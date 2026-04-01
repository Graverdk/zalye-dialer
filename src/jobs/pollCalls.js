'use strict';
const cron = require('node-cron');
const config = require('../config');
const { db, calls, messages, relatelNotes, state } = require('../db/database');
const relatel = require('../services/relatel');
const pipedrive = require('../services/pipedrive');
const { transcribe } = require('../services/transcription');
const claude = require('../services/claude');

// In-memory cache: phone number -> { personId, latestDealId, ts }
const personCache = new Map();
const CACHE_TTL = 10 * 60 * 1000; // 10 minutter

async function lookupPerson(phoneNumber) {
  const cached = personCache.get(phoneNumber);
  if (cached && (Date.now() - cached.ts) < CACHE_TTL) {
    return cached;
  }
  const person = await pipedrive.findPersonByPhone(phoneNumber);
  if (!person) {
    personCache.set(phoneNumber, { personId: null, latestDealId: null, ts: Date.now() });
    return null;
  }
  const { latestDealId } = await pipedrive.getPersonWithDeals(person.id);
  const entry = { personId: person.id, latestDealId, ts: Date.now() };
  personCache.set(phoneNumber, entry);
  return entry;
}

async function pollNewCalls() {
  const lastChecked = state.get('last_call_check') || new Date(Date.now() - 60000).toISOString();
  console.log('[Poll] Henter opkald afsluttet efter: ' + lastChecked);
  const rawCalls = await relatel.getCalls({ endedAfter: lastChecked });
  console.log('[Poll] Fandt ' + rawCalls.length + ' afsluttede opkald');
  state.set('last_call_check', new Date().toISOString());

  for (const rc of rawCalls) {
    const nc = relatel.normalizeCall(rc);
    if (!nc.phone_number) continue;

    if (!nc.recording_url && nc.relatel_uuid) {
      try {
        const fullCall = await relatel.getCall(nc.relatel_uuid);
        if (fullCall) {
          const detailed = relatel.normalizeCall(fullCall);
          if (detailed.recording_url) {
            nc.recording_url = detailed.recording_url;
            console.log('[Poll] Optagelse fundet via enkelt-opkald for ' + nc.relatel_uuid);
          } else {
            console.log('[Poll] Ingen optagelse for ' + nc.relatel_uuid);
          }
        }
      } catch (e) {
        console.error('[Poll] Fejl ved enkelt-opkald:', e.message);
      }
    }

    calls.upsert(nc);

    const lookup = await lookupPerson(nc.phone_number);
    if (!lookup || !lookup.personId) continue;
    const existing = calls.getByUuid(nc.relatel_uuid);
    if (existing && existing.pipedrive_note_id) continue;

    const noteId = await pipedrive.createCallNote({
      personId: lookup.personId,
      dealId: lookup.latestDealId,
      callData: {
        direction: nc.direction,
        phoneNumber: nc.phone_number,
        startedAt: nc.started_at,
        durationSec: nc.duration_sec,
      },
    });
    if (noteId) {
      db.prepare('UPDATE calls SET pipedrive_note_id = ?, pipedrive_person_id = ?, pipedrive_deal_id = ? WHERE relatel_uuid = ?')
        .run(noteId, lookup.personId, lookup.latestDealId, nc.relatel_uuid);
      console.log('[Poll] Opkaldsnote oprettet (note ' + noteId + ') for ' + nc.phone_number);
    }
  }
}

async function processTranscriptions() {
  const pending = calls.getPendingTranscriptions();
  if (pending.length === 0) return;
  console.log('[AI] Behandler ' + pending.length + ' opkald...');

  for (const call of pending) {
    db.prepare("UPDATE calls SET transcription_status = 'processing' WHERE relatel_uuid = ?")
      .run(call.relatel_uuid);
    console.log('[AI] Behandler: ' + call.relatel_uuid);

    try {
      console.log('[AI] Downloader optagelse...');
      const { buffer, contentType } = await relatel.downloadRecording(call.recording_url);
      const transcription = await transcribe(buffer, contentType);

      let summary = transcription;
      let actionPoints = null;
      let topics = null;
      let diarizedTranscription = null;

      if (transcription) {
        console.log('[AI] Analyserer med Claude...');
        const analysis = await claude.analyzeCall({
          transcription,
          direction: call.direction,
        });
        if (typeof analysis === 'object') {
          summary = analysis.summary || transcription;
          actionPoints = analysis.actionPoints || null;
          topics = analysis.topics || null;
          diarizedTranscription = analysis.diarizedTranscription || null;
        } else {
          summary = analysis || transcription;
        }
      }

      const callData = {
        direction: call.direction,
        phoneNumber: call.phone_number,
        startedAt: call.started_at,
        durationSec: call.duration_sec,
        summary,
        actionPoints,
        topics,
        transcription,
        diarizedTranscription,
      };

      if (call.pipedrive_note_id) {
        console.log('[AI] Opdaterer Pipedrive-note ' + call.pipedrive_note_id + ' med transskription...');
        await pipedrive.updateNote(call.pipedrive_note_id, { callData });
      } else if (call.pipedrive_person_id || call.pipedrive_deal_id) {
        const newNoteId = await pipedrive.createCallNote({
          personId: call.pipedrive_person_id,
          dealId: call.pipedrive_deal_id,
          callData,
        });
        if (newNoteId) {
          db.prepare('UPDATE calls SET pipedrive_note_id = ? WHERE relatel_uuid = ?')
            .run(newNoteId, call.relatel_uuid);
          console.log('[AI] Ny Pipedrive-note oprettet: ' + newNoteId);
        }
      }

      calls.updateTranscription(call.relatel_uuid, {
        status: 'done',
        transcription,
        summary,
        actionPoints,
        topics,
        pipedriveNoteId: call.pipedrive_note_id,
      });
      console.log('[AI] Faerdig: ' + call.relatel_uuid);
    } catch (err) {
      console.error('[AI] Fejl ved transskription: ' + err.message);
      calls.updateTranscription(call.relatel_uuid, {
        status: 'done',
        transcription: null,
        summary: null,
      });
    }
  }
}

async function fetchNewMessages() {
  const newMessages = [];
  try {
    const rawMessages = await relatel.getMessages({});
    console.log('[SMS] /messages returnerede ' + (rawMessages || []).length + ' beskeder');

    for (const m of (rawMessages || [])) {
      const msgId = m.id ? String(m.id) : null;
      if (!msgId) continue;
      const existing = messages.getById(msgId);
      if (existing && existing.pipedrive_note_id) continue;
      newMessages.push(m);
    }
    if (newMessages.length > 0) {
      console.log('[SMS] ' + newMessages.length + ' nye/usynkede beskeder fundet');
    }
  } catch (e) {
    console.error('[SMS] /messages fejl:', e.message);
  }

  for (const msg of newMessages) {
    const nm = relatel.normalizeMessage(msg);
    if (!nm.phone_number) continue;

    const lookup = await lookupPerson(nm.phone_number);
    if (!lookup || !lookup.personId) continue;

    messages.upsert({
      relatel_id: nm.relatel_id,
      direction: nm.direction,
      phone_number: nm.phone_number,
      employee_number: nm.employee_number,
      body: nm.body,
      sent_at: nm.sent_at,
      pipedrive_person_id: lookup.personId,
      pipedrive_deal_id: lookup.latestDealId,
    });

    const noteId = await pipedrive.createSmsNote({
      personId: lookup.personId,
      dealId: lookup.latestDealId,
      smsData: {
        direction: nm.direction,
        phoneNumber: nm.phone_number,
        body: nm.body,
        sentAt: nm.sent_at,
      },
    });
    if (noteId && nm.relatel_id) {
      messages.setNoteId(nm.relatel_id, noteId);
      console.log('[SMS] SMS-note oprettet (note ' + noteId + ') for ' + nm.phone_number);
    }
  }
}

async function fetchNewNotes() {
  const lastChecked = state.get('last_notes_check') || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  try {
    const contacts = await relatel.getContacts();
    let totalFresh = 0;

    for (const contact of contacts) {
      if (!contact.number) continue;
      const comments = await relatel.getContactComments(contact.id);
      if (!comments || comments.length === 0) continue;

      const freshComments = comments.filter(c => {
        const ts = c.created_at || c.updated_at;
        return !ts || new Date(ts) > new Date(lastChecked);
      });
      if (freshComments.length === 0) continue;

      const lookup = await lookupPerson(contact.number);
      if (!lookup || !lookup.personId) continue;
      totalFresh += freshComments.length;

      for (const comment of freshComments) {
        const noteId = comment.id ? String(comment.id) : null;
        if (!noteId) continue;

        const existing = relatelNotes.getById(noteId);
        if (existing && existing.pipedrive_note_id) continue;

        const body = comment.body || comment.text || comment.comment || '';
        const author = comment.author || comment.user || null;
        const createdAt = comment.created_at || null;

        const pdNoteId = await pipedrive.createRelatelNote({
          personId: lookup.personId,
          dealId: lookup.latestDealId,
          noteData: {
            author: (author && typeof author === 'object') ? (author.name || author.email || null) : author,
            body,
            createdAt,
          },
        });

        relatelNotes.upsert({
          relatel_id: noteId,
          relatel_contact_id: String(contact.id),
          phone_number: contact.number,
          author: (author && typeof author === 'object') ? (author.name || null) : author,
          body,
          created_at_rel: createdAt,
          pipedrive_person_id: lookup.personId,
          pipedrive_note_id: pdNoteId,
        });

        if (pdNoteId) {
          console.log('[Noter] Note oprettet (note ' + pdNoteId + ') for kontakt ' + lookup.personId);
        }
      }
    }
    if (totalFresh > 0) {
      console.log('[Noter] Behandlede ' + totalFresh + ' nye noter');
    }
  } catch (e) {
    console.error('[Noter] Fejl:', e.message);
  }
  state.set('last_notes_check', new Date().toISOString());
}

// ============================================================
// Kontakt-berigelse: Pipedrive -> Relatel
// ============================================================
async function enrichContacts() {
  try {
    const contacts = await relatel.getContacts({ limit: 200 });
    let enriched = 0;

    for (const contact of contacts) {
      if (!contact.number) continue;
      // Spring over hvis kontakten allerede har et rigtigt navn (ikke bare et nummer)
      if (contact.name && !/^\+?\d[\d\s\-().]+$/.test(contact.name.trim())) continue;

      // Slaa op i Pipedrive
      const person = await pipedrive.findPersonByPhone(contact.number);
      if (!person) continue;

      // Hent fulde persondetaljer (navn, firma, email)
      const details = await pipedrive.getPersonById(person.id);
      if (!details || !details.name) continue;

      // Byg visningsnavn: "Navn (Firma)"
      const orgName = (details.org_id && details.org_id.name) || null;
      const displayName = orgName
        ? details.name + ' (' + orgName + ')'
        : details.name;

      const email = (details.email && details.email.length > 0)
        ? details.email[0].value
        : null;

      // Opdater Relatel-kontakt
      await relatel.updateContact(contact.id, {
        name: displayName,
        email: email,
      });

      enriched++;
      console.log('[Enrich] ' + contact.number + ' -> ' + displayName + (email ? ' (' + email + ')' : ''));
    }

    if (enriched > 0) {
      console.log('[Enrich] Berigede ' + enriched + ' kontakter');
    } else {
      console.log('[Enrich] Ingen kontakter at berige');
    }
  } catch (e) {
    console.error('[Enrich] Fejl:', e.message);
  }
}

function start() {
  const INTERVAL = config.pollIntervalSeconds || 30;

  // Opkald: hvert 30. sekund
  cron.schedule('*/' + INTERVAL + ' * * * * *', async () => {
    try { await pollNewCalls(); } catch (e) { console.error('[Poll] Fejl:', e.message); }
  });

  // SMS: hvert minut
  cron.schedule('0 * * * * *', async () => {
    try { await fetchNewMessages(); } catch (e) { console.error('[SMS] Fejl:', e.message); }
  });

  // Transskription: hvert minut
  cron.schedule('30 * * * * *', async () => {
    try { await processTranscriptions(); } catch (e) { console.error('[AI] Fejl:', e.message); }
  });

  // Noter: hvert 5. minut
  cron.schedule('0 */5 * * * *', async () => {
    try { await fetchNewNotes(); } catch (e) { console.error('[Noter] Fejl:', e.message); }
  });

  // Kontakt-berigelse: hvert 5. minut (test), skift til daglig senere
  cron.schedule('15 */5 * * * *', async () => {
    try { await enrichContacts(); } catch (e) { console.error('[Enrich] Fejl:', e.message); }
  });

  console.log('[Poll] Cron-jobs startet (opkald: 30s, SMS: 60s, transskription: 60s, noter: 5min, berigelse: 5min).');
}

module.exports = { start, pollNewCalls, fetchNewMessages, fetchNewNotes, processTranscriptions, enrichContacts };
