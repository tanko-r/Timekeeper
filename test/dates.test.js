process.env.TZ = 'America/Los_Angeles';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  todayLocal, addDays, isValidDate, localMidnightMs, weekBounds,
} from '../server/lib/dates.js';

test('todayLocal formats a Date in local time zone', () => {
  // 2026-07-06 22:30 PDT == 2026-07-07 05:30 UTC — local date must win
  const d = new Date('2026-07-07T05:30:00Z');
  assert.equal(todayLocal(d), '2026-07-06');
});

test('addDays crosses month and DST boundaries', () => {
  assert.equal(addDays('2026-07-31', 1), '2026-08-01');
  assert.equal(addDays('2026-03-08', 1), '2026-03-09'); // spring forward day
  assert.equal(addDays('2026-11-01', 1), '2026-11-02'); // fall back day
  assert.equal(addDays('2026-01-01', -1), '2025-12-31');
});

test('isValidDate accepts real dates only', () => {
  assert.ok(isValidDate('2026-02-28'));
  assert.ok(!isValidDate('2026-02-30'));
  assert.ok(!isValidDate('07/06/2026'));
  assert.ok(!isValidDate('2026-13-01'));
  assert.ok(!isValidDate(''));
});

test('localMidnightMs matches local Date constructor', () => {
  assert.equal(localMidnightMs('2026-07-06'), new Date(2026, 6, 6).getTime());
  assert.equal(localMidnightMs('2026-11-01'), new Date(2026, 10, 1).getTime());
});

test('weekBounds returns Monday..Sunday containing the date', () => {
  assert.deepEqual(weekBounds('2026-07-06'), { from: '2026-07-06', to: '2026-07-12' }); // a Monday
  assert.deepEqual(weekBounds('2026-07-05'), { from: '2026-06-29', to: '2026-07-05' }); // a Sunday
  assert.deepEqual(weekBounds('2026-07-08'), { from: '2026-07-06', to: '2026-07-12' });
});
