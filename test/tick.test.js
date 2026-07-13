import test from 'node:test';
import assert from 'node:assert/strict';
import { msUntilNextSecond } from '../public/js/lib/tick.js';

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
