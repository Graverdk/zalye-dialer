const express = require('express');
const router = express.Router();
const { messages, relatelNotes } = require('../db/database');

// ============================================================
// GET /api/messages
// Hent SMS-beskeder for panel
// Query: ?personId=123 | ?dealId=456 | ?phone=4571...
// ============================================================
router.get('/', (req, res) => {
  const { personId, dealId, phone, limit = 50 } = req.query;

  let result = [];

  if (personId) {
    result = messages.getByPersonId(parseInt(personId), parseInt(limit));
  } else if (dealId) {
    result = messages.getByDealId(parseInt(dealId), parseInt(limit));
  } else if (phone) {
    result = messages.getByPhone(phone, parseInt(limit));
  } else {
    return res.status(400).json({ error: 'Angiv enten personId, dealId eller phone' });
  }

  res.json({ messages: result });
});

// ============================================================
// GET /api/messages/notes
// Hent Relatel-noter for panel
// Query: ?personId=123 | ?phone=4571...
// ============================================================
router.get('/notes', (req, res) => {
  const { personId, phone, limit = 50 } = req.query;

  let result = [];

  if (personId) {
    result = relatelNotes.getByPersonId(parseInt(personId), parseInt(limit));
  } else if (phone) {
    result = relatelNotes.getByPhone(phone, parseInt(limit));
  } else {
    return res.status(400).json({ error: 'Angiv enten personId eller phone' });
  }

  res.json({ notes: result });
});

// ============================================================
// POST /api/messages/poll
// Manuel trigger af SMS-polling (til test)
// ============================================================
router.post('/poll', async (req, res) => {
  const { fetchNewMessages } = require('../jobs/pollCalls');
  try {
    await fetchNewMessages();
    res.json({ success: true, message: 'SMS polling gennemført' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
