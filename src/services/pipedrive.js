const fetch = require('node-fetch');
const config = require('../config');

const BASE = config.pipedrive.baseUrl;
const TOKEN = config.pipedrive.apiToken;

async function request(method, path, body = null) {
  const separator = path.includes('?') ? '&' : '?';
  const url = `${BASE}${path}${separator}api_token=${TOKEN}`;

  const opts = {
    method,
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
  };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(url, opts);
  const json = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error(`Pipedrive API fejl ${res.status} på ${path}: ${JSON.stringify(json)}`);
  }
  return json.data || json;
}

// ============================================================
// Find person i Pipedrive ud fra telefonnummer
// ============================================================
async function findPersonByPhone(phoneNumber) {
  const normalized = phoneNumber.replace(/^(\+|00)/, '');
  try {
    const data = await request('GET', `/persons/search?term=${encodeURIComponent(normalized)}&fields=phone&limit=1`);
    const items = data?.items || [];
    return items.length > 0 ? items[0].item : null;
  } catch {
    return null;
  }
}

// ============================================================
// Hent person med tilhørende deals
// ============================================================
async function getPersonWithDeals(personId) {
  try {
    const [person, dealsData] = await Promise.all([
      request('GET', `/persons/${personId}`),
      request('GET', `/persons/${personId}/deals?limit=1&status=open`),
    ]);
    const deals = Array.isArray(dealsData) ? dealsData : [];
    return { person, latestDealId: deals.length > 0 ? deals[0].id : null };
  } catch {
    return null;
  }
}

// ============================================================
// Opret note på deal eller person med opkaldsresumé
// ============================================================
async function createCallNote({ dealId, personId, callData }) {
  const { direction, phoneNumber, startedAt, durationSec, summary, actionPoints, topics, transcription } = callData;

  const dirLabel = direction === 'outgoing' ? 'Udgående opkald' : 'Indgående opkald';
  const durationText = durationSec
    ? `${Math.floor(durationSec / 60)}:${String(durationSec % 60).padStart(2, '0')} min`
    : '';

  const actionPointsHtml = actionPoints && actionPoints.length > 0
    ? `<ul>${actionPoints.map(ap => `<li>${ap}</li>`).join('')}</ul>`
    : '';

  const topicsText = topics && topics.length > 0 ? topics.join(', ') : '';

  const content = `
<h3>Opkald — ${dirLabel}</h3>
<p>${phoneNumber}${durationText ? ` · ${durationText}` : ''}${topicsText ? ` · ${topicsText}` : ''}</p>

${summary ? `<p><strong>Resumé:</strong> ${summary}</p>` : ''}

${actionPointsHtml ? `<p><strong>Handlingspunkter:</strong></p>${actionPointsHtml}` : ''}

${transcription ? `<details><summary>Vis transskription</summary><p style="font-size:0.9em;color:#555;">${transcription.replace(/\n/g, '<br>')}</p></details>` : ''}
`.trim();

  const body = { content };
  if (dealId) body.deal_id = dealId;
  if (personId) body.person_id = personId;

  const note = await request('POST', '/notes', body);
  return note.id;
}

// ============================================================
// Opret aktivitet (Call) på deal eller person
// ============================================================
async function createCallActivity({ dealId, personId, subject, durationSec, doneAt }) {
  const body = {
    subject: subject || 'Opkald via Zalye Dialer',
    type: 'call',
    done: 1,
    due_date: doneAt ? doneAt.substring(0, 10) : new Date().toISOString().substring(0, 10),
    duration: durationSec ? `${String(Math.floor(durationSec / 3600)).padStart(2, '0')}:${String(Math.floor((durationSec % 3600) / 60)).padStart(2, '0')}:${String(durationSec % 60).padStart(2, '0')}` : '00:00:00',
  };
  if (dealId)   body.deal_id = dealId;
  if (personId) body.person_id = personId;

  return request('POST', '/activities', body);
}

// ============================================================
// Opret SMS-note i Pipedrive
// ============================================================
async function createSmsNote({ dealId, personId, smsData }) {
  const { direction, phoneNumber, body, sentAt } = smsData;
  const dirLabel = direction === 'outgoing' ? 'Sendt SMS' : 'Modtaget SMS';

  const content = `
<h3>SMS — ${dirLabel}</h3>
<p>${(body || '').replace(/\n/g, '<br>')}</p>
<p style="font-size:0.85em;color:#666;">${phoneNumber}</p>
`.trim();

  const noteBody = { content };
  if (dealId) noteBody.deal_id = dealId;
  if (personId) noteBody.person_id = personId;

  const note = await request('POST', '/notes', noteBody);
  return note.id;
}

// ============================================================
// Opret Relatel-note i Pipedrive
// ============================================================
async function createRelatelNote({ dealId, personId, noteData }) {
  const { author, body } = noteData;

  const content = `
<h3>Note</h3>
<p>${(body || '').replace(/\n/g, '<br>')}</p>
${author ? `<p style="font-size:0.85em;color:#666;">— ${author}</p>` : ''}
`.trim();

  const noteBody = { content };
  if (dealId) noteBody.deal_id = dealId;
  if (personId) noteBody.person_id = personId;

  const note = await request('POST', '/notes', noteBody);
  return note.id;
}

// ============================================================
// Opret person i Pipedrive med navn, virksomhed og nummer
// ============================================================
async function createPerson({ name, phone, orgName }) {
  const body = {
    name: name || phone || 'Ukendt',
    phone: [{ value: phone, primary: true }],
  };

  // Opret organisation først, hvis vi har et navn
  if (orgName) {
    try {
      const org = await request('POST', '/organizations', { name: orgName });
      if (org && org.id) body.org_id = org.id;
    } catch (err) {
      console.error('[Pipedrive] Kunne ikke oprette organisation:', err.message);
    }
  }

  return request('POST', '/persons', body);
}

module.exports = {
  findPersonByPhone, getPersonWithDeals,
  createCallNote, createCallActivity,
  createSmsNote, createRelatelNote, createPerson,
};
