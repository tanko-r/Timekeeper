// ---------------------------------------------------------------------------
// ADVERSARIAL VERIFICATION — independent reproduction of the claim:
//
//   "Changing an entry's matter or date lets the timer file the same day
//    clock a second time"
//
// These tests are written from scratch (not copied from the claimant's file)
// and every assertion is checked against the SQLite rows read directly out of
// the temp database, not against API response shapes.
//
// EVERY TEST HERE IS A *PROVING* TEST: each asserts the rule the brief states
// ("No time and no narrative may ever be lost… No entry dropped, skipped, or
// double-counted") and each FAILS against ui-overhaul-2026-08 as it stands.
// DO NOT weaken an assertion to make the suite green — fix the server.
//
//   V1  PATCH /api/entries/:id {cm_id}  → next START files the whole day
//       clock into a brand-new entry while the moved entry keeps its hours.
//   V2  PATCH /api/entries/:id {date}   → identical, via the date arm of the
//       same validity check in syncToEntry().
//   V3  POST  /api/entries/bulk {action:'set_cm'} → identical.
//   V4  CONTROL: finalizeOne() zeroes + unlinks, so the finalize path does
//       NOT double-count. This one PASSES today and pins the correct shape
//       the three paths above are missing.
// ---------------------------------------------------------------------------
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

const TODAY = '2026-08-14';
const YESTERDAY = '2026-08-13';
const START = '2026-08-14T09:00:00-07:00';

function makeClock(startIso) {
  let now = new Date(startIso).getTime();
  const clock = () => new Date(now);
  clock.advance = (seconds) => { now += seconds * 1000; };
  return clock;
}

async function withServer(fn) {
  const clock = makeClock(START);
  const t = await startTestServer({ clock });
  try { await fn(t, clock); } finally { await t.close(); }
}

const mkCm = (t, cm_number, short_name) =>
  t.fetchJson('POST', '/api/cms', { cm_number, short_name, billable: 1 })
    .then((r) => r.body);

// Read the truth out of SQLite: every live entry with its matter label and the
// total that would actually export (total_override, else the sum of lines).
function liveEntries(db) {
  return db.prepare(`
    SELECT e.id, e.date, e.cm_id, e.status, e.narrative,
           COALESCE(e.total_override,
             (SELECT COALESCE(SUM(duration), 0) FROM entry_tasks WHERE entry_id = e.id)) AS total,
           (SELECT short_name FROM matters WHERE matters.id = e.cm_id) AS matter
    FROM entries e WHERE e.deleted_at IS NULL ORDER BY e.id`).all();
}

const timerRow = (db, id) => db.prepare(
  'SELECT id, cm_id, running, accumulated_seconds, linked_entry_id FROM timers WHERE id=?').get(id);

// ---------------------------------------------------------------------------
// V1 — the matter variant.
// ---------------------------------------------------------------------------
test('V1: moving an entry to another matter must not let the day clock file twice', () =>
  withServer(async (t, clock) => {
    const acme = await mkCm(t, '100001-000012', 'Acme lease');
    const verity = await mkCm(t, '200002-000001', 'Verity merger');

    const timer = (await t.fetchJson('POST', '/api/timers', {
      name: 'Acme lease', cm_id: acme.id,
    })).body;

    // 1.0h of real work.
    await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
    clock.advance(3600);
    const first = (await t.fetchJson('POST', `/api/timers/${timer.id}/stop`)).body;
    assert.equal(first.hours, 1, 'first stop files 1.0h');
    const movedId = first.entry.id;

    // "That hour was actually Verity, not Acme." Reassign the ENTRY.
    const moved = await t.fetchJson('PATCH', `/api/entries/${movedId}`, { cm_id: verity.id });
    assert.equal(moved.status, 200);
    assert.equal(moved.body.cm_id, verity.id);

    // DB state after the move — the timer is still linked and still holds the
    // whole day on its clock. This is the mechanism, read from the rows.
    const afterMove = timerRow(t.db, timer.id);
    assert.equal(afterMove.linked_entry_id, movedId,
      'timer is still linked to the entry that left its matter');
    assert.equal(afterMove.accumulated_seconds, 3600,
      'timer still holds the whole day clock');

    // Another half hour on the SAME clock (a day accumulator: 1.5h total
    // elapsed, not 1.5h more).
    await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
    clock.advance(1800);
    const second = (await t.fetchJson('POST', `/api/timers/${timer.id}/stop`)).body;
    assert.equal(second.hours, 1.5, 'the clock is a day accumulator');

    const rows = liveEntries(t.db);
    const billed = rows.reduce((a, e) => a + Number(e.total), 0);
    assert.equal(
      Math.round(billed * 100) / 100, 1.5,
      `1.5h elapsed on one clock produced ${billed}h of stored entries: `
      + JSON.stringify(rows.map((e) => [e.matter, e.total])));
  }));

// ---------------------------------------------------------------------------
// V2 — the date variant. Same validity check, other arm.
// ---------------------------------------------------------------------------
test('V2: moving an entry to another date must not let the day clock file twice', () =>
  withServer(async (t, clock) => {
    const acme = await mkCm(t, '100001-000012', 'Acme lease');
    const timer = (await t.fetchJson('POST', '/api/timers', {
      name: 'Acme lease', cm_id: acme.id,
    })).body;

    await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
    clock.advance(3600);
    const first = (await t.fetchJson('POST', `/api/timers/${timer.id}/stop`)).body;
    assert.equal(first.hours, 1);

    // "That was yesterday's call, I forgot to log it."
    const moved = await t.fetchJson('PATCH', `/api/entries/${first.entry.id}`, { date: YESTERDAY });
    assert.equal(moved.status, 200);
    assert.equal(moved.body.date, YESTERDAY);

    assert.equal(timerRow(t.db, timer.id).linked_entry_id, first.entry.id,
      'timer is still linked to the entry that left today');

    await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
    clock.advance(1800);
    const second = (await t.fetchJson('POST', `/api/timers/${timer.id}/stop`)).body;
    assert.equal(second.hours, 1.5);

    const rows = liveEntries(t.db);
    const billed = rows.reduce((a, e) => a + Number(e.total), 0);
    assert.equal(
      Math.round(billed * 100) / 100, 1.5,
      `1.5h elapsed on one clock produced ${billed}h of stored entries: `
      + JSON.stringify(rows.map((e) => [e.date, e.matter, e.total])));
  }));

// ---------------------------------------------------------------------------
// V3 — the bulk variant (Search view → select → reassign matter).
// ---------------------------------------------------------------------------
test('V3: bulk set_cm must not let the day clock file twice', () =>
  withServer(async (t, clock) => {
    const acme = await mkCm(t, '100001-000012', 'Acme lease');
    const verity = await mkCm(t, '200002-000001', 'Verity merger');
    const timer = (await t.fetchJson('POST', '/api/timers', {
      name: 'Acme lease', cm_id: acme.id,
    })).body;

    await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
    clock.advance(3600);
    const first = (await t.fetchJson('POST', `/api/timers/${timer.id}/stop`)).body;
    assert.equal(first.hours, 1);

    const bulk = await t.fetchJson('POST', '/api/entries/bulk', {
      ids: [first.entry.id], action: 'set_cm', cm_id: verity.id,
    });
    assert.deepEqual(bulk.body.done, [first.entry.id]);

    await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
    clock.advance(1800);
    await t.fetchJson('POST', `/api/timers/${timer.id}/stop`);

    const rows = liveEntries(t.db);
    const billed = rows.reduce((a, e) => a + Number(e.total), 0);
    assert.equal(
      Math.round(billed * 100) / 100, 1.5,
      `1.5h elapsed on one clock produced ${billed}h of stored entries: `
      + JSON.stringify(rows.map((e) => [e.matter, e.total])));
  }));

// ---------------------------------------------------------------------------
// V5 — the SILENT variant, and the worst of them. After moving the entry the
// attorney does nothing else: he goes home. The nightly rollover in
// applyRollovers() banks the still-held clock, hits the same failed validity
// check, and files a duplicate onto YESTERDAY. applyRollovers discards
// syncToEntry's return value, so not even the `relinked` flag escapes — there
// is no toast, no response field, nothing on screen.
// ---------------------------------------------------------------------------
test('V5: moving an entry then letting the day turn must not bank the clock twice', () =>
  withServer(async (t, clock) => {
    const acme = await mkCm(t, '100001-000012', 'Acme lease');
    const verity = await mkCm(t, '200002-000001', 'Verity merger');
    const timer = (await t.fetchJson('POST', '/api/timers', {
      name: 'Acme lease', cm_id: acme.id,
    })).body;

    await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
    clock.advance(3600);
    const first = (await t.fetchJson('POST', `/api/timers/${timer.id}/stop`)).body;
    assert.equal(first.hours, 1);
    await t.fetchJson('PATCH', `/api/entries/${first.entry.id}`, { cm_id: verity.id });

    // He goes home. Next morning the app is opened — nothing else happens.
    clock.advance(20 * 3600); // into 2026-08-15
    const list = await t.fetchJson('GET', '/api/timers');
    assert.equal(list.status, 200);

    const rows = liveEntries(t.db);
    const billed = rows.reduce((a, e) => a + Number(e.total), 0);
    assert.equal(
      Math.round(billed * 100) / 100, 1,
      `1.0h on the clock became ${billed}h of stored entries with no further user action: `
      + JSON.stringify(rows.map((e) => [e.date, e.matter, e.total])));
  }));

// ---------------------------------------------------------------------------
// V4 — CONTROL. The finalize path already does the right thing (finalizeOne
// zeroes accumulated_seconds and nulls linked_entry_id). This test PASSES on
// ui-overhaul-2026-08 and is the shape V1–V3 are missing. If this one ever
// starts failing, the fix for V1–V3 broke the working path.
// ---------------------------------------------------------------------------
test('V4 (control): finalizing an entry zeroes the clock so no hour files twice', () =>
  withServer(async (t, clock) => {
    const acme = await mkCm(t, '100001-000012', 'Acme lease');
    const timer = (await t.fetchJson('POST', '/api/timers', {
      name: 'Acme lease', cm_id: acme.id,
    })).body;

    await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
    clock.advance(3600);
    const first = (await t.fetchJson('POST', `/api/timers/${timer.id}/stop`)).body;
    await t.fetchJson('PATCH', `/api/entries/${first.entry.id}`, {
      narrative: 'Reviewed lease amendment and conferred with landlord counsel.',
    });
    const fin = await t.fetchJson('POST', `/api/entries/${first.entry.id}/finalize`, { ack: true });
    assert.equal(fin.status, 200, JSON.stringify(fin.body));

    const cleared = timerRow(t.db, timer.id);
    assert.equal(cleared.accumulated_seconds, 0, 'finalize zeroes the day clock');
    assert.equal(cleared.linked_entry_id, null, 'finalize unlinks');

    await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
    clock.advance(1800);
    await t.fetchJson('POST', `/api/timers/${timer.id}/stop`);

    const rows = liveEntries(t.db);
    const billed = rows.reduce((a, e) => a + Number(e.total), 0);
    assert.equal(
      Math.round(billed * 100) / 100, 1.5,
      `1.5h elapsed on one clock produced ${billed}h of stored entries: `
      + JSON.stringify(rows.map((e) => [e.matter, e.total, e.status])));
  }));
