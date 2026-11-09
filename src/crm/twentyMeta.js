// ============================================================
// Twentys metadata (felter og option-værdier pr. objekt), hentet fra
// GET /rest/metadata/objects og cachet i 6 timer.
//
// Bruges til to ting:
// 1) clean(): før en skrivning droppes felter, der ikke findes på objektet,
//    og SELECT/MULTI_SELECT-værdier, der ikke er en gyldig option. Så kan
//    et forkert navn i twentyMapping.js aldrig få Twenty til at afvise hele
//    samtalen — feltet bliver bare tomt, og loggen siger hvilket.
// 2) matchOption(): autofill af systemer (driftssystem, regnskabsprogram,
//    lønprogram) og fag matches mod Twentys egne options, som Pipedrive-
//    autofill gør i dag. Uden metadata udfyldes de felter ikke.
//
// Kan metadata ikke hentes, sendes felterne som de er (clean() er så en
// no-op), og matchOption() giver kun de faste værdier fra mappingen.
// ============================================================
const client = require('./twentyClient');
const { norm } = require('./twentyMapping');

const TTL_MS = 6 * 3600 * 1000;
const RETRY_MS = 10 * 60 * 1000;

let cache = null;        // { at, objects: Map(plural → Map(fieldName → field)) }
let lastFailAt = 0;
const warned = new Set();

function warnOnce(key, msg) {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn('[Twenty] ' + msg);
}

function fieldList(obj) {
  const f = obj && obj.fields;
  if (Array.isArray(f)) return f;
  if (f && Array.isArray(f.edges)) return f.edges.map((e) => e.node).filter(Boolean);
  return null;
}

async function load({ force = false } = {}) {
  const now = Date.now();
  if (!force && cache && now - cache.at < TTL_MS) return cache;
  if (!force && !cache && now - lastFailAt < RETRY_MS) return null;
  const res = await client.get('/metadata/objects?limit=200');
  const list = Array.isArray(res.data) ? res.data : null;
  if (!res.ok || !list) {
    lastFailAt = now;
    if (res.status !== 503) warnOnce('meta-fail', 'Kunne ikke hente metadata — felter og options sendes uden tjek');
    return cache; // evt. en ældre udgave
  }
  const objects = new Map();
  for (const o of list) {
    const fields = fieldList(o);
    if (!fields) continue;
    const m = new Map();
    for (const f of fields) if (f && f.name) m.set(f.name, f);
    if (o.namePlural) objects.set(o.namePlural, m);
    if (o.nameSingular) objects.set(o.nameSingular, m);
  }
  cache = { at: now, objects };
  return cache;
}

function fieldsOf(objPlural) {
  return cache && cache.objects.get(objPlural) || null;
}

function optionValues(field) {
  return (field && Array.isArray(field.options) ? field.options : []).map((o) => o && o.value).filter(Boolean);
}

// Relationsfelter skrives som <navn>Id, men hedder <navn> i metadata
function lookupField(fields, key) {
  if (fields.has(key)) return fields.get(key);
  if (key.endsWith('Id') && fields.has(key.slice(0, -2))) return fields.get(key.slice(0, -2));
  return null;
}

function clean(objPlural, record) {
  const fields = fieldsOf(objPlural);
  if (!fields || !record) return record;
  const out = {};
  for (const [key, value] of Object.entries(record)) {
    if (key === 'id') { out[key] = value; continue; }
    const f = lookupField(fields, key);
    if (!f) {
      warnOnce(objPlural + '.' + key, `Ukendt felt ${objPlural}.${key} — springes over (ret twentyMapping.js)`);
      continue;
    }
    if (value === null || value === undefined) { out[key] = value; continue; }
    if (f.type === 'SELECT') {
      const opts = optionValues(f);
      if (opts.length && !opts.includes(value)) {
        warnOnce(objPlural + '.' + key + '=' + value, `Ukendt option ${objPlural}.${key}=${value} — springes over (ret twentyMapping.js)`);
        continue;
      }
    } else if (f.type === 'MULTI_SELECT') {
      const opts = optionValues(f);
      const arr = Array.isArray(value) ? value : [value];
      const ok = opts.length ? arr.filter((v) => opts.includes(v)) : arr;
      for (const v of arr) if (!ok.includes(v)) warnOnce(objPlural + '.' + key + '=' + v, `Ukendt option ${objPlural}.${key}=${v} — springes over (ret twentyMapping.js)`);
      if (arr.length && !ok.length) continue;
      out[key] = ok;
      continue;
    }
    out[key] = value;
  }
  return out;
}

function fieldType(objPlural, name) {
  const fields = fieldsOf(objPlural);
  const f = fields && lookupField(fields, name);
  return f ? f.type : null;
}

// Et ord fra analysen (fx "Apacta", "e-conomic", "Excel") → en gyldig option-værdi.
// preferred = fast værdi fra mappingen, der bruges hvis den findes blandt options.
const SYNONYMS = { excel: 'manuelt', papir: 'manuelt', manuel: 'manuelt', regneark: 'manuelt', ordrestyringdk: 'ordrestyring' };
function matchOption(objPlural, fieldName, raw, preferred = null) {
  const fields = fieldsOf(objPlural);
  const f = fields && lookupField(fields, fieldName);
  if (!f) return null;
  const opts = (Array.isArray(f.options) ? f.options : []).filter((o) => o && o.value);
  if (!opts.length) return null;
  if (preferred && opts.some((o) => o.value === preferred)) return preferred;
  if (!raw) return null;
  const v = norm(raw);
  if (v.length < 2) return null;
  const target = SYNONYMS[v] || v;
  const exact = opts.find((o) => norm(o.label) === target || norm(o.value) === target);
  if (exact) return exact.value;
  if (target.length < 4) return null;
  const partial = opts.filter((o) => {
    const l = norm(o.label);
    return l.includes(target) || target.includes(l);
  });
  return partial.length === 1 ? partial[0].value : null;
}

function _set(objects) {
  cache = { at: Date.now(), objects: new Map(Object.entries(objects).map(([k, v]) => [k, new Map(v.map((f) => [f.name, f]))])) };
}
function _reset() {
  cache = null;
  lastFailAt = 0;
  warned.clear();
}

module.exports = { load, clean, matchOption, fieldType, optionValues, _set, _reset };
