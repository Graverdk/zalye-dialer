// ============================================================
// Telefonopslag i Pipedrive med cache i SQLite (tabellen phone_lookups,
// nøglet på de sidste 8 cifre som i searchPersonByPhone). Cachen overlever
// genstart og deploy.
//
// - Match caches i 10 min.
// - "Ingen match" caches i 24 timer: højst ét opslag pr. ukendt nummer pr.
//   døgn. Et nyt opkald efter de 24 timer giver et frisk opslag.
// - Rækken ryddes/overskrives, når nummeret matches (her eller via
//   click-to-call fra Pipedrive).
// - 401, 429, netværks- og andre fejl er IKKE "ingen match" og caches
//   aldrig. Opslaget udskydes i stedet.
// - Højst 25 opslag pr. kørsel. Resten udskydes til næste kørsel, så en
//   indhentning efter nedetid ikke bliver en løkke mod Pipedrive.
// ============================================================
const runStats = require('./runStats');

const POSITIVE_TTL_MS = 10 * 60 * 1000;
const NEGATIVE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_LOOKUPS_PER_RUN = 25;
const CACHE_HIT_LOG_MS = 60 * 60 * 1000;

function last8(phone) {
  return String(phone || '').replace(/\D/g, '').slice(-8);
}

function createPhoneLookupCache({
  db,
  search,              // async (phone) => { status: 'found'|'none'|'error', person }
  getDeals,            // async (personId) => { latestDealId }
  isPaused = () => false,
  stats = runStats.current,
  now = Date.now,
  positiveTtlMs = POSITIVE_TTL_MS,
  negativeTtlMs = NEGATIVE_TTL_MS,
  maxLookupsPerRun = MAX_LOOKUPS_PER_RUN,
  log = console,
}) {
  db.exec(`CREATE TABLE IF NOT EXISTS phone_lookups (
    number_last8   TEXT PRIMARY KEY,
    person_id      INTEGER,
    latest_deal_id INTEGER,
    checked_at     INTEGER NOT NULL,
    first_miss_at  INTEGER
  )`);
  const getRow = db.prepare('SELECT * FROM phone_lookups WHERE number_last8 = ?');
  const putNone = db.prepare(`INSERT INTO phone_lookups (number_last8, person_id, latest_deal_id, checked_at, first_miss_at)
    VALUES (?, NULL, NULL, ?, ?)
    ON CONFLICT(number_last8) DO UPDATE SET
      person_id = NULL, latest_deal_id = NULL, checked_at = excluded.checked_at,
      first_miss_at = COALESCE(phone_lookups.first_miss_at, excluded.first_miss_at)`);
  const putMatch = db.prepare(`INSERT INTO phone_lookups (number_last8, person_id, latest_deal_id, checked_at, first_miss_at)
    VALUES (?, ?, ?, ?, NULL)
    ON CONFLICT(number_last8) DO UPDATE SET
      person_id = excluded.person_id, latest_deal_id = excluded.latest_deal_id,
      checked_at = excluded.checked_at, first_miss_at = NULL`);
  const del = db.prepare('DELETE FROM phone_lookups WHERE number_last8 = ?');
  const hitLoggedAt = new Map();

  function deferred(s, reason) {
    s.deferred++;
    return { personId: null, latestDealId: null, deferred: true, reason };
  }

  async function lookup(phoneNumber) {
    const key = last8(phoneNumber);
    if (key.length < 8) return null;
    const s = stats();
    const t = now();
    const row = getRow.get(key);

    if (row && row.person_id && t - row.checked_at < positiveTtlMs) {
      return { personId: row.person_id, latestDealId: row.latest_deal_id };
    }
    if (row && !row.person_id && t - row.checked_at < negativeTtlMs) {
      s.cacheHits++;
      if (t - (hitLoggedAt.get(key) || 0) >= CACHE_HIT_LOG_MS) {
        hitLoggedAt.set(key, t);
        const ago = t - row.checked_at;
        const agoText = ago < 60 * 60 * 1000 ? Math.round(ago / 60000) + ' min' : Math.round(ago / 3600000) + ' t';
        log.log('[Pipedrive] Cache: ingen match for …' + key.slice(-4) + ' (tjekket for ' + agoText + ' siden) — springer opslag over');
      }
      return null;
    }

    if (s.stopPipedrive || isPaused()) return deferred(s, 'pause');
    if (s.lookups >= maxLookupsPerRun) return deferred(s, 'loft');

    s.lookups++;
    const result = await search(phoneNumber);
    if (!result || result.status === 'error') return deferred(s, 'fejl'); // aldrig cachet som "ingen match"
    if (result.status === 'none') {
      putNone.run(key, t, t);
      return null;
    }
    const { latestDealId = null } = (await getDeals(result.person.id)) || {};
    putMatch.run(key, result.person.id, latestDealId, t);
    return { personId: result.person.id, latestDealId };
  }

  // Nummeret er koblet til en person et andet sted (fx click-to-call fra Pipedrive)
  function remember(phoneNumber, personId, latestDealId = null) {
    const key = last8(phoneNumber);
    if (key.length < 8 || !personId) return;
    putMatch.run(key, personId, latestDealId, now());
  }

  function forget(phoneNumber) {
    const key = last8(phoneNumber);
    if (key.length < 8) return;
    del.run(key);
    hitLoggedAt.delete(key);
  }

  return { lookup, remember, forget };
}

module.exports = { createPhoneLookupCache, last8, POSITIVE_TTL_MS, NEGATIVE_TTL_MS, MAX_LOOKUPS_PER_RUN };
