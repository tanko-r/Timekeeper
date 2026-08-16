// ===========================================================================
// ADVERSARIAL VERIFICATION of the claim:
//
//   "The CSV reports hours from the task lines while the screen, the .TIM and
//    the text summary report the entry total."
//
// This file is written by a VERIFIER, independently of the claimant's
// test/integrity.export.test.js. Every number it asserts was read back either
// out of the export payload or straight out of the SQLite rows.
//
// Tests named PROVES: are expected to FAIL against ui-overhaul-2026-08 as it
// stands. Do NOT relax them to make the suite green — the fix belongs in
// server/routes/export.js buildExport() and/or server/routes/timers.js
// syncToEntry().
//
// Tests named FACT: pass today and record what the export actually does, so
// the finding is neither overstated nor understated.
// ===========================================================================
process.env.TZ = 'America/Los_Angeles';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';
import { parseCsv } from '../server/lib/csv.js';

const TODAY = '2026-07-06';

function movingClock(startIso) {
  let ms = new Date(startIso).getTime();
  const c = () => new Date(ms);
  c.advance = (s) => { ms += s * 1000; };
  return c;
}

async function withServer(fn, startIso = '2026-07-06T09:00:00-07:00') {
  const clock = movingClock(startIso);
  const t = await startTestServer({ clock });
  try { return await fn(t, clock); } finally { await t.close(); }
}

const mkCm = (t, cm_number, short_name) =>
  t.fetchJson('POST', '/api/cms', { cm_number, short_name, billable: 1 }).then((r) => r.body);

// ---- readers -------------------------------------------------------------

// The CSV as a spreadsheet reader sees it: every row for one entry.
function csvRowsFor(csv, entryId) {
  const rows = parseCsv(csv);
  const head = rows[0];
  const i = (n) => head.indexOf(n);
  const body = rows.slice(1).filter((r) => String(r[i('entry_id')]) === String(entryId));
  return {
    head,
    rows: body,
    durationSum: Math.round(body.reduce((a, r) => a + (Number(r[i('duration')]) || 0), 0) * 1e4) / 1e4,
    entryTotal: body.length ? Number(body[0][i('entry_total')]) : null,
    narrative: body.length ? body[0][i('narrative')] : null,
    tasks: body.map((r) => r[i('task')]),
  };
}

// .TIM carries hours as seconds in `am=`.
const timSecondsFor = (tim) => (tim.split('\n').filter(Boolean)
  .map((l) => Number(/(?:^|\|)am=(\d+)(?:\||$)/.exec(l)[1])));

// Straight out of SQLite — no API in the way.
const storedEntry = (t, id) => t.db.prepare(
  'SELECT id, cm_id, date, status, total_override, narrative, exported_at FROM entries WHERE id=?').get(id);
const storedLines = (t, id) => t.db.prepare(
  'SELECT task_code, duration, fragment FROM entry_tasks WHERE entry_id=? ORDER BY sort_order, id').all(id);
const lineSum = (lines) => Math.round(lines.reduce((a, l) => a + (Number(l.duration) || 0), 0) * 1e4) / 1e4;

// Sum of the "(0.5)" allocations the task-billed narrative prints on the bill.
function allocationsIn(narrative) {
  const hits = String(narrative || '').match(/\(\s*(\d+(?:\.\d+)?)\s*\)/g) || [];
  return Math.round(hits.reduce((a, s) => a + Number(s.replace(/[()\s]/g, '')), 0) * 1e4) / 1e4;
}

// ===========================================================================
// PROVES 1 — the ordinary-use path. One timer, one matter, one split done in
// the editor, then more time on the same matter. Nothing unusual at any point.
// ===========================================================================
test('PROVES: a resumed timer on a split entry ships hours the CSV duration column never accounts for', () =>
  withServer(async (t, clock) => {
    const acme = await mkCm(t, '100001-000012', 'Acme lease');
    const timer = (await t.fetchJson('POST', '/api/timers', {
      name: 'Acme lease', cm_id: acme.id,
    })).body;

    // 1. An hour of work.
    await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
    clock.advance(3600);
    const id = (await t.fetchJson('POST', `/api/timers/${timer.id}/stop`)).body.entry.id;

    // 2. The attorney splits that hour into two task lines. This is exactly
    //    the payload public/js/components/entryeditor.js doPersist() sends:
    //    total_override = the entry total on screen, tasks = the lines.
    await t.fetchJson('PATCH', `/api/entries/${id}`, {
      total_override: 1,
      tasks: [
        { task_code: 'Review', duration: 0.5, fragment: 'review lease amendment' },
        { task_code: 'Draft', duration: 0.5, fragment: 'draft email to landlord' },
      ],
    });

    // 3. Back on the same matter for another half hour, same timer.
    await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
    clock.advance(1800);
    const second = (await t.fetchJson('POST', `/api/timers/${timer.id}/stop`)).body;
    assert.equal(second.entry.id, id, 'precondition: still the same entry');
    assert.equal(second.entry.total, 1.5, 'precondition: the app now records and shows 1.5 h');

    // 4. Close the day out. finalize-day sends ack date-wide; sum_mismatch is
    //    only a WARN, so one click clears it.
    const day = await t.fetchJson('POST', '/api/finalize-day', { date: TODAY, ack: true });
    assert.deepEqual(day.body.blocked, [], 'precondition: nothing blocks the close-out');

    const exp = (await t.fetchJson('POST', '/api/export', { from: TODAY, to: TODAY })).body;
    const csv = csvRowsFor(exp.csv, id);
    const tim = timSecondsFor(exp.tim);

    // What SQLite actually holds.
    const row = storedEntry(t, id);
    const lines = storedLines(t, id);
    const evidence = `\n  DB entries.total_override=${row.total_override}`
      + `\n  DB entry_tasks=[${lines.map((l) => `${l.task_code}=${l.duration}`).join(', ')}] sum=${lineSum(lines)}`
      + `\n  DB narrative=${JSON.stringify(row.narrative)} (allocations sum ${allocationsIn(row.narrative)})`
      + `\n  CSV rows=${csv.rows.length} duration column sums to ${csv.durationSum}`
      + `\n  CSV entry_total column=${csv.entryTotal}`
      + `\n  .TIM am=${tim[0]}s = ${tim[0] / 3600}h`
      + `\n  screen/API entry.total=${second.entry.total}`;

    // Record the divergence in the DB first — this is the root cause.
    assert.equal(lineSum(lines), row.total_override,
      `the task lines no longer add up to the billed total —${evidence}`);

    // Then the file. One export click, two numbers.
    assert.equal(csv.durationSum, 1.5,
      `the CSV duration column bills ${csv.durationSum}h for an entry the app records, `
      + `shows, and .TIM-exports as 1.5h —${evidence}`);
  }));

// ===========================================================================
// PROVES 2 — the one-tap path. timergrid.js entryTotalSet() PATCHes
// total_override alone when the hours on a Today row are retyped.
// ===========================================================================
test('PROVES: retyping the hours on a Today row pushes the CSV duration column away from the total', () =>
  withServer(async (t) => {
    const acme = await mkCm(t, '100001-000012', 'Acme lease');
    const e = (await t.fetchJson('POST', '/api/entries', {
      date: TODAY, cm_id: acme.id,
      narrative: 'Reviewed the lease amendment and conferred with the client.',
      tasks: [{ task_code: 'Review', duration: 1.5, fragment: 'reviewed lease amendment' }],
    })).body;

    // The exact request public/js/components/timergrid.js entryTotalSet() makes.
    const patched = await t.fetchJson('PATCH', `/api/entries/${e.id}`, { total_override: 2.0 });
    assert.equal(patched.body.total, 2, 'precondition: the app now shows 2.0 h');

    const f = await t.fetchJson('POST', `/api/entries/${e.id}/finalize`, { ack: true });
    assert.equal(f.status, 200, JSON.stringify(f.body));

    const exp = (await t.fetchJson('POST', '/api/export', { from: TODAY, to: TODAY })).body;
    const csv = csvRowsFor(exp.csv, e.id);
    const tim = timSecondsFor(exp.tim);
    const lines = storedLines(t, e.id);

    const evidence = `\n  DB total_override=${storedEntry(t, e.id).total_override}`
      + `\n  DB entry_tasks sum=${lineSum(lines)}`
      + `\n  CSV duration column=${csv.durationSum}, CSV entry_total=${csv.entryTotal}`
      + `\n  .TIM am=${tim[0]}s = ${tim[0] / 3600}h, screen=2`;

    assert.equal(csv.durationSum, 2,
      `30 minutes separate the CSV duration column from every other number this `
      + `export produced —${evidence}`);
  }));

// ===========================================================================
// PROVES 3 — the same gap OVER-bills when the lines exceed the override.
// ===========================================================================
test('PROVES: task lines above the override make the CSV duration column over-bill', () =>
  withServer(async (t) => {
    const acme = await mkCm(t, '100001-000012', 'Acme lease');
    const e = (await t.fetchJson('POST', '/api/entries', {
      date: TODAY, cm_id: acme.id,
      narrative: 'Drafted the settlement agreement (1.4); revised the settlement agreement (1.1).',
      tasks: [
        { task_code: 'Draft', duration: 1.4, fragment: 'drafted settlement agreement' },
        { task_code: 'Review', duration: 1.1, fragment: 'revised settlement agreement' },
      ],
    })).body;
    await t.fetchJson('PATCH', `/api/entries/${e.id}`, { total_override: 2.0 });
    await t.fetchJson('POST', `/api/entries/${e.id}/finalize`, { ack: true });

    const exp = (await t.fetchJson('POST', '/api/export', { from: TODAY, to: TODAY })).body;
    const csv = csvRowsFor(exp.csv, e.id);
    const tim = timSecondsFor(exp.tim);
    assert.equal(csv.durationSum, 2.0,
      `the CSV duration column bills ${csv.durationSum}h for an entry recorded, shown and `
      + `.TIM-exported as 2.0h (.TIM am=${tim[0]}s)`);
  }));

// ===========================================================================
// PROVES 4 — the third write path, and the one no test covered at all.
//
// server/routes/entries.js settleRunningTimers() books a RUNNING timer's live
// clock onto its entry as the day is closed out. Until 2026-08-16 it carried a
// pre-Stage-1e rule — "a single task line mirrors the total; user-added splits
// are left alone" — so finalizing a SPLIT entry while its timer ran stored
// total_override 1.5 over lines still summing to 1.0. The .TIM said am=5400 and
// the CSV duration column — the column the assistant keys from — said 1.0.
// Half an hour vanished from a finalized, exportable entry.
//
// Nothing unusual is done here: split an entry in the editor, leave the timer
// running, close the day out. Written 2026-08-16 (Lane C) because the gap was
// live and unproven.
// ===========================================================================
test('PROVES: closing the day out on a SPLIT entry whose timer is still running loses half an hour', () =>
  withServer(async (t, clock) => {
    const acme = await mkCm(t, '100001-000012', 'Acme lease');
    const timer = (await t.fetchJson('POST', '/api/timers', {
      name: 'Acme lease', cm_id: acme.id,
    })).body;

    // An hour of work, filed.
    await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
    clock.advance(3600);
    const id = (await t.fetchJson('POST', `/api/timers/${timer.id}/stop`)).body.entry.id;

    // Split it in the editor, exactly as entryeditor.js doPersist() does.
    await t.fetchJson('PATCH', `/api/entries/${id}`, {
      total_override: 1,
      tasks: [
        { task_code: 'Review', duration: 0.5, fragment: 'review lease amendment' },
        { task_code: 'Draft', duration: 0.5, fragment: 'draft email to landlord' },
      ],
    });

    // Back on it, and STILL RUNNING when the day is closed out — the clock's
    // extra half hour has never reached the entry.
    await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
    clock.advance(1800);
    const day = await t.fetchJson('POST', '/api/finalize-day', { date: TODAY, ack: true });
    assert.deepEqual(day.body.blocked, [], 'precondition: nothing blocks the close-out');

    const row = storedEntry(t, id);
    const lines = storedLines(t, id);
    assert.equal(row.status, 'finalized', 'precondition: the entry is locked and exportable');
    assert.equal(row.total_override, 1.5,
      'precondition: close-out settled the live clock onto the entry');

    const exp = (await t.fetchJson('POST', '/api/export', { from: TODAY, to: TODAY })).body;
    const csv = csvRowsFor(exp.csv, id);
    const tim = timSecondsFor(exp.tim);
    const evidence = `\n  DB total_override=${row.total_override}`
      + `\n  DB entry_tasks=[${lines.map((l) => `${l.task_code}=${l.duration}`).join(', ')}] sum=${lineSum(lines)}`
      + `\n  DB narrative=${JSON.stringify(row.narrative)} (allocations sum ${allocationsIn(row.narrative)})`
      + `\n  CSV duration column=${csv.durationSum}, CSV entry_total=${csv.entryTotal}`
      + `\n  .TIM am=${tim[0]}s = ${tim[0] / 3600}h`;

    assert.equal(lineSum(lines), row.total_override,
      `the settled total left the task lines behind —${evidence}`);
    assert.equal(csv.durationSum, 1.5,
      `the CSV duration column bills ${csv.durationSum}h against a .TIM that ships `
      + `${tim[0] / 3600}h —${evidence}`);
    assert.equal(tim[0], 5400, `the .TIM ships the settled 1.5h —${evidence}`);
    assert.equal(allocationsIn(row.narrative), 1.5,
      `and the sentence on the bill accounts for every settled hour —${evidence}`);
  }));

// ===========================================================================
// FACT — the entry total is present on every CSV row in `entry_total`, and it
// now AGREES with the duration column it used to contradict.
//
// Rewritten 2026-08-16 (Lane C). Until the reconcile landed on all three write
// paths this test recorded the gap — entry_total 2, duration 1.5 — to bound the
// finding: the hours were never absent from the file, only contradicted inside
// it. The contradiction is what was fixed, so the FACT now records the two
// columns agreeing; asserting the old numbers would be asserting the defect.
// ===========================================================================
test('FACT: the CSV entry_total and duration columns now report the same hours', () =>
  withServer(async (t) => {
    const acme = await mkCm(t, '100001-000012', 'Acme lease');
    const e = (await t.fetchJson('POST', '/api/entries', {
      date: TODAY, cm_id: acme.id,
      narrative: 'Reviewed the lease amendment and conferred with the client.',
      tasks: [{ task_code: 'Review', duration: 1.5, fragment: 'reviewed lease amendment' }],
    })).body;
    await t.fetchJson('PATCH', `/api/entries/${e.id}`, { total_override: 2.0 });
    await t.fetchJson('POST', `/api/entries/${e.id}/finalize`, { ack: true });
    const exp = (await t.fetchJson('POST', '/api/export', { from: TODAY, to: TODAY })).body;
    const csv = csvRowsFor(exp.csv, e.id);
    assert.equal(csv.entryTotal, 2, 'entry_total column carries the entry hours');
    assert.equal(csv.durationSum, 2, 'duration column carries the same hours');
    assert.equal(csv.entryTotal, csv.durationSum,
      'the two columns of the SAME csv row agree');
    // …and the stored line was moved, not a formatter applied at export time.
    assert.deepEqual(storedLines(t, e.id).map((l) => l.duration), [2]);
  }));

// ===========================================================================
// FACT — the narrative follows the hours. On a task-billed client the sentence
// that lands on the bill prints allocations, and they add up to the hours
// billed. This is the client-facing half of the same root cause.
//
// Rewritten 2026-08-16 (Lane C): this recorded 1.0h of allocations on a 1.5h
// entry while the drift existed.
// ===========================================================================
test('FACT: the client-facing narrative prints allocations that add up to the billed hours', () =>
  withServer(async (t, clock) => {
    const acme = await mkCm(t, '100001-000012', 'Acme lease');
    const timer = (await t.fetchJson('POST', '/api/timers', {
      name: 'Acme lease', cm_id: acme.id,
    })).body;
    await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
    clock.advance(3600);
    const id = (await t.fetchJson('POST', `/api/timers/${timer.id}/stop`)).body.entry.id;
    await t.fetchJson('PATCH', `/api/entries/${id}`, {
      total_override: 1,
      tasks: [
        { task_code: 'Review', duration: 0.5, fragment: 'review lease amendment' },
        { task_code: 'Draft', duration: 0.5, fragment: 'draft email to landlord' },
      ],
    });
    await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
    clock.advance(1800);
    await t.fetchJson('POST', `/api/timers/${timer.id}/stop`);

    const row = storedEntry(t, id);
    assert.equal(row.total_override, 1.5, 'the entry bills 1.5h');
    assert.equal(allocationsIn(row.narrative), 1.5,
      `the narrative on the bill accounts for all 1.5h: ${JSON.stringify(row.narrative)}`);
    assert.equal(lineSum(storedLines(t, id)), 1.5, 'because the task lines do');
  }));

// ===========================================================================
// FACT — sum_mismatch is still only a WARN in server/lib/validation.js, and
// every ordinary finalize path sends ack:true. That is what made the drift
// reachable rather than theoretical, and the validator has NOT been changed.
//
// Rewritten 2026-08-16 (Lane C). The original stimulus — PATCH total_override
// alone onto a one-line entry — can no longer produce a mismatch at all, which
// is the fix. So this test now records BOTH halves:
//   (a) the app path no longer produces the warning: a bare finalize succeeds;
//   (b) a database that already holds a drifted row (written before the
//       reconcile landed) still warns rather than blocks, and one ack still
//       carries it into both files — nothing is stranded by the fix.
// ===========================================================================
test('FACT: the app no longer produces sum_mismatch; a legacy drifted row still warns, not blocks', () =>
  withServer(async (t) => {
    const acme = await mkCm(t, '100001-000012', 'Acme lease');
    const e = (await t.fetchJson('POST', '/api/entries', {
      date: TODAY, cm_id: acme.id,
      narrative: 'Reviewed the lease amendment and conferred with the client.',
      tasks: [{ task_code: 'Review', duration: 1.5, fragment: 'reviewed lease amendment' }],
    })).body;
    // (a) the one-tap path timergrid.js entryTotalSet() takes.
    await t.fetchJson('PATCH', `/api/entries/${e.id}`, { total_override: 2.0 });
    const clean = await t.fetchJson('POST', `/api/entries/${e.id}/finalize`, {});
    assert.equal(clean.status, 200,
      'no ack needed: the lines were reconciled to the total, so there is no mismatch to warn about');
    assert.equal(lineSum(storedLines(t, e.id)), 2);

    // (b) a row that drifted before the fix — written straight into SQLite,
    //     because no route will produce one any more.
    const legacy = (await t.fetchJson('POST', '/api/entries', {
      date: TODAY, cm_id: acme.id,
      narrative: 'Attended to the lease file.',
      tasks: [{ task_code: 'Review', duration: 1.5, fragment: 'reviewed lease amendment' }],
    })).body;
    t.db.prepare('UPDATE entries SET total_override=2.0 WHERE id=?').run(legacy.id);

    const blocked = await t.fetchJson('POST', `/api/entries/${legacy.id}/finalize`, {});
    assert.equal(blocked.status, 422);
    assert.deepEqual(blocked.body.blocks, [], 'nothing BLOCKS it');
    assert.deepEqual(blocked.body.warns.map((w) => w.code), ['sum_mismatch'],
      'the only thing in the way is one ack-able warning');

    const ok = await t.fetchJson('POST', `/api/entries/${legacy.id}/finalize`, { ack: true });
    assert.equal(ok.status, 200, 'ack:true — the shape close-out, bulk finalize and the editor send');
    const exp = (await t.fetchJson('POST', '/api/export', { from: TODAY, to: TODAY })).body;
    assert.equal(exp.count, 2, 'and both reach the export');
  }));

// ===========================================================================
// CONTROL — with no override and no split, every number agrees. This isolates
// the defect to the total_override-vs-lines divergence, not to the export.
// ===========================================================================
test('CONTROL: an ordinary entry whose lines match its total agrees everywhere', () =>
  withServer(async (t) => {
    const acme = await mkCm(t, '100001-000012', 'Acme lease');
    const e = (await t.fetchJson('POST', '/api/entries', {
      date: TODAY, cm_id: acme.id,
      narrative: 'Reviewed the lease amendment and conferred with the client.',
      tasks: [
        { task_code: 'Review', duration: 0.8, fragment: 'reviewed lease amendment' },
        { task_code: 'Confer', duration: 0.7, fragment: 'conferred with client' },
      ],
      total_override: 1.5,
    })).body;
    await t.fetchJson('POST', `/api/entries/${e.id}/finalize`, { ack: true });
    const exp = (await t.fetchJson('POST', '/api/export', { from: TODAY, to: TODAY })).body;
    const csv = csvRowsFor(exp.csv, e.id);
    assert.equal(csv.durationSum, 1.5);
    assert.equal(csv.entryTotal, 1.5);
    assert.equal(timSecondsFor(exp.tim)[0], 5400);
  }));

// ===========================================================================
// SCOPE — this is an HOURS defect. Confirm no narrative crosses a matter
// boundary anywhere in the sequence, so it is not mis-filed as a leak.
// ===========================================================================
test('SCOPE: no narrative crosses a matter boundary in any of these sequences', () =>
  withServer(async (t, clock) => {
    const acme = await mkCm(t, '100001-000012', 'Acme lease');
    const north = await mkCm(t, '200002-000001', 'Northgate merger');
    const timer = (await t.fetchJson('POST', '/api/timers', {
      name: 'Acme lease', cm_id: acme.id,
    })).body;
    await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
    clock.advance(3600);
    const id = (await t.fetchJson('POST', `/api/timers/${timer.id}/stop`)).body.entry.id;
    await t.fetchJson('PATCH', `/api/entries/${id}`, {
      total_override: 1,
      tasks: [
        { task_code: 'Review', duration: 0.5, fragment: 'review lease amendment' },
        { task_code: 'Draft', duration: 0.5, fragment: 'draft email to landlord' },
      ],
    });
    await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
    clock.advance(1800);
    await t.fetchJson('POST', `/api/timers/${timer.id}/stop`);

    const rows = t.db.prepare(
      'SELECT id, cm_id, narrative FROM entries WHERE deleted_at IS NULL').all();
    for (const r of rows) {
      assert.equal(r.cm_id, acme.id,
        `every entry stays on Acme; none landed on Northgate (${north.id})`);
    }
    assert.equal(rows.length, 1, 'exactly one entry exists, on its own matter');
  }));
