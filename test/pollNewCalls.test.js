// Indhentning efter nedetid: opkald, der ikke kan kobles, fordi Pipedrive
// holder pause, må ikke tabes. Markøren holdes ved det ældste udskudte opkald.
require('./helpers');
const test = require('node:test');
const assert = require('node:assert');

const relatel = require('../src/services/relatel');
const pipedrive = require('../src/services/pipedrive');
const { state, calls } = require('../src/db/database');
const jobs = require('../src/jobs/pollCalls');

const raw = (uuid, number, endedAt) => ({
  call_uuid: uuid, direction: 'outgoing', from_number: '4571747007', to_number: number,
  started_at: endedAt, answered_at: endedAt, ended_at: endedAt, talk_duration: 60,
});

test('udskudte opkald holder markøren tilbage og kommer med næste gang', async () => {
  const origLog = console.log; console.log = () => {};
  try {
    state.set('last_call_check', '2026-10-22T09:00:00.000Z');
    const batch = [
      raw('u1', '4591111111', '2026-10-22T09:30:00.000Z'),
      raw('u2', '4592222222', '2026-10-22T10:00:00.000Z'),
      raw('u3', '4593333333', '2026-10-22T10:30:00.000Z'),
    ];
    relatel.getCalls = async () => batch;
    relatel.getCall = async () => null;
    let pdDown = true;
    pipedrive.isRateLimited = () => false;
    pipedrive.getPersonWithDeals = async () => ({ latestDealId: 1 });
    pipedrive.createCallActivity = async () => 1000 + Math.floor(Math.random() * 1000);
    pipedrive.searchPersonByPhone = async (phone) => {
      if (phone.endsWith('91111111')) return { status: 'found', person: { id: 11 } };
      if (phone.endsWith('92222222')) return pdDown ? { status: 'error', person: null } : { status: 'found', person: { id: 22 } };
      return { status: 'none', person: null };
    };

    await jobs.pollNewCalls();
    assert.ok(calls.getByUuid('u1').pipedrive_activity_id, 'u1 kom i Pipedrive');
    assert.strictEqual(calls.getByUuid('u2').pipedrive_activity_id, null, 'u2 venter');
    assert.strictEqual(state.get('last_call_check'), '2026-10-22T09:59:59.000Z', 'markøren holdes lige før u2');

    pdDown = false;
    await jobs.pollNewCalls();
    assert.ok(calls.getByUuid('u2').pipedrive_activity_id, 'u2 kom med anden gang');
    assert.ok(Date.parse(state.get('last_call_check')) > Date.parse('2026-10-23T00:00:00Z'), 'markøren rykker frem til nu');
  } finally {
    console.log = origLog;
  }
});
