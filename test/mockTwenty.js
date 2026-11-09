// ============================================================
// Et lille Twenty i hukommelsen til tests. Erstatter fetch i Twenty-vagten
// (client.guard._setFetch), så INGEN test kalder crm.zalye.si.
// Forstår de REST-former, dialeren bruger: lister med filter=, hent/ret én,
// opret, batch og metadata. Svarformen følger Twenty: { data: { <navn>: … } }.
// ============================================================
const realFetch = require('node-fetch');

const SINGULAR = {
  people: 'person', companies: 'company', opportunities: 'opportunity', tasks: 'task',
  samtaler: 'samtale', signaler: 'signal', onboardinger: 'onboarding', moedebookere: 'moedebooker',
};
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// ---- mini-parser til Twentys filter-syntaks --------------------------
function splitTop(s) {
  const out = []; let depth = 0; let cur = ''; let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"' && s[i - 1] !== '\\') inStr = !inStr;
    if (!inStr && (ch === '(' || ch === '[')) depth++;
    if (!inStr && (ch === ')' || ch === ']')) depth--;
    if (!inStr && ch === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}
function parseValue(v) {
  v = v.trim();
  if (v.startsWith('[')) return splitTop(v.slice(1, -1)).map(parseValue);
  if (v.startsWith('"')) return JSON.parse(v);
  return v;
}
function parseFilter(f) {
  f = f.trim();
  const m = f.match(/^and\((.*)\)$/s);
  if (m) return splitTop(m[1]).map(parseFilter).flat();
  const c = f.match(/^([\w.]+)\[(\w+)\]:(.*)$/s);
  if (!c) throw new Error('mockTwenty: forstår ikke filteret ' + f);
  return [{ field: c[1], op: c[2], value: parseValue(c[3]) }];
}
const getPath = (o, p) => p.split('.').reduce((a, k) => (a == null ? a : a[k]), o);
function matches(rec, conds) {
  return conds.every(({ field, op, value }) => {
    const v = getPath(rec, field);
    switch (op) {
      case 'eq': return v === value;
      case 'neq': return v !== value;
      case 'in': return value.includes(v);
      case 'like': {
        const re = new RegExp('^' + value.split('%').map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
        return v != null && re.test(String(v));
      }
      case 'lt': return v != null && v < value;
      case 'gte': return v != null && v >= value;
      default: throw new Error('mockTwenty: ukendt operator ' + op);
    }
  });
}

function createMockTwenty({ metadata = null } = {}) {
  const db = {};
  for (const k of Object.keys(SINGULAR)) db[k] = new Map();
  const requests = [];
  const failures = []; // { match: (method, path) => bool, status, body, headers, times }
  let seq = 0;
  const newId = () => '00000000-0000-4000-8000-' + String(++seq).padStart(12, '0');

  function add(plural, rec) {
    const r = { id: rec.id || newId(), updatedAt: new Date(Date.now() + seq).toISOString(), ...rec };
    db[plural].set(r.id, r);
    return r;
  }
  function failNext(match, status, { times = 1, body = { messages: ['mock fejl'] }, headers = {} } = {}) {
    failures.push({ match, status, times, body, headers });
  }
  const respond = (status, body, headers = {}) => Promise.resolve(new realFetch.Response(JSON.stringify(body), { status, headers }));

  async function fetch(url, opts = {}) {
    const method = (opts.method || 'GET').toUpperCase();
    const u = new URL(url);
    const path = u.pathname.replace(/^\/rest/, '');
    const body = opts.body ? JSON.parse(opts.body) : undefined;
    requests.push({ method, path, query: Object.fromEntries(u.searchParams), body, auth: opts.headers && opts.headers.Authorization });

    const f = failures.find((x) => x.times > 0 && x.match(method, path));
    if (f) { f.times--; return respond(f.status, f.body, f.headers); }

    if (path === '/metadata/objects') {
      if (!metadata) return respond(404, { messages: ['ikke her'] });
      return respond(200, { data: { objects: metadata } });
    }
    const batch = path.match(/^\/batch\/(\w+)$/);
    if (batch && method === 'POST') {
      const plural = batch[1];
      const created = body.map((r) => add(plural, r));
      return respond(201, { data: { ['create' + cap(plural)]: created } });
    }
    const m = path.match(/^\/(\w+)(?:\/([\w-]+))?$/);
    if (!m || !db[m[1]]) return respond(404, { messages: ['ukendt sti ' + path] });
    const plural = m[1]; const id = m[2]; const sing = SINGULAR[plural];

    if (!id && method === 'GET') {
      let rows = [...db[plural].values()];
      if (u.searchParams.get('filter')) rows = rows.filter((r) => matches(r, parseFilter(u.searchParams.get('filter'))));
      const ob = u.searchParams.get('orderBy');
      if (ob) {
        const [, field, dir] = ob.match(/^(\w+)\[(\w+)\]$/);
        rows.sort((a, b) => (a[field] < b[field] ? -1 : a[field] > b[field] ? 1 : 0) * (dir.startsWith('Desc') ? -1 : 1));
      }
      const limit = parseInt(u.searchParams.get('limit') || '60', 10);
      return respond(200, { data: { [plural]: rows.slice(0, limit) } });
    }
    if (!id && method === 'POST') {
      if (body.id && db[plural].has(body.id)) return respond(400, { messages: ['duplicate key value violates unique constraint'] });
      if (plural === 'samtaler' && body.eksterntId && [...db.samtaler.values()].some((s) => s.eksterntId === body.eksterntId)) {
        return respond(400, { messages: ['duplicate key value violates unique constraint "eksterntId"'] });
      }
      return respond(201, { data: { ['create' + cap(sing)]: add(plural, body) } });
    }
    if (id && method === 'GET') {
      const r = db[plural].get(id);
      return r ? respond(200, { data: { [sing]: r } }) : respond(404, { messages: ['findes ikke'] });
    }
    if (id && method === 'PATCH') {
      const r = db[plural].get(id);
      if (!r) return respond(404, { messages: ['findes ikke'] });
      Object.assign(r, body, { updatedAt: new Date().toISOString() });
      return respond(200, { data: { ['update' + cap(sing)]: r } });
    }
    return respond(405, { messages: ['metode'] });
  }

  const count = (method, prefix) => requests.filter((r) => r.method === method && r.path.startsWith(prefix)).length;
  return { db, add, fetch, requests, failNext, count, reset() { requests.length = 0; failures.length = 0; } };
}

// Metadata svarende til twentyMapping.js (+ options som i planen)
const opt = (...values) => values.map((v) => ({ value: v, label: v }));
function standardMetadata() {
  const f = (name, type = 'TEXT', options) => ({ name, type, ...(options ? { options } : {}) });
  return [
    { nameSingular: 'person', namePlural: 'people', fields: [f('name', 'FULL_NAME'), f('phones', 'PHONES'), f('emails', 'EMAILS'), f('telefon8'), f('company', 'RELATION'), f('rolle', 'SELECT', opt('EJER_DIREKTOER', 'FORMAND_PROJEKTLEDER', 'KONTOR_ADMINISTRATION', 'SERVICE_DRIFTSCHEF', 'IT_OEKONOMI'))] },
    { nameSingular: 'company', namePlural: 'companies', fields: [f('name'), f('employees', 'NUMBER'), f('branche', 'MULTI_SELECT', opt('MALER', 'TOEMRER_SNEDKER', 'ANLAEG_HAVE', 'VVS', 'EL')), f('driftssystem', 'SELECT', [{ value: 'APACTA', label: 'Apacta' }, { value: 'MANUELT', label: 'Manuelt' }]), f('regnskabsprogram', 'SELECT', [{ value: 'E_CONOMIC', label: 'e-conomic' }]), f('lonprogram', 'SELECT', [{ value: 'DANLOEN', label: 'Danløn' }])] },
    { nameSingular: 'opportunity', namePlural: 'opportunities', fields: [f('name'), f('stage', 'SELECT', opt('NY_LEAD', 'KVALIFICERET', 'VENTER_PAA_DEMO_BOOKING', 'DEMO_BOOKET', 'DEMO_HOLDT', 'BESLUTNING', 'VUNDET', 'TABT')), f('company', 'RELATION'), f('pointOfContact', 'RELATION'), f('booketAf', 'RELATION'), f('anledning', 'SELECT', opt('VAEKST', 'UTILFREDS_MED_SYSTEM', 'FEJL_ELLER_TAB', 'EJER_ELLER_LEDERSKIFTE', 'NYSGERRIG_PAA_AI')), f('primaerSmerte', 'SELECT', opt('PLANLAEGNING', 'TILBUD')), f('indvending'), f('konsekvens'), f('konsekvensTimerUge', 'NUMBER')] },
    { nameSingular: 'samtale', namePlural: 'samtaler', fields: [f('name'), f('samtaletype', 'SELECT', opt('OPKALD', 'SMS', 'NOTE')), f('retning', 'SELECT', opt('UD', 'IND')), f('dato', 'DATE_TIME'), f('varighedMin', 'NUMBER'), f('kilde', 'SELECT', opt('DIALER')), f('eksterntId'), f('person', 'RELATION'), f('virksomhed', 'RELATION'), f('salgsmulighed', 'RELATION'), f('onboarding', 'RELATION'), f('fortAf', 'RELATION'), f('moedebooker', 'RELATION'), f('udfald', 'SELECT', opt('IKKE_SVAR', 'MOEDE_BOOKET', 'IKKE_INTERESSERET', 'RING_IGEN', 'FORKERT_NUMMER')), f('modetype', 'SELECT', opt('BOOKING_KALD', 'M1_ANALYSE', 'M2_DEMO', 'OPFOELGNING', 'M4_M7_OPSTART', 'SUPPORT', 'PARTNER')), f('temperatur', 'SELECT', opt('VARM', 'LUN', 'KOLD')), f('blokkeDaekket', 'MULTI_SELECT', opt('ANLEDNING', 'SITUATION', 'SMERTE', 'KONSEKVENS', 'BESLUTNING', 'NAESTE_SKRIDT')), f('resume', 'RICH_TEXT_V2'), f('coachVurdering', 'RICH_TEXT_V2'), f('transskript', 'RICH_TEXT_V2')] },
    { nameSingular: 'signal', namePlural: 'signaler', fields: [f('name'), f('signaltype', 'SELECT', opt('ANLEDNING', 'SMERTE', 'INDVENDING', 'KONKURRENT', 'KUNDENS_ORD')), f('tekst'), f('samtale', 'RELATION'), f('virksomhed', 'RELATION'), f('salgsmulighed', 'RELATION'), f('status', 'SELECT', opt('FORESLAAET', 'GODKENDT', 'AFVIST')), f('forslag', 'SELECT', opt('UDFYLD_FELT')), f('forslagFelt'), f('forslagVaerdi')] },
  ];
}

module.exports = { createMockTwenty, standardMetadata, parseFilter };
