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
