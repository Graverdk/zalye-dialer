// ============================================================
// Transskribér lyd til dansk tekst via lokal Whisper-model
// Lyden forlader ALDRIG serveren — 100% privat og GDPR-safe.
// Bruger @xenova/transformers som kører modellen lokalt.
// ============================================================

let _pipeline = null;

async function getTranscriber() {
  if (_pipeline) return _pipeline;

  // Lazy-load for at undgå lang startup-tid
  const { pipeline } = await import('@xenova/transformers');

  console.log('[Whisper] Indlæser lokal Whisper-model (første gang tager ~30 sek)...');
  _pipeline = await pipeline('automatic-speech-recognition', 'Xenova/whisper-small', {
    revision: 'main',
    // Tving dansk sprog som standard
    forced_decoder_ids: null,
  });
  console.log('[Whisper] Model klar.');
  return _pipeline;
}

async function transcribe(audioBuffer, contentType = 'audio/mpeg') {
  const transcriber = await getTranscriber();

  // Konverter Buffer til Float32Array (Whisper-format)
  // Xenova/transformers accepterer raw audio data som URL eller Float32Array
  // Vi gemmer midlertidigt til en data URL
  const base64 = audioBuffer.toString('base64');
  const dataUrl = `data:${contentType};base64,${base64}`;

  const result = await transcriber(dataUrl, {
    language: 'danish',
    task: 'transcribe',
    chunk_length_s: 30,
    stride_length_s: 5,
  });

  return (result.text || '').trim();
}

module.exports = { transcribe };
