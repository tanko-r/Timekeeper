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

const ENTITIES = [
  { name: 'Development Agreement', kind: 'document' },
  { name: 'Cedar Utility', kind: 'org' },
];
const PEOPLE = [{ name: 'A. Turner' }, { name: 'M. Smith' }];
const OPTS = { entities: ENTITIES, people: PEOPLE };
const ghost = (typed, opts = OPTS) => ghostCompletion(typed, typed.length, PHRASES, opts);

test('a document verb offers the top entity', () => {
  assert.equal(ghost('Review and analyze '), 'Development Agreement');
});

test('regarding and re offer an entity too', () => {
  assert.equal(ghost('Call regarding '), 'Development Agreement');
  assert.equal(ghost('Email re '), 'Development Agreement');
});

test('with, to and from all offer a person', () => {
  assert.equal(ghost('Telephone conference with '), 'A. Turner');
  assert.equal(ghost('Email to '), 'A. Turner');
  assert.equal(ghost('Letter from '), 'A. Turner');
});

test('a part-typed word completes from either list, with no trigger needed', () => {
  assert.equal(ghost('Review and analyze Devel'), 'opment Agreement');
  assert.equal(ghost('Email to M. Sm'), 'ith');
});

test('an ordinary word offers nothing', () => {
  assert.equal(ghost('Attended the '), null);
  assert.equal(ghost('Reviewed it and then '), null);
});

test('never offers something already in the text — it offers the next one', () => {
  // 'Development Agreement' is spoken for, so the trigger falls through to the
  // next ranked entity rather than going quiet.
  assert.equal(ghost('Review Development Agreement and analyze '), 'Cedar Utility');
  // ...and with nothing left to offer, it does go quiet
  assert.equal(ghost('Review Development Agreement and Cedar Utility and analyze '), null);
});

test('a list of people continues after "and" or a comma', () => {
  assert.equal(ghost('Call with A. Turner and '), 'M. Smith');
  assert.equal(ghost('Call with A. Turner, '), 'M. Smith');
  // ...but only inside a clause that actually introduced a person
  assert.equal(ghost('Reviewed the file and '), null);
});

test('after a name with no document yet, the chain offers one', () => {
  assert.equal(ghost('Email to A. Turner '), 'regarding Development Agreement');
  // already has one → nothing to chain
  assert.equal(ghost('Email to A. Turner regarding Development Agreement '), null);
});

test('the phrasebook still wins when it matches', () => {
  // 'rev' is a phrase prefix; tier 2 must never get the chance
  assert.equal(ghost('rev'), 'ise lease legal description');
});

test('with no entities or people, behaviour is exactly as before', () => {
  assert.equal(ghostCompletion('Review and analyze ', 18, PHRASES), null);
  assert.equal(ghostCompletion('rev', 3, PHRASES), 'ise lease legal description');
});
