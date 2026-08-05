import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanCandidate, isUsableExemplar, looksLikeHouseVoice, pickExemplars, pickPairs, renderGlossary,
} from '../server/lib/exemplars.js';
import { SEED_PAIRS as SEED_PAIRS_FOR_TEST } from '../server/routes/ai.js';

// ── cleanCandidate ────────────────────────────────────────────────────────
// Matter tags and time allocations are display furniture; the model must
// never learn to emit them (the format contract forbids parentheticals).

test('cleanCandidate strips a leading (MTR09 – Cedar Lease) matter tag', () => {
  assert.equal(
    cleanCandidate('(MTR09 – Cedar Lease) Review and analyze Cedar Lease.'),
    'Review and analyze Cedar Lease.');
});

test('cleanCandidate strips a leading [MTR09] bracket tag', () => {
  assert.equal(cleanCandidate('[MTR09] Draft easement amendment.'),
    'Draft easement amendment.');
});

test('cleanCandidate strips (0.3) time allocations anywhere in the line', () => {
  assert.equal(
    cleanCandidate('Review Cedar Lease (0.3); draft amendment (1.2).'),
    'Review Cedar Lease; draft amendment.');
});

test('cleanCandidate collapses whitespace and trims', () => {
  assert.equal(cleanCandidate('  Review\n  Cedar   Lease.  '), 'Review Cedar Lease.');
});

test('cleanCandidate keeps parentheses that are not time amounts', () => {
  assert.equal(cleanCandidate('Review lease (west parcel).'),
    'Review lease (west parcel).');
});

test('cleanCandidate tolerates null and undefined', () => {
  assert.equal(cleanCandidate(null), '');
  assert.equal(cleanCandidate(undefined), '');
});

// ── isUsableExemplar ──────────────────────────────────────────────────────
// The design prototype learned register from a truncated entry ending
// "…regarding;" and reproduced the damage. This gate is that bug's test.

test('isUsableExemplar accepts a well-formed narrative', () => {
  assert.equal(
    isUsableExemplar('Review easement background and confer with M. Peacock regarding same.'),
    true);
});

test('isUsableExemplar rejects a narrative with no terminal period', () => {
  assert.equal(isUsableExemplar('Review easement background and confer with counsel'), false);
});

test('isUsableExemplar rejects a dangling connector before punctuation', () => {
  assert.equal(isUsableExemplar('Review correspondence from R. Calder regarding; draft response.'), false);
  assert.equal(isUsableExemplar('Confer with M. Peacock and.'), false);
});

test('isUsableExemplar rejects candidates that are too short to teach register', () => {
  assert.equal(isUsableExemplar('Review lease.'), false);
});

test('isUsableExemplar rejects candidates longer than 40 words', () => {
  assert.equal(isUsableExemplar(`Review ${'lease '.repeat(45)}.`), false);
});

// ── pickExemplars ─────────────────────────────────────────────────────────

const SAMPLE = [
  'Review lot addition plat and email with E. Hodgson.',                       // 9
  'Emails with J. Curtis and N. Feledy and analysis regarding Cedar Lease.',   // 11
  'Review messages regarding transaction and addendum; review addendum revisions.', // 10
  'Prepare and distribute risk review to the client team today.',              // 10
  'Review and analyze terms of Summit Development Agreement; draft revised agreement to reflect changes in scope; correspond with H. Hogan regarding same.', // 22
  'Emails with client team and with counsel regarding various easement matters and review maps and documents regarding same.', // 18
  'Draft revisions to Cedar Lease incorporating N. Feledy comments and transmit to Town attorney J. Curtis.', // 16
];

test('pickExemplars returns the requested count', () => {
  assert.equal(pickExemplars(SAMPLE, { count: 4 }).length, 4);
});

test('pickExemplars spreads across the length range rather than clustering', () => {
  const words = pickExemplars(SAMPLE, { count: 4 }).map((t) => t.split(/\s+/).length);
  // Ascending spread: shortest first, longest last, and a real spread between.
  assert.deepEqual(words, [...words].sort((a, b) => a - b));
  assert.ok(words[words.length - 1] - words[0] >= 5,
    `expected a spread of lengths, got ${words.join(',')}`);
});

test('pickExemplars drops unusable candidates before selecting', () => {
  const out = pickExemplars([...SAMPLE, 'Review correspondence regarding;', 'no period here'],
    { count: 7 });
  assert.ok(out.every(isUsableExemplar));
});

test('pickExemplars de-duplicates repeated narratives', () => {
  const dupes = ['Review lot addition plat and email with E. Hodgson.'];
  assert.equal(pickExemplars([...dupes, ...dupes, ...dupes], { count: 3 }).length, 1);
});

test('pickExemplars cleans tags and allocations from what it returns', () => {
  const out = pickExemplars(['(MTR09) Review lot addition plat and email with E. Hodgson (0.4).'],
    { count: 1 });
  assert.deepEqual(out, ['Review lot addition plat and email with E. Hodgson.']);
});

test('pickExemplars returns an empty array for no usable input', () => {
  assert.deepEqual(pickExemplars([], { count: 6 }), []);
  assert.deepEqual(pickExemplars(['nope'], { count: 6 }), []);
});

test('pickExemplars never returns more than it has', () => {
  assert.equal(pickExemplars(SAMPLE.slice(0, 2), { count: 6 }).length, 2);
});

// ── pickPairs ─────────────────────────────────────────────────────────────
// Fixed slot count over a growing pool (spec §4): real pairs displace seeds,
// selection prefers same-matter then verb overlap, and echo pairs are dropped.

const SEEDS = [
  { brief: 'rev easement bkgd; conf w peacock', narrative: 'Review easement background and confer with M. Peacock regarding same.', seed: true },
  { brief: 'call w hull re hager approach', narrative: 'Call with C. Hull regarding approach to B. Hager.', seed: true },
];

test('pickPairs falls back to seeds when the pool is empty', () => {
  const out = pickPairs([], SEEDS, { count: 2 });
  assert.deepEqual(out.map((p) => p.brief), SEEDS.map((p) => p.brief));
});

test('pickPairs prefers real pairs over seeds', () => {
  const pool = [
    { brief: 'draft psa', narrative: 'Draft Purchase and Sale Agreement.', cm_id: 1 },
    { brief: 'rev loi', narrative: 'Review and analyze letter of intent.', cm_id: 1 },
  ];
  const out = pickPairs(pool, SEEDS, { count: 2 });
  assert.ok(out.every((p) => !p.seed), 'seeds should be displaced by real pairs');
});

test('pickPairs tops up with seeds when the pool is too small', () => {
  const pool = [{ brief: 'draft psa', narrative: 'Draft Purchase and Sale Agreement.', cm_id: 1 }];
  const out = pickPairs(pool, SEEDS, { count: 3 });
  assert.equal(out.length, 3);
  assert.equal(out.filter((p) => p.seed).length, 2);
});

test('pickPairs never exceeds the slot count however large the pool', () => {
  const pool = Array.from({ length: 200 }, (_, i) => ({
    brief: `draft doc ${i}`, narrative: `Draft document number ${i} for the client.`, cm_id: 1,
  }));
  assert.equal(pickPairs(pool, SEEDS, { count: 6 }).length, 6);
});

test('pickPairs drops echo pairs where the brief already equals the narrative', () => {
  const pool = [
    { brief: 'Draft Purchase and Sale Agreement.', narrative: 'Draft Purchase and Sale Agreement.', cm_id: 1 },
    { brief: 'draft psa', narrative: 'Draft Purchase and Sale Agreement.', cm_id: 1 },
  ];
  const out = pickPairs(pool, [], { count: 6 });
  assert.deepEqual(out.map((p) => p.brief), ['draft psa']);
});

test('pickPairs drops pairs missing either side', () => {
  const pool = [
    { brief: '', narrative: 'Draft Purchase and Sale Agreement.', cm_id: 1 },
    { brief: 'draft psa', narrative: '', cm_id: 1 },
  ];
  assert.deepEqual(pickPairs(pool, [], { count: 6 }), []);
});

test('pickPairs prefers pairs from the current matter', () => {
  const pool = [
    { brief: 'other matter work', narrative: 'Review unrelated agreement for another matter.', cm_id: 99 },
    { brief: 'this matter work', narrative: 'Review Cedar Lease and confer with client regarding same.', cm_id: 7 },
  ];
  const out = pickPairs(pool, [], { count: 1, cmId: 7 });
  assert.equal(out[0].cm_id, 7);
});

test('pickPairs prefers pairs whose brief shares verbs with the current brief', () => {
  const pool = [
    { brief: 'draft easement amendment', narrative: 'Draft easement amendment for the client.', cm_id: 1 },
    { brief: 'call with client re scheduling', narrative: 'Call with client regarding scheduling.', cm_id: 1 },
  ];
  const out = pickPairs(pool, [], { count: 1, brief: 'draft lease amendment' });
  assert.match(out[0].brief, /draft/);
});

test('pickPairs does not return the same pair twice', () => {
  const one = { brief: 'draft psa', narrative: 'Draft Purchase and Sale Agreement.', cm_id: 1 };
  const out = pickPairs([one, one, one], [], { count: 3 });
  assert.equal(out.length, 1);
});

// ── renderGlossary ────────────────────────────────────────────────────────

test('renderGlossary renders abbrev to phrase lines', () => {
  const out = renderGlossary([{ abbrev: 'psa', phrase: 'Purchase and Sale Agreement' }]);
  assert.match(out, /psa/);
  assert.match(out, /Purchase and Sale Agreement/);
});

test('renderGlossary returns empty string for no rows', () => {
  assert.equal(renderGlossary([]), '');
  assert.equal(renderGlossary(null), '');
});

test('renderGlossary caps the number of rows it renders', () => {
  const rows = Array.from({ length: 200 }, (_, i) => ({ abbrev: `a${i}`, phrase: `Phrase ${i}` }));
  assert.ok(renderGlossary(rows).split('\n').length <= 41);
});

// Narratives autosave 600ms after you stop typing, so a pause mid-correction
// stores half-edited text and makes it pool-eligible. The exemplar path is
// gated by isUsableExemplar; pairs must clear the same bar or a truncated
// output side would teach the model to truncate.
test('pickPairs rejects a pair whose narrative is caught mid-edit', () => {
  const pool = [
    { brief: 'rev title commitment', cm_id: 1,
      narrative: 'Review and analyze title commitment, noting exce' },
    { brief: 'rev title commitment', cm_id: 1,
      narrative: 'Review and analyze title commitment and note exceptions.' },
  ];
  const out = pickPairs(pool, [], { count: 6 });
  assert.equal(out.length, 1);
  assert.match(out[0].narrative, /note exceptions\.$/);
});

test('pickPairs rejects a pair whose narrative dangles on a connector', () => {
  const pool = [{ brief: 'emails w client', cm_id: 1,
    narrative: 'Email with client regarding;' }];
  assert.deepEqual(pickPairs(pool, [], { count: 6 }), []);
});

test('seed pairs themselves clear the exemplar quality bar', () => {
  // A seed that could not survive the gate would be teaching something the
  // pool would reject — an inconsistency worth failing the build over.
  for (const p of SEED_PAIRS_FOR_TEST) {
    assert.ok(isUsableExemplar(p.narrative), `seed not well-formed: ${p.narrative}`);
  }
});

// ── teaching-quality gate ─────────────────────────────────────────────────
// Measured 2026-08-04: three days of use put lightly-edited AI text into the
// pool (the flag clears on any edit, and a nudge counts as an edit). Median
// output went 11 -> 18 words and filler came back. A pair demonstrates what
// good OUTPUT looks like, so it has to meet the bar the eval enforces.

test('looksLikeHouseVoice rejects a purpose clause', () => {
  assert.equal(looksLikeHouseVoice(
    'Review and revise responses to ensure accuracy and completeness.'), false);
  assert.equal(looksLikeHouseVoice(
    'Transmit revised document to client for review and approval.'), false);
});

test('looksLikeHouseVoice rejects text well past the house p90', () => {
  assert.equal(looksLikeHouseVoice(`Review ${'lease '.repeat(32)}.`), false);
});

test('looksLikeHouseVoice accepts a real house-voice narrative', () => {
  assert.equal(looksLikeHouseVoice(
    'Review easement background and confer with M. Peacock regarding same.'), true);
});

test('pickPairs emits cleaned text, not raw stored narratives', () => {
  const pool = [{
    brief: '[CYS85] rev easement draft',
    narrative: '[CYS85] Review revisions to easement draft (0.4); message to M. Peacock (0.4).',
    cm_id: 1,
  }];
  const out = pickPairs(pool, [], { count: 6 });
  assert.equal(out.length, 1);
  assert.doesNotMatch(out[0].narrative, /\(0\.4\)/, 'time allocations must never be demonstrated');
  assert.doesNotMatch(out[0].narrative, /CYS85/, 'matter tags must never be demonstrated');
});

test('pickPairs drops a pair whose output reads like model filler', () => {
  const pool = [
    { brief: 'email client re next steps', cm_id: 1,
      narrative: 'Compose email to client detailing proposed course of action and key considerations for resolving title issues.' },
    { brief: 'email client re next steps', cm_id: 1,
      narrative: 'Compose email to client regarding next steps.' },
  ];
  const out = pickPairs(pool, [], { count: 6 });
  assert.equal(out.length, 1);
  assert.match(out[0].narrative, /regarding next steps\.$/);
});

test('pickPairs drops a pair David barely changed from the model draft', () => {
  const aiDraft = 'Call with client and seller representatives to discuss outstanding issues and next steps.';
  const pool = [{
    brief: 'call w client and seller reps', cm_id: 1,
    ai_draft: aiDraft,
    narrative: 'Call with client and seller representatives to discuss outstanding issues and next step.',
  }];
  assert.deepEqual(pickPairs(pool, [], { count: 6 }), [],
    'a nudge is not a correction — the text is still the model\'s');
});

test('pickPairs keeps a pair David genuinely rewrote', () => {
  const pool = [{
    brief: 'call w client and seller reps', cm_id: 1,
    ai_draft: 'Call with client and seller representatives to discuss outstanding issues and next steps.',
    narrative: 'Call with client and seller representatives regarding parking agreement.',
  }];
  assert.equal(pickPairs(pool, [], { count: 6 }).length, 1);
});

test('pickExemplars applies the same house-voice bar', () => {
  const out = pickExemplars([
    'Transmit revised lease amendment to client for review and approval today.',
    'Review easement background and confer with M. Peacock regarding same.',
  ], { count: 2 });
  assert.deepEqual(out, ['Review easement background and confer with M. Peacock regarding same.']);
});
