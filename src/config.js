require('dotenv').config();

const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`Manglende miljovariabel: ${name}. Tjek din .env fil.`);
  return value;
};

const optional = (name, defaultValue = '') => process.env[name] || defaultValue;

// ============================================================
// CRM_MODE vælger hvor opkald, SMS og noter skrives hen:
//   pipedrive (standard) — som i dag, Twenty røres ikke
//   dual                 — Pipedrive er primær, Twenty skrives som skygge.
//                          Fejl i Twenty blokerer aldrig Pipedrive.
//   twenty               — Twenty er primær, Pipedrive røres ikke
// ============================================================
const CRM_MODES = ['pipedrive', 'dual', 'twenty'];
const crmMode = (() => {
  const raw = String(process.env.CRM_MODE || 'pipedrive').trim().toLowerCase();
  if (!CRM_MODES.includes(raw)) {
    throw new Error(`Ugyldig CRM_MODE "${raw}" — brug ${CRM_MODES.join(', ')}`);
  }
  return raw;
})();
const bool = (name, defaultValue) => {
  const v = process.env[name];
  if (v === undefined || v === '') return defaultValue;
  return !['false', '0', 'nej', 'no', 'off'].includes(String(v).trim().toLowerCase());
};
const int = (name, defaultValue) => {
  const n = parseInt(process.env[name], 10);
  return Number.isFinite(n) ? n : defaultValue;
};

module.exports = {
  port: parseInt(optional('PORT', '3000')),
  appUrl: optional('APP_URL', 'http://localhost:3000'),

  relatel: {
    baseUrl: 'https://app.relatel.dk/api/v2',
    accessToken: required('RELATEL_ACCESS_TOKEN'),
    // Vores hovednummer (landekode, ingen +/00) — bruges til at afgøre SMS-retning
    mainNumber: optional('RELATEL_MAIN_NUMBER', '4571747007').replace(/\D/g, ''),
  },

  anthropic: {
    apiKey: required('ANTHROPIC_API_KEY'),
    model: optional('CLAUDE_MODEL', 'claude-sonnet-5'),
  },

  elevenlabs: {
    // Bruges til tale-til-tekst (Scribe) med indbygget speaker diarization
    apiKey: required('ELEVENLABS_API_KEY'),
    model: optional('SCRIBE_MODEL', 'scribe_v2'),
  },


  crm: {
    mode: crmMode,
  },

  pipedrive: {
    // Påkrævet, medmindre CRM_MODE=twenty (så røres Pipedrive ikke)
    apiToken: crmMode === 'twenty' ? optional('PIPEDRIVE_API_TOKEN', '') : required('PIPEDRIVE_API_TOKEN'),
    // Kun til den gamle Pipedrive-app (panel i Pipedrive + OAuth-installation).
    // Appen er slettet 23/10, så de er valgfrie. Dataflowet bruger kun apiToken.
    clientId: optional('PIPEDRIVE_CLIENT_ID', ''),
    clientSecret: optional('PIPEDRIVE_CLIENT_SECRET', ''),
    domain: optional('PIPEDRIVE_COMPANY_DOMAIN', 'app'),
    get baseUrl() {
      return `https://${this.domain}.pipedrive.com/api/v1`;
    },
  },

  twenty: {
    // Selvhostet Twenty (REST). Nøglen laves i Twenty → Settings → APIs (egen nøgle til dialeren)
    apiUrl: optional('TWENTY_API_URL', 'https://crm.zalye.si').replace(/\/+$/, ''),
    // Påkrævet ved CRM_MODE=twenty. Ved dual uden nøgle slås skyggen fra (Pipedrive kører videre)
    apiKey: crmMode === 'twenty' ? required('TWENTY_API_KEY') : optional('TWENTY_API_KEY', ''),
    // Fuldt transskript i samtale.transskript (GDPR: tømmes natligt efter 12 mdr.)
    sendTranscript: bool('TWENTY_SEND_TRANSCRIPT', true),
    // Over denne længde afkortes transskriptet i Twenty (fuld tekst bliver i dialeren)
    transcriptMaxChars: int('TWENTY_TRANSCRIPT_MAX_CHARS', 100000),
    // Workspace member for Jeppe: fortAf på samtaler og modtager af opgaver
    // Standardejer: fortAf på samtaler uden mødebooker og modtager af opgaver.
    // TWENTY_JEPPE_MEMBER_ID er det gamle navn og virker stadig som fallback.
    defaultOwnerMemberId: optional('TWENTY_DEFAULT_OWNER_MEMBER_ID', '') || optional('TWENTY_JEPPE_MEMBER_ID', ''),
    jeppeMemberId: optional('TWENTY_DEFAULT_OWNER_MEMBER_ID', '') || optional('TWENTY_JEPPE_MEMBER_ID', ''),
    // Loft over Twenty-kald pr. kørsel (job-tick). Resten venter til næste kørsel
    maxCallsPerRun: int('TWENTY_MAX_CALLS_PER_RUN', 60),
    // Opgave ved ukendt nummer: minimumsvarighed (sek.) og modtager (standard Jeppe).
    // TWENTY_UNKNOWN_NUMBER_MIN_SEC=-1 slår opgaverne fra.
    unknownNumberMinSec: int('TWENTY_UNKNOWN_NUMBER_MIN_SEC', 25),
    unknownNumberAssigneeId: optional('TWENTY_UNKNOWN_NUMBER_ASSIGNEE_ID', '') || optional('TWENTY_DEFAULT_OWNER_MEMBER_ID', '') || optional('TWENTY_JEPPE_MEMBER_ID', ''),
    timeoutMs: int('TWENTY_TIMEOUT_MS', 15000),
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
    // Service-adgang for salgscoachen (header X-Service-Token) til at starte og
    // læse opkald. Tom = slået fra, og så ændrer intet sig.
    coachServiceToken: optional('COACH_SERVICE_TOKEN', ''),
    // Hvis sat: Relatel-webhook skal kalde /api/webhook/relatel?secret=<denne>
    webhookSecret: optional('WEBHOOK_SECRET', ''),
    // Signeringsnøglen Relatel viser når webhooken oprettes (Firmaadministration → Webhooks).
    // Når den er sat, afvises alt uden gyldig Relatel-Signature, og polling
    // skrues ned til et sikkerhedsnet hvert 15. minut.
    relatelWebhookSigningSecret: optional('RELATEL_WEBHOOK_SECRET', ''),
  },

  coaching: {
    // Den sælger, coachingen taler til, når kaldet ikke kan føres til en mødebooker
    defaultSellerName: optional('DEFAULT_SELLER_NAME', 'Jeppe'),
  },

  alerts: {
    // Hvor fejlalarmer sendes hen (Teams-workflow eller Make-webhook, der mailer
    // videre). Hemmelig: URL'en logges aldrig. Tom = alarmen står kun i loggen.
    webhookUrl: optional('ALERT_WEBHOOK_URL', ''),
    email: optional('ALERT_EMAIL', 'jg@zalye.dk'),
  },

  pollIntervalSeconds: parseInt(optional('POLL_INTERVAL_SECONDS', '30')),
};
