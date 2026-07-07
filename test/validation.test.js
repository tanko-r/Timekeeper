import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateCmNumber, validateEntry, canFinalize } from '../server/lib/validation.js';

const SETTINGS = {
  minNarrativeChars: 20,
  bannedPhrases: ['work on', 'attention to', 'review file'],
  blockBillingHours: 3.0,
  minIncrement: 0.1,
};

function entry(overrides = {}) {
  return {
    narrative: 'Telephone conference with client regarding lease dispute.',
    tasks: [{ task_code: 'Call/Conference', duration: 0.5, fragment: '' }],
    total_override: null,
    ack_validation: 0,
    cm: { cm_number: '123456-654321' },
    ...overrides,
  };
}

const codes = (list) => list.map((v) => v.code).sort();

test('CM number format', () => {
  assert.ok(validateCmNumber('123456-654321'));
  assert.ok(!validateCmNumber('12345-654321'));
  assert.ok(!validateCmNumber('123456-65432a'));
  assert.ok(!validateCmNumber('123456654321'));
});

test('clean entry has no findings', () => {
  assert.deepEqual(validateEntry(entry(), SETTINGS), []);
});

test('empty narrative blocks, short narrative warns', () => {
  const empty = validateEntry(entry({ narrative: '  ' }), SETTINGS);
  assert.deepEqual(codes(empty), ['narrative_empty']);
  assert.equal(empty[0].level, 'block');

  const short = validateEntry(entry({ narrative: 'Reviewed docs.' }), SETTINGS);
  assert.deepEqual(codes(short), ['narrative_short']);
  assert.equal(short[0].level, 'warn');
});

test('banned vague phrases warn, case-insensitive', () => {
  const v = validateEntry(entry({ narrative: 'Work on the Smith matter throughout the day.' }), SETTINGS);
  assert.ok(codes(v).includes('banned_phrase'));
});

test('no task lines blocks', () => {
  const v = validateEntry(entry({ tasks: [] }), SETTINGS);
  assert.ok(codes(v).includes('no_task_lines'));
  assert.equal(v.find((x) => x.code === 'no_task_lines').level, 'block');
});

test('sum mismatch vs manual total warns', () => {
  const v = validateEntry(entry({ total_override: 1.0 }), SETTINGS); // sum is 0.5
  assert.ok(codes(v).includes('sum_mismatch'));
  assert.deepEqual(codes(validateEntry(entry({ total_override: 0.5 }), SETTINGS)), []);
});

test('block billing: single line over threshold warns; broken-down does not', () => {
  const big = entry({
    narrative: 'Draft and revise motion for summary judgment and supporting papers.',
    tasks: [{ task_code: 'Draft', duration: 3.5, fragment: '' }],
  });
  assert.ok(codes(validateEntry(big, SETTINGS)).includes('block_billing'));

  const broken = entry({
    narrative: 'Draft motion for summary judgment; review record cites for accuracy.',
    tasks: [
      { task_code: 'Draft', duration: 3.5, fragment: 'Draft motion for summary judgment' },
      { task_code: 'Review', duration: 0.5, fragment: 'review record cites' },
    ],
  });
  assert.ok(!codes(validateEntry(broken, SETTINGS)).includes('block_billing'));
});

test('durations under minimum increment warn', () => {
  const v = validateEntry(entry({
    tasks: [{ task_code: 'Review', duration: 0.05, fragment: '' }],
  }), SETTINGS);
  assert.ok(codes(v).includes('min_increment'));
});

test('invalid CM blocks finalize', () => {
  const e = entry({ cm: { cm_number: 'bogus' } });
  const r = canFinalize(e, SETTINGS);
  assert.equal(r.ok, false);
  assert.ok(r.blocks.some((b) => b.code === 'invalid_cm'));
});

test('warnings gate finalize until acknowledged', () => {
  const warned = entry({ narrative: 'Reviewed docs.' }); // short → warn
  const r1 = canFinalize(warned, SETTINGS);
  assert.equal(r1.ok, false);
  assert.equal(r1.blocks.length, 0);
  assert.ok(r1.warns.length > 0);

  const r2 = canFinalize({ ...warned, ack_validation: 1 }, SETTINGS);
  assert.equal(r2.ok, true);
});

test('clean entry finalizes without ack', () => {
  const r = canFinalize(entry(), SETTINGS);
  assert.equal(r.ok, true);
});
