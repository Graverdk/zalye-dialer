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

module.exports = { db, calls, state };
