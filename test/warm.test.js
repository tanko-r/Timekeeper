import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldWarm, WARM_EVERY_MS, IDLE_AFTER_MS } from '../public/js/lib/warm.js';

const NOW = 1_000_000_000;

test('shouldWarm: recent input in a visible tab warms', () => {
  assert.equal(shouldWarm({ visible: true, nowMs: NOW, lastInputMs: NOW - 60_000 }), true);
});

test('shouldWarm: a visible tab with no recent input does not warm', () => {
  assert.equal(shouldWarm({ visible: true, nowMs: NOW, lastInputMs: NOW - IDLE_AFTER_MS }), false);
  assert.equal(shouldWarm({ visible: true, nowMs: NOW, lastInputMs: NOW - 3_600_000 }), false);
});

test('shouldWarm: a hidden tab never warms, even with recent input', () => {
  assert.equal(shouldWarm({ visible: false, nowMs: NOW, lastInputMs: NOW }), false);
});

test('heartbeat is no longer than the idle window, so active use is never missed', () => {
  assert.ok(WARM_EVERY_MS <= IDLE_AFTER_MS);
});
