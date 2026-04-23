// ============================================================
// Transskription via ElevenLabs Scribe
// - Branchens bedste dansk-præcision
// - Indbygget speaker diarization (automatisk Sælger / Kunde)
// - Lydhændelser taggges (latter, pauser, musik)
// - Samme platform som Zalye bruger til TTS → ét setup, ét billing
// ============================================================

const fetch = require('node-fetch');
const FormData = require('form-data');
const config = require('../config');

const SCRIBE_URL = 'https://api.elevenlabs.io/v1/speech-to-text';

// Kontekst-prompt hjælper modellen med egennavne og fagtermer
const DANISH_BIASED_KEYWORDS = [
  'Zalye', 'Jeppe Graversen', 'Pipedrive', 'Relatel',
  'håndværker', 'malerfix', 'gulvfix', 'flextagservice',
  'demo', 'onboarding', 'abonnement', 'faktura', 'tilbud',
];

async function transcribe(audioBuffer, contentType = 'audio/mpeg', options = {}) {
  if (!config.elevenlabs || !config.elevenlabs.apiKey) {
    throw new Error('ELEVENLABS_API_KEY mangler — tilføj den i Railway Variables');
  }

  const { numSpeakers = 2 } = options;

  console.log('[Scribe] Sender ' + audioBuffer.length + ' bytes til ElevenLabs Scribe...');

  const ext = (() => {
    if (contentType.includes('mpeg') || contentType.includes('mp3')) return 'mp3';
    if (contentType.includes('wav')) return 'wav';
    if (contentType.includes('mp4') || contentType.includes('m4a')) return 'm4a';
    if (contentType.includes('ogg')) return 'ogg';
    if (contentType.includes('webm')) return 'webm';
    if (contentType.includes('flac')) return 'flac';
    return 'mp3';
  })();

  const form = new FormData();
  form.append('file', audioBuffer, { filename: 'call.' + ext, contentType });
  form.append('model_id', 'scribe_v1');
  form.append('language_code', 'dan'); // ISO 639-3 for dansk
  form.append('diarize', 'true');
  form.append('num_speakers', String(numSpeakers));
  form.append('tag_audio_events', 'true');
  form.append('timestamps_granularity', 'word');
  // Biased keywords hjælper Scribe genkende egennavne — sendes som bias_keywords
  form.append('bias_keywords', JSON.stringify(DANISH_BIASED_KEYWORDS));

  const res = await fetch(SCRIBE_URL, {
    method: 'POST',
    headers: {
      'xi-api-key': config.elevenlabs.apiKey,
      ...form.getHeaders(),
    },
    body: form,
    timeout: 180000, // Op til 3 min for lange samtaler
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error('ElevenLabs Scribe fejl ' + res.status + ': ' + errText.substring(0, 400));
  }

  const result = await res.json();
  const rawText = (result.text || '').trim();
  console.log('[Scribe] Modtaget (' + rawText.length + ' tegn, ' + (result.words?.length || 0) + ' ord)');

  return {
    text: rawText,
    words: result.words || [],
    languageCode: result.language_code || 'dan',
    languageProbability: result.language_probability || null,
  };
}

// ============================================================
// Konverter Scribe's ord-niveau output til "Sælger: ... / Kunde: ..."
// Scribe giver speaker_id (speaker_0, speaker_1) per ord.
//
// Vigtigt: Den der taler FØRST er ikke den der "initierede" opkaldet
// — det er den der TAGER TELEFONEN:
// - outgoing (vi ringer ud): kunden tager telefonen → KUNDE taler først
// - incoming (kunden ringer): vi tager telefonen → SÆLGER taler først
// ============================================================
function buildDiarizedTranscript(words, direction = 'outgoing') {
  if (!words || words.length === 0) return null;

  // Find det første ikke-audio-event ord for at bestemme starteren
  const firstSpeech = words.find(w => w.type === 'word' && w.speaker_id);
  if (!firstSpeech) return null;

  const firstSpeaker = firstSpeech.speaker_id;
  const starterLabel = direction === 'outgoing' ? 'Kunde' : 'Sælger';
  const otherLabel = direction === 'outgoing' ? 'Sælger' : 'Kunde';

  const labelFor = (speakerId) => speakerId === firstSpeaker ? starterLabel : otherLabel;

  // Gruppér sammenhængende ord fra samme taler til replikker
  const turns = [];
  let currentSpeaker = null;
  let currentText = [];

  for (const w of words) {
    if (w.type === 'audio_event') {
      // Tagg audio events som inline markup, fx (latter), (pause)
      const eventText = '(' + (w.text || 'lyd') + ')';
      if (currentSpeaker) currentText.push(eventText);
      continue;
    }
    if (w.type !== 'word' && w.type !== 'spacing') continue;

    const speaker = w.speaker_id || currentSpeaker;
    if (speaker && speaker !== currentSpeaker && currentText.length > 0) {
      turns.push({ speaker: currentSpeaker, text: currentText.join('').trim() });
      currentText = [];
    }
    currentSpeaker = speaker;
    currentText.push(w.text || '');
  }
  if (currentText.length > 0 && currentSpeaker) {
    turns.push({ speaker: currentSpeaker, text: currentText.join('').trim() });
  }

  return turns
    .filter(t => t.text.length > 0)
    .map(t => labelFor(t.speaker) + ': ' + t.text)
    .join('\n');
}

module.exports = { transcribe, buildDiarizedTranscript };
