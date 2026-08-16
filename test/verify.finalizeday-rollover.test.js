// ---------------------------------------------------------------------------
// REGRESSION — POST /api/finalize-day must bank the overnight clock first.
//
// Every other timer-aware surface calls applyRollovers() before it reads or
// writes anything: the timer routes, the dashboard, the nightly job. Until
// 2026-08-16 the close-out route did NOT. So the one flow David actually
// performs — leave a timer running overnight, open the app the next morning,
// close out yesterday — finalized yesterday's entry at its stale total and
// then ran finalizeOne's zero+unlink loop over the timer, erasing the whole
// overnight clock. Nothing blocked, nothing warned, nothing was audited.
//
// docs/ui/BRIEF.md, "Data integrity": no time may be lost, and none may be
// double-counted. These tests hold the close-out route to both halves.
//
// The clock crosses a local midnight, so each test builds its own server.
// NOTE: no request may touch /api/timers or the dashboard before the
// finalize-day call — those endpoints roll over on their own and would hide
// the defect this file exists to pin.
// ---------------------------------------------------------------------------
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

const YESTERDAY = '2026-08-13';
const TODAY = '2026-08-14';
const LAST_NIGHT = new Date(`${YESTERDAY}T23:00:00-07:00`);
const THIS_MORNING = new Date(`${TODAY}T09:00:00-07:00`);

const NARRATIVE = 'Reviewed the lease renewal amendment and conferred with '
  + 'landlord counsel regarding the estoppel certificate.';

async function withOvernightTimer(fn) {
  const state = { now: LAST_NIGHT };
  const t = await startTestServer({ clock: () => state.now });
  try {
    const cm = (await t.fetchJson('POST', '/api/cms', {
      cm_number: '100001-000012', short_name: 'Acme lease', billable: 1,
    })).body;
    const timer = (await t.fetchJson('POST', '/api/timers', {
      name: 'Acme lease', cm_id: cm.id,
    })).body;
    // 23:00 — he starts the timer and never stops it.
    await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
    const entryId = t.db.prepare(
      'SELECT linked_entry_id FROM timers WHERE id=?').get(timer.id).linked_entry_id;
    assert.ok(entryId, 'starting the timer opens an entry for the day it started');
    await t.fetchJson('PATCH', `/api/entries/${entryId}`, { narrative: NARRATIVE });

    // …and picks the laptop up the next morning at 09:00. Ten hours of clock:
    // one before midnight (yesterday's) and nine after (today's).
    state.now = THIS_MORNING;
    await fn(t, { cm, timer, entryId, state });
  } finally { await t.close(); }
}

// Every live entry's billable total, straight out of SQLite.
function totalsByDate(db) {
  const rows = db.prepare(`
    SELECT e.date,
      COALESCE(e.total_override,
        (SELECT COALESCE(SUM(duration), 0) FROM entry_tasks WHERE entry_id = e.id)) AS total
    FROM entries e WHERE e.deleted_at IS NULL`).all();
  const out = {};
  for (const r of rows) out[r.date] = Math.round(((out[r.date] || 0) + Number(r.total)) * 100) / 100;
  return out;
}

// The hours still live on a timer's clock right now.
function clockHours(db, id, nowMs) {
  const t = db.prepare(
    'SELECT running, accumulated_seconds, last_started_at FROM timers WHERE id=?').get(id);
  let s = t.accumulated_seconds;
  if (t.running && t.last_started_at) s += Math.max(0, (nowMs - Date.parse(t.last_started_at)) / 1000);
  return Math.round((Math.floor(s) / 3600) * 100) / 100;
}

test('closing out yesterday banks the overnight clock instead of erasing it', () =>
  withOvernightTimer(async (t, { entryId }) => {
    const fin = await t.fetchJson('POST', '/api/finalize-day', { date: YESTERDAY, ack: true });
    assert.equal(fin.status, 200, JSON.stringify(fin.body));

    const entry = (await t.fetchJson('GET', `/api/entries/${entryId}`)).body;
    assert.equal(entry.date, YESTERDAY);
    assert.equal(entry.status, 'finalized');
    // 23:00 → midnight is one hour, and it belongs to the day it was worked.
    assert.equal(entry.total, 1,
      'the hour worked before midnight must reach the entry close-out locks');
  }));

// The day clock is an ACCUMULATOR per linked entry: syncToEntry SETS the
// entry's total from the clock rather than adding to it, so today's hours
// legitimately appear in both places at once. Accounting for today therefore
// takes the larger of the two, never their sum.
test('closing out yesterday loses none of the ten hours on the overnight clock', () =>
  withOvernightTimer(async (t, { timer, state }) => {
    await t.fetchJson('POST', '/api/finalize-day', { date: YESTERDAY, ack: true });

    const byDate = totalsByDate(t.db);
    assert.deepEqual(Object.keys(byDate).sort(), [YESTERDAY, TODAY],
      `the two days worked are the only days with entries: ${JSON.stringify(byDate)}`);
    const live = clockHours(t.db, timer.id, state.now.getTime());
    const accounted = (byDate[YESTERDAY] || 0) + Math.max(byDate[TODAY] || 0, live);
    assert.equal(
      Math.round(accounted * 100) / 100, 10,
      'ten hours elapsed; every one must be either filed on an entry or still '
      + `on the clock (stored ${JSON.stringify(byDate)}, clock ${live}h)`);
  }));

// The other direction: settling a running clock onto the entry close-out is
// locking must never move TODAY's hours onto a YESTERDAY-dated entry. The hour
// before midnight is yesterday's; the nine after it are not.
test('closing out yesterday does not book today’s hours onto yesterday’s entry', () =>
  withOvernightTimer(async (t, { timer, entryId, state }) => {
    await t.fetchJson('POST', '/api/finalize-day', { date: YESTERDAY, ack: true });

    const byDate = totalsByDate(t.db);
    assert.equal(byDate[YESTERDAY], 1, 'yesterday keeps exactly the hour it was worked');
    const entry = (await t.fetchJson('GET', `/api/entries/${entryId}`)).body;
    assert.equal(entry.total, 1, 'the locked entry carries one hour, not ten');
    const live = clockHours(t.db, timer.id, state.now.getTime());
    const today = byDate[TODAY] || 0;
    assert.equal(
      Math.max(today, live), 9,
      `today owns the nine hours since midnight and no more (entries ${today}h, clock ${live}h)`);
  }));
