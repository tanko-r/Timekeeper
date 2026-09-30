import { test } from 'node:test';
import assert from 'node:assert/strict';
import { downloadParts } from '../public/js/api.js';

// 2026-09-30 feedback: "Seller’s" opened in Excel as "Sellerâ€™s". Excel reads
// a CSV with no byte-order mark as Windows-1252, so every non-ASCII character
// (curly quotes, dashes, §) turns into two or three junk characters. A UTF-8
// BOM at the start of the file makes Excel read it as UTF-8.

test('CSV downloads start with a UTF-8 byte-order mark', () => {
  const parts = downloadParts('narrative\r\nSeller’s draft\r\n', 'text/csv');
  assert.equal(parts.join(''), '﻿narrative\r\nSeller’s draft\r\n');
});

test('the BOM is not doubled when the text already has one', () => {
  assert.equal(downloadParts('﻿a,b\r\n', 'text/csv').join(''), '﻿a,b\r\n');
});

test('non-CSV downloads (.TIM, plain-text summaries) are left byte-for-byte alone', () => {
  assert.deepEqual(downloadParts('Seller’s', 'text/plain'), ['Seller’s']);
});
