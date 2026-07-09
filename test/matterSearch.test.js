import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rankMatters } from '../server/lib/matterSearch.js';

// Minimal matter-row factory matching the /api/cms payload shape.
const M = (over = {}) => ({
  id: 1, cm_number: '100001-000012', short_name: 'Acme lease', favorite: 0,
  last_used_at: null, client_id: 1, matter_number: '000012',
  client_number: '100001', client_name: '', ...over,
});

test('empty query keeps favorites → recency → alpha ordering', () => {
  const zebra = M({ id: 1, short_name: 'Zenith Corp', last_used_at: '2026-07-06T10:00:00Z' });
  const apple = M({ id: 2, short_name: 'Aspen Partners' });
  const fav = M({ id: 3, short_name: 'Favorite Client', favorite: 1 });
  const out = rankMatters('', [zebra, apple, fav]);
  assert.deepEqual(out.map((m) => m.id), [3, 1, 2]);
});

test('multi-token query matches across client name and matter name', () => {
  const harbor = M({ id: 1, short_name: 'Harbor Lease', client_name: 'Meridian', client_number: '100004', cm_number: '100004-000001', matter_number: '000001' });
  const other = M({ id: 2, short_name: 'Summit Development', client_name: 'Meridian', client_number: '100004', cm_number: '100004-000002', matter_number: '000002' });
  const out = rankMatters('meri harbor', [other, harbor]);
  assert.deepEqual(out.map((m) => m.id), [1]);
});

test('every token must match somewhere (AND semantics)', () => {
  const a = M({ id: 1, short_name: 'Cedar Lease', client_name: 'Ironwood' });
  assert.deepEqual(rankMatters('ironwood lease', [a]).map((m) => m.id), [1]);
  assert.deepEqual(rankMatters('ironwood merger', [a]), []);
});

test('blank client names are handled; client numbers still match', () => {
  const a = M({ id: 1, client_name: '', client_number: '100001' });
  assert.deepEqual(rankMatters('100001', [a]).map((m) => m.id), [1]);
  assert.deepEqual(rankMatters('1000', [a]).map((m) => m.id), [1]);
});

test('word-start matches outrank mid-word matches', () => {
  const start = M({ id: 1, short_name: 'Lease renewal' });
  const mid = M({ id: 2, short_name: 'Sublease dispute' });
  const out = rankMatters('lease', [mid, start]);
  assert.deepEqual(out.map((m) => m.id), [1, 2]);
});

test('exact cm_number query matches only that matter; respects limit', () => {
  const rows = Array.from({ length: 30 }, (_, i) => M({
    id: i + 1,
    cm_number: `300000-${String(i + 1).padStart(6, '0')}`,
    matter_number: String(i + 1).padStart(6, '0'),
    short_name: `Matter ${i + 1}`,
  }));
  assert.deepEqual(rankMatters('300000-000002', rows).map((m) => m.id), [2]);
  assert.equal(rankMatters('', rows).length, 25);
  assert.equal(rankMatters('', rows, { limit: 5 }).length, 5);
});
