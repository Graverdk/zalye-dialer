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
    throw new Error(`Relatel API fejl ${res.status} paa ${path}: ${JSON.stringify(json)}`);
  }
  return json;
}

// ============================================================
// Initier udgaaende opkald (click-to-call bridge)
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
// ============================================================
async function getCalls({ direction, endedAfter, endedBefore, startedAfter, limit = 50, endpoint } = {}) {
  const params = new URLSearchParams();
  if (direction) params.set('direction', direction);
  if (endedAfter) params.set('ended_at_gt_or_eq', endedAfter);
  if (endedBefore) params.set('ended_at_lt_or_eq', endedBefore);
  if (startedAfter) params.set('started_at_gt_or_eq', startedAfter);
  if (limit) params.set('limit', limit);
  if (endpoint) params.set('endpoint', endpoint);
  const query = params.toString() ? `?${params}` : '';
  const data = await request('GET', `/calls${query}`);
  return data.calls || [];
}

async function getCall(callUuid) {
  const data = await request('POST', '/calls', { uuid: callUuid });
  return data.call;
}

async function downloadRecording(url) {
  const res = await fetch(url, {
    headers: { 'Authorization': `Bearer ${config.relatel.accessToken}` },
  });
  if (!res.ok) throw new Error(`Kunne ikke downloade optagelse: HTTP ${res.status}`);
  const buffer = await res.buffer();
  return { buffer, contentType: res.headers.get('content-type') || 'audio/mpeg' };
}

async function getEmployees() {
  const data = await request('GET', '/employees');
  return data.employees || [];
}

// ============================================================
// Normaliser Relatel Call-objekt til internt format
// ============================================================
function normalizeCall(rc) {
  const externalNumber = rc.remote_number || (
    rc.direction === 'outgoing' ? rc.to_number : rc.from_number
  );
  const employeeNumber = rc.direction === 'outgoing' ? rc.from_number : rc.to_number;

  const durationSec = rc.talk_duration != null
    ? rc.talk_duration
    : (
      rc.answered_at && rc.ended_at
        ? Math.round((new Date(rc.ended_at) - new Date(rc.answered_at)) / 1000)
        : null
    );

  const recordingUrl = rc.recording && !rc.recording.expired
    ? (rc.recording.url || rc.recording.sound?.url || null)
    : null;

  return {
    relatel_uuid: rc.call_uuid,
    direction: rc.direction,
    phone_number: (externalNumber || '').replace(/^(\+|00)/, ''),
    employee_number: employeeNumber || '',
    started_at: rc.started_at || null,
    answered_at: rc.answered_at || null,
    ended_at: rc.ended_at || null,
    duration_sec: durationSec,
    recording_url: recordingUrl,
    pipedrive_person_id: null,
    pipedrive_deal_id: null,
  };
}

// ============================================================
// SMS-beskeder
// ============================================================
async function getMessages({ after, before, limit = 50 } = {}) {
  const params = new URLSearchParams();
  if (after) params.set('created_at_gt_or_eq', after);
  if (before) params.set('created_at_lt_or_eq', before);
  if (limit) params.set('limit', limit);
  const query = params.toString() ? `?${params}` : '';
  const data = await request('GET', `/messages${query}`);
  return data.messages || data || [];
}

// ============================================================
// Kontakter fra Relatel
// ============================================================
async function getContacts({ limit = 100 } = {}) {
  const params = new URLSearchParams();
  if (limit) params.set('limit', limit);
  const query = params.toString() ? `?${params}` : '';
  const data = await request('GET', `/contacts${query}`);
  return data.contacts || data || [];
}

async function getContactComments(contactId) {
  const data = await request('GET', `/contacts/${contactId}/comments`);
  return data.comments || data || [];
}

// ============================================================
// Opdater kontakt i Relatel
// ============================================================
async function updateContact(contactId, { name, email } = {}) {
  const contact = {};
  if (name) contact.name = name;
  if (email) contact.email = email;
  return request('PUT', '/contacts/' + contactId, { contact });
}

// ============================================================
// Chats (SMS-traade)
// ============================================================
async function getChats({ after, limit = 50 } = {}) {
  const params = new URLSearchParams();
  if (after) params.set('updated_at_gt_or_eq', after);
  if (limit) params.set('limit', limit);
  const query = params.toString() ? `?${params}` : '';
  const data = await request('GET', `/chats${query}`);
  return data.chats || data || [];
}

async function getChat(uuid) {
  const data = await request('GET', `/chats/${uuid}`);
  return data.chat || data;
}

// ============================================================
// Normaliser SMS til internt format
// ============================================================
function normalizeMessage(msg) {
  return {
    relatel_id: msg.id || msg.uuid || null,
    direction: msg.direction || (msg.from_number ? 'incoming' : 'outgoing'),
    phone_number: (msg.remote_number || msg.to_number || msg.from_number || '').replace(/^(\+|00)/, ''),
    body: msg.body || msg.text || msg.content || '',
    sent_at: msg.created_at || msg.sent_at || null,
    employee_number: msg.employee_number || null,
  };
}

module.exports = {
  initiateCall,
  getCalls,
  getCall,
  downloadRecording,
  getEmployees,
  normalizeCall,
  getMessages,
  getContacts,
  getContactComments,
  updateContact,
  getChats,
  getChat,
  normalizeMessage,
};
