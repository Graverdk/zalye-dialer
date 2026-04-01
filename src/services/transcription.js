// ============================================================
// Lokal Whisper-transskription via @xenova/transformers + ffmpeg
// Lyden forlader ALDRIG serveren — 100% GDPR-safe.
// ffmpeg konverterer lyden til 16kHz mono PCM (Node.js-kompatibelt)
// Whisper-small model (~250MB) downloades første gang ved opstart.
// ============================================================

const { execFileSync } = require('child_process');
const { writeFileSync, readFileSync, unlinkSync, existsSync } = require('fs');
const { join } = require('path');
const { tmpdir } = require('os');
const ffmpegPath = require('ffmpeg-static'); // Pre-built binary — ingen system-ffmpeg nødvendig

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

// Konvertér audio buffer til Float32Array via ffmpeg (16kHz, mono, f32le)
function audioBufferToFloat32(audioBuffer) {
  const id = Date.now() + Math.random().toString(36).slice(2);
  const tmpIn  = join(tmpdir(), `whisper_in_${id}`);
  const tmpOut = join(tmpdir(), `whisper_out_${id}.pcm`);

  writeFileSync(tmpIn, audioBuffer);

  try {
    execFileSync(ffmpegPath, [
      '-i', tmpIn,
      '-ar', '16000', // 16 kHz samplingsrate
      '-ac', '1',     // mono
      '-f', 'f32le',  // 32-bit float little-endian (Whisper-format)
      '-y', tmpOut,
    ], { stdio: 'pipe' });

    const pcm = readFileSync(tmpOut);
    return new Float32Array(pcm.buffer, pcm.byteOffset, pcm.length / 4);
  } finally {
    if (existsSync(tmpIn))  unlinkSync(tmpIn);
    if (existsSync(tmpOut)) unlinkSync(tmpOut);
  }
}

async function transcribe(audioBuffer, contentType = 'audio/mpeg') {
  const transcriber = await getTranscriber();

  console.log('[Whisper] Konverterer lyd med ffmpeg...');
  const audioData = audioBufferToFloat32(audioBuffer);

  console.log('[Whisper] Transskriberer...');
  const result = await transcriber(audioData, {
    sampling_rate: 16000,
    language: 'danish',
    task: 'transcribe',
    chunk_length_s: 30,
    stride_length_s: 5,
  });

  return (result.text || '').trim();
}

module.exports = { transcribe };
