import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractPeople, correctInitials } from '../server/lib/people.js';

test('extracts name after "telephone conference with"', () => {
  assert.deepEqual(
    extractPeople('Telephone conference with M. Smith regarding lease terms.'),
    ['M. Smith']);
});

test('extracts multiple names joined by "and" and commas', () => {
  assert.deepEqual(
    extractPeople('Email to John Smith and Mary Jones re revised draft'),
    ['John Smith', 'Mary Jones']);
  assert.deepEqual(
    extractPeople('email to A. Foo, B. Bar and C. Baz re closing'),
    ['A. Foo', 'B. Bar', 'C. Baz']);
});

test('generic roles are not people', () => {
  assert.deepEqual(extractPeople('Correspondence with opposing counsel regarding hearing.'), []);
  assert.deepEqual(extractPeople('Call with Opposing Counsel re schedule.'), []);
  assert.deepEqual(extractPeople('meeting with City of Springfield staff'), []);
});

test('possessive captures are descriptions, not names', () => {
  assert.deepEqual(extractPeople("Conference with Sam's counsel re lease."), []);
  assert.deepEqual(extractPeople('Call with Landlord’s broker.'), []);
});

test('trailing punctuation and duration labels never leak into names', () => {
  assert.deepEqual(
    extractPeople('Emails from A. Turner; revise lease (0.3).'),
    ['A. Turner']);
});

test('connector tokens cut the capture', () => {
  assert.deepEqual(
    extractPeople('Meeting with John Smith Re Draft Agreement'),
    ['John Smith']);
});

test('courtesy titles are consumed but not stored', () => {
  assert.deepEqual(extractPeople('Email from Dr. Jones re inspection'), ['Jones']);
});

test('hyphens and apostrophes survive', () => {
  assert.deepEqual(
    extractPeople("Zoom with Sarah O'Brien-Smith re closing checklist"),
    ["Sarah O'Brien-Smith"]);
});

test('dedupes case-insensitively within one text', () => {
  assert.deepEqual(
    extractPeople('Call with John Smith; follow-up call with JOHN SMITH.'),
    ['John Smith']);
});

test('a bare single initial is not a name', () => {
  assert.deepEqual(extractPeople('call with M. re lease'), []);
});

test('name capture does not bleed across segment boundaries', () => {
  assert.deepEqual(
    extractPeople('Meeting with John Smith\n\n\nEmail to Mary Jones'),
    ['John Smith', 'Mary Jones']);
  assert.deepEqual(
    extractPeople('Meeting with John Smith Email to Mary Jones'),
    ['John Smith', 'Mary Jones']);
  assert.deepEqual(
    extractPeople('Call with John Smith Reviewed the draft'),
    ['John Smith']);
});

test('no triggers, empty, or non-string input → empty', () => {
  assert.deepEqual(extractPeople('Review lease agreement for renewal terms.'), []);
  assert.deepEqual(extractPeople(''), []);
  assert.deepEqual(extractPeople(null), []);
  assert.deepEqual(extractPeople(undefined), []);
});

// --- correctInitials -------------------------------------------------------
// The fine-tuned narrative model invents initials. Measured 2026-08-18: given
// "pierce" with C. Pierce outside its context window it wrote "R. Pierce"
// through PyTorch and "J. Pierce" through Ollama — a real colleague, the wrong
// initial, stated with no hedging. Two of four test generations were wrong this
// way. matter_people already knows the answer, so the roster decides.

test('corrects an invented initial against the roster', () => {
  const { text, fixes } = correctInitials(
    'Call with R. Pierce regarding access.', ['C. Pierce']);
  assert.equal(text, 'Call with C. Pierce regarding access.');
  assert.deepEqual(fixes, [{ from: 'R. Pierce', to: 'C. Pierce' }]);
});

test('supplies a missing initial for a bare surname', () => {
  const { text } = correctInitials('Call with Venn re title.', ['L. Venn']);
  assert.equal(text, 'Call with L. Venn re title.');
});

test('leaves a correct name untouched and reports no fix', () => {
  const { text, fixes } = correctInitials(
    'Emails with J. DiMaggio regarding Dominion.', ['J. DiMaggio']);
  assert.equal(text, 'Emails with J. DiMaggio regarding Dominion.');
  assert.deepEqual(fixes, []);
});

test('does not double-prefix an already-corrected name', () => {
  // Two passes (fix initials, then fill bare surnames) turn "R. Pierce" into
  // "C. C. Pierce": the second pass matches the surname the first just wrote.
  const { text } = correctInitials('Call with R. Pierce.', ['C. Pierce']);
  assert.equal(text, 'Call with C. Pierce.');
});

test('leaves surnames the roster does not know alone', () => {
  const { text, fixes } = correctInitials(
    'Call with R. Unknown regarding access.', ['C. Pierce']);
  assert.equal(text, 'Call with R. Unknown regarding access.');
  assert.deepEqual(fixes, []);
});

test('does not rewrite ordinary capitalised words', () => {
  // "Review" and "Amendment" are not people, and a roster surname must not
  // match a word that merely shares its spelling mid-sentence.
  const { text } = correctInitials(
    'Review 6th Amendment to Development Agreement.', ['C. Pierce', 'L. Venn']);
  assert.equal(text, 'Review 6th Amendment to Development Agreement.');
});

test('matches surname case-insensitively but writes the roster spelling', () => {
  const { text } = correctInitials('email to dimaggio re status', ['J. DiMaggio']);
  assert.equal(text, 'email to J. DiMaggio re status');
});

test('empty roster or empty text is a no-op', () => {
  assert.equal(correctInitials('Call with R. Pierce.', []).text, 'Call with R. Pierce.');
  assert.equal(correctInitials('', ['C. Pierce']).text, '');
  assert.equal(correctInitials(null, ['C. Pierce']).text, '');
});
