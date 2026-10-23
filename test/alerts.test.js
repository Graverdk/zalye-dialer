const { tmpDbPath } = require('./helpers');
const test = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const alerts = require('../src/services/alerts');
const runStats = require('../src/services/runStats');

function failingRun(provider) {
  const s = runStats.createStats('test');
  s.authFailures.add(provider);
  return s;
}

test('401 i to kørsler i træk giver én alarm, derefter højst én pr. time', async () => {
  const sent = [];
  alerts.configure({ db: new Database(':memory:'), send: async (info) => sent.push(info) });
  const t0 = 1_000_000_000;
  await alerts.endRun(failingRun('pipedrive'), t0);
  assert.strictEqual(sent.length, 0, 'ingen alarm efter første kørsel');
  await alerts.endRun(failingRun('pipedrive'), t0 + 2 * 60000);
  assert.strictEqual(sent.length, 1, 'alarm efter anden kørsel i træk');
  await alerts.endRun(failingRun('pipedrive'), t0 + 30 * 60000);
  assert.strictEqual(sent.length, 1, 'ingen ny alarm inden for en time');
  await alerts.endRun(failingRun('pipedrive'), t0 + 63 * 60000);
  assert.strictEqual(sent.length, 2, 'ny alarm efter en time');
  assert.strictEqual(sent[1].provider, 'pipedrive');
});

test('et OK-svar nulstiller tælleren', async () => {
  const sent = [];
  alerts.configure({ db: new Database(':memory:'), send: async (info) => sent.push(info) });
  await alerts.endRun(failingRun('relatel'), 1);
  await runStats.run('ok', async () => alerts.noteSuccess('relatel'), { log: { log() {} } });
  await alerts.endRun(failingRun('relatel'), 2);
  assert.strictEqual(sent.length, 0);
});

test('alarm-tilstanden overlever en genstart', async () => {
  const dbPath = tmpDbPath('alerts');
  const sent = [];
  let db = new Database(dbPath);
  alerts.configure({ db, send: async (info) => sent.push(info) });
  await alerts.endRun(failingRun('pipedrive'), 1000);
  db.close();
  db = new Database(dbPath);
  alerts.configure({ db, send: async (info) => sent.push(info) });
  await alerts.endRun(failingRun('pipedrive'), 2000);
  assert.strictEqual(sent.length, 1);
  db.close();
});

test('alarmteksten indeholder ingen nøgler', () => {
  const { title, text } = alerts.buildMessage({ provider: 'pipedrive', runs: 2, jobName: 'AI' });
  assert.match(title, /Pipedrive afviser nøglen \(401\)/);
  assert.doesNotMatch(title + text, /test/);
});
