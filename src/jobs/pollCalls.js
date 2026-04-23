'use strict';
const cron = require('node-cron');
const config = require('../config');
const { db, calls, messages, relatelNotes, insights, state } = require('../db/database');
const relatel = require('../services/relatel');
const pipedrive = require('../services/pipedrive');
const { transcribe, buildDiarizedTranscript } = require('../services/transcription');
const claude = require('../services/claude');

// In-memory cache: phone number -> { personId, latestDealId, ts }
// Positive matches caches i 10 min (sjældent skifter de).
// Negative matches caches kun i 60 sek så nyoprettede personer
// i Pipedrive findes hurtigt (vigtigt: lead → person konvertering).
const personCache = new Map();
const POSITIVE_TTL = 10 * 60 * 1000;
const NEGATIVE_TTL = 60 * 1000;

// Cache over berigede kontakter (Relatel contact ID -> true)
// Undgaar at scanne samme kontakter hvert 5. minut
const enrichedContactIds = new Set();

async function lookupPerson(phoneNumber) {
  const cached = personCache.get(phoneNumber);
  if (cached) {
    const ttl = cached.personId ? POSITIVE_TTL : NEGATIVE_TTL;
    if ((Date.now() - cached.ts) < ttl) return cached;
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
  // Default ved første kørsel: 24 timer tilbage (sikkerhedsnet hvis DB-volumet
  // mistes ved Railway-redeploy — så taber vi ikke alle opkald siden sidste deploy)
  const lastChecked = state.get('last_call_check') || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
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
      const scribeResult = await transcribe(buffer, contentType);
      const transcription = scribeResult.text;

      // Byg diariseret transskription direkte fra Scribe's ord+speaker-data
      // (langt mere pålidelig end at lade Claude gætte bagefter)
      let diarizedTranscription = buildDiarizedTranscript(scribeResult.words, call.direction);

      let summary = transcription;
      let actionPoints = null;
      let topics = null;
      let analysisResult = null;

      if (transcription) {
        console.log('[AI] Analyserer med Claude...');
        const analysis = await claude.analyzeCall({
          transcription: diarizedTranscription || transcription,
          direction: call.direction,
        });
        if (typeof analysis === 'object') {
          summary = analysis.summary || transcription;
          actionPoints = analysis.actionPoints || null;
          topics = analysis.topics || null;
          // Hvis Scribe ikke gav os diarization (fx kun én taler), brug Claude's
          if (!diarizedTranscription) diarizedTranscription = analysis.diarizedTranscription || null;
          analysisResult = analysis;
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

      // Re-try Pipedrive-lookup hvis vi ikke fik fat i personen ved første poll
      // (typisk fordi lead først blev konverteret til person efter opkaldet)
      let personId = call.pipedrive_person_id;
      let dealId = call.pipedrive_deal_id;
      if (!personId && !call.pipedrive_note_id && call.phone_number) {
        const lookup = await lookupPerson(call.phone_number);
        if (lookup && lookup.personId) {
          personId = lookup.personId;
          dealId = lookup.latestDealId || dealId;
          db.prepare('UPDATE calls SET pipedrive_person_id = ?, pipedrive_deal_id = ? WHERE relatel_uuid = ?')
            .run(personId, dealId, call.relatel_uuid);
          console.log('[AI] Sent-link til Pipedrive lykkedes for ' + call.phone_number + ' -> personId ' + personId);
        }
      }

      if (call.pipedrive_note_id) {
        console.log('[AI] Opdaterer Pipedrive-note ' + call.pipedrive_note_id + ' med transskription...');
        await pipedrive.updateNote(call.pipedrive_note_id, { callData });
      } else if (personId || dealId) {
        const newNoteId = await pipedrive.createCallNote({
          personId,
          dealId,
          callData,
        });
        if (newNoteId) {
          db.prepare('UPDATE calls SET pipedrive_note_id = ? WHERE relatel_uuid = ?')
            .run(newNoteId, call.relatel_uuid);
          console.log('[AI] Ny Pipedrive-note oprettet: ' + newNoteId);
        }
      } else {
        console.log('[AI] Ingen Pipedrive-match for ' + call.phone_number + ' — note ikke oprettet');
      }

      calls.updateTranscription(call.relatel_uuid, {
        status: 'done',
        transcription,
        summary,
        actionPoints,
        topics,
        pipedriveNoteId: call.pipedrive_note_id,
      });

      // ============================================================
      // GEM SALES INTELLIGENCE i call_insights-tabellen
      // Saa data kan bruges til trends, coaching og dashboards
      // ============================================================
      if (analysisResult && call.id) {
        try {
          insights.upsert(call.id, {
            sentiment: analysisResult.sentiment,
            callOutcome: analysisResult.callOutcome,
            painPoints: analysisResult.painPoints,
            objections: analysisResult.objections,
            buyingSignals: analysisResult.buyingSignals,
            competitorMentions: analysisResult.competitorMentions,
            nextSteps: analysisResult.nextSteps,
            customerStage: analysisResult.customerStage,
            engagementScore: analysisResult.engagementScore,
            conversionLikelihood: analysisResult.conversionLikelihood,
            aiCoachingNote: analysisResult.aiCoachingNote,
          });
          console.log('[AI] Sales intelligence gemt for call ' + call.id);
        } catch (insightErr) {
          console.error('[AI] Kunne ikke gemme insights:', insightErr.message);
        }
      }

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

// ============================================================
// CATCH-UP: Hent alle opkald fra sidste N dage og sæt dem
// i kø til transskription + Pipedrive-sync. Bruges til at
// indhente tabte opkald efter fx et servernedbrud.
// ============================================================
async function backfillCalls(days = 7) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  console.log('[Backfill] Henter opkald siden ' + since + ' (sidste ' + days + ' dage)');

  let rawCalls;
  try {
    rawCalls = await relatel.getCalls({ endedAfter: since, limit: 500 });
  } catch (e) {
    console.error('[Backfill] Kunne ikke hente opkald fra Relatel:', e.message);
    throw e;
  }
  console.log('[Backfill] Fandt ' + rawCalls.length + ' opkald fra Relatel');

  let imported = 0;
  let linked = 0;
  let alreadyDone = 0;
  let requeued = 0;
  const backfillStats = { notesCreated: 0 };

  for (const rc of rawCalls) {
    const nc = relatel.normalizeCall(rc);
    if (!nc.phone_number || !nc.relatel_uuid) continue;

    // Hvis der ikke er recording_url i listen, prøv at hente enkelt-opkald
    if (!nc.recording_url) {
      try {
        const fullCall = await relatel.getCall(nc.relatel_uuid);
        if (fullCall) {
          const detailed = relatel.normalizeCall(fullCall);
          if (detailed.recording_url) nc.recording_url = detailed.recording_url;
        }
      } catch { /* ignore */ }
    }

    // Upsert (ændrer intet hvis opkaldet allerede er i DB, undtagen recording_url)
    calls.upsert(nc);

    const existing = calls.getByUuid(nc.relatel_uuid);
    if (!existing) continue;

    // Tjek om opkaldet allerede er fuldt processeret
    if (existing.pipedrive_note_id && existing.transcription_status === 'done' && existing.transcription) {
      alreadyDone++;
      continue;
    }

    imported++;

    // Prøv at link til Pipedrive hvis vi ikke har person_id endnu
    let personId = existing.pipedrive_person_id;
    let dealId = existing.pipedrive_deal_id;
    if (!personId) {
      const lookup = await lookupPerson(nc.phone_number);
      if (lookup && lookup.personId) {
        personId = lookup.personId;
        dealId = lookup.latestDealId || null;
        db.prepare('UPDATE calls SET pipedrive_person_id = ?, pipedrive_deal_id = ? WHERE relatel_uuid = ?')
          .run(personId, dealId, nc.relatel_uuid);
        linked++;
      }
    }

    // Opret initial note i Pipedrive hvis der er match og ingen note endnu
    // (transskription tilføjes senere via processTranscriptions hvis recording findes)
    let notesCreated = 0;
    if (personId && !existing.pipedrive_note_id) {
      const noteId = await pipedrive.createCallNote({
        personId,
        dealId,
        callData: {
          direction: nc.direction,
          phoneNumber: nc.phone_number,
          startedAt: nc.started_at,
          durationSec: nc.duration_sec,
        },
      });
      if (noteId) {
        db.prepare('UPDATE calls SET pipedrive_note_id = ? WHERE relatel_uuid = ?')
          .run(noteId, nc.relatel_uuid);
        notesCreated++;
        console.log('[Backfill] Initial note oprettet (' + noteId + ') for ' + nc.phone_number);
      }
    }

    // Sæt transcription_status til pending hvis der er en recording og den ikke er done
    if (nc.recording_url && existing.transcription_status !== 'done') {
      db.prepare("UPDATE calls SET transcription_status = 'pending' WHERE relatel_uuid = ?")
        .run(nc.relatel_uuid);
      requeued++;
    }

    // Statistik
    backfillStats.notesCreated = (backfillStats.notesCreated || 0) + notesCreated;
  }

  const summary = {
    fetched: rawCalls.length,
    imported,
    linkedToPipedrive: linked,
    notesCreated: backfillStats.notesCreated || 0,
    requeuedForTranscription: requeued,
    alreadyDone,
  };
  console.log('[Backfill] Færdig:', JSON.stringify(summary));
  return summary;
}

// ============================================================
// FIX: Genhent opkald der mangler recording_url
// Relatel har ofte 1-2 min forsinkelse paa optagelser
// Uden denne funktion bliver de aldrig transskriberet
// ============================================================
async function retryMissingRecordings() {
  try {
    // Find opkald fra sidste 2 timer uden recording_url
    const stale = db.prepare(`
      SELECT relatel_uuid FROM calls
      WHERE recording_url IS NULL
        AND recording_expired = 0
        AND ended_at IS NOT NULL
        AND datetime(ended_at) > datetime('now', '-2 hours')
      ORDER BY ended_at DESC
      LIMIT 50
    `).all();

    if (stale.length === 0) return;
    const staleUuids = new Set(stale.map(r => r.relatel_uuid));
    console.log('[Retry] Forsoeger at hente recording for ' + stale.length + ' opkald');

    // Hent alle opkald fra sidste 2 timer via GET /calls (som virker)
    // Det er meget billigere end at hente hver enkelt og POST /calls returnerer 404
    const since = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    let rawCalls;
    try {
      rawCalls = await relatel.getCalls({ endedAfter: since, limit: 200 });
    } catch (e) {
      console.error('[Retry] Kunne ikke hente call-liste:', e.message);
      return;
    }

    let updated = 0;
    for (const rc of rawCalls) {
      const nc = relatel.normalizeCall(rc);
      if (!nc.relatel_uuid || !staleUuids.has(nc.relatel_uuid)) continue;
      if (nc.recording_url) {
        db.prepare('UPDATE calls SET recording_url = ?, transcription_status = ? WHERE relatel_uuid = ?')
          .run(nc.recording_url, 'pending', nc.relatel_uuid);
        console.log('[Retry] Recording fundet for ' + nc.relatel_uuid);
        updated++;
      }
    }
    if (updated === 0) console.log('[Retry] Ingen nye recordings fundet endnu (' + stale.length + ' venter)');
  } catch (e) {
    console.error('[Retry] Fejl:', e.message);
  }
}

// ============================================================
// OPTIMERET: Brug datofilter saa vi kun henter nye SMS'er
// + gem beskeder ALTID i DB (ogsaa uden Pipedrive-match)
// saa de ikke genbehandles naeste minut
// ============================================================
async function fetchNewMessages() {
  const lastChecked = state.get('last_sms_check') || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const newMessages = [];
  try {
    // Relatel: /messages er KUN til at SENDE. For at LISTE SMS bruges /chats + /chats/{uuid}
    const chats = await relatel.getChats({ after: lastChecked, limit: 100 });
    console.log('[SMS] /chats returnerede ' + (chats || []).length + ' chats (opdateret efter ' + lastChecked + ')');

    for (const chat of (chats || [])) {
      const chatUuid = chat.uuid || chat.id;
      if (!chatUuid) continue;
      let full;
      try {
        full = await relatel.getChat(chatUuid);
      } catch (e) {
        console.error('[SMS] Kunne ikke hente chat ' + chatUuid + ':', e.message);
        continue;
      }
      const chatMessages = (full && (full.messages || full.sms || [])) || [];
      for (const m of chatMessages) {
        const msgId = (m.id || m.uuid) ? String(m.id || m.uuid) : null;
        if (!msgId) continue;
        const existing = messages.getById(msgId);
        if (existing) continue;
        // Kopier chat-niveau felter ned i beskeden hvis de mangler
        if (!m.remote_number && chat.remote_number) m.remote_number = chat.remote_number;
        if (!m.employee_number && chat.employee_number) m.employee_number = chat.employee_number;
        newMessages.push(m);
      }
    }
    if (newMessages.length > 0) {
      console.log('[SMS] ' + newMessages.length + ' nye beskeder fundet');
    }
  } catch (e) {
    console.error('[SMS] /chats fejl:', e.message);
  }
  state.set('last_sms_check', new Date().toISOString());

  for (const msg of newMessages) {
    const nm = relatel.normalizeMessage(msg);
    if (!nm.phone_number) continue;

    // Gem ALTID i DB saa beskeden ikke genbehandles
    messages.upsert({
      relatel_id: nm.relatel_id,
      direction: nm.direction,
      phone_number: nm.phone_number,
      employee_number: nm.employee_number,
      body: nm.body,
      sent_at: nm.sent_at,
      pipedrive_person_id: null,
      pipedrive_deal_id: null,
    });

    const lookup = await lookupPerson(nm.phone_number);
    if (!lookup || !lookup.personId) continue;

    // Opdater med Pipedrive-kobling
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

// ============================================================
// OPTIMERET: Spring kontakter over som allerede er tjekket
// Hent kun kommentarer for kontakter med aendringer
// ============================================================
async function fetchNewNotes() {
  const lastChecked = state.get('last_notes_check') || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  try {
    const contacts = await relatel.getContacts();
    let totalFresh = 0;

    for (const contact of contacts) {
      if (!contact.number) continue;

      // Spring over kontakter uden nylige aendringer (baseret paa updated_at)
      if (contact.updated_at && new Date(contact.updated_at) < new Date(lastChecked)) continue;

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
// OPTIMERET: Track berigede kontakter saa vi ikke scanner
// de samme 200 kontakter hvert 5. minut
// ============================================================
async function enrichContacts() {
  try {
    const contacts = await relatel.getContacts({ limit: 200 });
    let enriched = 0;
    let inSync = 0;

    for (const contact of contacts) {
      if (!contact.number) continue;

      // Spring over allerede berigede kontakter (in-memory cache)
      // OBS: cache nulstilles ved server-restart så vi indhenter evt. ændringer
      if (enrichedContactIds.has(String(contact.id))) continue;

      // Slå op i Pipedrive — KILDE TIL SANDHED
      const person = await pipedrive.findPersonByPhone(contact.number);
      if (!person) {
        // Ingen match i Pipedrive — lad Relatel-navnet stå som det er
        enrichedContactIds.add(String(contact.id));
        continue;
      }

      // Hent fulde persondetaljer (navn, firma, email)
      const details = await pipedrive.getPersonById(person.id);
      if (!details || !details.name) {
        enrichedContactIds.add(String(contact.id));
        continue;
      }

      // Byg ønsket visningsnavn: "Navn (Firma)"
      const orgName = (details.org_id && details.org_id.name) || null;
      const desiredName = orgName
        ? details.name + ' (' + orgName + ')'
        : details.name;

      const desiredEmail = (details.email && details.email.length > 0)
        ? details.email[0].value
        : null;

      // Hvis Relatel-kontakten allerede matcher Pipedrive → skip update
      // (undgår at spamme Relatel API med unødvendige opdateringer)
      const currentName = (contact.name || '').trim();
      const currentEmail = (contact.email || '').trim();
      if (currentName === desiredName && (!desiredEmail || currentEmail === desiredEmail)) {
        enrichedContactIds.add(String(contact.id));
        inSync++;
        continue;
      }

      // Opdatér Relatel-kontakt med Pipedrive-data (overskriver evt. forkerte navne)
      try {
        await relatel.updateContact(contact.id, {
          name: desiredName,
          email: desiredEmail,
        });
        enrichedContactIds.add(String(contact.id));
        enriched++;
        const changeLog = currentName && currentName !== desiredName
          ? '"' + currentName + '" -> "' + desiredName + '"'
          : '-> ' + desiredName;
        console.log('[Enrich] ' + contact.number + ' ' + changeLog);
      } catch (updateErr) {
        console.error('[Enrich] Fejl ved opdatering af ' + contact.number + ':', updateErr.message);
      }
    }

    if (enriched > 0) {
      console.log('[Enrich] Opdaterede ' + enriched + ' kontakter i Relatel (Pipedrive er sandhed)');
    }
    if (inSync > 0) {
      console.log('[Enrich] ' + inSync + ' kontakter er allerede i sync');
    }
  } catch (e) {
    console.error('[Enrich] Fejl:', e.message);
  }
}

function start() {
  const INTERVAL = config.pollIntervalSeconds || 30;

  // Reset alle opkald der hænger i 'processing' (fx pga. tidligere crash/restart)
  // Ellers ville de aldrig blive plukket op igen af processTranscriptions
  try {
    const result = db.prepare(
      "UPDATE calls SET transcription_status = 'pending' WHERE transcription_status = 'processing'"
    ).run();
    if (result.changes > 0) {
      console.log('[Init] Resat ' + result.changes + ' h\u00e6ngende processing-opkald til pending');
    }
  } catch (e) {
    console.error('[Init] Kunne ikke resette processing-status:', e.message);
  }

  // Opkald: hvert 30. sekund (konfigurerbart via POLL_INTERVAL_SECONDS)
  cron.schedule('*/' + INTERVAL + ' * * * * *', async () => {
    try { await pollNewCalls(); } catch (e) { console.error('[Poll] Fejl:', e.message); }
  });

  // SMS: hvert minut
  cron.schedule('0 * * * * *', async () => {
    try { await fetchNewMessages(); } catch (e) { console.error('[SMS] Fejl:', e.message); }
  });

  // Retry manglende recordings: hvert minut (10s offset)
  cron.schedule('10 * * * * *', async () => {
    try { await retryMissingRecordings(); } catch (e) { console.error('[Retry] Fejl:', e.message); }
  });

  // Transskription: hvert minut
  cron.schedule('30 * * * * *', async () => {
    try { await processTranscriptions(); } catch (e) { console.error('[AI] Fejl:', e.message); }
  });

  // Noter: hvert 5. minut
  cron.schedule('0 */5 * * * *', async () => {
    try { await fetchNewNotes(); } catch (e) { console.error('[Noter] Fejl:', e.message); }
  });

  // Kontakt-berigelse: hvert 5. minut
  cron.schedule('15 */5 * * * *', async () => {
    try { await enrichContacts(); } catch (e) { console.error('[Enrich] Fejl:', e.message); }
  });

  console.log('[Poll] Cron-jobs startet (opkald: ' + INTERVAL + 's, SMS: 60s, transskription: 60s, noter: 5min, berigelse: 5min).');
}

module.exports = { start, pollNewCalls, fetchNewMessages, fetchNewNotes, processTranscriptions, enrichContacts, retryMissingRecordings, backfillCalls };
