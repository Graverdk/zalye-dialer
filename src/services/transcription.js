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

// Keyterms: ord Scribe skal genkende korrekt (egennavne, systemer, fagtermer).
// OBS: parameteren hedder `keyterms` — før 24/9 2026 blev de sendt som
// `bias_keywords`, som ElevenLabs ikke kender, så listen virkede aldrig.
// Maks 1000 termer, hver < 50 tegn og højst 5 ord.
const KEYTERMS = [
  // Os og vores værktøjer
  'Zalye', 'Jeppe Graversen', 'Pipedrive', 'Relatel',
  // Drifts-/sagsstyringssystemer
  'Apacta', 'Ordrestyring', 'Minuba', 'e-regnskab', 'E-Komplet', 'Tabletten', 'Intempus', 'Planday',
  // Regnskab
  'e-conomic', 'Dinero', 'Billy', 'Uniconta', 'Visma', 'Business Central', 'Navision',
  // Løn
  'Danløn', 'Zenegy', 'Salary', 'Proløn', 'Lessor',
  // Grossister
  'Bygma', 'STARK', 'XL-BYG', 'Davidsen', 'Sanistål', 'Lemvigh-Müller', 'Brødrene Dahl', 'Ahlsell',
  // Fag og fagtermer
  'håndværker', 'anlægsgartner', 'tagdækker', 'facaderens', 'VVS',
  'demo', 'onboarding', 'abonnement', 'faktura', 'tilbud', 'akkord', 'dagsseddel', 'timeregistrering',
];

async function transcribe(audioBuffer, contentType = 'audio/mpeg', options = {}) {
  if (!config.elevenlabs || !config.elevenlabs.apiKey) {
    throw new Error('ELEVENLABS_API_KEY mangler — tilføj den i Railway Variables');
  }

  const { numSpeakers = 2, withKeyterms = true } = options;

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
  form.append('model_id', config.elevenlabs.model);
  form.append('language_code', 'dan'); // ISO 639-3 for dansk
  form.append('diarize', 'true');
  form.append('num_speakers', String(numSpeakers));
  form.append('tag_audio_events', 'true');
  form.append('timestamps_granularity', 'word');
  // Liste-parameter i multipart: ét felt pr. term
  if (withKeyterms) for (const term of KEYTERMS) form.append('keyterms', term);

  const startTime = Date.now();
  let res;
  try {
    res = await fetch(SCRIBE_URL, {
      method: 'POST',
      headers: {
        'xi-api-key': config.elevenlabs.apiKey,
        ...form.getHeaders(),
      },
      body: form,
      timeout: 600000, // Op til 10 min — nødvendigt for lange samtaler (>15 min lyd)
    });
  } catch (fetchErr) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    throw new Error('Scribe netværksfejl efter ' + elapsed + 's: ' + fetchErr.message);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    // Sikkerhedsnet: afviser Scribe forespørgslen som ugyldig, så prøv én gang
    // uden keyterms — hellere en udskrift uden ordliste end ingen udskrift
    if ((res.status === 400 || res.status === 422) && withKeyterms) {
      console.warn('[Scribe] ' + res.status + ' med keyterms — prøver igen uden. Svar: ' + errText.substring(0, 300));
      return transcribe(audioBuffer, contentType, { ...options, withKeyterms: false });
    }
    // Specialcase kendte fejl så de er lette at spotte i logs
    if (res.status === 401) {
      throw new Error('Scribe 401 unauthorized efter ' + elapsed + 's — tjek ELEVENLABS_API_KEY');
    }
    if (res.status === 429) {
      throw new Error('Scribe 429 rate limit / credits opbrugt efter ' + elapsed + 's: ' + errText.substring(0, 200));
    }
    if (res.status === 413) {
      throw new Error('Scribe 413 fil for stor (' + audioBuffer.length + ' bytes): ' + errText.substring(0, 200));
    }
    throw new Error('Scribe fejl ' + res.status + ' efter ' + elapsed + 's: ' + errText.substring(0, 400));
  }
  console.log('[Scribe] Svar modtaget efter ' + elapsed + 's');

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
