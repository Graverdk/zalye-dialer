const cron = require('node-cron');
const config = require('../config');
const { db, calls, insights, state } = require('../db/database');
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

      // Gem/opdater i database
      calls.upsert(normalized);

      // Sæt transcription_status til pending hvis der er en optagelse
      if (normalized.recording_url && !calls.getByUuid(normalized.relatel_uuid)?.transcription) {
        // Opret Pipedrive-kobling baseret på telefonnummer
        await linkToPipedrive(normalized);
      }
    } catch (err) {
      console.error(`[Poll] Fejl ved behandling af opkald ${rc.uuid}:`, err.message);
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

  // Kør AI-pipeline hvert minut (uafhængig af polling)
  cron.schedule('* * * * *', async () => {
    await processTranscriptions().catch(err =>
      console.error('[Jobs] Transskription fejlede:', err.message)
    );
  });

  // Kør straks ved opstart
  setTimeout(() => fetchNewCalls(), 2000);
  setTimeout(() => processTranscriptions(), 5000);
}

module.exports = { start, fetchNewCalls, processTranscriptions };
