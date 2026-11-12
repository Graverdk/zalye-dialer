// ============================================================
// Twenty-adapteren (REST mod crm.zalye.si). Samme grænseflade som
// src/crm/pipedrive.js — se src/crm/index.js for beskrivelsen.
//
// Opkald, SMS og Relatel-noter bliver til en Samtale med et eksterntId
// (relatel-call:<uuid>, relatel-sms:<id>, relatel-note:<id>), så den samme
// hændelse aldrig oprettes to gange: før en oprettelse bruges id'et fra
// SQLite, ellers slås eksterntId op i Twenty.
//
// Funktionerne kaster ikke ved HTTP-fejl; de giver null/'error' tilbage,
// ligesom Pipedrive-koden. Alle navne og option-værdier står i
// twentyMapping.js og tjekkes mod Twentys metadata før skrivning.
// ============================================================
const crypto = require('crypto');
const config = require('../config');
const client = require('./twentyClient');
const meta = require('./twentyMeta');
const M = require('./twentyMapping');
const { last8 } = require('../services/phoneLookupCache');
const { buildCallNoteContent, buildSmsContent } = require('../services/pipedrive');
const { buildCoachingBlock } = require('../services/coaching');

const { OBJECTS } = M;
const LABEL = 'Twenty';

const cols = {
  person: 'twenty_person_id',
  deal: 'twenty_opportunity_id',
  company: 'twenty_company_id',
  onboarding: 'twenty_onboarding_id',
  record: 'twenty_samtale_id',
  notePerson: 'twenty_person_id',
  noteRecord: 'twenty_record_id',
};

const enc = encodeURIComponent;
const filterParam = (f) => 'filter=' + enc(f);
const first = (res) => (res.ok && Array.isArray(res.data) && res.data.length ? res.data[0] : null);

function isPaused() {
  return client.isPaused();
}

// ------------------------------------------------------------
// Telefonnumre
// ------------------------------------------------------------
function personNumbers(p) {
  const out = [];
  const ph = p && p.phones;
  if (ph) {
    if (ph.primaryPhoneNumber) out.push(String(ph.primaryPhoneCallingCode || '') + String(ph.primaryPhoneNumber));
    for (const a of Array.isArray(ph.additionalPhones) ? ph.additionalPhones : []) {
      if (!a) continue;
      if (typeof a === 'string') out.push(a);
      else if (a.number) out.push(String(a.callingCode || '') + String(a.number));
    }
  }
  return out;
}

function personHasNumber(p, l8) {
  if (p && p[M.PERSON.telefon8] && String(p[M.PERSON.telefon8]) === l8) return true;
  return personNumbers(p).some((n) => last8(n) === l8);
}

// Udfald: { status: 'found'|'none'|'error', person }. Kun 'none' må caches.
async function searchPersonByPhone(rawPhone) {
  const l8 = last8(rawPhone);
  if (l8.length < 8) return { status: 'none', person: null };
  const order = '&orderBy=' + enc('updatedAt[DescNullsLast]');

  // 1) telefon8 (sat på importerede personer + af dialeren ved match)
  const r1 = await client.get(`/${OBJECTS.person}?${filterParam(`${M.PERSON.telefon8}[eq]:${client.q(l8)}`)}&limit=5${order}`);
  if (!r1.ok && r1.status !== 400) return { status: 'error', person: null };
  let hit = (r1.ok ? r1.data || [] : []).find((p) => personHasNumber(p, l8));

  // 2) Fallback: primært nummer, verificér de sidste 8 cifre (også additionalPhones)
  if (!hit) {
    const r2 = await client.get(`/${OBJECTS.person}?${filterParam(`phones.primaryPhoneNumber[like]:${client.q('%' + l8)}`)}&limit=10${order}`);
    if (!r2.ok) return { status: 'error', person: null };
    const items = r2.data || [];
    hit = items.find((p) => personHasNumber(p, l8));
    if (!hit && items.length) {
      console.warn(`[Twenty] ${items.length} træf for …${l8.slice(-4)}, men ingen med et matchende nummer — afvist for at undgå fejlmatch`);
    }
  }
  if (!hit) {
    console.log(`[Twenty] Ingen person fundet for …${l8.slice(-4)}`);
    return { status: 'none', person: null };
  }

  // Sæt telefon8 på personen, så næste opslag rammer det hurtige filter
  if (String(hit[M.PERSON.telefon8] || '') !== l8) {
    await meta.load();
    const body = meta.clean(OBJECTS.person, { [M.PERSON.telefon8]: l8 });
    if (body && Object.keys(body).length) {
      const r = await client.patch(`/${OBJECTS.person}/${hit.id}`, body);
      if (r.ok) console.log(`[Twenty] telefon8 sat på person ${hit.id}`);
    }
  }
  console.log(`[Twenty] Fandt person for …${l8.slice(-4)} -> ${hit.id}`);
  return { status: 'found', person: hit };
}

// Åben salgsmulighed først, ellers nyeste VUNDET. Ingen åben → også aktiv onboarding.
async function getLinks(personId, person) {
  const companyId = (person && person.companyId) || null;
  const owner = companyId
    ? `${M.OPPORTUNITY.companyId}[eq]:${client.q(companyId)}`
    : `${M.OPPORTUNITY.pointOfContactId}[eq]:${client.q(personId)}`;
  const order = '&orderBy=' + enc('updatedAt[DescNullsLast]') + '&limit=1';
  const stages = '[' + M.OPEN_STAGES.map(client.q).join(',') + ']';

  const open = first(await client.get(`/${OBJECTS.opportunity}?${filterParam(`and(${owner},${M.OPPORTUNITY.stage}[in]:${stages})`)}${order}`));
  if (open) return { latestDealId: open.id, companyId };

  const won = first(await client.get(`/${OBJECTS.opportunity}?${filterParam(`and(${owner},${M.OPPORTUNITY.stage}[eq]:${client.q(M.STAGE.VUNDET)})`)}${order}`));
  let onboardingId = null;
  if (companyId) {
    const ob = first(await client.get(`/${OBJECTS.onboarding}?${filterParam(`and(${M.ONBOARDING.virksomhedId}[eq]:${client.q(companyId)},${M.ONBOARDING.fase}[neq]:${client.q(M.ONBOARDING_STOPPET)})`)}${order}`));
    onboardingId = ob ? ob.id : null;
  }
  return { latestDealId: won ? won.id : null, companyId, onboardingId };
}

// ------------------------------------------------------------
// Mødebooker ud fra Relatel employee_number (moedebooker.relatelBruger)
// Listen hentes én gang i timen.
// ------------------------------------------------------------
let bookerCache = { at: 0, list: null };
async function findMoedebooker(employeeNumber) {
  if (!employeeNumber) return null;
  if (!bookerCache.list || Date.now() - bookerCache.at > 3600 * 1000) {
    const r = await client.get(`/${OBJECTS.moedebooker}?limit=100`);
    if (r.ok && Array.isArray(r.data)) bookerCache = { at: Date.now(), list: r.data };
    else if (!bookerCache.list) return null;
  }
  const want = String(employeeNumber).trim().toLowerCase();
  const wantDigits = want.replace(/\D/g, '');
  return bookerCache.list.find((b) => {
    const v = String(b[M.MOEDEBOOKER.relatelBruger] || '').trim().toLowerCase();
    if (!v) return false;
    if (v === want) return true;
    const d = v.replace(/\D/g, '');
    return d.length >= 2 && wantDigits.length >= 2 && (d === wantDigits || (d.length >= 8 && last8(d) === last8(wantDigits)));
  }) || null;
}

// Mødebookeren for et opkald: først Relatel-brugeren, ellers den booker
// salgscoachen sendte med, da opkaldet blev startet (calls.twenty_moedebooker_id)
async function bookerForRow(row) {
  if (!row) return null;
  const viaRelatel = await findMoedebooker(row.employee_number);
  if (viaRelatel) return viaRelatel;
  return row.twenty_moedebooker_id ? { id: row.twenty_moedebooker_id } : null;
}

// ------------------------------------------------------------
// Samtaler (idempotent via eksterntId)
// ------------------------------------------------------------
async function findSamtaleId(eksterntId) {
  const r = await client.get(`/${OBJECTS.samtale}?${filterParam(`${M.SAMTALE.eksterntId}[eq]:${client.q(eksterntId)}`)}&limit=1`);
  if (!r.ok) return { ok: false, id: null };
  const s = first(r);
  return { ok: true, id: s ? s.id : null };
}

const isDuplicate = (res) => [400, 409].includes(res.status)
  && /duplicate|unique|already exists|findes allerede/i.test(JSON.stringify(res.json || ''));

// Returnerer { id, created } eller null (fejl/pause)
async function upsertSamtale(eksterntId, createFields, updateFields, knownId) {
  await meta.load();
  let id = knownId || null;
  if (!id) {
    const f = await findSamtaleId(eksterntId);
    if (!f.ok) return null;
    id = f.id;
  }
  if (id) {
    const body = meta.clean(OBJECTS.samtale, updateFields || {});
    if (body && Object.keys(body).length) {
      const r = await client.patch(`/${OBJECTS.samtale}/${id}`, body);
      if (!r.ok) return null;
    }
    return { id, created: false };
  }
  const body = meta.clean(OBJECTS.samtale, { ...createFields, ...(updateFields || {}), [M.SAMTALE.eksterntId]: eksterntId });
  const r = await client.post(`/${OBJECTS.samtale}`, body);
  if (r.ok && r.data && r.data.id) return { id: r.data.id, created: true };
  if (isDuplicate(r)) {
    const f = await findSamtaleId(eksterntId);
    if (f.ok && f.id) return { id: f.id, created: false };
  }
  return null;
}

function relations(match, { moedebookerId } = {}) {
  const S = M.SAMTALE;
  const out = {};
  if (match && match.personId) out[S.personId] = match.personId;
  if (match && match.companyId) out[S.virksomhedId] = match.companyId;
  if (match && match.latestDealId) out[S.salgsmulighedId] = match.latestDealId;
  if (match && match.onboardingId) out[S.onboardingId] = match.onboardingId;
  if (moedebookerId) out[S.moedebookerId] = moedebookerId;
  else if (config.twenty.defaultOwnerMemberId) out[S.fortAfId] = config.twenty.defaultOwnerMemberId;
  return out;
}

const callExternalId = (uuid) => 'relatel-call:' + uuid;
const isoOrNull = (v) => { const d = v ? new Date(v) : null; return d && !isNaN(d) ? d.toISOString() : null; };

async function callBaseFields(row, match) {
  const S = M.SAMTALE;
  const booker = row.direction === 'outgoing' ? await bookerForRow(row) : null;
  return {
    fields: {
      [S.name]: 'Opkald — ' + (row.direction === 'outgoing' ? 'Udgående' : 'Indgående'),
      [S.samtaletype]: M.SAMTALETYPE.OPKALD,
      [S.retning]: M.retning(row.direction),
      [S.dato]: isoOrNull(row.started_at || row.ended_at),
      [S.varighedMin]: M.varighedMin(row.duration_sec),
      [S.kilde]: M.KILDE.DIALER,
      ...relations(match, { moedebookerId: booker && booker.id }),
    },
    booker,
  };
}

// Opkald afsluttet (uden analyse): 1 kald (eller 0, hvis id'et kendes)
async function upsertCallRecord({ row, match }) {
  if (!row || !row.relatel_uuid) return null;
  if (row.twenty_samtale_id) return row.twenty_samtale_id;
  const { fields } = await callBaseFields(row, match);
  const r = await upsertSamtale(callExternalId(row.relatel_uuid), fields, null, null);
  return r ? r.id : null;
}

// "Twenty (skema v1)": hvad dialeren selv gjorde. Samme labels som Pipedrive-blokken,
// så Salgscoach-appen kan vise dem ("I Twenty").
function buildTwentyBlock({ personName, dealTitle, changes, stageChange } = {}) {
  const clean = (s) => String(s || '').replace(/\s*[;\n]+\s*/g, ', ').trim();
  const lines = [
    `Opkald lagt på: ${clean(personName) || 'kontakten'}${dealTitle ? ` · salgsmulighed "${clean(dealTitle)}"` : ' · ingen salgsmulighed'}`,
    ...((changes || []).length
      ? changes.map((c) => `Udfyldt (var tomt): ${clean(c.felt)} → ${clean(c.vaerdi)}`)
      : ['Udfyldt (var tomt): intet']),
  ];
  if (stageChange) lines.push(`Trin flyttet: ${clean(stageChange.from)} → ${clean(stageChange.to)}`);
  return `### Twenty (skema v1)\n${lines.map((l) => `- ${l}`).join('\n')}\n\n`;
}

function buildResume(callData) {
  let md = buildCallNoteContent({ ...callData, coaching: null, pipedrive: null });
  if (callData.twenty) md += buildTwentyBlock(callData.twenty);
  return md;
}

function transcriptMarkdown(transcript) {
  if (!config.twenty.sendTranscript) return 'Fuldt transskript ligger i dialeren (slettes efter 12 mdr.).';
  if (!transcript) return null;
  const max = config.twenty.transcriptMaxChars;
  if (max > 0 && transcript.length > max) {
    return transcript.slice(0, max) + '\n\n_(afkortet — fuld tekst ligger i dialeren og slettes efter 12 mdr.)_';
  }
  return transcript;
}

// Analyse færdig: 1 PATCH (eller POST hvis samtalen mangler) + 1 PATCH til transskriptet.
// Transskriptet sendes for sig, så et for stort body aldrig koster resumé og coaching.
async function completeCallRecord({ row, match, callData, transcript }) {
  if (!row || !row.relatel_uuid) return null;
  const S = M.SAMTALE;
  const { fields: base, booker } = await callBaseFields(row, match);
  const coaching = callData.coaching || null;
  const ins = callData.insights || null;
  const update = {
    ...relations(match, { moedebookerId: booker && booker.id }),
    [S.udfald]: M.udfald({ coachingUdfald: coaching && coaching.udfald, callOutcome: ins && ins.callOutcome, isUnanswered: callData.isUnanswered }),
    [S.modetype]: coaching ? M.modetype(coaching.moedetype, { byMoedebooker: !!booker }) : null,
    [S.temperatur]: ins ? M.temperatur(ins) : null,
    [S.blokkeDaekket]: coaching ? M.blokkeDaekket(coaching.blokke) : [],
    [S.resume]: { markdown: buildResume(callData) },
  };
  if (coaching) update[S.coachVurdering] = { markdown: buildCoachingBlock(coaching) };
  for (const k of Object.keys(update)) if (update[k] === null) delete update[k];

  const r = await upsertSamtale(callExternalId(row.relatel_uuid), base, update, row.twenty_samtale_id);
  if (!r) return null;

  const tx = transcriptMarkdown(transcript);
  if (tx) {
    const body = meta.clean(OBJECTS.samtale, { [S.transskript]: { markdown: tx } });
    if (body && Object.keys(body).length) {
      const t = await client.patch(`/${OBJECTS.samtale}/${r.id}`, body);
      if (!t.ok) console.warn('[Twenty] Transskriptet kom ikke med på samtale ' + r.id + ' (resumé og coaching er gemt)');
    }
  }
  console.log('[Twenty] Samtale ' + (r.created ? 'oprettet' : 'opdateret') + ' med analyse: ' + r.id);
  return { recordId: r.id, created: r.created };
}

// ------------------------------------------------------------
// Autofill: KUN tomme felter. Felter med en anden værdi giver et forslag
// (signal med forslag=UDFYLD_FELT) i stedet. DEMO_BOOKET sættes her også,
// fordi salgsmuligheden alligevel hentes.
// ------------------------------------------------------------
const isEmpty = (v) => v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0)
  || (typeof v === 'object' && !Array.isArray(v) && v && 'amountMicros' in v && v.amountMicros == null);

async function autofill({ match, analysis, coaching, row } = {}) {
  const changes = [];
  const suggestions = [];
  const result = { changes, suggestions, personName: null, dealTitle: null, stageChange: null };
  if (!analysis || !match || !match.personId) return result;
  await meta.load();
  const p = analysis.profile || {};
  const j = analysis.journey || {};

  const person = (await client.get(`/${OBJECTS.person}/${match.personId}`)).data;
  if (person) {
    const n = person.name || {};
    result.personName = [n.firstName, n.lastName].filter(Boolean).join(' ').trim() || null;
    const rolle = M.rolle(j.kontaktRolle);
    const f = M.PERSON.rolle;
    if (rolle) {
      if (isEmpty(person[f])) {
        const body = meta.clean(OBJECTS.person, { [f]: rolle });
        if (body[f] && (await client.patch(`/${OBJECTS.person}/${person.id}`, body)).ok) changes.push({ felt: 'Rolle', vaerdi: rolle });
      } else if (person[f] !== rolle) {
        suggestions.push({ felt: 'person.' + f, vaerdi: rolle });
      }
    }
  }

  const companyId = match.companyId || (person && person.companyId) || null;
  if (companyId) {
    const company = (await client.get(`/${OBJECTS.company}/${companyId}`)).data;
    if (company) {
      const C = M.COMPANY;
      const upd = {};
      const pending = []; // { felt, key, vaerdi } — meldes først, når PATCH er gået igennem
      const set = (felt, key, value, label) => { upd[key] = value; pending.push({ felt, key, vaerdi: label ?? String(value) }); };
      if (isEmpty(company[C.employees]) && Number.isInteger(p.antalMedarbejdere) && p.antalMedarbejdere > 0) {
        set('Antal ansatte', C.employees, p.antalMedarbejdere);
      }
      const brancheVal = M.branche(p.faggruppe) || meta.matchOption(OBJECTS.company, C.branche, p.faggruppe);
      if (brancheVal && isEmpty(company[C.branche])) set('Fag', C.branche, [brancheVal], brancheVal);
      // Systemfelterne er MULTI_SELECT i Twenty. Fast mapping først, ellers Twentys egne options.
      const system = (felt, key, raw, fixed) => {
        const v = fixed || meta.matchOption(OBJECTS.company, key, raw);
        if (!v) return;
        const type = meta.fieldType(OBJECTS.company, key) || 'MULTI_SELECT';
        if (isEmpty(company[key])) set(felt, key, type === 'MULTI_SELECT' ? [v] : v, v);
        else if (![].concat(company[key]).includes(v)) suggestions.push({ felt: 'company.' + key, vaerdi: v });
      };
      system('Driftssystem', C.driftssystem, p.driftssystem, M.driftssystem(p.driftssystem));
      system('Regnskabsprogram', C.regnskabsprogram, p.regnskabsprogram, M.regnskabsprogram(p.regnskabsprogram));
      system('Lønprogram', C.lonprogram, p.loenprogram, M.lonprogram(p.loenprogram));
      const body = meta.clean(OBJECTS.company, upd);
      if (Object.keys(body).length && (await client.patch(`/${OBJECTS.company}/${companyId}`, body)).ok) {
        // felter, som meta.clean droppede, er ikke udfyldt
        for (const c of pending) if (c.key in body) changes.push({ felt: c.felt, vaerdi: c.vaerdi });
      }
    }
  }

  if (match.latestDealId) {
    const O = M.OPPORTUNITY;
    const opp = (await client.get(`/${OBJECTS.opportunity}/${match.latestDealId}`)).data;
    if (opp) {
      result.dealTitle = opp.name || null;
      const upd = {};
      const labels = {};
      const fill = (felt, key, value) => {
        if (value === null || value === undefined || value === '') return;
        if (isEmpty(opp[key])) { upd[key] = value; labels[key] = felt; }
        else if (opp[key] !== value) suggestions.push({ felt: 'opportunity.' + key, vaerdi: value });
      };
      fill('Anledning', O.anledning, M.anledning(j.anledning));
      fill('Primær smerte', O.primaerSmerte, M.primaerSmerte(j.primaerSmerte));
      const objections = Array.isArray(analysis.objections) ? analysis.objections : [];
      fill('Indvending', O.indvending, objections.length ? objections.join('; ') : null);
      const kons = Array.isArray(j.konsekvens) ? j.konsekvens : [];
      fill('Konsekvens', O.konsekvens, kons.length ? kons.join('; ') : null);
      fill('Konsekvens (timer/uge)', O.konsekvensTimerUge, M.timerPrUge(kons));

      // DEMO_BOOKET: kun fremad fra et tidligere åbent trin, og booketAf sættes samtidig
      if (M.isBooked({ coachingUdfald: coaching && coaching.udfald, callOutcome: analysis.callOutcome })) {
        if (M.STAGES_BEFORE_DEMO_BOOKET.includes(opp[O.stage])) {
          upd[O.stage] = M.STAGE.DEMO_BOOKET;
          result.stageChange = { from: opp[O.stage], to: M.STAGE.DEMO_BOOKET };
        }
        const booker = row && row.direction === 'outgoing' ? await bookerForRow(row) : null;
        if (booker && isEmpty(opp[O.booketAfId])) { upd[O.booketAfId] = booker.id; labels[O.booketAfId] = 'Booket af'; }
      }

      const body = meta.clean(OBJECTS.opportunity, upd);
      if (Object.keys(body).length) {
        const r = await client.patch(`/${OBJECTS.opportunity}/${opp.id}`, body);
        if (r.ok) {
          for (const [k, felt] of Object.entries(labels)) if (k in body) changes.push({ felt, vaerdi: String(body[k]) });
          if (result.stageChange && !(O.stage in body)) result.stageChange = null;
          if (result.stageChange) console.log('[Twenty] Salgsmulighed ' + opp.id + ' flyttet til ' + M.STAGE.DEMO_BOOKET);
        } else {
          result.stageChange = null;
        }
      } else {
        result.stageChange = null;
      }
    }
  }
  return result;
}

// ------------------------------------------------------------
// Signaler: ét batch-kald med status=FORESLAAET. signaltype er en af
// ANLEDNING, SMERTE, INDVENDING, KONKURRENT, KUNDENS_ORD (ingen KONSEKVENS —
// konsekvens står på salgsmuligheden). vaerdi = enum-værdien, hvis den
// findes (fx VAEKST), ellers teksten; citat = kundens ordrette ord.
// ------------------------------------------------------------
const SIGNAL_BATCH_MAX = 60;
const short = (s, n = 80) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

function buildSignals({ samtaleId, match, analysis, suggestions = [] }) {
  const G = M.SIGNAL;
  const T = M.SIGNAL_TYPE;
  const j = (analysis && analysis.journey) || {};
  const p = (analysis && analysis.profile) || {};
  const base = { [G.samtaleId]: samtaleId, [G.status]: M.SIGNAL_STATUS.FORESLAAET };
  if (match && match.companyId) base[G.virksomhedId] = match.companyId;
  if (match && match.latestDealId) base[G.salgsmulighedId] = match.latestDealId;
  const out = [];
  const add = (type, label, tekst, { vaerdi, citat, forslagFelt } = {}) => {
    if (!tekst) return;
    const rec = { ...base, [G.name]: short(label + ': ' + tekst), [G.type]: type, [G.vaerdi]: String(vaerdi || tekst) };
    if (citat) rec[G.citat] = { markdown: String(citat) };
    const s = forslagFelt && suggestions.find((x) => x.felt === forslagFelt);
    if (s) Object.assign(rec, { [G.forslag]: M.SIGNAL_FORSLAG.UDFYLD_FELT, [G.forslagFelt]: s.felt, [G.forslagVaerdi]: String(s.vaerdi) });
    out.push(rec);
  };
  add(T.ANLEDNING, 'Anledning', j.anledning, { vaerdi: M.anledning(j.anledning), forslagFelt: 'opportunity.' + M.OPPORTUNITY.anledning });
  add(T.SMERTE, 'Smerte', j.primaerSmerte, { vaerdi: M.primaerSmerte(j.primaerSmerte), forslagFelt: 'opportunity.' + M.OPPORTUNITY.primaerSmerte });
  (analysis.objections || []).forEach((o, i) => add(T.INDVENDING, 'Indvending', o, { forslagFelt: i === 0 ? 'opportunity.' + M.OPPORTUNITY.indvending : null }));
  (p.konkurrenter || []).forEach((k) => add(T.KONKURRENT, 'Konkurrent', k && k.navn ? `${k.navn} (${k.forhold})` : null));
  (j.kundensOrd || []).forEach((q) => add(T.KUNDENS_ORD, 'Kundens ord', q, { citat: q }));
  return out.slice(0, SIGNAL_BATCH_MAX);
}

// Kaldes efter completeCallRecord. Returnerer antal oprettede signaler, eller null ved fejl.
async function afterAnalysis({ recordId, match, analysis, autofill: af }) {
  if (!recordId || !analysis) return 0;
  await meta.load();
  const records = buildSignals({ samtaleId: recordId, match, analysis, suggestions: (af && af.suggestions) || [] })
    .map((r) => meta.clean(OBJECTS.signal, r));
  if (!records.length) return 0;
  const r = await client.post(`/batch/${OBJECTS.signal}`, records);
  if (!r.ok) return null;
  console.log('[Twenty] ' + records.length + ' signaler foreslået for samtale ' + recordId);
  return records.length;
}

// ------------------------------------------------------------
// SMS og Relatel-noter
// ------------------------------------------------------------
async function upsertSms({ row, match }) {
  if (!row || !row.relatel_id) return { recordId: null };
  if (row.twenty_samtale_id) return { recordId: row.twenty_samtale_id };
  const S = M.SAMTALE;
  const dirLabel = row.direction === 'outgoing' ? 'Sendt' : 'Modtaget';
  const snippet = (row.body || '').replace(/\s+/g, ' ').trim();
  const fields = {
    [S.name]: `SMS — ${dirLabel}` + (snippet ? `: ${snippet.length > 60 ? snippet.slice(0, 57) + '…' : snippet}` : ''),
    [S.samtaletype]: M.SAMTALETYPE.SMS,
    [S.retning]: M.retning(row.direction),
    [S.dato]: isoOrNull(row.sent_at),
    [S.kilde]: M.KILDE.DIALER,
    [S.transskript]: { markdown: buildSmsContent({ direction: row.direction, phoneNumber: row.phone_number, body: row.body, sentAt: row.sent_at }) },
    ...relations(match),
  };
  const r = await upsertSamtale('relatel-sms:' + row.relatel_id, fields, null, null);
  return { recordId: r ? r.id : null };
}

async function upsertRelatelNote({ note, match }) {
  if (!note || !note.relatel_id) return null;
  const S = M.SAMTALE;
  const md = (note.author ? `**Af:** ${note.author}\n\n` : '') + (note.body || '_(tom note)_');
  const fields = {
    [S.name]: 'Note — Skrevet i Relatel',
    [S.samtaletype]: M.SAMTALETYPE.NOTE,
    [S.dato]: isoOrNull(note.created_at_rel) || new Date().toISOString(),
    [S.kilde]: M.KILDE.DIALER,
    [S.transskript]: { markdown: md },
    ...relations(match),
  };
  const r = await upsertSamtale('relatel-note:' + note.relatel_id, fields, null, null);
  return r ? r.id : null;
}

// ------------------------------------------------------------
// Navnesynk til Relatel: "Navn (Firma)" + mail fra Twenty-personen
// ------------------------------------------------------------
async function getContactForRelatel(rawPhone) {
  const res = await searchPersonByPhone(rawPhone);
  if (res.status === 'error') return { status: 'error' };
  if (res.status !== 'found') return { status: 'none' };
  const p = res.person;
  const n = p.name || {};
  const name = [n.firstName, n.lastName].filter(Boolean).join(' ').trim();
  if (!name) return { status: 'none' };
  let company = (p.company && p.company.name) || null;
  if (!company && p.companyId) {
    const c = (await client.get(`/${OBJECTS.company}/${p.companyId}`)).data;
    company = (c && c.name) || null;
  }
  const email = (p.emails && p.emails.primaryEmail) || null;
  return { status: 'found', name, company, email };
}

// ------------------------------------------------------------
// Opgave ved ukendt nummer: højst én pr. nummer pr. dag (lokal tabel +
// fast id i Twenty), kun for opkald over minimumsvarigheden.
// ------------------------------------------------------------
function uuidv5(name) {
  // Fast navnerum for dialeren (tilfældigt valgt, må ikke ændres)
  const ns = Buffer.from('3f2a1c9e7b5d4e8f9a0b1c2d3e4f5a6b', 'hex');
  const h = crypto.createHash('sha1').update(Buffer.concat([ns, Buffer.from(name, 'utf8')])).digest();
  h[6] = (h[6] & 0x0f) | 0x50;
  h[8] = (h[8] & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

function cphDay(d) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Copenhagen', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
function cphTime(d) {
  return new Intl.DateTimeFormat('da-DK', { timeZone: 'Europe/Copenhagen', hour: '2-digit', minute: '2-digit' }).format(d);
}
// Kl. 16:00 dansk tid på dagen som ISO (UTC)
function cph1600(day) {
  const probe = new Date(day + 'T12:00:00Z');
  const off = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Copenhagen', timeZoneName: 'longOffset' })
    .formatToParts(probe).find((x) => x.type === 'timeZoneName').value; // "GMT+01:00"
  const m = off.match(/([+-])(\d{2}):?(\d{2})/);
  const sign = m && m[1] === '-' ? -1 : 1;
  const mins = m ? sign * (Number(m[2]) * 60 + Number(m[3])) : 60;
  return new Date(Date.parse(day + 'T16:00:00Z') - mins * 60000).toISOString();
}

let taskTableReady = false;
function taskTable() {
  const { db } = require('../db/database');
  if (!taskTableReady) {
    db.exec(`CREATE TABLE IF NOT EXISTS unknown_number_tasks (
      number_last8 TEXT NOT NULL,
      day          TEXT NOT NULL,
      task_id      TEXT,
      created_at   INTEGER DEFAULT (strftime('%s', 'now')),
      PRIMARY KEY (number_last8, day)
    )`);
    taskTableReady = true;
  }
  return db;
}

async function createUnknownNumberTask({ phone, call }) {
  const min = config.twenty.unknownNumberMinSec;
  if (min < 0) return null;
  if (!call || (Number(call.duration_sec) || 0) < min) return null;
  const l8 = last8(phone);
  if (l8.length < 8) return null;
  const when = new Date(call.started_at || call.ended_at || Date.now());
  const at = isNaN(when) ? new Date() : when;
  const day = cphDay(at);
  const db = taskTable();
  if (db.prepare('SELECT 1 FROM unknown_number_tasks WHERE number_last8 = ? AND day = ?').get(l8, day)) return null;

  const id = uuidv5(`unknown:${l8}:${day}`);
  const dir = call.direction === 'outgoing' ? 'Udgående' : 'Indgående';
  const body = {
    id,
    title: `Ukendt nummer: ${M.visNummer(phone)} – opret/kobl kontakt`,
    status: M.TASK_STATUS_TODO,
    dueAt: cph1600(day),
    bodyV2: {
      markdown: `${dir} opkald kl. ${cphTime(at)} (${Math.round(Number(call.duration_sec) || 0)} sek.) fra/til ${M.visNummer(phone)}, som ikke findes i Twenty.\n\n`
        + 'Opret eller kobl kontakten inden for 7 dage, så bliver opkaldet transskriberet og lagt på kontakten. Ellers slettes det (GDPR).',
    },
  };
  if (config.twenty.unknownNumberAssigneeId) body.assigneeId = config.twenty.unknownNumberAssigneeId;
  const r = await client.post(`/${OBJECTS.task}`, body);
  if (r.ok || isDuplicate(r)) {
    db.prepare('INSERT OR IGNORE INTO unknown_number_tasks (number_last8, day, task_id) VALUES (?, ?, ?)').run(l8, day, id);
    if (r.ok) console.log('[Twenty] Opgave oprettet for ukendt nummer …' + l8.slice(-4));
    return id;
  }
  return null;
}

// ------------------------------------------------------------
// GDPR: tøm transskript på samtaler med kilde=DIALER ældre end 12 mdr.
// Markøren (system_state) sørger for, at hver samtale kun tjekkes én gang.
// ------------------------------------------------------------
async function purgeOldTranscripts({ state, months = 12, pageSize = 50, now = new Date() }) {
  const S = M.SAMTALE;
  const cutoff = new Date(now);
  cutoff.setMonth(cutoff.getMonth() - months);
  const KEY = 'twenty_transcript_purge_from';
  let from = state.get(KEY);
  let emptied = 0;
  let checked = 0;
  for (let page = 0; page < 20; page++) {
    if (isPaused()) break;
    const cond = [`${S.kilde}[eq]:${client.q(M.KILDE.DIALER)}`, `${S.dato}[lt]:${client.q(cutoff.toISOString())}`];
    if (from) cond.push(`${S.dato}[gte]:${client.q(from)}`);
    const r = await client.get(`/${OBJECTS.samtale}?${filterParam(`and(${cond.join(',')})`)}&orderBy=${enc(S.dato + '[AscNullsLast]')}&limit=${pageSize}`);
    if (!r.ok || !Array.isArray(r.data)) break;
    let last = null;
    for (const s of r.data) {
      checked++;
      const md = s[S.transskript] && s[S.transskript].markdown;
      if (md) {
        const p = await client.patch(`/${OBJECTS.samtale}/${s.id}`, { [S.transskript]: { markdown: '', blocknote: null } });
        if (!p.ok) { last = null; break; }
        emptied++;
      }
      last = s[S.dato];
    }
    if (!last) break;
    // Næste side starter ved sidste dato (samme dato tjekkes igen, men er allerede tom)
    if (from === last && r.data.length >= pageSize) break; // undgå løkke ved mange med samme tidsstempel
    from = last;
    state.set(KEY, from);
    if (r.data.length < pageSize) break;
  }
  if (emptied) console.log('[Twenty] Tømte transskript på ' + emptied + ' samtaler (>' + months + ' mdr.)');
  return { emptied, checked };
}

function _resetCaches() {
  bookerCache = { at: 0, list: null };
}

module.exports = {
  name: 'twenty',
  label: LABEL,
  cols,
  isPaused,
  enabled: client.enabled,
  search: searchPersonByPhone,
  getLinks,
  fromDb: (v) => v,
  searchPersonByPhone,
  upsertCallRecord,
  completeCallRecord,
  autofill,
  afterAnalysis,
  upsertSms,
  upsertRelatelNote,
  getContactForRelatel,
  createUnknownNumberTask,
  purgeOldTranscripts,
  // til tests og backfill
  buildSignals,
  buildTwentyBlock,
  buildResume,
  personHasNumber,
  findMoedebooker,
  bookerForRow,
  uuidv5,
  cph1600,
  callExternalId,
  _resetCaches,
};
