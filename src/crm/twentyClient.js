// ============================================================
// Tynd REST-klient mod Twenty (https://crm.zalye.si/rest/...).
// - Alle kald går gennem Twenty-vagten (pause ved 401/429, loft pr. kørsel
//   via TWENTY_MAX_CALLS_PER_RUN, timeout).
// - Nøglen sendes som Bearer-header og logges aldrig.
// - Kaster ALDRIG ved HTTP-fejl: svaret er { ok, status, data }. Netværks-
//   fejl giver { ok:false, status:0 }. Kalderen afgør, hvad en fejl betyder.
// ============================================================
const config = require('../config');
const { createGuard } = require('./guard');

const guard = createGuard({
  name: 'twenty',
  label: 'Twenty',
  maxCallsPerRun: config.twenty.maxCallsPerRun,
  timeoutMs: config.twenty.timeoutMs,
});

function enabled() {
  return !!(config.twenty.apiKey && config.twenty.apiUrl);
}

function headers(json) {
  const h = { Authorization: `Bearer ${config.twenty.apiKey}`, Accept: 'application/json' };
  if (json) h['Content-Type'] = 'application/json';
  return h;
}

// Twenty pakker svaret i { data: { <navn>: … } } — tag den første værdi
function unwrap(json) {
  const d = json && json.data;
  if (!d || typeof d !== 'object') return null;
  if (Array.isArray(d)) return d;
  const vals = Object.values(d);
  return vals.length ? vals[0] : null;
}

async function request(method, path, body) {
  const url = `${config.twenty.apiUrl}/rest${path}`;
  const opts = { method, headers: headers(body !== undefined) };
  if (body !== undefined) opts.body = JSON.stringify(body);
  let res;
  try {
    res = await guard.fetch(url, opts);
  } catch (e) {
    console.error(`[Twenty] Netværksfejl på ${method} ${path.split('?')[0]}: ${e.message}`);
    return { ok: false, status: 0, data: null, json: null };
  }
  const json = await res.json().catch(() => null);
  if (!res.ok && res.status !== 503) {
    const msg = json && (json.messages || json.message || json.error);
    console.error(`[Twenty] ${method} ${path.split('?')[0]} svarede ${res.status}: ${JSON.stringify(msg || json).slice(0, 300)}`);
  }
  return { ok: res.ok, status: res.status, data: res.ok ? unwrap(json) : null, json };
}

const get = (path) => request('GET', path);
const post = (path, body) => request('POST', path, body);
const patch = (path, body) => request('PATCH', path, body);

// Filter-værdi i Twentys REST-syntaks: tekst i "", enum uden
function q(v) {
  return '"' + String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

function isPaused() {
  return guard.isPaused() || guard.isStopped();
}

module.exports = { request, get, post, patch, q, enabled, isPaused, guard, unwrap };
