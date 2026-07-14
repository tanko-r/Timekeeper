import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPipRows, narrativeMode, narrativeValue, fmtDayTotal, fmtClock, pipSupported, recentPickList,
  closeoutTimer,
} from '../public/js/lib/pip.js';

const T = (id, extra = {}) => ({
  id, running: 0, elapsed_seconds: 0, pinned: 0, linked_entry_id: null,
  draft_narrative: null, entry_narrative: null, entry_narrative_manual: null,
  entry_substantive_lines: 0, ...extra,
});

test('buildPipRows: running OR time-today OR pinned; running first, input order kept', () => {
  const timers = [
    T(1),                                  // idle, no time — hidden
    T(2, { elapsed_seconds: 600 }),        // time today
    T(3, { pinned: 1 }),                   // pinned at zero
    T(4, { running: 1, elapsed_seconds: 60 }),
    T(5, { elapsed_seconds: 30 }),
  ];
  assert.deepEqual(buildPipRows(timers).map((t) => t.id), [4, 2, 3, 5]);
  assert.deepEqual(buildPipRows([]), []);
  assert.deepEqual(buildPipRows(null), []);
});

test('narrativeMode: stash without an entry, readonly for auto split entries, else entry', () => {
  assert.equal(narrativeMode(T(1)), 'stash');
  assert.equal(narrativeMode(T(1, { linked_entry_id: 9, entry_substantive_lines: 1 })), 'entry');
  assert.equal(narrativeMode(T(1, { linked_entry_id: 9, entry_substantive_lines: 2 })), 'readonly');
  assert.equal(
    narrativeMode(T(1, { linked_entry_id: 9, entry_substantive_lines: 2, entry_narrative_manual: 1 })),
    'entry', 'detached narrative is free text even on a split entry');
});

test('narrativeValue: stash text before an entry exists, entry narrative after', () => {
  assert.equal(narrativeValue(T(1, { draft_narrative: 'Stashed.' })), 'Stashed.');
  assert.equal(narrativeValue(T(1, { linked_entry_id: 9, entry_narrative: 'Filed.', entry_substantive_lines: 1 })), 'Filed.');
  assert.equal(narrativeValue(T(1)), '');
});

test('fmtDayTotal formats decimal hours', () => {
  assert.equal(fmtDayTotal(0), '0.0h today');
  assert.equal(fmtDayTotal(3960), '1.1h today');
  assert.equal(fmtDayTotal(-5), '0.0h today');
});

test('fmtClock matches the titlebar/ui format', () => {
  assert.equal(fmtClock(0), '00:00');
  assert.equal(fmtClock(75), '01:15');
  assert.equal(fmtClock(3600), '1:00:00');
  assert.equal(fmtClock(4271.9), '1:11:11');
});

test('closeoutTimer: returns the stopped timer when there is something to narrate', () => {
  const stopped = T(4, { elapsed_seconds: 600, linked_entry_id: 9 });
  assert.equal(closeoutTimer([T(1), stopped], 4), stopped, 'time filed to an entry');

  const held = T(4, { elapsed_seconds: 600 });
  assert.equal(closeoutTimer([held], 4), held, 'matterless timer holding time — narrative stashes');

  const entryOnly = T(4, { linked_entry_id: 9 });
  assert.equal(closeoutTimer([entryOnly], 4), entryOnly, 'entry exists even at 0:00 today');
});

test('closeoutTimer: null when the stop left nothing to narrate', () => {
  assert.equal(closeoutTimer([T(1), T(4)], 4), null, 'misclick grace undid the start');
  assert.equal(closeoutTimer([T(1)], 4), null, 'timer gone by the time the poll lands');
  assert.equal(closeoutTimer(null, 4), null);
  const stillRunning = T(4, { running: 1, elapsed_seconds: 600 });
  assert.equal(closeoutTimer([stillRunning], 4), null, 'never close out a timer that is running');
});

test('pipSupported is false outside a browser', () => {
  assert.equal(pipSupported(), false);
});

// 2026-07-14 feedback: a "recent" picker next to + adds past-week timers to
// today's float list. The additions ride in as an extra-ids set…
test('buildPipRows: extras set pulls otherwise-hidden timers into the list', () => {
  const timers = [T(1), T(2, { elapsed_seconds: 600 }), T(3)];
  assert.deepEqual(buildPipRows(timers, new Set([3])).map((t) => t.id), [2, 3]);
  assert.deepEqual(buildPipRows(timers, new Set()).map((t) => t.id), [2]);
  assert.deepEqual(buildPipRows(timers).map((t) => t.id), [2], 'extras optional');
});

// …and the picker itself offers past-week-active timers not already shown,
// alphabetically.
test('recentPickList: past-week activity, excludes shown rows, A–Z', () => {
  const now = Date.parse('2026-07-14T12:00:00-07:00');
  const days = (n) => new Date(now - n * 86400000).toISOString();
  const timers = [
    T(1, { name: 'Zeta', last_stopped_at: days(2) }),          // recent → offered
    T(2, { name: 'Alpha', last_started_at: days(6) }),         // recent → offered
    T(3, { name: 'Old', last_stopped_at: days(9) }),           // too old
    T(4, { name: 'Never' }),                                   // no activity
    T(5, { name: 'Shown', elapsed_seconds: 60, last_stopped_at: days(1) }), // already a row
    T(6, { name: 'Added', last_stopped_at: days(3) }),         // already added via extras
  ];
  assert.deepEqual(
    recentPickList(timers, new Set([6]), now).map((t) => t.name),
    ['Alpha', 'Zeta']);
  assert.deepEqual(recentPickList(null, new Set(), now), []);
});
