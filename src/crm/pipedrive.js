// ============================================================
// Pipedrive-adapteren: nuværende services/pipedrive.js og
// services/autofill.js pakket bag CRM-grænsefladen (se src/crm/index.js).
// INGEN adfærdsændring — samme kald, samme rækkefølge, samme logtekster.
// Modulerne slås op ved hvert kald (svc.x(...)), så tests kan erstatte dem.
// ============================================================
const svc = require('../services/pipedrive');
const autofillSvc = require('../services/autofill');

const cols = {
  person: 'pipedrive_person_id',
  deal: 'pipedrive_deal_id',
  record: 'pipedrive_activity_id',
  legacyNote: 'pipedrive_note_id',   // opkald/SMS fra før 24/9 2026
  notePerson: 'pipedrive_person_id',
  noteRecord: 'pipedrive_note_id',
};

function isPaused() {
  return svc.isRateLimited();
}

function callBase(row) {
  return {
    direction: row.direction,
    phoneNumber: row.phone_number,
    startedAt: row.started_at,
    durationSec: row.duration_sec,
  };
}

// Opkald afsluttet (uden analyse) → udført call-aktivitet. Returnerer aktivitets-id eller null.
async function upsertCallRecord({ row, match }) {
  return svc.createCallActivity({
    personId: match.personId,
    dealId: match.latestDealId,
    callData: callBase(row),
  });
}

// Analyse færdig → opdatér aktiviteten (eller den gamle note), ellers opret en ny.
async function completeCallRecord({ row, match, callData }) {
  const personId = match && match.personId;
  const dealId = match && match.latestDealId;
  if (row.pipedrive_activity_id) {
    console.log('[AI] Opdaterer Pipedrive-aktivitet ' + row.pipedrive_activity_id + ' med transskription...');
    await svc.updateCallActivity(row.pipedrive_activity_id, { callData, dealId });
    return { recordId: row.pipedrive_activity_id, created: false };
  }
  if (row.pipedrive_note_id) {
    // Opkald fra før 24/9 2026 har en note — den opdateres fortsat
    console.log('[AI] Opdaterer Pipedrive-note ' + row.pipedrive_note_id + ' med transskription...');
    await svc.updateNote(row.pipedrive_note_id, { callData });
    return { recordId: null, created: false };
  }
  if (personId || dealId) {
    const newActivityId = await svc.createCallActivity({ personId, dealId, callData });
    if (newActivityId) console.log('[AI] Ny Pipedrive-opkaldsaktivitet oprettet: ' + newActivityId);
    return newActivityId ? { recordId: newActivityId, created: true } : null;
  }
  console.log('[AI] Ingen Pipedrive-match for ' + row.phone_number + ' — note ikke oprettet');
  return null;
}

async function autofill({ match, analysis }) {
  return autofillSvc.autofillFromCall({ personId: match.personId, dealId: match.latestDealId, analysis });
}

// { recordId } (SMS-aktivitet) eller { noteId } som nødløsning
async function upsertSms({ row, match }) {
  const { activityId, noteId } = await svc.createSmsRecord({
    personId: match.personId,
    dealId: match.latestDealId,
    smsData: {
      direction: row.direction,
      phoneNumber: row.phone_number,
      body: row.body,
      sentAt: row.sent_at,
    },
  });
  return { recordId: activityId || null, noteId: noteId || null };
}

async function upsertRelatelNote({ note, match }) {
  return svc.createRelatelNote({
    personId: match.personId,
    dealId: match.latestDealId,
    noteData: { author: note.author, body: note.body, createdAt: note.created_at_rel },
  });
}

// Navnesynk: Pipedrive er sandheden. 'error' = Pipedrive afviste kaldet (stop kørslen)
async function getContactForRelatel(rawPhone) {
  const person = await svc.findPersonByPhone(rawPhone);
  if (!person && svc.isRateLimited()) return { status: 'error' };
  if (!person) return { status: 'none' };
  const details = await svc.getPersonById(person.id);
  if (!details || !details.name) return { status: 'none' };
  return {
    status: 'found',
    name: details.name,
    company: (details.org_id && details.org_id.name) || null,
    email: (details.email && details.email.length > 0) ? details.email[0].value : null,
  };
}

module.exports = {
  name: 'pipedrive',
  label: 'Pipedrive',
  cols,
  isPaused,
  enabled: () => true,
  search: (phone) => svc.searchPersonByPhone(phone),
  getLinks: (personId) => svc.getPersonWithDeals(personId),
  upsertCallRecord,
  completeCallRecord,
  autofill,
  afterAnalysis: null,
  upsertSms,
  upsertRelatelNote,
  getContactForRelatel,
  createUnknownNumberTask: null,
};
