const Anthropic = require('@anthropic-ai/sdk');
const config = require('../config');

const anthropic = new Anthropic({ apiKey: config.anthropic.apiKey });

// ============================================================
// Samtaleanalyse med FAST skema.
// Claude tvinges til at kalde værktøjet `registrer_analyse`, så svaret
// altid har præcis de samme felter — det er forudsætningen for, at
// agenten (via Pipedrive-MCP) kan tælle og sammenligne på tværs af
// kunder og kundegrupper. Ændres skemaet: hæv SCHEMA_VERSION.
// ============================================================
const SCHEMA_VERSION = 1;

const strList = (description) => ({ type: 'array', items: { type: 'string' }, description });
const nullableStr = (description) => ({ type: ['string', 'null'], description });

const ANALYSIS_TOOL = {
  name: 'registrer_analyse',
  description: 'Registrér den strukturerede analyse af samtalen. Kun oplysninger der faktisk fremgår af samtalen — ellers null eller tom liste.',
  input_schema: {
    type: 'object',
    properties: {
      summary: { type: 'string', description: '2-4 sætninger i datid på korrekt dansk om hvad samtalen handlede om.' },
      action_points: strList('Konkrete handlinger: hvem gør hvad og hvornår.'),
      topics: strList('Korte emneord.'),

      // --- Virksomhedsprofil ---
      faggruppe: nullableStr('Kundens fag/branche med ét kort ord, fx "maler", "tømrer", "anlægsgartner", "VVS", "el", "tagdækker", "facaderens". null hvis ukendt.'),
      antal_medarbejdere: { type: ['integer', 'null'], description: 'Antal ansatte hvis nævnt, ellers null.' },

      // --- Systemer (kan være ét og samme system) ---
      driftssystem: nullableStr('Nuværende drifts-/sagsstyringssystem (fx Apacta, Ordrestyring, Minuba, e-regnskab, Excel, papir). null hvis ikke nævnt.'),
      regnskabsprogram: nullableStr('Nuværende regnskabsprogram (fx e-conomic, Dinero, Billy, Uniconta). Er det samme system som driftssystemet, skriv navnet igen. null hvis ikke nævnt.'),
      loenprogram: nullableStr('Nuværende lønprogram (fx Danløn, Zenegy, Salary, Proløn). Er det samme system som et af ovenstående, skriv navnet igen. null hvis ikke nævnt.'),
      andre_systemer: strList('Øvrige systemer/værktøjer der nævnes (tidsregistrering, CRM, planlægning osv.).'),

      konkurrenter: {
        type: 'array',
        description: 'Konkurrerende løsninger kunden bruger, har set på eller nævner.',
        items: {
          type: 'object',
          properties: {
            navn: { type: 'string' },
            forhold: { type: 'string', enum: ['bruger_i_dag', 'har_brugt', 'overvejer', 'naevnt'] },
          },
          required: ['navn', 'forhold'],
        },
      },
      koebskanaler: strList('Hvordan kunden køber og finder løsninger: fx anbefaling fra kollega, brancheforening, grossist, revisor, Google, messe, LinkedIn, vi ringede op.'),

      // --- Salgssignaler ---
      udfordringer: strList('Kundens udfordringer/frustrationer i hverdagen.'),
      indvendinger: strList('Indvendinger mod at købe.'),
      koebssignaler: strList('Positive købssignaler.'),
      naeste_skridt: strList('Aftalte næste skridt.'),

      call_type: { type: 'string', enum: ['demo', 'onboarding', 'support', 'sales', 'follow_up', 'unknown'] },
      sentiment: { type: 'string', enum: ['positive', 'neutral', 'negative'] },
      call_outcome: { type: 'string', enum: ['interested', 'not_interested', 'meeting_booked', 'deal_closed', 'needs_follow_up', 'no_answer'] },
      customer_stage: { type: 'string', enum: ['lead', 'qualified', 'demo_done', 'proposal_sent', 'negotiation', 'closed_won', 'closed_lost'] },
      engagement_score: { type: 'integer', minimum: 1, maximum: 10 },
      conversion_likelihood: { type: 'integer', minimum: 1, maximum: 10 },
      ai_coaching_note: { type: 'string', description: '1-2 sætninger med konkret feedback til sælgeren.' },
    },
    required: [
      'summary', 'action_points', 'topics',
      'faggruppe', 'antal_medarbejdere', 'driftssystem', 'regnskabsprogram', 'loenprogram',
      'andre_systemer', 'konkurrenter', 'koebskanaler',
      'udfordringer', 'indvendinger', 'koebssignaler', 'naeste_skridt',
      'call_type', 'sentiment', 'call_outcome', 'customer_stage',
      'engagement_score', 'conversion_likelihood', 'ai_coaching_note',
    ],
  },
};

async function analyzeCall({ transcription, contactName = 'kunden', direction = 'outgoing' }) {
  const directionText = direction === 'outgoing' ? 'udgående opkald til' : 'indgående opkald fra';

  const prompt = `Du er salgsanalytiker for Zalye, en dansk softwarevirksomhed der bygger en driftsplatform til håndværkerbranchen.

Du har modtaget en transskription af et ${directionText} ${contactName}. Transskriptionen er opdelt i "Sælger:" og "Kunde:"-linjer (opdelingen kan være upræcis).

Registrér analysen med værktøjet registrer_analyse.

Regler:
- Skriv på korrekt dansk med æ, ø, å.
- Kun oplysninger der faktisk fremgår af samtalen. Gæt aldrig et system, en konkurrent eller et antal — brug null eller tom liste.
- Systemnavne staves som producenten gør (Apacta, e-conomic, Danløn). Ret åbenlyse fejlhøringer ud fra kontekst (fx "Sally" → "Zalye").
- Zalye selv er aldrig en konkurrent.
- action_points og naeste_skridt skal være konkrete — ikke vage.

TRANSSKRIPTION:
${transcription}`;

  const message = await anthropic.messages.create({
    model: config.anthropic.model,
    max_tokens: 4096,
    tools: [ANALYSIS_TOOL],
    tool_choice: { type: 'tool', name: ANALYSIS_TOOL.name },
    messages: [{ role: 'user', content: prompt }],
  });

  const toolUse = message.content.find((b) => b.type === 'tool_use' && b.name === ANALYSIS_TOOL.name);
  if (!toolUse) throw new Error('Claude returnerede ingen struktureret analyse (stop_reason: ' + message.stop_reason + ')');
  const a = toolUse.input || {};
  const arr = (v) => (Array.isArray(v) ? v : []);

  return {
    schemaVersion: SCHEMA_VERSION,

    // Basis
    summary: a.summary || '',
    actionPoints: arr(a.action_points),
    topics: arr(a.topics),

    // Virksomhedsprofil + systemer
    profile: {
      schemaVersion: SCHEMA_VERSION,
      faggruppe: a.faggruppe || null,
      antalMedarbejdere: Number.isInteger(a.antal_medarbejdere) ? a.antal_medarbejdere : null,
      driftssystem: a.driftssystem || null,
      regnskabsprogram: a.regnskabsprogram || null,
      loenprogram: a.loenprogram || null,
      andreSystemer: arr(a.andre_systemer),
      konkurrenter: arr(a.konkurrenter),
      koebskanaler: arr(a.koebskanaler),
    },

    // Sales intelligence (samme nøgler som før → call_insights-tabellen)
    callType: a.call_type || 'unknown',
    sentiment: a.sentiment || null,
    callOutcome: a.call_outcome || null,
    painPoints: arr(a.udfordringer),
    objections: arr(a.indvendinger),
    buyingSignals: arr(a.koebssignaler),
    competitorMentions: arr(a.konkurrenter).map((k) => k.navn + ' (' + k.forhold + ')'),
    nextSteps: arr(a.naeste_skridt),
    customerStage: a.customer_stage || null,
    engagementScore: a.engagement_score || null,
    conversionLikelihood: a.conversion_likelihood || null,
    aiCoachingNote: a.ai_coaching_note || null,
  };
}

module.exports = { analyzeCall, SCHEMA_VERSION };
