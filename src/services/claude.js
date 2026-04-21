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

  const starterText = direction === 'outgoing'
    ? 'Da det er et udgående opkald, er det sælgeren der starter samtalen.'
    : 'Da det er et indgående opkald, er det kunden der starter samtalen.';

  const prompt = `Du er salgs-intelligence assistent for Zalye, en dansk softwarevirksomhed der bygger en platform til håndværkerbranchen.

Du har modtaget en rå transskription af et ${directionText} ${contactName}. Transskriptionen kan indeholde stavefejl, manglende tegnsætning og fejlhørte ord — du skal rense og fortolke den intelligent på dansk.

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
- Ret åbenlyse stavefejl og fejlhørte ord baseret på kontekst (fx "Sally" → "Zalye", "håndværker" hvis konteksten er klar)
- action_points: Konkrete og actionable — ikke vage. Inkluder hvem og hvornår når det fremgår.
- pain_points: Kun ting kunden faktisk sagde eller antydede. Gæt ikke.
- objections: Kun reelle indvendinger.
- buying_signals: Ting som "hvad koster det?", "kan I starte i næste uge?", "send mig et tilbud".
- engagement_score (1-10): Baseret på hvor aktiv og interesseret kunden lød.
- conversion_likelihood (1-10): Baseret på helheden af samtalen.
- ai_coaching_note: Vær specifik og konstruktiv.

DIARIZED_TRANSCRIPTION (vigtigt):
- Opdel HELE samtalen i replikker, hver linje starter med enten "Sælger:" eller "Kunde:" (skriv ord bogstavet i æ/ø).
- ${starterText}
- Skift afsender hver gang taleren skifter — vurder ud fra indhold, tone og kontekst.
- Bevar det originale indhold så præcist som muligt, men ret stavefejl og indsæt naturlig tegnsætning.
- Brug linjeskift mellem replikker (\\n).
- IKKE punkttegn ("- "), tidsstempler eller noget andet før "Sælger:"/"Kunde:".

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
