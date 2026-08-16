// =========================================================================
// REGRESSION GUARD — deleting a draft must not drop its hours off the clock.
//
// Written 2026-08-16 during Stage 1e, after a critic caught the fix for one
// time-loss defect introducing another.
//
// BACKGROUND. syncToEntry() in server/routes/timers.js now DEDUCTS from the
// day clock any hours a departed entry kept, so the same time is not billed on
// two rows. That is correct when the entry survives the break — it moved to
// another matter or another date, or it was finalized — because the hours
// really are settled there.
//
// It is WRONG when the entry was SOFT-DELETED. A deleted entry is off every
// bill, every export and every total: it keeps nothing. Deducting its hours
// takes them off the clock as well, so they exist nowhere. Measured on the
// first version of that fix:
//
//     stop 1.0h  →  delete the entry  →  stop again
//     before the fix : the second stop filed 1.5h   (correct)
//     after  the fix : the second stop filed 0.5h   (one hour gone)
//
// The standard is docs/ui/BRIEF.md, "Data integrity": no time may be lost,
// dropped, or double-counted. This file holds BOTH sides of that line, so a
// future change cannot satisfy one by breaking the other.
// =========================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

function makeClock(startIso) {
  let now = new Date(startIso).getTime();
  const clock = () => new Date(now);
  clock.advance = (seconds) => { now += seconds * 1000; };
  return clock;
}

async function withServer(fn, startIso = '2026-08-14T09:00:00-07:00') {
  const clock = makeClock(startIso);
  const t = await startTestServer({ clock });
  try { return await fn(t, clock); } finally { await t.close(); }
}

const mkCm = async (t, cm_number, short_name, client_name) => {
  const r = await t.fetchJson('POST', '/api/cms', { cm_number, short_name, client_name, billable: 1 });
  assert.ok(r.status < 300, `cm create failed: ${JSON.stringify(r.body)}`);
  return r.body;
};

// Every live entry's hours, straight out of SQLite. Deleted rows are excluded
// exactly the way the export excludes them.
function liveHours(t) {
  return t.db.prepare(`
    SELECT COALESCE(e.total_override,
             (SELECT COALESCE(SUM(duration), 0) FROM entry_tasks WHERE entry_id = e.id)) AS hours
      FROM entries e WHERE e.deleted_at IS NULL`).all()
    .reduce((a, r) => a + Number(r.hours || 0), 0);
}

// -------------------------------------------------------------------------
// THE REGRESSION — a deleted entry keeps nothing, so its hours stay on the
// clock and must reach the next entry.
// -------------------------------------------------------------------------
test('a deleted draft does not take its hours off the day clock', () =>
  withServer(async (t, clock) => {
    const acme = await mkCm(t, '600001-000010', 'Borealis Merger', 'Acme Holdings');
    const timer = (await t.fetchJson('POST', '/api/timers', {
      name: 'Borealis Merger', cm_id: acme.id, task_code: 'Research',
    })).body;

    // an hour of work, filed
    await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
    clock.advance(3600);
    const first = (await t.fetchJson('POST', `/api/timers/${timer.id}/stop`)).body;
    assert.equal(first.hours, 1, 'precondition: the first stop filed an hour');

    // the attorney bins that draft — a junk entry, a mis-start, a duplicate
    const del = await t.fetchJson('DELETE', `/api/entries/${first.entry.id}`);
    assert.equal(del.status, 200, `delete failed: ${JSON.stringify(del.body)}`);
    assert.ok(
      t.db.prepare('SELECT deleted_at d FROM entries WHERE id=?').get(first.entry.id).d,
      'precondition: the entry really is soft-deleted');
    assert.equal(liveHours(t), 0, 'precondition: no live entry holds any time now');

    // …and keeps timing the same matter
    await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
    clock.advance(1800);
    const second = (await t.fetchJson('POST', `/api/timers/${timer.id}/stop`)).body;

    // The whole day worked is 1.5h. The deleted entry holds none of it, so all
    // 1.5h must be on the entry the second stop filed.
    assert.equal(liveHours(t), 1.5,
      'the hour that was on the deleted draft has been dropped from every live '
      + `entry. Live entries now hold ${liveHours(t)}h for 1.5h worked. Rows: `
      + JSON.stringify(t.db.prepare(
        'SELECT id, total_override, deleted_at FROM entries').all(), null, 2));
    assert.equal(second.hours, 1.5, 'the second stop reports what it filed');
  }));

// -------------------------------------------------------------------------
// THE OTHER SIDE — an entry that SURVIVES the break really does keep its
// hours, so they must NOT be filed a second time. This is the defect the
// deduct was added for; it is here so a fix for the test above cannot be
// "delete the deduct".
// -------------------------------------------------------------------------
test('an entry moved to another matter keeps its hours, and they are not re-billed', () =>
  withServer(async (t, clock) => {
    const acme = await mkCm(t, '600001-000010', 'Borealis Merger', 'Acme Holdings');
    const north = await mkCm(t, '600002-000010', 'Harbor Lease', 'Northgate Partners');
    const timer = (await t.fetchJson('POST', '/api/timers', {
      name: 'Borealis Merger', cm_id: acme.id, task_code: 'Research',
    })).body;

    await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
    clock.advance(3600);
    const first = (await t.fetchJson('POST', `/api/timers/${timer.id}/stop`)).body;
    assert.equal(first.hours, 1, 'precondition: the first stop filed an hour');

    // the entry is re-filed under another matter — it survives, holding its hour
    const moved = await t.fetchJson('PATCH', `/api/entries/${first.entry.id}`,
      { cm_id: north.id });
    assert.equal(moved.status, 200, `move failed: ${JSON.stringify(moved.body)}`);

    await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
    clock.advance(1800);
    await t.fetchJson('POST', `/api/timers/${timer.id}/stop`);

    assert.equal(liveHours(t), 1.5,
      'the day worked is 1.5h and the books must show exactly 1.5h — the hour '
      + 'the moved entry kept has been billed twice. Rows: '
      + JSON.stringify(t.db.prepare(
        'SELECT id, cm_id, total_override FROM entries WHERE deleted_at IS NULL').all(), null, 2));
  }));
