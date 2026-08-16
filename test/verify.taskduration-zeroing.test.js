// ADVERSARIAL VERIFICATION — do NOT "fix" these tests to pass.
//
// Claim under test: server/routes/entries.js normalizeTasks() does
//   `Number(t.duration) || 0`
// so a PATCH whose tasks array omits the `duration` key silently zeroes every
// task line's hours, and syncNarrative then rewrites the billing narrative
// with (0.0) amounts. Claimed severity: medium.
//
// These tests DOCUMENT the observed behaviour. The `repro` tests assert what
// the server actually does today (they pass, and pin the behaviour). The test
// marked FAILING-ON-PURPOSE asserts what the brief's "no time may ever be
// lost" rule demands, and fails until the server either rejects or preserves
// a duration-less task payload.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

async function withServer(fn) {
  const t = await startTestServer();
  try {
    const cm = (await t.fetchJson('POST', '/api/cms', {
      cm_number: '100001-000012', short_name: 'Acme lease', billable: 1,
    })).body;
    await fn(t, cm);
  } finally { await t.close(); }
}

// Reads the stored rows straight out of sqlite, bypassing the API's enrich().
function stored(t, id) {
  const e = t.db.prepare(
    'SELECT id, narrative, total_override, narrative_manual FROM entries WHERE id=?').get(id);
  const tasks = t.db.prepare(
    'SELECT task_code, duration, fragment, sort_order FROM entry_tasks WHERE entry_id=? ORDER BY sort_order, id'
  ).all(id);
  const sum = t.db.prepare(
    'SELECT COALESCE(SUM(duration),0) s FROM entry_tasks WHERE entry_id=?').get(id).s;
  return { entry: e, tasks, sum };
}

test('repro P4: PATCH tasks without duration keys zeroes stored durations and rewrites the narrative', () =>
  withServer(async (t, cm) => {
    const created = (await t.fetchJson('POST', '/api/entries', {
      date: '2026-07-06', cm_id: cm.id,
      tasks: [
        { task_code: 'Review', duration: 0.5, fragment: 'review lease' },
        { task_code: 'Draft', duration: 0.7, fragment: 'draft email' },
      ],
    })).body;
    assert.equal(created.total, 1.2);
    const before = stored(t, created.id);
    assert.equal(before.sum, 1.2);

    // The claimed payload: same fragments, same codes, NO duration key.
    const patched = (await t.fetchJson('PATCH', `/api/entries/${created.id}`, {
      tasks: [
        { task_code: 'Review', fragment: 'review lease' },
        { task_code: 'Draft', fragment: 'draft email' },
      ],
    })).body;

    const after = stored(t, created.id);
    // 200 OK, no error, no warning of any kind in the response.
    assert.equal(patched.total, 0, 'API total after duration-less PATCH');
    assert.equal(after.sum, 0, 'summed duration IN THE DATABASE after the PATCH');
    assert.deepEqual(after.tasks.map((x) => x.duration), [0, 0]);
    assert.equal(after.entry.narrative, 'Review lease (0.0); draft email (0.0).');
    assert.equal(after.entry.total_override, null);
  }));

test('repro variation A: a single duration-less line in an otherwise valid payload zeroes only that line', () =>
  withServer(async (t, cm) => {
    const created = (await t.fetchJson('POST', '/api/entries', {
      date: '2026-07-06', cm_id: cm.id,
      tasks: [
        { task_code: 'Review', duration: 0.5, fragment: 'review lease' },
        { task_code: 'Draft', duration: 0.7, fragment: 'draft email' },
      ],
    })).body;
    await t.fetchJson('PATCH', `/api/entries/${created.id}`, {
      tasks: [
        { task_code: 'Review', duration: 0.5, fragment: 'review lease' },
        { task_code: 'Draft', fragment: 'draft email' },
      ],
    });
    const after = stored(t, created.id);
    assert.deepEqual(after.tasks.map((x) => x.duration), [0.5, 0]);
    assert.equal(after.sum, 0.5); // 0.7h gone
  }));

test('repro variation B: a non-numeric duration ("", null, "0.5h") is coerced to 0, not rejected', () =>
  withServer(async (t, cm) => {
    const created = (await t.fetchJson('POST', '/api/entries', {
      date: '2026-07-06', cm_id: cm.id,
      tasks: [{ task_code: 'Review', duration: 1.4, fragment: 'review lease' }],
    })).body;
    for (const bad of ['', null, '0.5h', 'abc', {}]) {
      const r = await t.fetchJson('PATCH', `/api/entries/${created.id}`, {
        tasks: [{ task_code: 'Review', duration: bad, fragment: 'review lease' }],
      });
      assert.equal(r.status, 200, `duration=${JSON.stringify(bad)} was accepted`);
      assert.equal(stored(t, created.id).sum, 0, `duration=${JSON.stringify(bad)} stored as 0`);
      // restore for the next iteration
      await t.fetchJson('PATCH', `/api/entries/${created.id}`, {
        tasks: [{ task_code: 'Review', duration: 1.4, fragment: 'review lease' }],
      });
    }
  }));

test('scope check: total_override shields an entry whose hours were set as a total (the editor path)', () =>
  withServer(async (t, cm) => {
    // This is what public/js/components/entryeditor.js doPersist() actually
    // sends: total_override alongside the task lines.
    const created = (await t.fetchJson('POST', '/api/entries', {
      date: '2026-07-06', cm_id: cm.id, total_override: 1.2,
      tasks: [
        { task_code: 'Review', duration: 0.5, fragment: 'review lease' },
        { task_code: 'Draft', duration: 0.7, fragment: 'draft email' },
      ],
    })).body;
    await t.fetchJson('PATCH', `/api/entries/${created.id}`, {
      tasks: [
        { task_code: 'Review', fragment: 'review lease' },
        { task_code: 'Draft', fragment: 'draft email' },
      ],
    });
    const after = stored(t, created.id);
    assert.equal(after.entry.total_override, 1.2, 'billable total survives');
    assert.equal(after.sum, 0, 'but the per-line breakdown is still zeroed');
    // The narrative the bill would carry now contradicts the billed total.
    assert.equal(after.entry.narrative, 'Review lease (0.0); draft email (0.0).');
  }));

test('scope check: no narrative crosses a matter boundary on this path', () =>
  withServer(async (t, cm) => {
    const cmB = (await t.fetchJson('POST', '/api/cms', {
      cm_number: '100002-000001', short_name: 'Northgate merger', billable: 1,
    })).body;
    const a = (await t.fetchJson('POST', '/api/entries', {
      date: '2026-07-06', cm_id: cm.id,
      tasks: [
        { task_code: 'Review', duration: 0.5, fragment: 'review Acme lease rider' },
        { task_code: 'Draft', duration: 0.3, fragment: 'draft Acme estoppel letter' },
      ],
    })).body;
    // matter B's entry takes the duration-less shape — the zeroing path
    const b = (await t.fetchJson('POST', '/api/entries', {
      date: '2026-07-06', cm_id: cmB.id,
      tasks: [
        { task_code: 'Draft', fragment: 'draft Northgate disclosure schedule' },
        { task_code: 'Review', fragment: 'review Northgate diligence index' },
      ],
    })).body;
    await t.fetchJson('PATCH', `/api/entries/${b.id}`, {
      tasks: [
        { task_code: 'Draft', fragment: 'draft Northgate disclosure schedule' },
        { task_code: 'Review', fragment: 'review Northgate diligence index' },
      ],
    });
    const rows = t.db.prepare(
      'SELECT id, cm_id, narrative FROM entries WHERE deleted_at IS NULL').all();
    for (const row of rows) {
      if (row.id === a.id) assert.match(row.narrative, /Acme/);
      if (row.id === b.id) assert.doesNotMatch(row.narrative, /Acme/);
    }
    assert.ok(rows.length === 2);
  }));

// ---------------------------------------------------------------------------
// FAILING ON PURPOSE. This is the brief's rule, not the current behaviour.
// "No time and no narrative may ever be lost." A PATCH that omits duration
// must either be rejected (400) or leave the stored hours alone. Today it is
// accepted with 200 and the hours are gone with no signal. Do not delete or
// weaken this test to get a green run — fix normalizeTasks() instead.
// ---------------------------------------------------------------------------
test('FAILING ON PURPOSE: a duration-less tasks PATCH must not silently destroy recorded hours', () =>
  withServer(async (t, cm) => {
    const created = (await t.fetchJson('POST', '/api/entries', {
      date: '2026-07-06', cm_id: cm.id,
      tasks: [
        { task_code: 'Review', duration: 0.5, fragment: 'review lease' },
        { task_code: 'Draft', duration: 0.7, fragment: 'draft email' },
      ],
    })).body;
    const r = await t.fetchJson('PATCH', `/api/entries/${created.id}`, {
      tasks: [
        { task_code: 'Review', fragment: 'review lease' },
        { task_code: 'Draft', fragment: 'draft email' },
      ],
    });
    if (r.status === 400) return; // acceptable fix: reject the ambiguous shape
    assert.equal(stored(t, created.id).sum, 1.2,
      'recorded hours must survive a PATCH that says nothing about durations');
  }));
