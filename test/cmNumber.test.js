import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCmNumber, splitCmNumber, SIX } from '../server/lib/cmNumber.js';

test('buildCmNumber joins client and matter with a hyphen', () => {
  assert.equal(buildCmNumber('100001', '000012'), '100001-000012');
});

test('splitCmNumber parses a valid CM number', () => {
  assert.deepEqual(splitCmNumber('100001-000012'), { clientNumber: '100001', matterNumber: '000012' });
});

test('splitCmNumber returns null for malformed input', () => {
  assert.equal(splitCmNumber('123-456'), null);
  assert.equal(splitCmNumber('abcdef-000012'), null);
  assert.equal(splitCmNumber('1045330-00012'), null);
  assert.equal(splitCmNumber(''), null);
  assert.equal(splitCmNumber(null), null);
});

test('round-trips', () => {
  const cm = '222222-000001';
  const { clientNumber, matterNumber } = splitCmNumber(cm);
  assert.equal(buildCmNumber(clientNumber, matterNumber), cm);
});

test('SIX matches exactly six digits', () => {
  assert.ok(SIX.test('000000'));
  assert.ok(!SIX.test('00000'));
  assert.ok(!SIX.test('0000000'));
  assert.ok(!SIX.test('12345a'));
});
