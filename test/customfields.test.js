import test from 'node:test';
import assert from 'node:assert/strict';
import { effectiveFields, validateFieldValues, parseOptions } from '../server/lib/customfields.js';

const f = (over) => ({
  id: 1, client_id: 10, matter_id: null, name: 'Phase', type: 'text',
  options: '[]', pattern: null, pattern_hint: null, required: 0, active: 1, sort_order: 0,
  ...over,
});

test('effectiveFields: client fields first, matter overrides same name case-insensitively', () => {
  const client = [f({ id: 1, name: 'Phase', sort_order: 1 }), f({ id: 2, name: 'Task', sort_order: 0 })];
  const matter = [f({ id: 3, client_id: null, matter_id: 20, name: 'phase', sort_order: 0 })];
  const out = effectiveFields(client, matter);
  assert.deepEqual(out.map((x) => x.id), [2, 3]); // Task (client), phase (matter override)
});

test('effectiveFields: empty inputs', () => {
  assert.deepEqual(effectiveFields([], []), []);
  assert.equal(effectiveFields([f()], []).length, 1);
});

test('validateFieldValues: required + empty blocks; filled passes', () => {
  const fields = [f({ id: 1, required: 1 })];
  assert.deepEqual(validateFieldValues(fields, {}).map((x) => [x.level, x.code]),
    [['block', 'custom_required']]);
  assert.deepEqual(validateFieldValues(fields, { 1: '  ' }).map((x) => x.code), ['custom_required']);
  assert.deepEqual(validateFieldValues(fields, { 1: 'P100' }), []);
});

test('validateFieldValues: pattern mismatch warns, match passes, bad regex ignored', () => {
  const fields = [f({ id: 1, pattern: 'P\\d{3}', pattern_hint: 'P###' })];
  const warn = validateFieldValues(fields, { 1: 'X9' });
  assert.equal(warn[0].level, 'warn');
  assert.equal(warn[0].code, 'custom_format');
  assert.match(warn[0].message, /P###/);
  assert.deepEqual(validateFieldValues(fields, { 1: 'P123' }), []);
  assert.deepEqual(validateFieldValues([f({ id: 1, pattern: '(' })], { 1: 'anything' }), []);
});

test('validateFieldValues: select value must be an option; empty non-required is fine', () => {
  const fields = [f({ id: 1, type: 'select', options: '["P100","P200"]' })];
  assert.deepEqual(validateFieldValues(fields, { 1: 'P300' }).map((x) => x.code), ['custom_option']);
  assert.deepEqual(validateFieldValues(fields, { 1: 'P100' }), []);
  assert.deepEqual(validateFieldValues(fields, {}), []);
});

test('parseOptions: JSON text or already-parsed array in, junk out safely', () => {
  assert.deepEqual(parseOptions('["a","b"]'), ['a', 'b']);
  assert.deepEqual(parseOptions(['a', 'b']), ['a', 'b']); // enrich() hands routes' pre-parsed arrays through
  assert.deepEqual(parseOptions('not json'), []);
  assert.deepEqual(parseOptions(''), []);
  assert.deepEqual(parseOptions('{"a":1}'), []);
});

test('validateFieldValues works when options arrive pre-parsed (enrich path)', () => {
  const fields = [f({ id: 1, type: 'select', options: ['P100', 'P200'] })];
  assert.deepEqual(validateFieldValues(fields, { 1: 'P300' }).map((x) => x.code), ['custom_option']);
  assert.deepEqual(validateFieldValues(fields, { 1: 'P100' }), []);
});
