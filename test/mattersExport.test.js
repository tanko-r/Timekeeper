import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MATTERS_CSV_HEADER, buildMattersCsv } from '../server/lib/mattersExport.js';
import { parseCsv } from '../server/lib/csv.js';

const row = (over = {}) => ({
  client_number: '100001',
  client_name: 'Acme Holdings',
  matter_number: '000012',
  cm_number: '100001-000012',
  short_name: 'Lease dispute',
  billable: 1,
  status: 'active',
  favorite: 0,
  entry_count: 3,
  last_used_at: '2026-08-01T17:00:00.000Z',
  ...over,
});

test('matters CSV emits the documented header', () => {
  const rows = parseCsv(buildMattersCsv([row()]));
  assert.deepEqual(rows[0], MATTERS_CSV_HEADER);
});

test('matters CSV writes readable values, not raw integers', () => {
  const csv = buildMattersCsv([row({ billable: 0, favorite: 1 })]);
  const [, data] = parseCsv(csv);
  assert.deepEqual(data, [
    '100001', 'Acme Holdings', '000012', '100001-000012', 'Lease dispute',
    'non-billable', 'active', 'yes', '3', '2026-08-01T17:00:00.000Z',
  ]);
});

test('matters CSV sorts by client number then matter number', () => {
  const csv = buildMattersCsv([
    row({ client_number: '100002', matter_number: '000002', cm_number: '100002-000002' }),
    row({ client_number: '100001', matter_number: '000030', cm_number: '100001-000030' }),
    row({ client_number: '100001', matter_number: '000004', cm_number: '100001-000004' }),
  ]);
  const nums = parseCsv(csv).slice(1).map((r) => r[3]);
  assert.deepEqual(nums, ['100001-000004', '100001-000030', '100002-000002']);
});

test('matters CSV tolerates an unnamed client and a never-used matter', () => {
  const csv = buildMattersCsv([row({ client_name: null, last_used_at: null, entry_count: 0 })]);
  const [, data] = parseCsv(csv);
  assert.equal(data[1], '');
  assert.equal(data[8], '0');
  assert.equal(data[9], '');
});
