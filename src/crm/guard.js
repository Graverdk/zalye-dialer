// ============================================================
// Vagt foran alle kald til ét CRM (én vagt pr. system: pipedrive, twenty).
// - 401 (nøglen afvist) og 429 (over loftet) giver pause for ALLE kald
//   til det system: 2, 4, 8 og derefter 15 min. Ved 429 respekteres
//   Retry-After, hvis systemet sender den.
// - Ved 401 rører resten af kørslen ikke systemet (ingen løkke).
// - Et OK-svar ophæver pausen.
// - Valgfrit loft pr. kørsel (maxCallsPerRun): når det er nået, holdes
//   resten af kørslens kald tilbage (TWENTY_MAX_CALLS_PER_RUN).
// Pausen i ét system påvirker aldrig det andet.
//
// Tællerne i runStats hedder <navn>Calls, <navn>Skipped, <navn>Errors og
// stop<Navn> (fx pipedriveCalls, stopPipedrive, twentyCalls, stopTwenty).
// ============================================================
const nodeFetch = require('node-fetch');
const runStats = require('../services/runStats');
const alerts = require('../services/alerts');

const BASE_PAUSE_MS = 2 * 60 * 1000;
const MAX_PAUSE_MS = 15 * 60 * 1000;

function pauseFor(failures) {
  return Math.min(BASE_PAUSE_MS * 2 ** Math.max(0, failures - 1), MAX_PAUSE_MS);
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function createGuard({ name, label = cap(name), maxCallsPerRun = 0, timeoutMs = 0 }) {
  const state = { failures: 0, pausedUntil: 0, lastStatus: null };
  const k = {
    calls: name + 'Calls',
    skipped: name + 'Skipped',
    errors: name + 'Errors',
    stop: 'stop' + cap(name),
  };
  let fetchImpl = null; // til tests

  function isPaused(now = Date.now()) {
    return now < state.pausedUntil;
  }

  // Kørslen må ikke røre systemet: 401 tidligere i kørslen eller loftet er nået
  function isStopped(stats = runStats.current()) {
    return !!stats[k.stop] || (maxCallsPerRun > 0 && (stats[k.calls] || 0) >= maxCallsPerRun);
  }

  function heldBackResponse(reason) {
    return new nodeFetch.Response(JSON.stringify({ success: false, error: reason }), {
      status: 503,
      statusText: 'Holdt tilbage',
      headers: { 'Content-Type': 'application/json' },
    });
  }

  async function guardedFetch(url, opts = {}) {
    const stats = runStats.current();
    if (stats[k.stop] || isPaused() || isStopped(stats)) {
      stats[k.skipped] = (stats[k.skipped] || 0) + 1;
      let reason;
      if (stats[k.stop]) reason = label + ' afviste nøglen (401) tidligere i kørslen';
      else if (isPaused()) reason = label + '-kald holder pause efter ' + state.lastStatus;
      else reason = label + '-loftet på ' + maxCallsPerRun + ' kald pr. kørsel er nået';
      return heldBackResponse(reason);
    }

    stats[k.calls] = (stats[k.calls] || 0) + 1;
    let res;
    try {
      const o = timeoutMs && !opts.timeout ? { ...opts, timeout: timeoutMs } : opts;
      res = await (fetchImpl || nodeFetch)(url, o);
    } catch (e) {
      stats[k.errors] = (stats[k.errors] || 0) + 1;
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
      stats[k.errors] = (stats[k.errors] || 0) + 1;
      if (res.status === 401) {
        stats[k.stop] = true;
        alerts.noteAuthFailure(name);
      }
      console.warn('[' + label + '] ' + (res.status === 401 ? '401: nøglen er afvist' : '429: over loftet')
        + ' — alle ' + label + '-kald holder pause i ' + Math.round(wait / 60000) + ' min (fejl nr. ' + state.failures + ' i træk)');
    } else if (res.ok) {
      if (state.failures) console.log('[' + label + '] Svarer igen — pausen er ophævet');
      state.failures = 0;
      state.pausedUntil = 0;
      state.lastStatus = null;
      alerts.noteSuccess(name);
    } else {
      stats[k.errors] = (stats[k.errors] || 0) + 1;
    }
    return res;
  }

  function _reset() {
    state.failures = 0;
    state.pausedUntil = 0;
    state.lastStatus = null;
  }

  return {
    name,
    label,
    fetch: guardedFetch,
    isPaused,
    isStopped,
    pauseFor,
    BASE_PAUSE_MS,
    MAX_PAUSE_MS,
    _state: state,
    _reset,
    _setFetch(fn) { fetchImpl = fn; },
    _setMaxCallsPerRun(n) { maxCallsPerRun = n; },
  };
}

module.exports = { createGuard, pauseFor, BASE_PAUSE_MS, MAX_PAUSE_MS };
