// Pipedrive-appen er slettet: serveren skal kunne starte uden client id/secret,
// og panel-adgangen må så kun åbnes med ADMIN_SECRET (aldrig med et tomt JWT-secret).
require('./helpers');
process.env.PIPEDRIVE_CLIENT_ID = ''; // tom frem for slettet, så en lokal .env ikke fylder den ud
process.env.PIPEDRIVE_CLIENT_SECRET = '';
process.env.PIPEDRIVE_JWT_SECRET = '';
process.env.ADMIN_SECRET = 'admin-test';
const test = require('node:test');
const assert = require('node:assert');
const jwt = require('jsonwebtoken');

const { requirePanelAuth, signSessionToken } = require('../src/middleware/auth');

function call(req) {
  let status = 200; let nextCalled = false;
  const res = { status(c) { status = c; return this; }, json() { return this; } };
  requirePanelAuth({ headers: {}, query: {}, ...req }, res, () => { nextCalled = true; });
  return { status, nextCalled };
}

test('config og routes kan indlæses uden PIPEDRIVE_CLIENT_ID/SECRET', () => {
  assert.doesNotThrow(() => require('../src/config'));
  assert.doesNotThrow(() => require('../src/routes/auth'));
});

test('et token signeret med et tomt secret afvises', () => {
  const forged = jwt.sign({ scope: 'panel' }, 'x'); // hvilket som helst token
  assert.strictEqual(call({ headers: { authorization: 'Bearer ' + forged } }).status, 401);
  assert.throws(() => signSessionToken());
});

test('ADMIN_SECRET giver stadig adgang', () => {
  assert.strictEqual(call({ headers: { 'x-admin-secret': 'admin-test' } }).nextCalled, true);
});
