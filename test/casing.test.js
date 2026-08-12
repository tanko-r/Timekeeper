import { test } from 'node:test';
import assert from 'node:assert/strict';
import { restoreSourceCasing } from '../server/lib/casing.js';

// 2026-08-11 feedback: "Expand → split into tasks … makes all uppercase words
// lowercase." Reproduced against llama3.1:8b — handed the finished narrative
// "Review message from E. Hodgson (0.1); draft revisions to Second Amendment
// to Option Agreement (0.7); …" it returned fragments case-folded to
// "review message from e hodgson", "draft revisions to second amendment to
// option agreement". The format contract tells it to start a fragment
// lowercase and an 8B model applies that to the whole clause. This restores
// the attorney's own capitalisation deterministically, after the model.

test('restoreSourceCasing: restores proper nouns the model case-folded', () => {
  const src = 'Review message from E. Hodgson (0.1); draft revisions to Second Amendment to Option Agreement (0.7).';
  assert.equal(
    restoreSourceCasing('draft revisions to second amendment to option agreement', src),
    'draft revisions to Second Amendment to Option Agreement');
});

test('restoreSourceCasing: rebuilds an initial with its period', () => {
  const src = 'Review message from E. Hodgson (0.1); email to E. Hodgson (0.1).';
  assert.equal(restoreSourceCasing('review message from e hodgson', src),
    'review message from E. Hodgson');
});

test('restoreSourceCasing: never capitalises the first word', () => {
  // Fragments start lowercase by contract — generateNarrative capitalises the
  // leading clause when it builds the narrative.
  const src = 'Draft amendment to Memorandum.';
  assert.equal(restoreSourceCasing('draft amendment to memorandum', src),
    'draft amendment to Memorandum');
});

test('restoreSourceCasing: leaves a word the source never capitalised', () => {
  const src = 'Review message from E. Hodgson; draft updates to easement template.';
  assert.equal(restoreSourceCasing('draft updates to easement template', src),
    'draft updates to easement template');
});

test('restoreSourceCasing: ignores a word capitalised only by sentence position', () => {
  // "Review" leads the source, so its capital says nothing about the word.
  const src = 'Review message from E. Hodgson. Draft revisions and review again.';
  assert.equal(restoreSourceCasing('email client and review file', src),
    'email client and review file');
});

test('restoreSourceCasing: skips a word the source spells both ways', () => {
  const src = 'Draft revisions to Lease; review the lease exhibits.';
  assert.equal(restoreSourceCasing('review the lease exhibits', src),
    'review the lease exhibits');
});

test('restoreSourceCasing: keeps punctuation the model wrote around a word', () => {
  const src = 'Confer with J. Larson regarding Purchase and Sale Agreement.';
  assert.equal(restoreSourceCasing('confer with j larson, then review the purchase and sale agreement', src),
    'confer with J. Larson, then review the Purchase and Sale Agreement');
});

test('restoreSourceCasing: does not append a sentence period to a restored word', () => {
  const src = 'Draft amendment to Memorandum. Email client regarding same.';
  assert.equal(restoreSourceCasing('draft amendment to memorandum and email client', src),
    'draft amendment to Memorandum and email client');
});

test('restoreSourceCasing: an all-caps acronym comes back in full caps', () => {
  const src = 'Review NDA and draft revisions to LOI.';
  assert.equal(restoreSourceCasing('review nda and draft revisions to loi', src),
    'review NDA and draft revisions to LOI');
});

test('restoreSourceCasing: the first word is left alone even when the source caps it', () => {
  const src = 'Draft revisions to LOI and review NDA.';
  assert.equal(restoreSourceCasing('loi revisions drafted and nda reviewed', src),
    'loi revisions drafted and NDA reviewed');
});

test('restoreSourceCasing: leaves text the model already got right', () => {
  const src = 'Draft revisions to Second Amendment to Option Agreement.';
  const frag = 'draft revisions to Second Amendment to Option Agreement';
  assert.equal(restoreSourceCasing(frag, src), frag);
});

test('restoreSourceCasing: empty and missing inputs are safe', () => {
  assert.equal(restoreSourceCasing('', 'Something Here'), '');
  assert.equal(restoreSourceCasing('draft the lease', ''), 'draft the lease');
  assert.equal(restoreSourceCasing(null, null), '');
});
