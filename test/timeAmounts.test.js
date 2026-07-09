import { test } from 'node:test';
import assert from 'node:assert/strict';
import { containsTimeAmounts as serverCheck } from '../server/lib/timeAmounts.js';
import { containsTimeAmounts as clientCheck } from '../public/js/lib/timeamounts.js';

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
