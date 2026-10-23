// Coaching-blokken: labels og format skal matche parseren i zalye-salgscoach (insights.js)
require('./helpers');
const test = require('node:test');
const assert = require('node:assert');
const { buildCoachingBlock, COACHING_SCHEMA_VERSION, MESTRE } = require('../src/services/coaching');

const base = {
  schemaVersion: COACHING_SCHEMA_VERSION,
  moedetype: 'Første kald', formaal: 'Book analysen', exit_naaet: 'ja', exit_begrundelse: 'Møde booket',
  udfald: 'booket', blokke: {}, voss_brugt: [], styrker: [], mere_vaegt_paa: [],
  vendepunkt: null, bedste_replik: null, oevelse: 'Spørg til konsekvensen', moenster: null, karakter: 7,
};

test('spillereglerne skrives som én linje med sælger, fulgt/brudt og næste gang', () => {
  const block = buildCoachingBlock({
    ...base,
    spilleregler: [
      { saelger: 'Rackham', fulgt: 'brudt', hvad: 'Du spurgte ikke, hvad det koster ham', naeste_gang: 'Spørg: "Hvad sker der, når tilbuddet er sent?"' },
      { saelger: 'Sandler', fulgt: 'fulgt', hvad: 'Du aftalte formålet i starten; godt', naeste_gang: 'Gør det igen' },
    ],
  });
  assert.match(block, /^### Coaching \(skema v2\)/);
  const line = block.split('\n').find((l) => l.startsWith('- Spilleregler:'));
  assert.ok(line, 'linjen mangler');
  const items = line.replace('- Spilleregler: ', '').split('; ');
  assert.strictEqual(items.length, 2, 'semikolon inde i en regel må ikke splitte den');
  assert.match(items[0], /^Rackham \(brudt\): .+ — .+$/);
  assert.match(items[1], /^Sandler \(fulgt\): /);
});

test('uden spilleregler står der "ingen"', () => {
  assert.match(buildCoachingBlock(base), /- Spilleregler: ingen\n/);
});

test('der er præcis ti sælgere at vælge imellem', () => {
  assert.strictEqual(MESTRE.length, 10);
});
