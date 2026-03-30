const OpenAI = require('openai');
const FormData = require('form-data');
const config = require('../config');

const openai = new OpenAI({ apiKey: config.openai.apiKey });

// ============================================================
// Transskribér lyd til dansk tekst via OpenAI Whisper
// audioBuffer: Buffer med lydfilen
// contentType: MIME type (f.eks. 'audio/mpeg', 'audio/wav')
// ============================================================
async function transcribe(audioBuffer, contentType = 'audio/mpeg') {
  // Bestem filendelse ud fra content type
  const ext = contentType.includes('wav') ? 'wav'
    : contentType.includes('ogg') ? 'ogg'
    : 'mp3';

  // Opret en File-lignende objekt som OpenAI SDK forventer
  const file = new File([audioBuffer], `opkald.${ext}`, { type: contentType });

  const response = await openai.audio.transcriptions.create({
    file,
    model: 'whisper-1',
    language: 'da',          // Dansk
    response_format: 'text',
  });

  return response;
}

module.exports = { transcribe };
