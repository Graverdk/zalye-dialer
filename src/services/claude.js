const Anthropic = require('@anthropic-ai/sdk');
const config = require('../config');

const anthropic = new Anthropic({ apiKey: config.anthropic.apiKey });

// ============================================================
// Analyser en samtaletransskription og returner:
// summary, actionPoints, topics, sales intelligence
// + diarizedTranscription: Samtale opdelt i Saelger/Kunde
// ============================================================
async function analyzeCall({ transcription, contactName = 'kunden', direction = 'outgoing' }) {
  const directionText = direction === 'outgoing'
    ? 'udgaaende opkald til'
    : 'indgaaende opkald fra';

  const prompt = `Du er salgs-intelligence assistent for Zalye, en dansk softwarevirksomhed der bygger en platform til haandvaerkerbranchen.

Du har modtaget transskriptionen af et ${directionText} ${contactName}.

Analyser samtalen og returner et JSON-objekt med praecis disse felter:

{
  "summary": "2-4 saetninger der opsummerer hvad samtalen handlede om. Skriv i datid.",
  "action_points": ["Konkret handling (hvem goer hvad)", "..."],
  "topics": ["emne1", "emne2"],
  "call_type": "demo | onboarding | support | sales | follow_up | unknown",
  "sentiment": "positive | neutral | negative",
  "call_outcome": "interested | not_interested | meeting_booked | deal_closed | needs_follow_up | no_answer",
  "pain_points": ["Kundens problemer/frustrationer der kom frem i samtalen"],
  "objections": ["Indvendinger kunden havde mod koeb/tilmelding"],
  "buying_signals": ["Positive signaler der tyder paa interesse"],
  "competitor_mentions": ["Andre systemer/loesninger kunden naevnte"],
  "next_steps": ["Konkrete naeste skridt aftalt i samtalen"],
  "customer_stage": "lead | qualified | demo_done | proposal_sent | negotiation | closed_won | closed_lost",
  "engagement_score": 7,
  "conversion_likelihood": 6,
  "ai_coaching_note": "1-2 saetninger med konkret feedback til saelgeren. Hvad gik godt? Hvad kunne forbedres?",
  "diarized_transcription": "- Saelger: Hej, det er Jeppe fra Zalye...\\n- Kunde: Ja hej, hvad drejer det sig om?\\n- Saelger: ..."
}

Regler:
- Skriv ALTID paa dansk
- action_points skal vaere konkrete og actionable - ikke vage
- pain_points: Kun ting kunden faktisk sagde eller antydede. Gaet ikke.
- objections: Kun reelle indvendinger.
- buying_signals: Ting som "hvad koster det?", "kan I starte i naeste uge?" osv.
- engagement_score (1-10): Baseret paa hvor aktiv og interesseret kunden loed
- conversion_likelihood (1-10): Baseret paa helheden af samtalen
- ai_coaching_note: Vaer specifik og konstruktiv
- diarized_transcription: Omskriv transskriptionen saa hver replik er markeret med enten "Saelger:" eller "Kunde:". ${direction === 'outgoing' ? 'Da det er et udgaaende opkald, er det saelgeren der starter samtalen.' : 'Da det er et indgaaende opkald, er det kunden der starter samtalen.'} Brug linjeformat med "- Saelger:" og "- Kunde:" foran hver replik. Bevar det originale indhold saa praecist som muligt, men opdel det i tydelige ture.
- Hvis et felt ikke er relevant, brug tom array [] eller null
- Returner KUN det rene JSON-objekt, ingen markdown, ingen forklaring

TRANSSKRIPTION:
${transcription}`;

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    messages: [{ role: 'user', content: prompt }],
  });

  const raw = message.content[0].text.trim();

  // Parse JSON
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error(`Claude returnerede ikke gyldigt JSON: ${raw.substring(0, 200)}`);
  }

  const parsed = JSON.parse(jsonMatch[0]);

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
