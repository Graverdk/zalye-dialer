// ============================================================
// Transskription via OpenAI Whisper API (whisper-1 / large-v3)
// - Meget bedre til dansk end lokal whisper-small
// - Ingen "da-da-da"-repetition eller fejl-oversættelse af egennavne
// - Initial prompt hjælper modellen genkende Zalye-specifikke termer
// ============================================================

const fetch = require('node-fetch');
const FormData = require('form-data');
const config = require('../config');

// Dansk kontekst-prompt: forbedrer genkendelse af egennavne og fagtermer
// Whisper bruger denne som "stylistisk reference" — ikke som direkte instruktion
const DANISH_CONTEXT_PROMPT = (
  'Dette er en salgssamtale på dansk mellem Jeppe Graversen fra Zalye ' +
  'og en kunde. Zalye er en softwareplatform til håndværkerbranchen. ' +
  'Almindelige emner: demo, booking, pris, abonnement, onboarding, ' +
  'faktura, tilbud, kalender, opgaver, kunder, håndværkere. ' +
  'Andre ord: Pipedrive, Relatel, Flextagservice, Malerfix, Gulvfix.'
);

async function transcribe(audioBuffer, contentType = 'audio/mpeg') {
  if (!config.openai || !config.openai.apiKey) {
    throw new Error('OPENAI_API_KEY mangler — tilføj den i Railway Variables');
  }

  console.log('[Whisper] Sender ' + audioBuffer.length + ' bytes til OpenAI Whisper API...');

  // Bestem filendelse ud fra content-type (Whisper API kræver korrekt filendelse)
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
  form.append('model', 'whisper-1');
  form.append('language', 'da');
  form.append('response_format', 'text');
  form.append('temperature', '0'); // Minimér hallucinering / repetition loops
  form.append('prompt', DANISH_CONTEXT_PROMPT);

  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + config.openai.apiKey,
      ...form.getHeaders(),
    },
    body: form,
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error('OpenAI Whisper fejl ' + res.status + ': ' + errText.substring(0, 300));
  }

  const text = (await res.text()).trim();
  console.log('[Whisper] Transskription modtaget (' + text.length + ' tegn)');
  return text;
}

module.exports = { transcribe };
