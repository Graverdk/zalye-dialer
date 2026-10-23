// Pipedrive-vagten testes med en falsk node-fetch, så vi kan svare 401/429/200
// uden netværk og uden rigtige nøgler.
const { quiet } = require('./helpers');
const test = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');

const realFetch = require('node-fetch');
const responses = [];
const hits = [];
function fakeFetch(url) {
  hits.push(url);
  const next = responses.shift() || { status: 200, body: { success: true, data: { items: [] } } };
  return Promise.resolve(new realFetch.Response(JSON.stringify(next.body || {}), { status: next.status, headers: next.headers || {} }));
}
fakeFetch.Response = realFetch.Response;
require.cache[require.resolve('node-fetch')].exports = fakeFetch;

const alerts = require('../src/services/alerts');
alerts.configure({ db: new Database(':memory:'), send: async () => {} });
const guard = require('../src/services/pipedriveGuard');
const pipedrive = require('../src/services/pipedrive');
const runStats = require('../src/services/runStats');
const { createPhoneLookupCache } = require('../src/services/phoneLookupCache');

test.beforeEach(() => { guard._reset(); responses.length = 0; hits.length = 0; });
const origWarn = console.warn; const origErr = console.error; const origLog = console.log;
test.before(() => { console.warn = () => {}; console.error = () => {}; console.log = () => {}; });
test.after(() => { console.warn = origWarn; console.error = origErr; console.log = origLog; });

test('pausen vokser eksponentielt op til 15 min', () => {
  const min = (n) => guard.pauseFor(n) / 60000;
  assert.deepStrictEqual([1, 2, 3, 4, 5, 9].map(min), [2, 4, 8, 15, 15, 15]);
});

test('401: resten af kørslen rører ikke Pipedrive, og opslaget er en fejl, ikke "ingen match"', async () => {
  responses.push({ status: 401, body: { success: false, error: 'unauthorized access' } });
  await runStats.run('test', async () => {
    const a = await pipedrive.searchPersonByPhone('92821085');
    const b = await pipedrive.searchPersonByPhone('22751363');
    assert.strictEqual(a.status, 'error');
    assert.strictEqual(b.status, 'error');
    const s = runStats.current();
    assert.strictEqual(s.stopPipedrive, true);
    assert.strictEqual(s.pipedriveCalls, 1);
    assert.strictEqual(s.pipedriveSkipped, 1);
    assert.ok(s.authFailures.has('pipedrive'));
  }, { log: quiet });
  assert.strictEqual(hits.length, 1, 'kun ét kald ud til Pipedrive');
  assert.ok(guard.isPaused(), 'pause efter 401');
});

test('401 og 429 havner aldrig i cachen som "ingen match"', async () => {
  const db = new Database(':memory:');
  const cache = createPhoneLookupCache({
    db,
    search: (p) => pipedrive.searchPersonByPhone(p),
    getDeals: (id) => pipedrive.getPersonWithDeals(id),
    isPaused: () => pipedrive.isRateLimited(),
    log: quiet,
  });
  for (const status of [401, 429]) {
    guard._reset();
    responses.push({ status, body: { success: false } });
    const r = await runStats.run('test', () => cache.lookup('+45 92 82 10 85'), { log: quiet });
    assert.strictEqual(r.deferred, true, 'status ' + status);
    assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM phone_lookups').get().n, 0, 'status ' + status);
  }
});

test('429 respekterer Retry-After (højst 15 min), og et OK-svar ophæver pausen', async () => {
  responses.push({ status: 429, body: {}, headers: { 'Retry-After': '600' } });
  await runStats.run('test', () => guard.fetch('https://test.pipedrive.com/api/v1/x'), { log: quiet });
  const left = guard._state.pausedUntil - Date.now();
  assert.ok(left > 9 * 60000 && left <= 10 * 60000, 'ca. 10 min pause');

  guard._state.pausedUntil = 0;                       // pausen er gået
  responses.push({ status: 200, body: { success: true } });
  const res = await runStats.run('test', () => guard.fetch('https://test.pipedrive.com/api/v1/x'), { log: quiet });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(guard._state.failures, 0);
  assert.strictEqual(guard.isPaused(), false);
});

test('under pausen går ingen kald ud', async () => {
  responses.push({ status: 429, body: {} });
  await runStats.run('a', () => guard.fetch('https://test.pipedrive.com/api/v1/x'), { log: quiet });
  const res = await runStats.run('b', () => guard.fetch('https://test.pipedrive.com/api/v1/y'), { log: quiet });
  assert.strictEqual(res.status, 503);
  assert.strictEqual(hits.length, 1);
});
