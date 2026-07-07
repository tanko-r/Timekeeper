import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toCsv } from '../server/lib/csv.js';

test('plain values joined with CRLF', () => {
  assert.equal(toCsv(['a', 'b'], [[1, 'x']]), 'a,b\r\n1,x\r\n');
});

test('quotes fields containing commas, quotes, newlines', () => {
  const out = toCsv(['n'], [['he said "hi", twice\nok']]);
  assert.equal(out, 'n\r\n"he said ""hi"", twice\nok"\r\n');
});

test('defangs leading formula characters for spreadsheet safety', () => {
  const out = toCsv(['n'], [['=SUM(A1)'], ['+1'], ['@cmd'], ['-2 review']]);
  assert.equal(out, "n\r\n'=SUM(A1)\r\n'+1\r\n'@cmd\r\n'-2 review\r\n");
});

test('null and undefined render empty; numbers unquoted', () => {
  assert.equal(toCsv(['a', 'b', 'c'], [[null, undefined, 1.5]]), 'a,b,c\r\n,,1.5\r\n');
});
