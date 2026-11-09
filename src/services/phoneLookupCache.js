// ============================================================
// Telefonopslag i et CRM med cache i SQLite (tabellen phone_lookups,
// nøglet på (crm, sidste 8 cifre)). Cachen overlever genstart og deploy,
// og Pipedrive og Twenty har hver sine rækker.
//
// - Match caches i 10 min.
// - "Ingen match" caches i 24 timer: højst ét opslag pr. ukendt nummer pr.
//   døgn pr. CRM. Et nyt opkald efter de 24 timer giver et frisk opslag.
// - Rækken ryddes/overskrives, når nummeret matches (her eller via
//   click-to-call).
// - 401, 429, netværks- og andre fejl er IKKE "ingen match" og caches
//   aldrig. Opslaget udskydes i stedet.
// - Højst 25 opslag pr. kørsel pr. CRM. Resten udskydes til næste kørsel,
//   så en indhentning efter nedetid ikke bliver en løkke mod CRM'et.
//
// Id'er gemmes som TEXT (Twenty bruger UUID). Pipedrive-adapteren giver
// en fromDb, der laver dem om til tal igen, så Pipedrive-flowet er uændret.
// ============================================================
const runStats = require('./runStats');

const POSITIVE_TTL_MS = 10 * 60 * 1000;
const NEGATIVE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_LOOKUPS_PER_RUN = 25;
const CACHE_HIT_LOG_MS = 60 * 60 * 1000;

function last8(phone) {
  return String(phone || '').replace(/\D/g, '').slice(-8);
}

// Tællernavne i runStats pr. CRM (Pipedrive beholder de oprindelige navne)
const STAT_KEYS = {
  pipedrive: { lookups: 'lookups', deferred: 'deferred', cacheHits: 'cacheHits', stop: 'stopPipedrive' },
  twenty: { lookups: 'twentyLookups', deferred: 'twentyDeferred', cacheHits: 'twentyCacheHits', stop: 'stopTwenty' },
};

// Før 11/2026 var tabellen nøglet på number_last8 alene med INTEGER-id'er.
// Den flyttes til (crm, number_last8) med TEXT-id'er; gamle rækker er Pipedrive.
function ensureTable(db) {
  const cols = db.prepare('PRAGMA table_info(phone_lookups)').all();
  const create = (name) => db.exec(`CREATE TABLE IF NOT EXISTS ${name} (
    crm            TEXT NOT NULL DEFAULT 'pipedrive',
    number_last8   TEXT NOT NULL,
    person_id      TEXT,
    latest_deal_id TEXT,
    company_id     TEXT,
    onboarding_id  TEXT,
    checked_at     INTEGER NOT NULL,
    first_miss_at  INTEGER,
    PRIMARY KEY (crm, number_last8)
  )`);
  if (cols.length === 0) {
    create('phone_lookups');
    return;
  }
  if (cols.some((c) => c.name === 'crm')) return;
  db.transaction(() => {
    create('phone_lookups_v2');
    db.exec(`INSERT INTO phone_lookups_v2 (crm, number_last8, person_id, latest_deal_id, checked_at, first_miss_at)
      SELECT 'pipedrive', number_last8, CAST(person_id AS TEXT), CAST(latest_deal_id AS TEXT), checked_at, first_miss_at
      FROM phone_lookups`);
    db.exec('DROP TABLE phone_lookups');
    db.exec('ALTER TABLE phone_lookups_v2 RENAME TO phone_lookups');
  })();
  console.log('[DB] phone_lookups flyttet til nøglen (crm, number_last8)');
}

// Pipedrive-id'er er heltal — som TEXT i cachen, som tal i resten af koden
const pipedriveId = (v) => (v === null || v === undefined ? null : (/^\d+$/.test(String(v)) ? Number(v) : v));
const asText = (v) => (v === null || v === undefined || v === '' ? null : String(v));

function createPhoneLookupCache({
  db,
  crm = 'pipedrive',
  label = crm === 'twenty' ? 'Twenty' : 'Pipedrive',
  search,              // async (phone) => { status: 'found'|'none'|'error', person }
  getDeals,            // async (personId, person) => { latestDealId, companyId?, onboardingId? }
  isPaused = () => false,
  fromDb = crm === 'pipedrive' ? pipedriveId : (v) => v, // id fra DB (TEXT) → adapterens id-type
  stats = runStats.current,
  now = Date.now,
  positiveTtlMs = POSITIVE_TTL_MS,
  negativeTtlMs = NEGATIVE_TTL_MS,
  maxLookupsPerRun = MAX_LOOKUPS_PER_RUN,
  log = console,
}) {
  ensureTable(db);
  const keys = STAT_KEYS[crm] || STAT_KEYS.pipedrive;
  const getRow = db.prepare('SELECT * FROM phone_lookups WHERE crm = ? AND number_last8 = ?');
  const putNone = db.prepare(`INSERT INTO phone_lookups (crm, number_last8, person_id, latest_deal_id, company_id, onboarding_id, checked_at, first_miss_at)
    VALUES (?, ?, NULL, NULL, NULL, NULL, ?, ?)
    ON CONFLICT(crm, number_last8) DO UPDATE SET
      person_id = NULL, latest_deal_id = NULL, company_id = NULL, onboarding_id = NULL,
      checked_at = excluded.checked_at,
      first_miss_at = COALESCE(phone_lookups.first_miss_at, excluded.first_miss_at)`);
  const putMatch = db.prepare(`INSERT INTO phone_lookups (crm, number_last8, person_id, latest_deal_id, company_id, onboarding_id, checked_at, first_miss_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
    ON CONFLICT(crm, number_last8) DO UPDATE SET
      person_id = excluded.person_id, latest_deal_id = excluded.latest_deal_id,
      company_id = excluded.company_id, onboarding_id = excluded.onboarding_id,
      checked_at = excluded.checked_at, first_miss_at = NULL`);
  const del = db.prepare('DELETE FROM phone_lookups WHERE crm = ? AND number_last8 = ?');
  const hitLoggedAt = new Map();

  function deferred(s, reason) {
    s[keys.deferred] = (s[keys.deferred] || 0) + 1;
    return { personId: null, latestDealId: null, deferred: true, reason };
  }

  // Pipedrive giver præcis { personId, latestDealId } som før; Twenty også virksomhed/onboarding
  function toMatch(row) {
    const m = { personId: fromDb(row.person_id), latestDealId: fromDb(row.latest_deal_id) };
    if (row.company_id != null) m.companyId = row.company_id;
    if (row.onboarding_id != null) m.onboardingId = row.onboarding_id;
    return m;
  }

  async function lookup(phoneNumber) {
    const key = last8(phoneNumber);
    if (key.length < 8) return null;
    const s = stats();
    const t = now();
    const row = getRow.get(crm, key);

    if (row && row.person_id && t - row.checked_at < positiveTtlMs) {
      return toMatch(row);
    }
    if (row && !row.person_id && t - row.checked_at < negativeTtlMs) {
      s[keys.cacheHits] = (s[keys.cacheHits] || 0) + 1;
      if (t - (hitLoggedAt.get(key) || 0) >= CACHE_HIT_LOG_MS) {
        hitLoggedAt.set(key, t);
        const ago = t - row.checked_at;
        const agoText = ago < 60 * 60 * 1000 ? Math.round(ago / 60000) + ' min' : Math.round(ago / 3600000) + ' t';
        log.log('[' + label + '] Cache: ingen match for …' + key.slice(-4) + ' (tjekket for ' + agoText + ' siden) — springer opslag over');
      }
      return null;
    }

    if (s[keys.stop] || isPaused()) return deferred(s, 'pause');
    if ((s[keys.lookups] || 0) >= maxLookupsPerRun) return deferred(s, 'loft');

    s[keys.lookups] = (s[keys.lookups] || 0) + 1;
    const result = await search(phoneNumber);
    if (!result || result.status === 'error') return deferred(s, 'fejl'); // aldrig cachet som "ingen match"
    if (result.status === 'none') {
      putNone.run(crm, key, t, t);
      return null;
    }
    const links = (await getDeals(result.person.id, result.person)) || {};
    const row2 = {
      person_id: asText(result.person.id),
      latest_deal_id: asText(links.latestDealId),
      company_id: asText(links.companyId),
      onboarding_id: asText(links.onboardingId),
    };
    putMatch.run(crm, key, row2.person_id, row2.latest_deal_id, row2.company_id, row2.onboarding_id, t);
    return toMatch(row2);
  }

  // Nummeret er koblet til en person et andet sted (fx click-to-call)
  function remember(phoneNumber, personId, latestDealId = null, extra = {}) {
    const key = last8(phoneNumber);
    if (key.length < 8 || !personId) return;
    putMatch.run(crm, key, asText(personId), asText(latestDealId), asText(extra.companyId), asText(extra.onboardingId), now());
  }

  function forget(phoneNumber) {
    const key = last8(phoneNumber);
    if (key.length < 8) return;
    del.run(crm, key);
    hitLoggedAt.delete(key);
  }

  return { lookup, remember, forget, crm };
}

module.exports = { createPhoneLookupCache, last8, POSITIVE_TTL_MS, NEGATIVE_TTL_MS, MAX_LOOKUPS_PER_RUN };
