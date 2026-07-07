import { test } from 'node:test';
import assert from 'node:assert/strict';
import { roundHours, secondsToHours } from '../server/lib/rounding.js';

test('nearest mode rounds to increment', () => {
  const r = { increment: 0.1, mode: 'nearest' };
  assert.equal(roundHours(1.24, r), 1.2);
  assert.equal(roundHours(1.25, r), 1.3);
  assert.equal(roundHours(0.04, r), 0);
  assert.equal(roundHours(0.05, r), 0.1);
  assert.equal(roundHours(2.0, r), 2.0);
});

test('up mode always rounds up to next increment', () => {
  const r = { increment: 0.1, mode: 'up' };
  assert.equal(roundHours(0.01, r), 0.1);
  assert.equal(roundHours(1.21, r), 1.3);
  assert.equal(roundHours(1.2, r), 1.2); // exact multiples stay put
});

test('quarter-hour increments work', () => {
  assert.equal(roundHours(1.3, { increment: 0.25, mode: 'nearest' }), 1.25);
  assert.equal(roundHours(1.4, { increment: 0.25, mode: 'up' }), 1.5);
});

test('invalid increment returns value unchanged', () => {
  assert.equal(roundHours(1.234, { increment: 0, mode: 'nearest' }), 1.234);
});

test('secondsToHours applies rounding when enabled', () => {
  assert.equal(secondsToHours(3600, { enabled: true, increment: 0.1, mode: 'nearest' }), 1.0);
  assert.equal(secondsToHours(2520, { enabled: true, increment: 0.1, mode: 'nearest' }), 0.7);
  assert.equal(secondsToHours(90, { enabled: true, increment: 0.1, mode: 'up' }), 0.1);
  // disabled → raw hours to 2 decimals
  assert.equal(secondsToHours(100, { enabled: false, increment: 0.1, mode: 'nearest' }), 0.03);
});
