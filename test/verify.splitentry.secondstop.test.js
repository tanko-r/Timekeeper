// ---------------------------------------------------------------------------
// ADVERSARIAL VERIFICATION of the claim:
//   "A second timer stop onto a split entry makes the narrative's allocations
//    contradict the exported hours."
//
// VERDICT: CONFIRMED. This file is a *PROVING* test — the first two tests
// FAIL against ui-overhaul-2026-08 as it stands. Do NOT weaken the assertions
// to make the suite green; fix syncToEntry() in server/routes/timers.js.
//
// MECHANISM (server/routes/timers.js syncToEntry, lines 62-71):
//   db.prepare('UPDATE entries SET total_override=? ...').run(hours, entry.id)
//   ...
//   if (lines.length === 1) { ...mirror hours onto the single line... }
//   syncNarrative(db, entry.id);
// The whole day clock is written to total_override unconditionally, but the
// task lines are only touched when there is exactly ONE of them ("user-added
// splits are left alone"). Once the attorney has split the entry in the
// editor, every later stop of the same timer raises the billed total while the
// task lines — and therefore the client-facing narrative built from them, and
// the per-line `duration` column of the CSV — stay at the old number.
//
// The control test at the bottom shows the same second stop is CORRECT on an
// unsplit entry, so the split is the trigger, not the second stop.
// ---------------------------------------------------------------------------
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';
import { parseCsv } from '../server/lib/csv.js';

function makeClock(startIso) {
  let now = new Date(startIso).getTime();
  const clock = () => new Date(now);
  clock.advance = (seconds) => { now += seconds * 1000; };
  return clock;
}

const TODAY = '2026-08-14';
const START = '2026-08-14T09:00:00-07:00';

async function withServer(fn) {
  const clock = makeClock(START);
  const t = await startTestServer({ clock });
  try {
    await fn(t, clock);
  } finally { await t.close(); }
}

const mkCm = (t, cm_number, short_name) =>
  t.fetchJson('POST', '/api/cms', { cm_number, short_name, billable: 1 }).then((r) => r.body);

// Sum of the "(0.5)" style allocations the task-billed narrative prints.
function allocationsIn(narrative) {
  const hits = String(narrative || '').match(/\(\s*(\d+(?:\.\d+)?)\s*\)/g) || [];
  return Math.round(hits.reduce((a, s) => a + Number(s.replace(/[()\s]/g, '')), 0) * 1e4) / 1e4;
}

// Read the task lines straight out of the database, not through the API.
function storedLines(t, entryId) {
  return t.db.prepare(
    'SELECT task_code, duration, fragment FROM entry_tasks WHERE entry_id=? ORDER BY sort_order, id'
  ).all(entryId);
}

function storedEntry(t, entryId) {
  return t.db.prepare(
    'SELECT id, cm_id, total_override, narrative, narrative_manual, status FROM entries WHERE id=?'
  ).get(entryId);
}

// The exact sequence the claim describes, run against a real server.
async function splitThenStopAgain(t, clock) {
  const acme = await mkCm(t, '100001-000012', 'Acme lease');
  const timer = (await t.fetchJson('POST', '/api/timers', {
    name: 'Acme lease', cm_id: acme.id,
  })).body;

  // 1. An hour on the matter.
  await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
  clock.advance(3600);
  const entryId = (await t.fetchJson('POST', `/api/timers/${timer.id}/stop`)).body.entry.id;

  // 2. The attorney splits that hour across two task lines in the editor.
  //    This payload is the shape public/js/components/entryeditor.js sends
  //    (doPersist: total_override = the entry total, tasks = the lines).
  const split = (await t.fetchJson('PATCH', `/api/entries/${entryId}`, {
    total_override: 1,
    tasks: [
      { task_code: 'Review', duration: 0.5, fragment: 'review lease amendment' },
      { task_code: 'Draft', duration: 0.5, fragment: 'draft email to landlord' },
    ],
  })).body;
  assert.equal(split.total, 1, 'precondition: the split still totals the hour worked');
  assert.equal(
    split.narrative,
    'Review lease amendment (0.5); draft email to landlord (0.5).',
    'precondition: the task-billed narrative is built from the two lines');

  // 3. Back on the same matter for another half hour, same timer.
  await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
  clock.advance(1800);
  const second = (await t.fetchJson('POST', `/api/timers/${timer.id}/stop`)).body;
  assert.equal(second.entry.id, entryId, 'precondition: it is still the same entry');
  assert.equal(second.entry.total, 1.5, 'precondition: the entry now bills the full 1.5h');

  return { entryId, timerId: timer.id, entry: second.entry };
}

// ---------------------------------------------------------------------------
// PROVING TEST 1 — the stored row. The sentence that lands on the client's
// bill accounts for fewer hours than the entry bills.
// ---------------------------------------------------------------------------
test('PROVES: a second stop onto a split entry leaves the narrative billing less than the entry', () =>
  withServer(async (t, clock) => {
    const { entryId } = await splitThenStopAgain(t, clock);

    const row = storedEntry(t, entryId);
    const lines = storedLines(t, entryId);
    const lineSum = Math.round(lines.reduce((a, l) => a + (Number(l.duration) || 0), 0) * 1e4) / 1e4;
    const evidence = `entries.total_override=${row.total_override}, `
      + `entry_tasks=[${lines.map((l) => `${l.task_code}=${l.duration}`).join(', ')}] `
      + `summing to ${lineSum}, narrative=${JSON.stringify(row.narrative)}`;

    // The two must agree: whatever the entry bills is what the narrative and
    // the task lines must account for.
    assert.equal(lineSum, row.total_override,
      `task lines no longer add up to the billed total — ${evidence}`);
    assert.equal(allocationsIn(row.narrative), row.total_override,
      `the narrative's allocations contradict the billed hours — ${evidence}`);
  }));

// ---------------------------------------------------------------------------
// PROVING TEST 2 — the file. The CSV that the assistant keys from and the
// .TIM the billing system ingests disagree with each other by the lost time.
// ---------------------------------------------------------------------------
test('PROVES: the exported CSV and .TIM disagree about the same entry’s hours', () =>
  withServer(async (t, clock) => {
    const { entryId } = await splitThenStopAgain(t, clock);

    // The mismatch is an ack-able WARNING, not a block — one click past it and
    // the day finalizes and exports.
    const blocked = await t.fetchJson('POST', `/api/entries/${entryId}/finalize`, {});
    assert.equal(blocked.status, 422);
    assert.deepEqual(blocked.body.warns.map((w) => w.code), ['sum_mismatch'],
      'the only thing standing between this entry and the file is one ack-able warning');
    const ok = await t.fetchJson('POST', `/api/entries/${entryId}/finalize`, { ack: true });
    assert.equal(ok.status, 200);

    const exp = (await t.fetchJson('POST', '/api/export', { from: TODAY, to: TODAY })).body;
    const rows = parseCsv(exp.csv);
    const header = rows[0];
    const body = rows.slice(1).filter((r) => String(r[header.indexOf('entry_id')]) === String(entryId));
    const durationCol = header.indexOf('duration');
    const totalCol = header.indexOf('entry_total');
    const csvLineHours = Math.round(
      body.reduce((a, r) => a + (Number(r[durationCol]) || 0), 0) * 1e4) / 1e4;
    const csvEntryTotal = Number(body[0][totalCol]);
    // .TIM carries the hours as seconds in the `am=` field.
    const timSeconds = Number((/(?:^|\|)am=(\d+)/.exec(exp.tim) || [])[1]);

    const evidence = `CSV duration column sums to ${csvLineHours}h across ${body.length} rows, `
      + `CSV entry_total says ${csvEntryTotal}h, .TIM am=${timSeconds}s `
      + `(${timSeconds / 3600}h), narrative=${JSON.stringify(body[0][header.indexOf('narrative')])}`;

    assert.equal(csvLineHours, csvEntryTotal,
      `the CSV contradicts itself — ${evidence}`);
    assert.equal(timSeconds, Math.round(csvLineHours * 3600),
      `the .TIM bills hours the CSV task lines never account for — ${evidence}`);
  }));

// ---------------------------------------------------------------------------
// CONTROL — the identical second stop on an UNSPLIT entry is correct. This is
// what isolates the defect to the `lines.length === 1` guard in syncToEntry.
// This test PASSES today and must keep passing after the fix.
// ---------------------------------------------------------------------------
test('CONTROL: a second stop onto an unsplit entry keeps its single line in step', () =>
  withServer(async (t, clock) => {
    const acme = await mkCm(t, '100001-000012', 'Acme lease');
    const timer = (await t.fetchJson('POST', '/api/timers', {
      name: 'Acme lease', cm_id: acme.id,
    })).body;

    await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
    clock.advance(3600);
    const entryId = (await t.fetchJson('POST', `/api/timers/${timer.id}/stop`)).body.entry.id;

    await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
    clock.advance(1800);
    const second = (await t.fetchJson('POST', `/api/timers/${timer.id}/stop`)).body;

    const row = storedEntry(t, entryId);
    const lines = storedLines(t, entryId);
    const lineSum = Math.round(lines.reduce((a, l) => a + (Number(l.duration) || 0), 0) * 1e4) / 1e4;
    assert.equal(second.entry.total, 1.5);
    assert.equal(lineSum, row.total_override,
      'unsplit: the single task line mirrors the clock, so nothing diverges');
    assert.deepEqual(
      second.entry.validation.filter((v) => v.code === 'sum_mismatch'), [],
      'unsplit: no sum_mismatch warning, because nothing is mismatched');
  }));

// ---------------------------------------------------------------------------
// SCOPE CHECK — this is an HOURS defect, not a matter-boundary defect. The
// narrative stays on its own matter throughout; nothing crosses a boundary.
// Recorded so the finding is not mis-filed as a cross-matter leak.
// ---------------------------------------------------------------------------
test('SCOPE: no narrative crosses a matter boundary in this sequence', () =>
  withServer(async (t, clock) => {
    const { entryId } = await splitThenStopAgain(t, clock);
    const row = storedEntry(t, entryId);
    const mine = t.db.prepare('SELECT cm_number FROM matters WHERE id=?').get(row.cm_id);
    assert.equal(mine.cm_number, '100001-000012');
    const others = t.db.prepare(
      'SELECT COUNT(*) c FROM entries WHERE cm_id IS NOT ? AND deleted_at IS NULL').get(row.cm_id).c;
    assert.equal(others, 0, 'only one matter exists — the text never left it');
  }));
