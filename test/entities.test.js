import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractEntities } from '../server/lib/entities.js';

const names = (t) => extractEntities(t).map((e) => `${e.kind}:${e.name}`);

test('a capitalised run ending in a head noun is a document', () => {
  assert.deepEqual(names('Review and revise the Cedar Lease Agreement today.'),
    ['document:Cedar Lease Agreement']);
});

test('"and" inside a document name is part of the name', () => {
  assert.deepEqual(names('Circulate the Purchase and Sale Agreement.'),
    ['document:Purchase and Sale Agreement']);
});

test('lowercase joiners hold a document name together', () => {
  assert.deepEqual(names('Analyze the Letter of Intent.'), ['document:Letter of Intent']);
});

// The two junk shapes measured on the live database before this was designed.
test('a leading verb is stripped off its object', () => {
  assert.deepEqual(names('Prepare Closing Binder for the closing.'),
    ['document:Closing Binder']);
});

test('"and" between two organisations splits them', () => {
  assert.deepEqual(names('Call regarding Acme and Cedar Utility scheduling.'),
    ['org:Acme', 'org:Cedar Utility']);
});

test('a lone word at the start of a clause is not evidence of an organisation', () => {
  // sentence-initial capitals are grammar, not names
  assert.deepEqual(names('Analysis of the title chain.'), []);
  // ...but an acronym is, wherever it sits
  assert.deepEqual(names('BGE confirmed the route.'), ['org:BGE']);
});

test('people are never captured as entities', () => {
  assert.deepEqual(names('Telephone conference with A. Turner regarding access.'), []);
  assert.deepEqual(names('Email to M. Smith and J. Rowan about the survey.'), []);
});

test('a comma ends a run, and an initial disqualifies it', () => {
  assert.deepEqual(names('Call with A. Turner, M. Smith regarding scheduling.'), []);
});

test('the matter tag is stripped before anything else', () => {
  assert.deepEqual(names('(YEL) Revise the Access Agreement.'), ['document:Access Agreement']);
});

test('a bare head noun is not a document', () => {
  assert.deepEqual(names('Revise the Agreement.'), []);
});

test('duplicates within one text collapse', () => {
  assert.deepEqual(names('Revise the Access Agreement; recirculate the Access Agreement.'),
    ['document:Access Agreement']);
});

test('empty and missing input', () => {
  assert.deepEqual(extractEntities(''), []);
  assert.deepEqual(extractEntities(null), []);
});
