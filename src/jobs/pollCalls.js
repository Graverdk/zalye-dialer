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
  // Hvornår pollede vi sidst?
  const lastPoll = state.get('last_poll_time') || new Date(Date.now() - 60 * 60 * 1000).toISOString();

  console.log(`[Poll] Henter opkald afsluttet efter: ${lastPoll}`);

  let allCalls = [];
  try {
    // Hent både ind- og udgående opkald siden sidste poll
    const [outgoing, incoming] = await Promise.all([
      relatel.getCalls({ direction: 'outgoing', endedAfter: lastPoll, limit: 50 }),
      relatel.getCalls({ direction: 'incoming', endedAfter: lastPoll, limit: 50 }),
    ]);
    allCalls = [...outgoing, ...incoming];
  } catch (err) {
    console.error('[Poll] Fejl ved hentning fra Relatel:', err.message);
    return;
  }

  // Opdater tidsstempel FØR vi begynder at processere (undgår dobbelt-processering)
  state.set('last_poll_time', new Date().toISOString());

  // Filtrer kun afsluttede opkald (med ended_at)
  const endedCalls = allCalls.filter(c => c.ended_at);
  console.log(`[Poll] Fandt ${endedCalls.length} afsluttede opkald`);

  for (const rc of endedCalls) {
    try {
      const normalized = relatel.normalizeCall(rc);

      // Check om opkaldet er nyt inden upsert
      const existingCall = calls.getByUuid(normalized.relatel_uuid);
      const isNew = !existingCall;

      // Gem/opdater i database
      calls.upsert(normalized);

      // Log optagelsesstatus for debug
      if (normalized.recording_url) {
        console.log(`[Poll] Opkald ${normalized.relatel_uuid}: har optagelse → klar til transskription`);
      } else {
        console.log(`[Poll] Opkald ${normalized.relatel_uuid}: ingen optagelse (varighed: ${normalized.duration_sec}s)`);
      }

      // Link til Pipedrive for alle NYE opkald, eller opkald der endnu ikke er linket
      if (isNew || !existingCall.pipedrive_person_id) {
        await linkToPipedrive(normalized);
      }
    } catch (err) {
      console.error(`[Poll] Fejl ved behandling af opkald ${rc.call_uuid}:`, err.message);
    }
  }
}

// ============================================================
// Forsøg at linke et opkald til Pipedrive-kontakt og deal
// ============================================================
async function linkToPipedrive(normalizedCall) {
  if (!normalizedCall.phone_number) return;

  try {
    const person = await pipedrive.findPersonByPhone(normalizedCall.phone_number);
    if (!person) return;

    const { latestDealId } = await pipedrive.getPersonWithDeals(person.id) || {};

    // Opdater opkaldet med Pipedrive-IDs
    calls.upsert({
      ...normalizedCall,
      pipedrive_person_id: person.id,
      pipedrive_deal_id:   latestDealId || null,
    });
  } catch (err) {
    console.error('[Poll] Fejl ved Pipedrive-opslag:', err.message);
  }
}

// ============================================================
// Kør AI-pipeline for opkald der venter på transskription
// ============================================================
async function processTranscriptions() {
  const pending = calls.getPendingTranscriptions();
  if (pending.length === 0) return;

  console.log(`[AI] Behandler ${pending.length} opkald...`);

  for (const call of pending) {
    console.log(`[AI] Behandler: ${call.relatel_uuid}`);

    // Marker som "processing" så vi ikke starter den igen
    calls.updateTranscription(call.relatel_uuid, {
      status: 'processing',
      transcription: null, summary: null, actionPoints: null, topics: null, pipedriveNoteId: null,
    });

    try {
      // 1. Download optagelse
      console.log(`[AI] Downloader optagelse...`);
      const { buffer, contentType } = await relatel.downloadRecording(call.recording_url);

      // 2. Transskribér med Whisper
      console.log(`[AI] Transskriberer med Whisper (dansk)...`);
      const transcription = await transcribe(buffer, contentType);

      if (!transcription || transcription.trim().length < 10) {
        throw new Error('Transskription er for kort eller tom');
      }

      // 3. Analysér med Claude (inkl. sales intelligence)
      console.log(`[AI] Analyserer med Claude (salgs-intelligence)...`);
      const analysis = await analyzeCall({
        transcription,
        direction: call.direction,
      });

      const { summary, actionPoints, topics } = analysis;

      // 4. Opdater call_type og pipeline kontekst
      if (analysis.callType && analysis.callType !== 'unknown') {
        db.prepare('UPDATE calls SET call_type = ? WHERE relatel_uuid = ?')
          .run(analysis.callType, call.relatel_uuid);
      }

      // 5. Gem sales insights i call_insights tabellen
      const dbCall = calls.getByUuid(call.relatel_uuid);
      if (dbCall) {
        console.log(`[AI] Gemmer salgs-insights...`);
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

      // 6. Opret note i Pipedrive
      let pipedriveNoteId = null;
      if (call.pipedrive_deal_id || call.pipedrive_person_id) {
        console.log(`[AI] Opretter Pipedrive-note...`);
        pipedriveNoteId = await pipedrive.createCallNote({
          dealId:    call.pipedrive_deal_id,
          personId:  call.pipedrive_person_id,
          callData: {
            direction:   call.direction,
            phoneNumber: call.phone_number,
            startedAt:   call.started_at,
            durationSec: call.duration_sec,
            summary,
            actionPoints,
            topics,
            transcription,
          },
        });

        // Opret også en aktivitet
        await pipedrive.createCallActivity({
          dealId:    call.pipedrive_deal_id,
          personId:  call.pipedrive_person_id,
          subject:   `${call.direction === 'outgoing' ? 'Udgående' : 'Indgående'} opkald — ${call.phone_number}`,
          durationSec: call.duration_sec,
          doneAt: call.ended_at,
        });
      }

      // 7. Gem alt i databasen
      calls.updateTranscription(call.relatel_uuid, {
        status: 'done',
        transcription,
        summary,
        actionPoints,
        topics,
        pipedriveNoteId,
      });

      console.log(`[AI] ✅ Færdig: ${call.relatel_uuid} (${analysis.callType}, sentiment: ${analysis.sentiment})`);

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
// Hent nye SMS-beskeder fra Relatel
// Tjekker både /messages og /chats (desktop app SMS bruger /chats)
// ============================================================
async function fetchNewMessages() {
  const lastPoll = state.get('last_sms_poll_time') || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  console.log(`[SMS] Henter beskeder efter: ${lastPoll}`);

  state.set('last_sms_poll_time', new Date().toISOString());

  // Hent fra /messages (API-sendte beskeder)
  let allMessages = [];
  try {
    const fromMessages = await relatel.getMessages({ after: lastPoll, limit: 50 });
    if (Array.isArray(fromMessages)) allMessages.push(...fromMessages);
    console.log(`[SMS] /messages: ${fromMessages.length || 0} beskeder`);
  } catch (err) {
    console.log('[SMS] /messages ikke tilgængeligt:', err.message);
  }

  // Hent fra /chats (desktop app SMS tråde)
  try {
    const recentChats = await relatel.getChats({ after: lastPoll, limit: 50 });
    if (Array.isArray(recentChats)) {
      for (const chat of recentChats) {
        // Udtræk beskeder fra chat-objektet (de kan ligge i .messages eller .last_message)
        const chatMsgs = chat.messages || (chat.last_message ? [chat.last_message] : []);
        const phone = (chat.remote_number || chat.contact_number || chat.phone || '').replace(/^(\+|00)/, '');
        for (const m of chatMsgs) {
          allMessages.push({ ...m, remote_number: phone || m.remote_number, _from_chat: chat.uuid || chat.id });
        }
      }
      console.log(`[SMS] /chats: ${recentChats.length} tråde`);
    }
  } catch (err) {
    console.log('[SMS] /chats ikke tilgængeligt:', err.message);
  }

  console.log(`[SMS] Fandt ${allMessages.length} beskeder i alt`);

  for (const msg of allMessages) {
    try {
      const normalized = relatel.normalizeMessage(msg);
      if (!normalized.relatel_id) continue;

      const existing = messages.getById(normalized.relatel_id);
      if (existing) continue; // Allerede gemt

      // Gem i database
      messages.upsert(normalized);

      // Link til Pipedrive
      if (normalized.phone_number) {
        try {
          const person = await pipedrive.findPersonByPhone(normalized.phone_number);
          if (person) {
            const { latestDealId } = await pipedrive.getPersonWithDeals(person.id) || {};
            messages.upsert({
              ...normalized,
              pipedrive_person_id: person.id,
              pipedrive_deal_id: latestDealId || null,
            });

            // Opret note i Pipedrive for SMS'en
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
              console.log(`[SMS] Oprettet Pipedrive-note ${noteId} for SMS ${normalized.relatel_id}`);
            }
          }
        } catch (err) {
          console.error(`[SMS] Fejl ved Pipedrive-link for ${normalized.relatel_id}:`, err.message);
        }
      }
    } catch (err) {
      console.error(`[SMS] Fejl ved behandling af besked:`, err.message);
    }
  }
}

// ============================================================
// Hent noter/kommentarer fra Relatel kontakter
// ============================================================
async function fetchNewNotes() {
  console.log('[Noter] Henter kontakter og kommentarer fra Relatel...');

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

        // Link til Pipedrive
        if (phoneNumber) {
          try {
            const person = await pipedrive.findPersonByPhone(phoneNumber);
            if (person) {
              const { latestDealId } = await pipedrive.getPersonWithDeals(person.id) || {};
              relatelNotes.upsert({
                ...noteData,
                pipedrive_person_id: person.id,
              });

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
              }
            }
          } catch (err) {
            console.error(`[Noter] Fejl ved Pipedrive-link:`, err.message);
          }
        }
      }
    } catch (err) {
      // Nogle kontakter har muligvis ikke comments-adgang
      if (!err.message.includes('404')) {
        console.error(`[Noter] Fejl for kontakt ${contact.id}:`, err.message);
      }
    }
  }
}

// ============================================================
// Start polling og AI-pipeline med cron
// ============================================================
function start() {
  const intervalSec = config.pollIntervalSeconds;

  console.log(`[Jobs] Starter polling hvert ${intervalSec} sekunder`);

  // Hent nye opkald
  cron.schedule(`*/${intervalSec} * * * * *`, async () => {
    await fetchNewCalls().catch(err =>
      console.error('[Jobs] Polling fejlede:', err.message)
    );
  });

  // Hent nye SMS-beskeder hvert 60. sekund
  cron.schedule('* * * * *', async () => {
    await fetchNewMessages().catch(err =>
      console.error('[Jobs] SMS polling fejlede:', err.message)
    );
  });

  // Hent noter fra Relatel hvert 5. minut
  cron.schedule('*/5 * * * *', async () => {
    await fetchNewNotes().catch(err =>
      console.error('[Jobs] Note polling fejlede:', err.message)
    );
  });

  // Kør AI-pipeline hvert minut (uafhængig af polling)
  cron.schedule('* * * * *', async () => {
    await processTranscriptions().catch(err =>
      console.error('[Jobs] Transskription fejlede:', err.message)
    );
  });

  // Kør straks ved opstart
  setTimeout(() => fetchNewCalls(), 2000);
  setTimeout(() => fetchNewMessages(), 4000);
  setTimeout(() => processTranscriptions(), 6000);
  setTimeout(() => fetchNewNotes(), 10000);
}

module.exports = { start, fetchNewCalls, fetchNewMessages, fetchNewNotes, processTranscriptions };
