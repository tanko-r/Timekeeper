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

test('a capitalised verb the list does not know is still not part of the name', () => {
  // LEAD_VERBS cannot list every verb; "the" straight after a capitalised word
  // is the grammar that gives it away
  assert.deepEqual(names('Recirculate the Access Agreement.'),
    ['document:Access Agreement']);
  assert.deepEqual(names('Revise the Access Agreement; recirculate the Access Agreement.'),
    ['document:Access Agreement']);
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

import { rankEntities } from '../server/lib/entities.js';

const row = (name, count, last, extra = {}) => ({
  name, kind: 'document', count, last_seen_at: last,
  origin: 'derived', hidden: 0, ...extra,
});

test('rankEntities: recent beats stale at equal count', () => {
  const out = rankEntities([
    row('Stale Agreement', 4, '2026-05-01'),
    row('Fresh Agreement', 4, '2026-08-29'),
  ], { today: '2026-08-30' });
  assert.deepEqual(out.map((e) => e.name), ['Fresh Agreement', 'Stale Agreement']);
  assert.ok(out[0].score > out[1].score);
});

test('rankEntities: a derived row needs two sightings, a manual row needs none', () => {
  const out = rankEntities([
    row('Once Seen Agreement', 1, '2026-08-29'),
    row('Typed By Hand', 0, null, { origin: 'manual', count: 0 }),
  ], { today: '2026-08-30' });
  assert.deepEqual(out.map((e) => e.name), ['Typed By Hand']);
});

test('rankEntities: hidden rows never rank', () => {
  const out = rankEntities([
    row('Wrong Capture Agreement', 9, '2026-08-29', { hidden: 1 }),
    row('Real Agreement', 2, '2026-08-29'),
  ], { today: '2026-08-30' });
  assert.deepEqual(out.map((e) => e.name), ['Real Agreement']);
});

test('rankEntities: a manual row with no date sorts below dated rows', () => {
  const out = rankEntities([
    row('Typed By Hand', 0, null, { origin: 'manual' }),
    row('Seen Twice Agreement', 2, '2026-08-29'),
  ], { today: '2026-08-30' });
  assert.deepEqual(out.map((e) => e.name), ['Seen Twice Agreement', 'Typed By Hand']);
});

test('rankEntities: empty and missing input', () => {
  assert.deepEqual(rankEntities([], { today: '2026-08-30' }), []);
  assert.deepEqual(rankEntities(undefined, { today: '2026-08-30' }), []);
});
