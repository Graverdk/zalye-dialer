require('dotenv').config();

const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`Manglende miljovariabel: ${name}. Tjek din .env fil.`);
  return value;
};

const optional = (name, defaultValue = '') => process.env[name] || defaultValue;

module.exports = {
  port: parseInt(optional('PORT', '3000')),
  appUrl: optional('APP_URL', 'http://localhost:3000'),

  relatel: {
    baseUrl: 'https://app.relatel.dk/api/v2',
    accessToken: required('RELATEL_ACCESS_TOKEN'),
  },

  anthropic: {
    apiKey: required('ANTHROPIC_API_KEY'),
  },

  elevenlabs: {
    // Bruges til tale-til-tekst (Scribe) med indbygget speaker diarization
    apiKey: required('ELEVENLABS_API_KEY'),
  },


  pipedrive: {
    apiToken: required('PIPEDRIVE_API_TOKEN'),
    clientId: required('PIPEDRIVE_CLIENT_ID'),
    clientSecret: required('PIPEDRIVE_CLIENT_SECRET'),
    domain: optional('PIPEDRIVE_COMPANY_DOMAIN', 'app'),
    get baseUrl() {
      return `https://${this.domain}.pipedrive.com/api/v1`;
    },
  },

  db: {
    path: optional('DB_PATH', './data/zalye.db'),
  },

  security: {
    // Pipedrive signerer panel-JWT'er med app'ens "JWT secret" hvis sat i
    // Developer Hub — ellers med client_secret. Skal matche her.
    panelJwtSecret: optional('PIPEDRIVE_JWT_SECRET', ''),
    // Beskytter debug-/vedligeholdelses-endpoints. Uden denne er de deaktiveret.
    adminSecret: optional('ADMIN_SECRET', ''),
    // Hvis sat: Relatel-webhook skal kalde /api/webhook/relatel?secret=<denne>
    webhookSecret: optional('WEBHOOK_SECRET', ''),
  },

  pollIntervalSeconds: parseInt(optional('POLL_INTERVAL_SECONDS', '30')),
};
