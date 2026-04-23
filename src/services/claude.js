const Anthropic = require('@anthropic-ai/sdk');
const config = require('../config');

const anthropic = new Anthropic({ apiKey: config.anthropic.apiKey });

// ============================================================
// Analyser en samtaletransskription og returner:
// summary, actionPoints, topics, sales intelligence
// + diarizedTranscription: Samtale opdelt i Sælger/Kunde
// ============================================================
async function analyzeCall({ transcription, contactName = 'kunden', direction = 'outgoing' }) {
  const directionText = direction === 'outgoing'
    ? 'udgående opkald til'
    : 'indgående opkald fra';

  // Hvem taler FØRST i lydoptagelsen = hvem tager telefonen:
  // - Udgående (vi ringer ud): kunden tager telefonen → kunden taler først
  // - Indgående (kunden ringer): vi tager telefonen → sælgeren taler først
  const starterText = direction === 'outgoing'
    ? 'Da det er et udgående opkald (vi ringer ud), er det kunden der tager telefonen og derfor taler først. Sælgeren svarer ved at præsentere sig.'
    : 'Da det er et indgående opkald (kunden ringer til os), er det sælgeren der tager telefonen og derfor taler først. Kunden præsenterer sig derefter.';

  const prompt = `Du er salgs-intelligence assistent for Zalye, en dansk softwarevirksomhed der bygger en platform til håndværkerbranchen.

Du har modtaget en transskription af et ${directionText} ${contactName}. ${starterText}
Transskriptionen kan allerede være opdelt i "Sælger:" og "Kunde:" linjer fra automatisk speaker-diarization — brug den opdeling hvis den er der.

Returner ét rent JSON-objekt med præcis disse felter:

{
  "summary": "2-4 sætninger der opsummerer hvad samtalen handlede om. Skriv i datid på korrekt dansk.",
  "action_points": ["Konkret handling (hvem gør hvad og hvornår)", "..."],
  "topics": ["emne1", "emne2"],
  "call_type": "demo | onboarding | support | sales | follow_up | unknown",
  "sentiment": "positive | neutral | negative",
  "call_outcome": "interested | not_interested | meeting_booked | deal_closed | needs_follow_up | no_answer",
  "pain_points": ["Kundens problemer/frustrationer der kom frem i samtalen"],
  "objections": ["Indvendinger kunden havde mod køb/tilmelding"],
  "buying_signals": ["Positive signaler der tyder på interesse"],
  "competitor_mentions": ["Andre systemer/løsninger kunden nævnte"],
  "next_steps": ["Konkrete næste skridt aftalt i samtalen"],
  "customer_stage": "lead | qualified | demo_done | proposal_sent | negotiation | closed_won | closed_lost",
  "engagement_score": 7,
  "conversion_likelihood": 6,
  "ai_coaching_note": "1-2 sætninger med konkret feedback til sælgeren. Hvad gik godt? Hvad kunne forbedres?",
  "diarized_transcription": "Sælger: Hej, det er Jeppe fra Zalye...\\nKunde: Ja hej, hvad drejer det sig om?\\nSælger: ..."
}

Regler:
- Skriv ALTID på korrekt dansk med æ, ø, å (aldrig "ae", "oe", "aa")
- Ret åbenlyse stavefejl og fejlhørte ord baseret på kontekst (fx "Sally" → "Zalye", "Jeppe" hvis konteksten er klar)
- action_points: Konkrete og actionable — ikke vage. Inkluder hvem og hvornår når det fremgår.
- pain_points: Kun ting kunden faktisk sagde eller antydede. Gæt ikke.
- objections: Kun reelle indvendinger.
- buying_signals: Ting som "hvad koster det?", "kan I starte i næste uge?", "send mig et tilbud".
- engagement_score (1-10): Baseret på hvor aktiv og interesseret kunden lød.
- conversion_likelihood (1-10): Baseret på helheden af samtalen.
- ai_coaching_note: Vær specifik og konstruktiv.

DIARIZED_TRANSCRIPTION:
- Hvis transskriptionen nedenfor ALLEREDE har "Sælger:" / "Kunde:" labels, bevar dem præcist som de er — bare rens tegnsætning og åbenlyse fejlhørte ord.
- Hvis ikke, opdel selv i "Sælger:" / "Kunde:" replikker. ${starterText}
- Brug linjeskift mellem replikker.

OUTPUT-FORMAT:
- Returner KUN det rene JSON-objekt — ingen markdown-code-fences, ingen forklaring før/efter.
- Hvis et felt ikke er relevant, brug tom array [] eller null.

TRANSSKRIPTION:
${transcription}`;

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    messages: [{ role: 'user', content: prompt }],
  });

  const raw = message.content[0].text.trim();

  // Parse JSON (tag det første { ... } match)
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error(`Claude returnerede ikke gyldigt JSON: ${raw.substring(0, 200)}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch (e) {
    throw new Error(`Kunne ikke parse Claude JSON: ${e.message}. Raw: ${raw.substring(0, 300)}`);
  }

  return {
    // Basis
    summary: parsed.summary || '',
    actionPoints: Array.isArray(parsed.action_points) ? parsed.action_points : [],
    topics: Array.isArray(parsed.topics) ? parsed.topics : [],

    // Sales intelligence
    callType: parsed.call_type || 'unknown',
    sentiment: parsed.sentiment || null,
    callOutcome: parsed.call_outcome || null,
    painPoints: Array.isArray(parsed.pain_points) ? parsed.pain_points : [],
    objections: Array.isArray(parsed.objections) ? parsed.objections : [],
    buyingSignals: Array.isArray(parsed.buying_signals) ? parsed.buying_signals : [],
    competitorMentions: Array.isArray(parsed.competitor_mentions) ? parsed.competitor_mentions : [],
    nextSteps: Array.isArray(parsed.next_steps) ? parsed.next_steps : [],
    customerStage: parsed.customer_stage || null,
    engagementScore: parsed.engagement_score || null,
    conversionLikelihood: parsed.conversion_likelihood || null,
    aiCoachingNote: parsed.ai_coaching_note || null,

    // Speaker diarization
    diarizedTranscription: parsed.diarized_transcription || null,
  };
}

module.exports = { analyzeCall };
