const { tmpDbPath, quiet } = require('./helpers');
const test = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const runStats = require('../src/services/runStats');
const { createPhoneLookupCache, NEGATIVE_TTL_MS, NEGATIVE_FIRST_HOUR_TTL_MS } = require('../src/services/phoneLookupCache');

const NUMBER = '+45 92 82 10 85';

function setup({ results, dbPath = ':memory:', clock, paused = false } = {}) {
  const db = new Database(dbPath);
  const calls = [];
  const queue = [...(results || [])];
  const cache = createPhoneLookupCache({
    db,
    search: async (phone) => { calls.push(phone); return queue.length ? queue.shift() : { status: 'none', person: null }; },
    getDeals: async () => ({ latestDealId: 7 }),
    isPaused: () => paused,
    now: clock ? () => clock.t : Date.now,
    log: quiet,
  });
  return { db, cache, calls };
}

test('"ingen match" caches i 24 timer og slås op igen bagefter', async () => {
  const clock = { t: 1_000_000 };
  const { cache, calls } = setup({ clock });
  await runStats.run('test', async () => {
    assert.strictEqual(await cache.lookup(NUMBER), null);
    clock.t += 2 * 60 * 1000;                       // næste kørsel 2 min efter
    assert.strictEqual(await cache.lookup(NUMBER), null);
    clock.t += NEGATIVE_TTL_MS - 3 * 60 * 1000;     // stadig inden for 24 t
    assert.strictEqual(await cache.lookup(NUMBER), null);
    assert.strictEqual(runStats.current().cacheHits, 2);
  }, { log: quiet });
  assert.strictEqual(calls.length, 1, 'kun ét Pipedrive-opslag inden for TTL');

  clock.t += 2 * 60 * 1000;                         // nu er de 24 t gået
  await runStats.run('test', () => cache.lookup(NUMBER), { log: quiet });
  assert.strictEqual(calls.length, 2, 'nyt opslag efter TTL');
});

for (const status of [401, 429]) {
  test(`fejl (${status}) caches aldrig som "ingen match"`, async () => {
    const { db, cache, calls } = setup({ results: [{ status: 'error', person: null }, { status: 'error', person: null }] });
    const first = await runStats.run('test', () => cache.lookup(NUMBER), { log: quiet });
    assert.strictEqual(first.deferred, true);
    assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM phone_lookups').get().n, 0);
    const second = await runStats.run('test', () => cache.lookup(NUMBER), { log: quiet });
    assert.strictEqual(second.deferred, true);
    assert.strictEqual(calls.length, 2, 'opslaget prøves igen, fordi fejlen ikke blev cachet');
  });
}

test('pause (efter 401/429) udskyder opslaget uden at kalde Pipedrive', async () => {
  const { cache, calls } = setup({ paused: true });
  const r = await runStats.run('test', () => cache.lookup(NUMBER), { log: quiet });
  assert.deepStrictEqual([r.deferred, r.reason, calls.length], [true, 'pause', 0]);
});

test('cachen overlever en genstart', async () => {
  const dbPath = tmpDbPath('restart');
  const first = setup({ dbPath });
  await runStats.run('test', () => first.cache.lookup(NUMBER), { log: quiet });
  assert.strictEqual(first.calls.length, 1);
  first.db.close();

  const afterRestart = setup({ dbPath });             // ny proces: ny forbindelse, ny cache
  const r = await runStats.run('test', () => afterRestart.cache.lookup(NUMBER), { log: quiet });
  assert.strictEqual(r, null);
  assert.strictEqual(afterRestart.calls.length, 0, 'ingen Pipedrive-kald efter genstart');
  afterRestart.db.close();
});

test('højst 25 opslag pr. kørsel — resten udskydes', async () => {
  const { cache, calls } = setup();
  const results = await runStats.run('indhentning', async () => {
    const out = [];
    for (let i = 0; i < 30; i++) out.push(await cache.lookup('+45 2' + String(1000000 + i)));
    return out;
  }, { log: quiet });
  assert.strictEqual(calls.length, 25);
  assert.strictEqual(results.filter((r) => r && r.deferred && r.reason === 'loft').length, 5);
});

test('et match rydder "ingen match" for nummeret', async () => {
  const { cache, calls } = setup();
  await runStats.run('test', () => cache.lookup(NUMBER), { log: quiet });
  cache.remember(NUMBER, 42, 9);                     // fx click-to-call fra Pipedrive
  const r = await runStats.run('test', () => cache.lookup(NUMBER), { log: quiet });
  assert.deepStrictEqual(r, { personId: 42, latestDealId: 9 });
  assert.strictEqual(calls.length, 1);
});

test('fundet person caches og giver deal med', async () => {
  const { cache } = setup({ results: [{ status: 'found', person: { id: 5 } }] });
  const r = await runStats.run('test', () => cache.lookup(NUMBER), { log: quiet });
  assert.deepStrictEqual(r, { personId: 5, latestDealId: 7 });
});

test('gammel tabel (kun sidste 8, INTEGER-id) flyttes til (crm, sidste 8) uden at tabe rækker', async () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE phone_lookups (number_last8 TEXT PRIMARY KEY, person_id INTEGER, latest_deal_id INTEGER, checked_at INTEGER NOT NULL, first_miss_at INTEGER)`);
  const t = Date.now();
  db.prepare('INSERT INTO phone_lookups VALUES (?, ?, ?, ?, NULL)').run('92821085', 42, 9, t);
  db.prepare('INSERT INTO phone_lookups VALUES (?, NULL, NULL, ?, ?)').run('22751363', t, t);
  const calls = [];
  const origLog = console.log; console.log = () => {};
  const cache = createPhoneLookupCache({ db, search: async (p) => { calls.push(p); return { status: 'none' }; }, getDeals: async () => ({}), log: quiet });
  console.log = origLog;
  const cols = db.prepare('PRAGMA table_info(phone_lookups)').all().map((c) => c.name);
  assert.ok(cols.includes('crm'));
  const r = await runStats.run('test', () => cache.lookup(NUMBER), { log: quiet });
  assert.deepStrictEqual(r, { personId: 42, latestDealId: 9 }, 'Pipedrive-id er stadig et tal');
  assert.strictEqual(await runStats.run('test', () => cache.lookup('+45 22 75 13 63'), { log: quiet }), null, '"ingen match" bevaret');
  assert.strictEqual(calls.length, 0);
});

test('Twenty og Pipedrive deler tabel, men ikke rækker', async () => {
  const db = new Database(':memory:');
  const mk = (crm, id) => createPhoneLookupCache({ db, crm, search: async () => ({ status: 'found', person: { id } }), getDeals: async () => ({ latestDealId: null }), log: quiet });
  const pd = mk('pipedrive', 5);
  const tw = mk('twenty', 'a1b2c3d4-0000-4000-8000-000000000001');
  assert.strictEqual((await runStats.run('t', () => pd.lookup(NUMBER), { log: quiet })).personId, 5);
  assert.strictEqual((await runStats.run('t', () => tw.lookup(NUMBER), { log: quiet })).personId, 'a1b2c3d4-0000-4000-8000-000000000001');
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM phone_lookups').get().n, 2);
});

test('"ingen match": 15 min den første time, derefter 24 timer — og en ny time efter et døgn', async () => {
  const clock = { t: 5_000_000 };
  const { cache, calls } = setup({ clock });
  const look = () => runStats.run('test', () => cache.lookup(NUMBER), { log: quiet });
  await look();                                         // første miss
  clock.t += 10 * 60 * 1000; await look();              // +10 min: cache
  assert.strictEqual(calls.length, 1);
  clock.t += 6 * 60 * 1000; await look();               // +16 min: nyt opslag (15 min-reglen)
  assert.strictEqual(calls.length, 2);
  clock.t += 16 * 60 * 1000; await look();              // +32 min
  clock.t += 16 * 60 * 1000; await look();              // +48 min
  assert.strictEqual(calls.length, 4, 'opslag ved 0, 16, 32 og 48 min');
  clock.t += 16 * 60 * 1000; await look();              // +64 min: efter første time gælder 24 t fra seneste tjek
  clock.t += 10 * 3600 * 1000; await look();            // +10 t: stadig cache
  assert.strictEqual(calls.length, 4, 'efter første time højst ét opslag pr. døgn');
  clock.t += NEGATIVE_TTL_MS; await look();              // døgnet er gået: nyt opslag, og en ny første time starter
  assert.strictEqual(calls.length, 5);
  clock.t += NEGATIVE_FIRST_HOUR_TTL_MS + 1000; await look();
  assert.strictEqual(calls.length, 6, 'ny første time efter døgnet');
});
