const Anthropic = require('@anthropic-ai/sdk');
const config = require('../config');

const anthropic = new Anthropic({ apiKey: config.anthropic.apiKey });

// ============================================================
// Transskribér lyd til dansk tekst via Anthropic Claude
// audioBuffer: Buffer med lydfilen
// contentType: MIME type (f.eks. 'audio/mpeg', 'audio/wav')
// ============================================================
async function transcribe(audioBuffer, contentType = 'audio/mpeg') {
  // Konverter til base64 for Anthropic API
  const base64Audio = audioBuffer.toString('base64');

  // Map content type til Anthropic's understøttede media types
  const mediaType = contentType.includes('wav') ? 'audio/wav'
    : contentType.includes('ogg') ? 'audio/ogg'
    : contentType.includes('webm') ? 'audio/webm'
    : 'audio/mpeg';

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'media',
            source: {
              type: 'base64',
              media_type: mediaType,
              data: base64Audio,
            },
          },
          {
            type: 'text',
            text: `Transskribér denne lydoptagelse af et telefonopkald på dansk.

Regler:
- Skriv PRÆCIS hvad der bliver sagt, ord for ord
- Bevar talesprog og dialekt som det lyder
- Markér forskellige talere med "Taler 1:" og "Taler 2:" osv.
- Inkluder pauser med [...] og utydeligt tale med [utydelig]
- Returner KUN transskriptionen, ingen kommentarer eller forklaring`,
          },
        ],
      },
    ],
  });

  return message.content[0].text.trim();
}

module.exports = { transcribe };
