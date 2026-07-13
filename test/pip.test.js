import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPipRows, narrativeMode, narrativeValue, fmtDayTotal, fmtClock, pipSupported,
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

test('pipSupported is false outside a browser', () => {
  assert.equal(pipSupported(), false);
});
