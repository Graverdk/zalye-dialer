// ============================================================
// CRM-laget. Jobbet (src/jobs/pollCalls.js) taler kun med dette modul.
//
// CRM_MODE (src/config.js):
//   pipedrive (standard) — primary = Pipedrive, ingen skygge. Som før.
//   dual                 — primary = Pipedrive, shadow = Twenty. Skyggen
//                          kører EFTER Pipedrive, i shadowRun(), der fanger
//                          alle fejl — Twenty kan aldrig blokere Pipedrive.
//                          Mangler TWENTY_API_KEY, slås skyggen fra.
//   twenty               — primary = Twenty, ingen skygge. Pipedrive røres ikke.
//
// Begge adaptere har samme grænseflade:
//   name, label, cols            DB-kolonnerne for person/deal/record i SQLite
//   isPaused()                   rate-limit-pause (vagt pr. CRM)
//   search(phone), getLinks()    telefonopslag (bruges af cachen herunder)
//   upsertCallRecord({row, match})                    → id | null
//   completeCallRecord({row, match, callData, transcript}) → { recordId, created } | null
//   autofill({match, analysis, coaching, row})        → { changes, personName, dealTitle, … }
//   afterAnalysis({recordId, match, analysis, autofill}) → antal signaler | null   (kun Twenty)
//   upsertSms({row, match})                           → { recordId, noteId? }
//   upsertRelatelNote({note, match})                  → id | null
//   getContactForRelatel(phone)  → { status:'found'|'none'|'error', name, company, email }
//   createUnknownNumberTask({phone, call})            → id | null           (kun Twenty)
// match = { personId, latestDealId, companyId?, onboardingId? }
// ============================================================
const config = require('../config');
const pipedrive = require('./pipedrive');
const twenty = require('./twenty');
const { createPhoneLookupCache } = require('../services/phoneLookupCache');

const mode = config.crm.mode;
const twentyReady = twenty.enabled();

if (mode === 'dual' && !twentyReady) {
  console.warn('[CRM] CRM_MODE=dual, men TWENTY_API_KEY mangler — Twenty-skyggen er slået fra, Pipedrive kører som før');
}

const primary = mode === 'twenty' ? twenty : pipedrive;
const shadow = mode === 'dual' && twentyReady ? twenty : null;
const twentyActive = primary === twenty || shadow === twenty;

// Én telefon-cache pr. CRM (phone_lookups nøglet på (crm, sidste 8 cifre))
const caches = {};
function cacheFor(adapter) {
  if (!caches[adapter.name]) {
    const { db } = require('../db/database');
    caches[adapter.name] = createPhoneLookupCache({
      db,
      crm: adapter.name,
      label: adapter.label,
      search: (phone) => adapter.search(phone),
      getDeals: (personId, person) => adapter.getLinks(personId, person),
      isPaused: () => adapter.isPaused(),
      ...(adapter.fromDb ? { fromDb: adapter.fromDb } : {}),
    });
  }
  return caches[adapter.name];
}

function lookup(adapter, phone) {
  return cacheFor(adapter).lookup(phone);
}

function remember(adapter, phone, personId, latestDealId, extra) {
  return cacheFor(adapter).remember(phone, personId, latestDealId, extra);
}

// Kør et skridt i skyggen (dual). Fejl logges og sluges; pause = spring over.
async function shadowRun(label, fn) {
  if (!shadow) return null;
  if (shadow.isPaused()) return null;
  try {
    return await fn(shadow);
  } catch (e) {
    console.error('[Twenty-skygge] ' + label + ' fejlede (Pipedrive påvirkes ikke): ' + e.message);
    return null;
  }
}

// Kolonne → værdi for et match (bruges til UPDATE i calls/messages)
function matchColumns(adapter, match) {
  const c = adapter.cols;
  const out = {};
  out[c.person] = match.personId ?? null;
  if (c.deal) out[c.deal] = match.latestDealId ?? null;
  if (c.company) out[c.company] = match.companyId ?? null;
  if (c.onboarding) out[c.onboarding] = match.onboardingId ?? null;
  return out;
}

// Et match ud fra det, der allerede står i rækken
function matchFromRow(adapter, row) {
  const c = adapter.cols;
  if (!row || !row[c.person]) return null;
  const m = { personId: row[c.person], latestDealId: (c.deal && row[c.deal]) || null };
  if (c.company && row[c.company]) m.companyId = row[c.company];
  if (c.onboarding && row[c.onboarding]) m.onboardingId = row[c.onboarding];
  return m;
}

// Har rækken allerede en post i adapterens CRM?
function hasRecord(adapter, row) {
  if (!row) return false;
  const c = adapter.cols;
  return !!(row[c.record] || (c.legacyNote && row[c.legacyNote]));
}

module.exports = {
  mode,
  primary,
  shadow,
  twentyActive,
  adapters: { pipedrive, twenty },
  lookup,
  remember,
  shadowRun,
  matchColumns,
  matchFromRow,
  hasRecord,
};
