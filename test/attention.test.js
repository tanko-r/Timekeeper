import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isUnfinalized, isUnexported, isReverted, needsAttention, attentionSql,
  ATTENTION_KINDS, ATTENTION_WINDOW_DAYS,
} from '../server/lib/attention.js';

const draft = (over = {}) => ({ status: 'draft', exported_at: null, ever_finalized: 0, deleted_at: null, ...over });
const fin = (over = {}) => ({ status: 'finalized', exported_at: null, ever_finalized: 1, deleted_at: null, ...over });

test('unfinalized: any live draft, whatever its history', () => {
  assert.equal(isUnfinalized(draft()), true);
  assert.equal(isUnfinalized(draft({ ever_finalized: 1, exported_at: '2026-08-01T00:00:00Z' })), true);
  assert.equal(isUnfinalized(fin()), false);
  assert.equal(isUnfinalized(draft({ deleted_at: '2026-08-01T00:00:00Z' })), false);
});

test('unexported: finalized with no stamp', () => {
  assert.equal(isUnexported(fin()), true);
  assert.equal(isUnexported(fin({ exported_at: '2026-08-01T00:00:00Z' })), false);
  assert.equal(isUnexported(fin({ deleted_at: '2026-08-01T00:00:00Z' })), false);
  // a draft is not "unexported" — it has not reached that hop yet
  assert.equal(isUnexported(draft()), false);
});

test('reverted: the entry that already looked done', () => {
  // unlocked after being finalized and exported — the leak David is after
  assert.equal(isReverted(draft({ ever_finalized: 1, exported_at: '2026-08-01T00:00:00Z' })), true);
  // unlocked after finalizing but before exporting — same leak, one hop back
  assert.equal(isReverted(draft({ ever_finalized: 1 })), true);
  // never finalized: a plain draft, not a revert
  assert.equal(isReverted(draft()), false);
  // still finalized: nothing was reverted
  assert.equal(isReverted(fin()), false);
});

test('needsAttention dispatches on kind, "either" is the union', () => {
  const d = draft();
  const f = fin();
  const done = fin({ exported_at: '2026-08-01T00:00:00Z' });
  assert.equal(needsAttention(d, 'unfinalized'), true);
  assert.equal(needsAttention(d, 'unexported'), false);
  assert.equal(needsAttention(f, 'unexported'), true);
  assert.equal(needsAttention(d, 'either'), true);
  assert.equal(needsAttention(f, 'either'), true);
  assert.equal(needsAttention(done, 'either'), false);
  // unknown/absent kind filters nothing
  assert.equal(needsAttention(done, 'all'), true);
  assert.equal(needsAttention(done, undefined), true);
});

test('attentionSql matches the predicates for every kind', () => {
  assert.deepEqual(ATTENTION_KINDS, ['unfinalized', 'unexported', 'either']);
  for (const kind of ATTENTION_KINDS) assert.ok(attentionSql(kind).includes('status'));
  assert.equal(attentionSql('all'), '');
  assert.equal(attentionSql(undefined), '');
  assert.equal(attentionSql('nonsense'), '');
});

test('the banner looks back a fixed window', () => {
  assert.equal(ATTENTION_WINDOW_DAYS, 90);
});
