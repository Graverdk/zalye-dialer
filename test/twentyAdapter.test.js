// Twenty-adapteren mod et mocket Twenty (test/mockTwenty.js). Ingen netværk.
const { quiet } = require('./helpers');
process.env.CRM_MODE = 'twenty';
process.env.TWENTY_API_URL = 'https://twenty.test';
process.env.TWENTY_API_KEY = 'test-key';
process.env.TWENTY_JEPPE_MEMBER_ID = 'jeppe-member';
process.env.TWENTY_MAX_CALLS_PER_RUN = '60';
process.env.TWENTY_UNKNOWN_NUMBER_MIN_SEC = '25';

const test = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const alerts = require('../src/services/alerts');
const sentAlerts = [];
alerts.configure({ db: new Database(':memory:'), send: async (i) => sentAlerts.push(i) });

const runStats = require('../src/services/runStats');
const client = require('../src/crm/twentyClient');
const meta = require('../src/crm/twentyMeta');
const twenty = require('../src/crm/twenty');
const crm = require('../src/crm');
const { db } = require('../src/db/database');
const { createMockTwenty, standardMetadata } = require('./mockTwenty');

let tw;
const run = (fn) => runStats.run('test', fn, { log: quiet });
const origLog = console.log; const origWarn = console.warn; const origErr = console.error;
test.before(() => { console.log = () => {}; console.warn = () => {}; console.error = () => {}; });
test.after(() => { console.log = origLog; console.warn = origWarn; console.error = origErr; });
test.beforeEach(() => {
  tw = createMockTwenty({ metadata: standardMetadata() });
  client.guard._setFetch(tw.fetch);
  client.guard._reset();
  client.guard._setMaxCallsPerRun(60);
  meta._reset();
  twenty._resetCaches();
  try { db.exec('DELETE FROM phone_lookups'); } catch { /* oprettes ved første opslag */ }
  db.exec('DROP TABLE IF EXISTS unknown_number_tasks');
  sentAlerts.length = 0;
});

function seedCustomer({ phone = '12345678', telefon8 = '12345678', stage = 'KVALIFICERET', additional = [] } = {}) {
  const company = tw.add('companies', { name: 'Maler ApS', employees: null, branche: [], driftssystem: [], regnskabsprogram: [], lonprogram: [] });
  const person = tw.add('people', {
    name: { firstName: 'Ole', lastName: 'Hansen' },
    phones: { primaryPhoneNumber: phone, primaryPhoneCallingCode: '+45', additionalPhones: additional },
    emails: { primaryEmail: 'ole@maler.dk' },
    telefon8, companyId: company.id, rolle: null,
  });
  const opp = tw.add('opportunities', { name: 'Maler ApS – Zalye', stage, companyId: company.id, anledning: null, indvending: 'Har allerede noget', booketAfId: null });
  return { company, person, opp };
}

const call = (over = {}) => ({
  relatel_uuid: 'uuid-1', direction: 'outgoing', phone_number: '4512345678', employee_number: '4571747007',
  started_at: '2026-11-10T09:00:00.000Z', ended_at: '2026-11-10T09:05:00.000Z', duration_sec: 300, ...over,
});

test('nøglen sendes som Bearer-header og aldrig i URL’en', async () => {
  seedCustomer();
  await run(() => twenty.searchPersonByPhone('+45 12 34 56 78'));
  assert.ok(tw.requests.length > 0);
  for (const r of tw.requests) {
    assert.strictEqual(r.auth, 'Bearer test-key');
    assert.doesNotMatch(JSON.stringify(r.query) + r.path, /test-key/);
  }
});

test('telefonformater: +45, 0045, mellemrum og 8 cifre finder samme person', async () => {
  const { person } = seedCustomer();
  for (const raw of ['+4512345678', '004512345678', '12 34 56 78', '12345678', '+45 12-34-56-78']) {
    const r = await run(() => twenty.searchPersonByPhone(raw));
    assert.strictEqual(r.status, 'found', raw);
    assert.strictEqual(r.person.id, person.id, raw);
  }
  assert.strictEqual((await run(() => twenty.searchPersonByPhone('1234'))).status, 'none', 'for kort nummer');
});

test('fallback på primært nummer sætter telefon8, og additionalPhones tjekkes i koden', async () => {
  const { person } = seedCustomer({ telefon8: null });
  const r = await run(() => twenty.searchPersonByPhone('4512345678'));
  assert.strictEqual(r.status, 'found');
  assert.strictEqual(tw.db.people.get(person.id).telefon8, '12345678', 'telefon8 sat ved match');

  // Nummer kun i additionalPhones, men med telefon8 sat → fundet via det hurtige filter
  const p2 = tw.add('people', { name: { firstName: 'Bo' }, phones: { primaryPhoneNumber: '99999999', additionalPhones: [{ number: '87654321', callingCode: '+45' }] }, telefon8: '87654321' });
  assert.strictEqual((await run(() => twenty.searchPersonByPhone('+4587654321'))).person.id, p2.id);
  assert.ok(twenty.personHasNumber(p2, '87654321'));
  assert.ok(!twenty.personHasNumber(p2, '11111111'));
});

test('udenlandsk nummer matcher kun på de sidste 8 cifre, og et forkert træf afvises', async () => {
  tw.add('people', { name: { firstName: 'Ivan' }, phones: { primaryPhoneNumber: '441234567', primaryPhoneCallingCode: '+380' }, telefon8: null });
  assert.strictEqual((await run(() => twenty.searchPersonByPhone('+380 44 123 4567'))).status, 'found');
  // like-træf på "%…" uden at de sidste 8 passer (fx fejlformateret) → afvist
  tw.add('people', { name: { firstName: 'X' }, phones: { primaryPhoneNumber: '5512345678x' }, telefon8: null });
  assert.strictEqual((await run(() => twenty.searchPersonByPhone('+4555555555'))).status, 'none');
});

test('opslag giver åben salgsmulighed, ellers VUNDET + aktiv onboarding', async () => {
  const { person, opp, company } = seedCustomer();
  const links = await run(() => twenty.getLinks(person.id, tw.db.people.get(person.id)));
  assert.deepStrictEqual(links, { latestDealId: opp.id, companyId: company.id });

  tw.db.opportunities.get(opp.id).stage = 'VUNDET';
  const ob = tw.add('onboardings', { virksomhedId: company.id, fase: 'I_BRUG' });
  tw.add('onboardings', { virksomhedId: company.id, fase: 'STOPPET' });
  const links2 = await run(() => twenty.getLinks(person.id, tw.db.people.get(person.id)));
  assert.strictEqual(links2.latestDealId, opp.id);
  assert.strictEqual(links2.onboardingId, ob.id);
});

test('cachen er nøglet på (crm, sidste 8) — Twenty og Pipedrive har hver sin række', async () => {
  seedCustomer();
  await run(() => crm.lookup(twenty, '4512345678'));
  await run(() => crm.lookup(twenty, '4512345678'));
  const rows = db.prepare("SELECT crm, number_last8, person_id FROM phone_lookups").all();
  assert.deepStrictEqual(rows.map((r) => [r.crm, r.number_last8]), [['twenty', '12345678']]);
  assert.match(rows[0].person_id, /^[0-9a-f-]{36}$/, 'UUID gemt som tekst');
  assert.strictEqual(tw.count('GET', '/people'), 1, 'andet opslag ramte cachen');
});

test('idempotens: samme opkald to gange giver én samtale', async () => {
  const { person, company, opp } = seedCustomer();
  const match = { personId: person.id, companyId: company.id, latestDealId: opp.id };
  const id1 = await run(() => twenty.upsertCallRecord({ row: call(), match }));
  const id2 = await run(() => twenty.upsertCallRecord({ row: call(), match }));
  assert.ok(id1);
  assert.strictEqual(id1, id2);
  assert.strictEqual(tw.db.samtaler.size, 1);
  const s = tw.db.samtaler.get(id1);
  assert.strictEqual(s.eksterntId, 'relatel-call:uuid-1');
  assert.strictEqual(s.samtaletype, 'OPKALD');
  assert.strictEqual(s.retning, 'UD');
  assert.strictEqual(s.kilde, 'DIALER');
  assert.strictEqual(s.varighedMin, 5);
  assert.strictEqual(s.personId, person.id);
  assert.strictEqual(s.virksomhedId, company.id);
  assert.strictEqual(s.salgsmulighedId, opp.id);
  assert.strictEqual(s.fortAfId, 'jeppe-member');

  // Kendt id i SQLite → intet kald
  tw.reset();
  assert.strictEqual(await run(() => twenty.upsertCallRecord({ row: call({ twenty_samtale_id: id1 }), match })), id1);
  assert.strictEqual(tw.requests.length, 0);
});

test('SMS og Relatel-note bliver samtaler med eget eksterntId, også ved gentagelse', async () => {
  const { person } = seedCustomer();
  const match = { personId: person.id };
  const sms = { relatel_id: '777', direction: 'incoming', phone_number: '4512345678', body: 'Hej, ring mig op', sent_at: '2026-11-10T10:00:00Z' };
  const a = await run(() => twenty.upsertSms({ row: sms, match }));
  const b = await run(() => twenty.upsertSms({ row: sms, match }));
  assert.strictEqual(a.recordId, b.recordId);
  const n1 = await run(() => twenty.upsertRelatelNote({ note: { relatel_id: 'c9', author: 'Jeppe', body: 'Ring tirsdag' }, match }));
  const n2 = await run(() => twenty.upsertRelatelNote({ note: { relatel_id: 'c9', author: 'Jeppe', body: 'Ring tirsdag' }, match }));
  assert.strictEqual(n1, n2);
  const types = [...tw.db.samtaler.values()].map((s) => [s.samtaletype, s.eksterntId]).sort();
  assert.deepStrictEqual(types, [['NOTE', 'relatel-note:c9'], ['SMS', 'relatel-sms:777']]);
});

test('analysen opdaterer samtalen med udfald, mødetype, temperatur, blokke, resumé, coaching og transskript', async () => {
  const { person, company, opp } = seedCustomer();
  const match = { personId: person.id, companyId: company.id, latestDealId: opp.id };
  const id = await run(() => twenty.upsertCallRecord({ row: call(), match }));
  const callData = {
    direction: 'outgoing', phoneNumber: '4512345678', startedAt: call().started_at, durationSec: 300,
    summary: 'Ole vil se en demo.', actionPoints: ['Send invitation'], topics: ['planlægning'],
    insights: { schemaVersion: 2, profile: {}, journey: {}, conversionLikelihood: 8, sentiment: 'positive', callOutcome: 'meeting_booked' },
    coaching: { schemaVersion: 2, moedetype: 'Første kald', udfald: 'booket', blokke: { anledning: 'dækket', smerte: 'delvist' }, karakter: 8, styrker: [], mere_vaegt_paa: [], spilleregler: [], voss_brugt: [] },
    twenty: { personName: 'Ole Hansen', dealTitle: 'Maler ApS – Zalye', changes: [{ felt: 'Rolle', vaerdi: 'EJER_DIREKTOER' }] },
  };
  const rec = await run(() => twenty.completeCallRecord({ row: call({ twenty_samtale_id: id }), match, callData, transcript: 'Sælger: Hej\nKunde: Hej' }));
  assert.strictEqual(rec.recordId, id);
  const s = tw.db.samtaler.get(id);
  assert.strictEqual(s.udfald, 'MOEDE_BOOKET');
  assert.strictEqual(s.modetype, 'M1_ANALYSE');
  assert.strictEqual(s.temperatur, 'VARM');
  assert.deepStrictEqual(s.blokkeDaekket, ['ANLEDNING']);
  assert.match(s.resume.markdown, /### Indsigter \(skema v2\)/);
  assert.match(s.resume.markdown, /### Twenty \(skema v1\)\n- Opkald lagt på: Ole Hansen · salgsmulighed "Maler ApS – Zalye"\n- Udfyldt \(var tomt\): Rolle → EJER_DIREKTOER/);
  assert.doesNotMatch(s.resume.markdown, /### Coaching/, 'coaching står i coachVurdering, ikke i resumé');
  assert.match(s.coachVurdering.markdown, /^### Coaching \(skema v2\)/);
  assert.strictEqual(s.transskript.markdown, 'Sælger: Hej\nKunde: Hej');
  assert.strictEqual(tw.db.samtaler.size, 1);
});

test('meta.clean dropper ukendte felter og options i stedet for at få kaldet afvist', async () => {
  await run(() => meta.load());
  const out = meta.clean('samtaler', { udfald: 'FINDES_IKKE', temperatur: 'VARM', foo: 1, personId: 'x', blokkeDaekket: ['ANLEDNING', 'NOPE'] });
  assert.deepStrictEqual(out, { temperatur: 'VARM', personId: 'x', blokkeDaekket: ['ANLEDNING'] });
});

test('autofill udfylder kun tomme felter og foreslår resten', async () => {
  const { person, company, opp } = seedCustomer();
  const match = { personId: person.id, companyId: company.id, latestDealId: opp.id };
  const analysis = {
    profile: { antalMedarbejdere: 12, faggruppe: 'maler', driftssystem: 'Apacta', regnskabsprogram: 'e-conomic', loenprogram: 'Danløn' },
    journey: { kontaktRolle: 'ejer/direktør', anledning: 'vækst/nye ansatte', primaerSmerte: 'kommunikation/mail', konsekvens: ['5 timer om ugen på planlægning'] },
    objections: ['For dyrt'],
  };
  tw.db.companies.get(company.id).regnskabsprogram = ['ANDET'];
  const af = await run(() => twenty.autofill({ match, analysis }));
  const c = tw.db.companies.get(company.id);
  assert.strictEqual(c.employees, 12);
  assert.deepStrictEqual(c.branche, ['MALER']);
  assert.deepStrictEqual(c.driftssystem, ['APACTA'], 'MULTI_SELECT skrives som liste');
  assert.deepStrictEqual(c.lonprogram, ['DANLOEN']);
  assert.deepStrictEqual(c.regnskabsprogram, ['ANDET'], 'eksisterende værdi overskrives aldrig');
  assert.strictEqual(tw.db.people.get(person.id).rolle, 'EJER_DIREKTOER');
  const o = tw.db.opportunities.get(opp.id);
  assert.strictEqual(o.anledning, 'VAEKST');
  assert.strictEqual(o.primaerSmerte, 'MAIL', 'kommunikation/mail → MAIL');
  assert.strictEqual(o.indvending, 'Har allerede noget', 'eksisterende indvending overskrives ikke');
  assert.strictEqual(o.konsekvensTimerUge, 5);
  assert.ok(af.suggestions.some((s) => s.felt === 'company.regnskabsprogram' && s.vaerdi === 'E_CONOMIC'));
  assert.ok(af.suggestions.some((s) => s.felt === 'opportunity.indvending'));
  assert.deepStrictEqual(af.changes.map((x) => x.felt).sort(),
    ['Anledning', 'Antal ansatte', 'Driftssystem', 'Fag', 'Konsekvens', 'Konsekvens (timer/uge)', 'Lønprogram', 'Primær smerte', 'Rolle'].sort());
});

test('DEMO_BOOKET: kun fremad, og booketAf sættes ud fra Relatel-brugeren', async () => {
  const booker = tw.add('moedebookere', { name: 'Mette', relatelBruger: '4571747007' });
  const analysis = { profile: {}, journey: {}, objections: [], callOutcome: 'meeting_booked' };
  for (const [from, expected] of [['NY_LEAD', 'DEMO_BOOKET'], ['VENTER_PAA_DEMO_BOOKING', 'DEMO_BOOKET'], ['DEMO_HOLDT', 'DEMO_HOLDT'], ['BESLUTNING', 'BESLUTNING'], ['VUNDET', 'VUNDET']]) {
    const { person, company, opp } = seedCustomer({ stage: from });
    const af = await run(() => twenty.autofill({ match: { personId: person.id, companyId: company.id, latestDealId: opp.id }, analysis, coaching: { udfald: 'booket' }, row: call() }));
    const o = tw.db.opportunities.get(opp.id);
    assert.strictEqual(o.stage, expected, 'fra ' + from);
    assert.strictEqual(o.booketAfId, booker.id, 'booketAf fra ' + from);
    assert.strictEqual(!!af.stageChange, expected !== from);
  }
  // Ikke booket → intet trinskift
  const { person, company, opp } = seedCustomer({ stage: 'NY_LEAD' });
  await run(() => twenty.autofill({ match: { personId: person.id, companyId: company.id, latestDealId: opp.id }, analysis: { ...analysis, callOutcome: 'interested' }, coaching: { udfald: 'uafklaret' }, row: call() }));
  assert.strictEqual(tw.db.opportunities.get(opp.id).stage, 'NY_LEAD');
});

test('signaler oprettes i ét batch-kald med status FORESLAAET', async () => {
  const { person, company, opp } = seedCustomer();
  const match = { personId: person.id, companyId: company.id, latestDealId: opp.id };
  const analysis = {
    profile: { konkurrenter: [{ navn: 'Apacta', forhold: 'bruger_i_dag' }] },
    journey: { anledning: 'vækst/nye ansatte', primaerSmerte: 'overblik/styring', kundensOrd: ['Vi drukner i papir'], konsekvens: ['10 timer om ugen'] },
    objections: ['For dyrt', 'Ingen tid'],
  };
  const n = await run(() => twenty.afterAnalysis({ recordId: 'samtale-1', match, analysis, autofill: { suggestions: [{ felt: 'opportunity.indvending', vaerdi: 'For dyrt; Ingen tid' }] } }));
  assert.strictEqual(n, 6);
  assert.strictEqual(tw.count('POST', '/batch/signaler'), 1);
  const sig = [...tw.db.signaler.values()];
  assert.ok(sig.every((s) => s.status === 'FORESLAAET' && s.samtaleId === 'samtale-1' && s.virksomhedId === company.id && s.salgsmulighedId === opp.id));
  assert.deepStrictEqual(sig.map((s) => s.signaltype).sort(), ['ANLEDNING', 'INDVENDING', 'INDVENDING', 'KONKURRENT', 'KUNDENS_ORD', 'SMERTE'], 'ingen KONSEKVENS-signal');
  const by = (t) => sig.find((s) => s.signaltype === t);
  assert.strictEqual(by('ANLEDNING').vaerdi, 'VAEKST', 'enum-værdien i vaerdi');
  assert.strictEqual(by('SMERTE').vaerdi, 'OVERBLIK');
  assert.strictEqual(by('KONKURRENT').vaerdi, 'Apacta (bruger_i_dag)');
  assert.deepStrictEqual(by('KUNDENS_ORD').citat, { markdown: 'Vi drukner i papir' });
  assert.ok(sig.every((s) => !('tekst' in s)), 'feltet tekst findes ikke i Twenty');
  const withForslag = sig.filter((s) => s.forslag === 'UDFYLD_FELT');
  assert.strictEqual(withForslag.length, 1);
  assert.strictEqual(withForslag[0].forslagFelt, 'opportunity.indvending');
});

test('opgave ved ukendt nummer: højst én pr. nummer pr. dag og kun over minimumsvarigheden', async () => {
  const c = call({ phone_number: '4599999999', duration_sec: 40 });
  assert.ok(await run(() => twenty.createUnknownNumberTask({ phone: c.phone_number, call: c })));
  assert.strictEqual(await run(() => twenty.createUnknownNumberTask({ phone: c.phone_number, call: { ...c, relatel_uuid: 'uuid-2' } })), null);
  assert.strictEqual(tw.db.tasks.size, 1);
  const t = [...tw.db.tasks.values()][0];
  assert.strictEqual(t.status, 'TODO');
  assert.strictEqual(t.assigneeId, 'jeppe-member');
  assert.match(t.title, /^Ukendt nummer: \+45 99 99 99 99/);
  assert.strictEqual(t.dueAt, '2026-11-10T15:00:00.000Z', 'kl. 16 dansk tid (vintertid)');

  // Kort opkald → ingen opgave
  assert.strictEqual(await run(() => twenty.createUnknownNumberTask({ phone: '4588888888', call: { ...c, duration_sec: 10 } })), null);
  // Næste dag → ny opgave
  assert.ok(await run(() => twenty.createUnknownNumberTask({ phone: c.phone_number, call: { ...c, started_at: '2026-11-11T09:00:00Z' } })));
  assert.strictEqual(tw.db.tasks.size, 2);

  // Lokal tabel tabt (fx nyt volume): det faste id forhindrer en dublet i Twenty
  db.exec('DELETE FROM unknown_number_tasks');
  await run(() => twenty.createUnknownNumberTask({ phone: c.phone_number, call: c }));
  assert.strictEqual(tw.db.tasks.size, 2);
});

test('429: opslaget er en fejl, caches aldrig som "ingen match", og Twenty holder pause', async () => {
  tw.failNext(() => true, 429, { headers: { 'Retry-After': '120' } });
  const r = await run(() => crm.lookup(twenty, '4512345678'));
  assert.strictEqual(r.deferred, true);
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM phone_lookups').get().n, 0);
  assert.ok(client.guard.isPaused());
  const before = tw.requests.length;
  const r2 = await run(() => crm.lookup(twenty, '4512345678'));
  assert.strictEqual(r2.deferred, true);
  assert.strictEqual(tw.requests.length, before, 'ingen kald under pausen');
});

test('401: resten af kørslen rører ikke Twenty, og alarmen tælles for twenty', async () => {
  tw.failNext(() => true, 401);
  await run(async () => {
    const a = await twenty.searchPersonByPhone('4512345678');
    const b = await twenty.searchPersonByPhone('4587654321');
    assert.strictEqual(a.status, 'error');
    assert.strictEqual(b.status, 'error');
    const s = runStats.current();
    assert.strictEqual(s.stopTwenty, true);
    assert.strictEqual(s.twentyCalls, 1);
    assert.ok(s.authFailures.has('twenty'));
    assert.strictEqual(s.stopPipedrive, false, 'Pipedrive påvirkes ikke');
  });
  assert.strictEqual(tw.requests.length, 1);
});

test('TWENTY_MAX_CALLS_PER_RUN: loftet holder resten af kørslens kald tilbage', async () => {
  client.guard._setMaxCallsPerRun(3);
  await run(async () => {
    for (let i = 0; i < 6; i++) await twenty.searchPersonByPhone('451234567' + i);
    const s = runStats.current();
    assert.strictEqual(s.twentyCalls, 3);
    assert.ok(s.twentySkipped >= 3);
    assert.match(runStats.summaryLine(s), /Twenty-kald: 3/);
  });
  assert.strictEqual(tw.requests.length, 3);
});

test('natlig oprydning tømmer transskript på DIALER-samtaler ældre end 12 mdr. — kun én gang', async () => {
  const old = tw.add('samtaler', { kilde: 'DIALER', dato: '2025-10-01T10:00:00.000Z', transskript: { markdown: 'gammel tekst' } });
  const oldOther = tw.add('samtaler', { kilde: 'MANUEL', dato: '2025-10-01T10:00:00.000Z', transskript: { markdown: 'skal blive' } });
  const recent = tw.add('samtaler', { kilde: 'DIALER', dato: '2026-11-01T10:00:00.000Z', transskript: { markdown: 'ny tekst' } });
  const { state } = require('../src/db/database');
  db.prepare("DELETE FROM system_state WHERE key = 'twenty_transcript_purge_from'").run();
  const r = await run(() => twenty.purgeOldTranscripts({ state, now: new Date('2026-11-09T03:50:00Z') }));
  assert.strictEqual(r.emptied, 1);
  assert.strictEqual(tw.db.samtaler.get(old.id).transskript.markdown, '');
  assert.strictEqual(tw.db.samtaler.get(oldOther.id).transskript.markdown, 'skal blive');
  assert.strictEqual(tw.db.samtaler.get(recent.id).transskript.markdown, 'ny tekst');
  tw.reset();
  const r2 = await run(() => twenty.purgeOldTranscripts({ state, now: new Date('2026-11-10T03:50:00Z') }));
  assert.strictEqual(r2.emptied, 0);
  assert.strictEqual(tw.count('PATCH', '/samtaler'), 0);
});

test('TWENTY_SEND_TRANSCRIPT=false: kun en kort linje i transskript', async () => {
  const config = require('../src/config');
  const { person } = seedCustomer();
  config.twenty.sendTranscript = false;
  try {
    const rec = await run(() => twenty.completeCallRecord({ row: call(), match: { personId: person.id }, callData: { direction: 'outgoing', summary: 'x' }, transcript: 'Sælger: hemmeligt' }));
    assert.match(tw.db.samtaler.get(rec.recordId).transskript.markdown, /^Fuldt transskript ligger i dialeren/);
  } finally {
    config.twenty.sendTranscript = true;
  }
});

test('navnesynk til Relatel læser "Navn (Firma)" og mail fra Twenty-personen', async () => {
  seedCustomer();
  const r = await run(() => twenty.getContactForRelatel('+4512345678'));
  assert.deepStrictEqual(r, { status: 'found', name: 'Ole Hansen', company: 'Maler ApS', email: 'ole@maler.dk' });
  assert.deepStrictEqual(await run(() => twenty.getContactForRelatel('+4500000000')), { status: 'none' });
});
