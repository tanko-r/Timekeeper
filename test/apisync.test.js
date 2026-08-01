import { test } from 'node:test';
import assert from 'node:assert/strict';
import { changeEventsFor } from '../public/js/api.js';

// Cross-surface sync (2026-07-14 feedback: AOT float and dashboard drifted
// apart for 30+ minutes). Every surface — timer grid, entry cards, the PiP
// float — talks through api.js, so the request layer is the one place that
// sees every mutation. changeEventsFor names the window events to dispatch
// after a successful request; listeners refresh instantly instead of waiting
// out a (possibly throttled) 5s poll.

test('timer mutations announce tk:timers-changed', () => {
  assert.deepEqual(changeEventsFor('POST', '/api/timers/3/stop'), ['tk:timers-changed']);
  assert.deepEqual(changeEventsFor('POST', '/api/timers'), ['tk:timers-changed']);
  assert.deepEqual(changeEventsFor('PATCH', '/api/timers/3'), ['tk:timers-changed']);
  assert.deepEqual(changeEventsFor('PUT', '/api/timers/order'), ['tk:timers-changed']);
  assert.deepEqual(changeEventsFor('DELETE', '/api/timers/3'), ['tk:timers-changed']);
});

test('entry mutations announce tk:entries-changed', () => {
  assert.deepEqual(changeEventsFor('PATCH', '/api/entries/9'), ['tk:entries-changed']);
  assert.deepEqual(changeEventsFor('POST', '/api/entries'), ['tk:entries-changed']);
  assert.deepEqual(changeEventsFor('DELETE', '/api/entries/9'), ['tk:entries-changed']);
});

// 2026-07-24 feedback: an entry edit that re-bases a timer's day clock (the
// server reports which in timers_synced) has to wake the timer surfaces too,
// or the grid shows the old clock until its next 5s poll.
test('an entry edit that moved a timer clock also announces tk:timers-changed', () => {
  assert.deepEqual(
    changeEventsFor('PATCH', '/api/entries/9', { timers_synced: [3] }),
    ['tk:entries-changed', 'tk:timers-changed']);
  assert.deepEqual(
    changeEventsFor('PATCH', '/api/entries/9', { timers_synced: [] }),
    ['tk:entries-changed']);
  assert.deepEqual(changeEventsFor('PATCH', '/api/entries/9', null), ['tk:entries-changed']);
});

test('reads and unrelated endpoints announce nothing', () => {
  assert.deepEqual(changeEventsFor('GET', '/api/timers'), []);
  assert.deepEqual(changeEventsFor('GET', '/api/entries'), []);
  assert.deepEqual(changeEventsFor('GET', '/api/dashboard'), []);
  assert.deepEqual(changeEventsFor('POST', '/api/timer-groups'), []);
  assert.deepEqual(changeEventsFor('POST', '/api/export'), []);
  assert.deepEqual(changeEventsFor('PATCH', '/api/settings'), []);
});
