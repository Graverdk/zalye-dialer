// Mapping dialer → Twenty (src/crm/twentyMapping.js): ren logik, ingen netværk
require('./helpers');
const test = require('node:test');
const assert = require('node:assert');
const M = require('../src/crm/twentyMapping');

test('retning og varighed', () => {
  assert.strictEqual(M.retning('outgoing'), 'UD');
  assert.strictEqual(M.retning('incoming'), 'IND');
  assert.deepStrictEqual([null, 0, 10, 30, 89, 91, 3600].map(M.varighedMin), [null, 0, 1, 1, 1, 2, 60]);
});

test('modetype: Jeppe-kald er M1_ANALYSE, mødebooker-kald BOOKING_KALD', () => {
  assert.strictEqual(M.modetype('Første kald'), 'M1_ANALYSE');
  assert.strictEqual(M.modetype('Genopkald', { byMoedebooker: true }), 'BOOKING_KALD');
  assert.strictEqual(M.modetype('Omstilling'), 'BOOKING_KALD');
  assert.strictEqual(M.modetype('Demo'), 'M2_DEMO');
  assert.strictEqual(M.modetype('Opfølgning'), 'OPFOELGNING');
  assert.strictEqual(M.modetype('Opstart'), 'M4_M7_OPSTART');
  assert.strictEqual(M.modetype('Support'), 'SUPPORT');
  assert.strictEqual(M.modetype('Partner'), 'PARTNER');
  assert.strictEqual(M.modetype('noget andet'), null);
});

test('udfald fra coaching, analyse og ubesvaret', () => {
  assert.strictEqual(M.udfald({ isUnanswered: true, coachingUdfald: 'booket' }), 'IKKE_SVAR');
  assert.strictEqual(M.udfald({ coachingUdfald: 'ingen kontakt' }), 'IKKE_SVAR');
  assert.strictEqual(M.udfald({ callOutcome: 'meeting_booked' }), 'MOEDE_BOOKET');
  assert.strictEqual(M.udfald({ coachingUdfald: 'booket' }), 'MOEDE_BOOKET');
  assert.strictEqual(M.udfald({ coachingUdfald: 'tabt med årsag' }), 'IKKE_INTERESSERET');
  assert.strictEqual(M.udfald({ callOutcome: 'not_interested' }), 'IKKE_INTERESSERET');
  assert.strictEqual(M.udfald({ coachingUdfald: 'parkeret med dato' }), 'RING_IGEN');
  assert.strictEqual(M.udfald({ coachingUdfald: 'uafklaret' }), 'RING_IGEN');
  assert.strictEqual(M.udfald({ callOutcome: 'needs_follow_up' }), 'RING_IGEN');
  assert.strictEqual(M.udfald({ callOutcome: 'interested' }), null, 'FORKERT_NUMMER og andet sættes ikke automatisk');
});

test('temperatur', () => {
  assert.strictEqual(M.temperatur({ conversionLikelihood: 8 }), 'VARM');
  assert.strictEqual(M.temperatur({ conversionLikelihood: 5 }), 'LUN');
  assert.strictEqual(M.temperatur({ conversionLikelihood: 2, sentiment: 'positive' }), 'KOLD');
  assert.strictEqual(M.temperatur({ conversionLikelihood: 5, sentiment: 'negative' }), 'KOLD');
  assert.strictEqual(M.temperatur({ sentiment: 'positive', callOutcome: 'interested' }), 'VARM');
  assert.strictEqual(M.temperatur({}), null);
});

test('blokkeDaekket tager kun "dækket"', () => {
  assert.deepStrictEqual(M.blokkeDaekket({ anledning: 'dækket', situation: 'delvist', smerte: 'dækket', naeste_skridt: 'dækket', beslutning: 'mangler' }),
    ['ANLEDNING', 'SMERTE', 'NAESTE_SKRIDT']);
  assert.deepStrictEqual(M.blokkeDaekket(null), []);
});

test('rolle, anledning, branche og timer pr. uge', () => {
  assert.strictEqual(M.rolle('ejer/direktør'), 'EJER_DIREKTOER');
  assert.strictEqual(M.rolle('IT/økonomi'), 'IT_OEKONOMI');
  assert.strictEqual(M.anledning('vækst/nye ansatte'), 'VAEKST');
  assert.strictEqual(M.anledning('andet'), null);
  assert.strictEqual(M.branche('Tømrer'), 'TOEMRER_SNEDKER');
  assert.strictEqual(M.branche('anlægsgartner'), 'ANLAEG_HAVE');
  assert.strictEqual(M.branche('tagdækker'), null, 'fag uden for planens liste springes over');
  assert.strictEqual(M.timerPrUge(['Bruger 10 timer om ugen på tilbud']), 10);
  assert.strictEqual(M.timerPrUge(['koster dyrt']), null);
});

test('DEMO_BOOKET må kun nås fra tidligere åbne trin', () => {
  assert.deepStrictEqual(M.STAGES_BEFORE_DEMO_BOOKET, ['NY_LEAD', 'KVALIFICERET', 'VENTER_PAA_DEMO_BOOKING']);
});

test('visNummer', () => {
  assert.strictEqual(M.visNummer('4512345678'), '+45 12 34 56 78');
  assert.strictEqual(M.visNummer('12345678'), '12 34 56 78');
});
