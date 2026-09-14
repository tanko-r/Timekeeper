import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractCmDigits } from '../public/js/lib/cmparse.js';

// The quick-add matter field accepts a paste of almost anything — a bare
// CM#, or a whole paragraph with the CM# buried in it (2026-09-14 feedback).
// It must find exactly one 6-digit client number + 6-digit matter number and
// never let stray digits elsewhere in the text (dates, ZIP codes, a longer
// account number) leak into the result.
const FIXTURES = [
  // [text, expected, why]
  ['100004-000012', { clientNumber: '100004', matterNumber: '000012' }, 'hyphen-separated'],
  ['100004 000012', { clientNumber: '100004', matterNumber: '000012' }, 'space-separated'],
  ['100004.000012', { clientNumber: '100004', matterNumber: '000012' }, 'period-separated'],
  ['100004000012', { clientNumber: '100004', matterNumber: '000012' }, 'no separator, adjacent digits'],
  ['Please open CM 100004-000012 for the Q3 review by Friday.',
    { clientNumber: '100004', matterNumber: '000012' }, 'embedded in a sentence'],
  [`Hi David,\n\nCan you start billing 100004-000012 right away? We need\nthis moving before the 10/15 deadline. Thanks.`,
    { clientNumber: '100004', matterNumber: '000012' }, 'embedded in a lengthy paragraph with an unrelated date'],
  ['Invoice #55512345670 covers unrelated work.', null, '11-digit run is not a valid CM# and must not be sliced'],
  ['My zip is 941051234 and the case is 100004-000012.',
    { clientNumber: '100004', matterNumber: '000012' }, 'a longer stray digit run earlier in the text is skipped'],
  ['12345-678901', null, 'only 5 digits before the separator — not a match'],
  ['', null, 'empty'],
  [null, null, 'null'],
  [undefined, null, 'undefined'],
];

test('extractCmDigits: fixture table', () => {
  for (const [text, expected, why] of FIXTURES) {
    assert.deepEqual(extractCmDigits(text), expected, `${why}: ${JSON.stringify(text)}`);
  }
});
