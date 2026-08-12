import { test } from 'node:test';
import assert from 'node:assert/strict';
import { containsTimeAmounts as serverCheck, stripTimeAmounts as serverStrip } from '../server/lib/timeAmounts.js';
import { containsTimeAmounts as clientCheck, stripTimeAmounts as clientStrip } from '../public/js/lib/timeamounts.js';

// ONE fixture table run against BOTH copies of the detector — the browser
// mirror (public/js/lib/timeamounts.js) cannot import server code, so this
// test is what keeps the two files from drifting: edit one without the
// other and the divergent case fails here.
//
// Design intent: this is an attorney billing app. Task-billing amounts are
// always decimals ("(0.5)", "1.5 hrs", "0.3 h"), while citation subsections
// ("12(b)(6)", "1542(3)") and dimension-style integers ("8h x 10w") are
// everyday narrative text that must never be flagged.
const FIXTURES = [
  // [text, expected, why]
  ['Reviewed lease (0.5); drafted amendment (1.2).', true, 'decimal task-billing parentheticals'],
  ['Analyze development agreement (0.2); draft revised agreement (0.5).', true, 'the live-DB shape that started this'],
  ['(1.0)', true, 'decimal parenthetical, whole hour'],
  ['Billed 2 hours for the review.', true, 'integer + "hours" is unambiguously a duration'],
  ['Spent 1.5 hrs drafting the motion.', true, 'decimal + "hrs"'],
  ['Recorded 0.3 h against the matter.', true, 'decimal + bare "h"'],

  ['Moved for summary judgment under Fed. R. Civ. P. 12(b)(6).', false, 'citation subsection'],
  ['Analyzed waiver of Civil Code 1542(3) claims.', false, 'citation subsection'],
  ['Drafted opposition citing Rule 56(c)(2).', false, 'citation subsection'],
  ['Reviewed invoice for the 8h x 10w frame.', false, 'integer + bare "h" is a dimension, not a duration'],
  ['Negotiated the 2026 lease renewal with the county.', false, 'a year is not an amount'],
  ['Reviewed Section 8 housing regulations with opposing counsel.', false, 'a section number is not an amount'],
  ['Reviewed and revised lease legal description; correspondence with counsel.', false, 'plain prose'],
  ['', false, 'empty'],
  [null, false, 'null'],
];

for (const [label, check] of [['server helper', serverCheck], ['client mirror', clientCheck]]) {
  test(`containsTimeAmounts (${label}): fixture table`, () => {
    for (const [text, expected, why] of FIXTURES) {
      assert.equal(check(text), expected, `${why}: ${JSON.stringify(text)}`);
    }
  });
}

// stripTimeAmounts — the removal half of the same rule. "Expand → split into
// tasks" seeds the model with whatever the narrative box shows, and an AUTO
// narrative shows every task-billing parenthetical. Those amounts are the
// app's bookkeeping, not a description of the work, so they come out before
// the brief reaches the model. Same fixture-table discipline: one table, both
// copies, so the browser mirror cannot drift.
const STRIP_FIXTURES = [
  // [text, expected, why]
  ['Reviewed lease (0.5); drafted amendment (1.2).',
    'Reviewed lease; drafted amendment.', 'parentheticals leave no gap before the punctuation'],
  ['Review message from E. Hodgson (0.1); email to E. Hodgson (0.1).',
    'Review message from E. Hodgson; email to E. Hodgson.', 'the reported AUTO-narrative shape'],
  ['Drafted the motion in 1.5 hrs and filed it.',
    'Drafted the motion in and filed it.', 'a worded amount is removed with its surrounding space'],
  ['Moved for summary judgment under Fed. R. Civ. P. 12(b)(6).',
    'Moved for summary judgment under Fed. R. Civ. P. 12(b)(6).', 'citation subsections are untouched'],
  ['Reviewed invoice for the 8h x 10w frame.',
    'Reviewed invoice for the 8h x 10w frame.', 'a dimension is not a duration'],
  ['Review and revise lease.', 'Review and revise lease.', 'plain prose is returned unchanged'],
  ['', '', 'empty'],
  [null, '', 'null'],
];

for (const [label, strip] of [['server helper', serverStrip], ['client mirror', clientStrip]]) {
  test(`stripTimeAmounts (${label}): fixture table`, () => {
    for (const [text, expected, why] of STRIP_FIXTURES) {
      assert.equal(strip(text), expected, `${why}: ${JSON.stringify(text)}`);
    }
  });

  test(`stripTimeAmounts (${label}): output never trips the detector`, () => {
    for (const [text] of FIXTURES) {
      assert.equal(serverCheck(strip(text)), false, `still flagged: ${JSON.stringify(text)}`);
    }
  });
}
