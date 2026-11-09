'use strict';
const cron = require('node-cron');
const config = require('../config');
const { db, calls, messages, relatelNotes, insights, state, assertColumn } = require('../db/database');
const relatel = require('../services/relatel');
const { transcribe, buildDiarizedTranscript } = require('../services/transcription');
const claude = require('../services/claude');
const coaching = require('../services/coaching');
const runStats = require('../services/runStats');
const alerts = require('../services/alerts');
const crm = require('../crm');

// ============================================================
// CRM-laget (src/crm): P = det primære CRM (Pipedrive, eller Twenty ved
// CRM_MODE=twenty). Ved CRM_MODE=dual skrives Twenty bagefter som skygge
// via crm.shadowRun(), der aldrig kaster — Pipedrive er upåvirket.
//
// Telefonopslag caches i SQLite (phone_lookups, nøglet på (crm, sidste 8
// cifre)), så cachen overlever genstart og deploy. "Ingen match" gælder i
// 24 timer, 401/429 caches aldrig, og højst 25 opslag pr. kørsel pr. CRM.
// Se services/phoneLookupCache.js. Før gav et umatchet opkald et
// Pipedrive-kald hvert 2. minut i op til 7 dage (set 21/10 og 22–23/10).
// ============================================================
const P = crm.primary;
const PC = P.cols;

// UPDATE <table> SET <kolonner> WHERE <keyCol> = key. Kolonnenavne kommer fra
// adapterne (src/crm) og tjekkes mod en whitelist i database.js.
function setColumns(table, keyCol, key, values, { coalesce = [] } = {}) {
  const entries = Object.entries(values).filter(([c]) => c);
  if (!entries.length) return;
  const sets = entries.map(([c]) => {
    assertColumn(c);
    return coalesce.includes(c) ? `${c} = COALESCE(${c}, ?)` : `${c} = ?`;
  });
  db.prepare(`UPDATE ${table} SET ${sets.join(', ')} WHERE ${keyCol} = ?`).run(...entries.map((e) => e[1]), key);
}

// Telefonopslag i det primære CRM
async function lookupPerson(phoneNumber) {
  return crm.lookup(P, phoneNumber);
}

// Opgave ved ukendt nummer (kun Twenty har den). Best effort.
async function maybeUnknownNumberTask(adapter, nc) {
  if (!adapter.createUnknownNumberTask) return;
  try {
    await adapter.createUnknownNumberTask({ phone: nc.phone_number, call: nc });
  } catch (e) {
    console.error('[' + adapter.label + '] Opgave for ukendt nummer fejlede: ' + e.message);
  }
}

// Berigelse af Relatel-kontakter: hvornår hver kontakt sidst blev tjekket
// gemmes i DB (overlever genstart — før startede hver deploy en fuld scanning
// af 200 kontakter og ramte Pipedrives rate limit). Gen-tjek efter 7 dage.
const ENRICH_RECHECK_MS = 7 * 24 * 60 * 60 * 1000;
const ENRICH_MAX_PER_RUN = 25;
db.exec(`CREATE TABLE IF NOT EXISTS enriched_contacts (
  contact_id TEXT PRIMARY KEY,
  checked_at INTEGER NOT NULL
)`);
const enrichedContactIds = {
  has(id) {
    const row = db.prepare('SELECT checked_at FROM enriched_contacts WHERE contact_id = ?').get(id);
    return !!row && (Date.now() - row.checked_at) < ENRICH_RECHECK_MS;
  },
  add(id) {
    db.prepare(`INSERT INTO enriched_contacts (contact_id, checked_at) VALUES (?, ?)
      ON CONFLICT(contact_id) DO UPDATE SET checked_at = excluded.checked_at`).run(id, Date.now());
  },
};

// ============================================================
// In-flight-lås: samme job må aldrig køre to gange samtidig.
// Cron + webhook + manuelle triggers kan ellers overlappe og
// give fx duplikerede CRM-poster (begge ser "ingen post endnu").
// ============================================================
function withLock(name, fn) {
  let running = false;
  return async (...args) => {
    if (running) {
      console.log('[Lock] ' + name + ' kører allerede — springer over');
      return { skipped: true, reason: name + ' kører allerede' };
    }
    running = true;
    try {
      // Én kørsel: tællere for CRM-kald, cache og fejl, én logline til
      // sidst og tjek af 401-alarmen (services/runStats.js, services/alerts.js)
      return await runStats.run(name, () => fn(...args), { onEnd: (stats) => alerts.endRun(stats) });
    } finally {
      running = false;
    }
  };
}

// lookupPerson giver { personId, latestDealId, … } ved match, null ved "ingen
// match" og { deferred: true } når opslaget er udskudt (CRM'et på pause, fejl
// eller loftet på 25 opslag i kørslen). Udskudte opslag prøves igen næste kørsel.

// Relatel giver 50 opkald som standard. Efter nedetid kan der være flere.
const POLL_LIMIT = 200;

async function pollNewCalls() {
  // Default ved første kørsel: 24 timer tilbage (sikkerhedsnet hvis DB-volumet
  // mistes ved Railway-redeploy — så taber vi ikke alle opkald siden sidste deploy)
  const lastChecked = state.get('last_call_check') || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  // Tag tidsstemplet FØR vi spørger Relatel — ellers kan opkald, der slutter
  // mellem query og "nu", falde i et hul og aldrig blive hentet
  const checkTime = new Date().toISOString();
  console.log('[Poll] Henter opkald afsluttet efter: ' + lastChecked);
  const rawCalls = await relatel.getCalls({ endedAfter: lastChecked, limit: POLL_LIMIT });
  console.log('[Poll] Fandt ' + rawCalls.length + ' afsluttede opkald');
  if (rawCalls.length >= POLL_LIMIT) {
    console.warn('[Poll] Relatel returnerede ' + POLL_LIMIT + ' opkald (loftet) — der kan være flere');
  }

  // Opkald, der ikke blev færdige, fordi det primære CRM holdt pause eller loftet
  // på 25 opslag var nået, holder markøren tilbage, så de hentes igen næste gang.
  // Før rykkede markøren altid frem, og opkald uden optagelse kom aldrig i Pipedrive.
  let holdFrom = null;
  const holdCall = (nc) => {
    const ms = Date.parse(nc.ended_at || '');
    if (ms && (!holdFrom || ms < holdFrom)) holdFrom = ms;
  };

  try {
    for (const rc of rawCalls) {
      const nc = relatel.normalizeCall(rc);
      if (!nc.phone_number) continue;

      // Allerede i det primære CRM eller med optagelse: spring enkelt-opslaget i Relatel over
      // (vigtigt når markøren holdes tilbage, og de samme opkald hentes igen)
      const known = calls.getByUuid(nc.relatel_uuid);
      const knownDone = known && (known.recording_url || crm.hasRecord(P, known));
      if (!nc.recording_url && nc.relatel_uuid && !knownDone) {
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

      // Match evt. midlertidig 'pending-…'-række fra click-to-call:
      // overfør person/deal-koblingen (vi VED hvilken side der blev ringet fra
      // — bedre end gæt via "seneste åbne deal") og slet temp-rækken
      if (nc.direction === 'outgoing') {
        const temp = db.prepare(`
          SELECT * FROM calls
          WHERE relatel_uuid LIKE 'pending-%'
            AND substr(phone_number, -8) = substr(?, -8)
            AND created_at > strftime('%s', 'now') - 3600
          ORDER BY created_at DESC LIMIT 1
        `).get(nc.phone_number);
        if (temp) {
          if (temp[PC.person] || temp[PC.deal]) {
            setColumns('calls', 'relatel_uuid', nc.relatel_uuid,
              { [PC.person]: temp[PC.person], [PC.deal]: temp[PC.deal] },
              { coalesce: [PC.person, PC.deal] });
            console.log('[Poll] Click-to-call-kobling overført til ' + nc.relatel_uuid);
            // Nummeret er nu koblet til en person — ryd evt. "ingen match" i cachen
            if (temp[PC.person]) crm.remember(P, nc.phone_number, temp[PC.person], temp[PC.deal]);
          }
          db.prepare("DELETE FROM calls WHERE relatel_uuid = ?").run(temp.relatel_uuid);
        }
      }

      const existing = calls.getByUuid(nc.relatel_uuid);
      await syncPrimaryCall(nc, existing, holdCall);
      await syncShadowCall(nc);
    }
  } finally {
    const marker = holdFrom
      ? new Date(Math.min(holdFrom - 1000, Date.parse(checkTime))).toISOString()
      : checkTime;
    state.set('last_call_check', marker);
    if (holdFrom) console.log('[Poll] Opkald venter på ' + P.label + ' — markøren holdes på ' + marker);
  }
}

// Opkaldet i det primære CRM. Kun dette skridt kan holde markøren tilbage.
async function syncPrimaryCall(nc, existing, holdCall) {
  if (existing && crm.hasRecord(P, existing)) return;

  // Brug eksisterende kobling (fx fra click-to-call) før telefon-opslag
  let match = crm.matchFromRow(P, existing);
  if (!match) {
    const lookup = await lookupPerson(nc.phone_number);
    if (lookup && lookup.personId) {
      match = lookup;
    } else if (lookup && lookup.deferred) {
      holdCall(nc);
    } else if (lookup === null) {
      await maybeUnknownNumberTask(P, nc);
    }
  }
  if (!match) return;

  const recordId = await P.upsertCallRecord({ row: { ...(existing || {}), ...nc }, match });
  if (recordId) {
    setColumns('calls', 'relatel_uuid', nc.relatel_uuid, { [PC.record]: recordId, ...crm.matchColumns(P, match) });
    console.log('[Poll] Opkald lagt i ' + P.label + ' (' + recordId + ') for ' + nc.phone_number);
  } else if (P.isPaused()) {
    holdCall(nc);
  }
}

// Dual: samme opkald i Twenty som skygge. Holder aldrig markøren tilbage; et
// opkald, skyggen ikke nåede, kommer med ved analysen eller backfill-scriptet.
async function syncShadowCall(nc) {
  await crm.shadowRun('opkald', async (S) => {
    const row = calls.getByUuid(nc.relatel_uuid);
    if (!row || row[S.cols.record]) return;
    let match = crm.matchFromRow(S, row);
    if (!match) {
      const lookup = await crm.lookup(S, nc.phone_number);
      if (lookup === null) await maybeUnknownNumberTask(S, nc);
      if (!lookup || !lookup.personId) return;
      match = lookup;
    }
    const id = await S.upsertCallRecord({ row, match });
    if (id) setColumns('calls', 'relatel_uuid', nc.relatel_uuid, { [S.cols.record]: id, ...crm.matchColumns(S, match) });
  });
}

// ============================================================
// GDPR + omkostninger: transskribér KUN opkald med match i det primære CRM.
// Umatchede opkald (privatopkald, forkerte numre, leverandører...)
// venter i UNMATCHED_WAIT_DAYS på et match (fx nyt lead der oprettes)
// og markeres derefter 'skipped' — de transskriberes aldrig.
// ============================================================
const UNMATCHED_WAIT_DAYS = 7;

async function matchUnmatchedPendingCalls() {
  if (P.isPaused()) {
    console.log('[Match] ' + P.label + ' rate limit ramt for nylig — springer over');
    return;
  }
  const unmatched = db.prepare(`
    SELECT relatel_uuid, phone_number, ended_at FROM calls
    WHERE transcription_status = 'pending'
      AND ${PC.person} IS NULL
      AND recording_url IS NOT NULL
      AND ended_at IS NOT NULL
    ORDER BY ended_at DESC
    LIMIT 10
  `).all();

  // Flere opkald fra samme nummer giver kun ét CRM-kald: det første
  // opslag lander i phone_lookups, de næste rammer cachen.
  for (const c of unmatched) {
    if (!c.phone_number) continue;
    if (P.isPaused()) {
      console.warn('[Match] ' + P.label + ' rate limit — stopper kørslen');
      break;
    }
    const lookup = await lookupPerson(c.phone_number);
    if (lookup && lookup.personId) {
      const v = crm.matchColumns(P, lookup);
      setColumns('calls', 'relatel_uuid', c.relatel_uuid, v, { coalesce: Object.keys(v).filter((k) => k !== PC.person) });
      console.log('[Match] Sent match: ' + c.phone_number + ' -> person ' + lookup.personId + ' — transskriberes nu');
    }
  }
}

function expireUnmatchedCalls() {
  const result = db.prepare(`
    UPDATE calls SET transcription_status = 'skipped'
    WHERE transcription_status = 'pending'
      AND ${PC.person} IS NULL
      AND ended_at IS NOT NULL
      AND datetime(ended_at) < datetime('now', '-' || ? || ' days')
  `).run(UNMATCHED_WAIT_DAYS);
  if (result.changes > 0) {
    console.log('[Match] ' + result.changes + ' umatchede opkald udløbet (>' + UNMATCHED_WAIT_DAYS + ' dage) — transskriberes ikke');
  }
}

async function processTranscriptions() {
  expireUnmatchedCalls();
  await matchUnmatchedPendingCalls();

  const pending = calls.getPendingTranscriptions(PC.person);
  if (pending.length === 0) return;
  console.log('[AI] Behandler ' + pending.length + ' opkald...');

  for (const call of pending) {
    db.prepare("UPDATE calls SET transcription_status = 'processing', transcription_attempts = COALESCE(transcription_attempts, 0) + 1 WHERE relatel_uuid = ?")
      .run(call.relatel_uuid);
    const attempt = (call.transcription_attempts || 0) + 1;
    console.log('[AI] Behandler: ' + call.relatel_uuid + ' (forsøg ' + attempt + ')');

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

      // Detektér ubesvarede / for-korte opkald og spring Claude-analyse over
      // (så vi undgår meningsløse "handlingspunkter" som at "tjekke optagelsen")
      const shortCallThreshold = 25; // sek
      const minMeaningfulTextLength = 30; // tegn
      const isUnanswered = (
        (call.duration_sec != null && call.duration_sec < shortCallThreshold) ||
        !transcription ||
        transcription.replace(/[^a-zA-ZæøåÆØÅ]/g, '').length < minMeaningfulTextLength
      );

      if (isUnanswered) {
        console.log('[AI] Springer Claude-analyse over — ubesvaret/for kort opkald');
        const dirLabel = call.direction === 'outgoing' ? 'Udgående' : 'Indgående';
        summary = `${dirLabel} opkald uden besvaret samtale (varighed: ${call.duration_sec || 0}s).`;
        actionPoints = [];
        topics = [];
      } else if (transcription) {
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

      // ============================================================
      // SALGSCOACHING — kun når der var en rigtig samtale. Best effort:
      // fejler coachingen, lander analysen alligevel i CRM'et.
      // ============================================================
      let coachingResult = null;
      if (analysisResult && !isUnanswered) {
        try {
          const history = db.prepare(`
            SELECT coaching_json, started_at FROM calls
            WHERE coaching_json IS NOT NULL AND relatel_uuid != ?
            ORDER BY datetime(started_at) DESC LIMIT 10
          `).all(call.relatel_uuid);
          console.log('[Coach] Coacher kaldet...');
          coachingResult = await coaching.coachCall({
            transcription: diarizedTranscription || transcription,
            direction: call.direction,
            durationSec: call.duration_sec,
            analysis: analysisResult,
            history,
          });
          db.prepare('UPDATE calls SET coaching_json = ? WHERE relatel_uuid = ?')
            .run(JSON.stringify(coachingResult), call.relatel_uuid);
        } catch (coachErr) {
          console.error('[Coach] Coaching fejlede (analysen sendes alligevel):', coachErr.message);
          coachingResult = null;
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
        insights: analysisResult,
        coaching: coachingResult,
        isUnanswered,
      };
      const transcriptText = diarizedTranscription || transcription;

      // Re-try opslag i det primære CRM, hvis vi ikke fik fat i personen ved første poll
      // (typisk fordi lead først blev konverteret til person efter opkaldet)
      let match = crm.matchFromRow(P, call);
      if (!match && !crm.hasRecord(P, call) && call.phone_number) {
        const lookup = await lookupPerson(call.phone_number);
        if (lookup && lookup.personId) {
          match = lookup;
          setColumns('calls', 'relatel_uuid', call.relatel_uuid, crm.matchColumns(P, match));
          console.log('[AI] Sent-link til ' + P.label + ' lykkedes for ' + call.phone_number + ' -> personId ' + match.personId);
        }
      }

      await writeAnalysis(P, call, match, callData, { analysisResult, coachingResult, transcriptText });

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
            profile: analysisResult.profile,
          });
          console.log('[AI] Sales intelligence gemt for call ' + call.id);
        } catch (insightErr) {
          console.error('[AI] Kunne ikke gemme insights:', insightErr.message);
        }
      }

      // Dual: samme analyse i Twenty som skygge (fejl her rører ikke Pipedrive)
      await crm.shadowRun('analyse', async (S) => {
        const row = calls.getByUuid(call.relatel_uuid);
        let sMatch = crm.matchFromRow(S, row);
        if (!sMatch) {
          const lookup = await crm.lookup(S, call.phone_number);
          if (!lookup || !lookup.personId) return;
          sMatch = lookup;
          setColumns('calls', 'relatel_uuid', call.relatel_uuid, crm.matchColumns(S, sMatch));
        }
        const { pipedrive: _pd, ...shadowData } = callData;
        await writeAnalysis(S, row, sMatch, shadowData, { analysisResult, coachingResult, transcriptText });
      });

      // Nulstil fejl-tilstand ved success
      db.prepare("UPDATE calls SET transcription_error = NULL WHERE relatel_uuid = ?")
        .run(call.relatel_uuid);
      console.log('[AI] Faerdig: ' + call.relatel_uuid);
    } catch (err) {
      console.error('[AI] Fejl ved transskription for ' + call.relatel_uuid + ' (forsøg ' + attempt + '): ' + err.message);
      // Gem fejl-besked i DB så vi kan se hvad der gik galt
      db.prepare("UPDATE calls SET transcription_status = 'failed', transcription_error = ? WHERE relatel_uuid = ?")
        .run(err.message.substring(0, 500), call.relatel_uuid);
    }
  }
}

// ============================================================
// Analysen ud i ét CRM: udfyld tomme felter → opdatér/opret posten →
// (Twenty) signaler. Rækkefølgen for Pipedrive er som før.
// ============================================================
async function writeAnalysis(adapter, row, match, callData, { analysisResult, coachingResult, transcriptText }) {
  const personId = match && match.personId;

  // UDFYLD TOMME FELTER (antal ansatte, fag, systemer, rolle, anledning,
  // indvending …) — og skriv i noten, hvad der blev gjort. Best effort.
  let af = null;
  if (analysisResult && personId && !adapter.isPaused()) {
    try {
      af = await adapter.autofill({ match, analysis: analysisResult, coaching: coachingResult, row });
      // callData.pipedrive → blokken "Pipedrive (skema v1)"; callData.twenty → "Twenty (skema v1)"
      const block = { personName: af.personName, dealTitle: af.dealTitle, changes: af.changes };
      if (af.stageChange) block.stageChange = af.stageChange;
      callData[adapter.name] = block;
      if (af.changes.length) console.log('[' + adapter.label + '] Udfyldte tomme felter: ' + af.changes.map((c) => c.felt).join(', '));
    } catch (afErr) {
      console.error('[' + adapter.label + '] Autoudfyldning fejlede:', afErr.message);
    }
  }

  const rec = await adapter.completeCallRecord({
    row, match: match || {}, callData, transcript: transcriptText,
  });
  if (rec && rec.recordId && (rec.created || !row[adapter.cols.record])) {
    setColumns('calls', 'relatel_uuid', row.relatel_uuid, { [adapter.cols.record]: rec.recordId });
  }

  // Signaler (kun Twenty): én gang pr. opkald
  if (adapter.afterAnalysis && rec && rec.recordId && analysisResult && !row.twenty_signaler_at) {
    const n = await adapter.afterAnalysis({ recordId: rec.recordId, match, analysis: analysisResult, autofill: af });
    if (n !== null) setColumns('calls', 'relatel_uuid', row.relatel_uuid, { twenty_signaler_at: new Date().toISOString() });
  }
  return rec;
}

// ============================================================
// Auto-retry: find failed opkald med < 3 forsøg og sæt dem til pending igen
// Kører hvert 5. minut via cron — så user skal aldrig manuelt kalde retry
// ============================================================
async function autoRetryFailed() {
  const MAX_ATTEMPTS = 3;
  const result = db.prepare(`
    UPDATE calls
    SET transcription_status = 'pending'
    WHERE transcription_status = 'failed'
      AND COALESCE(transcription_attempts, 0) < ?
      AND recording_url IS NOT NULL
      AND recording_url != ''
  `).run(MAX_ATTEMPTS);
  if (result.changes > 0) {
    console.log('[AutoRetry] Sat ' + result.changes + ' failed opkald tilbage til pending');
    // Kick-start processering med det samme (i stedet for at vente på næste cron-tick)
    // — via den låste version, så vi aldrig kører dobbelt
    jobs.processTranscriptions().catch(e => console.error('[AutoRetry] Fejl:', e.message));
  }
}

// ============================================================
// CATCH-UP: Hent alle opkald fra sidste N dage og sæt dem
// i kø til transskription + CRM-sync. Bruges til at
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
    if (crm.hasRecord(P, existing) && existing.transcription_status === 'done' && existing.transcription) {
      alreadyDone++;
      await syncShadowCall(nc);
      continue;
    }

    imported++;

    // Prøv at linke til det primære CRM, hvis vi ikke har person_id endnu
    let match = crm.matchFromRow(P, existing);
    if (!match) {
      const lookup = await lookupPerson(nc.phone_number);
      if (lookup && lookup.personId) {
        match = lookup;
        setColumns('calls', 'relatel_uuid', nc.relatel_uuid, crm.matchColumns(P, match));
        linked++;
      }
    }

    // Opret opkaldet i CRM'et hvis der er match og ingen post endnu
    // (transskription tilføjes senere via processTranscriptions hvis recording findes)
    let notesCreated = 0;
    if (match && !crm.hasRecord(P, existing)) {
      const recordId = await P.upsertCallRecord({ row: { ...existing, ...nc }, match });
      if (recordId) {
        setColumns('calls', 'relatel_uuid', nc.relatel_uuid, { [PC.record]: recordId });
        notesCreated++;
        console.log('[Backfill] Opkald lagt i ' + P.label + ' (' + recordId + ') for ' + nc.phone_number);
      }
    }
    await syncShadowCall(nc);

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
// + gem beskeder ALTID i DB (ogsaa uden CRM-match)
// saa de ikke genbehandles naeste minut
// ============================================================
async function fetchNewMessages() {
  const lastChecked = state.get('last_sms_check') || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const checkTime = new Date().toISOString(); // tidsstempel FØR fetch — undgår huller
  const newMessages = [];
  try {
    // /messages virker faktisk til at LISTE SMS (selvom dokumentationen siger den kun er til send)
    // Debug viste 7 beskeder fra /messages mens /chats returnerede 0
    const rawMessages = await relatel.getMessages({ after: lastChecked, limit: 200 });
    console.log('[SMS] /messages returnerede ' + (rawMessages || []).length + ' beskeder (created_at efter ' + lastChecked + ')');

    for (const m of (rawMessages || [])) {
      const msgId = (m.id || m.uuid) ? String(m.id || m.uuid) : null;
      if (!msgId) continue;
      const existing = messages.getById(msgId);
      if (existing) continue;
      newMessages.push(m);
    }
    if (newMessages.length > 0) {
      console.log('[SMS] ' + newMessages.length + ' nye beskeder fundet');
    }
    // Ryk kun checkpointet frem når Relatel-kaldet lykkedes —
    // ellers mister vi beskeder i vinduet ved API-nedbrud
    state.set('last_sms_check', checkTime);
  } catch (e) {
    console.error('[SMS] /messages fejl:', e.message);
  }

  for (const msg of newMessages) {
    const nm = relatel.normalizeMessage(msg);
    if (!nm.phone_number) continue;

    // Gem ALTID i DB saa beskeden ikke genbehandles — koblingen til CRM'et
    // sker i linkUnmatchedMessages() nedenfor, som også samler ældre SMS op
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
  }

  await linkUnmatchedMessages();
}

// ============================================================
// SMS uden post i CRM'et: prøv at koble igen i UNMATCHED_WAIT_DAYS.
// Samme regel som opkald — en SMS fra et nyt nummer kommer med, hvis
// personen oprettes i CRM'et inden for vinduet. Dækker også SMS, hvor
// personen blev fundet, men oprettelsen fejlede.
// ============================================================
async function linkUnmatchedMessages() {
  await linkMessagesFor(P);
  await crm.shadowRun('SMS', (S) => linkMessagesFor(S));
}

async function linkMessagesFor(adapter) {
  const c = adapter.cols;
  const cutoff = new Date(Date.now() - UNMATCHED_WAIT_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const notSynced = [c.record, c.legacyNote].filter(Boolean).map((col) => `${assertColumn(col)} IS NULL`).join(' AND ');
  const pending = db.prepare(`
    SELECT * FROM messages
    WHERE ${notSynced}
      AND sent_at >= ?
    ORDER BY sent_at ASC
    LIMIT 50
  `).all(cutoff);

  for (const m of pending) {
    let match = crm.matchFromRow(adapter, m);
    if (!match) {
      const lookup = await crm.lookup(adapter, m.phone_number);
      if (!lookup || !lookup.personId) continue;
      match = lookup;
      const v = crm.matchColumns(adapter, match);
      setColumns('messages', 'relatel_id', m.relatel_id, v, { coalesce: Object.keys(v).filter((k) => k !== c.person) });
    }

    const { recordId, noteId } = await adapter.upsertSms({ row: m, match });
    if (recordId) {
      setColumns('messages', 'relatel_id', m.relatel_id, { [c.record]: recordId });
      console.log('[SMS] SMS lagt i ' + adapter.label + ' (' + recordId + ') for ' + m.phone_number);
    } else if (noteId) {
      messages.setNoteId(m.relatel_id, noteId);
      console.log('[SMS] SMS-note oprettet som nødløsning (note ' + noteId + ') for ' + m.phone_number);
    }
  }
}

async function fetchNewNotes() {
  const lastChecked = state.get('last_notes_check') || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const checkTime = new Date().toISOString(); // tidsstempel FØR fetch — undgår huller
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
      const sLookup = await crm.shadowRun('note-opslag', (S) => crm.lookup(S, contact.number));
      const pOk = !!(lookup && lookup.personId);
      const sOk = !!(sLookup && sLookup.personId);
      if (!pOk && !sOk) continue;
      totalFresh += freshComments.length;

      for (const comment of freshComments) {
        const noteId = comment.id ? String(comment.id) : null;
        if (!noteId) continue;

        const existing = relatelNotes.getById(noteId);
        const needPrimary = pOk && !(existing && existing[PC.noteRecord]);
        const needShadow = sOk && crm.shadow && !(existing && existing[crm.shadow.cols.noteRecord]);
        if (!needPrimary && !needShadow) continue;

        const body = comment.body || comment.text || comment.comment || '';
        const author = comment.author || comment.user || null;
        const createdAt = comment.created_at || null;
        const note = {
          relatel_id: noteId,
          author: (author && typeof author === 'object') ? (author.name || author.email || null) : author,
          body,
          created_at_rel: createdAt,
        };

        const row = {
          relatel_id: noteId,
          relatel_contact_id: String(contact.id),
          phone_number: contact.number,
          author: (author && typeof author === 'object') ? (author.name || null) : author,
          body,
          created_at_rel: createdAt,
        };
        if (needPrimary) {
          const recId = await P.upsertRelatelNote({ note, match: lookup });
          row[PC.notePerson] = lookup.personId;
          row[PC.noteRecord] = recId;
          if (recId) console.log('[Noter] Note lagt i ' + P.label + ' (' + recId + ') for kontakt ' + lookup.personId);
        }
        if (needShadow) {
          const sId = await crm.shadowRun('note', (S) => S.upsertRelatelNote({ note, match: sLookup }));
          row[crm.shadow.cols.notePerson] = sLookup.personId;
          row[crm.shadow.cols.noteRecord] = sId;
        }
        relatelNotes.upsert(row);
      }
    }
    if (totalFresh > 0) {
      console.log('[Noter] Behandlede ' + totalFresh + ' nye noter');
    }
    state.set('last_notes_check', checkTime); // kun frem ved succes
  } catch (e) {
    console.error('[Noter] Fejl:', e.message);
  }
}

// ============================================================
// OPTIMERET: Track berigede kontakter saa vi ikke scanner
// de samme 200 kontakter hvert 5. minut
// ============================================================
async function enrichContacts() {
  try {
    if (P.isPaused()) {
      console.log('[Enrich] ' + P.label + ' rate limit ramt for nylig — springer over');
      return;
    }
    const contacts = await relatel.getContacts({ limit: 200 });
    let enriched = 0;
    let inSync = 0;
    let lookups = 0;

    for (const contact of contacts) {
      if (!contact.number) continue;

      // Spring over kontakter tjekket inden for de sidste 7 dage (gemt i DB)
      if (enrichedContactIds.has(String(contact.id))) continue;

      // Højst ENRICH_MAX_PER_RUN opslag pr. kørsel — resten tages næste halve time
      if (lookups >= ENRICH_MAX_PER_RUN) break;
      lookups++;

      // Slå op i det primære CRM — KILDE TIL SANDHED (Twenty ved CRM_MODE=twenty)
      const found = await P.getContactForRelatel(contact.number);
      if (found.status === 'error') {
        // Ikke "ingen match" — CRM'et afviste kaldet. Stop og prøv næste kørsel
        console.warn('[Enrich] ' + P.label + ' rate limit — stopper kørslen');
        break;
      }
      if (found.status !== 'found') {
        // Ingen match — lad Relatel-navnet stå som det er
        enrichedContactIds.add(String(contact.id));
        continue;
      }

      // Byg ønsket visningsnavn: "Navn (Firma)"
      const desiredName = found.company
        ? found.name + ' (' + found.company + ')'
        : found.name;
      const desiredEmail = found.email || null;

      // Hvis Relatel-kontakten allerede matcher CRM'et → skip update
      // (undgår at spamme Relatel API med unødvendige opdateringer)
      const currentName = (contact.name || '').trim();
      const currentEmail = (contact.email || '').trim();
      if (currentName === desiredName && (!desiredEmail || currentEmail === desiredEmail)) {
        enrichedContactIds.add(String(contact.id));
        inSync++;
        continue;
      }

      // Opdatér Relatel-kontakt med CRM-data (overskriver evt. forkerte navne)
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
      console.log('[Enrich] Opdaterede ' + enriched + ' kontakter i Relatel (' + P.label + ' er sandhed)');
    }
    if (inSync > 0) {
      console.log('[Enrich] ' + inSync + ' kontakter er allerede i sync');
    }
  } catch (e) {
    console.error('[Enrich] Fejl:', e.message);
  }
}

// ============================================================
// Låste versioner af alle jobs — brug ALTID disse udadtil
// (cron, webhook, routes), så intet job kører dobbelt.
// ============================================================
const jobs = {
  pollNewCalls:           withLock('Poll', pollNewCalls),
  fetchNewMessages:       withLock('SMS', fetchNewMessages),
  fetchNewNotes:          withLock('Noter', fetchNewNotes),
  processTranscriptions:  withLock('AI', processTranscriptions),
  enrichContacts:         withLock('Enrich', enrichContacts),
  retryMissingRecordings: withLock('Retry', retryMissingRecordings),
  backfillCalls:          withLock('Backfill', backfillCalls),
  autoRetryFailed:        withLock('AutoRetry', autoRetryFailed),
  purgeTwentyTranscripts: withLock('TwentyRetention', purgeTwentyTranscripts),
};

// ============================================================
// Oprydning: slet 'pending-…'-temp-rækker fra click-to-call
// der aldrig blev matchet til et rigtigt opkald (fx optaget/ej besvaret)
// ============================================================
function cleanupPendingRows() {
  try {
    const result = db.prepare(`
      DELETE FROM calls
      WHERE relatel_uuid LIKE 'pending-%'
        AND created_at < strftime('%s', 'now') - 86400
    `).run();
    if (result.changes > 0) {
      console.log('[Cleanup] Slettede ' + result.changes + ' forældede pending-rækker');
    }
  } catch (e) {
    console.error('[Cleanup] Fejl:', e.message);
  }
}

// ============================================================
// GDPR-retention: slet rå samtaletekst fra lokal DB efter 12 mdr.
// Resumé, handlingspunkter og salgsindsigter beholdes — og
// Pipedrive-noten (med den fulde tekst) røres ikke.
// OBS: holdes i sync med dato-guarden i routes/calls.js (retry-transcription)
// ============================================================
const TRANSCRIPT_RETENTION_MONTHS = 12;

function cleanupOldTranscriptions() {
  try {
    const result = db.prepare(`
      UPDATE calls SET transcription = NULL
      WHERE transcription IS NOT NULL
        AND ended_at IS NOT NULL
        AND datetime(ended_at) < datetime('now', '-' || ? || ' months')
    `).run(TRANSCRIPT_RETENTION_MONTHS);
    if (result.changes > 0) {
      console.log('[Retention] Fjernede rå transskription fra ' + result.changes + ' opkald (>' + TRANSCRIPT_RETENTION_MONTHS + ' mdr.)');
    }
  } catch (e) {
    console.error('[Retention] Fejl:', e.message);
  }
}

// ============================================================
// GDPR-retention i Twenty: tøm samtale.transskript på samtaler med
// kilde=DIALER ældre end 12 mdr. Kører kun ved CRM_MODE=dual|twenty.
// ============================================================
async function purgeTwentyTranscripts() {
  if (!crm.twentyActive) return null;
  try {
    return await crm.adapters.twenty.purgeOldTranscripts({ state, months: TRANSCRIPT_RETENTION_MONTHS });
  } catch (e) {
    console.error('[Retention] Twenty-oprydning fejlede:', e.message);
    return null;
  }
}

function start() {
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

  // Ryd op i gamle temp-rækker ved boot og derefter dagligt kl. 03:30
  cleanupPendingRows();
  cron.schedule('0 30 3 * * *', cleanupPendingRows);

  // GDPR-retention: ryd gamle rå transskriptioner ved boot + dagligt kl. 03:45
  cleanupOldTranscriptions();
  cron.schedule('0 45 3 * * *', cleanupOldTranscriptions);

  // Samme regel for transskripter i Twenty: dagligt kl. 03:50
  if (crm.twentyActive) {
    cron.schedule('0 50 3 * * *', async () => {
      try { await jobs.purgeTwentyTranscripts(); } catch (e) { console.error('[Retention] Fejl:', e.message); }
    });
  }

  // ============================================================
  // OPTIMERET polling-cadence — reducerer unødvendige API-kald
  // når der sjældent er nye opkald. Bruger /api/webhook/relatel
  // endpointet til øjeblikkelig processering hvis webhook konfigureres.
  // ============================================================

  // Med Relatel-webhooks slået til (signeringsnøgle sat) er polling kun et
  // sikkerhedsnet: webhooken vækker os med det samme, cron fanger evt. tabte events.
  const webhooksOn = !!config.security.relatelWebhookSigningSecret;
  const callCron = webhooksOn ? '0 */15 * * * *' : '0 * * * * *';
  const smsCron  = webhooksOn ? '30 */15 * * * *' : '0 */5 * * * *';

  // Opkald: hvert minut uden webhooks, hvert 15. minut med
  cron.schedule(callCron, async () => {
    try { await jobs.pollNewCalls(); } catch (e) { console.error('[Poll] Fejl:', e.message); }
  });

  // SMS: hvert 5. minut uden webhooks, hvert 15. minut med
  cron.schedule(smsCron, async () => {
    try { await jobs.fetchNewMessages(); } catch (e) { console.error('[SMS] Fejl:', e.message); }
  });

  // Transskription: hvert 2. minut (før: 1 min)
  cron.schedule('30 */2 * * * *', async () => {
    try { await jobs.processTranscriptions(); } catch (e) { console.error('[AI] Fejl:', e.message); }
  });

  // Retry manglende recordings: hvert 3. minut (før: 1 min)
  cron.schedule('20 */3 * * * *', async () => {
    try { await jobs.retryMissingRecordings(); } catch (e) { console.error('[Retry] Fejl:', e.message); }
  });

  // Noter: hvert 15. minut (før: 5 min)
  cron.schedule('0 */15 * * * *', async () => {
    try { await jobs.fetchNewNotes(); } catch (e) { console.error('[Noter] Fejl:', e.message); }
  });

  // Kontakt-berigelse: hvert 30. minut (før: 5 min) — kører stille i baggrunden
  cron.schedule('15 */30 * * * *', async () => {
    try { await jobs.enrichContacts(); } catch (e) { console.error('[Enrich] Fejl:', e.message); }
  });

  // Auto-retry failed transskriptioner: hvert 10. minut (før: 5 min)
  cron.schedule('45 */10 * * * *', async () => {
    try { await jobs.autoRetryFailed(); } catch (e) { console.error('[AutoRetry] Fejl:', e.message); }
  });

  console.log('[CRM] CRM_MODE=' + crm.mode + ' — primær: ' + P.label + (crm.shadow ? ', skygge: ' + crm.shadow.label : ''));
  console.log('[Poll] Cron-jobs startet — webhooks ' + (webhooksOn ? 'TIL (opkald+SMS: sikkerhedsnet hvert 15. min)' : 'FRA (opkald: 60s, SMS: 5min)') + ', transskription: 2min, retry: 3min, noter: 15min, berigelse: 30min, auto-retry: 10min');
}

// Eksportér de LÅSTE versioner — webhook/routes må ikke kunne starte dobbeltkørsler
module.exports = {
  start,
  pollNewCalls: jobs.pollNewCalls,
  fetchNewMessages: jobs.fetchNewMessages,
  fetchNewNotes: jobs.fetchNewNotes,
  processTranscriptions: jobs.processTranscriptions,
  enrichContacts: jobs.enrichContacts,
  retryMissingRecordings: jobs.retryMissingRecordings,
  backfillCalls: jobs.backfillCalls,
  autoRetryFailed: jobs.autoRetryFailed,
  purgeTwentyTranscripts: jobs.purgeTwentyTranscripts,
};
