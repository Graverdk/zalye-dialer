// ============================================================
// Lokal Whisper-transskription via @xenova/transformers
// Lyden forlader ALDRIG serveren — 100% GDPR-safe.
// Første gang: downloader Whisper-small model (~250MB, ~30 sek)
// Derefter: model er cached og klar med det samme.
// ============================================================

let _pipeline = null;

async function getTranscriber() {
  if (_pipeline) return _pipeline;

  const { pipeline } = await import('@xenova/transformers');

  console.log('[Whisper] Indlæser lokal Whisper-model (første gang tager ~30 sek)...');
  _pipeline = await pipeline('automatic-speech-recognition', 'Xenova/whisper-small', {
    revision: 'main',
    forced_decoder_ids: null,
  });
  console.log('[Whisper] Model klar.');
  return _pipeline;
}

async function transcribe(audioBuffer, contentType = 'audio/mpeg') {
  const transcriber = await getTranscriber();

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
