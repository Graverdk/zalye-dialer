// ============================================================
// Én kørsel = ét job-tick (Poll, AI, SMS, Noter …).
// Tællerne følger kørslen via AsyncLocalStorage, så to jobs, der kører
// samtidig, ikke blander deres tal. Uden for en kørsel (fx et kald fra
// panelet) tælles i et engangsobjekt, der ikke logges.
// ============================================================
const { AsyncLocalStorage } = require('async_hooks');

const als = new AsyncLocalStorage();

function createStats(name = null) {
  return {
    name,
    pipedriveCalls: 0,    // kald, der faktisk gik ud til Pipedrive
    pipedriveSkipped: 0,  // kald, der blev holdt tilbage (pause efter 401/429)
    pipedriveErrors: 0,
    relatelErrors: 0,
    cacheHits: 0,         // "Cache: ingen match" — opslag, der blev sparet
    lookups: 0,           // telefonopslag i Pipedrive i denne kørsel
    deferred: 0,          // opslag udskudt til næste kørsel (loft eller pause)
    stopPipedrive: false, // sat ved 401: resten af kørslen rører ikke Pipedrive
    stopRelatel: false,   // sat ved 401 fra Relatel
    // Twenty (CRM_MODE=dual|twenty) — samme betydning som Pipedrive-tællerne
    twentyCalls: 0,
    twentySkipped: 0,
    twentyErrors: 0,
    twentyCacheHits: 0,
    twentyLookups: 0,
    twentyDeferred: 0,
    stopTwenty: false,
    authFailures: new Set(),
  };
}

function current() {
  return als.getStore() || createStats(null);
}

function summaryLine(s) {
  return '[Kørsel ' + s.name + '] Pipedrive-kald: ' + s.pipedriveCalls
    + ' · Cache: ingen match: ' + s.cacheHits
    + ' · udskudt: ' + s.deferred
    + ' · holdt tilbage (pause): ' + s.pipedriveSkipped
    + ' · fejl: Pipedrive ' + s.pipedriveErrors + ', Relatel ' + s.relatelErrors
    + twentySummary(s);
}

// Twenty-delen tages kun med, når kørslen faktisk rørte Twenty, så loglinjen
// er uændret ved CRM_MODE=pipedrive
function twentySummary(s) {
  const touched = s.twentyCalls + s.twentySkipped + s.twentyErrors + s.twentyCacheHits + s.twentyDeferred;
  if (!touched) return '';
  return ' · Twenty-kald: ' + s.twentyCalls
    + ' · Twenty cache: ingen match: ' + s.twentyCacheHits
    + ' · Twenty udskudt: ' + s.twentyDeferred
    + ' · Twenty holdt tilbage: ' + s.twentySkipped
    + ' · Twenty fejl: ' + s.twentyErrors;
}

async function run(name, fn, { onEnd, log = console } = {}) {
  const stats = createStats(name);
  return als.run(stats, async () => {
    try {
      return await fn();
    } finally {
      log.log(summaryLine(stats));
      if (onEnd) {
        try { await onEnd(stats); } catch (e) { log.error('[Kørsel ' + name + '] Afslutning fejlede: ' + e.message); }
      }
    }
  });
}

module.exports = { run, current, createStats, summaryLine };
