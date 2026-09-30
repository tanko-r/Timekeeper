import test from 'node:test';
import assert from 'node:assert/strict';
import { pipelineBucket, pipelineByDay, sumPipeline } from '../public/js/lib/pipeline.js';

const entry = (over = {}) => ({
  id: 1, date: '2026-09-01', total: 1, status: 'draft', exported_at: null, ...over,
});

test('bucket: a draft is unfinalized, even one exported before and reopened', () => {
  assert.equal(pipelineBucket(entry()), 'unfinalized');
  assert.equal(pipelineBucket(entry({ exported_at: '2026-09-02T10:00:00Z' })), 'unfinalized');
});

test('bucket: finalized and never sent is unexported; finalized and sent is exported', () => {
  assert.equal(pipelineBucket(entry({ status: 'finalized' })), 'unexported');
  assert.equal(pipelineBucket(entry({ status: 'finalized', exported_at: '2026-09-02T10:00:00Z' })), 'exported');
});

test('pipelineByDay sums hours per bucket for each date', () => {
  const days = pipelineByDay([
    entry({ id: 1, total: 1.2 }),
    entry({ id: 2, total: 0.3, status: 'finalized' }),
    entry({ id: 3, total: 2.5, status: 'finalized', exported_at: 'x' }),
    entry({ id: 4, total: 0.4, status: 'finalized' }),
    entry({ id: 5, date: '2026-09-02', total: 0.1 }),
  ]);
  assert.deepEqual(days.get('2026-09-01'), { unfinalized: 1.2, unexported: 0.7, exported: 2.5, total: 4.4 });
  assert.deepEqual(days.get('2026-09-02'), { unfinalized: 0.1, unexported: 0, exported: 0, total: 0.1 });
  assert.equal(days.has('2026-09-03'), false);
});

test('sums do not drift into float noise', () => {
  const days = pipelineByDay([0.1, 0.2, 0.4].map((total, i) => entry({ id: i, total })));
  assert.equal(days.get('2026-09-01').unfinalized, 0.7);
});

test('sumPipeline adds day summaries and skips missing days', () => {
  const days = pipelineByDay([
    entry({ id: 1, total: 1 }),
    entry({ id: 2, date: '2026-09-02', total: 2, status: 'finalized' }),
  ]);
  const t = sumPipeline(['2026-09-01', '2026-09-02', '2026-09-09'].map((d) => days.get(d)));
  assert.deepEqual(t, { unfinalized: 1, unexported: 2, exported: 0, total: 3 });
});

test('handles empty and missing input', () => {
  assert.equal(pipelineByDay(null).size, 0);
  assert.deepEqual(sumPipeline([]), { unfinalized: 0, unexported: 0, exported: 0, total: 0 });
});
