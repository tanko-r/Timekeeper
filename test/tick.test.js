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
