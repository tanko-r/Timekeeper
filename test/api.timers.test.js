import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

// Round-2 timer model: the clock is a DAY ACCUMULATOR. Stopping never zeroes
// it — it files/updates ONE linked draft entry for today. "fresh" zeroes the
// clock and unlinks so later time goes to a new entry.

function makeClock(startIso) {
  let now = new Date(startIso).getTime();
  const clock = () => new Date(now);
  clock.set = (iso) => { now = new Date(iso).getTime(); };
  clock.advance = (seconds) => { now += seconds * 1000; };
  return clock;
}

async function withServer(startIso, fn) {
  const clock = makeClock(startIso);
  const t = await startTestServer({ clock });
  try {
    const cm = (await t.fetchJson('POST', '/api/cms', {
      cm_number: '100001-000012', short_name: 'Acme lease', billable: 1,
    })).body;
    await fn(t, cm, clock);
  } finally { await t.close(); }
}

test('day accumulator: repeated start/stop grows ONE linked entry, clock never zeroes on stop', () =>
  withServer('2026-07-06T09:00:00-07:00', async (t, cm, clock) => {
    const timer = (await t.fetchJson('POST', '/api/timers', {
      name: 'Acme research', cm_id: cm.id, task_code: 'Research',
    })).body;

    await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
    clock.advance(1200); // 20 min
    const stop1 = (await t.fetchJson('POST', `/api/timers/${timer.id}/stop`)).body;
    assert.equal(stop1.hours, 0.4); // 1200s → rounds UP to 0.4
    assert.ok(stop1.entry);
    assert.equal(stop1.entry.total, 0.4);
    assert.equal(stop1.entry.tasks.length, 1);
    assert.equal(stop1.entry.tasks[0].duration, 0.4);

    let list = (await t.fetchJson('GET', '/api/timers')).body;
    assert.equal(list[0].running, 0);
    assert.equal(list[0].elapsed_seconds, 1200, 'clock keeps the day total after stop');
    assert.equal(list[0].linked_entry_id, stop1.entry.id);

    clock.advance(600); // paused gap — not counted
    await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
    clock.advance(1320); // total 2520s
    const stop2 = (await t.fetchJson('POST', `/api/timers/${timer.id}/stop`)).body;
    assert.equal(stop2.hours, 0.7);
    assert.equal(stop2.entry.id, stop1.entry.id, 'same entry updated, not a new one');
    assert.equal(stop2.entry.total, 0.7);
    assert.equal(stop2.entry.tasks.length, 1);
    assert.equal(stop2.entry.tasks[0].duration, 0.7);

    const dayEntries = (await t.fetchJson('GET', '/api/entries?date=2026-07-06')).body;
    assert.equal(dayEntries.length, 1);
  }));

test('re-sync preserves narrative and extra task lines the user added', () =>
  withServer('2026-07-06T09:00:00-07:00', async (t, cm, clock) => {
    const timer = (await t.fetchJson('POST', '/api/timers', {
      name: 'T', cm_id: cm.id, task_code: 'Research',
    })).body;
    await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
    clock.advance(3600);
    const stop1 = (await t.fetchJson('POST', `/api/timers/${timer.id}/stop`)).body;

    await t.fetchJson('PATCH', `/api/entries/${stop1.entry.id}`, {
      narrative: 'Research regarding federal preemption of state claims.',
      tasks: [
        { task_code: 'Research', duration: 0.6, fragment: 'research preemption' },
        { task_code: 'Draft', duration: 0.4, fragment: 'draft memo' },
      ],
    });

    await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
    clock.advance(1800); // day total 1.5
    const stop2 = (await t.fetchJson('POST', `/api/timers/${timer.id}/stop`)).body;
    assert.equal(stop2.entry.total, 1.5, 'total follows the clock');
    assert.equal(stop2.entry.tasks.length, 2, 'user task lines untouched');
    assert.equal(stop2.entry.tasks[0].duration, 0.6, 'multi-line durations untouched');
    assert.match(stop2.entry.narrative, /preemption/);
    // unallocated remainder surfaces as the sum-mismatch warning
    assert.ok(stop2.entry.validation.some((v) => v.code === 'sum_mismatch'));
  }));

test('fresh: zeroes clock, unlinks; next stop files a NEW entry; old entry retained', () =>
  withServer('2026-07-06T09:00:00-07:00', async (t, cm, clock) => {
    const timer = (await t.fetchJson('POST', '/api/timers', { name: 'T', cm_id: cm.id })).body;
    await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
    clock.advance(2520);
    const stop1 = (await t.fetchJson('POST', `/api/timers/${timer.id}/stop`)).body;

    const fresh = (await t.fetchJson('POST', `/api/timers/${timer.id}/fresh`)).body;
    assert.equal(fresh.timer.elapsed_seconds, 0);
    assert.equal(fresh.timer.linked_entry_id, null);

    await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
    clock.advance(3600);
    const stop2 = (await t.fetchJson('POST', `/api/timers/${timer.id}/stop`)).body;
    assert.notEqual(stop2.entry.id, stop1.entry.id);
    assert.equal(stop2.entry.total, 1.0);

    const dayEntries = (await t.fetchJson('GET', '/api/entries?date=2026-07-06')).body;
    assert.equal(dayEntries.length, 2, 'both entries exist');
  }));

test('clock is editable: set hours, ±tenths delta, clamped at zero, syncs linked entry when paused', () =>
  withServer('2026-07-06T09:00:00-07:00', async (t, cm, clock) => {
    const timer = (await t.fetchJson('POST', '/api/timers', { name: 'T', cm_id: cm.id })).body;
    await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
    clock.advance(1800);
    await t.fetchJson('POST', `/api/timers/${timer.id}/stop`); // links entry at 0.5

    const set = (await t.fetchJson('PUT', `/api/timers/${timer.id}/clock`, { hours: 1.4 })).body;
    assert.equal(set.timer.elapsed_seconds, 5040);
    assert.equal(set.entry.total, 1.4, 'paused+linked clock edit syncs the entry');

    const minus = (await t.fetchJson('PUT', `/api/timers/${timer.id}/clock`, { deltaHours: -0.1 })).body;
    assert.equal(minus.timer.elapsed_seconds, 4680); // 1.3h

    const clamped = (await t.fetchJson('PUT', `/api/timers/${timer.id}/clock`, { deltaHours: -9 })).body;
    assert.equal(clamped.timer.elapsed_seconds, 0);

    const bad = await t.fetchJson('PUT', `/api/timers/${timer.id}/clock`, { hours: -1 });
    assert.equal(bad.status, 400);

    // while running: set clock, elapsed continues from the new base
    await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
    await t.fetchJson('PUT', `/api/timers/${timer.id}/clock`, { hours: 0.5 });
    clock.advance(360);
    const list = (await t.fetchJson('GET', '/api/timers')).body;
    assert.equal(list[0].elapsed_seconds, 2160); // 1800 + 360
    assert.equal(list[0].running, 1);
  }));

test('backdated start: minutesAgo and atLastStop', () =>
  withServer('2026-07-06T09:00:00-07:00', async (t, cm, clock) => {
    const timer = (await t.fetchJson('POST', '/api/timers', { name: 'T', cm_id: cm.id })).body;

    await t.fetchJson('POST', `/api/timers/${timer.id}/start`, { minutesAgo: 10 });
    let list = (await t.fetchJson('GET', '/api/timers')).body;
    assert.equal(list[0].elapsed_seconds, 600);

    clock.advance(600); // 09:10, elapsed 1200
    await t.fetchJson('POST', `/api/timers/${timer.id}/stop`);
    clock.advance(900); // 15-min untracked gap
    await t.fetchJson('POST', `/api/timers/${timer.id}/start`, { atLastStop: true });
    list = (await t.fetchJson('GET', '/api/timers')).body;
    assert.equal(list[0].elapsed_seconds, 1200 + 900, 'gap since last stop is recaptured');
    assert.equal(list[0].running, 1);

    // starting an already-running timer with a backdate is refused
    const r = await t.fetchJson('POST', `/api/timers/${timer.id}/start`, { minutesAgo: 30 });
    assert.equal(r.status, 409);
  }));

test('misclick grace: stop within 2s of starting reverts as if nothing happened', () =>
  withServer('2026-07-06T09:00:00-07:00', async (t, cm, clock) => {
    const timer = (await t.fetchJson('POST', '/api/timers', { name: 'Tiny', cm_id: cm.id })).body;
    await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
    clock.advance(1);
    const stopped = (await t.fetchJson('POST', `/api/timers/${timer.id}/stop`)).body;
    assert.equal(stopped.hours, 0);
    assert.equal(stopped.entry, null);
    assert.equal(stopped.discarded, true);
    let list = (await t.fetchJson('GET', '/api/timers')).body;
    assert.equal(list[0].elapsed_seconds, 0, 'back to zero as if nothing happened');
    assert.equal(list[0].running, 0);
    assert.equal(list[0].last_stopped_at, null, 'a misclick must not move the last-stop anchor');
    assert.equal((await t.fetchJson('GET', '/api/entries?date=2026-07-06')).body.length, 0);

    // with prior time on the clock, only the sub-2s segment is discarded
    await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
    clock.advance(1800);
    await t.fetchJson('POST', `/api/timers/${timer.id}/stop`); // files 0.5
    const anchor = (await t.fetchJson('GET', '/api/timers')).body[0].last_stopped_at;
    await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
    clock.advance(2);
    const mis = (await t.fetchJson('POST', `/api/timers/${timer.id}/stop`)).body;
    assert.equal(mis.discarded, true);
    list = (await t.fetchJson('GET', '/api/timers')).body;
    assert.equal(list[0].elapsed_seconds, 1800, 'day total untouched by the misclick');
    assert.equal(list[0].last_stopped_at, anchor, 'anchor unchanged');
    assert.equal((await t.fetchJson('GET', '/api/entries?date=2026-07-06')).body.length, 1);
  }));

test('a 3-second stop files 0.1 (everything rounds up)', () =>
  withServer('2026-07-06T09:00:00-07:00', async (t, cm, clock) => {
    const timer = (await t.fetchJson('POST', '/api/timers', { name: 'T', cm_id: cm.id })).body;
    await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
    clock.advance(3);
    const stopped = (await t.fetchJson('POST', `/api/timers/${timer.id}/stop`)).body;
    assert.equal(stopped.hours, 0.1);
    assert.equal(stopped.entry.total, 0.1);
  }));

test('linked entry finalized meanwhile → stop rolls into a new entry automatically', () =>
  withServer('2026-07-06T09:00:00-07:00', async (t, cm, clock) => {
    const timer = (await t.fetchJson('POST', '/api/timers', { name: 'T', cm_id: cm.id })).body;
    await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
    clock.advance(1800);
    const stop1 = (await t.fetchJson('POST', `/api/timers/${timer.id}/stop`)).body;
    await t.fetchJson('PATCH', `/api/entries/${stop1.entry.id}`, {
      narrative: 'Reviewed lease agreement for renewal terms today.',
    });
    await t.fetchJson('POST', `/api/entries/${stop1.entry.id}/finalize`);

    await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
    clock.advance(1800); // clock now 1.0 total
    const stop2 = (await t.fetchJson('POST', `/api/timers/${timer.id}/stop`)).body;
    assert.notEqual(stop2.entry.id, stop1.entry.id, 'finalized entry is never touched');
    assert.equal(stop2.entry.status, 'draft');
    // the finalized entry keeps its 0.5; the new entry carries the full clock —
    // the stop response flags the situation so the UI can offer a fresh reset
    assert.equal(stop2.relinked, true);
  }));

test('midnight rollover: final sync to yesterday via linked entry, clock zeroed and unlinked', () =>
  withServer('2026-07-06T22:00:00-07:00', async (t, cm, clock) => {
    const timer = (await t.fetchJson('POST', '/api/timers', {
      name: 'Late', cm_id: cm.id, task_code: 'Draft',
    })).body;
    await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
    clock.advance(3600); // 23:00
    const stop1 = (await t.fetchJson('POST', `/api/timers/${timer.id}/stop`)).body; // 1.0 filed
    clock.advance(1800); // 23:30
    await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
    clock.set('2026-07-07T09:00:00-07:00');

    const list = (await t.fetchJson('GET', '/api/timers')).body;
    // banked to yesterday: 3600 + (23:30→24:00 = 1800) = 5400s = 1.5h on the SAME entry
    const yesterday = (await t.fetchJson('GET', '/api/entries?date=2026-07-06')).body;
    assert.equal(yesterday.length, 1);
    assert.equal(yesterday[0].id, stop1.entry.id);
    assert.equal(yesterday[0].total, 1.5);
    // today: clock restarted from midnight, still running, unlinked
    assert.equal(list[0].running, 1);
    assert.equal(list[0].elapsed_seconds, 9 * 3600);
    assert.equal(list[0].linked_entry_id, null);
  }));

test('timer groups: CRUD, assignment, per-group ordering, collapse, delete ungroups', () =>
  withServer('2026-07-06T09:00:00-07:00', async (t, cm) => {
    const g1 = (await t.fetchJson('POST', '/api/timer-groups', { name: 'Litigation' })).body;
    const g2 = (await t.fetchJson('POST', '/api/timer-groups', { name: 'Deals' })).body;
    assert.equal(g1.name, 'Litigation');

    const a = (await t.fetchJson('POST', '/api/timers', { name: 'A', cm_id: cm.id, group_id: g1.id })).body;
    const b = (await t.fetchJson('POST', '/api/timers', { name: 'B', cm_id: cm.id, group_id: g1.id })).body;
    const c = (await t.fetchJson('POST', '/api/timers', { name: 'C', cm_id: cm.id })).body; // ungrouped
    assert.equal(a.group_id, g1.id);

    // move c into g2
    await t.fetchJson('PATCH', `/api/timers/${c.id}`, { group_id: g2.id });

    // reorder inside g1
    await t.fetchJson('PUT', '/api/timers/order', { ids: [b.id, a.id] });
    const list = (await t.fetchJson('GET', '/api/timers')).body;
    const inG1 = list.filter((x) => x.group_id === g1.id).map((x) => x.id);
    assert.deepEqual(inG1, [b.id, a.id]);

    // collapse persists
    await t.fetchJson('PATCH', `/api/timer-groups/${g1.id}`, { collapsed: 1 });
    const groups = (await t.fetchJson('GET', '/api/timer-groups')).body;
    assert.equal(groups.find((g) => g.id === g1.id).collapsed, 1);

    // group order
    await t.fetchJson('PUT', '/api/timer-groups/order', { ids: [g2.id, g1.id] });
    const ordered = (await t.fetchJson('GET', '/api/timer-groups')).body.map((g) => g.id);
    assert.deepEqual(ordered, [g2.id, g1.id]);

    // deleting a group keeps its timers, ungrouped
    await t.fetchJson('DELETE', `/api/timer-groups/${g1.id}`);
    const after = (await t.fetchJson('GET', '/api/timers')).body;
    assert.equal(after.find((x) => x.id === a.id).group_id, null);
    assert.equal(after.length, 3);
  }));

test('duplicate timer copies binding, zero clock', () =>
  withServer('2026-07-06T09:00:00-07:00', async (t, cm, clock) => {
    const g = (await t.fetchJson('POST', '/api/timer-groups', { name: 'G' })).body;
    const timer = (await t.fetchJson('POST', '/api/timers', {
      name: 'Original', cm_id: cm.id, task_code: 'Draft', group_id: g.id,
    })).body;
    await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
    clock.advance(600);
    const dup = (await t.fetchJson('POST', `/api/timers/${timer.id}/duplicate`)).body;
    assert.equal(dup.name, 'Original (copy)');
    assert.equal(dup.cm_id, cm.id);
    assert.equal(dup.task_code, 'Draft');
    assert.equal(dup.group_id, g.id);
    assert.equal(dup.elapsed_seconds, 0);
    assert.equal(dup.running, 0);
  }));

test('starting a second timer warns but does not block', () =>
  withServer('2026-07-06T09:00:00-07:00', async (t, cm) => {
    const a = (await t.fetchJson('POST', '/api/timers', { name: 'Timer A', cm_id: cm.id })).body;
    const b = (await t.fetchJson('POST', '/api/timers', { name: 'Timer B', cm_id: cm.id })).body;
    const r1 = await t.fetchJson('POST', `/api/timers/${a.id}/start`);
    assert.equal(r1.body.warning, undefined);
    const r2 = await t.fetchJson('POST', `/api/timers/${b.id}/start`);
    assert.match(r2.body.warning, /Timer A/);
  }));

test('timer-created entries bump the CM picker recency', () =>
  withServer('2026-07-06T09:00:00-07:00', async (t, cm, clock) => {
    const timer = (await t.fetchJson('POST', '/api/timers', { name: 'T', cm_id: cm.id })).body;
    await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
    clock.advance(3600);
    await t.fetchJson('POST', `/api/timers/${timer.id}/stop`);
    const row = t.db.prepare('SELECT last_used_at FROM matters WHERE id=?').get(cm.id);
    assert.ok(row.last_used_at, 'last_used_at set by timer entry');
  }));

test('timer list carries client fields for by-client grouping', () =>
  withServer('2026-07-06T09:00:00-07:00', async (t, cm) => {
    await t.fetchJson('POST', '/api/timers', { name: 'Acme research', cm_id: cm.id });
    let list = (await t.fetchJson('GET', '/api/timers')).body;
    assert.equal(list[0].client_number, '100001');
    assert.equal(list[0].client_name, ''); // blank until named
    assert.ok(list[0].client_id);

    const client = (await t.fetchJson('GET', '/api/clients')).body[0];
    await t.fetchJson('PATCH', `/api/clients/${client.id}`, { name: 'Acme Holdings' });
    list = (await t.fetchJson('GET', '/api/timers')).body;
    assert.equal(list[0].client_name, 'Acme Holdings');
  }));

test('start pre-computes a suggested narrative from the phrasebook', () =>
  withServer('2026-07-06T09:00:00-07:00', async (t, cm, clock) => {
    await t.fetchJson('POST', '/api/entries', {
      date: '2026-07-05', cm_id: cm.id,
      tasks: [{ task_code: 'Revise', duration: 0.5, fragment: 'revise lease legal description' }],
    });
    const timer = (await t.fetchJson('POST', '/api/timers', { name: 'Acme', cm_id: cm.id })).body;
    assert.equal(timer.suggested_narrative, null, 'nothing suggested before first start');

    await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
    let list = (await t.fetchJson('GET', '/api/timers')).body;
    assert.equal(list[0].suggested_narrative, 'revise lease legal description');

    // the stop payload carries it too — the chips UI reads it from there
    clock.advance(600);
    const stop = (await t.fetchJson('POST', `/api/timers/${timer.id}/stop`)).body;
    assert.equal(stop.timer.suggested_narrative, 'revise lease legal description');

    // re-pointing the timer at a different matter clears the stale suggestion
    const other = (await t.fetchJson('POST', '/api/cms', { cm_number: '100001-000099', short_name: 'Sibling' })).body;
    const patched = (await t.fetchJson('PATCH', `/api/timers/${timer.id}`, { cm_id: other.id })).body;
    assert.equal(patched.suggested_narrative, null);
  }));

test('start on a cold matter leaves the suggestion empty (and no LLM call when disabled)', () =>
  withServer('2026-07-06T09:00:00-07:00', async (t, cm) => {
    const timer = (await t.fetchJson('POST', '/api/timers', { name: 'Cold', cm_id: cm.id })).body;
    await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
    const list = (await t.fetchJson('GET', '/api/timers')).body;
    assert.equal(list[0].suggested_narrative, null);
  }));
