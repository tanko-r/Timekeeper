import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ghostCompletion } from '../public/js/lib/ghost.js';

const PHRASES = [
  'revise lease legal description',
  'telephone conference with A. Turner',
  'Review title commitment and survey',
];

test('completes a prefix from the ranked list; first (highest-ranked) hit wins', () => {
  assert.equal(ghostCompletion('rev', 3, PHRASES), 'ise lease legal description');
});

test('case-insensitive; remainder keeps the phrase casing after the typed part', () => {
  assert.equal(ghostCompletion('Rev', 3, PHRASES), 'ise lease legal description');
  assert.equal(ghostCompletion('review t', 8, PHRASES), 'itle commitment and survey');
});

test('completes the clause after the last sentence break', () => {
  const typed = 'Reviewed survey; tele';
  assert.equal(ghostCompletion(typed, typed.length, PHRASES), 'phone conference with A. Turner');
});

test('no ghost when the caret is not at the end, input too short, or no match', () => {
  assert.equal(ghostCompletion('rev', 2, PHRASES), null);
  assert.equal(ghostCompletion('r', 1, PHRASES), null);
  assert.equal(ghostCompletion('zzz', 3, PHRASES), null);
  assert.equal(ghostCompletion('', 0, PHRASES), null);
});

test('a fully typed phrase produces no ghost', () => {
  const full = 'revise lease legal description';
  assert.equal(ghostCompletion(full, full.length, PHRASES), null);
});
