const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const config = require('../config');

// Sørg for at mappen eksisterer
const dbDir = path.dirname(config.db.path);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new Database(config.db.path);

// WAL mode giver bedre ydeevne og concurrent reads
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ============================================================
// Schema
// ============================================================
db.exec(`
  CREATE TABLE IF NOT EXISTS calls (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    relatel_uuid    TEXT UNIQUE NOT NULL,
    direction       TEXT NOT NULL,          -- 'incoming' | 'outgoing'
    phone_number    TEXT NOT NULL,          -- ekstern part's nummer
    employee_number TEXT,                   -- Relatel-medarbejderens nummer
    started_at      TEXT,
    ended_at        TEXT,
    duration_sec    INTEGER,
    recording_url   TEXT,
    recording_expired INTEGER DEFAULT 0,

    -- Pipedrive kobling
    pipedrive_person_id  INTEGER,
    pipedrive_deal_id    INTEGER,
    pipedrive_note_id    INTEGER,

    -- Salgs-intelligence kontekst
    call_type       TEXT DEFAULT 'unknown', -- demo | onboarding | support | sales | follow_up | unknown
    sales_rep       TEXT,                   -- Hvem fra Zalye tog opkaldet (navn eller ID)
    pipeline_stage  TEXT,                   -- Pipedrive-stadie da opkaldet skete (fx 'Kvalificeret', 'Demo booket')

    -- AI pipeline status
    transcription_status TEXT DEFAULT 'pending',  -- pending | processing | done | failed
    transcription        TEXT,
    summary              TEXT,
    action_points        TEXT,              -- JSON array af strenge
    topics               TEXT,             -- JSON array af strenge

    created_at      INTEGER DEFAULT (strftime('%s', 'now')),
    updated_at      INTEGER DEFAULT (strftime('%s', 'now'))
  );

  CREATE INDEX IF NOT EXISTS idx_calls_phone     ON calls(phone_number);
  CREATE INDEX IF NOT EXISTS idx_calls_person    ON calls(pipedrive_person_id);
  CREATE INDEX IF NOT EXISTS idx_calls_deal      ON calls(pipedrive_deal_id);
  CREATE INDEX IF NOT EXISTS idx_calls_ended_at  ON calls(ended_at);
  CREATE INDEX IF NOT EXISTS idx_calls_status    ON calls(transcription_status);
  CREATE INDEX IF NOT EXISTS idx_calls_type      ON calls(call_type);
  CREATE INDEX IF NOT EXISTS idx_calls_rep       ON calls(sales_rep);
  CREATE INDEX IF NOT EXISTS idx_calls_stage     ON calls(pipeline_stage);

  -- ============================================================
  -- Sales Intelligence: Insights fra hver samtale
  -- Claude udtrækker automatisk disse fra transskriptionen
  -- ============================================================
  CREATE TABLE IF NOT EXISTS call_insights (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    call_id         INTEGER NOT NULL REFERENCES calls(id),

    -- Sentiment og outcome
    sentiment       TEXT,                  -- positive | neutral | negative
    call_outcome    TEXT,                  -- interested | not_interested | meeting_booked | deal_closed | needs_follow_up | no_answer

    -- Salgsrelevante signaler (JSON arrays)
    pain_points     TEXT,                  -- ["Bruger for lang tid på fakturering", "Mangler overblik"]
    objections      TEXT,                  -- ["For dyrt", "Har allerede et system"]
    buying_signals  TEXT,                  -- ["Spurgte til pris", "Vil gerne se demo"]
    competitor_mentions TEXT,              -- ["Bruger X system i dag", "Har set på Y"]
    next_steps      TEXT,                  -- ["Send tilbud inden fredag", "Book demo næste uge"]

    -- Kundens stadie i salgsprocessen
    customer_stage  TEXT,                  -- lead | qualified | demo_done | proposal_sent | negotiation | closed_won | closed_lost | churned

    -- Scoring
    engagement_score INTEGER,             -- 1-10: hvor engageret var kunden?
    conversion_likelihood INTEGER,        -- 1-10: hvor sandsynligt er det at de konverterer?

    -- Fritekst-noter fra AI
    ai_coaching_note TEXT,                -- "God åbning, men glemte at spørge til budget. Prøv at..."

    created_at      INTEGER DEFAULT (strftime('%s', 'now'))
  );

  CREATE INDEX IF NOT EXISTS idx_insights_call    ON call_insights(call_id);
  CREATE INDEX IF NOT EXISTS idx_insights_outcome ON call_insights(call_outcome);
  CREATE INDEX IF NOT EXISTS idx_insights_stage   ON call_insights(customer_stage);

  -- ============================================================
  -- Deal Outcomes: Tracker resultater over tid per deal
  -- Gør det muligt at analysere: hvilke kunder lukker vi / lukker vi ikke?
  -- ============================================================
  CREATE TABLE IF NOT EXISTS deal_outcomes (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    pipedrive_deal_id   INTEGER NOT NULL,
    pipedrive_person_id INTEGER,

    -- Status
    outcome             TEXT NOT NULL,     -- won | lost | stalled | active
    reason              TEXT,              -- Hvorfor vandt/tabte vi? (fra AI eller manuelt)

    -- Aggregerede metrics (beregnet fra call_insights)
    total_calls         INTEGER DEFAULT 0,
    total_duration_sec  INTEGER DEFAULT 0,
    avg_sentiment       TEXT,              -- positive | neutral | negative (baseret på alle opkald)
    top_objections      TEXT,              -- JSON: de hyppigste indvendinger for dette deal
    top_pain_points     TEXT,              -- JSON: de hyppigste smertepunkter

    -- Tidslinje
    first_contact_at    TEXT,
    last_contact_at     TEXT,
    outcome_at          TEXT,              -- Hvornår blev deal lukket/tabt
    days_in_pipeline    INTEGER,

    created_at          INTEGER DEFAULT (strftime('%s', 'now')),
    updated_at          INTEGER DEFAULT (strftime('%s', 'now'))
  );

  CREATE INDEX IF NOT EXISTS idx_outcomes_deal    ON deal_outcomes(pipedrive_deal_id);
  CREATE INDEX IF NOT EXISTS idx_outcomes_outcome ON deal_outcomes(outcome);

  -- ============================================================
  -- SMS-beskeder fra Relatel
  -- ============================================================
  CREATE TABLE IF NOT EXISTS messages (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    relatel_id      TEXT UNIQUE,
    direction       TEXT NOT NULL,          -- 'incoming' | 'outgoing'
    phone_number    TEXT NOT NULL,          -- ekstern part's nummer
    employee_number TEXT,
    body            TEXT,
    sent_at         TEXT,

    -- Pipedrive kobling
    pipedrive_person_id  INTEGER,
    pipedrive_deal_id    INTEGER,
    pipedrive_note_id    INTEGER,           -- ID på Pipedrive-note oprettet for denne SMS

    created_at      INTEGER DEFAULT (strftime('%s', 'now'))
  );

  CREATE INDEX IF NOT EXISTS idx_messages_phone    ON messages(phone_number);
  CREATE INDEX IF NOT EXISTS idx_messages_person   ON messages(pipedrive_person_id);
  CREATE INDEX IF NOT EXISTS idx_messages_sent     ON messages(sent_at);

  -- ============================================================
  -- Noter/kommentarer fra Relatel kontakter
  -- ============================================================
  CREATE TABLE IF NOT EXISTS relatel_notes (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    relatel_id      TEXT UNIQUE,
    relatel_contact_id TEXT,
    phone_number    TEXT,
    author          TEXT,
    body            TEXT,
    created_at_rel  TEXT,                   -- tidsstempel fra Relatel

    -- Pipedrive kobling
    pipedrive_person_id  INTEGER,
    pipedrive_note_id    INTEGER,

    created_at      INTEGER DEFAULT (strftime('%s', 'now'))
  );

  CREATE INDEX IF NOT EXISTS idx_rnotes_phone   ON relatel_notes(phone_number);
  CREATE INDEX IF NOT EXISTS idx_rnotes_person  ON relatel_notes(pipedrive_person_id);

  -- Systemstate: gemmer hvornår vi sidst pollede
  CREATE TABLE IF NOT EXISTS system_state (
    key   TEXT PRIMARY KEY,
    value TEXT
  );
`);

// ============================================================
// Hjælpefunktioner
// ============================================================

const calls = {
  upsert(callData) {
    const stmt = db.prepare(`
      INSERT INTO calls (
        relatel_uuid, direction, phone_number, employee_number,
        started_at, ended_at, duration_sec, recording_url,
        pipedrive_person_id, pipedrive_deal_id
      ) VALUES (
        @relatel_uuid, @direction, @phone_number, @employee_number,
        @started_at, @ended_at, @duration_sec, @recording_url,
        @pipedrive_person_id, @pipedrive_deal_id
      )
      ON CONFLICT(relatel_uuid) DO UPDATE SET
        ended_at            = COALESCE(excluded.ended_at, ended_at),
        duration_sec        = COALESCE(excluded.duration_sec, duration_sec),
        recording_url       = COALESCE(excluded.recording_url, recording_url),
        pipedrive_person_id = COALESCE(excluded.pipedrive_person_id, pipedrive_person_id),
        pipedrive_deal_id   = COALESCE(excluded.pipedrive_deal_id, pipedrive_deal_id),
        updated_at          = strftime('%s', 'now')
    `);
    return stmt.run(callData);
  },

  getByUuid(uuid) {
    return db.prepare('SELECT * FROM calls WHERE relatel_uuid = ?').get(uuid);
  },

  getByPersonId(personId, limit = 20) {
    return db.prepare(`
      SELECT * FROM calls
      WHERE pipedrive_person_id = ?
      ORDER BY started_at DESC
      LIMIT ?
    `).all(personId, limit);
  },

  getByDealId(dealId, limit = 20) {
    return db.prepare(`
      SELECT * FROM calls
      WHERE pipedrive_deal_id = ?
      ORDER BY started_at DESC
      LIMIT ?
    `).all(dealId, limit);
  },

  getByPhone(phoneNumber, limit = 20) {
    // Normaliser nummeret (fjern +, 00 prefix)
    const normalized = phoneNumber.replace(/^(\+|00)/, '');
    return db.prepare(`
      SELECT * FROM calls
      WHERE phone_number LIKE ?
      ORDER BY started_at DESC
      LIMIT ?
    `).all(`%${normalized}`, limit);
  },

  updateTranscription(uuid, { status, transcription, summary, actionPoints, topics, pipedriveNoteId }) {
    return db.prepare(`
      UPDATE calls SET
        transcription_status = ?,
        transcription        = ?,
        summary              = ?,
        action_points        = ?,
        topics               = ?,
        pipedrive_note_id    = ?,
        updated_at           = strftime('%s', 'now')
      WHERE relatel_uuid = ?
    `).run(
      status,
      transcription || null,
      summary || null,
      actionPoints ? JSON.stringify(actionPoints) : null,
      topics ? JSON.stringify(topics) : null,
      pipedriveNoteId || null,
      uuid
    );
  },

  getPendingTranscriptions() {
    return db.prepare(`
      SELECT * FROM calls
      WHERE transcription_status = 'pending'
        AND recording_url IS NOT NULL
        AND ended_at IS NOT NULL
      ORDER BY ended_at ASC
      LIMIT 5
    `).all();
  },
};

// ============================================================
// Sales Intelligence hjælpefunktioner
// ============================================================

const insights = {
  upsert(callId, insightData) {
    const existing = db.prepare('SELECT id FROM call_insights WHERE call_id = ?').get(callId);
    if (existing) {
      return db.prepare(`
        UPDATE call_insights SET
          sentiment = ?, call_outcome = ?,
          pain_points = ?, objections = ?, buying_signals = ?,
          competitor_mentions = ?, next_steps = ?,
          customer_stage = ?, engagement_score = ?, conversion_likelihood = ?,
          ai_coaching_note = ?
        WHERE call_id = ?
      `).run(
        insightData.sentiment || null,
        insightData.callOutcome || null,
        insightData.painPoints ? JSON.stringify(insightData.painPoints) : null,
        insightData.objections ? JSON.stringify(insightData.objections) : null,
        insightData.buyingSignals ? JSON.stringify(insightData.buyingSignals) : null,
        insightData.competitorMentions ? JSON.stringify(insightData.competitorMentions) : null,
        insightData.nextSteps ? JSON.stringify(insightData.nextSteps) : null,
        insightData.customerStage || null,
        insightData.engagementScore || null,
        insightData.conversionLikelihood || null,
        insightData.aiCoachingNote || null,
        callId
      );
    } else {
      return db.prepare(`
        INSERT INTO call_insights (
          call_id, sentiment, call_outcome,
          pain_points, objections, buying_signals,
          competitor_mentions, next_steps,
          customer_stage, engagement_score, conversion_likelihood,
          ai_coaching_note
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        callId,
        insightData.sentiment || null,
        insightData.callOutcome || null,
        insightData.painPoints ? JSON.stringify(insightData.painPoints) : null,
        insightData.objections ? JSON.stringify(insightData.objections) : null,
        insightData.buyingSignals ? JSON.stringify(insightData.buyingSignals) : null,
        insightData.competitorMentions ? JSON.stringify(insightData.competitorMentions) : null,
        insightData.nextSteps ? JSON.stringify(insightData.nextSteps) : null,
        insightData.customerStage || null,
        insightData.engagementScore || null,
        insightData.conversionLikelihood || null,
        insightData.aiCoachingNote || null
      );
    }
  },

  getByCallId(callId) {
    const row = db.prepare('SELECT * FROM call_insights WHERE call_id = ?').get(callId);
    if (!row) return null;
    return {
      ...row,
      pain_points:        row.pain_points ? JSON.parse(row.pain_points) : [],
      objections:         row.objections ? JSON.parse(row.objections) : [],
      buying_signals:     row.buying_signals ? JSON.parse(row.buying_signals) : [],
      competitor_mentions: row.competitor_mentions ? JSON.parse(row.competitor_mentions) : [],
      next_steps:         row.next_steps ? JSON.parse(row.next_steps) : [],
    };
  },

  getByDealId(dealId) {
    return db.prepare(`
      SELECT ci.*, c.started_at, c.direction, c.phone_number, c.call_type
      FROM call_insights ci
      JOIN calls c ON c.id = ci.call_id
      WHERE c.pipedrive_deal_id = ?
      ORDER BY c.started_at DESC
    `).all(dealId).map(row => ({
      ...row,
      pain_points:        row.pain_points ? JSON.parse(row.pain_points) : [],
      objections:         row.objections ? JSON.parse(row.objections) : [],
      buying_signals:     row.buying_signals ? JSON.parse(row.buying_signals) : [],
      competitor_mentions: row.competitor_mentions ? JSON.parse(row.competitor_mentions) : [],
      next_steps:         row.next_steps ? JSON.parse(row.next_steps) : [],
    }));
  },

  // Hent aggregerede salgs-trends (til fremtidig sales coach)
  getTrends({ fromDate, toDate, callType } = {}) {
    let where = '1=1';
    const params = [];
    if (fromDate)  { where += ' AND c.started_at >= ?'; params.push(fromDate); }
    if (toDate)    { where += ' AND c.started_at <= ?'; params.push(toDate); }
    if (callType)  { where += ' AND c.call_type = ?';   params.push(callType); }

    return db.prepare(`
      SELECT
        c.call_type,
        ci.call_outcome,
        ci.customer_stage,
        COUNT(*) as count,
        ROUND(AVG(ci.engagement_score), 1) as avg_engagement,
        ROUND(AVG(ci.conversion_likelihood), 1) as avg_conversion
      FROM call_insights ci
      JOIN calls c ON c.id = ci.call_id
      WHERE ${where}
      GROUP BY c.call_type, ci.call_outcome, ci.customer_stage
      ORDER BY count DESC
    `).all(...params);
  },
};

const dealOutcomes = {
  upsert(data) {
    const existing = db.prepare('SELECT id FROM deal_outcomes WHERE pipedrive_deal_id = ?').get(data.pipedriveDeealId || data.pipedrive_deal_id);
    if (existing) {
      return db.prepare(`
        UPDATE deal_outcomes SET
          outcome = ?, reason = ?,
          total_calls = ?, total_duration_sec = ?,
          avg_sentiment = ?, top_objections = ?, top_pain_points = ?,
          first_contact_at = ?, last_contact_at = ?,
          outcome_at = ?, days_in_pipeline = ?,
          updated_at = strftime('%s', 'now')
        WHERE pipedrive_deal_id = ?
      `).run(
        data.outcome, data.reason || null,
        data.totalCalls || 0, data.totalDurationSec || 0,
        data.avgSentiment || null,
        data.topObjections ? JSON.stringify(data.topObjections) : null,
        data.topPainPoints ? JSON.stringify(data.topPainPoints) : null,
        data.firstContactAt || null, data.lastContactAt || null,
        data.outcomeAt || null, data.daysInPipeline || null,
        data.pipedriveDealId || data.pipedrive_deal_id
      );
    } else {
      return db.prepare(`
        INSERT INTO deal_outcomes (
          pipedrive_deal_id, pipedrive_person_id,
          outcome, reason,
          total_calls, total_duration_sec,
          avg_sentiment, top_objections, top_pain_points,
          first_contact_at, last_contact_at,
          outcome_at, days_in_pipeline
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        data.pipedriveDealId || data.pipedrive_deal_id,
        data.pipedrivePersonId || data.pipedrive_person_id || null,
        data.outcome, data.reason || null,
        data.totalCalls || 0, data.totalDurationSec || 0,
        data.avgSentiment || null,
        data.topObjections ? JSON.stringify(data.topObjections) : null,
        data.topPainPoints ? JSON.stringify(data.topPainPoints) : null,
        data.firstContactAt || null, data.lastContactAt || null,
        data.outcomeAt || null, data.daysInPipeline || null
      );
    }
  },

  getByDealId(dealId) {
    return db.prepare('SELECT * FROM deal_outcomes WHERE pipedrive_deal_id = ?').get(dealId);
  },

  getWonVsLost({ fromDate, toDate } = {}) {
    let where = '1=1';
    const params = [];
    if (fromDate) { where += ' AND outcome_at >= ?'; params.push(fromDate); }
    if (toDate)   { where += ' AND outcome_at <= ?'; params.push(toDate); }

    return db.prepare(`
      SELECT
        outcome,
        COUNT(*) as count,
        ROUND(AVG(total_calls), 1) as avg_calls,
        ROUND(AVG(days_in_pipeline), 0) as avg_days
      FROM deal_outcomes
      WHERE ${where}
      GROUP BY outcome
    `).all(...params);
  },
};

// ============================================================
// SMS-besked hjælpefunktioner
// ============================================================
const messages = {
  upsert(msgData) {
    const stmt = db.prepare(`
      INSERT INTO messages (
        relatel_id, direction, phone_number, employee_number,
        body, sent_at, pipedrive_person_id, pipedrive_deal_id
      ) VALUES (
        @relatel_id, @direction, @phone_number, @employee_number,
        @body, @sent_at, @pipedrive_person_id, @pipedrive_deal_id
      )
      ON CONFLICT(relatel_id) DO UPDATE SET
        pipedrive_person_id = COALESCE(excluded.pipedrive_person_id, pipedrive_person_id),
        pipedrive_deal_id   = COALESCE(excluded.pipedrive_deal_id, pipedrive_deal_id)
    `);
    return stmt.run({
      relatel_id: msgData.relatel_id,
      direction: msgData.direction,
      phone_number: msgData.phone_number,
      employee_number: msgData.employee_number || null,
      body: msgData.body || null,
      sent_at: msgData.sent_at || null,
      pipedrive_person_id: msgData.pipedrive_person_id || null,
      pipedrive_deal_id: msgData.pipedrive_deal_id || null,
    });
  },

  getById(relatelId) {
    return db.prepare('SELECT * FROM messages WHERE relatel_id = ?').get(relatelId);
  },

  getByPersonId(personId, limit = 50) {
    return db.prepare(`
      SELECT * FROM messages
      WHERE pipedrive_person_id = ?
      ORDER BY sent_at DESC
      LIMIT ?
    `).all(personId, limit);
  },

  getByDealId(dealId, limit = 50) {
    return db.prepare(`
      SELECT * FROM messages
      WHERE pipedrive_deal_id = ?
      ORDER BY sent_at DESC
      LIMIT ?
    `).all(dealId, limit);
  },

  getByPhone(phoneNumber, limit = 50) {
    const normalized = phoneNumber.replace(/^(\+|00)/, '');
    return db.prepare(`
      SELECT * FROM messages
      WHERE phone_number LIKE ?
      ORDER BY sent_at DESC
      LIMIT ?
    `).all(`%${normalized}`, limit);
  },

  setNoteId(relatelId, noteId) {
    return db.prepare('UPDATE messages SET pipedrive_note_id = ? WHERE relatel_id = ?').run(noteId, relatelId);
  },

  getUnlinked(limit = 50) {
    return db.prepare(`
      SELECT * FROM messages
      WHERE pipedrive_person_id IS NULL
      ORDER BY sent_at DESC LIMIT ?
    `).all(limit);
  },
};

// ============================================================
// Relatel noter hjælpefunktioner
// ============================================================
const relatelNotes = {
  upsert(noteData) {
    return db.prepare(`
      INSERT INTO relatel_notes (
        relatel_id, relatel_contact_id, phone_number, author, body,
        created_at_rel, pipedrive_person_id, pipedrive_note_id
      ) VALUES (
        @relatel_id, @relatel_contact_id, @phone_number, @author, @body,
        @created_at_rel, @pipedrive_person_id, @pipedrive_note_id
      )
      ON CONFLICT(relatel_id) DO UPDATE SET
        pipedrive_person_id = COALESCE(excluded.pipedrive_person_id, pipedrive_person_id),
        pipedrive_note_id   = COALESCE(excluded.pipedrive_note_id, pipedrive_note_id)
    `).run({
      relatel_id: noteData.relatel_id,
      relatel_contact_id: noteData.relatel_contact_id || null,
      phone_number: noteData.phone_number || null,
      author: noteData.author || null,
      body: noteData.body || null,
      created_at_rel: noteData.created_at_rel || null,
      pipedrive_person_id: noteData.pipedrive_person_id || null,
      pipedrive_note_id: noteData.pipedrive_note_id || null,
    });
  },

  getById(relatelId) {
    return db.prepare('SELECT * FROM relatel_notes WHERE relatel_id = ?').get(relatelId);
  },

  getByPersonId(personId, limit = 50) {
    return db.prepare(`
      SELECT * FROM relatel_notes
      WHERE pipedrive_person_id = ?
      ORDER BY created_at_rel DESC
      LIMIT ?
    `).all(personId, limit);
  },

  getByPhone(phoneNumber, limit = 50) {
    const normalized = phoneNumber.replace(/^(\+|00)/, '');
    return db.prepare(`
      SELECT * FROM relatel_notes
      WHERE phone_number LIKE ?
      ORDER BY created_at_rel DESC
      LIMIT ?
    `).all(`%${normalized}`, limit);
  },
};

const state = {
  get(key) {
    const row = db.prepare('SELECT value FROM system_state WHERE key = ?').get(key);
    return row ? row.value : null;
  },
  set(key, value) {
    db.prepare(`
      INSERT INTO system_state (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, String(value));
  },
};

module.exports = { db, calls, messages, relatelNotes, insights, dealOutcomes, state };
