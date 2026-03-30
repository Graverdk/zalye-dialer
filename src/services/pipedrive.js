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

  const directionDa = direction === 'outgoing' ? 'Udgående opkald' : 'Indgående opkald';
  const dato = new Date(startedAt).toLocaleDateString('da-DK', {
    day: '2-digit', month: 'long', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });

  const durationText = durationSec
    ? `${Math.floor(durationSec / 60)}:${String(durationSec % 60).padStart(2, '0')} min`
    : 'Ukendt varighed';

  // Byg note-indhold i HTML (Pipedrive understøtter HTML i noter)
  const actionPointsHtml = actionPoints && actionPoints.length > 0
    ? `<ul>${actionPoints.map(ap => `<li>${ap}</li>`).join('')}</ul>`
    : '<p><em>Ingen handlingspunkter registreret</em></p>';

  const topicsText = topics && topics.length > 0 ? topics.join(', ') : '';

  const content = `
<h3>📞 ${directionDa} — ${phoneNumber}</h3>
<p><strong>Dato:</strong> ${dato} &nbsp;|&nbsp; <strong>Varighed:</strong> ${durationText}${topicsText ? ` &nbsp;|&nbsp; <strong>Emner:</strong> ${topicsText}` : ''}</p>

<h4>Resumé</h4>
<p>${summary || '<em>Resumé ikke tilgængeligt</em>'}</p>

<h4>Handlingspunkter</h4>
${actionPointsHtml}

${transcription ? `<details><summary><strong>Vis fuld transskription</strong></summary><p style="font-size:0.9em;color:#555;">${transcription.replace(/\n/g, '<br>')}</p></details>` : ''}

<p style="font-size:0.8em;color:#888;">Automatisk genereret af Zalye Dialer</p>
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

module.exports = { findPersonByPhone, getPersonWithDeals, createCallNote, createCallActivity };
