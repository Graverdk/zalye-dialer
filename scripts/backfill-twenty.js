#!/usr/bin/env node
// ============================================================
// Backfill: skub opkald og SMS fra dialerens SQLite til Twenty.
//
//   node scripts/backfill-twenty.js --dry-run            # tæl kun, ingen kald til Twenty
//   node scripts/backfill-twenty.js                      # siden 2026-11-09 (importen)
//   node scripts/backfill-twenty.js --since 2026-11-20 --max-calls 200
//
// Skal køres der, hvor databasen ligger (dialer-servicen på Railway, fx
// `railway ssh` → `node scripts/backfill-twenty.js`), med TWENTY_API_KEY sat.
// Virker uanset CRM_MODE.
//
// - Idempotent: samtalerne nøgles på eksterntId (relatel-call:/relatel-sms:),
//   og fremdriften gemmes i tabellen twenty_backfill. Kør det igen, til der
//   står "Færdig".
// - Opkald med færdig analyse får resumé, coaching og (hvis
//   TWENTY_SEND_TRANSCRIPT=true) det rå transskript. Autofill og signaler
//   laves IKKE for gamle opkald (analysens kunderejse er ikke gemt i SQLite,
//   og gamle opkald må ikke overskrive nyere viden i Twenty).
// - Respekterer Twenty-vagten: stopper ved 401/429 og ved loftet
//   (--max-calls, ellers TWENTY_MAX_CALLS_PER_RUN).
// ============================================================
'use strict';

const args = process.argv.slice(2);
const arg = (name, def) => {
  const i = args.indexOf('--' + name);
  return i >= 0 ? (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true) : def;
};
const DRY = !!arg('dry-run', false);
const SINCE = String(arg('since', '2026-11-09'));
const LIMIT = parseInt(arg('limit', '0'), 10) || 0;
const MAX_CALLS = parseInt(arg('max-calls', '0'), 10) || 0;

if (!/^\d{4}-\d{2}-\d{2}/.test(SINCE)) {
  console.error('Brug --since ÅÅÅÅ-MM-DD');
  process.exit(1);
}

const config = require('../src/config');
if (!DRY && !config.twenty.apiKey) {
  console.error('TWENTY_API_KEY er ikke sat — intet at skubbe til. (Brug --dry-run for kun at tælle.)');
  process.exit(1);
}

const { db, calls } = require('../src/db/database');
const runStats = require('../src/services/runStats');
const crm = require('../src/crm');
const client = require('../src/crm/twentyClient');

const twenty = crm.adapters.twenty;
if (MAX_CALLS > 0) client.guard._setMaxCallsPerRun(MAX_CALLS);

db.exec(`CREATE TABLE IF NOT EXISTS twenty_backfill (
  kind    TEXT NOT NULL,
  key     TEXT NOT NULL,
  done_at TEXT NOT NULL,
  PRIMARY KEY (kind, key)
)`);
const isDone = db.prepare('SELECT 1 FROM twenty_backfill WHERE kind = ? AND key = ?');
const markDone = db.prepare('INSERT OR REPLACE INTO twenty_backfill (kind, key, done_at) VALUES (?, ?, ?)');

const json = (s, def) => { try { return s ? JSON.parse(s) : def; } catch { return def; } };

// call_insights + profile_json → det insights-objekt, buildInsightBlock forventer
function insightsFor(callId) {
  const r = db.prepare('SELECT * FROM call_insights WHERE call_id = ?').get(callId);
  if (!r) return null;
  const profile = json(r.profile_json, {}) || {};
  return {
    schemaVersion: profile.schemaVersion || 1,
    profile,
    journey: {},
    sentiment: r.sentiment,
    callOutcome: r.call_outcome,
    painPoints: json(r.pain_points, []),
    objections: json(r.objections, []),
    buyingSignals: json(r.buying_signals, []),
    competitorMentions: json(r.competitor_mentions, []),
    nextSteps: json(r.next_steps, []),
    customerStage: r.customer_stage,
    engagementScore: r.engagement_score,
    conversionLikelihood: r.conversion_likelihood,
    aiCoachingNote: r.ai_coaching_note,
  };
}

function setCols(table, keyCol, key, values) {
  const entries = Object.entries(values).filter(([, v]) => v !== undefined);
  if (!entries.length) return;
  db.prepare(`UPDATE ${table} SET ${entries.map(([c]) => `${c} = ?`).join(', ')} WHERE ${keyCol} = ?`)
    .run(...entries.map((e) => e[1]), key);
}

async function resolveMatch(row) {
  const m = crm.matchFromRow(twenty, row);
  if (m) return { match: m };
  const l = await crm.lookup(twenty, row.phone_number);
  if (l && l.deferred) return { stop: true };
  if (!l || !l.personId) return { none: true };
  return { match: l, save: crm.matchColumns(twenty, l) };
}

async function main() {
  const out = { since: SINCE, dryRun: DRY, calls: 0, sms: 0, skippedDone: 0, unmatched: 0, failed: 0, stopped: false };

  const callRows = db.prepare(`
    SELECT * FROM calls
    WHERE relatel_uuid NOT LIKE 'pending-%'
      AND datetime(COALESCE(ended_at, started_at)) >= datetime(?)
    ORDER BY datetime(COALESCE(ended_at, started_at)) ASC
  `).all(SINCE);
  const smsRows = db.prepare(`
    SELECT * FROM messages
    WHERE relatel_id IS NOT NULL AND datetime(sent_at) >= datetime(?)
    ORDER BY datetime(sent_at) ASC
  `).all(SINCE);

  if (DRY) {
    const pendingCalls = callRows.filter((r) => !isDone.get('call', r.relatel_uuid)).length;
    const pendingSms = smsRows.filter((r) => !isDone.get('sms', r.relatel_id)).length;
    console.log(JSON.stringify({ ...out, callsInDb: callRows.length, callsToPush: pendingCalls, smsInDb: smsRows.length, smsToPush: pendingSms }, null, 2));
    return;
  }

  let n = 0;
  for (const row of callRows) {
    if (LIMIT && n >= LIMIT) break;
    if (isDone.get('call', row.relatel_uuid)) { out.skippedDone++; continue; }
    if (twenty.isPaused()) { out.stopped = true; break; }
    const r = await resolveMatch(row);
    if (r.stop) { out.stopped = true; break; }
    if (r.none) { out.unmatched++; continue; }
    if (r.save) setCols('calls', 'relatel_uuid', row.relatel_uuid, r.save);
    const fresh = calls.getByUuid(row.relatel_uuid);

    let recordId = null;
    if (fresh.transcription_status === 'done' && fresh.summary) {
      const callData = {
        direction: fresh.direction,
        phoneNumber: fresh.phone_number,
        startedAt: fresh.started_at,
        durationSec: fresh.duration_sec,
        summary: fresh.summary,
        actionPoints: json(fresh.action_points, []),
        topics: json(fresh.topics, []),
        insights: insightsFor(fresh.id),
        coaching: json(fresh.coaching_json, null),
        isUnanswered: fresh.duration_sec != null && fresh.duration_sec < 25,
      };
      const rec = await twenty.completeCallRecord({ row: fresh, match: r.match, callData, transcript: fresh.transcription });
      recordId = rec && rec.recordId;
    } else {
      recordId = await twenty.upsertCallRecord({ row: fresh, match: r.match });
    }
    if (!recordId) {
      out.failed++;
      if (twenty.isPaused()) { out.stopped = true; break; }
      continue;
    }
    setCols('calls', 'relatel_uuid', row.relatel_uuid, { twenty_samtale_id: recordId });
    markDone.run('call', row.relatel_uuid, new Date().toISOString());
    out.calls++;
    n++;
  }

  if (!out.stopped) {
    for (const row of smsRows) {
      if (LIMIT && n >= LIMIT) break;
      if (isDone.get('sms', row.relatel_id)) { out.skippedDone++; continue; }
      if (twenty.isPaused()) { out.stopped = true; break; }
      const r = await resolveMatch(row);
      if (r.stop) { out.stopped = true; break; }
      if (r.none) { out.unmatched++; continue; }
      if (r.save) setCols('messages', 'relatel_id', row.relatel_id, r.save);
      const fresh = db.prepare('SELECT * FROM messages WHERE relatel_id = ?').get(row.relatel_id);
      const { recordId } = await twenty.upsertSms({ row: fresh, match: r.match });
      if (!recordId) {
        out.failed++;
        if (twenty.isPaused()) { out.stopped = true; break; }
        continue;
      }
      setCols('messages', 'relatel_id', row.relatel_id, { twenty_samtale_id: recordId });
      markDone.run('sms', row.relatel_id, new Date().toISOString());
      out.sms++;
      n++;
    }
  }

  console.log(JSON.stringify(out, null, 2));
  console.log(out.stopped
    ? 'Stoppet (Twenty-loft, pause eller 401) — kør scriptet igen for at fortsætte.'
    : 'Færdig. Umatchede numre (' + out.unmatched + ') kommer med, når personen findes i Twenty, og scriptet køres igen.');
}

runStats.run('Backfill-Twenty', main).then(
  () => process.exit(0),
  (e) => { console.error('Backfill fejlede:', e.message); process.exit(1); },
);
