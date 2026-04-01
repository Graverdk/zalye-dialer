'use strict';
const cron = require('node-cron');
const config = require('../config');
const { db, calls, messages, relatelNotes, state } = require('../db/database');
const relatel = require('../services/relatel');
const pipedrive = require('../services/pipedrive');
const { transcribe } = require('../services/transcription');
const claude = require('../services/claude');

// -------------------------------------------------------
// pollNewCalls
// -------------------------------------------------------
async function pollNewCalls() {
  const lastChecked = state.get('last_call_check') || new Date(Date.now() - 60000).toISOString();
  console.log('[Poll] Henter opkald afsluttet efter: ' + lastChecked);
  const rawCalls = await relatel.getCalls({ endedAfter: lastChecked });
  console.log('[Poll] Fandt ' + rawCalls.length + ' afsluttede opkald');
  state.set('last_call_check', new Date().toISOString());

  for (const rc of rawCalls) {
    const nc = relatel.normalizeCall(rc);
    if (!nc.phone_number) continue;

    // Hent fulde opkaldsdetaljer hvis listen ikke inkluderer recording_url
    if (!nc.recording_url && nc.relatel_uuid) {
      try {
        const fullCall = await relatel.getCall(nc.relatel_uuid);
        if (fullCall) {
          const detailed = relatel.normalizeCall(fullCall);
          if (detailed.recording_url) {
            nc.recording_url = detailed.recording_url;
            console.log('[Poll] Optagelse fundet via enkelt-opkald for ' + nc.relatel_uuid);
          } else {
            console.log('[Poll] Ingen optagelse for ' + nc.relatel_uuid + ' (rc.recording=' + JSON.stringify(fullCall.recording || null) + ')');
          }
        }
      } catch (e) {
        console.error('[Poll] Fejl ved enkelt-opkald:', e.message);
      }
    }

    calls.upsert(nc);
    const person = await pipedrive.findPersonByPhone(nc.phone_number);
    if (!person) continue;
    const existing = calls.getByUuid(nc.relatel_uuid);
    if (existing && existing.pipedrive_note_id) continue;
    const { latestDealId } = await pipedrive.getPersonWithDeals(person.id);
    const noteId = await pipedrive.createCallNote({
      personId: person.id,
      dealId: latestDealId,
      callData: {
        direction: nc.direction,
        phoneNumber: nc.phone_number,
        startedAt: nc.started_at,
        durationSec: nc.duration_sec,
      },
    });
    if (noteId) {
      db.prepare('UPDATE calls SET pipedrive_note_id = ?, pipedrive_person_id = ?, pipedrive_deal_id = ? WHERE relatel_uuid = ?')
        .run(noteId, person.id, latestDealId, nc.relatel_uuid);
      console.log('[Poll] Opkaldsnote oprettet (note ' + noteId + ') for ' + nc.phone_number);
    }
  }
}

// -------------------------------------------------------
// processTranscriptions
// -------------------------------------------------------
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
      // FIX: destrukturÃ©r { buffer, contentType } korrekt
      const { buffer, contentType } = await relatel.downloadRecording(call.recording_url);
      const transcription = await transcribe(buffer, contentType);

      let summary = transcription;
      let actionPoints = null;
      let topics = null;

      if (transcription) {
        console.log('[AI] Analyserer med Claude...');
        const analysis = await claude.summarizeCall(transcription, {
          phone: call.phone_number,
          direction: call.direction,
          duration: call.duration_sec,
        });
        if (typeof analysis === 'object') {
          summary = analysis.summary || transcription;
          actionPoints = analysis.actionPoints || null;
          topics = analysis.topics || null;
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
      };

      if (call.pipedrive_note_id) {
        // OPDATER eksisterende note â undgÃ¥r duplikater
        console.log('[AI] Opdaterer Pipedrive-note ' + call.pipedrive_note_id + ' med transskription...');
        await pipedrive.updateNote(call.pipedrive_note_id, { callData });
      } else if (call.pipedrive_person_id || call.pipedrive_deal_id) {
        // Ingen eksisterende note â opret ny
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

// -------------------------------------------------------
// fetchNewMessages
// -------------------------------------------------------
async function fetchNewMessages() {
  const lastChecked = state.get('last_sms_check') || new Date(Date.now() - 60000).toISOString();
  console.log('[SMS] Henter beskeder efter: ' + lastChecked);

  // DEBUG: Tjek om /messages returnerer noget (uden datofilter)
  try {
    const allMsgs = await relatel.getMessages({});
    console.log('[SMS] DEBUG /messages (ingen filter): ' + (allMsgs ? allMsgs.length : 'null') + ' beskeder totalt');
    if (allMsgs && allMsgs.length > 0) {
      console.log('[SMS] DEBUG fÃ¸rste besked nÃ¸gler: ' + Object.keys(allMsgs[0]).join(', '));
      console.log('[SMS] DEBUG fÃ¸rste besked: ' + JSON.stringify(allMsgs[0]).substring(0, 300));
    }
  } catch (e) {
    console.error('[SMS] DEBUG /messages (ingen filter) fejl:', e.message);
  }

  const newMessages = [];
  try {
    const rawMessages = await relatel.getMessages({ after: lastChecked });
    const fresh = (rawMessages || []).filter(m => {
      const ts = m.created_at || m.sent_at;
      return ts && new Date(ts) > new Date(lastChecked);
    });
    console.log('[SMS] /messages: ' + (rawMessages ? rawMessages.length : 0) + ' total, ' + fresh.length + ' nye');
    newMessages.push(...fresh);
  } catch (e) {
    console.error('[SMS] /messages fejl:', e.message);
  }

  try {
    const chats = await relatel.getChats({ after: lastChecked });
    console.log('[SMS] /chats svar: ' + (chats ? chats.length : 0) + ' elementer');
    newMessages.push(...(chats || []));
  } catch (e) {
    console.error('[SMS] /chats fejl:', e.message);
  }

  console.log('[SMS] Fandt ' + newMessages.length + ' nye beskeder');
  for (const msg of newMessages) {
    const nm = relatel.normalizeMessage(msg);
    if (!nm.phone_number) continue;
    const existing = nm.relatel_id ? messages.getById(nm.relatel_id) : null;
    if (existing && existing.pipedrive_note_id) continue;
    const person = await pipedrive.findPersonByPhone(nm.phone_number);
    if (!person) continue;
    const { latestDealId } = await pipedrive.getPersonWithDeals(person.id);
    messages.upsert({
      relatel_id: nm.relatel_id,
      direction: nm.direction,
      phone_number: nm.phone_number,
      employee_number: nm.employee_number,
      body: nm.body,
      sent_at: nm.sent_at,
      pipedrive_person_id: person.id,
      pipedrive_deal_id: latestDealId,
    });
    const noteId = await pipedrive.createSmsNote({
      personId: person.id,
      dealId: latestDealId,
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
  state.set('last_sms_check', new Date().toISOString());
}

// -------------------------------------------------------
// fetchNewNotes
// -------------------------------------------------------
async function fetchNewNotes() {
  const lastChecked = state.get('last_notes_check')
    || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  console.log('[Noter] Henter kontakter fra Relatel (noter siden ' + lastChecked + ')...');

  try {
    const contacts = await relatel.getContacts();
    for (const contact of contacts) {
      if (!contact.number) continue;
      const person = await pipedrive.findPersonByPhone(contact.number);
      if (!person) continue;
      const comments = await relatel.getContactComments(contact.id);
      if (!comments || comments.length === 0) continue;

      const freshComments = comments.filter(c => {
        const ts = c.created_at || c.updated_at;
        return !ts || new Date(ts) > new Date(lastChecked);
      });
      if (freshComments.length === 0) continue;

      const { latestDealId } = await pipedrive.getPersonWithDeals(person.id);
      for (const comment of freshComments) {
        const noteId = comment.id ? String(comment.id) : null;
        if (!noteId) continue;
        const existing = relatelNotes.getById(noteId);
        if (existing && existing.pipedrive_note_id) continue;
        const body = comment.body || comment.text || comment.comment || '';
        const author = comment.author || comment.user || null;
        const createdAt = comment.created_at || null;
        const pdNoteId = await pipedrive.createRelatelNote({
          personId: person.id,
          dealId: latestDealId,
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
          pipedrive_person_id: person.id,
          pipedrive_note_id: pdNoteId,
        });
        if (pdNoteId) {
          console.log('[Noter] Note oprettet (note ' + pdNoteId + ') for kontakt ' + person.id);
        }
      }
    }
  } catch (e) {
    console.error('[Noter] Fejl:', e.message);
  }
  state.set('last_notes_check', new Date().toISOString());
}

// -------------------------------------------------------
// start()
// -------------------------------------------------------
function start() {
  const INTERVAL = config.pollIntervalSeconds || 30;
  cron.schedule('*/' + INTERVAL + ' * * * * *', async () => {
    try { await pollNewCalls(); } catch (e) { console.error('[Poll] Fejl:', e.message); }
  });
  cron.schedule('*/30 * * * * *', async () => {
    try { await fetchNewMessages(); } catch (e) { console.error('[SMS] Fejl:', e.message); }
  });
  cron.schedule('0 * * * * *', async () => {
    try { await fetchNewNotes(); } catch (e) { console.error('[Noter] Fejl:', e.message); }
    try { await processTranscriptions(); } catch (e) { console.error('[AI] Fejl:', e.message); }
  });
  console.log('[Poll] Cron-jobs startet.');
}

module.exports = { start, pollNewCalls, fetchNewMessages, fetchNewNotes, processTranscriptions };
