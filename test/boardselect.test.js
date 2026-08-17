process.env.TZ = 'America/Los_Angeles';
import test from 'node:test';
import assert from 'node:assert/strict';
import { selectBands, nextRecentOrder, matchTimers } from '../public/js/lib/boardselect.js';

// Fri 2026-08-14 16:00 local — a plain mid-afternoon, nothing special about
// the date itself.
const TODAY = '2026-08-14';
const NOW = new Date(2026, 7, 14, 16, 0, 0);
const iso = (h, m = 0, d = 14) => new Date(2026, 7, d, h, m, 0).toISOString();

// A minimal, complete timer row. Every field the selection rules read is
// present with an inert default, so a test only has to override what it's
// actually exercising.
function mk(id, overrides = {}) {
  return {
    id,
    name: `Timer ${id}`,
    cm_short_name: `Matter ${id}`,
    cm_number: `M-${1000 + id}`,
    sort_order: id,
    archived_at: null,
    running: 0,
    last_started_at: null,
    last_stopped_at: null,
    accumulated_seconds: 0,
    last_reset_date: null,
    ...overrides,
  };
}

function board(n, overrides = {}) {
  return Array.from({ length: n }, (_, i) => mk(i + 1, overrides));
}

function baseOpts(extra = {}) {
  return { front: [], recentOrder: [], recentDate: null, today: TODAY, now: NOW, entriesByTimer: {}, scope: 'working', ...extra };
}

// ---------------------------------------------------------------- flat vs banded

test('9 timers do not band; front/recent are empty and prefix is manual-order top 9', () => {
  const timers = board(9);
  const r = selectBands(timers, baseOpts());
  assert.equal(r.mode, 'flat');
  assert.deepEqual(r.front, []);
  assert.deepEqual(r.recent, []);
  assert.equal(r.rest.length, 9);
  assert.deepEqual(r.prefix.map((t) => t.id), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

test('10 timers band', () => {
  const timers = board(10);
  const r = selectBands(timers, baseOpts());
  assert.equal(r.mode, 'banded');
});

test('flat board rest is manual order (sort_order asc, id tiebreak)', () => {
  const timers = [mk(1, { sort_order: 5 }), mk(2, { sort_order: 1 }), mk(3, { sort_order: 3 })];
  const r = selectBands(timers, baseOpts());
  assert.deepEqual(r.rest.map((t) => t.id), [2, 3, 1]);
});

// ---------------------------------------------------------------- Band A: front row

test('front row is exactly 3, in his order, when he chose 3', () => {
  const timers = board(12);
  const r = selectBands(timers, baseOpts({ front: [7, 2, 9] }));
  assert.deepEqual(r.front.map((t) => t.id), [7, 2, 9]);
});

test('front row fills to 3 by most 14-day hours when he chose fewer, and never drops his pick', () => {
  const timers = board(12);
  const hours14 = { 3: 1, 4: 40, 5: 2, 6: 100 }; // 6 has the most hours, then 4
  const r = selectBands(timers, baseOpts({ front: [11], hours14 }));
  // his one pick stays first; fill comes from the top of hours14, not from
  // whichever timer merely comes first in the array
  assert.deepEqual(r.front.map((t) => t.id), [11, 6, 4]);
});

test('front row fill ties break by sort_order then id, not by hours14 being absent', () => {
  const timers = board(12);
  const r = selectBands(timers, baseOpts({ front: [] })); // no hours14 at all — every candidate ties at 0
  assert.deepEqual(r.front.map((t) => t.id), [1, 2, 3]);
});

test('a front-row pick that no longer exists or was archived is dropped, not counted, and the rest still fills to 3', () => {
  const timers = board(12, {}).map((t) => (t.id === 5 ? { ...t, archived_at: iso(9) } : t));
  const r = selectBands(timers, baseOpts({ front: [5, 999, 2] })); // 5 archived, 999 doesn't exist
  assert.deepEqual(r.front.map((t) => t.id), [2, 1, 3]); // 2 kept, filled to 3 by manual order
});

test('archived timers never appear in front, recent, rest, or prefix', () => {
  const timers = board(12).map((t) => (t.id <= 3 ? { ...t, archived_at: iso(9) } : t));
  const r = selectBands(timers, baseOpts({ front: [1, 2, 3] })); // all three picks archived
  const allIds = [...r.front, ...r.recent, ...r.rest].map((t) => t.id);
  assert.ok(!allIds.includes(1) && !allIds.includes(2) && !allIds.includes(3));
  assert.ok(!r.prefix.some((t) => [1, 2, 3].includes(t.id)));
});

// ---------------------------------------------------------------- Band B: recent ordering

test('recent orders by COALESCE(last_started_at, last_stopped_at), most recent first', () => {
  const timers = board(12, {}).map((t) => {
    if (t.id === 4) return { ...t, last_started_at: iso(9) };  // 9am start, never stopped since (still counts as activity)
    if (t.id === 5) return { ...t, last_stopped_at: iso(14) }; // stopped 2pm
    if (t.id === 6) return { ...t, last_stopped_at: iso(10) }; // stopped 10am
    return t;
  });
  // force these three into Recent via entriesByTimer so ordering is the only thing under test
  const r = selectBands(timers, baseOpts({ front: [18, 19, 20], entriesByTimer: { 4: 1, 5: 1, 6: 1 } }));
  const ids = r.recent.map((t) => t.id);
  assert.deepEqual(ids.slice(0, 3), [5, 6, 4]); // 2pm stop, then 10am stop, then 9am start
});

test('recent ordering when EVERY timer has last_started_at null (the real end-of-day board)', () => {
  // The server nulls last_started_at on stop. A board where nothing is
  // currently running — the normal state most of the day — has this
  // field null on every row; ordering must fall through to last_stopped_at
  // instead of collapsing to "no order" (every row tying at 0).
  const timers = board(12, {}).map((t) => {
    if (t.id === 4) return { ...t, last_stopped_at: iso(11) };
    if (t.id === 5) return { ...t, last_stopped_at: iso(15) };
    if (t.id === 6) return { ...t, last_stopped_at: iso(9) };
    return t;
  });
  const r = selectBands(timers, baseOpts({ entriesByTimer: { 4: 1, 5: 1, 6: 1 } }));
  assert.deepEqual(r.recent.map((t) => t.id).slice(0, 3), [5, 4, 6]);
});

test('recent band B: rule (a) timers first, then 14-day backfill until it holds 6', () => {
  const timers = board(20, {}).map((t) => {
    if ([2, 3, 4, 5, 6].includes(t.id)) return { ...t, last_stopped_at: iso(9 + t.id) }; // recently active, not today
    return t;
  });
  // only timer 10 worked today; 2..6 are 14-day-recent backfill candidates.
  // front is pinned away from all of them so it can't scoop any up first.
  const r = selectBands(timers, baseOpts({ front: [18, 19, 20], entriesByTimer: { 10: 2.5 } }));
  const ids = r.recent.map((t) => t.id);
  assert.equal(r.recent.length, 6);
  assert.equal(ids[0], 10); // today's work leads
  assert.deepEqual(ids.slice(1), [6, 5, 4, 3, 2]); // backfilled most-recent-first to fill the band
});

test('backfill never reaches past 14 days', () => {
  const stale = new Date(NOW.getTime() - 20 * 86400000).toISOString();
  const timers = board(12, {}).map((t) => (t.id === 2 ? { ...t, last_stopped_at: stale } : t));
  const r = selectBands(timers, baseOpts({ front: [10, 11, 12] }));
  assert.ok(!r.recent.some((t) => t.id === 2));
  assert.ok(r.rest.length === 0); // scope 'working' — can't see it landed in rest, but it must not be in recent
  const all = selectBands(timers, baseOpts({ front: [10, 11, 12], scope: 'all' }));
  assert.ok(all.rest.some((t) => t.id === 2)); // it exists, just not recent enough
});

// ---------------------------------------------------------------- append-only within a day

test('append-only: a timer already in the persisted order keeps its position all day', () => {
  const timers = board(20, {}).map((t) => (t.id === 15 ? { ...t, last_stopped_at: iso(8) } : t)); // quiet since 8am
  // yesterday morning's computation put 15 at position 1; nothing today's
  // activity would naturally rank it first, but the persisted order says it
  // stays first regardless.
  const opts = baseOpts({ recentOrder: [15], recentDate: TODAY, entriesByTimer: { 4: 1 } });
  const r = selectBands(timers, opts);
  assert.equal(r.recent[0].id, 15);
});

test('append-only: a newly qualifying timer appends after the persisted order, not before', () => {
  const timers = board(20, {}).map((t) => (t.id === 15 ? { ...t, last_stopped_at: iso(8) } : t));
  const opts = baseOpts({ recentOrder: [15], recentDate: TODAY, entriesByTimer: { 4: 1 } });
  const r = selectBands(timers, opts);
  assert.deepEqual(r.recent.map((t) => t.id).slice(0, 2), [15, 4]);
});

test('append-only: a new day (recentDate mismatch) recomputes Recent from scratch', () => {
  const timers = board(20, {}).map((t) => (t.id === 15 ? { ...t, last_stopped_at: iso(8) } : t));
  const opts = baseOpts({ recentOrder: [15], recentDate: '2026-08-13', entriesByTimer: { 4: 1 } }); // yesterday's date
  const r = selectBands(timers, opts);
  // 15 did nothing today and isn't in entriesByTimer — with the stale
  // persisted order discarded, it has to win a spot on 14-day recency
  // instead of an automatic first slot.
  assert.equal(r.recent[0].id, 4);
});

test('nextRecentOrder persists append order and can run past the 6-tile render cap', () => {
  // eleven timers worked today; recentOrder for tomorrow's opts should
  // preserve all eleven positions even though only 6 render right now.
  const entriesByTimer = {};
  for (let id = 1; id <= 11; id++) entriesByTimer[id] = 1;
  const timers = board(20);
  const order = nextRecentOrder(timers, baseOpts({ front: [18, 19, 20], entriesByTimer }));
  assert.equal(order.length, 11);
});

test('nextRecentOrder returns [] for a flat (unbanded) board', () => {
  const timers = board(9);
  assert.deepEqual(nextRecentOrder(timers, baseOpts()), []);
});

// ---------------------------------------------------------------- running timer always reachable

test('the running timer displaces the last Recent member when it would otherwise fall out of the prefix', () => {
  const timers = board(20, {}).map((t) => (t.id === 20 ? { ...t, running: 1, last_started_at: iso(7) } : t));
  // 20 is running but its persisted append position is last (8th of 8
  // qualifiers) — it must not be pushed out of the rendered band.
  const opts = baseOpts({ recentOrder: [11, 12, 13, 14, 15, 16, 17, 20], recentDate: TODAY });
  const r = selectBands(timers, opts);
  assert.ok(r.recent.some((t) => t.id === 20), 'running timer must render somewhere in Recent');
  assert.equal(r.recent.length, 6);
  assert.equal(r.recent[5].id, 20); // took the last slot
  assert.ok(r.prefix.some((t) => t.id === 20));
});

test('the running timer is never duplicated when it already qualified into Recent on its own', () => {
  const timers = board(20, {}).map((t) => (t.id === 4 ? { ...t, running: 1, last_started_at: iso(15) } : t));
  const r = selectBands(timers, baseOpts({ entriesByTimer: { 4: 0.5 } }));
  const occurrences = r.recent.filter((t) => t.id === 4).length;
  assert.equal(occurrences, 1);
});

test('the running timer already in Band A changes nothing in Recent', () => {
  const timers = board(20, {}).map((t) => (t.id === 4 ? { ...t, running: 1, last_started_at: iso(15) } : t));
  const r = selectBands(timers, baseOpts({ front: [4, 1, 2] }));
  assert.equal(r.front[0].id, 4);
  assert.ok(!r.recent.some((t) => t.id === 4));
});

// ---------------------------------------------------------------- the nine-tile cap

test('eleven timers worked today still yields exactly 9 tiles in the prefix', () => {
  const entriesByTimer = {};
  for (let id = 1; id <= 11; id++) entriesByTimer[id] = 1;
  const timers = board(20);
  const r = selectBands(timers, baseOpts({ front: [18, 19, 20], entriesByTimer }));
  assert.equal(r.prefix.length, 9);
  assert.equal(r.front.length, 3);
  assert.equal(r.recent.length, 6);
});

test('the overflow beyond the 9-tile prefix falls into rest under scope all', () => {
  const entriesByTimer = {};
  for (let id = 1; id <= 11; id++) entriesByTimer[id] = 1;
  const timers = board(20);
  const r = selectBands(timers, baseOpts({ front: [18, 19, 20], entriesByTimer, scope: 'all' }));
  const prefixIds = new Set(r.prefix.map((t) => t.id));
  const overflowed = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].filter((id) => !prefixIds.has(id));
  assert.ok(overflowed.length >= 5); // 11 qualifiers - 6 rendered slots
  assert.ok(overflowed.every((id) => r.rest.some((t) => t.id === id)));
});

// ---------------------------------------------------------------- scope

test('working vs all: front and recent are element-for-element identical', () => {
  const timers = board(20, {}).map((t) => (t.id === 5 ? { ...t, last_stopped_at: iso(13) } : t));
  const opts = baseOpts({ front: [1, 2, 3], entriesByTimer: { 5: 1 } });
  const working = selectBands(timers, opts);
  const all = selectBands(timers, { ...opts, scope: 'all' });
  assert.deepEqual(working.front.map((t) => t.id), all.front.map((t) => t.id));
  assert.deepEqual(working.recent.map((t) => t.id), all.recent.map((t) => t.id));
  assert.deepEqual(working.prefix.map((t) => t.id), all.prefix.map((t) => t.id));
});

test('scope working: rest is always empty', () => {
  const timers = board(20);
  const r = selectBands(timers, baseOpts({ scope: 'working' }));
  assert.deepEqual(r.rest, []);
});

test('scope all: rest holds every remaining non-archived timer in manual order', () => {
  const timers = board(20, {}).map((t) => (t.id === 15 ? { ...t, archived_at: iso(9) } : t));
  const r = selectBands(timers, baseOpts({ front: [1, 2, 3], scope: 'all' }));
  const bandedIds = new Set([...r.front, ...r.recent].map((t) => t.id));
  const expectedRest = timers
    .filter((t) => !t.archived_at && !bandedIds.has(t.id))
    .sort((a, b) => a.sort_order - b.sort_order || a.id - b.id)
    .map((t) => t.id);
  assert.deepEqual(r.rest.map((t) => t.id), expectedRest);
  assert.ok(!r.rest.some((t) => t.id === 15)); // archived, excluded even from rest
});

// ---------------------------------------------------------------- matchTimers

test('matchTimers: empty query returns null, not []', () => {
  const timers = board(5);
  assert.equal(matchTimers(timers, ''), null);
  assert.equal(matchTimers(timers, '   '), null);
  assert.equal(matchTimers(timers, undefined), null);
});

test('matchTimers: matches by timer name', () => {
  const timers = [mk(1, { name: 'Acme merger' }), mk(2, { name: 'Northgate lease' })];
  const r = matchTimers(timers, 'merger');
  assert.deepEqual(r.map((t) => t.id), [1]);
});

test('matchTimers: matches by matter short name', () => {
  const timers = [mk(1, { name: 'A', cm_short_name: 'Acme — Lease' }), mk(2, { name: 'B', cm_short_name: 'Other' })];
  const r = matchTimers(timers, 'acme');
  assert.deepEqual(r.map((t) => t.id), [1]);
});

test('matchTimers: matches by cm_number', () => {
  const timers = [mk(1, { cm_number: '100001-000012' }), mk(2, { cm_number: '200002-000099' })];
  const r = matchTimers(timers, '000012');
  assert.deepEqual(r.map((t) => t.id), [1]);
});

test('matchTimers: case- and diacritic-insensitive, in board order', () => {
  const timers = [mk(1, { name: 'Verité Films' }), mk(2, { name: 'Something Else' })];
  assert.deepEqual(matchTimers(timers, 'VERITE').map((t) => t.id), [1]);
  assert.deepEqual(matchTimers(timers, 'verité').map((t) => t.id), [1]);
});

test('matchTimers: preserves the input array\'s relative order', () => {
  const timers = [mk(9, { name: 'Acme A' }), mk(1, { name: 'Acme B' }), mk(5, { name: 'Acme C' })];
  assert.deepEqual(matchTimers(timers, 'acme').map((t) => t.id), [9, 1, 5]);
});
