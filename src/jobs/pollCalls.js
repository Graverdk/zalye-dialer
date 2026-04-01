'use strict';

const cron = require('node-cron');
const config = require('../config');
const { db } = require('../db/database');
const relatel = require('../services/relatel');
const pipedrive = require('../services/pipedrive');
const { transcribe } = require('../services/transcription');
const claude = require('../services/claude');

// -------------------------------------------------------
// Opret tabeller hvis de ikke findes
// -------------------------------------------------------
db.prepare(`CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
)`).run();

db.prepare(`CREATE TABLE IF NOT EXISTS synced_notes (
  relatel_note_id INTEGER PRIMARY KEY,
  pipedrive_note_id INTEGER,
  synced_at TEXT DEFAULT (datetime('now'))
)`).run();

// -------------------------------------------------------
// linkToPipedrive — opret opkaldsnote i Pipedrive (én gang)
// -------------------------------------------------------
async function linkToPipedrive(normalizedCall) {
  if (!normalizedCall.phone) return;

  const person = await pipedrive.findPersonByPhone(normalizedCall.phone);
  if (!person) return;

  const existing = db.prepare('SELECT pipedrive_note_id FROM calls WHERE relatel_uuid = ?')
    .get(normalizedCall.relatel_uuid);

  if (existing && existing.pipedrive_note_id) return;

  const noteId = await pipedrive.createCallNote({
    personId:  person.id,
    phone:     normalizedCall.phone,
    direction: normalizedCall.direction,
    duration:  normalizedCall.duration,
    startedAt: normalizedCall.started_at,
  });

  if (noteId) {
    db.prepare('UPDATE calls SET pipedrive_note_id = ?, pipedrive_person_id = ? WHERE relatel_uuid = ?')
      .run(noteId, person.id, normalizedCall.relatel_uuid);
    console.log(`[Poll] ✅ Opkaldsnote oprettet i Pipedrive (note ${noteId}) for ${normalizedCall.phone}`);
  }
}

// -------------------------------------------------------
// processTranscriptions — Whisper + Claude (uden race condition)
// -------------------------------------------------------
async function processTranscriptions() {
  const pending = db.prepare(
    "SELECT * FROM calls WHERE transcription_status = 'pending' AND recording_url IS NOT NULL"
  ).all();

  if (pending.length === 0) return;
  console.log(`[AI] Behandler ${pending.length} opkald...`);

  for (const call of pending) {
    // Sæt 'processing' STRAKS inden async-arbejde starter
    db.prepare("UPDATE calls SET transcription_status = 'processing' WHERE relatel_uuid = ?")
      .run(call.relatel_uuid);

    console.log(`[AI] Behandler: ${call.relatel_uuid}`);

    try {
      console.log('[AI] Downloader optagelse...');
      const audioBuffer = await relatel.downloadRecording(call.recording_url);

      const transcription = await transcribe(audioBuffer);

      let summary = transcription;
      if (transcription) {
        console.log('[AI] Analyserer med Claude...');
        summary = await claude.summarizeCall(transcription, {
          phone:     call.phone,
          direction: call.direction,
          duration:  call.duration,
        });
      }

      if (summary && call.pipedrive_note_id) {
        await pipedrive.updateNoteWithTranscription(call.pipedrive_note_id, summary);
      }

      db.prepare("UPDATE calls SET transcription_status = 'done', transcription = ? WHERE relatel_uuid = ?")
        .run(summary || '', call.relatel_uuid);
      console.log(`[AI] ✅ Færdig: ${call.relatel_uuid}`);

    } catch (err) {
      console.log(`[AI] Transskription sprunget over: ${err.message}`);
      db.prepare("UPDATE calls SET transcription_status = 'done' WHERE relatel_uuid = ?")
        .run(call.relatel_uuid);
      console.log(`[AI] ✅ Færdig: ${call.relatel_uuid}`);
    }
  }
}

// -------------------------------------------------------
// fetchNewMessages — SMS via /messages + /chats
// -------------------------------------------------------
async function fetchNewMessages() {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'last_sms_check'").get();
  const lastChecked = row ? row.value : new Date(Date.now() - 60000).toISOString();
  console.log(`[SMS] Henter beskeder efter: ${lastChecked}`);

  const newMessages = [];

  try {
    const messages = await relatel.getMessages();
    const fresh = (messages || []).filter(m => new Date(m.created_at) > new Date(lastChecked));
    console.log(`[SMS] /messages: ${messages?.length || 0} total, ${fresh.length} nye`);
    newMessages.push(...fresh);
  } catch (e) { console.error('[SMS] /messages fejl:', e.message); }

  try {
    const chats = await relatel.getChats();
    console.log(`[SMS] /chats svar: ${chats?.length || 0} elementer`);
    const freshChats = (chats || []).filter(c => {
      const ts = c.created_at || c.updated_at || c.last_message_at;
      return ts && new Date(ts) > new Date(lastChecked);
    });
    newMessages.push(...freshChats);
  } catch (e) { console.error('[SMS] /chats fejl:', e.message); }

  console.log(`[SMS] Fandt ${newMessages.length} nye beskeder`);

  for (const msg of newMessages) {
    const phone = msg.from_number || msg.from || msg.number;
    if (!phone) continue;
    const person = await pipedrive.findPersonByPhone(phone);
    if (!person) continue;
    await pipedrive.createSmsNote({
      personId:  person.id,
      phone,
      body:      msg.body || msg.text || msg.message || '',
      direction: msg.direction || 'incoming',
      createdAt: msg.created_at,
    });
    console.log(`[SMS] ✅ SMS-note oprettet i Pipedrive for ${phone}`);
  }

  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('last_sms_check', ?)")
    .run(new Date().toISOString());
}

// -------------------------------------------------------
// fetchNewNotes — Relatel-noter → Pipedrive (ingen dubletter)
// -------------------------------------------------------
async function fetchNewNotes() {
  console.log('[Noter] Henter kontakter fra Relatel...');
  try {
    const contacts = await relatel.getContacts();

    for (const contact of contacts) {
      if (!contact.number) continue;

      const person = await pipedrive.findPersonByPhone(contact.number);
      if (!person) continue;

      // Brug getComments (det faktiske funktionsnavn i relatel.js)
      const notes = await relatel.getComments(contact.id);
      if (!notes || notes.length === 0) continue;

      for (const note of notes) {
        if (!note.id) continue;

        // Deduplication via SQLite
        const already = db.prepare('SELECT 1 FROM synced_notes WHERE relatel_note_id = ?').get(note.id);
        if (already) continue;

        const body = note.body || note.text || note.comment || '';
        const noteId = await pipedrive.createNote({
          personId: person.id,
          content:  `## Note\n**Dato:** ${new Date(note.created_at).toLocaleString('da-DK')}\n${body}`,
        });

        if (noteId) {
          db.prepare('INSERT OR IGNORE INTO synced_notes (relatel_note_id, pipedrive_note_id) VALUES (?, ?)')
            .run(note.id, noteId);
          console.log(`[Noter] ✅ Note oprettet i Pipedrive for kontakt ${person.id}`);
        }
      }
    }
  } catch (e) {
    console.error('[Noter] Fejl:', e.message);
  }
}

// -------------------------------------------------------
// pollNewCalls — hent nye afsluttede opkald fra Relatel
// -------------------------------------------------------
async function pollNewCalls() {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'last_call_check'").get();
  const lastChecked = row ? row.value : new Date(Date.now() - 60000).toISOString();
  console.log(`[Poll] Henter opkald afsluttet efter: ${lastChecked}`);

  const calls = await relatel.getCompletedCalls(lastChecked);
  console.log(`[Poll] Fandt ${calls.length} afsluttede opkald`);

  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('last_call_check', ?)")
    .run(new Date().toISOString());

  for (const call of calls) {
    const normalizedCall = {
      relatel_uuid:  call.id || call.uuid,
      phone:         call.from_number || call.to_number,
      direction:     call.direction,
      duration:      call.duration,
      started_at:    call.started_at || call.created_at,
      recording_url: call.recording_url || null,
    };

    db.prepare(`INSERT OR IGNORE INTO calls
      (relatel_uuid, phone, direction, duration, started_at, recording_url, transcription_status)
      VALUES (?, ?, ?, ?, ?, ?, 'pending')`).run(
      normalizedCall.relatel_uuid, normalizedCall.phone, normalizedCall.direction,
      normalizedCall.duration, normalizedCall.started_at, normalizedCall.recording_url
    );

    await linkToPipedrive(normalizedCall);
  }
}

// -------------------------------------------------------
// start() — eksporteret funktion kaldt fra server.js
// -------------------------------------------------------
function start() {
  const INTERVAL = config.pollIntervalSeconds || 30;

  cron.schedule(`*/${INTERVAL} * * * * *`, async () => {
    try { await pollNewCalls(); } catch (e) { console.error('[Poll] Fejl:', e.message); }
  });

  cron.schedule('*/30 * * * * *', async () => {
    try { await fetchNewMessages(); } catch (e) { console.error('[SMS] Fejl:', e.message); }
  });

  cron.schedule('0 * * * * *', async () => {
    try { await fetchNewNotes(); } catch (e) { console.error('[Noter] Fejl:', e.message); }
    try { await processTranscriptions(); } catch (e) { console.error('[AI] Fejl:', e.message); }
  });

  console.log('[Poll] Cron-jobs startet.');
}

module.exports = { start, pollNewCalls, fetchNewMessages, fetchNewNotes, processTranscriptions };
