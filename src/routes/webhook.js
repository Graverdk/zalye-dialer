// ============================================================
// Webhook-endpoint til Relatel events (lanceret af Relatel 31/8 2026)
// Opsætning: Relatel → Firmaadministration → Webhooks, ét webhook pr. hovednummer,
// URL: <APP_URL>/api/webhook/relatel
// Events vi bruger: call.ended, incoming_message.created (+ webhook.test)
//
// Format: POST {delivery_id, event_type, occurred_at, payload}
// Signatur: header "Relatel-Signature: t=<ts>,v1=<hex>" hvor
//   v1 = HMAC-SHA256(signing secret, `${t}.${rå body}`)
// Relatel kan levere dubletter og i vilkårlig rækkefølge — derfor dedup på
// delivery_id, og vi bruger kun eventet som "vågn op"-signal: selve data hentes
// stadig via API'et (payload er ikke dokumenteret, og optagelsen er ikke klar
// ved call.ended alligevel).
// ============================================================

const crypto = require('crypto');
const express = require('express');
const router = express.Router();
const config = require('../config');

// Sete delivery_id'er (begrænset størrelse — dubletter kommer typisk tæt på hinanden)
const seenDeliveries = new Set();
const MAX_SEEN = 1000;

function rememberDelivery(id) {
  if (!id) return false;
  if (seenDeliveries.has(id)) return true;
  seenDeliveries.add(id);
  if (seenDeliveries.size > MAX_SEEN) {
    seenDeliveries.delete(seenDeliveries.values().next().value);
  }
  return false;
}

function verifyRelatelSignature(req) {
  const secret = config.security.relatelWebhookSigningSecret;
  const header = req.get('Relatel-Signature') || '';
  const parts = Object.fromEntries(
    header.split(',').map((p) => p.trim().split('=')).filter((kv) => kv.length === 2)
  );
  if (!parts.t || !parts.v1 || !req.rawBody) return false;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${parts.t}.${req.rawBody.toString('utf8')}`)
    .digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(parts.v1, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

router.post('/relatel', async (req, res) => {
  if (config.security.relatelWebhookSigningSecret) {
    if (!verifyRelatelSignature(req)) {
      console.warn('[Webhook] Afvist: ugyldig eller manglende Relatel-Signature');
      return res.status(401).json({ error: 'Ugyldig signatur' });
    }
  } else if (config.security.webhookSecret && req.query.secret !== config.security.webhookSecret) {
    // Ældre beskyttelse via ?secret= i URL'en (bruges kun hvis signeringsnøglen ikke er sat)
    return res.status(401).json({ error: 'Ugyldig webhook-secret' });
  }

  // Svar hurtigt så Relatel ikke timeout'er og genleverer — arbejd i baggrunden
  res.json({ received: true });

  try {
    const event = req.body || {};
    const eventType = event.event_type || event.type || event.event || 'unknown';
    const deliveryId = req.get('Relatel-Delivery-Id') || event.delivery_id;

    if (rememberDelivery(deliveryId)) {
      console.log('[Webhook] Dublet ignoreret: ' + deliveryId);
      return;
    }
    // Logger payload-formen så vi lærer Relatels (udokumenterede) payload at kende
    console.log('[Webhook] ' + eventType + ' (' + (deliveryId || 'uden id') + '):',
      JSON.stringify(event.payload ?? event).substring(0, 500));

    const { pollNewCalls, fetchNewMessages } = require('../jobs/pollCalls');

    if (eventType === 'call.ended' || eventType === 'call.created') {
      if (eventType === 'call.ended') {
        pollNewCalls().catch((e) => console.error('[Webhook] pollNewCalls fejlede:', e.message));
      }
    } else if (eventType === 'incoming_message.created') {
      fetchNewMessages().catch((e) => console.error('[Webhook] fetchNewMessages fejlede:', e.message));
    } else if (eventType === 'webhook.test') {
      console.log('[Webhook] Testevent modtaget — forbindelsen virker');
    }
    // contact.* og chat.* bruger vi ikke (endnu)
  } catch (e) {
    console.error('[Webhook] Fejl ved behandling:', e.message);
  }
});

// Health check — nogle opsætninger GET'er endpointet først
router.get('/relatel', (req, res) => {
  res.json({ status: 'ok', message: 'Relatel webhook endpoint klar' });
});

module.exports = router;
