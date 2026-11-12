// Salgscoachens service-adgang og coaching uden fast sælgernavn.
require('./helpers');
process.env.ADMIN_SECRET = 'admin-test';
process.env.COACH_SERVICE_TOKEN = 'coach-test-token';
const test = require('node:test');
const assert = require('node:assert');

const config = require('../src/config');
const { requireServiceOrPanel } = require('../src/middleware/auth');
const coaching = require('../src/services/coaching');

function call(headers) {
  let status = 200; let nextCalled = false;
  const res = { status(c) { status = c; return this; }, json() { return this; } };
  requireServiceOrPanel({ headers, query: {} }, res, () => { nextCalled = true; });
  return { status, nextCalled };
}

test('service-token: rigtigt token giver adgang, forkert eller manglende afvises', () => {
  assert.strictEqual(call({ 'x-service-token': 'coach-test-token' }).nextCalled, true);
  assert.strictEqual(call({ 'x-service-token': 'forkert-token-xx' }).status, 401);
  assert.strictEqual(call({}).status, 401);
  assert.strictEqual(call({ 'x-admin-secret': 'admin-test' }).nextCalled, true); // admin virker som før
});

test('service-token: uden COACH_SERVICE_TOKEN er adgangen slået fra', () => {
  const saved = config.security.coachServiceToken;
  config.security.coachServiceToken = '';
  try {
    assert.strictEqual(call({ 'x-service-token': '' }).status, 401);
    assert.strictEqual(call({ 'x-service-token': 'coach-test-token' }).status, 401);
  } finally { config.security.coachServiceToken = saved; }
});

test('coaching: værktøjets tekster bruger sælgerens navn, standard er som før', () => {
  const standard = JSON.stringify(coaching.toolFor(coaching.sellerName(null)));
  assert.ok(standard.includes('Jeppes bedste replik'));
  assert.ok(!standard.includes('{S}'));
  const booker = JSON.stringify(coaching.toolFor(coaching.sellerName({ name: 'Anne', role: 'moedebooker' })));
  assert.ok(booker.includes('Annes bedste replik'));
  assert.ok(!booker.includes('Jeppe'));
});

test('coaching: historikken tæller kun sælgerens egne kald', () => {
  const row = (c) => ({ started_at: '2026-11-01', coaching_json: JSON.stringify({ moedetype: 'Første kald', blokke: {}, exit_naaet: 'ja', oevelse: 'x', ...c }) });
  const rows = [row({}), row({ saelger: { navn: 'Anne', rolle: 'moedebooker' } }), row({})];
  assert.match(coaching.summarizeHistory(rows, null), /De seneste 2 coachede kald/);
  assert.match(coaching.summarizeHistory(rows, { name: 'Anne', role: 'moedebooker' }), /De seneste 1 coachede kald/);
});

test('coaching-blokken: standardsælgerens navn som før, ellers kaldets sælger', () => {
  const base = { moedetype: 'Første kald', blokke: {}, tale: { saelgerPct: 40, kundePct: 60, saelgerSpoergsmaal: 5 }, karakter: 7 };
  assert.match(coaching.buildCoachingBlock(base), /Tale: Jeppe 40 %/);
  assert.match(coaching.buildCoachingBlock({ ...base, saelger: { navn: 'Anne', rolle: 'moedebooker' } }), /Tale: Anne 40 %/);
});
