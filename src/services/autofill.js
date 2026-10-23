const { fetch } = require('./pipedriveGuard'); // pause ved 401/429 som resten af Pipedrive-kaldene
const config = require('../config');

// ============================================================
// Udfylder TOMME felter i Pipedrive ud fra opkaldsanalysen.
// Jeppes regel (okt 2026): agenten må selv udfylde tomme felter
// (systemer, antal ansatte, fag). Næste aktivitet, trinskift og
// opfølgningsmail kræver hans ja — dem laver Salgscoach-appen som
// forslag med en knap. Eksisterende værdier overskrives ALDRIG.
// Felterne findes via deres navn i Pipedrive (ikke hårdkodede nøgler),
// og valgmuligheder matches på tekst — er der ikke et sikkert match,
// springes feltet over.
// ============================================================
const BASE = config.pipedrive.baseUrl;
const TOKEN = config.pipedrive.apiToken;
const GET_HEADERS = { 'x-api-token': TOKEN, Accept: 'application/json' };
const JSON_HEADERS = { 'x-api-token': TOKEN, 'Content-Type': 'application/json' };

async function get(path) {
  const res = await fetch(`${BASE}${path}`, { headers: GET_HEADERS });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Pipedrive ${res.status} på ${path}`);
  return data?.data;
}
async function put(path, body) {
  const res = await fetch(`${BASE}${path}`, { method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Pipedrive ${res.status} på ${path}: ${JSON.stringify(data).slice(0, 200)}`);
  return data?.data;
}

// Feltdefinitioner caches i 6 timer
const FIELDS_TTL = 6 * 3600 * 1000;
const fieldCache = {};
async function fields(kind) {
  const c = fieldCache[kind];
  if (c && Date.now() - c.at < FIELDS_TTL) return c.list;
  const list = (await get(`/${kind}Fields?limit=500`)) || [];
  fieldCache[kind] = { at: Date.now(), list };
  return list;
}
const byName = (list, name) => list.find((f) => String(f.name).trim().toLowerCase() === name.toLowerCase());

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9æøå]/g, '');
// Ord fra analysen → tekst på valgmuligheden i Pipedrive
const SYNONYMS = {
  excel: 'manuelt', papir: 'manuelt', manuel: 'manuelt', regneark: 'manuelt',
  ordrestyring: 'ordrestyringdk', ekomplet: 'ekomplet', economic: 'economic', dataløn: 'datalønvisma',
  tømrer: 'almtømre', tømrersnedker: 'almtømre', snedker: 'almtømre', murer: 'mure', el: 'elinstallation',
  elektriker: 'elinstallation', vinduespudser: 'vinduespolering', gulv: 'gulve', gulvlægger: 'gulve',
  entreprenør: 'entreprise', kloakentreprenør: 'entreprise', tagrens: 'tagmalingtagrens', tagmaling: 'tagmalingtagrens',
  anlæg: 'anlægsgartner', anlæghave: 'anlægsgartner', have: 'haveservice',
};
function matchOption(options, value) {
  if (!value || !Array.isArray(options)) return null;
  const v = norm(value);
  if (v.length < 2) return null;
  const target = SYNONYMS[v] || v;
  const exact = options.find((o) => norm(o.label) === target);
  if (exact) return exact;
  // Delvist match kun på længere ord, og kun hvis det er entydigt
  if (target.length < 4) return null;
  const partial = options.filter((o) => norm(o.label).includes(target) || target.includes(norm(o.label)));
  return partial.length === 1 ? partial[0] : null;
}
const isEmpty = (v) => v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);

const ROLE_MAP = { 'ejer/direktør': 'Ejer', 'formand/projektleder': 'Projektleder', 'kontor/administration': 'Assisten' };

async function autofillFromCall({ personId, dealId, analysis }) {
  const changes = [];
  const result = { changes, personName: null, dealTitle: null };
  if (!analysis || !personId) return result;
  const p = analysis.profile || {};
  const j = analysis.journey || {};

  const person = await get(`/persons/${personId}`);
  result.personName = person?.name || null;
  const orgId = person?.org_id?.value || person?.org_id || null;

  // ---- Organisation: antal ansatte, fag og systemer ----
  if (orgId) {
    const [org, orgFields] = [await get(`/organizations/${orgId}`), await fields('organization')];
    const upd = {};
    const set = (felt, key, value, label) => { upd[key] = value; changes.push({ felt, vaerdi: label ?? String(value) }); };
    if (isEmpty(org.employee_count) && Number.isInteger(p.antalMedarbejdere) && p.antalMedarbejdere > 0) {
      set('Antal ansatte', 'employee_count', p.antalMedarbejdere);
    }
    const enumField = (felt, name, value) => {
      const f = byName(orgFields, name);
      if (!f || !isEmpty(org[f.key])) return;
      const opt = matchOption(f.options, value);
      if (opt) set(felt, f.key, f.field_type === 'set' ? String(opt.id) : opt.id, opt.label);
    };
    enumField('Fag', 'Primary Industry', p.faggruppe);
    enumField('Driftssystem', 'Drift system de bruger idag', p.driftssystem);
    enumField('Regnskabsprogram', 'Regnskabsprogram', p.regnskabsprogram);
    enumField('Lønprogram', 'Lønprogram', p.loenprogram);
    if (Object.keys(upd).length) await put(`/organizations/${orgId}`, upd);
  }

  // ---- Person: rolle ----
  const roleLabel = ROLE_MAP[j.kontaktRolle];
  if (roleLabel) {
    const f = byName(await fields('person'), 'Role');
    if (f && isEmpty(person[f.key])) {
      const opt = (f.options || []).find((o) => o.label === roleLabel);
      if (opt) { await put(`/persons/${personId}`, { [f.key]: opt.id }); changes.push({ felt: 'Rolle', vaerdi: opt.label }); }
    }
  }

  // ---- Deal: anledning og indvending (tekstfelter) ----
  if (dealId) {
    const [deal, dealFields] = [await get(`/deals/${dealId}`), await fields('deal')];
    result.dealTitle = deal?.title || null;
    const upd = {};
    const fAnl = byName(dealFields, 'Anledning');
    if (fAnl && isEmpty(deal[fAnl.key]) && j.anledning) {
      upd[fAnl.key] = j.anledning;
      changes.push({ felt: 'Anledning', vaerdi: j.anledning });
    }
    const fInd = byName(dealFields, 'Indvending');
    const objections = Array.isArray(analysis.objections) ? analysis.objections : [];
    if (fInd && isEmpty(deal[fInd.key]) && objections.length) {
      upd[fInd.key] = objections.join('; ');
      changes.push({ felt: 'Indvending', vaerdi: objections.join('; ') });
    }
    if (Object.keys(upd).length) await put(`/deals/${dealId}`, upd);
  }
  return result;
}

module.exports = { autofillFromCall, matchOption };
