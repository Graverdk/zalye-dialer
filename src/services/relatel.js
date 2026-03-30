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
// Initier udgående opkald (click-to-call)
// Relatel ringer først til medarbejderens telefon, derefter til kunden.
// restrict_to: '' (alle), 'web_call', 'mobile'
// ============================================================
async function initiateCall({ toNumber, restrictTo = '', cloakReceptionId = null }) {
  // Normaliser nummeret - Relatel vil have det uden +/00
  const normalized = toNumber.replace(/^(\+|00)/, '');

  const body = { to_number: normalized };
  if (restrictTo) body.restrict_to = restrictTo;
  if (cloakReceptionId) body.cloak_reception_id = cloakReceptionId;

  return request('POST', '/switch/dial', body);
}

// ============================================================
// Hent opkald med filtrering
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
// Hent enkelt opkald
// ============================================================
async function getCall(uuid) {
  const data = await request('GET', `/calls/${uuid}`);
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
// ============================================================
function normalizeCall(rc) {
  // Find ekstern part (den der ikke er medarbejder)
  const externalNumber = rc.direction === 'outgoing'
    ? rc.to_number
    : rc.from_number;

  const employeeNumber = rc.direction === 'outgoing'
    ? rc.from_number
    : rc.to_number;

  const durationSec = rc.duration || (
    rc.started_at && rc.ended_at
      ? Math.round((new Date(rc.ended_at) - new Date(rc.started_at)) / 1000)
      : null
  );

  const recordingUrl = rc.recording && !rc.recording.expired
    ? rc.recording.sound?.url
    : null;

  return {
    relatel_uuid:    rc.uuid,
    direction:       rc.direction,
    phone_number:    externalNumber || '',
    employee_number: employeeNumber || '',
    started_at:      rc.started_at || null,
    ended_at:        rc.ended_at || null,
    duration_sec:    durationSec,
    recording_url:   recordingUrl,
    pipedrive_person_id: null,
    pipedrive_deal_id:   null,
  };
}

module.exports = { initiateCall, getCalls, getCall, downloadRecording, getEmployees, normalizeCall };
