import test from 'node:test';
import assert from 'node:assert/strict';
import { addDaysStr, rangeFor, shiftAnchor } from '../public/js/lib/daterange.js';

test('addDaysStr crosses month and year boundaries in local time', () => {
  assert.equal(addDaysStr('2026-07-13', 1), '2026-07-14');
  assert.equal(addDaysStr('2026-07-31', 1), '2026-08-01');
  assert.equal(addDaysStr('2026-01-01', -1), '2025-12-31');
});

test('rangeFor day is the single day', () => {
  assert.deepEqual(rangeFor('day', '2026-07-13'), { from: '2026-07-13', to: '2026-07-13' });
});

test('rangeFor week runs Monday through Sunday of the anchor week', () => {
  // 2026-07-13 is a Monday
  assert.deepEqual(rangeFor('week', '2026-07-13'), { from: '2026-07-13', to: '2026-07-19' });
  assert.deepEqual(rangeFor('week', '2026-07-15'), { from: '2026-07-13', to: '2026-07-19' });
  assert.deepEqual(rangeFor('week', '2026-07-19'), { from: '2026-07-13', to: '2026-07-19' }); // Sunday belongs to the same week
});

test('rangeFor month covers the anchor month exactly', () => {
  assert.deepEqual(rangeFor('month', '2026-07-13'), { from: '2026-07-01', to: '2026-07-31' });
  assert.deepEqual(rangeFor('month', '2026-02-10'), { from: '2026-02-01', to: '2026-02-28' });
  assert.deepEqual(rangeFor('month', '2028-02-10'), { from: '2028-02-01', to: '2028-02-29' }); // leap
});

test('shiftAnchor steps by the mode unit', () => {
  assert.equal(shiftAnchor('day', '2026-07-13', 1), '2026-07-14');
  assert.equal(shiftAnchor('week', '2026-07-13', -1), '2026-07-06');
  assert.equal(shiftAnchor('month', '2026-07-13', 1), '2026-08-13');
});

test('shiftAnchor month clamps the day-of-month', () => {
  assert.equal(shiftAnchor('month', '2026-07-31', -1), '2026-06-30');
  assert.equal(shiftAnchor('month', '2026-01-31', 1), '2026-02-28');
});
