const fetch = require('node-fetch');
const config = require('../config');

const BASE = config.relatel.baseUrl;

function headers() {
  return {
    'Authorization': `Bearer ${config.relatel.accessToken}`,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };
}

async function request(method, path, body = null) {
  const opts = { method, headers: headers() };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${BASE}${path}`, opts);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Relatel API fejl ${res.status} på ${path}: ${JSON.stringify(json)}`);
  }
  return json;
}

// ============================================================
// Initier udgående opkald (click-to-call bridge)
// Relatel ringer til medarbejderens telefon, derefter til kunden.
// restrict_to: '' (alle), 'web_call', 'mobile'
// ============================================================
async function initiateCall({ toNumber, restrictTo = '', cloakReceptionId = null }) {
  const normalized = toNumber.replace(/^(\+|00)/, '');
  const body = { to_number: normalized };
  if (restrictTo) body.restrict_to = restrictTo;
  if (cloakReceptionId) body.cloak_reception_id = cloakReceptionId;
  return request('POST', '/switch/dial', body);
}

// ============================================================
// Hent afsluttede opkald med filtrering
// Relatel API v2 bruger 'call_uuid' som unik nøgle (ikke 'uuid')
// ============================================================
async function getCalls({ direction, endedAfter, endedBefore, startedAfter, limit = 50, endpoint } = {}) {
  const params = new URLSearchParams();
  if (direction)    params.set('direction', direction);
  if (endedAfter)   params.set('ended_at_gt_or_eq', endedAfter);
  if (endedBefore)  params.set('ended_at_lt_or_eq', endedBefore);
  if (startedAfter) params.set('started_at_gt_or_eq', startedAfter);
  if (limit)        params.set('limit', limit);
  if (endpoint)     params.set('endpoint', endpoint);
  const query = params.toString() ? `?${params}` : '';
  const data = await request('GET', `/calls${query}`);
  return data.calls || [];
}

// ============================================================
// Hent enkelt opkald via call_uuid (POST /calls med uuid i body)
// ============================================================
async function getCall(callUuid) {
  const data = await request('POST', '/calls', { uuid: callUuid });
  return data.call;
}

// ============================================================
// Download optagelsesfil som Buffer
// ============================================================
async function downloadRecording(url) {
  const res = await fetch(url, {
    headers: { 'Authorization': `Bearer ${config.relatel.accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`Kunne ikke downloade optagelse: HTTP ${res.status}`);
  }
  const buffer = await res.buffer();
  return { buffer, contentType: res.headers.get('content-type') || 'audio/mpeg' };
}

// ============================================================
// Hent liste over medarbejdere
// ============================================================
async function getEmployees() {
  const data = await request('GET', '/employees');
  return data.employees || [];
}

// ============================================================
// Normaliser et Relatel Call-objekt til vores interne format
// VIGTIGT: Relatel API v2 bruger 'call_uuid' (ikke 'uuid')
// og 'talk_duration' (ikke 'duration')
// ============================================================
function normalizeCall(rc) {
  // Ekstern part: ved udgående = to_number, ved indgående = from_number
  // remote_number er altid den eksterne part
  const externalNumber = rc.remote_number || (
    rc.direction === 'outgoing' ? rc.to_number : rc.from_number
  );
  const employeeNumber = rc.direction === 'outgoing' ? rc.from_number : rc.to_number;

  // Varighed: brug talk_duration (sekunder) fra Relatel v2
  const durationSec = rc.talk_duration != null ? rc.talk_duration : (
    rc.answered_at && rc.ended_at
      ? Math.round((new Date(rc.ended_at) - new Date(rc.answered_at)) / 1000)
      : null
  );

  // Optagelse: tjek recording felt
  const recordingUrl = rc.recording && !rc.recording.expired
    ? (rc.recording.url || rc.recording.sound?.url || null)
    : null;

  return {
    relatel_uuid: rc.call_uuid,   // RETTET: var rc.uuid - hedder call_uuid i Relatel v2
    direction:    rc.direction,
    phone_number: (externalNumber || '').replace(/^(\+|00)/, ''),
    employee_number: employeeNumber || '',
    started_at:  rc.started_at  || null,
    answered_at: rc.answered_at || null,
    ended_at:    rc.ended_at    || null,
    duration_sec: durationSec,
    recording_url: recordingUrl,
    pipedrive_person_id: null,
    pipedrive_deal_id:   null,
  };
}

module.exports = { initiateCall, getCalls, getCall, downloadRecording, getEmployees, normalizeCall };
