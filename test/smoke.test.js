// Modulerne kan indlæses (fanger syntaks- og require-fejl før deploy)
require('./helpers');
const test = require('node:test');
const assert = require('node:assert');

test('pollCalls, routes og services kan indlæses', () => {
  const jobs = require('../src/jobs/pollCalls');
  assert.strictEqual(typeof jobs.pollNewCalls, 'function');
  for (const m of ['../src/routes/calls', '../src/routes/messages', '../src/routes/webhook', '../src/routes/auth']) {
    assert.ok(require(m));
  }
});
