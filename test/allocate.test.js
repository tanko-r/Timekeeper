import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allocateTenths } from '../server/lib/allocate.js';

test('divides a total into tenths matching shares, summing exactly', () => {
  assert.deepEqual(allocateTenths(1.5, [0.5, 0.3, 0.2]), [0.8, 0.4, 0.3]);
  assert.deepEqual(allocateTenths(1.0, [1]), [1.0]);
  assert.deepEqual(allocateTenths(0.5, [0.34, 0.33, 0.33]), [0.2, 0.2, 0.1]);
});

test('sum always equals the total despite rounding', () => {
  for (const [total, shares] of [
    [2.3, [0.17, 0.29, 0.54]],
    [0.4, [0.5, 0.5]],
    [7.7, [0.1, 0.2, 0.3, 0.4]],
  ]) {
    const out = allocateTenths(total, shares);
    const sum = Math.round(out.reduce((a, b) => a + b, 0) * 10) / 10;
    assert.equal(sum, total, `${total} / ${shares}`);
  }
});

test('degenerate shares fall back to an even split', () => {
  assert.deepEqual(allocateTenths(0.3, [0, 0, 0]), [0.1, 0.1, 0.1]);
  assert.deepEqual(allocateTenths(1.0, []), []);
});

test('every line gets at least a tenth when the total allows it', () => {
  const out = allocateTenths(1.0, [0.97, 0.01, 0.01, 0.01]);
  assert.ok(out.every((h) => h >= 0.1), JSON.stringify(out));
  assert.equal(Math.round(out.reduce((a, b) => a + b, 0) * 10) / 10, 1.0);
});

// --- billing increments other than a tenth --------------------------------
// The firm's rounding increment is a setting (Settings → rounding). Every entry
// total is a multiple of it, and the task lines that make up that entry have to
// be multiples of it too — and still add up to the entry exactly.

const exactSum = (out) => Math.round(out.reduce((a, b) => a + b, 0) * 1e6) / 1e6;
const isMultiple = (h, inc) => Math.abs(Math.round(h / inc) - h / inc) < 1e-9;

test('quarter-hour firm: lines are quarters and sum exactly to the total', () => {
  assert.deepEqual(allocateTenths(0.75, [0.5, 0.5], 0.25), [0.5, 0.25]);
  assert.deepEqual(allocateTenths(1.0, [0.5, 0.5], 0.25), [0.5, 0.5]);
  assert.deepEqual(allocateTenths(0.25, [1], 0.25), [0.25]);

  for (const [total, shares] of [
    [0.75, [0.5, 0.5]],
    [2.5, [0.17, 0.29, 0.54]],
    [1.25, [0.6, 0.4]],
    [4.0, [0.1, 0.2, 0.3, 0.4]],
    [0.5, [0.34, 0.33, 0.33]],
  ]) {
    const out = allocateTenths(total, shares, 0.25);
    assert.equal(exactSum(out), total, `sum for ${total} / ${shares}: ${out}`);
    for (const h of out) assert.ok(isMultiple(h, 0.25), `${h} is not a quarter (${out})`);
  }
});

test('other increments keep the exact-sum invariant', () => {
  for (const increment of [0.05, 0.2, 0.5, 0.1]) {
    for (const [total, shares] of [
      [increment, [1]],
      [increment * 3, [0.5, 0.5]],
      [increment * 7, [0.17, 0.29, 0.54]],
      [increment * 13, [0.97, 0.01, 0.01, 0.01]],
      [increment * 20, [0, 0, 0]],
    ]) {
      const out = allocateTenths(total, shares, increment);
      assert.equal(exactSum(out), Math.round(total * 1e6) / 1e6,
        `sum for ${total} @ ${increment} / ${shares}: ${out}`);
      for (const h of out) {
        assert.ok(isMultiple(h, increment), `${h} is not a multiple of ${increment} (${out})`);
      }
    }
  }
});

test('a total that is not a whole number of increments still sums exactly', () => {
  // Shouldn't happen (entry totals are rounded to the increment first), but if
  // it does, the sub-increment tail rides on a line instead of vanishing.
  for (const [total, shares, increment] of [
    [0.75, [0.5, 0.5], 0.1],
    [0.24, [0.5, 0.5], 0.1],
    [1.3, [0.5, 0.3, 0.2], 0.25],
    [0.05, [0.5, 0.5], 0.1],
  ]) {
    const out = allocateTenths(total, shares, increment);
    assert.equal(exactSum(out), total, `sum for ${total} @ ${increment}: ${out}`);
  }
});

test('omitting the increment is identical to passing a tenth', () => {
  for (const [total, shares] of [
    [1.5, [0.5, 0.3, 0.2]],
    [0.5, [0.34, 0.33, 0.33]],
    [7.7, [0.1, 0.2, 0.3, 0.4]],
    [1.0, [0.97, 0.01, 0.01, 0.01]],
    [0.3, [0, 0, 0]],
  ]) {
    assert.deepEqual(allocateTenths(total, shares), allocateTenths(total, shares, 0.1));
  }
});
