import { test } from 'node:test';
import assert from 'node:assert/strict';
import { longRunMark, longRunNotifications } from '../public/js/lib/notify.js';

// Long-running timer notifications: first at 2h of continuous running, then
// hourly (3h, 4h, …). Pure scheduling — the component supplies the current
// running-stretch seconds and keeps the returned marks between ticks.

test('longRunMark: null below the threshold, then whole elapsed hours', () => {
  assert.equal(longRunMark(0), null);
  assert.equal(longRunMark(7199), null);        // 1h59m59s
  assert.equal(longRunMark(7200), 2);           // exactly 2h
  assert.equal(longRunMark(10799), 2);          // 2h59m59s
  assert.equal(longRunMark(10800), 3);          // hourly after that
  assert.equal(longRunMark(4 * 3600 + 5), 4);
});

test('longRunMark honors a custom threshold', () => {
  assert.equal(longRunMark(3600, 1), 1);
  assert.equal(longRunMark(3599, 1), null);
  assert.equal(longRunMark(2 * 3600, 3), null);
});

test('crossing 2h fires once; the same mark never repeats', () => {
  const timers = [{ id: 7, name: 'Acme research', running: true, seconds: 7300 }];
  const first = longRunNotifications(timers, {});
  assert.deepEqual(first.due, [{ id: 7, name: 'Acme research', mark: 2 }]);
  const again = longRunNotifications(timers, first.marks);
  assert.deepEqual(again.due, []);
});

test('each later hour fires exactly once', () => {
  const at = (s) => [{ id: 7, name: 'T', running: true, seconds: s }];
  const r2 = longRunNotifications(at(7200), {});
  const r3 = longRunNotifications(at(10800), r2.marks);
  assert.deepEqual(r3.due.map((d) => d.mark), [3]);
  const r3b = longRunNotifications(at(11000), r3.marks);
  assert.deepEqual(r3b.due, []);
});

test('a stopped timer is forgotten, so a fresh 2h stretch re-notifies', () => {
  const running = [{ id: 7, name: 'T', running: true, seconds: 7300 }];
  const r1 = longRunNotifications(running, {});
  assert.equal(r1.due.length, 1);
  // stop → the mark drops out of the returned map
  const stopped = [{ id: 7, name: 'T', running: false, seconds: 0 }];
  const r2 = longRunNotifications(stopped, r1.marks);
  assert.deepEqual(r2.due, []);
  assert.deepEqual(r2.marks, {});
  // a brand-new 2h stretch alerts again
  const r3 = longRunNotifications(running, r2.marks);
  assert.equal(r3.due.length, 1);
});

test('below-threshold running timers carry no mark', () => {
  const { due, marks } = longRunNotifications(
    [{ id: 1, name: 'A', running: true, seconds: 600 }], {});
  assert.deepEqual(due, []);
  assert.deepEqual(marks, {});
});

test('timers are independent', () => {
  const timers = [
    { id: 1, name: 'A', running: true, seconds: 7300 },
    { id: 2, name: 'B', running: true, seconds: 11000 },
    { id: 3, name: 'C', running: true, seconds: 100 },
  ];
  const { due } = longRunNotifications(timers, { 2: 2 });
  assert.deepEqual(due, [{ id: 1, name: 'A', mark: 2 }, { id: 2, name: 'B', mark: 3 }]);
});
