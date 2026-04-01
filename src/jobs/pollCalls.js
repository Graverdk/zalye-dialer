const cron = require('node-cron');
const config = require('../config');
const { db, calls, messages, relatelNotes, insights, state } = require('../db/database');
const relatel = require('../services/relatel');
const { transcribe } = require('../services/transcription');
const { analyzeCall } = require('../services/claude');
const pipedrive = require('../services/pipedrive');

// ============================================================
// Hent nye afsluttede opkald fra Relatel og gem dem
// ============================================================
async function fetchNewCalls() {
  const lastPoll = state.get('last_poll_time') || new Date(Date.now() - 60 * 60 * 1000).toISOString();
  console.log(`[Poll] Henter opkald afsluttet efter: ${lastPoll}`);

  let allCalls = [];
  try {
    const [outgoing, incoming] = await Promise.all([
      relatel.getCalls({ direction: 'outgoing', endedAfter: lastPoll, limit: 50 }),
      relatel.getCalls({ direction: 'incoming', endedAfter: lastPoll, limit: 50 }),
    ]);
    allCalls = [...outgoing, ...incoming];
  } catch (err) {
    console.error('[Poll] Fejl ved hentning fra Relatel:', err.message);
    return;
  }

  state.set('last_poll_time', new Date().toISOString());

  const endedCalls = allCalls.filter(c => c.ended_at);
  console.log(`[Poll] Fandt ${endedCalls.length} afsluttede opkald`);

  for (const rc of endedCalls) {
    try {
      const normalized = relatel.normalizeCall(rc);
      const existingCall = calls.getByUuid(normalized.relatel_uuid);
      const isNew = !existingCall;

      calls.upsert(normalized);

      if (isNew || !existingCall?.pipedrive_person_id) {
        await linkToPipedrive(normalized);
      }
    } catch (err) {
      console.error(`[Poll] Fejl ved behandling af opkald ${rc.call_uuid}:`, err.message);
    }
  }
}

// ============================================================
// Link opkald til Pipedrive og opret note MED DET SAMME
// ============================================================
async function linkToPipedrive(normalizedCall) {
  if (!normalizedCall.phone_number) return;

  try {
    const person = await pipedrive.findPersonByPhone(normalizedCall.phone_number);
    if (!person) {
      console.log(`[Poll] Ingen Pipedrive-kontakt fundet for ${normalizedCall.phone_number}`);
      return;
    }

    const { latestDealId } = (await pipedrive.getPersonWithDeals(person.id)) || {};

    // Opdater call med Pipedrive-IDs
    calls.upsert({
      ...normalizedCall,
      pipedrive_person_id: person.id,
      pipedrive_deal_id: latestDealId || null,
    });

    // Opret altid en grundlæggende note i Pipedrive med det samme
    // (uanset om optagelse eller transskription er tilgængelig)
    const existing = calls.getByUuid(normalizedCall.relatel_uuid);
    if (!existing?.pipedrive_note_id) {
      const noteId = await pipedrive.createCallNote({
        dealId: latestDealId || null,
        personId: person.id,
        callData: {
          direction:   normalizedCall.direction,
          phoneNumber: normalizedCall.phone_number,
          startedAt:   normalizedCall.started_at,
          durationSec: normalizedCall.duration_sec,
          summary:     null,
          actionPoints: null,
          topics:      null,
          transcription: '',
        },
      });

      if (noteId) {
        db.prepare('UPDATE calls SET pipedrive_note_id = ? WHERE relatel_uuid = ?')
          .run(noteId, normalizedCall.relatel_uuid);
        console.log(`[Poll] ✅ Opkaldsnote oprettet i Pipedrive (note ${noteId}) for ${normalizedCall.phone_number}`);
      }
    }
  } catch (err) {
    console.error('[Poll] Fejl ved Pipedrive-link:', err.message);
  }
}

// ============================================================
// AI-transskription (valgfri — kræver optagelse)
// ============================================================
async function processTranscriptions() {
  const pending = calls.getPendingTranscriptions();
  if (pending.length === 0) return;

  console.log(`[AI] Behandler ${pending.length} opkald...`);

  for (const call of pending) {
    // Spring over hvis note allerede er oprettet og ingen optagelse
    if (!call.recording_url) {
      calls.updateTranscription(call.relatel_uuid, {
        status: 'done',
        transcription: null, summary: null, actionPoints: null, topics: null,
        pipedriveNoteId: call.pipedrive_note_id || null,
      });
      continue;
    }

    console.log(`[AI] Behandler: ${call.relatel_uuid}`);
    calls.updateTranscription(call.relatel_uuid, {
      status: 'processing',
      transcription: null, summary: null, actionPoints: null, topics: null, pipedriveNoteId: null,
    });

    try {
      let transcription = '';
      let summary = null;
      let actionPoints = null;
      let topics = null;

      // Download og transskribér (returnerer '' hvis deaktiveret)
      try {
        console.log(`[AI] Downloader optagelse...`);
        const { buffer, contentType } = await relatel.downloadRecording(call.recording_url);
        transcription = await transcribe(buffer, contentType);
      } catch (err) {
        console.log(`[AI] Transskription sprunget over: ${err.message}`);
      }

      // Analysér med Claude hvis vi har transskription
      if (transcription && transcription.trim().length >= 10) {
        try {
          console.log(`[AI] Analyserer med Claude...`);
          const analysis = await analyzeCall({ transcription, direction: call.direction });
          summary = analysis.summary;
          actionPoints = analysis.actionPoints;
          topics = analysis.topics;

          // Gem salgs-insights
          const dbCall = calls.getByUuid(call.relatel_uuid);
          if (dbCall) {
            insights.upsert(dbCall.id, {
              sentiment:            analysis.sentiment,
              callOutcome:          analysis.callOutcome,
              painPoints:           analysis.painPoints,
              objections:           analysis.objections,
              buyingSignals:        analysis.buyingSignals,
              competitorMentions:   analysis.competitorMentions,
              nextSteps:            analysis.nextSteps,
              customerStage:        analysis.customerStage,
              engagementScore:      analysis.engagementScore,
              conversionLikelihood: analysis.conversionLikelihood,
              aiCoachingNote:       analysis.aiCoachingNote,
            });
          }
        } catch (err) {
          console.log(`[AI] Claude-analyse sprunget over: ${err.message}`);
        }
      }

      calls.updateTranscription(call.relatel_uuid, {
        status: 'done',
        transcription,
        summary,
        actionPoints,
        topics,
        pipedriveNoteId: call.pipedrive_note_id || null,
      });

      console.log(`[AI] ✅ Færdig: ${call.relatel_uuid}`);

    } catch (err) {
      console.error(`[AI] ❌ Fejl for ${call.relatel_uuid}:`, err.message);
      calls.updateTranscription(call.relatel_uuid, {
        status: 'failed',
        transcription: null, summary: null, actionPoints: null, topics: null, pipedriveNoteId: null,
      });
    }
  }
}

// ============================================================
// Hent SMS-beskeder fra Relatel
// Bruger /chats uden tidsfilter og filtrerer selv efter timestamp
// ============================================================
async function fetchNewMessages() {
  const lastPoll = state.get('last_sms_poll_time') || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  console.log(`[SMS] Henter beskeder efter: ${lastPoll}`);
  state.set('last_sms_poll_time', new Date().toISOString());

  let allMessages = [];

  // /messages endpoint (API-sendte beskeder)
  try {
    const fromMessages = await relatel.getMessages({ limit: 50 });
    if (Array.isArray(fromMessages)) {
      // Filtrer efter timestamp
      const newMsgs = fromMessages.filter(m => {
        const ts = m.created_at || m.sent_at || m.timestamp;
        return ts && new Date(ts) > new Date(lastPoll);
      });
      allMessages.push(...newMsgs);
      console.log(`[SMS] /messages: ${fromMessages.length} total, ${newMsgs.length} nye`);
    }
  } catch (err) {
    console.log('[SMS] /messages ikke tilgængeligt:', err.message);
  }

  // /chats endpoint (desktop app SMS) — hent alle og filtrer selv
  try {
    const recentChats = await relatel.getChats({ limit: 100 });
    console.log(`[SMS] /chats svar: ${Array.isArray(recentChats) ? recentChats.length : typeof recentChats} elementer`);

    if (Array.isArray(recentChats)) {
      for (const chat of recentChats) {
        // Log første chat-objekt for debugging
        if (allMessages.length === 0 && recentChats.indexOf(chat) === 0) {
          console.log(`[SMS] Chat eksempel:  ${JSON.stringify(chat).substring(0, 300)}`);
        }

        const chatMsgs = chat.messages || (chat.last_message ? [chat.last_message] : []);
        const phone = (chat.remote_number || chat.contact_number || chat.phone || '').replace(/^(\+|00)/, '');

        for (const m of chatMsgs) {
          const ts = m.created_at || m.sent_at || m.timestamp;
          if (ts && new Date(ts) > new Date(lastPoll)) {
            allMessages.push({ ...m, remote_number: phone || m.remote_number, _from_chat: chat.uuid || chat.id });
          }
        }
      }
    }
  } catch (err) {
    console.log('[SMS] /chats fejl:', err.message);
  }

  console.log(`[SMS] Fandt ${allMessages.length} nye beskeder`);

  for (const msg of allMessages) {
    try {
      const normalized = relatel.normalizeMessage(msg);
      if (!normalized.relatel_id) continue;

      const existing = messages.getById(normalized.relatel_id);
      if (existing) continue;

      messages.upsert(normalized);

      if (normalized.phone_number) {
        try {
          const person = await pipedrive.findPersonByPhone(normalized.phone_number);
          if (person) {
            const { latestDealId } = (await pipedrive.getPersonWithDeals(person.id)) || {};
            messages.upsert({ ...normalized, pipedrive_person_id: person.id, pipedrive_deal_id: latestDealId || null });

            const noteId = await pipedrive.createSmsNote({
              personId: person.id,
              dealId: latestDealId || null,
              smsData: {
                direction: normalized.direction,
                phoneNumber: normalized.phone_number,
                body: normalized.body,
                sentAt: normalized.sent_at,
              },
            });

            if (noteId) {
              messages.setNoteId(normalized.relatel_id, noteId);
              console.log(`[SMS] ✅ Note oprettet i Pipedrive for SMS ${normalized.relatel_id}`);
            }
          }
        } catch (err) {
          console.error(`[SMS] Pipedrive-link fejl:`, err.message);
        }
      }
    } catch (err) {
      console.error(`[SMS] Behandlingsfejl:`, err.message);
    }
  }
}

// ============================================================
// Hent noter fra Relatel-kontakter
// ============================================================
async function fetchNewNotes() {
  console.log('[Noter] Henter kontakter fra Relatel...');

  let contacts = [];
  try {
    contacts = await relatel.getContacts({ limit: 100 });
  } catch (err) {
    console.error('[Noter] Fejl ved hentning af kontakter:', err.message);
    return;
  }

  if (!Array.isArray(contacts)) return;

  for (const contact of contacts) {
    try {
      const comments = await relatel.getContactComments(contact.id);
      if (!Array.isArray(comments) || comments.length === 0) continue;

      const phoneNumber = (contact.number || contact.phone || '').replace(/^(\+|00)/, '');

      for (const comment of comments) {
        const relatelId = `comment-${contact.id}-${comment.id}`;
        const existing = relatelNotes.getById(relatelId);
        if (existing) continue;

        const noteData = {
          relatel_id: relatelId,
          relatel_contact_id: String(contact.id),
          phone_number: phoneNumber,
          author: comment.author || comment.user_name || null,
          body: comment.body || comment.text || comment.content || '',
          created_at_rel: comment.created_at || null,
        };

        relatelNotes.upsert(noteData);

        if (phoneNumber) {
          try {
            const person = await pipedrive.findPersonByPhone(phoneNumber);
            if (person) {
              const { latestDealId } = (await pipedrive.getPersonWithDeals(person.id)) || {};
              const pipedriveNoteId = await pipedrive.createRelatelNote({
                personId: person.id,
                dealId: latestDealId || null,
                noteData: {
                  author: noteData.author,
                  body: noteData.body,
                  createdAt: noteData.created_at_rel,
                },
              });

              if (pipedriveNoteId) {
                relatelNotes.upsert({ ...noteData, pipedrive_person_id: person.id, pipedrive_note_id: pipedriveNoteId });
                console.log(`[Noter] ✅ Note oprettet i Pipedrive for kontakt ${contact.id}`);
              }
            }
          } catch (err) {
            console.error(`[Noter] Pipedrive-link fejl:`, err.message);
          }
        }
      }
    } catch (err) {
      if (!err.message.includes('404')) {
        console.error(`[Noter] Fejl for kontakt ${contact.id}:`, err.message);
      }
    }
  }
}

// ============================================================
// Start polling
// ============================================================
function start() {
  const intervalSec = config.pollIntervalSeconds;
  console.log(`[Jobs] Starter polling hvert ${intervalSec} sekunder`);

  cron.schedule(`*/${intervalSec} * * * * *`, () =>
    fetchNewCalls().catch(err => console.error('[Jobs] Poll fejl:', err.message))
  );

  cron.schedule('* * * * *', () =>
    fetchNewMessages().catch(err => console.error('[Jobs] SMS fejl:', err.message))
  );

  cron.schedule('*/5 * * * *', () =>
    fetchNewNotes().catch(err => console.error('[Jobs] Note fejl:', err.message))
  );

  cron.schedule('* * * * *', () =>
    processTranscriptions().catch(err => console.error('[Jobs] Transskription fejl:', err.message))
  );

  setTimeout(() => fetchNewCalls(), 2000);
  setTimeout(() => fetchNewMessages(), 4000);
  setTimeout(() => processTranscriptions(), 6000);
  setTimeout(() => fetchNewNotes(), 10000);
}

module.exports = { start, fetchNewCalls, fetchNewMessages, fetchNewNotes, processTranscriptions };
