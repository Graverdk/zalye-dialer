// ============================================================
// Fejlalarm: når Pipedrive eller Relatel svarer 401 i to kørsler i træk,
// sendes én alarm pr. time pr. tjeneste. En død nøgle må ikke kunne stå
// i dagevis, uden at nogen opdager det (sket 22/10).
//
// Alarmen sendes som JSON til ALERT_WEBHOOK_URL (fx en Teams-workflow eller
// et Make-scenarie, der sender mail til ALERT_EMAIL). Er den ikke sat,
// skrives alarmen kun i loggen. Webhook-URL'en logges aldrig.
// Tilstanden ligger i SQLite, så en genstart ikke nulstiller tælleren.
// ============================================================
const fetch = require('node-fetch');
const config = require('../config');
const runStats = require('./runStats');

const ALERT_INTERVAL_MS = 60 * 60 * 1000;
const RUNS_BEFORE_ALERT = 2;
const LABEL = { pipedrive: 'Pipedrive', relatel: 'Relatel' };

let dbRef = null;
let sendImpl = null;
const knownOk = new Map(); // provider -> true, når tælleren står på 0 (undgår skrivning ved hvert OK-svar)
const ensured = new WeakSet();

function getDb() {
  if (!dbRef) dbRef = require('../db/database').db;
  if (!ensured.has(dbRef)) {
    dbRef.exec(`CREATE TABLE IF NOT EXISTS alert_state (
      provider          TEXT PRIMARY KEY,
      consecutive_runs  INTEGER NOT NULL DEFAULT 0,
      last_alert_at     INTEGER
    )`);
    ensured.add(dbRef);
  }
  return dbRef;
}

// Til tests: indsæt egen database og afsender
function configure({ db, send } = {}) {
  if (db) dbRef = db;
  if (send) sendImpl = send;
  knownOk.clear();
}

function noteAuthFailure(provider) {
  runStats.current().authFailures.add(provider);
}

function noteSuccess(provider) {
  if (knownOk.get(provider)) return;
  getDb().prepare(`INSERT INTO alert_state (provider, consecutive_runs) VALUES (?, 0)
    ON CONFLICT(provider) DO UPDATE SET consecutive_runs = 0`).run(provider);
  knownOk.set(provider, true);
}

async function endRun(stats, now = Date.now()) {
  const sent = [];
  for (const provider of stats.authFailures) {
    knownOk.set(provider, false);
    const db = getDb();
    db.prepare(`INSERT INTO alert_state (provider, consecutive_runs) VALUES (?, 1)
      ON CONFLICT(provider) DO UPDATE SET consecutive_runs = consecutive_runs + 1`).run(provider);
    const row = db.prepare('SELECT consecutive_runs, last_alert_at FROM alert_state WHERE provider = ?').get(provider);
    if (row.consecutive_runs >= RUNS_BEFORE_ALERT && (!row.last_alert_at || now - row.last_alert_at >= ALERT_INTERVAL_MS)) {
      db.prepare('UPDATE alert_state SET last_alert_at = ? WHERE provider = ?').run(now, provider);
      await (sendImpl || send)({ provider, runs: row.consecutive_runs, jobName: stats.name });
      sent.push(provider);
    }
  }
  return sent;
}

function buildMessage({ provider, runs, jobName }) {
  const name = LABEL[provider] || provider;
  const title = 'Zalye-dialer: ' + name + ' afviser nøglen (401)';
  const text = name + ' har svaret 401 i ' + runs + ' kørsler i træk (seneste: ' + (jobName || 'ukendt') + '). '
    + 'Opkald, SMS og noter kommer ikke i Pipedrive, før nøglen er skiftet i Railway (zalye-dialer › Variables) og rullet ud. '
    + 'Næste alarm tidligst om 1 time.';
  return { title, text };
}

async function send(info) {
  const { title, text } = buildMessage(info);
  const url = config.alerts.webhookUrl;
  if (!url) {
    console.error('[Alarm] ' + title + '. ' + text + ' (ALERT_WEBHOOK_URL er ikke sat, så alarmen står kun i loggen)');
    return false;
  }
  const payload = {
    title,
    text,
    to: config.alerts.email,
    source: 'zalye-dialer',
    provider: info.provider,
    // Teams-workflows ("Post to a chat when a webhook request is received") læser kortet herunder
    type: 'message',
    attachments: [{
      contentType: 'application/vnd.microsoft.card.adaptive',
      content: {
        $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
        type: 'AdaptiveCard',
        version: '1.4',
        body: [
          { type: 'TextBlock', text: title, weight: 'Bolder', wrap: true },
          { type: 'TextBlock', text, wrap: true },
        ],
      },
    }],
  };
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      timeout: 10000,
    });
    if (!res.ok) {
      console.error('[Alarm] Alarm-webhooken svarede ' + res.status + ' — alarmen er måske ikke nået frem: ' + title);
      return false;
    }
    console.log('[Alarm] Sendt: ' + title);
    return true;
  } catch (e) {
    console.error('[Alarm] Kunne ikke sende alarmen (' + e.message + '): ' + title);
    return false;
  }
}

module.exports = { noteAuthFailure, noteSuccess, endRun, configure, buildMessage, RUNS_BEFORE_ALERT, ALERT_INTERVAL_MS };
