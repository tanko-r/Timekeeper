// ADVERSARIAL VERIFICATION — do NOT "fix" these tests to pass.
//
// Claim under test: server/routes/entries.js normalizeTasks() does
//   `Number(t.duration) || 0`
// so a PATCH whose tasks array omits the `duration` key silently zeroes every
// task line's hours, and syncNarrative then rewrites the billing narrative
// with (0.0) amounts. Claimed severity: medium.
//
// FIXED 2026-08-16. normalizeTasks() now takes { requireDuration } and the
// PATCH route passes it; a task line with no usable duration is a 400 and
// NOTHING in the payload is written. The create route deliberately does not
// pass it — a brand-new entry has no hours to lose and legitimately starts
// with none.
//
// The `repro` tests below used to assert the destructive behaviour verbatim
// (200 OK, durations zeroed, narrative rewritten with "(0.0)"). Those
// assertions stated the DEFECT, not the specification: the file's own
// FAILING-ON-PURPOSE test named 400 as an acceptable fix, and the brief's "no
// time may ever be lost" rule outranks a description of what the server
// happened to do. They have been rewritten to assert the refusal and — the
// part that actually matters — that the stored hours and narrative are
// untouched by it. Every rewrite kept or strengthened what is checked after
// the request; none removed a check. See the four-step revert proof in the
// task report.
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

test('P4: a PATCH whose tasks omit the duration key is refused and changes nothing', () =>
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
    assert.equal(before.entry.narrative, 'Review lease (0.5); draft email (0.7).');

    // The claimed payload: same fragments, same codes, NO duration key.
    const r = await t.fetchJson('PATCH', `/api/entries/${created.id}`, {
      tasks: [
        { task_code: 'Review', fragment: 'review lease' },
        { task_code: 'Draft', fragment: 'draft email' },
      ],
    });

    // Refused, and the refusal SAYS SO — no silent 200 over destroyed hours.
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.match(r.body.error, /duration/i);

    const after = stored(t, created.id);
    assert.equal(after.sum, 1.2, 'summed duration IN THE DATABASE after the refusal');
    assert.deepEqual(after.tasks.map((x) => x.duration), [0.5, 0.7]);
    assert.equal(after.entry.narrative, 'Review lease (0.5); draft email (0.7).',
      'the billing narrative is not rewritten with (0.0) amounts');
    assert.equal(after.entry.total_override, null);
  }));

test('variation A: one duration-less line refuses the WHOLE payload — nothing partial lands', () =>
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
        // the second line would legitimately edit the first one's fragment;
        // writeTasks replaces the lines wholesale, so a partial write would
        // still be a loss. The whole request is refused.
        { task_code: 'Review', duration: 0.9, fragment: 'review lease rider' },
        { task_code: 'Draft', fragment: 'draft email' },
      ],
    });
    assert.equal(r.status, 400, JSON.stringify(r.body));
    const after = stored(t, created.id);
    assert.deepEqual(after.tasks.map((x) => x.duration), [0.5, 0.7]);
    assert.deepEqual(after.tasks.map((x) => x.fragment), ['review lease', 'draft email'],
      'the valid line is not written either — the refusal is all-or-nothing');
    assert.equal(after.sum, 1.2); // the 0.7h that used to disappear
  }));

test('variation B: a non-numeric duration ("", null, "0.5h") is rejected, never coerced to 0', () =>
  withServer(async (t, cm) => {
    const created = (await t.fetchJson('POST', '/api/entries', {
      date: '2026-07-06', cm_id: cm.id,
      tasks: [{ task_code: 'Review', duration: 1.4, fragment: 'review lease' }],
    })).body;
    for (const bad of ['', null, '0.5h', 'abc', {}, undefined]) {
      const r = await t.fetchJson('PATCH', `/api/entries/${created.id}`, {
        tasks: [{ task_code: 'Review', duration: bad, fragment: 'review lease' }],
      });
      assert.equal(r.status, 400, `duration=${JSON.stringify(bad)} was accepted`);
      assert.equal(stored(t, created.id).sum, 1.4,
        `duration=${JSON.stringify(bad)} must leave the recorded 1.4h alone`);
    }
    // …while anything that really is a number still goes through, including a
    // deliberate zero and a numeric string.
    for (const [good, expected] of [[0, 0], ['0.5', 0.5], [1.4, 1.4]]) {
      const r = await t.fetchJson('PATCH', `/api/entries/${created.id}`, {
        tasks: [{ task_code: 'Review', duration: good, fragment: 'review lease' }],
      });
      assert.equal(r.status, 200, `duration=${JSON.stringify(good)} was refused`);
      assert.equal(stored(t, created.id).sum, expected);
    }
  }));

test('scope check: the create path still accepts task lines with no durations yet', () =>
  withServer(async (t, cm) => {
    // A create has no recorded hours to destroy, and the editor legitimately
    // opens a new entry on blank lines. The requirement is EDIT-path only.
    const r = await t.fetchJson('POST', '/api/entries', {
      date: '2026-07-06', cm_id: cm.id,
      tasks: [
        { task_code: 'Review', fragment: 'review lease' },
        { task_code: 'Draft', fragment: 'draft email' },
      ],
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(stored(t, r.body.id).sum, 0);
  }));

test('scope check: an entry whose hours were set as a total keeps its breakdown too', () =>
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
    const r = await t.fetchJson('PATCH', `/api/entries/${created.id}`, {
      tasks: [
        { task_code: 'Review', fragment: 'review lease' },
        { task_code: 'Draft', fragment: 'draft email' },
      ],
    });
    assert.equal(r.status, 400, JSON.stringify(r.body));
    const after = stored(t, created.id);
    assert.equal(after.entry.total_override, 1.2, 'billable total survives');
    assert.equal(after.sum, 1.2, 'and so does the per-line breakdown behind it');
    // The narrative on the bill still agrees with the billed total.
    assert.equal(after.entry.narrative, 'Review lease (0.5); draft email (0.7).');
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
    // The refused edit must not leak either: a 400 writes nothing at all, so
    // matter B's narrative stays matter B's.
    const refused = await t.fetchJson('PATCH', `/api/entries/${b.id}`, {
      tasks: [
        { task_code: 'Draft', fragment: 'draft Northgate disclosure schedule' },
        { task_code: 'Review', fragment: 'review Northgate diligence index' },
      ],
    });
    assert.equal(refused.status, 400);
    // …and the accepted edit stays on its own matter too.
    const ok = await t.fetchJson('PATCH', `/api/entries/${b.id}`, {
      tasks: [
        { task_code: 'Draft', duration: 0.4, fragment: 'draft Northgate disclosure schedule' },
        { task_code: 'Review', duration: 0.2, fragment: 'review Northgate diligence index' },
      ],
    });
    assert.equal(ok.status, 200);
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
