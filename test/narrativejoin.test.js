import { test } from 'node:test';
import assert from 'node:assert/strict';
import { joinNarratives, insertNarrative } from '../public/js/lib/narrativejoin.js';

test('joinNarratives makes one clause list with a single terminal period', () => {
  assert.equal(
    joinNarratives(['Call with W. Hammond regarding the lease.', 'draft response to the landlord.']),
    'Call with W. Hammond regarding the lease; draft response to the landlord.');
});

test('joinNarratives keeps a single narrative intact and capitalized', () => {
  assert.equal(joinNarratives(['review the lease']), 'Review the lease.');
});

test('joinNarratives strips a trailing semicolon as well as a period', () => {
  assert.equal(joinNarratives(['Review the lease;', 'draft the email']),
    'Review the lease; draft the email.');
});

test('joinNarratives drops blanks and handles nothing at all', () => {
  assert.equal(joinNarratives(['', '  ', 'Review the lease.']), 'Review the lease.');
  assert.equal(joinNarratives([]), '');
  assert.equal(joinNarratives(undefined), '');
});

test('insertNarrative fills an empty box', () => {
  assert.equal(insertNarrative('', 'Review the lease.'), 'Review the lease.');
  assert.equal(insertNarrative('   ', 'review the lease'), 'Review the lease.');
});

// Later clauses keep the casing they arrived with. Down-casing the first
// word of a borrowed narrative would be a guess, and the guess is wrong the
// moment that word is a name ("M. Cantu emailed regarding the amendment").
test('insertNarrative never replaces text the attorney already typed', () => {
  assert.equal(
    insertNarrative('Call with D. Adams.', 'Review the lease.'),
    'Call with D. Adams; Review the lease.');
});

test('insertNarrative with nothing to add leaves the box alone', () => {
  assert.equal(insertNarrative('Call with D. Adams.', ''), 'Call with D. Adams.');
  assert.equal(insertNarrative('', ''), '');
});
