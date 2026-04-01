// Transskription er midlertidigt deaktiveret.
// @xenova/transformers kræver mere RAM end Railway's gratis plan tilbyder (~512MB).
// Opkald får stadig en komplet note i Pipedrive med varighed, retning og telefonnummer.
// TODO: Aktiver igen ved opgradering af Railway RAM eller lokal server.

async function transcribe(audioBuffer, contentType = 'audio/mpeg') {
  console.log('[Transskription] Deaktiveret — opretter note uden transskription.');
  return '';
}

module.exports = { transcribe };
