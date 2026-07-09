import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expandShortcuts } from '../public/js/lib/expand.js';

const DICT = [
  { abbrev: 'IA', phrase: 'Interconnect Agreement' },
  { abbrev: 'tc/oc', phrase: 'telephone conference with opposing counsel' },
  { abbrev: 'mtge', phrase: 'mortgage' },
];

test('expands after a space, preserving the delimiter and caret', () => {
  const out = expandShortcuts('revise IA ', 10, DICT);
  assert.deepEqual(out, { text: 'revise Interconnect Agreement ', caret: 30 });
});

test('expands on punctuation delimiters', () => {
  const out = expandShortcuts('draft mtge.', 11, DICT);
  assert.equal(out.text, 'draft mortgage.');
  assert.equal(out.caret, 15);
});

test('abbreviations may contain punctuation that is not a delimiter', () => {
  const out = expandShortcuts('tc/oc ', 6, DICT);
  assert.equal(out.text, 'telephone conference with opposing counsel ');
});

test('case-insensitive match; a leading capital propagates to the phrase', () => {
  assert.equal(expandShortcuts('Mtge ', 5, DICT).text, 'Mortgage ');
  assert.equal(expandShortcuts('MTGE ', 5, DICT).text, 'Mortgage ');
  assert.equal(expandShortcuts('ia ', 3, DICT).text, 'Interconnect Agreement ');
});

test('mid-text expansion keeps the tail and places the caret after the delimiter', () => {
  const out = expandShortcuts('per IA terms', 7, DICT); // caret right after "IA "
  assert.equal(out.text, 'per Interconnect Agreement terms');
  assert.equal(out.caret, 27);
});

test('no expansion mid-word, without a delimiter, or for unknown words', () => {
  assert.equal(expandShortcuts('via ', 4, DICT), null);      // "via" is one word, not "IA"
  assert.equal(expandShortcuts('revise IA', 9, DICT), null); // no delimiter typed yet
  assert.equal(expandShortcuts('foo ', 4, DICT), null);
  assert.equal(expandShortcuts('', 0, DICT), null);
  assert.equal(expandShortcuts('IA ', 3, []), null);
});
