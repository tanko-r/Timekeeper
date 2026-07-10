import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTransferDate, parseTaskLines, planIntappImport } from '../server/lib/intappimport.js';

// ---------- parseTransferDate ----------

test('parseTransferDate reads the date out of an Intapp Transferred status', () => {
  assert.equal(parseTransferDate('Transferred May/07/2026 02:00:21 (MDT)'), '2026-05-07');
  assert.equal(parseTransferDate('Transferred Jul/02/2026 01:45:16 (MDT)'), '2026-07-02');
  assert.equal(parseTransferDate('Transferred Jun/22/2026 14:03:09 (MST)'), '2026-06-22');
});

test('parseTransferDate returns null for non-transferred statuses', () => {
  assert.equal(parseTransferDate('Cannot close entry with temporary Client number'), null);
  assert.equal(parseTransferDate(''), null);
  assert.equal(parseTransferDate(null), null);
  assert.equal(parseTransferDate('Transferred Foo/07/2026 02:00:21 (MDT)'), null);
});

// ---------- parseTaskLines ----------

test('parseTaskLines splits a task-billed narrative whose allocations sum to the hours', () => {
  assert.deepEqual(
    parseTaskLines('Review lease (1.2); draft email to landlord (0.3); call with client (0.7).', 2.2),
    [
      { fragment: 'Review lease', duration: 1.2 },
      { fragment: 'draft email to landlord', duration: 0.3 },
      { fragment: 'call with client', duration: 0.7 },
    ]);
});

test('parseTaskLines handles fragments that contain their own parens', () => {
  assert.deepEqual(
    parseTaskLines('(MAT1) Bi-weekly design call (1.3); review Master Lease (0.6); draft response (0.3).', 2.2),
    [
      { fragment: '(MAT1) Bi-weekly design call', duration: 1.3 },
      { fragment: 'review Master Lease', duration: 0.6 },
      { fragment: 'draft response', duration: 0.3 },
    ]);
});

test('parseTaskLines returns null for free narratives (no trailing allocations)', () => {
  assert.equal(parseTaskLines('Additional review on tax incentive provisions.', 0.2), null);
  // A leading matter tag is not an allocation.
  assert.equal(parseTaskLines('(MAT2) Call with N. Delgado and follow up with Lakeside Law.', 0.4), null);
  assert.equal(parseTaskLines('', 0.5), null);
});

test('parseTaskLines returns null when only one segment parses (single line = free narrative)', () => {
  assert.equal(parseTaskLines('Review lease (1.2).', 1.2), null);
});

test('parseTaskLines returns null when any segment lacks an allocation', () => {
  assert.equal(parseTaskLines('Review lease (1.2); draft email to landlord.', 1.5), null);
});

test('parseTaskLines returns null when allocations do not sum to the entry hours', () => {
  assert.equal(parseTaskLines('Review lease (1.0); call (0.5).', 2.0), null);
  // float noise within a hundredth is fine
  assert.deepEqual(
    parseTaskLines('Review (0.1); call (0.2).', 0.30000000004),
    [{ fragment: 'Review', duration: 0.1 }, { fragment: 'call', duration: 0.2 }]);
});

// ---------- planIntappImport ----------

const ROWS = [
  { hours: '0.20', cm_number: '100002-000001', client_name: 'Cascade Ventures, LLC', matter_name: 'Cascade Property Sale -133101', narrative: 'Additional review on tax incentive provisions.', status: 'Transferred May/07/2026 02:00:21 (MDT)' },
  { hours: '2.20', cm_number: '100003-000002', client_name: 'Meridian Corporation', matter_name: 'Real Estate Dev-General FY26', narrative: 'Design call (1.3); review lease (0.6); draft response (0.3).', status: 'Transferred May/24/2026 01:45:16 (MDT)' },
  { hours: '1.33', cm_number: '$1', client_name: '', matter_name: '', narrative: 'PROJ01 - research.', status: 'Cannot close entry with temporary Client number' },
];

test('planIntappImport maps rows to entry plans against existing matters', () => {
  const { plan, counts } = planIntappImport(ROWS, {
    existingByCm: new Map([['100002-000001', { id: 7, billable: 1 }]]),
  });

  assert.equal(counts.import, 2);
  assert.equal(counts.skip, 1);
  assert.equal(counts.newMatters, 1);

  const [a, b, c] = plan;
  assert.equal(a.action, 'import');
  assert.deepEqual(a.entry, {
    date: '2026-05-07', cm_number: '100002-000001', narrative: ROWS[0].narrative,
    hours: 0.2, tasks: null,
  });
  assert.equal(a.newMatter, null);

  assert.equal(b.action, 'import');
  assert.equal(b.entry.date, '2026-05-24');
  assert.equal(b.entry.tasks.length, 3);
  // Matter missing from the DB → plan creates it, carrying both names.
  assert.deepEqual(b.newMatter, {
    cm_number: '100003-000002',
    client_name: 'Meridian Corporation',
    matter_name: 'Real Estate Dev-General FY26',
  });

  assert.equal(c.action, 'skip');
  assert.match(c.reason, /CM number/);
});

test('planIntappImport skips rows without a parseable transfer date', () => {
  const { plan } = planIntappImport([
    { ...ROWS[0], status: 'Pending' },
  ], { existingByCm: new Map() });
  assert.equal(plan[0].action, 'skip');
  assert.match(plan[0].reason, /date/);
});

test('planIntappImport skips duplicates already in the DB (idempotent re-run)', () => {
  const key = `2026-05-07|100002-000001|${ROWS[0].narrative}`;
  const { plan, counts } = planIntappImport([ROWS[0]], {
    existingByCm: new Map([['100002-000001', { id: 7, billable: 1 }]]),
    existingEntryKeys: new Set([key]),
  });
  assert.equal(plan[0].action, 'skip');
  assert.match(plan[0].reason, /already imported/);
  assert.equal(counts.skip, 1);
});

test('planIntappImport creates each missing matter only once and skips bad hours', () => {
  const { plan, counts } = planIntappImport([
    { ...ROWS[1], narrative: 'First entry.', status: 'Transferred Jun/01/2026 01:00:00 (MDT)' },
    { ...ROWS[1], narrative: 'Second entry.', status: 'Transferred Jun/02/2026 01:00:00 (MDT)' },
    { ...ROWS[1], hours: '0', narrative: 'Zero hours.' },
  ], { existingByCm: new Map() });
  assert.equal(counts.newMatters, 1);
  assert.equal(plan[0].newMatter?.cm_number, '100003-000002');
  assert.equal(plan[1].newMatter, null); // already planned above
  assert.equal(plan[2].action, 'skip');
  assert.match(plan[2].reason, /hours/);
});
