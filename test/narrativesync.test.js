import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateNarrative, parseNarrativeEdit, rebalanceHours, formatSuggestion,
} from '../public/js/lib/narrativesync.js';

// ---------- generateNarrative (client mirror of server/lib/narrative.js) ----------

test('generateNarrative: spec example formats exactly (task-billed, default)', () => {
  const lines = [
    { fragment: 'Review lease', task_code: 'Review', duration: 1.2 },
    { fragment: 'draft email to landlord', task_code: 'Draft', duration: 0.3 },
    { fragment: 'telephone conference with client', task_code: 'Call/Conference', duration: 0.4 },
  ];
  assert.equal(
    generateNarrative(lines, { increment: 0.1 }),
    'Review lease (1.2); draft email to landlord (0.3); telephone conference with client (0.4).',
  );
});

test('generateNarrative: single or zero lines produce null', () => {
  assert.equal(generateNarrative([], { increment: 0.1 }), null);
  assert.equal(
    generateNarrative([{ fragment: 'Review lease', task_code: 'Review', duration: 1.2 }], { increment: 0.1 }),
    null,
  );
});

test('generateNarrative: first fragment capitalized, others preserved as typed', () => {
  const lines = [
    { fragment: 'review lease', task_code: 'Review', duration: 1.0 },
    { fragment: 'Draft memo', task_code: 'Draft', duration: 0.5 },
  ];
  assert.equal(generateNarrative(lines, { increment: 0.1 }), 'Review lease (1.0); Draft memo (0.5).');
});

test('generateNarrative: trailing punctuation on fragments is normalized', () => {
  const lines = [
    { fragment: 'Review lease.', task_code: 'Review', duration: 1.0 },
    { fragment: 'draft memo; ', task_code: 'Draft', duration: 0.5 },
  ];
  assert.equal(generateNarrative(lines, { increment: 0.1 }), 'Review lease (1.0); draft memo (0.5).');
});

test('generateNarrative: empty fragment falls back to task code', () => {
  const lines = [
    { fragment: '', task_code: 'Research', duration: 0.8 },
    { fragment: 'draft brief', task_code: 'Draft', duration: 2.1 },
  ];
  assert.equal(generateNarrative(lines, { increment: 0.1 }), 'Research (0.8); draft brief (2.1).');
});

test('generateNarrative: completely empty lines are skipped, and can drop below 2 -> null', () => {
  const lines = [
    { fragment: 'Review lease', task_code: 'Review', duration: 1.0 },
    { fragment: '', task_code: '', duration: 0 },
    { fragment: 'draft memo', task_code: 'Draft', duration: 0.5 },
  ];
  assert.equal(generateNarrative(lines, { increment: 0.1 }), 'Review lease (1.0); draft memo (0.5).');
  assert.equal(
    generateNarrative(lines.slice(0, 2), { increment: 0.1 }),
    null,
  );
});

test('generateNarrative: block billing (taskBilling: false) joins fragments without allocations', () => {
  const lines = [
    { fragment: 'Review lease', task_code: 'Review', duration: 1.2 },
    { fragment: 'draft email to landlord', task_code: 'Draft', duration: 0.3 },
  ];
  assert.equal(
    generateNarrative(lines, { increment: 0.1, taskBilling: false }),
    'Review lease; draft email to landlord.',
  );
});

test('generateNarrative: block billing still capitalizes first fragment and falls back to task code', () => {
  const lines = [
    { fragment: '', task_code: 'research', duration: 0.8 },
    { fragment: 'draft brief.', task_code: 'Draft', duration: 2.1 },
  ];
  assert.equal(
    generateNarrative(lines, { increment: 0.1, taskBilling: false }),
    'Research; draft brief.',
  );
});

test('generateNarrative: taskBilling defaults to true when omitted', () => {
  const lines = [
    { fragment: 'Review lease', task_code: 'Review', duration: 1.0 },
    { fragment: 'Draft memo', task_code: 'Draft', duration: 0.5 },
  ];
  assert.equal(generateNarrative(lines), 'Review lease (1.0); Draft memo (0.5).');
});

// ---------- hours-formatting drift guard ----------
// narrativesync.js copies ui.js's fmtHours formula (it cannot import it — zero
// imports is a hard rule). This fixture table pins the exact formula's output
// so a future edit to either copy trips a test instead of silently drifting.

const HOURS_FIXTURES = [
  { hours: 1.2, increment: 0.1, expected: '1.2' },
  { hours: 2, increment: 0.1, expected: '2.0' },
  { hours: 0.3, increment: 0.1, expected: '0.3' },
  { hours: 0, increment: 0.1, expected: '0.0' },
  { hours: 3.333, increment: 0.1, expected: '3.3' },
  { hours: 1.25, increment: 0.25, expected: '1.25' },
  { hours: 1.5, increment: 0.25, expected: '1.50' },
  { hours: 0.05, increment: 0.05, expected: '0.05' },
  { hours: 1, increment: 1, expected: '1.0' },
];

test('generateNarrative: duration formatting matches ui.js fmtHours fixture table', () => {
  for (const { hours, increment, expected } of HOURS_FIXTURES) {
    const out = generateNarrative(
      [{ fragment: 'Alpha', duration: hours }, { fragment: 'Beta', duration: 0.4 }],
      { increment },
    );
    assert.ok(
      out.includes(`(${expected})`),
      `expected "(${expected})" in "${out}" for hours=${hours} increment=${increment}`,
    );
  }
});

// ---------- parseNarrativeEdit ----------

test('parseNarrativeEdit: round-trips generateNarrative output (task-billed)', () => {
  const lines = [
    { fragment: 'Review lease', task_code: 'Review', duration: 1.2 },
    { fragment: 'draft email to landlord', task_code: 'Draft', duration: 0.3 },
  ];
  const text = generateNarrative(lines, { increment: 0.1 });
  assert.deepEqual(parseNarrativeEdit(text, 2, { taskBilling: true }), {
    segments: [
      { fragment: 'Review lease', duration: 1.2 },
      { fragment: 'draft email to landlord', duration: 0.3 },
    ],
  });
});

test('parseNarrativeEdit: round-trips generateNarrative output (block billing)', () => {
  const lines = [
    { fragment: 'Review lease', task_code: 'Review', duration: 1.2 },
    { fragment: 'draft email to landlord', task_code: 'Draft', duration: 0.3 },
  ];
  const text = generateNarrative(lines, { increment: 0.1, taskBilling: false });
  assert.deepEqual(parseNarrativeEdit(text, 2, { taskBilling: false }), {
    segments: [
      { fragment: 'Review lease', duration: null },
      { fragment: 'draft email to landlord', duration: null },
    ],
  });
});

test('parseNarrativeEdit: editing one fragment leaves the other segment and both durations intact', () => {
  const text = 'Review the lease agreement (1.2); draft email to landlord (0.3).';
  assert.deepEqual(parseNarrativeEdit(text, 2, { taskBilling: true }), {
    segments: [
      { fragment: 'Review the lease agreement', duration: 1.2 },
      { fragment: 'draft email to landlord', duration: 0.3 },
    ],
  });
});

test('parseNarrativeEdit: editing one duration leaves fragments and the other duration intact', () => {
  const text = 'Review lease (1.5); draft email to landlord (0.3).';
  assert.deepEqual(parseNarrativeEdit(text, 2, { taskBilling: true }), {
    segments: [
      { fragment: 'Review lease', duration: 1.5 },
      { fragment: 'draft email to landlord', duration: 0.3 },
    ],
  });
});

test('parseNarrativeEdit: a fragment may legitimately contain parentheses as long as a trailing (num) still terminates it', () => {
  const text = 'Review lease (see § 4(b)) (1.2); draft email to landlord (0.3).';
  assert.deepEqual(parseNarrativeEdit(text, 2, { taskBilling: true }), {
    segments: [
      { fragment: 'Review lease (see § 4(b))', duration: 1.2 },
      { fragment: 'draft email to landlord', duration: 0.3 },
    ],
  });
});

test('parseNarrativeEdit: structural break — a deleted paren returns null', () => {
  const text = 'Review lease 1.2; draft email to landlord (0.3).';
  assert.equal(parseNarrativeEdit(text, 2, { taskBilling: true }), null);
});

test('parseNarrativeEdit: structural break — merged segments (missing semicolon) returns null', () => {
  const text = 'Review lease (1.2) draft email to landlord (0.3).';
  assert.equal(parseNarrativeEdit(text, 2, { taskBilling: true }), null);
});

test('parseNarrativeEdit: structural break — an added segment returns null', () => {
  const text = 'Review lease (1.2); Extra thing (0.1); draft email to landlord (0.3).';
  assert.equal(parseNarrativeEdit(text, 2, { taskBilling: true }), null);
});

test('parseNarrativeEdit: structural break — empty fragment text returns null', () => {
  const text = '(1.2); draft email to landlord (0.3).';
  assert.equal(parseNarrativeEdit(text, 2, { taskBilling: true }), null);
});

test('parseNarrativeEdit: block-mode fragment count mismatch (user typed a semicolon inside a fragment) returns null', () => {
  const text = 'Review lease; sub-point; draft email to landlord.';
  assert.equal(parseNarrativeEdit(text, 2, { taskBilling: false }), null);
});

test('parseNarrativeEdit: block-mode empty segment returns null', () => {
  const text = 'Review lease; ; draft memo.';
  assert.equal(parseNarrativeEdit(text, 3, { taskBilling: false }), null);
});

test('parseNarrativeEdit: tolerates a missing trailing period', () => {
  const text = 'Review lease (1.2); draft email to landlord (0.3)';
  assert.deepEqual(parseNarrativeEdit(text, 2, { taskBilling: true }), {
    segments: [
      { fragment: 'Review lease', duration: 1.2 },
      { fragment: 'draft email to landlord', duration: 0.3 },
    ],
  });
});

test('parseNarrativeEdit: a fragment\'s own inner parens can still fool the last-paren anchor into a bad split', () => {
  // "Foo (bar (1.2))" has no trailing "(<fragment>) (<num>)" shape for a
  // single segment — the last paren closes the OUTER group, not a bare
  // number — so this must fail closed (null), not silently misparse.
  assert.equal(parseNarrativeEdit('Foo (bar (1.2))', 1, { taskBilling: true }), null);
});

test('parseNarrativeEdit: empty/blank text returns null', () => {
  assert.equal(parseNarrativeEdit('', 2, { taskBilling: true }), null);
  assert.equal(parseNarrativeEdit('   ', 2, { taskBilling: true }), null);
  assert.equal(parseNarrativeEdit('.', 2, { taskBilling: true }), null);
});

// ---------- rebalanceHours ----------

test('rebalanceHours: simple pull-from-last absorbs the whole delta', () => {
  const out = rebalanceHours([1.0, 0.5, 1.0], 0, 1.2, { increment: 0.1 });
  assert.deepEqual(out, [1.2, 0.5, 0.8]);
});

test('rebalanceHours: a larger delta spans two lines (reverse order) and fully absorbs', () => {
  const out = rebalanceHours([1.0, 0.4, 0.4], 0, 1.5, { increment: 0.1 });
  assert.deepEqual(out, [1.5, 0.2, 0.1]);
  // total is preserved when the delta fully absorbs
  assert.equal(out.reduce((a, b) => a + b, 0).toFixed(1), '1.8');
});

test('rebalanceHours: floor-at-increment leaves an unabsorbed remainder (effective total grows)', () => {
  const out = rebalanceHours([1.0, 0.1, 0.1], 0, 1.3, { increment: 0.1 });
  assert.deepEqual(out, [1.3, 0.1, 0.1]);
  assert.equal(out.reduce((a, b) => a + b, 0).toFixed(1), '1.5'); // grew from 1.2
});

test('rebalanceHours: decrease case returns the whole delta to the last line only', () => {
  const out = rebalanceHours([1.0, 0.5, 0.3], 0, 0.6, { increment: 0.1 });
  assert.deepEqual(out, [0.6, 0.5, 0.7]);
});

test('rebalanceHours: single-line array is a no-op besides taking the new value', () => {
  const out = rebalanceHours([0.7], 0, 1.1, { increment: 0.1 });
  assert.deepEqual(out, [1.1]);
});

test('rebalanceHours: new value rounds to the increment and floors at one increment minimum', () => {
  const out = rebalanceHours([1.0, 0.5], 1, 0.03, { increment: 0.1 });
  assert.deepEqual(out, [1.4, 0.1]);
});

// ---------- formatSuggestion ----------

test('formatSuggestion: trims, capitalizes, and adds a trailing period', () => {
  assert.equal(formatSuggestion('  review lease  '), 'Review lease.');
});

test('formatSuggestion: does not double a trailing period', () => {
  assert.equal(formatSuggestion('Draft memo.'), 'Draft memo.');
});

test('formatSuggestion: does not add a period after ! or ?', () => {
  assert.equal(formatSuggestion('Call opposing counsel!'), 'Call opposing counsel!');
  assert.equal(formatSuggestion('Confirm hearing date?'), 'Confirm hearing date?');
});

test('formatSuggestion: blank input stays blank', () => {
  assert.equal(formatSuggestion(''), '');
  assert.equal(formatSuggestion('   '), '');
});
