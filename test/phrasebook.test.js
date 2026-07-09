import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePhrase, rankPhrases } from '../server/lib/phrasebook.js';

test('normalizePhrase trims, collapses whitespace, strips trailing punctuation', () => {
  assert.equal(normalizePhrase('  revise   lease.  '), 'revise lease');
  assert.equal(normalizePhrase('draft email to landlord;'), 'draft email to landlord');
  assert.equal(normalizePhrase(null), '');
});

test('frequency wins between same-age phrases', () => {
  const out = rankPhrases([
    { text: 'revise lease', date: '2026-07-07' },
    { text: 'revise lease', date: '2026-07-06' },
    { text: 'draft access agreement', date: '2026-07-07' },
  ], { today: '2026-07-08' });
  assert.deepEqual(out.map((p) => p.text), ['revise lease', 'draft access agreement']);
  assert.equal(out[0].count, 2);
  assert.equal(out[0].last_used, '2026-07-07');
  assert.equal(out[0].source, 'matter');
  assert.ok(out[0].score > out[1].score);
});

test('recency beats a slightly higher stale count', () => {
  const out = rankPhrases([
    { text: 'old workhorse', date: '2025-01-01' },
    { text: 'old workhorse', date: '2025-01-02' },
    { text: 'old workhorse', date: '2025-01-03' },
    { text: 'fresh phrase', date: '2026-07-07' },
    { text: 'fresh phrase', date: '2026-07-06' },
  ], { today: '2026-07-08' });
  // three ~18-month-old uses decay to ~0; two this-week uses win
  assert.equal(out[0].text, 'fresh phrase');
});

test('same phrase on the same day counts once', () => {
  const out = rankPhrases([
    { text: 'revise lease', date: '2026-07-07' },
    { text: 'Revise lease.', date: '2026-07-07' },
  ], { today: '2026-07-08' });
  assert.equal(out.length, 1);
  assert.equal(out[0].count, 1);
});

test('case-insensitive grouping keeps the most recent casing', () => {
  const out = rankPhrases([
    { text: 'telephone conference with client', date: '2026-07-01' },
    { text: 'Telephone conference with client', date: '2026-07-07' },
  ], { today: '2026-07-08' });
  assert.equal(out.length, 1);
  assert.equal(out[0].text, 'Telephone conference with client');
  assert.equal(out[0].count, 2);
});

test('client-borrowed occurrences weigh less and are flagged', () => {
  const out = rankPhrases([
    { text: 'sibling phrase', date: '2026-07-07', source: 'client' },
    { text: 'own phrase', date: '2026-07-07', source: 'matter' },
  ], { today: '2026-07-08' });
  assert.equal(out[0].text, 'own phrase'); // weight 1.0 beats 0.25
  assert.equal(out[0].source, 'matter');
  assert.equal(out[1].source, 'client');
  assert.ok(out[1].score < out[0].score);
});

test('short scraps filtered, default limit 15, empty input ok', () => {
  const many = [];
  for (let i = 0; i < 20; i++) many.push({ text: `phrase number ${i}`, date: '2026-07-07' });
  const out = rankPhrases(many.concat([{ text: 'ok', date: '2026-07-07' }]),
    { today: '2026-07-08' });
  assert.equal(out.length, 15);
  assert.ok(!out.some((p) => p.text === 'ok')); // length 2 < minLength 3
  assert.deepEqual(rankPhrases([], { today: '2026-07-08' }), []);
});
