// =========================================================================
// REGRESSION GUARD — a tasks PATCH must never lose the hours it sends.
//
// Written 2026-08-16 during Stage 1f/1g, after a critic caught the fix for the
// CSV column drift introducing a silent time loss.
//
// BACKGROUND. An entry's task lines and its total_override must agree, or the
// CSV's per-line duration column and its entry_total column ship two different
// figures for the same entry. Stage 1f made every write reconcile them.
//
// But the reconcile ran ONE WAY ONLY: the lines were dragged to the stored
// override. So a PATCH that restated the lines — the ordinary "add a task
// line" save — had its new hours silently shrunk back to the old total:
//
//     stored: override 1.0, lines [1.0]
//     PATCH tasks [0.5, 0.8]        (1.3 h — the attorney added a line)
//     stored: override 1.0, lines [0.5, 0.5]     HTTP 200, no error
//
// Three tenths of an hour destroyed, with a 200 and a response body that
// reported the old total. The standard is docs/ui/BRIEF.md, "Data integrity":
// no time may be lost.
//
// THE RULE THIS FILE PINS, both directions:
//   - request supplies TASKS and no override  → the lines win; the override
//     follows them. (He is telling the app what the hours are.)
//   - request supplies an OVERRIDE            → the override wins; the lines
//     are reconciled to it. (He has said both; the override is what bills.)
// Both must hold, or one of them is being satisfied by breaking the other.
// =========================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

async function withServer(fn) {
  const t = await startTestServer();
  try { return await fn(t); } finally { await t.close(); }
}

const mkCm = async (t, cm_number, short_name, client_name) => {
  const r = await t.fetchJson('POST', '/api/cms', { cm_number, short_name, client_name, billable: 1 });
  assert.ok(r.status < 300, `cm create failed: ${JSON.stringify(r.body)}`);
  return r.body;
};

const stored = (t, id) => ({
  total: t.db.prepare('SELECT total_override FROM entries WHERE id=?').get(id).total_override,
  lines: t.db.prepare(
    'SELECT duration FROM entry_tasks WHERE entry_id=? ORDER BY sort_order, id').all(id)
    .map((r) => Number(r.duration)),
});

const TODAY = '2026-08-14';

// -------------------------------------------------------------------------
// THE REGRESSION — adding a task line must not shrink it back.
// -------------------------------------------------------------------------
test('a tasks PATCH keeps every hour it sends, even against a stale override', () =>
  withServer(async (t) => {
    const cm = await mkCm(t, '600001-000010', 'Borealis Merger', 'Acme Holdings');
    const e = (await t.fetchJson('POST', '/api/entries', {
      date: TODAY, cm_id: cm.id, narrative: 'Review the disclosure schedules.',
      tasks: [{ task_code: 'Draft', duration: 0.5, fragment: 'drafted the schedules' }],
    })).body;
    await t.fetchJson('PATCH', `/api/entries/${e.id}`, { total_override: 1.0 });
    assert.deepEqual(stored(t, e.id), { total: 1, lines: [1] }, 'precondition');

    // the ordinary "add a task line" save: 0.5 + 0.8 = 1.3 h
    const r = await t.fetchJson('PATCH', `/api/entries/${e.id}`, {
      tasks: [
        { task_code: 'Draft', duration: 0.5, fragment: 'drafted the schedules' },
        { task_code: 'Review', duration: 0.8, fragment: 'reviewed the counterparty markup' },
      ],
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));

    const after = stored(t, e.id);
    assert.equal(after.lines.reduce((a, b) => a + b, 0), 1.3,
      `the lines the attorney sent were shrunk: sent 0.5 + 0.8 = 1.3 h, stored `
      + `${JSON.stringify(after.lines)}`);
    assert.equal(after.total, 1.3,
      `the entry still bills the stale override — it charges ${after.total} h for `
      + `${after.lines.reduce((a, b) => a + b, 0)} h of recorded work`);
    assert.equal(r.body.total, 1.3, 'the response reports what was actually stored');
  }));

// -------------------------------------------------------------------------
// THE OTHER SIDE — an explicit override still wins and still pulls the lines
// with it. This is the defect the reconcile was added for; it is here so a fix
// for the test above cannot be "delete the reconcile".
// -------------------------------------------------------------------------
test('an explicit override still wins, and the lines follow it', () =>
  withServer(async (t) => {
    const cm = await mkCm(t, '600001-000010', 'Borealis Merger', 'Acme Holdings');
    const e = (await t.fetchJson('POST', '/api/entries', {
      date: TODAY, cm_id: cm.id, narrative: 'Review the disclosure schedules.',
      tasks: [
        { task_code: 'Draft', duration: 0.5, fragment: 'drafted the schedules' },
        { task_code: 'Review', duration: 0.5, fragment: 'reviewed the markup' },
      ],
    })).body;

    // the one-tap path: retype the hours on the Today row, lines untouched
    const r = await t.fetchJson('PATCH', `/api/entries/${e.id}`, { total_override: 2.0 });
    assert.equal(r.status, 200, JSON.stringify(r.body));

    const after = stored(t, e.id);
    assert.equal(after.total, 2,
      `the override the attorney typed was not honoured: ${JSON.stringify(after)}`);
    assert.equal(after.lines.reduce((a, b) => a + b, 0), 2,
      'the task lines must add up to what the entry bills, or the CSV duration '
      + `column and the entry total ship different figures: ${JSON.stringify(after)}`);
  }));

// -------------------------------------------------------------------------
// Every stored figure stays a multiple of the billing increment (the owner's
// tenth-of-an-hour rule), on BOTH paths above.
// -------------------------------------------------------------------------
test('both paths leave every stored figure on the billing increment', () =>
  withServer(async (t) => {
    const cm = await mkCm(t, '600001-000010', 'Borealis Merger', 'Acme Holdings');
    const e = (await t.fetchJson('POST', '/api/entries', {
      date: TODAY, cm_id: cm.id, narrative: 'Review the disclosure schedules.',
      tasks: [{ task_code: 'Draft', duration: 0.5, fragment: 'drafted' }],
    })).body;
    const r = await t.fetchJson('PATCH', `/api/entries/${e.id}`, {
      tasks: [
        { task_code: 'Draft', duration: 0.33, fragment: 'drafted' },
        { task_code: 'Review', duration: 0.42, fragment: 'reviewed' },
      ],
    });
    const a = stored(t, e.id);
    const isTenth = (n) => Math.abs(Math.round(n * 10) - n * 10) < 1e-9;
    assert.ok(a.lines.every(isTenth),
      `every billed line must be a multiple of 0.1 h: ${JSON.stringify(a)}`);
    // A null override is not a missing total — it MEANS "the total is the sum
    // of the lines", which is the shape an entry with no retyped hours has.
    // The figure that bills is what the API reports either way.
    assert.ok(isTenth(r.body.total),
      `the billed total must be a multiple of 0.1 h: ${r.body.total}`);
    assert.equal(Math.round(a.lines.reduce((x, y) => x + y, 0) * 10) / 10, r.body.total,
      `the lines must add up to what the entry bills: ${JSON.stringify(a)} vs ${r.body.total}`);
  }));
