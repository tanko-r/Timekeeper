import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectMapping, normalizeMapping, planImport } from '../server/lib/timerimport.js';

test('detectMapping guesses columns and avoids collisions', () => {
  assert.deepEqual(
    detectMapping(['CM Number', 'Matter Name', 'Group']),
    { cm_number: 0, client_name: -1, matter_name: 1, group: 2 });
  // "Matter Number" must claim cm_number so "Matter Name" doesn't steal it.
  assert.deepEqual(
    detectMapping(['Practice', 'Matter Name', 'Matter Number']),
    { cm_number: 2, client_name: -1, matter_name: 1, group: 0 });
});

test('detectMapping finds a client-name column without it stealing matter name', () => {
  assert.deepEqual(
    detectMapping(['CM Number', 'Client Name', 'Matter Name', 'Group']),
    { cm_number: 0, client_name: 1, matter_name: 2, group: 3 });
  // client column first: "Client" must not be claimed by matter_name's
  // 'name' needle, and "Client/Matter" style headers still mean cm_number.
  assert.deepEqual(
    detectMapping(['Client', 'CM', 'Matter Name']),
    { cm_number: 1, client_name: 0, matter_name: 2, group: -1 });
  assert.deepEqual(
    detectMapping(['Client/Matter', 'Matter Name']),
    { cm_number: 0, client_name: -1, matter_name: 1, group: -1 });
});

test('detectMapping returns -1 for fields it cannot find', () => {
  assert.deepEqual(detectMapping(['foo', 'bar']),
    { cm_number: -1, client_name: -1, matter_name: -1, group: -1 });
});

test('normalizeMapping clamps out-of-range/garbage indices to -1', () => {
  assert.deepEqual(
    normalizeMapping({ cm_number: 0, matter_name: 5, group: 'x' }, 3),
    { cm_number: 0, client_name: -1, matter_name: -1, group: -1 });
  assert.deepEqual(
    normalizeMapping({ cm_number: 0, client_name: 1, matter_name: 2, group: -1 }, 3),
    { cm_number: 0, client_name: 1, matter_name: 2, group: -1 });
});

test('planImport passes client_name through on create rows', () => {
  const rows = [
    ['CM Number', 'Matter Name', 'Client Name'],
    ['123456-000001', 'Acme merger', 'Acme Holdings'],
    ['123456-000002', 'Acme lease', ''],
  ];
  const { plan } = planImport(rows, { cm_number: 0, matter_name: 1, client_name: 2, group: -1 });
  assert.equal(plan[0].client_name, 'Acme Holdings');
  assert.equal(plan[1].client_name, '');
  assert.equal(plan[0].action, 'create');
});

const HEADER = ['CM Number', 'Matter Name', 'Group'];
const MAP = { cm_number: 0, matter_name: 1, group: 2 };

test('planImport creates valid new matters and computes billability from group', () => {
  const rows = [
    HEADER,
    ['123456-000001', 'Acme merger', 'Corporate'],
    ['123456-000002', 'Firm admin', 'Firm'],
  ];
  const { plan, counts } = planImport(rows, MAP, { nonBillableGroups: ['firm', 'internal'] });
  assert.equal(counts.create, 2);
  assert.equal(plan[0].billable, 1);
  assert.equal(plan[1].billable, 0); // group "Firm" → non-billable
  assert.equal(plan[0].rowNum, 2);
});

test('planImport skips invalid CM, missing name, existing, and in-file duplicates', () => {
  const rows = [
    HEADER,
    ['bad-cm', 'Whatever', 'Corporate'],
    ['123456-000003', '', 'Corporate'],
    ['123456-000004', 'Already here', 'Corporate'],
    ['123456-000005', 'First', 'Corporate'],
    ['123456-000005', 'Dup', 'Corporate'],
  ];
  const { plan, counts } = planImport(rows, MAP, {
    existingCmNumbers: ['123456-000004'],
  });
  assert.deepEqual(plan.map((p) => p.reason), [
    'invalid CM number', 'missing name', 'already exists', null, 'duplicate in file',
  ]);
  assert.equal(counts.create, 1);
  assert.equal(counts.skip, 4);
});

test('planImport drops wholly blank rows without counting them', () => {
  const rows = [HEADER, ['', '', ''], ['123456-000006', 'Real', '']];
  const { plan, counts } = planImport(rows, MAP, {});
  assert.equal(plan.length, 1);
  assert.equal(counts.create, 1);
  assert.equal(plan[0].billable, 1); // blank group → billable
});
