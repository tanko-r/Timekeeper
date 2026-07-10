import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickPipTimer, fmtClock, pipSupported } from '../public/js/lib/pip.js';

const T = (id, running = 0) => ({ id, running });

test('pickPipTimer: a running timer always wins', () => {
  assert.equal(pickPipTimer([T(1), T(2, 1), T(3)], 3).id, 2);
});

test('pickPipTimer: idle → last-used, then first, then null', () => {
  assert.equal(pickPipTimer([T(1), T(2), T(3)], 3).id, 3);
  assert.equal(pickPipTimer([T(1), T(2)], 99).id, 1); // stale last-used id
  assert.equal(pickPipTimer([T(1), T(2)], NaN).id, 1); // nothing in localStorage
  assert.equal(pickPipTimer([], 1), null);
  assert.equal(pickPipTimer(null, 1), null);
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
