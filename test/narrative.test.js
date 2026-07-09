import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildNarrative, durationLabel } from '../server/lib/narrative.js';

const INC = { increment: 0.1 };

test('spec example formats exactly', () => {
  const lines = [
    { fragment: 'Review lease', taskCode: 'Review', duration: 1.2 },
    { fragment: 'draft email to landlord', taskCode: 'Draft', duration: 0.3 },
    { fragment: 'telephone conference with client', taskCode: 'Call/Conference', duration: 0.4 },
  ];
  assert.equal(
    buildNarrative(lines, INC),
    'Review lease (1.2); draft email to landlord (0.3); telephone conference with client (0.4).'
  );
});

test('single or zero lines produce null (free-text narrative retained)', () => {
  assert.equal(buildNarrative([], INC), null);
  assert.equal(buildNarrative([{ fragment: 'Review lease', taskCode: 'Review', duration: 1.2 }], INC), null);
});

test('first fragment is capitalized, others preserved as typed', () => {
  const lines = [
    { fragment: 'review lease', taskCode: 'Review', duration: 1.0 },
    { fragment: 'Draft memo', taskCode: 'Draft', duration: 0.5 },
  ];
  assert.equal(buildNarrative(lines, INC), 'Review lease (1.0); Draft memo (0.5).');
});

test('trailing punctuation on fragments is normalized', () => {
  const lines = [
    { fragment: 'Review lease.', taskCode: 'Review', duration: 1.0 },
    { fragment: 'draft memo; ', taskCode: 'Draft', duration: 0.5 },
  ];
  assert.equal(buildNarrative(lines, INC), 'Review lease (1.0); draft memo (0.5).');
});

test('empty fragment falls back to task code', () => {
  const lines = [
    { fragment: '', taskCode: 'Research', duration: 0.8 },
    { fragment: 'draft brief', taskCode: 'Draft', duration: 2.1 },
  ];
  assert.equal(buildNarrative(lines, INC), 'Research (0.8); draft brief (2.1).');
});

test('completely empty lines are skipped', () => {
  const lines = [
    { fragment: 'Review lease', taskCode: 'Review', duration: 1.0 },
    { fragment: '', taskCode: '', duration: 0 },
    { fragment: 'draft memo', taskCode: 'Draft', duration: 0.5 },
  ];
  assert.equal(buildNarrative(lines, INC), 'Review lease (1.0); draft memo (0.5).');
});

test('skipping empties can drop below two lines -> null', () => {
  const lines = [
    { fragment: 'Review lease', taskCode: 'Review', duration: 1.0 },
    { fragment: '', taskCode: '', duration: 0 },
  ];
  assert.equal(buildNarrative(lines, INC), null);
});

test('block billing (taskBilling: false): fragments joined without parenthetical allocations', () => {
  const lines = [
    { fragment: 'Review lease', taskCode: 'Review', duration: 1.2 },
    { fragment: 'draft email to landlord', taskCode: 'Draft', duration: 0.3 },
  ];
  assert.equal(
    buildNarrative(lines, { increment: 0.1, taskBilling: false }),
    'Review lease; draft email to landlord.'
  );
});

test('block billing: first fragment capitalized, empty fragment falls back to task code, trailing punctuation normalized', () => {
  const lines = [
    { fragment: '', taskCode: 'research', duration: 0.8 },
    { fragment: 'draft brief.', taskCode: 'Draft', duration: 2.1 },
  ];
  assert.equal(
    buildNarrative(lines, { increment: 0.1, taskBilling: false }),
    'Research; draft brief.'
  );
});

test('block billing: same ≥2-substantive-lines rule — single line still returns null', () => {
  assert.equal(
    buildNarrative([{ fragment: 'Review lease', taskCode: 'Review', duration: 1.2 }], { taskBilling: false }),
    null
  );
});

test('taskBilling defaults to true (today\'s behavior) when omitted', () => {
  const lines = [
    { fragment: 'Review lease', taskCode: 'Review', duration: 1.0 },
    { fragment: 'Draft memo', taskCode: 'Draft', duration: 0.5 },
  ];
  assert.equal(buildNarrative(lines, { increment: 0.1 }), 'Review lease (1.0); Draft memo (0.5).');
});

test('duration label precision follows increment', () => {
  assert.equal(durationLabel(1.2, 0.1), '1.2');
  assert.equal(durationLabel(2, 0.1), '2.0');
  assert.equal(durationLabel(1.25, 0.25), '1.25');
  assert.equal(durationLabel(1.5, 0.25), '1.50');
  assert.equal(durationLabel(0.3, undefined), '0.3'); // default 0.1-style
});
