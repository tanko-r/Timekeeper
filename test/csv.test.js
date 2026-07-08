import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toCsv, parseCsv } from '../server/lib/csv.js';

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

test('parseCsv splits simple rows and cells', () => {
  assert.deepEqual(parseCsv('a,b,c\r\n1,2,3\r\n'), [['a', 'b', 'c'], ['1', '2', '3']]);
});

test('parseCsv handles LF, CRLF, and a missing trailing newline', () => {
  assert.deepEqual(parseCsv('a,b\n1,2'), [['a', 'b'], ['1', '2']]);
  assert.deepEqual(parseCsv('a,b\r\n1,2\r\n'), [['a', 'b'], ['1', '2']]);
});

test('parseCsv preserves quoted commas, newlines, and doubled quotes', () => {
  const rows = parseCsv('cm,name\r\n123,"Acme, Inc."\r\n456,"line1\nline2"\r\n789,"say ""hi"""\r\n');
  assert.deepEqual(rows, [
    ['cm', 'name'],
    ['123', 'Acme, Inc.'],
    ['456', 'line1\nline2'],
    ['789', 'say "hi"'],
  ]);
});

test('parseCsv keeps trailing empty fields but skips fully blank lines', () => {
  assert.deepEqual(parseCsv('a,b,\r\n\r\nx,y,z\r\n'), [['a', 'b', ''], ['x', 'y', 'z']]);
});

test('parseCsv on empty input yields no rows', () => {
  assert.deepEqual(parseCsv(''), []);
  assert.deepEqual(parseCsv('\r\n\r\n'), []);
});
