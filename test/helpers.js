// Fælles opsætning for tests: falske miljøvariabler og en midlertidig database,
// så config.js og database.js kan indlæses uden rigtige nøgler.
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dialer-test-'));
const defaults = {
  RELATEL_ACCESS_TOKEN: 'test',
  ANTHROPIC_API_KEY: 'test',
  ELEVENLABS_API_KEY: 'test',
  PIPEDRIVE_API_TOKEN: 'test',
  PIPEDRIVE_CLIENT_ID: 'test',
  PIPEDRIVE_CLIENT_SECRET: 'test',
  PIPEDRIVE_COMPANY_DOMAIN: 'test',
  DB_PATH: path.join(dir, 'app.db'),
  ALERT_WEBHOOK_URL: '',
};
for (const [k, v] of Object.entries(defaults)) process.env[k] = v;

function tmpDbPath(name) {
  return path.join(dir, name + '-' + Math.random().toString(36).slice(2) + '.db');
}

const quiet = { log() {}, error() {}, warn() {} };

module.exports = { tmpDbPath, quiet };
