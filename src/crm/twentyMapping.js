// ============================================================
// ALLE Twenty-navne ét sted: objekter, felter og option-værdier, plus
// funktionerne der oversætter dialerens analyse/coaching til dem.
//
// Kilde: dialer-plan.md (kortlægning af crm.zalye.si efter importen 9/11
// 2026). Ingen af værdierne er slået op i Twenty af denne PR — de er
// opdelt i to grupper:
//   PLAN   = står ordret i planen (navne set i Twenty-modellen)
//   GÆT    = afledt af planen, men ikke set; tjek før CRM_MODE=dual
// Dialeren henter desuden Twentys metadata (felter + options) ved første
// skrivning og dropper felter/værdier, der ikke findes, med en advarsel i
// loggen ("[Twenty] Ukendt …"). Et forkert gæt giver derfor et tomt felt,
// aldrig et afvist kald. Se twentyMeta.js.
// ============================================================

// ---- Objekter (REST-stier: /rest/<plural>) --------------------------
const OBJECTS = {
  person: 'people',              // standard
  company: 'companies',          // standard
  opportunity: 'opportunities',  // standard
  task: 'tasks',                 // standard
  samtale: 'samtaler',           // PLAN
  signal: 'signaler',            // PLAN (batch: /rest/batch/signaler)
  onboarding: 'onboardinger',    // PLAN
  moedebooker: 'moedebookere',   // GÆT (planen nævner kun objektet "moedebooker")
};

// ---- Felter --------------------------------------------------------
const PERSON = {
  telefon8: 'telefon8',                 // PLAN — de sidste 8 cifre
  phones: 'phones',                     // standard (primaryPhoneNumber, additionalPhones)
  rolle: 'rolle',                       // PLAN
};
const COMPANY = {
  employees: 'employees',               // standard
  branche: 'branche',                   // PLAN (MULTI_SELECT)
  driftssystem: 'driftssystem',         // PLAN
  regnskabsprogram: 'regnskabsprogram', // PLAN
  lonprogram: 'lonprogram',             // PLAN
};
const OPPORTUNITY = {
  stage: 'stage',
  companyId: 'companyId',
  pointOfContactId: 'pointOfContactId',
  booketAfId: 'booketAfId',             // PLAN (relation til moedebooker)
  anledning: 'anledning',               // PLAN
  primaerSmerte: 'primaerSmerte',       // PLAN
  indvending: 'indvending',             // PLAN (tekst)
  konsekvens: 'konsekvens',             // PLAN (tekst)
  konsekvensTimerUge: 'konsekvensTimerUge', // PLAN (tal)
};
const ONBOARDING = {
  virksomhedId: 'virksomhedId',         // PLAN
  fase: 'fase',                         // PLAN
};
const MOEDEBOOKER = {
  relatelBruger: 'relatelBruger',       // PLAN — matches mod Relatel employee_number
};
// Samtale: alle felter fra planens afsnit 4–5
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
  type: 'signaltype',                   // GÆT — planen skriver kun "Signal INDVENDING" osv.
  tekst: 'tekst',                       // GÆT
  samtaleId: 'samtaleId',               // PLAN
  virksomhedId: 'virksomhedId',         // PLAN
  salgsmulighedId: 'salgsmulighedId',   // PLAN
  status: 'status',                     // PLAN
  forslag: 'forslag',                   // PLAN
  forslagFelt: 'forslagFelt',           // PLAN
  forslagVaerdi: 'forslagVaerdi',       // PLAN
};

// ---- Option-værdier ------------------------------------------------
const SAMTALETYPE = { OPKALD: 'OPKALD', SMS: 'SMS', NOTE: 'NOTE' };          // PLAN
const RETNING = { UD: 'UD', IND: 'IND' };                                    // PLAN
const KILDE = { DIALER: 'DIALER' };                                          // PLAN
const UDFALD = {                                                             // PLAN
  IKKE_SVAR: 'IKKE_SVAR', MOEDE_BOOKET: 'MOEDE_BOOKET', IKKE_INTERESSERET: 'IKKE_INTERESSERET',
  RING_IGEN: 'RING_IGEN', FORKERT_NUMMER: 'FORKERT_NUMMER',
};
const MODETYPE = {                                                           // PLAN
  BOOKING_KALD: 'BOOKING_KALD', M1_ANALYSE: 'M1_ANALYSE', M2_DEMO: 'M2_DEMO', OPFOELGNING: 'OPFOELGNING',
  M4_M7_OPSTART: 'M4_M7_OPSTART', SUPPORT: 'SUPPORT', PARTNER: 'PARTNER',
};
const TEMPERATUR = { VARM: 'VARM', LUN: 'LUN', KOLD: 'KOLD' };               // GÆT (opgaven nævner den som uverificeret)
const BLOK = {                                                               // PLAN
  anledning: 'ANLEDNING', situation: 'SITUATION', smerte: 'SMERTE',
  konsekvens: 'KONSEKVENS', beslutning: 'BESLUTNING', naeste_skridt: 'NAESTE_SKRIDT',
};
const STAGE = {                                                              // PLAN
  NY_LEAD: 'NY_LEAD', KVALIFICERET: 'KVALIFICERET', VENTER_PAA_DEMO_BOOKING: 'VENTER_PAA_DEMO_BOOKING',
  DEMO_BOOKET: 'DEMO_BOOKET', DEMO_HOLDT: 'DEMO_HOLDT', BESLUTNING: 'BESLUTNING', VUNDET: 'VUNDET',
};
// Åbne trin i rækkefølge (planen afsnit 4A)
const OPEN_STAGES = [STAGE.NY_LEAD, STAGE.KVALIFICERET, STAGE.VENTER_PAA_DEMO_BOOKING, STAGE.DEMO_BOOKET, STAGE.DEMO_HOLDT, STAGE.BESLUTNING];
// Dialeren må flytte til DEMO_BOOKET KUN fra disse (aldrig baglæns)
const STAGES_BEFORE_DEMO_BOOKET = OPEN_STAGES.slice(0, OPEN_STAGES.indexOf(STAGE.DEMO_BOOKET));
const ONBOARDING_STOPPET = 'STOPPET';                                        // PLAN
const SIGNAL_STATUS = { FORESLAAET: 'FORESLAAET' };                          // PLAN
const SIGNAL_FORSLAG = { UDFYLD_FELT: 'UDFYLD_FELT' };                       // PLAN
const SIGNAL_TYPE = {                                                        // GÆT (navne fra planens tekst)
  ANLEDNING: 'ANLEDNING', SMERTE: 'SMERTE', INDVENDING: 'INDVENDING',
  KONKURRENT: 'KONKURRENT', KUNDENS_ORD: 'KUNDENS_ORD',
};
const TASK_STATUS_TODO = 'TODO';                                             // standard

// Analysens kontakt_rolle → person.rolle (PLAN)
const ROLLE = {
  'ejer/direktør': 'EJER_DIREKTOER',
  'formand/projektleder': 'FORMAND_PROJEKTLEDER',
  'kontor/administration': 'KONTOR_ADMINISTRATION',
  'service-/driftschef': 'SERVICE_DRIFTSCHEF',
  'IT/økonomi': 'IT_OEKONOMI',
};
// Analysens anledning → opportunity.anledning (PLAN). "andet" sættes ikke.
const ANLEDNING = {
  'vækst/nye ansatte': 'VAEKST',
  'utilfreds med eller udløb af system': 'UTILFREDS_MED_SYSTEM',
  'fejl eller tab der gjorde ondt': 'FEJL_ELLER_TAB',
  'ejer- eller lederskifte': 'EJER_ELLER_LEDERSKIFTE',
  'nysgerrig på AI': 'NYSGERRIG_PAA_AI',
};
// Analysens primaer_smerte → opportunity.primaerSmerte (GÆT — planen siger kun "enum-match")
const PRIMAER_SMERTE = {
  'planlægning': 'PLANLAEGNING',
  'tilbud': 'TILBUD',
  'timer/løn': 'TIMER_LOEN',
  'fakturering': 'FAKTURERING',
  'dokumentation': 'DOKUMENTATION',
  'kommunikation/mail': 'KOMMUNIKATION_MAIL',
  'overblik/styring': 'OVERBLIK_STYRING',
};
// Faggruppe → company.branche (PLAN: kun de fem planen nævner. Andre fag
// matches mod Twentys egne options via metadata, ellers springes de over)
const BRANCHE_SYNONYMS = {
  maler: 'MALER', malermester: 'MALER',
  tømrer: 'TOEMRER_SNEDKER', snedker: 'TOEMRER_SNEDKER', tømrersnedker: 'TOEMRER_SNEDKER',
  anlæg: 'ANLAEG_HAVE', anlægsgartner: 'ANLAEG_HAVE', have: 'ANLAEG_HAVE', haveservice: 'ANLAEG_HAVE', anlæghave: 'ANLAEG_HAVE',
  vvs: 'VVS', vvser: 'VVS', blikkenslager: 'VVS',
  el: 'EL', elektriker: 'EL', elinstallatør: 'EL', elinstallation: 'EL',
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
// Jeppe selv ringer, og BOOKING_KALD, når en mødebooker ringer (GÆT på
// planens "eller M1_ANALYSE ved Jeppe-kald").
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
  TASK_STATUS_TODO, ROLLE, ANLEDNING, PRIMAER_SMERTE, BRANCHE_SYNONYMS,
  retning, varighedMin, modetype, udfald, isBooked, blokkeDaekket, temperatur,
  rolle, anledning, primaerSmerte, branche, timerPrUge, visNummer, norm,
};
