// ============================================================
// Webhook-endpoint til Relatel events
// Relatel kan konfigureres til at POST'e her ved opkalds-events —
// så vi slipper for at polle hvert minut for at finde nye opkald.
// Konfigurer i Relatel admin: POST til /api/webhook/relatel
// ============================================================

const express = require('express');
const router = express.Router();

router.post('/relatel', async (req, res) => {
  // Svar hurtigt så Relatel ikke timeout'er — arbejd i baggrunden
  res.json({ received: true });

  try {
    const event = req.body || {};
    const eventType = event.type || event.event || 'unknown';
    console.log('[Webhook] Relatel event modtaget: ' + eventType, JSON.stringify(event).substring(0, 300));

    // Kør polling med det samme — pollNewCalls vil finde det nye opkald
    // uanset eksakt payload-format (vi er forsigtige indtil vi kender Relatels præcise format)
    const { pollNewCalls, fetchNewMessages, fetchNewNotes } = require('../jobs/pollCalls');

    if (eventType.includes('call')) {
      pollNewCalls().catch(e => console.error('[Webhook] pollNewCalls fejlede:', e.message));
    } else if (eventType.includes('message') || eventType.includes('sms') || eventType.includes('chat')) {
      fetchNewMessages().catch(e => console.error('[Webhook] fetchNewMessages fejlede:', e.message));
    } else if (eventType.includes('note') || eventType.includes('comment')) {
      fetchNewNotes().catch(e => console.error('[Webhook] fetchNewNotes fejlede:', e.message));
    } else {
      // Ukendt event-type — kør alle tre for sikkerhed
      pollNewCalls().catch(() => {});
      fetchNewMessages().catch(() => {});
    }
  } catch (e) {
    console.error('[Webhook] Fejl ved behandling:', e.message);
  }
});

// Health check til Relatel — de vil ofte GET'e endpointet først
router.get('/relatel', (req, res) => {
  res.json({ status: 'ok', message: 'Relatel webhook endpoint klar' });
});

module.exports = router;
