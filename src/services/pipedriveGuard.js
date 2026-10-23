// ============================================================
// Vagt foran alle Pipedrive-kald (pipedrive.js og autofill.js).
// - 401 (nøglen afvist) og 429 (over loftet) giver pause for ALLE
//   Pipedrive-kald: 2, 4, 8 og derefter 15 min. Ved 429 respekteres
//   Retry-After, hvis Pipedrive sender den.
// - Ved 401 rører resten af kørslen ikke Pipedrive (ingen løkke).
// - Et OK-svar ophæver pausen.
// Loftet deles med lead-hubben og Claudes Pipedrive-forbindelse, så vi
// skal hellere vente for længe end hamre løs.
// ============================================================
const nodeFetch = require('node-fetch');
const runStats = require('./runStats');
const alerts = require('./alerts');

const BASE_PAUSE_MS = 2 * 60 * 1000;
const MAX_PAUSE_MS = 15 * 60 * 1000;

const state = { failures: 0, pausedUntil: 0, lastStatus: null };

function pauseFor(failures) {
  return Math.min(BASE_PAUSE_MS * 2 ** Math.max(0, failures - 1), MAX_PAUSE_MS);
}

function isPaused(now = Date.now()) {
  return now < state.pausedUntil;
}

function heldBackResponse(reason) {
  return new nodeFetch.Response(JSON.stringify({ success: false, error: reason }), {
    status: 503,
    statusText: 'Holdt tilbage',
    headers: { 'Content-Type': 'application/json' },
  });
}

async function guardedFetch(url, opts) {
  const stats = runStats.current();
  if (stats.stopPipedrive || isPaused()) {
    stats.pipedriveSkipped++;
    return heldBackResponse(stats.stopPipedrive
      ? 'Pipedrive afviste nøglen (401) tidligere i kørslen'
      : 'Pipedrive-kald holder pause efter ' + state.lastStatus);
  }

  stats.pipedriveCalls++;
  let res;
  try {
    res = await nodeFetch(url, opts);
  } catch (e) {
    stats.pipedriveErrors++;
    throw e;
  }

  if (res.status === 401 || res.status === 429) {
    state.failures++;
    let wait = pauseFor(state.failures);
    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get('retry-after'), 10);
      if (retryAfter > 0) wait = Math.min(Math.max(wait, retryAfter * 1000), MAX_PAUSE_MS);
    }
    state.pausedUntil = Date.now() + wait;
    state.lastStatus = res.status;
    stats.pipedriveErrors++;
    if (res.status === 401) {
      stats.stopPipedrive = true;
      alerts.noteAuthFailure('pipedrive');
    }
    console.warn('[Pipedrive] ' + (res.status === 401 ? '401: nøglen er afvist' : '429: over loftet')
      + ' — alle Pipedrive-kald holder pause i ' + Math.round(wait / 60000) + ' min (fejl nr. ' + state.failures + ' i træk)');
  } else if (res.ok) {
    if (state.failures) console.log('[Pipedrive] Svarer igen — pausen er ophævet');
    state.failures = 0;
    state.pausedUntil = 0;
    state.lastStatus = null;
    alerts.noteSuccess('pipedrive');
  } else {
    stats.pipedriveErrors++;
  }
  return res;
}

function _reset() {
  state.failures = 0;
  state.pausedUntil = 0;
  state.lastStatus = null;
}

module.exports = { fetch: guardedFetch, isPaused, pauseFor, BASE_PAUSE_MS, MAX_PAUSE_MS, _state: state, _reset };
