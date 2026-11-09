// ============================================================
// ALLE Twenty-navne ét sted: objekter, felter og option-værdier, plus
// funktionerne der oversætter dialerens analyse/coaching til dem.
//
// Kilde: verificeret live mod crm.zalye.si (workspace c7ba3e7a-…) 9/11 2026
// via Twentys metadata — se claude-rettelser-twenty-vaerdier.md. Alle
// objekter, felter og option-værdier herunder er bekræftet, medmindre der
// står andet ved linjen.
// Dialeren henter desuden Twentys metadata (felter + options) ved første
// skrivning og dropper felter/værdier, der ikke findes, med en advarsel i
// loggen ("[Twenty] Ukendt …"). En fremtidig ændring i Twenty giver derfor
// et tomt felt, aldrig et afvist kald. Se twentyMeta.js.
// ============================================================

// ---- Objekter (REST-stier: /rest/<plural>) --------------------------
const OBJECTS = {
  person: 'people',              // standard
  company: 'companies',          // standard
  opportunity: 'opportunities',  // standard
  task: 'tasks',                 // standard
  samtale: 'samtaler',
  signal: 'signaler',            // batch: /rest/batch/signaler
  onboarding: 'onboardings',     // engelsk plural (ikke "onboardinger")
  moedebooker: 'moedebookere',
};

// ---- Felter --------------------------------------------------------
const PERSON = {
  telefon8: 'telefon8',                 // TEXT «Telefon (8 cifre)»
  phones: 'phones',                     // PHONES (primaryPhoneNumber, additionalPhones)
  rolle: 'rolle',                       // SELECT
};
const COMPANY = {
  employees: 'employees',               // NUMBER
  branche: 'branche',                   // MULTI_SELECT
  driftssystem: 'driftssystem',         // MULTI_SELECT
  regnskabsprogram: 'regnskabsprogram', // MULTI_SELECT
  lonprogram: 'lonprogram',             // MULTI_SELECT (stavet uden «e»)
};
const OPPORTUNITY = {
  stage: 'stage',
  companyId: 'companyId',
  pointOfContactId: 'pointOfContactId',
  booketAfId: 'booketAfId',             // relation til moedebooker
  anledning: 'anledning',               // SELECT
  primaerSmerte: 'primaerSmerte',       // SELECT
  indvending: 'indvending',             // TEXT
  konsekvens: 'konsekvens',             // TEXT
  konsekvensTimerUge: 'konsekvensTimerUge', // NUMBER
};
const ONBOARDING = {
  virksomhedId: 'virksomhedId',
  fase: 'fase',                         // SELECT
};
const MOEDEBOOKER = {
  // TEXT. Matches mod Relatel employee_number. Formatet i feltet er ikke
  // bestemt endnu — koden sammenligner tekst og de sidste 8 cifre.
  relatelBruger: 'relatelBruger',
};
// Samtale. (optagelse er LINKS — { primaryLinkUrl } — og skrives ikke af dialeren)
const SAMTALE = {
  name: 'name',
  samtaletype: 'samtaletype',
  retning: 'retning',
  dato: 'dato',
  varighedMin: 'varighedMin',
  kilde: 'kilde',
  eksterntId: 'eksterntId',
  personId: 'personId',
  virksomhedId: 'virksomhedId',
  salgsmulighedId: 'salgsmulighedId',
  onboardingId: 'onboardingId',
  fortAfId: 'fortAfId',
  moedebookerId: 'moedebookerId',
  udfald: 'udfald',
  modetype: 'modetype',
  temperatur: 'temperatur',
  blokkeDaekket: 'blokkeDaekket',
  resume: 'resume',                     // RICH_TEXT ({ markdown })
  coachVurdering: 'coachVurdering',     // RICH_TEXT
  transskript: 'transskript',           // RICH_TEXT
};
const SIGNAL = {
  name: 'name',
  type: 'signaltype',                   // SELECT
  vaerdi: 'vaerdi',                     // TEXT (enum-værdi eller fritekst)
  citat: 'citat',                       // RICH_TEXT ({ markdown }) — kundens ordrette ord
  samtaleId: 'samtaleId',
  virksomhedId: 'virksomhedId',
  salgsmulighedId: 'salgsmulighedId',
  status: 'status',                     // SELECT
  forslag: 'forslag',                   // SELECT
  forslagFelt: 'forslagFelt',           // TEXT
  forslagVaerdi: 'forslagVaerdi',       // TEXT
};

// ---- Option-værdier ------------------------------------------------
// Twenty har også MOEDE, MAIL, BESKED — dialeren bruger kun disse tre
const SAMTALETYPE = { OPKALD: 'OPKALD', SMS: 'SMS', NOTE: 'NOTE' };
const RETNING = { UD: 'UD', IND: 'IND' };
const KILDE = { DIALER: 'DIALER' };                                          // (også FIREFLIES, PIPEDRIVE_IMPORT, MANUEL)
const UDFALD = {
  IKKE_SVAR: 'IKKE_SVAR', MOEDE_BOOKET: 'MOEDE_BOOKET', IKKE_INTERESSERET: 'IKKE_INTERESSERET',
  RING_IGEN: 'RING_IGEN', FORKERT_NUMMER: 'FORKERT_NUMMER',
};
const MODETYPE = {
  BOOKING_KALD: 'BOOKING_KALD', M1_ANALYSE: 'M1_ANALYSE', M2_DEMO: 'M2_DEMO', M3_BESLUTNING: 'M3_BESLUTNING',
  OPFOELGNING: 'OPFOELGNING', M4_M7_OPSTART: 'M4_M7_OPSTART', SUPPORT: 'SUPPORT', PARTNER: 'PARTNER',
};
const TEMPERATUR = { VARM: 'VARM', LUN: 'LUN', KOLD: 'KOLD' };
const BLOK = {
  anledning: 'ANLEDNING', situation: 'SITUATION', smerte: 'SMERTE',
  konsekvens: 'KONSEKVENS', beslutning: 'BESLUTNING', naeste_skridt: 'NAESTE_SKRIDT',
};
const STAGE = {
  NY_LEAD: 'NY_LEAD', KVALIFICERET: 'KVALIFICERET', VENTER_PAA_DEMO_BOOKING: 'VENTER_PAA_DEMO_BOOKING',
  DEMO_BOOKET: 'DEMO_BOOKET', DEMO_HOLDT: 'DEMO_HOLDT', BESLUTNING: 'BESLUTNING', VUNDET: 'VUNDET',
  TABT: 'TABT', PARKERET: 'PARKERET',
};
// Åbne trin i rækkefølge (planen afsnit 4A)
const OPEN_STAGES = [STAGE.NY_LEAD, STAGE.KVALIFICERET, STAGE.VENTER_PAA_DEMO_BOOKING, STAGE.DEMO_BOOKET, STAGE.DEMO_HOLDT, STAGE.BESLUTNING];
// Dialeren må flytte til DEMO_BOOKET KUN fra disse (aldrig baglæns)
const STAGES_BEFORE_DEMO_BOOKET = OPEN_STAGES.slice(0, OPEN_STAGES.indexOf(STAGE.DEMO_BOOKET));
const ONBOARDING_STOPPET = 'STOPPET';
const SIGNAL_STATUS = { FORESLAAET: 'FORESLAAET' };                          // (også GODKENDT, AFVIST — sættes i Twenty)
const SIGNAL_FORSLAG = { UDFYLD_FELT: 'UDFYLD_FELT' };                       // (også INGEN, TRINSKIFT, NAESTE_SKRIDT, MAILKLADDE)
// Signaltyper dialeren opretter. Der findes INGEN KONSEKVENS-type: konsekvens
// står i opportunity.konsekvens/konsekvensTimerUge. (Twenty har også
// FEATURE_OENSKE og SPOERGSMAAL, som dialeren ikke laver.)
const SIGNAL_TYPE = {
  ANLEDNING: 'ANLEDNING', SMERTE: 'SMERTE', INDVENDING: 'INDVENDING',
  KONKURRENT: 'KONKURRENT', KUNDENS_ORD: 'KUNDENS_ORD',
};
const TASK_STATUS_TODO = 'TODO';

// Analysens kontakt_rolle → person.rolle
const ROLLE = {
  'ejer/direktør': 'EJER_DIREKTOER',
  'formand/projektleder': 'FORMAND_PROJEKTLEDER',
  'kontor/administration': 'KONTOR_ADMINISTRATION',
  'service-/driftschef': 'SERVICE_DRIFTSCHEF',
  'IT/økonomi': 'IT_OEKONOMI',
};
// Analysens anledning → opportunity.anledning. "andet" sættes ikke.
const ANLEDNING = {
  'vækst/nye ansatte': 'VAEKST',
  'utilfreds med eller udløb af system': 'UTILFREDS_MED_SYSTEM',
  'fejl eller tab der gjorde ondt': 'FEJL_ELLER_TAB',
  'ejer- eller lederskifte': 'EJER_ELLER_LEDERSKIFTE',
  'nysgerrig på AI': 'NYSGERRIG_PAA_AI',
};
// Analysens primaer_smerte → opportunity.primaerSmerte
const PRIMAER_SMERTE = {
  'planlægning': 'PLANLAEGNING',
  'tilbud': 'TILBUD',
  'timer/løn': 'TIMER_LOEN',
  'fakturering': 'FAKTURERING',
  'dokumentation': 'DOKUMENTATION',
  'kommunikation/mail': 'MAIL',
  'overblik/styring': 'OVERBLIK',
};
// Faggruppe (ét ord fra analysen, normaliseret) → company.branche.
// Ukendte fag springes over — dialeren sætter aldrig ANDET.
const BRANCHE_SYNONYMS = {
  maler: 'MALER', malermester: 'MALER',
  tømrer: 'TOEMRER_SNEDKER', snedker: 'TOEMRER_SNEDKER', tømrersnedker: 'TOEMRER_SNEDKER',
  anlæg: 'ANLAEG_HAVE', anlægsgartner: 'ANLAEG_HAVE', anlæghave: 'ANLAEG_HAVE',
  have: 'HAVESERVICE', haveservice: 'HAVESERVICE', havemand: 'HAVESERVICE',
  vvs: 'VVS', vvser: 'VVS',
  blik: 'BLIK', blikkenslager: 'BLIK',
  el: 'EL', elektriker: 'EL', elinstallatør: 'EL', elinstallation: 'EL',
  murer: 'MURER', murermester: 'MURER',
  tag: 'TAG', tagdækker: 'TAG', tagrens: 'TAG',
  gulv: 'GULVE', gulve: 'GULVE', gulvlægger: 'GULVE',
  vinduespudser: 'VINDUESPOLERING', vinduespolering: 'VINDUESPOLERING',
  kloak: 'KLOAK_ENTREPRENOER', kloakmester: 'KLOAK_ENTREPRENOER', entreprenør: 'KLOAK_ENTREPRENOER', kloakentreprenør: 'KLOAK_ENTREPRENOER',
  rengøring: 'RENGOERING_SERVICE',
  ejendomsservice: 'EJENDOMSSERVICE',
  isolatør: 'ISOLATOERER', isolering: 'ISOLATOERER',
  ventilation: 'VENTILATION',
  fliserens: 'FLISERENS',
  algerens: 'ALGERENS',
  skadeservice: 'SKADESERVICES',
  overfladebehandling: 'OVERFLADEBEHANDLING',
};
// Systemnavne fra analysen (normaliseret) → company.driftssystem /
// regnskabsprogram / lonprogram (alle MULTI_SELECT). Ukendt → springes over.
const DRIFTSSYSTEM = {
  apacta: 'APACTA', ekomplet: 'E_KOMPLET', eregnskab: 'E_REGNSKAB', eg: 'EG',
  excel: 'EXCEL_REGNEARK', regneark: 'EXCEL_REGNEARK', fenster: 'FENSTER', kala: 'KALA',
  minuba: 'MINUBA', mobilplan: 'MOBILPLAN', ordrestyring: 'ORDRESTYRING_DK', ordrestyringdk: 'ORDRESTYRING_DK',
  papir: 'PAPIR_MANUELT', manuelt: 'PAPIR_MANUELT', manuel: 'PAPIR_MANUELT',
};
const REGNSKABSPROGRAM = {
  dinero: 'DINERO', economic: 'E_CONOMIC', ekomplet: 'E_KOMPLET', eregnskab: 'E_REGNSKAB',
  uniconta: 'UNICONTA', billy: 'BILLY', visma: 'VISMA_ANDET_ERP', navision: 'VISMA_ANDET_ERP',
  businesscentral: 'VISMA_ANDET_ERP',
};
const LONPROGRAM = {
  danløn: 'DANLOEN', dataløn: 'DATALOEN_VISMA', datalønvisma: 'DATALOEN_VISMA', zenegy: 'ZENEGY',
  salary: 'SALARY', proløn: 'PROLOEN', lessor: 'LESSOR', intect: 'INTECT',
  economicløn: 'E_CONOMIC_LOEN',
};

// ============================================================
// Oversættelser
// ============================================================
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9æøå]/g, '');

function retning(direction) {
  return direction === 'outgoing' ? RETNING.UD : RETNING.IND;
}

// Hele minutter, mindst 1 for et kald med taletid; 0 for et kald uden
function varighedMin(sec) {
  if (sec === null || sec === undefined || !Number.isFinite(Number(sec))) return null;
  const s = Number(sec);
  if (s <= 0) return 0;
  return Math.max(1, Math.round(s / 60));
}

// coaching.moedetype → modetype. Første kald/Genopkald er M1_ANALYSE, når
// Jeppe selv ringer, og BOOKING_KALD, når en mødebooker ringer (planens
// "eller M1_ANALYSE ved Jeppe-kald"; værdierne er verificeret, reglen er en
// fortolkning). M3_BESLUTNING sættes ikke automatisk.
function modetype(moedetypeDa, { byMoedebooker = false } = {}) {
  switch (moedetypeDa) {
    case 'Første kald':
    case 'Genopkald':
      return byMoedebooker ? MODETYPE.BOOKING_KALD : MODETYPE.M1_ANALYSE;
    case 'Omstilling': return MODETYPE.BOOKING_KALD;
    case 'Demo': return MODETYPE.M2_DEMO;
    case 'Opfølgning': return MODETYPE.OPFOELGNING;
    case 'Opstart': return MODETYPE.M4_M7_OPSTART;
    case 'Support': return MODETYPE.SUPPORT;
    case 'Partner': return MODETYPE.PARTNER;
    default: return null;
  }
}

// coaching.udfald / analysis.callOutcome / ubesvaret → udfald.
// FORKERT_NUMMER sættes kun manuelt i Twenty.
function udfald({ coachingUdfald, callOutcome, isUnanswered } = {}) {
  if (isUnanswered || coachingUdfald === 'ingen kontakt' || callOutcome === 'no_answer') return UDFALD.IKKE_SVAR;
  if (coachingUdfald === 'booket' || callOutcome === 'meeting_booked') return UDFALD.MOEDE_BOOKET;
  if (coachingUdfald === 'tabt med årsag' || callOutcome === 'not_interested') return UDFALD.IKKE_INTERESSERET;
  if (['parkeret med dato', 'uafklaret'].includes(coachingUdfald) || callOutcome === 'needs_follow_up') return UDFALD.RING_IGEN;
  return null;
}

function isBooked({ coachingUdfald, callOutcome } = {}) {
  return coachingUdfald === 'booket' || callOutcome === 'meeting_booked';
}

// Kun blokke der er "dækket" (ikke "delvist")
function blokkeDaekket(blokke) {
  if (!blokke || typeof blokke !== 'object') return [];
  return Object.keys(BLOK).filter((b) => blokke[b] === 'dækket').map((b) => BLOK[b]);
}

// conversionLikelihood + sentiment → temperatur
function temperatur({ conversionLikelihood, sentiment, callOutcome } = {}) {
  const cl = Number.isFinite(Number(conversionLikelihood)) && conversionLikelihood !== null ? Number(conversionLikelihood) : null;
  if (cl !== null && cl >= 7) return TEMPERATUR.VARM;
  if (cl !== null && cl <= 3) return TEMPERATUR.KOLD;
  if (sentiment === 'negative') return TEMPERATUR.KOLD;
  if (sentiment === 'positive' && callOutcome === 'interested') return TEMPERATUR.VARM;
  if (cl !== null) return TEMPERATUR.LUN;
  return null;
}

function rolle(kontaktRolle) {
  return ROLLE[kontaktRolle] || null;
}
function anledning(a) {
  return ANLEDNING[a] || null;
}
function primaerSmerte(s) {
  return PRIMAER_SMERTE[s] || null;
}
function branche(faggruppe) {
  return BRANCHE_SYNONYMS[norm(faggruppe)] || null;
}
function driftssystem(v) { return DRIFTSSYSTEM[norm(v)] || null; }
function regnskabsprogram(v) { return REGNSKABSPROGRAM[norm(v)] || null; }
function lonprogram(v) { return LONPROGRAM[norm(v)] || null; }

// "10 timer om ugen" → 10. Kun når teksten tydeligt siger timer pr. uge.
function timerPrUge(konsekvens) {
  for (const t of Array.isArray(konsekvens) ? konsekvens : [konsekvens]) {
    const m = String(t || '').match(/(\d+(?:[.,]\d+)?)\s*(?:timer|t\.?)\s*(?:om|pr\.?|per|i)\s*(?:ugen|uge)\b/i);
    if (m) return Math.round(Number(m[1].replace(',', '.')));
  }
  return null;
}

// Tal på 8 cifre til visning: "+45 12 34 56 78"
function visNummer(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  const l8 = d.slice(-8);
  if (l8.length < 8) return String(phone || '');
  const cc = d.length > 8 ? '+' + d.slice(0, -8) + ' ' : '';
  return cc + l8.replace(/(\d{2})(?=\d)/g, '$1 ');
}

module.exports = {
  OBJECTS, PERSON, COMPANY, OPPORTUNITY, ONBOARDING, MOEDEBOOKER, SAMTALE, SIGNAL,
  SAMTALETYPE, RETNING, KILDE, UDFALD, MODETYPE, TEMPERATUR, BLOK, STAGE, OPEN_STAGES,
  STAGES_BEFORE_DEMO_BOOKET, ONBOARDING_STOPPET, SIGNAL_STATUS, SIGNAL_FORSLAG, SIGNAL_TYPE,
  TASK_STATUS_TODO, ROLLE, ANLEDNING, PRIMAER_SMERTE, BRANCHE_SYNONYMS, DRIFTSSYSTEM, REGNSKABSPROGRAM, LONPROGRAM,
  retning, varighedMin, modetype, udfald, isBooked, blokkeDaekket, temperatur,
  rolle, anledning, primaerSmerte, branche, driftssystem, regnskabsprogram, lonprogram, timerPrUge, visNummer, norm,
};
