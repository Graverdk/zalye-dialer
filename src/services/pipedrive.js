const fetch = require('node-fetch');
const config = require('../config');

const BASE = config.pipedrive.baseUrl;
const TOKEN = config.pipedrive.apiToken;

async function findPersonByPhone(rawPhone) {
  if (!rawPhone) return null;
  const digits = rawPhone.replace(/\D/g, '');
  if (digits.length < 8) return null;
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

async function getPersonById(personId) {
  const url = `${BASE}/persons/${personId}?api_token=${TOKEN}`;
  const res = await fetch(url);
  const data = await res.json();
  return data?.data || null;
}

async function getPersonWithDeals(personId) {
  const url = `${BASE}/persons/${personId}/deals?api_token=${TOKEN}&status=open&limit=1`;
  const res = await fetch(url);
  const data = await res.json();
  const deals = data?.data || [];
  return { latestDealId: deals[0]?.id || null };
}

function buildCallNoteContent({ direction, phoneNumber, startedAt, durationSec, summary, actionPoints, topics, transcription, diarizedTranscription }) {
  const dirLabel = direction === 'outgoing' ? 'Udgaaende' : 'Indgaaende';
  const date = startedAt
    ? new Date(startedAt).toLocaleString('da-DK', { timeZone: 'Europe/Copenhagen' })
    : '\u2014';
  const min = Math.floor((durationSec || 0) / 60);
  const sec = (durationSec || 0) % 60;
  const durStr = `${min}m ${sec}s`;

  let content = `## Opkald \u2014 ${dirLabel}\n`;
  content += `**Tidspunkt:** ${date}\n`;
  content += `**Nummer:** ${phoneNumber || '\u2014'}\n`;
  content += `**Varighed:** ${durStr}\n\n`;

  if (summary) content += `### Resum\u00e9\n${summary}\n\n`;
  if (actionPoints && actionPoints.length > 0) {
    content += `### Handlingspunkter\n${actionPoints.map(a => `- ${a}`).join('\n')}\n\n`;
  }
  if (topics && topics.length > 0) {
    content += `### Emner\n${topics.map(t => `- ${t}`).join('\n')}\n\n`;
  }
  if (diarizedTranscription && diarizedTranscription.trim().length > 0) {
    content += `### Transskription\n${diarizedTranscription}\n`;
  } else if (transcription && transcription.trim().length > 0) {
    content += `### Transskription\n${transcription}\n`;
  }
  return content;
}

async function createCallNote({ dealId, personId, callData }) {
  const content = buildCallNoteContent(callData);
  const body = { content, pinned_to_deal_flag: !!dealId };
  if (dealId) body.deal_id = dealId;
  if (personId) body.person_id = personId;

  const res = await fetch(`${BASE}/notes?api_token=${TOKEN}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  return data?.data?.id || null;
}

async function updateNote(noteId, { callData }) {
  const content = buildCallNoteContent(callData);
  const res = await fetch(`${BASE}/notes/${noteId}?api_token=${TOKEN}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });
  const data = await res.json();
  return data?.data?.id || null;
}

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
  if (dealId) body.deal_id = dealId;
  if (personId) body.person_id = personId;

  const res = await fetch(`${BASE}/activities?api_token=${TOKEN}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  return data?.data?.id || null;
}

async function createSmsNote({ personId, dealId, smsData }) {
  const { direction, phoneNumber, body: msgBody, sentAt } = smsData;
  const dirLabel = direction === 'outgoing' ? 'Sendt' : 'Modtaget';
  const date = sentAt
    ? new Date(sentAt).toLocaleString('da-DK', { timeZone: 'Europe/Copenhagen' })
    : '\u2014';

  let content = `## SMS \u2014 ${dirLabel}\n`;
  content += `**Tidspunkt:** ${date}\n`;
  content += `**Nummer:** ${phoneNumber || '\u2014'}\n\n`;
  content += msgBody || '(tom besked)';

  const noteBody = { content };
  if (dealId) noteBody.deal_id = dealId;
  if (personId) noteBody.person_id = personId;

  const res = await fetch(`${BASE}/notes?api_token=${TOKEN}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(noteBody),
  });
  const data = await res.json();
  return data?.data?.id || null;
}

async function createRelatelNote({ personId, dealId, noteData }) {
  const { author, body: noteBody, createdAt } = noteData;
  const date = createdAt
    ? new Date(createdAt).toLocaleString('da-DK', { timeZone: 'Europe/Copenhagen' })
    : '\u2014';

  let content = `## Note\n`;
  content += `**Dato:** ${date}\n`;
  if (author) content += `**Skrevet af:** ${author}\n`;
  content += `\n${noteBody || '(tom note)'}`;

  const body = { content };
  if (dealId) body.deal_id = dealId;
  if (personId) body.person_id = personId;

  const res = await fetch(`${BASE}/notes?api_token=${TOKEN}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  return data?.data?.id || null;
}

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
  getPersonById,
  getPersonWithDeals,
  createCallNote,
  updateNote,
  createCallActivity,
  createSmsNote,
  createRelatelNote,
  createPerson,
};
