// Alle Pipedrive-kald går gennem vagten: pause ved 401/429, stop ved 401 i kørslen
const guard = require('./pipedriveGuard');
const runStats = require('./runStats');
const fetch = guard.fetch;
const config = require('../config');
const { buildCoachingBlock } = require('./coaching');

const BASE = config.pipedrive.baseUrl;
const TOKEN = config.pipedrive.apiToken;

// Token sendes som header — ALDRIG i URL'en (URL'er ender i logs og fejlbeskeder)
const GET_HEADERS  = { 'x-api-token': TOKEN, 'Accept': 'application/json' };
const JSON_HEADERS = { 'x-api-token': TOKEN, 'Content-Type': 'application/json' };

// Pipedrive holder pause efter 401/429 (se pipedriveGuard.js), eller nøglen er
// afvist tidligere i denne kørsel. Baggrundsjob springer så over. Loftet deles
// med lead-hubben og Claudes Pipedrive-forbindelse.
function isRateLimited() {
  return guard.isPaused() || runStats.current().stopPipedrive;
}

// Telefonopslag med udfald: 'found' (person), 'none' (Pipedrive svarede, ingen
// match) eller 'error' (429, anden HTTP-fejl, netværk). Kun 'none' må caches
// som "ingen match" — en 429 er ikke et svar på spørgsmålet.
async function searchPersonByPhone(rawPhone) {
  if (!rawPhone) return { status: 'none', person: null };
  const digits = rawPhone.replace(/\D/g, '');
  if (digits.length < 8) return { status: 'none', person: null };
  const localNumber = digits.slice(-8);
  // Ikke exact_match: så finder Pipedrive kun numre gemt som præcis de otte
  // cifre, og alle numre gemt med +45 bliver aldrig fundet. Delvise træf
  // sorteres fra nedenfor, hvor de sidste otte cifre skal passe.
  const url = `${BASE}/persons/search?term=${encodeURIComponent(localNumber)}&fields=phone`;
  try {
    const res = await fetch(url, { headers: GET_HEADERS });
    const data = await res.json();
    if (!res.ok) {
      console.error(`[Pipedrive] Søge-fejl ${res.status} for ${localNumber}: ${JSON.stringify(data)}`);
      return { status: 'error', person: null, rateLimited: res.status === 429 };
    }
    const items = data?.data?.items || [];
    // Verificér at den fundne person rent faktisk HAR det nummer vi ringede til.
    // Før blev items[0] taget blindt, og et fejlmatch blev cachet i ti minutter
    // og skrevet tilbage til Relatel som kontaktens visningsnavn.
    const hit = items.find(({ item }) =>
      (item?.phones || []).some(
        (p) => String(p?.value ?? p).replace(/\D/g, '').slice(-8) === localNumber
      )
    );
    if (hit) {
      console.log(`[Pipedrive] Fandt kontakt for ${localNumber} (fra ${digits}) -> personId ${hit.item.id}`);
      return { status: 'found', person: hit.item };
    }
    if (items.length > 0) {
      console.warn(`[Pipedrive] ${items.length} træf for ${localNumber}, men ingen med et matchende nummer — afvist for at undgå fejlmatch`);
      return { status: 'none', person: null };
    }
    console.log(`[Pipedrive] Ingen kontakt fundet for ${localNumber} (fra ${digits})`);
    return { status: 'none', person: null };
  } catch (e) {
    console.error(`[Pipedrive] Netværksfejl ved søgning på ${localNumber}: ${e.message}`);
    return { status: 'error', person: null };
  }
}

async function findPersonByPhone(rawPhone) {
  return (await searchPersonByPhone(rawPhone)).person;
}

async function getPersonById(personId) {
  const url = `${BASE}/persons/${personId}`;
  const res = await fetch(url, { headers: GET_HEADERS });
  const data = await res.json();
  return data?.data || null;
}

// Åben deal først. Ellers den nyeste VUNDNE deal: vundne kunder ligger i
// Onboarding-pipelinen, og opkald til dem (opstart, opfølgning) skal også
// lande på dealen — ellers mister dealen sin historik (fejl fundet 7/10).
async function getPersonWithDeals(personId) {
  for (const status of ['open', 'won']) {
    const url = `${BASE}/persons/${personId}/deals?status=${status}&sort=update_time%20DESC&limit=1`;
    const res = await fetch(url, { headers: GET_HEADERS });
    const data = await res.json().catch(() => ({}));
    const deal = (data?.data || [])[0];
    if (deal?.id) return { latestDealId: deal.id };
  }
  return { latestDealId: null };
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
// Fast rækkefølge og faste labels HVER gang — agenten læser blokken via MCP
// og skal kunne tælle/sammenligne på tværs af opkald. Ukendt = "ikke nævnt".
function buildInsightBlock(ins) {
  const p = ins.profile || {};
  const j = ins.journey || {};
  const none = 'ikke nævnt';
  const val = (v) => (v === null || v === undefined || v === '' ? none : String(v));
  const list = (a) => (Array.isArray(a) && a.length ? a.join('; ') : none);
  const konk = (p.konkurrenter || []).map((k) => `${k.navn} (${k.forhold})`);
  const lines = [
    `Faggruppe: ${val(p.faggruppe)}`,
    `Medarbejdere: ${val(p.antalMedarbejdere)}`,
    `Driftssystem: ${val(p.driftssystem)}`,
    `Regnskabsprogram: ${val(p.regnskabsprogram)}`,
    `Lønprogram: ${val(p.loenprogram)}`,
    `Andre systemer: ${list(p.andreSystemer)}`,
    `Konkurrenter: ${list(konk)}`,
    `Købskanaler: ${list(p.koebskanaler)}`,
    `Kontaktens rolle: ${val(j.kontaktRolle)}`,
    `Anledning: ${val(j.anledning)}`,
    `Primær smerte: ${val(j.primaerSmerte)}`,
    `Konsekvens: ${list(j.konsekvens)}`,
    `Beslutning: ${val(j.beslutning)}`,
    `Kundens ord: ${list((j.kundensOrd || []).map((q) => '"' + String(q).replace(/\s*[;"\n]+\s*/g, ' ').trim() + '"'))}`,
    `Udfordringer: ${list(ins.painPoints)}`,
    `Indvendinger: ${list(ins.objections)}`,
    `Købssignaler: ${list(ins.buyingSignals)}`,
    `Næste skridt: ${list(ins.nextSteps)}`,
    `Opkaldstype: ${val(ins.callType)}  ·  Udfald: ${val(ins.callOutcome)}  ·  Stadie: ${val(ins.customerStage)}  ·  Stemning: ${val(ins.sentiment)}`,
    `Engagement: ${ins.engagementScore ? ins.engagementScore + '/10' : none}  ·  Sandsynlighed for salg: ${ins.conversionLikelihood ? ins.conversionLikelihood + '/10' : none}`,
    `Coaching: ${val(ins.aiCoachingNote)}`,
  ];
  return `### Indsigter (skema v${ins.schemaVersion || 1})\n${lines.map((l) => `- ${l}`).join('\n')}\n\n`;
}

// Hvad dialeren selv gjorde i Pipedrive efter kaldet. FASTE labels —
// Salgscoach-appen viser dem under "I Pipedrive" (insights.js: parsePipedriveBlock).
function buildPipedriveBlock({ personName, dealTitle, changes }) {
  const clean = (s) => String(s || '').replace(/\s*[;\n]+\s*/g, ', ').trim();
  const lines = [
    `Opkald lagt på: ${clean(personName) || 'kontakten'}${dealTitle ? ` · deal "${clean(dealTitle)}"` : ' · ingen deal'}`,
    ...((changes || []).length
      ? changes.map((c) => `Udfyldt (var tomt): ${clean(c.felt)} → ${clean(c.vaerdi)}`)
      : ['Udfyldt (var tomt): intet']),
  ];
  return `### Pipedrive (skema v1)\n${lines.map((l) => `- ${l}`).join('\n')}\n\n`;
}

// Den fulde samtale sendes IKKE til Pipedrive: den bliver i dialerens egen
// database og slettes efter 12 mdr. (GDPR-beslutning 11/6 + 24/9 2026)
function buildCallNoteContent({
  direction, phoneNumber, startedAt, durationSec,
  summary, actionPoints, topics, insights, coaching, pipedrive,
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
  if (insights) {
    content += buildInsightBlock(insights);
  }
  if (coaching) {
    content += buildCoachingBlock(coaching);
  }
  if (pipedrive) {
    content += buildPipedriveBlock(pipedrive);
  }
  return content;
}

async function createCallNote({ dealId, personId, callData }) {
  const content = buildCallNoteContent(callData);
  // Almindelig note (ikke pinned) → vises under Notes-fanen og opdaterer Notes(X)-tælleren
  const body = { content };
  if (dealId) body.deal_id = dealId;
  if (personId) body.person_id = personId;

  const res = await fetch(`${BASE}/notes`, {
    method: 'POST',
    headers: JSON_HEADERS,
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
  const res = await fetch(`${BASE}/notes/${noteId}`, {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify({ content }),
  });
  const data = await res.json();
  if (!res.ok) {
    console.error(`[Pipedrive] updateNote fejl ${res.status}: ${JSON.stringify(data)}`);
    return null;
  }
  return data?.data?.id || null;
}

// ============================================================
// AKTIVITETER — opkald og SMS lægges som UDFØRTE aktiviteter med hver sin
// type ('call' / 'SMS'), så de kan skilles fra noter i data (MCP-agenten
// læser type-feltet). done=1 + busy_flag=false: ingen to-do, ingen
// optaget-tid i kalenderen. Noter forbeholdes rigtige noter.
// ============================================================

// Note-feltet på en aktivitet er HTML — omsæt vores lette markdown
function toActivityHtml(md) {
  const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return md.split('\n').map((line) => {
    let l = esc(line);
    if (/^#{2,3} /.test(l)) return '<b>' + l.replace(/^#{2,3} /, '') + '</b>';
    l = l.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/^- /, '• ');
    return l;
  }).join('<br>');
}

// Pipedrive v1: due_date/due_time i UTC, duration som HH:MM
function dueFields(iso) {
  const d = iso ? new Date(iso) : new Date();
  const t = isNaN(d) ? new Date() : d;
  return { due_date: t.toISOString().slice(0, 10), due_time: t.toISOString().slice(11, 16) };
}
function durationHHMM(sec) {
  if (!sec || sec <= 0) return undefined;
  const mins = Math.max(1, Math.round(sec / 60));
  return String(Math.floor(mins / 60)).padStart(2, '0') + ':' + String(mins % 60).padStart(2, '0');
}

async function postActivity(body, label) {
  const res = await fetch(`${BASE}/activities`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`[Pipedrive] ${label} fejl ${res.status}: ${JSON.stringify(data)}`);
    return null;
  }
  return data?.data?.id || null;
}

async function createCallActivity({ dealId, personId, callData }) {
  const dirLabel = callData.direction === 'outgoing' ? 'Udgående' : 'Indgående';
  const body = {
    subject: `Opkald — ${dirLabel}`,
    type: 'call',
    done: 1,
    busy_flag: false,
    ...dueFields(callData.startedAt),
    note: toActivityHtml(buildCallNoteContent(callData)),
  };
  const dur = durationHHMM(callData.durationSec);
  if (dur) body.duration = dur;
  if (dealId) body.deal_id = dealId;
  if (personId) body.person_id = personId;
  return postActivity(body, 'createCallActivity');
}

async function updateCallActivity(activityId, { callData, dealId }) {
  const body = { note: toActivityHtml(buildCallNoteContent(callData)) };
  if (dealId) body.deal_id = dealId; // fx når dealen først blev fundet efter kaldet
  const res = await fetch(`${BASE}/activities/${activityId}`, {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`[Pipedrive] updateCallActivity fejl ${res.status}: ${JSON.stringify(data)}`);
    return null;
  }
  return data?.data?.id || null;
}

// Aktivitetstypen "SMS" findes ikke som standard i Pipedrive — slå op, og
// opret den én gang hvis den mangler (ikon: taleboble)
let smsTypeKey = null;
async function ensureSmsActivityType() {
  if (smsTypeKey) return smsTypeKey;
  try {
    const res = await fetch(`${BASE}/activityTypes`, { headers: GET_HEADERS });
    const data = await res.json();
    const found = (data?.data || []).find(
      (t) => t.active_flag !== false && String(t.name || '').trim().toLowerCase() === 'sms'
    );
    if (found) return (smsTypeKey = found.key_string);

    const cr = await fetch(`${BASE}/activityTypes`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ name: 'SMS', icon_key: 'bubble' }),
    });
    const cd = await cr.json().catch(() => ({}));
    if (!cr.ok || !cd?.data?.key_string) {
      console.error(`[Pipedrive] Kunne ikke oprette aktivitetstypen SMS (${cr.status}): ${JSON.stringify(cd)}`);
      return null;
    }
    console.log('[Pipedrive] Aktivitetstype "SMS" oprettet (key: ' + cd.data.key_string + ')');
    return (smsTypeKey = cd.data.key_string);
  } catch (e) {
    console.error('[Pipedrive] ensureSmsActivityType fejl:', e.message);
    return null;
  }
}

// Returnerer { activityId } — eller { noteId } som nødløsning, hvis
// SMS-typen ikke kan oprettes (så mister vi aldrig en SMS)
async function createSmsRecord({ personId, dealId, smsData }) {
  const typeKey = await ensureSmsActivityType();
  if (!typeKey) {
    const noteId = await createSmsNote({ personId, dealId, smsData });
    return { noteId };
  }
  const { direction, body: msgBody, sentAt } = smsData;
  const dirLabel = direction === 'outgoing' ? 'Sendt' : 'Modtaget';
  const snippet = (msgBody || '').replace(/\s+/g, ' ').trim();
  const body = {
    subject: `SMS — ${dirLabel}` + (snippet ? `: ${snippet.length > 60 ? snippet.slice(0, 57) + '…' : snippet}` : ''),
    type: typeKey,
    done: 1,
    busy_flag: false,
    ...dueFields(sentAt),
    note: toActivityHtml(buildSmsContent(smsData)),
  };
  if (dealId) body.deal_id = dealId;
  if (personId) body.person_id = personId;
  const activityId = await postActivity(body, 'createSmsActivity');
  return { activityId };
}

// ============================================================
// SMS-note med tydelig overskrift
// ============================================================
function buildSmsContent({ direction, phoneNumber, body: msgBody, sentAt }) {
  const dirLabel = direction === 'outgoing' ? 'Sendt' : 'Modtaget';
  let content = `## SMS — ${dirLabel}\n`;
  content += `**Tidspunkt:** ${formatDate(sentAt)}  ·  **Nummer:** ${phoneNumber || '—'}\n\n`;
  content += `### Besked\n${msgBody || '_(tom besked)_'}\n`;
  return content;
}

async function createSmsNote({ personId, dealId, smsData }) {
  const content = buildSmsContent(smsData);

  const noteBody = { content };
  if (dealId) noteBody.deal_id = dealId;
  if (personId) noteBody.person_id = personId;

  const res = await fetch(`${BASE}/notes`, {
    method: 'POST',
    headers: JSON_HEADERS,
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

  const res = await fetch(`${BASE}/notes`, {
    method: 'POST',
    headers: JSON_HEADERS,
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

  const res = await fetch(`${BASE}/persons`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
  const data = await res.json();
  return data?.data || null;
}

module.exports = {
  isRateLimited,
  findPersonByPhone,
  searchPersonByPhone,
  getPersonById,
  getPersonWithDeals,
  createCallNote,
  updateNote,
  createCallActivity,
  updateCallActivity,
  createSmsNote,
  createSmsRecord,
  ensureSmsActivityType,
  createRelatelNote,
  createPerson,
};
