const Anthropic = require('@anthropic-ai/sdk');
const config = require('../config');

const anthropic = new Anthropic({ apiKey: config.anthropic.apiKey });

// ============================================================
// Analysér en samtaletransskription og returner:
//   summary:      Kort resumé (2-4 sætninger)
//   actionPoints: Array af konkrete handlingspunkter
//   topics:       Array af emner der blev diskuteret
// + Sales intelligence felter til coaching og analyse
// ============================================================
async function analyzeCall({ transcription, contactName = 'kunden', direction = 'outgoing' }) {
  const directionText = direction === 'outgoing' ? 'udgående opkald til' : 'indgående opkald fra';

  const prompt = `Du er salgs-intelligence assistent for Zalye, en dansk softwarevirksomhed der bygger en platform til håndværkerbranchen.
Du har modtaget transskriptionen af et ${directionText} ${contactName}.

Analyser samtalen og returner et JSON-objekt med præcis disse felter:

{
  "summary": "2-4 sætninger der opsummerer hvad samtalen handlede om. Skriv i datid.",
  "action_points": ["Konkret handling (hvem gør hvad)", "..."],
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

  "ai_coaching_note": "1-2 sætninger med konkret feedback til sælgeren. Hvad gik godt? Hvad kunne forbedres?"
}

Regler:
- Skriv ALTID på dansk
- action_points skal være konkrete og actionable - ikke vage
- pain_points: Kun ting kunden faktisk sagde eller antydede. Gæt ikke.
- objections: Kun reelle indvendinger. "For dyrt", "har ikke tid" osv.
- buying_signals: Ting som "hvad koster det?", "kan I starte i næste uge?" osv.
- engagement_score (1-10): Baseret på hvor aktiv og interesseret kunden lød
- conversion_likelihood (1-10): Baseret på helheden af samtalen
- ai_coaching_note: Vær specifik og konstruktiv. Fx "God behovsafdækning, men glemte at spørge til budget"
- Hvis et felt ikke er relevant, brug tom array [] eller null
- Returner KUN det rene JSON-objekt, ingen markdown, ingen forklaring

TRANSSKRIPTION:
${transcription}`;

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2048,
    messages: [{ role: 'user', content: prompt }],
  });

  const raw = message.content[0].text.trim();

  // Parse JSON - håndter tilfælde hvor Claude tilføjer markdown
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error(`Claude returnerede ikke gyldigt JSON: ${raw.substring(0, 200)}`);
  }

  const parsed = JSON.parse(jsonMatch[0]);

  return {
    // Basis (som før)
    summary:      parsed.summary || '',
    actionPoints: Array.isArray(parsed.action_points) ? parsed.action_points : [],
    topics:       Array.isArray(parsed.topics) ? parsed.topics : [],

    // Sales intelligence (nyt)
    callType:              parsed.call_type || 'unknown',
    sentiment:             parsed.sentiment || null,
    callOutcome:           parsed.call_outcome || null,
    painPoints:            Array.isArray(parsed.pain_points) ? parsed.pain_points : [],
    objections:            Array.isArray(parsed.objections) ? parsed.objections : [],
    buyingSignals:         Array.isArray(parsed.buying_signals) ? parsed.buying_signals : [],
    competitorMentions:    Array.isArray(parsed.competitor_mentions) ? parsed.competitor_mentions : [],
    nextSteps:             Array.isArray(parsed.next_steps) ? parsed.next_steps : [],
    customerStage:         parsed.customer_stage || null,
    engagementScore:       parsed.engagement_score || null,
    conversionLikelihood:  parsed.conversion_likelihood || null,
    aiCoachingNote:        parsed.ai_coaching_note || null,
  };
}

module.exports = { analyzeCall };
