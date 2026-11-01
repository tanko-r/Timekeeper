import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toInputValue, fromInputValue, fmtRunStamp, runKind } from '../public/js/lib/runtimes.js';

// Local-time dates built from parts so the tests hold in any time zone.
const local = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi).toISOString();

test('runKind: time-only when both ends are today, date+time when the run began earlier', () => {
  const today = '2026-07-07';
  assert.equal(runKind(local(2026, 7, 7, 9, 0), today), 'time');
  assert.equal(runKind(local(2026, 7, 6, 21, 0), today), 'datetime');
  assert.equal(runKind(null, today), 'time');
});

test('toInputValue: time and datetime-local formats', () => {
  const iso = local(2026, 7, 7, 9, 5);
  assert.equal(toInputValue(iso, 'time'), '09:05');
  assert.equal(toInputValue(iso, 'datetime'), '2026-07-07T09:05');
  assert.equal(toInputValue(null, 'time'), '');
});

test('fromInputValue: time uses the given day; datetime stands alone; blank is null', () => {
  assert.equal(fromInputValue('09:05', '2026-07-07'), local(2026, 7, 7, 9, 5));
  assert.equal(fromInputValue('2026-07-06T21:30', '2026-07-07'), local(2026, 7, 6, 21, 30));
  assert.equal(fromInputValue('', '2026-07-07'), null);
  assert.equal(fromInputValue('garbage', '2026-07-07'), null);
});

test('fmtRunStamp: bare time today, weekday + time otherwise', () => {
  assert.equal(fmtRunStamp(local(2026, 7, 7, 21, 14), '2026-07-07'), '9:14 PM');
  assert.equal(fmtRunStamp(local(2026, 7, 7, 0, 5), '2026-07-07'), '12:05 AM');
  assert.equal(fmtRunStamp(local(2026, 7, 6, 21, 14), '2026-07-07'), 'Mon 9:14 PM');
  assert.equal(fmtRunStamp(null, '2026-07-07'), '');
});
