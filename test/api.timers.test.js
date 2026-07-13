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

test('linked entry finalized meanwhile → next start opens a fresh entry with a fresh clock', () =>
  withServer('2026-07-06T09:00:00-07:00', async (t, cm, clock) => {
    const timer = (await t.fetchJson('POST', '/api/timers', { name: 'T', cm_id: cm.id })).body;
    await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
    clock.advance(1800);
    const stop1 = (await t.fetchJson('POST', `/api/timers/${timer.id}/stop`)).body;
    await t.fetchJson('PATCH', `/api/entries/${stop1.entry.id}`, {
      narrative: 'Reviewed lease agreement for renewal terms today.',
    });
    await t.fetchJson('POST', `/api/entries/${stop1.entry.id}/finalize`);

    // Finalize already zeroed + unlinked the timer (Acme fix,
    // 2026-07-10), so this start is a clean slate: a NEW entry, no relink
    // flag, no carried-over clock to deduct.
    const start2 = (await t.fetchJson('POST', `/api/timers/${timer.id}/start`)).body;
    assert.equal(start2.relinked ?? false, false);
    assert.notEqual(start2.entry.id, stop1.entry.id, 'finalized entry is never touched');
    clock.advance(1800); // 0.5h of genuinely new work
    const stop2 = (await t.fetchJson('POST', `/api/timers/${timer.id}/stop`)).body;
    assert.equal(stop2.entry.id, start2.entry.id, 'stop settles the new entry');
    assert.equal(stop2.entry.status, 'draft');
    assert.equal(stop2.entry.total, 0.5, 'only post-finalize time — nothing double-counted');
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
    // today: clock restarted from midnight, still running, linked to a NEW
    // entry for the new day (running timers keep the entry-exists invariant)
    assert.equal(list[0].running, 1);
    assert.equal(list[0].elapsed_seconds, 9 * 3600);
    assert.ok(list[0].linked_entry_id, 'new day gets its own linked entry');
    assert.notEqual(list[0].linked_entry_id, stop1.entry.id);
    const today = (await t.fetchJson('GET', '/api/entries?date=2026-07-07')).body;
    assert.equal(today.length, 1);
    assert.equal(today[0].id, list[0].linked_entry_id);
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

// Quick timers: no client/matter — just time and an optional caption. The
// clock runs normally; stops HOLD the time (nothing files, nothing is lost)
// until a matter is assigned, and midnight carries the clock forward instead
// of banking it nowhere.
test('quick timer: created without cm or name, runs, stop holds the clock without filing', () =>
  withServer('2026-07-06T09:00:00-07:00', async (t, cm, clock) => {
    const r = await t.fetchJson('POST', '/api/timers', {});
    assert.equal(r.status, 201);
    assert.equal(r.body.cm_id, null);
    assert.equal(r.body.name, 'Quick timer');
    const timer = r.body;

    await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
    clock.advance(3600);
    const stop = (await t.fetchJson('POST', `/api/timers/${timer.id}/stop`)).body;
    assert.equal(stop.entry, null);
    assert.equal(stop.unassigned, true);
    assert.equal(stop.seconds, 3600);

    const row = (await t.fetchJson('GET', '/api/timers')).body.find((x) => x.id === timer.id);
    assert.equal(row.running, 0);
    assert.equal(row.elapsed_seconds, 3600, 'time held on the clock');
    const entries = (await t.fetchJson('GET', '/api/entries?date=2026-07-06')).body;
    assert.equal(entries.length, 0, 'nothing filed without a matter');
  }));

test('quick timer: caption only (no cm) is honored', () =>
  withServer('2026-07-06T09:00:00-07:00', async (t) => {
    const r = await t.fetchJson('POST', '/api/timers', { name: 'Mystery call' });
    assert.equal(r.status, 201);
    assert.equal(r.body.name, 'Mystery call');
    assert.equal(r.body.cm_id, null);
  }));

test('quick timer: assigning a matter later files the held time on the next stop', () =>
  withServer('2026-07-06T09:00:00-07:00', async (t, cm, clock) => {
    const timer = (await t.fetchJson('POST', '/api/timers', { name: 'Parking lot' })).body;
    await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
    clock.advance(3600); // 1.0h held
    await t.fetchJson('POST', `/api/timers/${timer.id}/stop`);

    const patched = (await t.fetchJson('PATCH', `/api/timers/${timer.id}`, { cm_id: cm.id })).body;
    assert.equal(patched.cm_id, cm.id);

    await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
    clock.advance(1800); // +0.5h
    const stop = (await t.fetchJson('POST', `/api/timers/${timer.id}/stop`)).body;
    assert.ok(stop.entry, 'held time files once a matter exists');
    assert.equal(stop.entry.total, 1.5);
  }));

test('quick timer: assigning a matter to a PAUSED timer files the held time immediately', () =>
  withServer('2026-07-06T09:00:00-07:00', async (t, cm, clock) => {
    const timer = (await t.fetchJson('POST', '/api/timers', { name: 'Parking lot' })).body;
    await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
    clock.advance(3600); // 1.0h held
    await t.fetchJson('POST', `/api/timers/${timer.id}/stop`);

    const r = (await t.fetchJson('PATCH', `/api/timers/${timer.id}`, { cm_id: cm.id })).body;
    assert.ok(r.entry, 'held time files on assignment, not on the next stop');
    assert.equal(r.entry.total, 1.0);
    assert.equal(r.linked_entry_id, r.entry.id);
    const entries = (await t.fetchJson('GET', '/api/entries?date=2026-07-06')).body;
    assert.equal(entries.length, 1);
  }));

test('quick timer: assigning a matter while RUNNING creates the entry immediately', () =>
  withServer('2026-07-06T09:00:00-07:00', async (t, cm, clock) => {
    const timer = (await t.fetchJson('POST', '/api/timers', { name: 'Parking lot' })).body;
    await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
    clock.advance(3600);
    const r = (await t.fetchJson('PATCH', `/api/timers/${timer.id}`, { cm_id: cm.id })).body;
    assert.ok(r.entry, 'entry exists as soon as the running timer has a matter');
    assert.equal(r.entry.total, 1.0, 'created at the current snapshot');
    assert.equal(r.linked_entry_id, r.entry.id);
    clock.advance(1800);
    const stop = (await t.fetchJson('POST', `/api/timers/${timer.id}/stop`)).body;
    assert.equal(stop.entry.id, r.entry.id, 'stop settles the SAME entry');
    assert.equal(stop.entry.total, 1.5);
  }));

test('quick timer: assignment below the minimum increment holds without filing', () =>
  withServer('2026-07-06T09:00:00-07:00', async (t, cm, clock) => {
    const timer = (await t.fetchJson('POST', '/api/timers', { name: 'Parking lot' })).body;
    // 2 tenths of a minute — under 0.1h even after rounding? 100s rounds UP
    // to 0.1h, so use a clock edit to zero instead: just don't run it at all.
    const r = (await t.fetchJson('PATCH', `/api/timers/${timer.id}`, { cm_id: cm.id })).body;
    assert.equal(r.entry ?? null, null, 'zero clock — nothing to file');
    assert.equal((await t.fetchJson('GET', '/api/entries?date=2026-07-06')).body.length, 0);
  }));

test('quick timer: un-assigning the matter is allowed and unlinks the entry', () =>
  withServer('2026-07-06T09:00:00-07:00', async (t, cm, clock) => {
    const timer = (await t.fetchJson('POST', '/api/timers', { name: 'T', cm_id: cm.id })).body;
    await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
    clock.advance(3600);
    await t.fetchJson('POST', `/api/timers/${timer.id}/stop`);
    const patched = (await t.fetchJson('PATCH', `/api/timers/${timer.id}`, { cm_id: null })).body;
    assert.equal(patched.cm_id, null);
    assert.equal(patched.linked_entry_id, null, 'old entry is no longer this timer’s home');
  }));

test('quick timer: midnight carries unassigned time forward instead of dropping it', () =>
  withServer('2026-07-06T09:00:00-07:00', async (t, cm, clock) => {
    const timer = (await t.fetchJson('POST', '/api/timers', { name: 'Parking lot' })).body;
    await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
    clock.advance(2 * 3600);
    await t.fetchJson('POST', `/api/timers/${timer.id}/stop`);

    clock.set('2026-07-07T10:00:00-07:00'); // next day
    const row = (await t.fetchJson('GET', '/api/timers')).body.find((x) => x.id === timer.id);
    assert.equal(row.elapsed_seconds, 7200, 'clock survives the rollover');
    assert.equal(row.last_reset_date, '2026-07-07', 'rollover bookkeeping still advances');
    const entries = (await t.fetchJson('GET', '/api/entries?date=2026-07-06')).body;
    assert.equal(entries.length, 0, 'nothing banked to an entry');
  }));

// Exclusive timers: one running timer at a time. Starting a timer stops-and-
// files any other running timer server-side (atomic against races/multi-tab)
// and reports what it stopped so the client can surface the narrative chips.
test('exclusive: starting a second timer auto-stops the first and files its time', () =>
  withServer('2026-07-06T09:00:00-07:00', async (t, cm, clock) => {
    const a = (await t.fetchJson('POST', '/api/timers', { name: 'Timer A', cm_id: cm.id })).body;
    const b = (await t.fetchJson('POST', '/api/timers', { name: 'Timer B', cm_id: cm.id })).body;

    const r1 = (await t.fetchJson('POST', `/api/timers/${a.id}/start`)).body;
    assert.equal(r1.stopped, undefined, 'nothing running → nothing stopped');

    clock.advance(1200); // 20 min on Timer A
    const r2 = (await t.fetchJson('POST', `/api/timers/${b.id}/start`)).body;
    assert.equal(r2.timer.running, 1, 'the new timer starts');
    assert.equal(r2.stopped.length, 1);
    const s = r2.stopped[0];
    assert.equal(s.timer.id, a.id);
    assert.equal(s.timer.running, 0);
    assert.equal(s.hours, 0.4); // 1200s rounds up to 0.4
    assert.equal(s.entry.total, 0.4, 'auto-stop files exactly like a manual stop');

    const list = (await t.fetchJson('GET', '/api/timers')).body;
    assert.equal(list.filter((x) => x.running).length, 1, 'only one timer running');
    assert.equal(list.find((x) => x.id === a.id).elapsed_seconds, 1200);
  }));

test('exclusive: a sub-2s stretch on the auto-stopped timer is discarded, not filed', () =>
  withServer('2026-07-06T09:00:00-07:00', async (t, cm, clock) => {
    const a = (await t.fetchJson('POST', '/api/timers', { name: 'Timer A', cm_id: cm.id })).body;
    const b = (await t.fetchJson('POST', '/api/timers', { name: 'Timer B', cm_id: cm.id })).body;
    await t.fetchJson('POST', `/api/timers/${a.id}/start`);
    clock.advance(1); // misclick territory
    const r = (await t.fetchJson('POST', `/api/timers/${b.id}/start`)).body;
    assert.equal(r.stopped[0].discarded, true);
    assert.equal(r.stopped[0].entry, null);
    const rowA = (await t.fetchJson('GET', '/api/timers')).body.find((x) => x.id === a.id);
    assert.equal(rowA.running, 0);
    assert.equal(rowA.elapsed_seconds, 0, 'misclick stretch fully reverted');
  }));

test('exclusive: a backdated start also stops the running timer first', () =>
  withServer('2026-07-06T09:00:00-07:00', async (t, cm, clock) => {
    const a = (await t.fetchJson('POST', '/api/timers', { name: 'Timer A', cm_id: cm.id })).body;
    const b = (await t.fetchJson('POST', '/api/timers', { name: 'Timer B', cm_id: cm.id })).body;
    await t.fetchJson('POST', `/api/timers/${a.id}/start`);
    clock.advance(1800);
    const r = (await t.fetchJson('POST', `/api/timers/${b.id}/start`, { minutesAgo: 10 })).body;
    assert.equal(r.stopped[0].timer.id, a.id);
    assert.equal(r.stopped[0].hours, 0.5);
    const rowB = (await t.fetchJson('GET', '/api/timers')).body.find((x) => x.id === b.id);
    assert.equal(rowB.running, 1);
    assert.equal(rowB.elapsed_seconds, 600, 'backdated start honored');
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
    assert.equal(list[0].cm_billable, 1);

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

test('start skips a top-ranked phrase carrying time amounts, suggests the next clean phrase', () =>
  withServer('2026-07-06T09:00:00-07:00', async (t, cm) => {
    // A stored free-text narrative with baked-in parentheticals ranks as a
    // phrasebook phrase just like any other — occurring twice outranks the
    // single clean phrase below, so it would be phrases[0] if left unfiltered.
    for (const date of ['2026-07-03', '2026-07-04']) {
      await t.fetchJson('POST', '/api/entries', {
        date, cm_id: cm.id,
        narrative: 'Analyzed development agreement (0.5); drafted revised agreement (0.3).',
      });
    }
    await t.fetchJson('POST', '/api/entries', {
      date: '2026-07-05', cm_id: cm.id,
      tasks: [{ task_code: 'Revise', duration: 0.5, fragment: 'revise lease legal description' }],
    });
    const timer = (await t.fetchJson('POST', '/api/timers', { name: 'Acme', cm_id: cm.id })).body;
    await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
    const list = (await t.fetchJson('GET', '/api/timers')).body;
    assert.equal(list[0].suggested_narrative, 'revise lease legal description');
  }));

test('start on a cold matter leaves the suggestion empty (and no LLM call when disabled)', () =>
  withServer('2026-07-06T09:00:00-07:00', async (t, cm) => {
    const timer = (await t.fetchJson('POST', '/api/timers', { name: 'Cold', cm_id: cm.id })).body;
    await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
    const list = (await t.fetchJson('GET', '/api/timers')).body;
    assert.equal(list[0].suggested_narrative, null);
  }));

test('start creates the linked entry immediately (0.0h draft, visible on the dashboard)', () =>
  withServer('2026-07-06T09:00:00-07:00', async (t, cm, clock) => {
    const timer = (await t.fetchJson('POST', '/api/timers', {
      name: 'Acme research', cm_id: cm.id, task_code: 'Research',
    })).body;

    const started = (await t.fetchJson('POST', `/api/timers/${timer.id}/start`)).body;
    assert.ok(started.entry, 'start returns the created entry');
    assert.equal(started.entry.total, 0);
    assert.equal(started.entry.status, 'draft');
    assert.equal(started.timer.linked_entry_id, started.entry.id);

    const dash = (await t.fetchJson('GET', '/api/dashboard')).body;
    assert.equal(dash.entries.length, 1, 'Today’s entries shows it while running');

    clock.advance(1200); // 20 min
    const stop = (await t.fetchJson('POST', `/api/timers/${timer.id}/stop`)).body;
    assert.equal(stop.entry.id, started.entry.id, 'stop settles the SAME entry');
    assert.equal(stop.entry.total, 0.4);

    // a re-start later the same day does not spawn a second entry
    await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
    const dash2 = (await t.fetchJson('GET', '/api/dashboard')).body;
    assert.equal(dash2.entries.length, 1);
  }));

test('misclick after a fresh start removes the just-created empty entry', () =>
  withServer('2026-07-06T09:00:00-07:00', async (t, cm, clock) => {
    const timer = (await t.fetchJson('POST', '/api/timers', {
      name: 'Acme research', cm_id: cm.id,
    })).body;
    const started = (await t.fetchJson('POST', `/api/timers/${timer.id}/start`)).body;
    assert.ok(started.entry);
    clock.advance(1);
    const stop = (await t.fetchJson('POST', `/api/timers/${timer.id}/stop`)).body;
    assert.equal(stop.discarded, true);
    const dash = (await t.fetchJson('GET', '/api/dashboard')).body;
    assert.equal(dash.entries.length, 0, 'as if nothing happened — no 0.0h litter');
    const after = (await t.fetchJson('GET', '/api/timers')).body.find((x) => x.id === timer.id);
    assert.equal(after.linked_entry_id, null);
  }));

test('fresh removes an untouched empty entry and re-links a running timer to a new one', () =>
  withServer('2026-07-06T09:00:00-07:00', async (t, cm, clock) => {
    const timer = (await t.fetchJson('POST', '/api/timers', {
      name: 'Acme research', cm_id: cm.id,
    })).body;
    const started = (await t.fetchJson('POST', `/api/timers/${timer.id}/start`)).body;
    clock.advance(1); // still running, nothing settled
    const fresh = (await t.fetchJson('POST', `/api/timers/${timer.id}/fresh`)).body;
    assert.ok(fresh.entry, 'running matter timer keeps the invariant: linked entry exists');
    assert.notEqual(fresh.entry.id, started.entry.id);
    const dash = (await t.fetchJson('GET', '/api/dashboard')).body;
    assert.equal(dash.entries.length, 1, 'old empty entry deleted, exactly one remains');
  }));

test('midnight rollover: a running timer starts the new day with its own linked entry', () =>
  withServer('2026-07-06T23:50:00-07:00', async (t, cm, clock) => {
    const timer = (await t.fetchJson('POST', '/api/timers', {
      name: 'Late night', cm_id: cm.id,
    })).body;
    await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
    clock.set('2026-07-07T00:05:00-07:00');
    const rolled = (await t.fetchJson('GET', '/api/timers')).body.find((x) => x.id === timer.id); // GET triggers rollover
    const yesterday = t.db.prepare("SELECT * FROM entries WHERE date='2026-07-06' AND deleted_at IS NULL").all();
    assert.equal(yesterday.length, 1);
    assert.equal(yesterday[0].total_override, 0.2, '10 min banked to the accrual day (rounds up)');
    const today = t.db.prepare("SELECT * FROM entries WHERE date='2026-07-07' AND deleted_at IS NULL").all();
    assert.equal(today.length, 1, 'the new day has its own entry from the first moment');
    assert.equal(rolled.linked_entry_id, today[0].id);
    assert.notEqual(today[0].id, yesterday[0].id);
  }));

test('midnight reset preserves linked entries of paused timers — even when nothing banks', () =>
  withServer('2026-07-06T22:00:00-07:00', async (t, cm, clock) => {
    const timer = (await t.fetchJson('POST', '/api/timers', {
      name: 'Evening work', cm_id: cm.id,
    })).body;
    // paused timer with a settled entry
    await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
    clock.advance(1200);
    await t.fetchJson('POST', `/api/timers/${timer.id}/stop`);
    // second timer: filed 0.2h, then clock zeroed → at midnight its bank is 0
    // (the else-branch that must NOT touch the linked entry)
    const t2 = (await t.fetchJson('POST', '/api/timers', {
      name: 'Zeroed out', cm_id: cm.id,
    })).body;
    await t.fetchJson('POST', `/api/timers/${t2.id}/start`);
    clock.advance(600);
    await t.fetchJson('POST', `/api/timers/${t2.id}/stop`);
    await t.fetchJson('PUT', `/api/timers/${t2.id}/clock`, { hours: 0 });

    clock.set('2026-07-07T00:10:00-07:00');
    await t.fetchJson('GET', '/api/timers'); // triggers rollover
    const kept = t.db.prepare("SELECT * FROM entries WHERE date='2026-07-06' AND deleted_at IS NULL").all();
    assert.equal(kept.length, 2, 'midnight deletes nothing — both entries preserved');
    const list = (await t.fetchJson('GET', '/api/timers')).body;
    for (const x of list) assert.equal(x.linked_entry_id, null, 'paused timers unlink for the new day');
  }));

test('dashboard alerts skip entries whose timer is running; they surface on stop', () =>
  withServer('2026-07-06T09:00:00-07:00', async (t, cm, clock) => {
    const timer = (await t.fetchJson('POST', '/api/timers', {
      name: 'Acme research', cm_id: cm.id,
    })).body;
    await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
    clock.advance(60);
    let dash = (await t.fetchJson('GET', '/api/dashboard')).body;
    assert.equal(dash.alerts.invalidDrafts.length, 0, 'work in progress is not "needs attention"');
    await t.fetchJson('POST', `/api/timers/${timer.id}/stop`);
    dash = (await t.fetchJson('GET', '/api/dashboard')).body;
    assert.equal(dash.alerts.invalidDrafts.length, 1, 'stopped: the empty narrative surfaces normally');
  }));

test('dashboard timers include unassigned quick timers (for the ghost row + footer)', () =>
  withServer('2026-07-06T09:00:00-07:00', async (t) => {
    const quick = (await t.fetchJson('POST', '/api/timers', {})).body;
    await t.fetchJson('POST', `/api/timers/${quick.id}/start`);
    const dash = (await t.fetchJson('GET', '/api/dashboard')).body;
    const row = dash.timers.find((x) => x.id === quick.id);
    assert.ok(row, 'quick timer present in dashboard payload');
    assert.equal(row.cm_number, null);
    assert.equal(row.running, 1);
  }));

// 2026-07-10 feedback (Acme duplicate): finalizing a timer's linked
// entry must ZERO the timer and unlink it — otherwise the next stop refiles
// the whole day clock into a brand-new entry, double-counting the time.
test('finalizing the linked entry zeroes and unlinks its timer (stopped and running)', () =>
  withServer('2026-07-06T09:00:00-07:00', async (t, cm, clock) => {
    const timer = (await t.fetchJson('POST', '/api/timers', {
      name: 'IM work', cm_id: cm.id,
    })).body;

    await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
    clock.advance(5400); // 1.5h
    const stop = (await t.fetchJson('POST', `/api/timers/${timer.id}/stop`)).body;
    assert.equal(stop.entry.total, 1.5);

    // make it finalizable, then finalize
    await t.fetchJson('PATCH', `/api/entries/${stop.entry.id}`, {
      narrative: 'Review and analyze Access Agreement; revisions to Access Agreement.',
    });
    const fin = await t.fetchJson('POST', `/api/entries/${stop.entry.id}/finalize`);
    assert.equal(fin.status, 200);

    let list = (await t.fetchJson('GET', '/api/timers')).body;
    assert.equal(list[0].elapsed_seconds, 0, 'finalize zeroes the timer clock');
    assert.equal(list[0].linked_entry_id, null, 'finalize unlinks the timer');

    // more work after finalizing files ONLY the new time into a NEW entry
    clock.advance(600);
    await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
    clock.advance(720); // 0.2h
    const stop2 = (await t.fetchJson('POST', `/api/timers/${timer.id}/stop`)).body;
    assert.notEqual(stop2.entry.id, stop.entry.id);
    assert.equal(stop2.entry.total, 0.2, 'no duplicated pre-finalize time');
    const day = (await t.fetchJson('GET', '/api/entries?date=2026-07-06')).body;
    assert.equal(day.reduce((s, e) => s + e.total, 0), 1.7);

    // a RUNNING timer keeps running but restarts its clock from finalize time
    await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
    clock.advance(1800); // 0.5h on the clock (0.2 banked + 0.5 running − wait: 0.2+0.5)
    await t.fetchJson('PATCH', `/api/entries/${stop2.entry.id}`, {
      narrative: 'Additional revisions to Access Agreement and emails with client.',
    });
    const fin2 = await t.fetchJson('POST', `/api/entries/${stop2.entry.id}/finalize`);
    assert.equal(fin2.status, 200);
    list = (await t.fetchJson('GET', '/api/timers')).body;
    assert.equal(list[0].running, 1, 'timer keeps running through finalize');
    assert.equal(list[0].elapsed_seconds, 0, 'but its clock restarts from zero');
    clock.advance(360); // 0.1h of genuinely new time
    const stop3 = (await t.fetchJson('POST', `/api/timers/${timer.id}/stop`)).body;
    assert.equal(stop3.entry.total, 0.1, 'only post-finalize time files');
    assert.notEqual(stop3.entry.id, stop2.entry.id);
  }));

// Held-over surfacing (2026-07-11 feedback: "these timers were orphaned from
// yesterday — not sure why"): carrying an unassigned quick timer's clock
// across midnight is deliberate (nowhere to bank), but the UI must SAY so.
// held_since records the (first) day the held time came from; assigning a
// matter or zeroing the clock clears it.
test('quick timer: midnight carry-over stamps held_since with the day the time came from', () =>
  withServer('2026-07-06T09:00:00-07:00', async (t, cm, clock) => {
    const timer = (await t.fetchJson('POST', '/api/timers', { name: 'Parking lot' })).body;
    await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
    clock.advance(2 * 3600);
    await t.fetchJson('POST', `/api/timers/${timer.id}/stop`);

    clock.set('2026-07-07T10:00:00-07:00');
    let row = (await t.fetchJson('GET', '/api/timers')).body.find((x) => x.id === timer.id);
    assert.equal(row.held_since, '2026-07-06');

    // a second midnight keeps the ORIGINAL day, not the latest
    clock.set('2026-07-08T10:00:00-07:00');
    row = (await t.fetchJson('GET', '/api/timers')).body.find((x) => x.id === timer.id);
    assert.equal(row.held_since, '2026-07-06');

    // dashboard surfaces the count so the banner can point at it
    const dash = (await t.fetchJson('GET', '/api/dashboard')).body;
    assert.equal(dash.alerts.heldTimers.length, 1);
    assert.equal(dash.alerts.heldTimers[0].id, timer.id);
    assert.equal(dash.alerts.heldTimers[0].held_since, '2026-07-06');
  }));

test('quick timer: a zero-clock timer crossing midnight does NOT get held_since', () =>
  withServer('2026-07-06T09:00:00-07:00', async (t, cm, clock) => {
    const timer = (await t.fetchJson('POST', '/api/timers', { name: 'Idle' })).body;
    clock.set('2026-07-07T10:00:00-07:00');
    const row = (await t.fetchJson('GET', '/api/timers')).body.find((x) => x.id === timer.id);
    assert.equal(row.held_since, null);
  }));

test('quick timer: assigning a matter clears held_since (the time files)', () =>
  withServer('2026-07-06T09:00:00-07:00', async (t, cm, clock) => {
    const timer = (await t.fetchJson('POST', '/api/timers', { name: 'Parking lot' })).body;
    await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
    clock.advance(2 * 3600);
    await t.fetchJson('POST', `/api/timers/${timer.id}/stop`);
    clock.set('2026-07-07T10:00:00-07:00');

    const patched = (await t.fetchJson('PATCH', `/api/timers/${timer.id}`, { cm_id: cm.id })).body;
    assert.equal(patched.held_since, null);
    assert.ok(patched.entry, 'held time filed on assignment');
  }));

test('quick timer: zeroing the clock clears held_since (nothing held anymore)', () =>
  withServer('2026-07-06T09:00:00-07:00', async (t, cm, clock) => {
    const timer = (await t.fetchJson('POST', '/api/timers', { name: 'Parking lot' })).body;
    await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
    clock.advance(2 * 3600);
    await t.fetchJson('POST', `/api/timers/${timer.id}/stop`);
    clock.set('2026-07-07T10:00:00-07:00');

    await t.fetchJson('PUT', `/api/timers/${timer.id}/clock`, { hours: 0 });
    let row = (await t.fetchJson('GET', '/api/timers')).body.find((x) => x.id === timer.id);
    assert.equal(row.held_since, null);
  }));

test('quick timer: "fresh" also clears held_since', () =>
  withServer('2026-07-06T09:00:00-07:00', async (t, cm, clock) => {
    const timer = (await t.fetchJson('POST', '/api/timers', { name: 'Parking lot' })).body;
    await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
    clock.advance(2 * 3600);
    await t.fetchJson('POST', `/api/timers/${timer.id}/stop`);
    clock.set('2026-07-07T10:00:00-07:00');

    await t.fetchJson('POST', `/api/timers/${timer.id}/fresh`);
    const row = (await t.fetchJson('GET', '/api/timers')).body.find((x) => x.id === timer.id);
    assert.equal(row.held_since, null);
  }));

// Start-timer-from-entry (2026-07-11 feedback: entry cards get a start
// button that "links back to the other timer"). The timer clock is a day
// accumulator that overwrites the linked entry's total at stop — so linking
// MUST align the clock to the entry's current total, never clobber it.
test('start-for-entry: resumes the timer already linked to the entry', () =>
  withServer('2026-07-06T09:00:00-07:00', async (t, cm, clock) => {
    const timer = (await t.fetchJson('POST', '/api/timers', { name: 'Acme', cm_id: cm.id })).body;
    await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
    clock.advance(1800);
    const stop = (await t.fetchJson('POST', `/api/timers/${timer.id}/stop`)).body;

    const r = await t.fetchJson('POST', '/api/timers/start-for-entry', { entry_id: stop.entry.id });
    assert.equal(r.status, 200);
    assert.equal(r.body.timer.id, timer.id, 'reuses the linked timer, no new one');
    assert.equal(r.body.timer.running, 1);
    const count = (await t.fetchJson('GET', '/api/timers')).body.length;
    assert.equal(count, 1);
  }));

test('start-for-entry: manual entry gets a timer whose clock starts at the entry total', () =>
  withServer('2026-07-06T09:00:00-07:00', async (t, cm, clock) => {
    const entry = (await t.fetchJson('POST', '/api/entries', {
      date: '2026-07-06', cm_id: cm.id, narrative: 'Drafted the lease amendment carefully.',
      tasks: [{ task_code: '', duration: 1.2, fragment: '' }],
    })).body;

    const r = await t.fetchJson('POST', '/api/timers/start-for-entry', { entry_id: entry.id });
    assert.equal(r.status, 200);
    const timer = r.body.timer;
    assert.equal(timer.running, 1);
    assert.equal(timer.linked_entry_id, entry.id);
    assert.equal(timer.elapsed_seconds, Math.round(1.2 * 3600), 'clock aligned to the entry total');

    // 30 more minutes then stop: total grows from the base, never clobbered
    clock.advance(1800);
    const stop = (await t.fetchJson('POST', `/api/timers/${timer.id}/stop`)).body;
    assert.equal(stop.entry.id, entry.id, 'stop files back into the SAME entry');
    assert.equal(stop.entry.total, 1.7, '1.2 base + 0.5 new');
  }));

test('start-for-entry: reuses a paused same-matter timer instead of creating another', () =>
  withServer('2026-07-06T09:00:00-07:00', async (t, cm, clock) => {
    const timer = (await t.fetchJson('POST', '/api/timers', { name: 'Acme', cm_id: cm.id })).body;
    const entry = (await t.fetchJson('POST', '/api/entries', {
      date: '2026-07-06', cm_id: cm.id, narrative: 'Reviewed and revised indemnification rider.',
      tasks: [{ task_code: '', duration: 0.5, fragment: '' }],
    })).body;

    const r = await t.fetchJson('POST', '/api/timers/start-for-entry', { entry_id: entry.id });
    assert.equal(r.body.timer.id, timer.id, 'existing matter timer reused');
    assert.equal(r.body.timer.linked_entry_id, entry.id, 'relinked to this entry');
    assert.equal(r.body.timer.elapsed_seconds, 1800, 'clock aligned to entry total');
    assert.equal((await t.fetchJson('GET', '/api/timers')).body.length, 1);
  }));

test('start-for-entry: refuses finalized and non-today entries', () =>
  withServer('2026-07-06T09:00:00-07:00', async (t, cm, clock) => {
    const entry = (await t.fetchJson('POST', '/api/entries', {
      date: '2026-07-06', cm_id: cm.id, narrative: 'Analyzed lease scope and reported.',
      tasks: [{ task_code: '', duration: 0.5, fragment: '' }],
    })).body;
    await t.fetchJson('POST', `/api/entries/${entry.id}/finalize`);
    const r1 = await t.fetchJson('POST', '/api/timers/start-for-entry', { entry_id: entry.id });
    assert.equal(r1.status, 409, 'finalized entry cannot take a timer');

    const old = (await t.fetchJson('POST', '/api/entries', {
      date: '2026-07-01', cm_id: cm.id, narrative: 'Analyzed lease scope and reported.',
      tasks: [{ task_code: '', duration: 0.5, fragment: '' }],
    })).body;
    const r2 = await t.fetchJson('POST', '/api/timers/start-for-entry', { entry_id: old.id });
    assert.equal(r2.status, 409, 'only today\'s entries can take a timer');
  }));

test('start-for-entry: exclusivity still stops other running timers', () =>
  withServer('2026-07-06T09:00:00-07:00', async (t, cm, clock) => {
    const other = (await t.fetchJson('POST', '/api/timers', { name: 'Other', cm_id: cm.id })).body;
    await t.fetchJson('POST', `/api/timers/${other.id}/start`);
    clock.advance(1200);

    const entry = (await t.fetchJson('POST', '/api/entries', {
      date: '2026-07-06', cm_id: cm.id, narrative: 'Prepared closing checklist and circulated.',
      tasks: [{ task_code: '', duration: 0.3, fragment: '' }],
    })).body;
    const r = await t.fetchJson('POST', '/api/timers/start-for-entry', { entry_id: entry.id });
    assert.equal(r.status, 200);
    assert.equal(r.body.stopped.length, 1, 'the other running timer was stopped');
    const rows = (await t.fetchJson('GET', '/api/timers')).body;
    assert.equal(rows.find((x) => x.id === other.id).running, 0);
  }));
