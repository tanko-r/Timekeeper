import test from 'node:test';
import assert from 'node:assert/strict';
import { msUntilNextSecond, startAlignedTick } from '../public/js/lib/tick.js';

// The displayed second increments when (now - anchor) crosses a whole-second
// boundary; the delay returned must land the next tick just past that
// boundary regardless of where "now" sits inside the current second.

test('just after a boundary waits a full second (plus epsilon)', () => {
  assert.equal(msUntilNextSecond(10_000, 0), 1025);
  assert.equal(msUntilNextSecond(10_001, 0), 1024);
});

test('mid-second waits the remaining fraction', () => {
  assert.equal(msUntilNextSecond(10_400, 0), 625);
  assert.equal(msUntilNextSecond(10_999, 0), 26);
});

test('boundaries are anchored to anchorMs, not epoch seconds', () => {
  // anchor at 300ms past the epoch second → boundaries at x.3s
  assert.equal(msUntilNextSecond(10_300, 300), 1025);
  assert.equal(msUntilNextSecond(10_500, 300), 825);
});

test('anchor in the future still yields a sane positive delay', () => {
  const d = msUntilNextSecond(1_000, 5_500);
  assert.ok(d > 0 && d <= 1025, `got ${d}`);
});

test('custom epsilon', () => {
  assert.equal(msUntilNextSecond(10_400, 0, 5), 605);
});

// The PiP float must schedule its ticks on the PiP window's OWN timers — the
// opener tab's timers get throttled once it's hidden behind other windows,
// which is precisely when the float is in use.
test('startAlignedTick schedules on the provided host and cancels through it', () => {
  const calls = [];
  let cleared = null;
  const host = {
    setTimeout: (fn, ms) => { calls.push(ms); return calls.length; },
    clearTimeout: (h) => { cleared = h; },
  };
  const cancel = startAlignedTick(0, () => {}, host);
  assert.equal(calls.length, 1, 'first tick scheduled via host.setTimeout');
  assert.ok(calls[0] > 0 && calls[0] <= 1025, `delay in range, got ${calls[0]}`);
  cancel();
  assert.equal(cleared, 1, 'cancel clears via host.clearTimeout');
});

// Live entry hours (2026-08-14 feedback: "These numbers don't update live
// when the timer is running"). An entry's filed total only moves when the
// timer stops, so the list has to add the seconds elapsed since the payload
// was fetched — the same arithmetic the timer card and the footer use.
import { liveTimerSeconds } from '../public/js/lib/tick.js';

const RUN = { running: 1, elapsed_seconds: 120 };

test('a running timer accrues the seconds since the payload was fetched', () => {
  assert.equal(liveTimerSeconds(RUN, 10_000, 15_400), 125.4);
});

test('a stopped timer is frozen at its fetched elapsed_seconds', () => {
  assert.equal(liveTimerSeconds({ running: 0, elapsed_seconds: 120 }, 10_000, 99_000), 120);
});

test('no timer, or no fetch anchor, yields null — the caller keeps the filed total', () => {
  assert.equal(liveTimerSeconds(null, 10_000, 15_000), null);
  assert.equal(liveTimerSeconds(RUN, null, 15_000), null);
});

test('a clock that jumped backwards never subtracts time', () => {
  assert.equal(liveTimerSeconds(RUN, 20_000, 15_000), 120);
});
