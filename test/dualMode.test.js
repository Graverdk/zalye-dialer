// CRM_MODE=dual: Pipedrive er primær, Twenty skygge. Fejl i Twenty må aldrig
// blokere Pipedrive. Pipedrive-kaldene er stubbet; Twenty er mocket.
const { quiet } = require('./helpers');
process.env.CRM_MODE = 'dual';
process.env.TWENTY_API_URL = 'https://twenty.test';
process.env.TWENTY_API_KEY = 'test-key';
process.env.TWENTY_JEPPE_MEMBER_ID = 'jeppe-member';

const test = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
require('../src/services/alerts').configure({ db: new Database(':memory:'), send: async () => {} });

// Transskription stubbes FØR pollCalls indlæses (den destrukturerer ved require)
const transcription = require('../src/services/transcription');
transcription.transcribe = async () => ({ text: 'Hej Ole, det er Jeppe fra Zalye. Vi taler om planlægning og tilbud i jeres malerfirma i dag.', words: [] });
transcription.buildDiarizedTranscript = () => 'Sælger: Hej Ole\nKunde: Hej Jeppe, vi bruger Apacta i dag';

const relatel = require('../src/services/relatel');
const pipedrive = require('../src/services/pipedrive');
const autofill = require('../src/services/autofill');
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
  call_uuid: uuid, direction: 'outgoing', from_number: '4571747007', to_number: number,
  started_at: endedAt, answered_at: endedAt, ended_at: endedAt, talk_duration: 120, ...extra,
});

let tw; let pd;
const origLog = console.log; const origWarn = console.warn; const origErr = console.error;
test.before(() => { console.log = () => {}; console.warn = () => {}; console.error = () => {}; });
test.after(() => { console.log = origLog; console.warn = origWarn; console.error = origErr; });

test.beforeEach(() => {
  db.exec('DELETE FROM call_insights; DELETE FROM calls; DELETE FROM messages;');
  try { db.exec('DELETE FROM phone_lookups'); } catch { /* oprettes ved første opslag */ }
  tw = createMockTwenty({ metadata: standardMetadata() });
  client.guard._setFetch(tw.fetch);
  client.guard._reset();
  meta._reset();
  twentyAdapter._resetCaches();
  pd = { activities: [], updates: [], sms: [], autofills: 0 };
  pipedrive.isRateLimited = () => false;
  pipedrive.getPersonWithDeals = async () => ({ latestDealId: 77 });
  pipedrive.searchPersonByPhone = async (phone) => (phone.endsWith('12345678')
    ? { status: 'found', person: { id: 11 } } : { status: 'none', person: null });
  pipedrive.createCallActivity = async (a) => { pd.activities.push(a); return 5000 + pd.activities.length; };
  pipedrive.updateCallActivity = async (id, a) => { pd.updates.push({ id, ...a }); return id; };
  pipedrive.createSmsRecord = async (a) => { pd.sms.push(a); return { activityId: 9000 + pd.sms.length }; };
  autofill.autofillFromCall = async () => { pd.autofills++; return { changes: [], personName: 'Ole', dealTitle: 'Deal' }; };
  relatel.getCall = async () => null;
  relatel.downloadRecording = async () => ({ buffer: Buffer.from('x'), contentType: 'audio/mpeg' });
  claude.analyzeCall = async () => ({
    schemaVersion: 2, summary: 'Ole vil se en demo.', actionPoints: ['Send invitation'], topics: ['planlægning'],
    profile: { faggruppe: 'maler', antalMedarbejdere: 8, konkurrenter: [] }, journey: { anledning: 'vækst/nye ansatte', kundensOrd: [] },
    objections: ['For dyrt'], callOutcome: 'meeting_booked', sentiment: 'positive', conversionLikelihood: 8,
  });
  coaching.coachCall = async () => ({ schemaVersion: 2, moedetype: 'Første kald', udfald: 'booket', blokke: { anledning: 'dækket' }, karakter: 7, styrker: [], mere_vaegt_paa: [], spilleregler: [], voss_brugt: [] });
  state.set('last_call_check', '2026-11-10T08:00:00.000Z');
});

function seedTwenty() {
  const company = tw.add('companies', { name: 'Maler ApS' });
  const person = tw.add('people', { name: { firstName: 'Ole' }, phones: { primaryPhoneNumber: '12345678' }, telefon8: '12345678', companyId: company.id });
  const opp = tw.add('opportunities', { name: 'Maler ApS – Zalye', stage: 'KVALIFICERET', companyId: company.id });
  return { company, person, opp };
}

test('dual: opkaldet lander i Pipedrive OG som samtale i Twenty', async () => {
  const { person, opp } = seedTwenty();
  relatel.getCalls = async () => [raw('d1', '4512345678', '2026-11-10T09:00:00.000Z')];
  await jobs.pollNewCalls();
  const row = calls.getByUuid('d1');
  assert.strictEqual(row.pipedrive_activity_id, 5001);
  assert.strictEqual(row.pipedrive_person_id, 11, 'Pipedrive-id er stadig et tal');
  assert.ok(row.twenty_samtale_id);
  assert.strictEqual(row.twenty_person_id, person.id);
  assert.strictEqual(row.twenty_opportunity_id, opp.id);
  assert.strictEqual(tw.db.samtaler.get(row.twenty_samtale_id).eksterntId, 'relatel-call:d1');
});

test('dual: Twenty svarer 500 på alt → Pipedrive kører som før, markøren holdes ikke', async () => {
  seedTwenty();
  tw.failNext(() => true, 500, { times: 1000 });
  relatel.getCalls = async () => [raw('d2', '4512345678', '2026-11-10T09:00:00.000Z')];
  await jobs.pollNewCalls();
  const row = calls.getByUuid('d2');
  assert.strictEqual(row.pipedrive_activity_id, 5001);
  assert.strictEqual(row.twenty_samtale_id, null);
  assert.ok(Date.parse(state.get('last_call_check')) > Date.now() - 60000, 'markøren rykkede frem til nu');
});

test('dual: en undtagelse i Twenty-adapteren fanges — Pipedrive får sit', async () => {
  const orig = twentyAdapter.upsertCallRecord;
  twentyAdapter.upsertCallRecord = async () => { throw new Error('bum'); };
  try {
    seedTwenty();
    relatel.getCalls = async () => [raw('d3', '4512345678', '2026-11-10T09:00:00.000Z')];
    await assert.doesNotReject(() => jobs.pollNewCalls());
    assert.strictEqual(calls.getByUuid('d3').pipedrive_activity_id, 5001);
  } finally {
    twentyAdapter.upsertCallRecord = orig;
  }
});

test('dual: Twenty 429 sætter kun Twenty på pause — Pipedrive-vagten er upåvirket', async () => {
  seedTwenty();
  tw.failNext(() => true, 429, { times: 10 });
  relatel.getCalls = async () => [
    raw('d4', '4512345678', '2026-11-10T09:00:00.000Z'),
    raw('d5', '4512345678', '2026-11-10T09:10:00.000Z'),
  ];
  await jobs.pollNewCalls();
  assert.ok(client.guard.isPaused(), 'Twenty holder pause');
  assert.strictEqual(require('../src/services/pipedriveGuard').isPaused(), false);
  assert.strictEqual(pd.activities.length, 2);
  assert.strictEqual(tw.requests.length, 1, 'efter 429 går der ingen flere Twenty-kald ud');
});

test('dual: analysen opdaterer Pipedrive-aktiviteten og samtalen i Twenty (med signaler)', async () => {
  const { opp } = seedTwenty();
  db.prepare(`INSERT INTO calls (relatel_uuid, direction, phone_number, employee_number, started_at, ended_at, duration_sec, recording_url,
    pipedrive_person_id, pipedrive_deal_id, pipedrive_activity_id, transcription_status)
    VALUES ('a1', 'outgoing', '4512345678', '4571747007', '2026-11-10T09:00:00Z', '2026-11-10T09:05:00Z', 300, 'https://rec', 11, 77, 5001, 'pending')`).run();
  await jobs.processTranscriptions();
  const row = calls.getByUuid('a1');
  assert.strictEqual(row.transcription_status, 'done');
  assert.strictEqual(pd.updates.length, 1);
  assert.match(pd.updates[0].callData && JSON.stringify(pd.updates[0].callData), /Ole vil se en demo/);
  assert.ok(pd.updates[0].callData.pipedrive, 'Pipedrive-blokken er med');
  assert.strictEqual(pd.updates[0].callData.twenty, undefined, 'Twenty-blokken lækker ikke ind i Pipedrive');
  const s = tw.db.samtaler.get(row.twenty_samtale_id);
  assert.strictEqual(s.udfald, 'MOEDE_BOOKET');
  assert.match(s.resume.markdown, /### Twenty \(skema v1\)/);
  assert.doesNotMatch(s.resume.markdown, /### Pipedrive \(skema v1\)/);
  assert.ok(row.twenty_signaler_at, 'signaler markeret som oprettet');
  assert.ok(tw.db.signaler.size >= 2);
  assert.strictEqual(tw.db.opportunities.get(opp.id).stage, 'DEMO_BOOKET');

  // Genkørsel må ikke give dublet-signaler
  const n = tw.db.signaler.size;
  db.prepare("UPDATE calls SET transcription_status = 'pending' WHERE relatel_uuid = 'a1'").run();
  await jobs.processTranscriptions();
  assert.strictEqual(tw.db.signaler.size, n);
  assert.strictEqual(tw.db.samtaler.size, 1);
});

test('dual: Twenty nede under analysen → Pipedrive opdateres og opkaldet er færdigt', async () => {
  seedTwenty();
  tw.failNext(() => true, 500, { times: 1000 });
  db.prepare(`INSERT INTO calls (relatel_uuid, direction, phone_number, started_at, ended_at, duration_sec, recording_url,
    pipedrive_person_id, pipedrive_deal_id, pipedrive_activity_id, transcription_status)
    VALUES ('a2', 'outgoing', '4512345678', '2026-11-10T09:00:00Z', '2026-11-10T09:05:00Z', 300, 'https://rec', 11, 77, 5001, 'pending')`).run();
  await jobs.processTranscriptions();
  assert.strictEqual(calls.getByUuid('a2').transcription_status, 'done');
  assert.strictEqual(pd.updates.length, 1);
});

test('dual: GDPR følger primæren — match kun i Twenty giver ingen transskription', async () => {
  tw.add('people', { name: { firstName: 'Kun i Twenty' }, phones: { primaryPhoneNumber: '55555555' }, telefon8: '55555555' });
  db.prepare(`INSERT INTO calls (relatel_uuid, direction, phone_number, started_at, ended_at, duration_sec, recording_url, transcription_status)
    VALUES ('g1', 'incoming', '4555555555', '2026-11-10T09:00:00Z', '2026-11-10T09:05:00Z', 300, 'https://rec', 'pending')`).run();
  let downloads = 0;
  relatel.downloadRecording = async () => { downloads++; return { buffer: Buffer.from('x'), contentType: 'audio/mpeg' }; };
  await jobs.processTranscriptions();
  assert.strictEqual(downloads, 0);
  assert.strictEqual(calls.getByUuid('g1').transcription_status, 'pending');
});

test('dual: SMS lander i Pipedrive og som SMS-samtale i Twenty', async () => {
  seedTwenty();
  db.prepare(`INSERT INTO messages (relatel_id, direction, phone_number, body, sent_at) VALUES ('m1', 'incoming', '4512345678', 'Ring mig', ?)`)
    .run(new Date().toISOString());
  relatel.getMessages = async () => [];
  await jobs.fetchNewMessages();
  const m = db.prepare("SELECT * FROM messages WHERE relatel_id = 'm1'").get();
  assert.strictEqual(m.pipedrive_activity_id, 9001);
  assert.ok(m.twenty_samtale_id);
  assert.strictEqual(tw.db.samtaler.get(m.twenty_samtale_id).samtaletype, 'SMS');
});

test('dual: Twenty-cachen og Pipedrive-cachen er adskilte', async () => {
  seedTwenty();
  relatel.getCalls = async () => [raw('c1', '4512345678', '2026-11-10T09:00:00.000Z')];
  await jobs.pollNewCalls();
  const rows = db.prepare('SELECT crm FROM phone_lookups ORDER BY crm').all().map((r) => r.crm);
  assert.deepStrictEqual(rows, ['pipedrive', 'twenty']);
  assert.strictEqual(crm.mode, 'dual');
});
