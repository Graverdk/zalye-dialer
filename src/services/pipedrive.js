const fetch = require('node-fetch');
const config = require('../config');

const BASE = config.pipedrive.baseUrl;
const TOKEN = config.pipedrive.apiToken;

// ============================================================
// Find Pipedrive-person baseret på telefonnummer
// Søger på de SIDSTE 8 cifre — matcher alle formater:
// 41291042, +4541291042, 4541291042, 0045 41291042 osv.
// ============================================================
async function findPersonByPhone(rawPhone) {
  if (!rawPhone) return null;

  // Fjern alt undtagen cifre
  const digits = rawPhone.replace(/\D/g, '');
  if (digits.length < 8) return null;

  // Søg på de sidste 8 cifre (det lokale nummer uden landekode)
  // Pipedrive's søgning finder nummeret uanset om det er gemt med eller uden +45
  const localNumber = digits.slice(-8);

  const url = `${BASE}/persons/search?term=${encodeURIComponent(localNumber)}&fields=phone&api_token=${TOKEN}`;
  const res = await fetch(url);
  const data = await res.json();
  const items = data?.data?.items || [];

  if (items.length > 0) {
    console.log(`[Pipedrive] Fandt kontakt for ${localNumber} (fra ${digits})`);
    return items[0].item;
  }

  console.log(`[Pipedrive] Ingen kontakt fundet for ${localNumber} (fra ${digits})`);
  return null;
}

// ============================================================
// Hent person + seneste deal
// ============================================================
async function getPersonWithDeals(personId) {
  const url = `${BASE}/persons/${personId}/deals?api_token=${TOKEN}&status=open&limit=1`;
  const res = await fetch(url);
  const data = await res.json();
  const deals = data?.data || [];
  return { latestDealId: deals[0]?.id || null };
}

// ============================================================
// Opret note i Pipedrive for et opkald
// ============================================================
async function createCallNote({ dealId, personId, callData }) {
  const { direction, phoneNumber, startedAt, durationSec, summary, actionPoints, topics, transcription } = callData;

  const dirLabel = direction === 'outgoing' ? 'Udgående' : 'Indgående';
  const date = startedAt ? new Date(startedAt).toLocaleString('da-DK', { timeZone: 'Europe/Copenhagen' }) : '—';
  const min = Math.floor((durationSec || 0) / 60);
  const sec = (durationSec || 0) % 60;
  const durStr = `${min}m ${sec}s`;

  let content = `## Opkald — ${dirLabel}\n`;
  content += `**Tidspunkt:** ${date}\n`;
  content += `**Nummer:** ${phoneNumber || '—'}\n`;
  content += `**Varighed:** ${durStr}\n\n`;

  if (summary) {
    content += `### Resumé\n${summary}\n\n`;
  }
  if (actionPoints && actionPoints.length > 0) {
    content += `### Handlingspunkter\n${actionPoints.map(a => `- ${a}`).join('\n')}\n\n`;
  }
  if (topics && topics.length > 0) {
    content += `### Emner\n${topics.map(t => `- ${t}`).join('\n')}\n\n`;
  }
  if (transcription && transcription.trim().length > 0) {
    content += `### Transskription\n${transcription}\n`;
  }

  const body = { content, pinned_to_deal_flag: !!dealId };
  if (dealId)   body.deal_id   = dealId;
  if (personId) body.person_id = personId;

  const res = await fetch(`${BASE}/notes?api_token=${TOKEN}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  return data?.data?.id || null;
}

// ============================================================
// Opret aktivitet i Pipedrive for et opkald
// ============================================================
async function createCallActivity({ dealId, personId, subject, durationSec, doneAt }) {
  const body = {
    subject,
    type: 'call',
    done: 1,
    due_date: doneAt ? doneAt.split('T')[0] : new Date().toISOString().split('T')[0],
    duration: durationSec
      ? `${String(Math.floor(durationSec / 3600)).padStart(2,'0')}:${String(Math.floor((durationSec % 3600)/60)).padStart(2,'0')}:${String(durationSec % 60).padStart(2,'0')}`
      : '00:00:00',
  };
  if (dealId)   body.deal_id   = dealId;
  if (personId) body.person_id = personId;

  const res = await fetch(`${BASE}/activities?api_token=${TOKEN}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  return data?.data?.id || null;
}

// ============================================================
// Opret note i Pipedrive for en SMS
// ============================================================
async function createSmsNote({ personId, dealId, smsData }) {
  const { direction, phoneNumber, body: msgBody, sentAt } = smsData;
  const dirLabel = direction === 'outgoing' ? 'Sendt' : 'Modtaget';
  const date = sentAt ? new Date(sentAt).toLocaleString('da-DK', { timeZone: 'Europe/Copenhagen' }) : '—';

  let content = `## SMS — ${dirLabel}\n`;
  content += `**Tidspunkt:** ${date}\n`;
  content += `**Nummer:** ${phoneNumber || '—'}\n\n`;
  content += msgBody || '(tom besked)';

  const noteBody = { content };
  if (dealId)   noteBody.deal_id   = dealId;
  if (personId) noteBody.person_id = personId;

  const res = await fetch(`${BASE}/notes?api_token=${TOKEN}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(noteBody),
  });
  const data = await res.json();
  return data?.data?.id || null;
}

// ============================================================
// Opret note i Pipedrive for en Relatel-note/kommentar
// ============================================================
async function createRelatelNote({ personId, dealId, noteData }) {
  const { author, body: noteBody, createdAt } = noteData;
  const date = createdAt ? new Date(createdAt).toLocaleString('da-DK', { timeZone: 'Europe/Copenhagen' }) : '—';

  let content = `## Note\n`;
  content += `**Dato:** ${date}\n`;
  if (author) content += `**Skrevet af:** ${author}\n`;
  content += `\n${noteBody || '(tom note)'}`;

  const body = { content };
  if (dealId)   body.deal_id   = dealId;
  if (personId) body.person_id = personId;

  const res = await fetch(`${BASE}/notes?api_token=${TOKEN}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  return data?.data?.id || null;
}

// ============================================================
// Opret ny person i Pipedrive
// ============================================================
async function createPerson({ name, phone, orgName }) {
  const body = { name, phone: [{ value: phone, primary: true }] };
  if (orgName) body.org_name = orgName;

  const res = await fetch(`${BASE}/persons?api_token=${TOKEN}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  return data?.data || null;
}

module.exports = {
  findPersonByPhone,
  getPersonWithDeals,
  createCallNote,
  createCallActivity,
  createSmsNote,
  createRelatelNote,
  createPerson,
};
