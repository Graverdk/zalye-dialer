const express = require('express');
const router = express.Router();
const relatel = require('../services/relatel');
const { calls, state } = require('../db/database');

// ============================================================
// POST /api/calls/initiate
// Start et udgående opkald via Relatel
// Body: { toNumber, personId?, dealId?, restrictTo? }
// ============================================================
router.post('/initiate', async (req, res) => {
  const { toNumber, personId, dealId, restrictTo = '' } = req.body;

  if (!toNumber) {
    return res.status(400).json({ error: 'toNumber er påkrævet' });
  }

  try {
    const result = await relatel.initiateCall({ toNumber, restrictTo });

    // Gem et foreløbigt opkald i databasen så vi kan linke Pipedrive-IDs
    // Det rigtige opkald hentes ved næste poll fra Relatel
    const tempUuid = `pending-${Date.now()}-${toNumber.replace(/\D/g, '')}`;
    calls.upsert({
      relatel_uuid:       tempUuid,
      direction:          'outgoing',
      phone_number:       toNumber.replace(/^(\+|00)/, ''),
      employee_number:    null,
      started_at:         new Date().toISOString(),
      ended_at:           null,
      duration_sec:       null,
      recording_url:      null,
      pipedrive_person_id: personId || null,
      pipedrive_deal_id:  dealId || null,
    });

    res.json({ success: true, message: result.message || 'Opkald igangsat' });
  } catch (err) {
    console.error('[API] Fejl ved initiering af opkald:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// GET /api/calls
// Hent opkald til sidebar panel
// Query: ?personId=123 | ?dealId=456 | ?phone=4571...
// ============================================================
router.get('/', (req, res) => {
  const { personId, dealId, phone, limit = 20 } = req.query;

  let result = [];

  if (personId) {
    result = calls.getByPersonId(parseInt(personId), parseInt(limit));
  } else if (dealId) {
    result = calls.getByDealId(parseInt(dealId), parseInt(limit));
  } else if (phone) {
    result = calls.getByPhone(phone, parseInt(limit));
  } else {
    return res.status(400).json({ error: 'Angiv enten personId, dealId eller phone' });
  }

  // Parse JSON-felter
  const parsed = result.map(formatCall);
  res.json({ calls: parsed });
});

// ============================================================
// GET /api/calls/:uuid
// Hent enkelt opkald med fuld detaljer
// ============================================================
router.get('/:uuid', (req, res) => {
  const call = calls.getByUuid(req.params.uuid);
  if (!call) return res.status(404).json({ error: 'Opkald ikke fundet' });
  res.json(formatCall(call));
});

// ============================================================
// POST /api/calls/poll
// Manuel trigger af polling (til test)
// ============================================================
router.post('/poll', async (req, res) => {
  const { pollNewCalls } = require('../jobs/pollCalls');
  try {
    await pollNewCalls();
    res.json({ success: true, message: 'Polling gennemført' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// GET /api/calls/debug/relatel?hours=24
// Dump rå Relatel data for de sidste N timer — til debug af
// recording_url-feltet som ikke altid kommer igennem korrekt
// ============================================================
router.get('/debug/relatel', async (req, res) => {
  const relatel = require('../services/relatel');
  const hours = Math.min(Math.max(parseInt(req.query.hours) || 24, 1), 168);
  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  try {
    const rawCalls = await relatel.getCalls({ endedAfter: since, limit: 50 });

    // Hent også fuld enkelt-opkald for et udgående opkald (med varighed)
    // for at se om POST /calls returnerer ekstra recording-data
    const outgoingWithTalk = rawCalls.find(c => c.direction === 'outgoing' && c.talk_duration > 0);
    let singleCallDetail = null;
    if (outgoingWithTalk) {
      try {
        singleCallDetail = await relatel.getCall(outgoingWithTalk.call_uuid);
      } catch (e) {
        singleCallDetail = { error: e.message };
      }
    }

    res.json({
      hours,
      count: rawCalls.length,
      rawCalls, // FULD rå data for alle opkald
      singleCallDetail, // FULD rå data fra POST /calls (enkelt-opkald endpoint)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// GET /api/calls/debug/sms?hours=2
// Dump seneste chats + beskeder fra Relatel
// ============================================================
router.get('/debug/sms', async (req, res) => {
  const relatel = require('../services/relatel');
  const hours = Math.min(Math.max(parseInt(req.query.hours) || 2, 1), 168);
  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  try {
    const chats = await relatel.getChats({ after: since, limit: 50 });
    const detailed = [];
    for (const chat of (chats || []).slice(0, 20)) {
      const uuid = chat.uuid || chat.id;
      try {
        const full = await relatel.getChat(uuid);
        detailed.push({ chat, full });
      } catch (e) {
        detailed.push({ chat, error: e.message });
      }
    }
    res.json({ hours, chatsCount: (chats || []).length, chats: detailed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// GET /api/calls/debug/db-status
// Viser hvad der ligger i vores DB + deres transskriptions-status
// ============================================================
router.get('/debug/db-status', (req, res) => {
  const { db } = require('../db/database');
  try {
    const rows = db.prepare(`
      SELECT
        relatel_uuid,
        direction,
        phone_number,
        started_at,
        duration_sec,
        recording_url IS NOT NULL AS has_recording,
        transcription_status,
        LENGTH(transcription) AS transcription_length,
        pipedrive_person_id IS NOT NULL AS linked,
        pipedrive_note_id IS NOT NULL AS has_note
      FROM calls
      ORDER BY started_at DESC
      LIMIT 30
    `).all();

    const summary = db.prepare(`
      SELECT transcription_status, COUNT(*) as n FROM calls GROUP BY transcription_status
    `).all();

    res.json({ summary, recent: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// POST /api/calls/retry-transcription
// Find alle opkald der har recording_url men ingen transskription
// og marker dem 'pending' igen, så processTranscriptions tager dem.
// ============================================================
router.post('/retry-transcription', async (req, res) => {
  const { db } = require('../db/database');
  const { processTranscriptions } = require('../jobs/pollCalls');
  try {
    const result = db.prepare(`
      UPDATE calls
      SET transcription_status = 'pending'
      WHERE recording_url IS NOT NULL
        AND recording_url != ''
        AND (transcription IS NULL OR transcription = '')
    `).run();
    processTranscriptions().catch(e => console.error('[Retry] Transskription-kick fejlede:', e.message));
    res.json({ success: true, requeued: result.changes, message: 'Transskription kører i baggrunden' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// POST /api/calls/backfill?days=7
// Catch-up: hent alle opkald fra sidste N dage og (re)processer
// dem der mangler transskription eller Pipedrive-note.
// ============================================================
router.post('/backfill', async (req, res) => {
  const { backfillCalls, processTranscriptions } = require('../jobs/pollCalls');
  const days = Math.min(Math.max(parseInt(req.query.days) || 7, 1), 30);
  try {
    const summary = await backfillCalls(days);
    // Kick-start transskription med det samme så brugeren ser fremgang hurtigt
    processTranscriptions().catch(e => console.error('[Backfill] Transskription-kick fejlede:', e.message));
    res.json({ success: true, days, summary, message: 'Backfill startet — transskription kører i baggrunden' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// Hjælpefunktion: Formatér et database-opkald til API-svar
// ============================================================
function formatCall(call) {
  return {
    ...call,
    action_points: call.action_points ? JSON.parse(call.action_points) : [],
    topics:        call.topics        ? JSON.parse(call.topics)        : [],
  };
}

module.exports = router;
