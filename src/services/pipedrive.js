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
  try {
    const res = await fetch(url);
    const data = await res.json();
    if (!res.ok) {
      console.error(`[Pipedrive] Søge-fejl ${res.status} for ${localNumber}: ${JSON.stringify(data)}`);
      return null;
    }
    const items = data?.data?.items || [];
    if (items.length > 0) {
      console.log(`[Pipedrive] Fandt kontakt for ${localNumber} (fra ${digits}) -> personId ${items[0].item.id}`);
      return items[0].item;
    }
    console.log(`[Pipedrive] Ingen kontakt fundet for ${localNumber} (fra ${digits})`);
    return null;
  } catch (e) {
    console.error(`[Pipedrive] Netværksfejl ved søgning på ${localNumber}: ${e.message}`);
    return null;
  }
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

// ============================================================
// Formatering: dato + varighed på dansk
// ============================================================
function formatDate(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('da-DK', {
      timeZone: 'Europe/Copenhagen',
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

function formatDuration(sec) {
  if (!sec || sec < 0) return '0m 0s';
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m ${s}s`;
}

// ============================================================
// Byg note-indhold til OPKALD
// Overskrift gør det krystalklart at det er et opkald
// ============================================================
function buildCallNoteContent({
  direction, phoneNumber, startedAt, durationSec,
  summary, actionPoints, topics, transcription, diarizedTranscription,
}) {
  const dirLabel = direction === 'outgoing' ? 'Udgående' : 'Indgående';
  const date = formatDate(startedAt);
  const durStr = formatDuration(durationSec);

  let content = `## OPKALD — ${dirLabel}\n`;
  content += `**Tidspunkt:** ${date}  ·  **Nummer:** ${phoneNumber || '—'}  ·  **Varighed:** ${durStr}\n\n`;

  if (summary) {
    content += `### Resumé\n${summary}\n\n`;
  }
  if (actionPoints && actionPoints.length > 0) {
    content += `### Handlingspunkter\n${actionPoints.map(a => `- ${a}`).join('\n')}\n\n`;
  }
  if (topics && topics.length > 0) {
    content += `### Emner\n${topics.map(t => `- ${t}`).join('\n')}\n\n`;
  }
  if (diarizedTranscription && diarizedTranscription.trim().length > 0) {
    content += `### Samtale (Sælger / Kunde)\n${diarizedTranscription}\n\n`;
  }
  if (transcription && transcription.trim().length > 0) {
    content += `### Fuld transskription (rå)\n${transcription}\n`;
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
  if (!res.ok) {
    console.error(`[Pipedrive] createCallNote fejl ${res.status}: ${JSON.stringify(data)}`);
    return null;
  }
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
  if (!res.ok) {
    console.error(`[Pipedrive] updateNote fejl ${res.status}: ${JSON.stringify(data)}`);
    return null;
  }
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

// ============================================================
// SMS-note med tydelig overskrift
// ============================================================
async function createSmsNote({ personId, dealId, smsData }) {
  const { direction, phoneNumber, body: msgBody, sentAt } = smsData;
  const dirLabel = direction === 'outgoing' ? 'Sendt' : 'Modtaget';
  const date = formatDate(sentAt);

  let content = `## SMS — ${dirLabel}\n`;
  content += `**Tidspunkt:** ${date}  ·  **Nummer:** ${phoneNumber || '—'}\n\n`;
  content += `### Besked\n${msgBody || '_(tom besked)_'}\n`;

  const noteBody = { content };
  if (dealId) noteBody.deal_id = dealId;
  if (personId) noteBody.person_id = personId;

  const res = await fetch(`${BASE}/notes?api_token=${TOKEN}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(noteBody),
  });
  const data = await res.json();
  if (!res.ok) {
    console.error(`[Pipedrive] createSmsNote fejl ${res.status}: ${JSON.stringify(data)}`);
    return null;
  }
  return data?.data?.id || null;
}

// ============================================================
// Note skrevet i Relatel (kommentar på kontakt) → Pipedrive-note
// ============================================================
async function createRelatelNote({ personId, dealId, noteData }) {
  const { author, body: noteBody, createdAt } = noteData;
  const date = formatDate(createdAt);

  let content = `## NOTE — Skrevet i Relatel\n`;
  content += `**Tidspunkt:** ${date}`;
  if (author) content += `  ·  **Af:** ${author}`;
  content += `\n\n${noteBody || '_(tom note)_'}\n`;

  const body = { content };
  if (dealId) body.deal_id = dealId;
  if (personId) body.person_id = personId;

  const res = await fetch(`${BASE}/notes?api_token=${TOKEN}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) {
    console.error(`[Pipedrive] createRelatelNote fejl ${res.status}: ${JSON.stringify(data)}`);
    return null;
  }
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
