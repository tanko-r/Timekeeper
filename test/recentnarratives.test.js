import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickRecentNarratives } from '../server/lib/recentnarratives.js';

const row = (id, date, narrative, extra = {}) => ({
  id, date, narrative, total: 0.5, status: 'finalized', ...extra,
});

test('keeps the rows in the order given, newest first', () => {
  const out = pickRecentNarratives([
    row(3, '2026-08-14', 'Call with W. Hammond regarding the lease.'),
    row(2, '2026-08-13', 'Review and comment on the data center ordinance.'),
    row(1, '2026-08-12', 'Draft response to the landlord.'),
  ], 20);
  assert.deepEqual(out.map((o) => o.id), [3, 2, 1]);
  assert.deepEqual(out.map((o) => o.uses), [1, 1, 1]);
});

test('identical narratives collapse to the most recent, counting uses', () => {
  const out = pickRecentNarratives([
    row(4, '2026-08-14', 'Call with W. Hammond regarding the lease.'),
    row(3, '2026-08-13', 'call with w. hammond regarding the lease'),
    row(2, '2026-08-12', '  Call  with W. Hammond regarding the lease.  '),
    row(1, '2026-08-11', 'Draft response to the landlord.'),
  ], 20);
  assert.equal(out.length, 2);
  assert.equal(out[0].id, 4);
  assert.equal(out[0].uses, 3);
  assert.equal(out[0].narrative, 'Call with W. Hammond regarding the lease.');
  assert.equal(out[1].uses, 1);
});

test('different time allocations are different narratives', () => {
  const out = pickRecentNarratives([
    row(2, '2026-08-14', 'Review lease (0.5); draft email (0.2).'),
    row(1, '2026-08-13', 'Review lease (1.5); draft email (0.2).'),
  ], 20);
  assert.equal(out.length, 2);
});

test('blank narratives are skipped entirely', () => {
  const out = pickRecentNarratives([
    row(3, '2026-08-14', '   '),
    row(2, '2026-08-13', null),
    row(1, '2026-08-12', 'Draft response to the landlord.'),
  ], 20);
  assert.deepEqual(out.map((o) => o.id), [1]);
});

test('the limit caps distinct narratives but repeats still count', () => {
  const out = pickRecentNarratives([
    row(5, '2026-08-14', 'One.'),
    row(4, '2026-08-13', 'Two.'),
    row(3, '2026-08-12', 'Three.'),
    row(2, '2026-08-11', 'One.'),
  ], 2);
  assert.deepEqual(out.map((o) => o.narrative), ['One.', 'Two.']);
  assert.equal(out[0].uses, 2);
});

test('empty and missing input', () => {
  assert.deepEqual(pickRecentNarratives([], 20), []);
  assert.deepEqual(pickRecentNarratives(undefined, 20), []);
});
