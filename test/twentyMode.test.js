// CRM_MODE=twenty: Twenty er primær, Pipedrive røres ikke (og PIPEDRIVE_API_TOKEN er valgfri).
const { quiet } = require('./helpers');
process.env.CRM_MODE = 'twenty';
process.env.PIPEDRIVE_API_TOKEN = '';
process.env.TWENTY_API_URL = 'https://twenty.test';
process.env.TWENTY_API_KEY = 'test-key';
process.env.TWENTY_JEPPE_MEMBER_ID = 'jeppe-member';

const test = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
require('../src/services/alerts').configure({ db: new Database(':memory:'), send: async () => {} });

const transcription = require('../src/services/transcription');
transcription.transcribe = async () => ({ text: 'Hej Ole, det er Jeppe fra Zalye. Vi taler om planlægning og tilbud i jeres malerfirma i dag.', words: [] });
transcription.buildDiarizedTranscript = () => 'Sælger: Hej\nKunde: Hej';

const pdGuard = require('../src/services/pipedriveGuard');
const pdHits = [];
pdGuard._setFetch(async (url) => { pdHits.push(url); throw new Error('Pipedrive må ikke kaldes i twenty-mode'); });

const relatel = require('../src/services/relatel');
const claude = require('../src/services/claude');
const coaching = require('../src/services/coaching');
const client = require('../src/crm/twentyClient');
const meta = require('../src/crm/twentyMeta');
const twentyAdapter = require('../src/crm/twenty');
const crm = require('../src/crm');
const { db, state, calls } = require('../src/db/database');
const jobs = require('../src/jobs/pollCalls');
const { createMockTwenty, standardMetadata } = require('./mockTwenty');

const raw = (uuid, number, endedAt, extra = {}) => ({
  call_uuid: uuid, direction: 'incoming', from_number: number, to_number: '4571747007',
  started_at: endedAt, answered_at: endedAt, ended_at: endedAt, talk_duration: 60, ...extra,
});

let tw;
const origLog = console.log; const origWarn = console.warn; const origErr = console.error;
test.before(() => { console.log = () => {}; console.warn = () => {}; console.error = () => {}; });
test.after(() => { console.log = origLog; console.warn = origWarn; console.error = origErr; });
test.beforeEach(() => {
  db.exec('DELETE FROM call_insights; DELETE FROM calls; DELETE FROM messages;');
  try { db.exec('DELETE FROM phone_lookups; DELETE FROM unknown_number_tasks;'); } catch { /* oprettes senere */ }
  tw = createMockTwenty({ metadata: standardMetadata() });
  client.guard._setFetch(tw.fetch);
  client.guard._reset();
  meta._reset();
  twentyAdapter._resetCaches();
  relatel.getCall = async () => null;
  relatel.downloadRecording = async () => ({ buffer: Buffer.from('x'), contentType: 'audio/mpeg' });
  claude.analyzeCall = async () => ({ schemaVersion: 2, summary: 'Kort snak.', actionPoints: [], topics: [], profile: {}, journey: {}, objections: [], callOutcome: 'needs_follow_up', conversionLikelihood: 5 });
  coaching.coachCall = async () => ({ schemaVersion: 2, moedetype: 'Opfølgning', udfald: 'uafklaret', blokke: {}, karakter: 6, styrker: [], mere_vaegt_paa: [], spilleregler: [], voss_brugt: [] });
  state.set('last_call_check', '2026-11-08T08:00:00.000Z');
});

test('twenty: primær er Twenty, ingen skygge', () => {
  assert.strictEqual(crm.primary.name, 'twenty');
  assert.strictEqual(crm.shadow, null);
});

test('twenty: kendt nummer → samtale; ukendt nummer over 25 sek. → én opgave til Jeppe', async () => {
  tw.add('people', { name: { firstName: 'Ole' }, phones: { primaryPhoneNumber: '12345678' }, telefon8: '12345678' });
  relatel.getCalls = async () => [
    raw('t1', '4512345678', '2026-11-08T09:00:00.000Z'),
    raw('t2', '4599999999', '2026-11-08T09:10:00.000Z'),
    raw('t3', '4599999999', '2026-11-08T09:20:00.000Z'),
    raw('t4', '4588888888', '2026-11-08T09:30:00.000Z', { talk_duration: 10 }),
  ];
  await jobs.pollNewCalls();
  assert.ok(calls.getByUuid('t1').twenty_samtale_id);
  assert.strictEqual(calls.getByUuid('t1').pipedrive_activity_id, null);
  assert.strictEqual(calls.getByUuid('t2').twenty_samtale_id, null);
  assert.strictEqual(tw.db.tasks.size, 1, 'én opgave for 99999999 — ingen for det korte opkald');
  assert.strictEqual([...tw.db.tasks.values()][0].assigneeId, 'jeppe-member');
  assert.strictEqual(pdHits.length, 0);
});

test('twenty: GDPR — kun opkald med Twenty-match transskriberes', async () => {
  db.prepare(`INSERT INTO calls (relatel_uuid, direction, phone_number, started_at, ended_at, duration_sec, recording_url, transcription_status, twenty_person_id)
    VALUES ('g1', 'incoming', '4512345678', '2026-11-08T09:00:00Z', '2026-11-08T09:05:00Z', 300, 'https://rec', 'pending', 'p-uuid')`).run();
  db.prepare(`INSERT INTO calls (relatel_uuid, direction, phone_number, started_at, ended_at, duration_sec, recording_url, transcription_status, pipedrive_person_id)
    VALUES ('g2', 'incoming', '4587878787', '2026-11-08T09:00:00Z', '2026-11-08T09:05:00Z', 300, 'https://rec', 'pending', 42)`).run();
  await jobs.processTranscriptions();
  assert.strictEqual(calls.getByUuid('g1').transcription_status, 'done');
  assert.ok(calls.getByUuid('g1').twenty_samtale_id);
  assert.strictEqual(calls.getByUuid('g2').transcription_status, 'pending', 'et Pipedrive-match tæller ikke i twenty-mode');
  assert.strictEqual(pdHits.length, 0);
});

test('twenty: navnesynk til Relatel læser fra Twenty', async () => {
  const company = tw.add('companies', { name: 'Maler ApS' });
  tw.add('people', { name: { firstName: 'Ole', lastName: 'Hansen' }, phones: { primaryPhoneNumber: '12345678' }, telefon8: '12345678', companyId: company.id, emails: { primaryEmail: 'ole@maler.dk' } });
  const updates = [];
  relatel.getContacts = async () => [{ id: 'k1', number: '+4512345678', name: 'Ukendt' }];
  relatel.updateContact = async (id, data) => updates.push({ id, ...data });
  db.exec('DELETE FROM enriched_contacts');
  await jobs.enrichContacts();
  assert.deepStrictEqual(updates, [{ id: 'k1', name: 'Ole Hansen (Maler ApS)', email: 'ole@maler.dk' }]);
  assert.strictEqual(pdHits.length, 0);
});
