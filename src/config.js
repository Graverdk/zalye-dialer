require('dotenv').config();

const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`Manglende miljøvariabel: ${name}. Tjek din .env fil.`);
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

  pipedrive: {
    apiToken: required('PIPEDRIVE_API_TOKEN'),
    domain: optional('PIPEDRIVE_COMPANY_DOMAIN', 'app'),
    get baseUrl() {
      return `https://${this.domain}.pipedrive.com/api/v1`;
    },
  },

  db: {
    path: optional('DB_PATH', './data/zalye.db'),
  },

  pollIntervalSeconds: parseInt(optional('POLL_INTERVAL_SECONDS', '30')),
};
