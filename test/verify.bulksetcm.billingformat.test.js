// ---------------------------------------------------------------------------
// ADVERSARIAL VERIFICATION of the claim:
//
//   "Bulk set_cm is the only matter-changing write that skips syncNarrative,
//    leaving the wrong billing format on the bill."
//
// THESE TESTS ARE *PROVING* TESTS. They assert the behaviour that SHOULD hold
// and FAIL against ui-overhaul-2026-08 where the defect is real. Do not weaken
// an assertion to make the suite green.
//
// Every assertion reads the SQLite row directly (t.db), not just the API
// payload, so the evidence is the stored value, not a view of it.
// ---------------------------------------------------------------------------
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

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
  try { await fn(t, clock); } finally { await t.close(); }
}

const mkCm = (t, cm_number, short_name, extra = {}) =>
  t.fetchJson('POST', '/api/cms', { cm_number, short_name, billable: 1, ...extra })
    .then((r) => r.body);

const rawRow = (t, id) => t.db.prepare(
  `SELECT e.id, e.cm_id, e.narrative, e.narrative_manual,
          m.cm_number, COALESCE(c.task_billing, 1) AS task_billing
     FROM entries e
     LEFT JOIN matters m ON m.id = e.cm_id
     LEFT JOIN clients c ON c.id = m.client_id
    WHERE e.id = ?`).get(id);

// ---------------------------------------------------------------------------
// V1 — exact reproduction as claimed: task-billed client → block-billed client.
// The stored narrative must be re-emitted in the NEW client's billing format,
// exactly as PATCH /api/entries/:id does for the same move.
// ---------------------------------------------------------------------------
test('V1 bulk set_cm onto a block-billed client must drop the per-line allocations', () =>
  withServer(async (t) => {
    const taskBilled = await mkCm(t, '100001-000012', 'Acme lease');
    const blockBilled = await mkCm(t, '300003-000001', 'Northgate co',
      { client_task_billing: 0 });

    const e = (await t.fetchJson('POST', '/api/entries', {
      date: TODAY, cm_id: taskBilled.id, narrative: '',
      tasks: [
        { task_code: 'Review', duration: 0.5, fragment: 'review lease' },
        { task_code: 'Draft', duration: 0.5, fragment: 'draft email to landlord' },
      ],
    })).body;
    assert.equal(rawRow(t, e.id).narrative,
      'Review lease (0.5); draft email to landlord (0.5).',
      'precondition: the task-billed client got allocations');

    const r = (await t.fetchJson('POST', '/api/entries/bulk', {
      ids: [e.id], action: 'set_cm', cm_id: blockBilled.id,
    })).body;
    assert.deepEqual(r.done, [e.id]);

    const after = rawRow(t, e.id);
    assert.equal(after.task_billing, 0, 'the entry really is on the block-billed client');
    assert.equal(after.narrative, 'Review lease; draft email to landlord.',
      `STORED narrative is still in the old client's task-billed format: ${JSON.stringify(after.narrative)}`);
  }));

// ---------------------------------------------------------------------------
// V2 — control: the SAME move through PATCH /api/entries/:id. This one passes
// today, which is what makes bulk the outlier rather than the format rule
// being unenforced everywhere.
// ---------------------------------------------------------------------------
test('V2 control: PATCH cm_id onto a block-billed client DOES reformat', () =>
  withServer(async (t) => {
    const taskBilled = await mkCm(t, '100001-000012', 'Acme lease');
    const blockBilled = await mkCm(t, '300003-000001', 'Northgate co',
      { client_task_billing: 0 });

    const e = (await t.fetchJson('POST', '/api/entries', {
      date: TODAY, cm_id: taskBilled.id, narrative: '',
      tasks: [
        { task_code: 'Review', duration: 0.5, fragment: 'review lease' },
        { task_code: 'Draft', duration: 0.5, fragment: 'draft email to landlord' },
      ],
    })).body;

    await t.fetchJson('PATCH', `/api/entries/${e.id}`, { cm_id: blockBilled.id });

    assert.equal(rawRow(t, e.id).narrative, 'Review lease; draft email to landlord.',
      'PATCH is the control path and is expected to reformat');
  }));

// ---------------------------------------------------------------------------
// V3 — the consequence the claim names: the stale format REACHES THE EXPORT
// FILE, and nothing in validation flags it on the way out. A block-billed
// client's CSV row carries "(0.5)" allocations it never contracted for.
// ---------------------------------------------------------------------------
test('V3 the stale task-billed narrative reaches the CSV with no warning', () =>
  withServer(async (t) => {
    const taskBilled = await mkCm(t, '100001-000012', 'Acme lease');
    const blockBilled = await mkCm(t, '300003-000001', 'Northgate co',
      { client_task_billing: 0 });

    const e = (await t.fetchJson('POST', '/api/entries', {
      date: TODAY, cm_id: taskBilled.id, narrative: '',
      tasks: [
        { task_code: 'Review', duration: 0.5, fragment: 'review lease' },
        { task_code: 'Draft', duration: 0.5, fragment: 'draft email to landlord' },
      ],
    })).body;
    await t.fetchJson('POST', '/api/entries/bulk', {
      ids: [e.id], action: 'set_cm', cm_id: blockBilled.id,
    });

    // Nothing warns the attorney that the format no longer matches the client.
    const reloaded = (await t.fetchJson('GET', `/api/entries/${e.id}`)).body;
    const codes = (reloaded.validation || []).map((f) => f.code);
    assert.ok(codes.length === 0 || !codes.includes('missing_allocations'),
      'sanity: block-billed clients are not asked for allocations');

    const fin = await t.fetchJson('POST', `/api/entries/${e.id}/finalize`, { ack: true });
    assert.equal(fin.status, 200, `finalize blocked: ${JSON.stringify(fin.body)}`);

    const exp = await t.fetchJson('POST', '/api/export', { from: TODAY, to: TODAY });
    assert.equal(exp.status, 200, JSON.stringify(exp.body));
    assert.equal(exp.body.count, 1, 'sanity: the entry is in the export');
    assert.ok(!/\(0\.5\)/.test(exp.body.csv),
      `the exported CSV carries the old client's allocations:\n${exp.body.csv}`);
    assert.ok(!/\(0\.5\)/.test(exp.body.text),
      `the exported text carries the old client's allocations:\n${exp.body.text}`);
  }));

// ---------------------------------------------------------------------------
// V4 — the "silent later reformat" half of the claim: after the bulk move the
// stored text is unstable. An UNRELATED later save (toggling billable — it
// touches no narrative and no task line) rewrites the narrative. What prints
// on the bill therefore depends on whether the attorney happened to reopen the
// entry. Both halves of this test are asserted against the raw row.
// ---------------------------------------------------------------------------
test('V4 an unrelated later save silently rewrites the narrative after a bulk move', () =>
  withServer(async (t) => {
    const taskBilled = await mkCm(t, '100001-000012', 'Acme lease');
    const blockBilled = await mkCm(t, '300003-000001', 'Northgate co',
      { client_task_billing: 0 });

    const e = (await t.fetchJson('POST', '/api/entries', {
      date: TODAY, cm_id: taskBilled.id, narrative: '',
      tasks: [
        { task_code: 'Review', duration: 0.5, fragment: 'review lease' },
        { task_code: 'Draft', duration: 0.5, fragment: 'draft email to landlord' },
      ],
    })).body;
    await t.fetchJson('POST', '/api/entries/bulk', {
      ids: [e.id], action: 'set_cm', cm_id: blockBilled.id,
    });
    const afterBulk = rawRow(t, e.id).narrative;

    // A save that mentions neither the narrative nor the tasks nor the matter.
    await t.fetchJson('PATCH', `/api/entries/${e.id}`, { billable: 0 });
    const afterTouch = rawRow(t, e.id).narrative;

    assert.equal(afterTouch, afterBulk,
      `the same entry billed two different ways depending on whether it was reopened:\n` +
      `  after bulk move : ${JSON.stringify(afterBulk)}\n` +
      `  after a billable toggle: ${JSON.stringify(afterTouch)}`);
  }));

// ---------------------------------------------------------------------------
// V5 — the OTHER direction, which the claim does not mention: block-billed →
// task-billed. The allocations the new client contracts for are missing. This
// direction IS caught by validation ('missing_allocations' warns at finalize),
// so it is the milder half. Asserted so the report can say which half is
// silent and which half is not.
// ---------------------------------------------------------------------------
test('V5 bulk set_cm onto a task-billed client must add the allocations', () =>
  withServer(async (t) => {
    const blockBilled = await mkCm(t, '300003-000001', 'Northgate co',
      { client_task_billing: 0 });
    const taskBilled = await mkCm(t, '100001-000012', 'Acme lease');

    const e = (await t.fetchJson('POST', '/api/entries', {
      date: TODAY, cm_id: blockBilled.id, narrative: '',
      tasks: [
        { task_code: 'Review', duration: 0.5, fragment: 'review lease' },
        { task_code: 'Draft', duration: 0.5, fragment: 'draft email to landlord' },
      ],
    })).body;
    assert.equal(rawRow(t, e.id).narrative, 'Review lease; draft email to landlord.');

    await t.fetchJson('POST', '/api/entries/bulk', {
      ids: [e.id], action: 'set_cm', cm_id: taskBilled.id,
    });
    const after = rawRow(t, e.id);
    assert.equal(after.narrative, 'Review lease (0.5); draft email to landlord (0.5).',
      `STORED narrative lacks the new client's required allocations: ${JSON.stringify(after.narrative)}`);
  }));

// ---------------------------------------------------------------------------
// V6 — NOT a narrative leak. Scoping check: after the bulk move, does any
// OTHER matter's narrative appear on this entry, or this entry's narrative on
// another matter's row? It must not — and it does not. Recorded so the report
// can say plainly that this defect is a billing-format defect, not a
// matter-boundary crossing under the brief.
// ---------------------------------------------------------------------------
test('V6 bulk set_cm moves no text between entries (this is a format bug, not a leak)', () =>
  withServer(async (t) => {
    const acme = await mkCm(t, '100001-000012', 'Acme lease');
    const northgate = await mkCm(t, '300003-000001', 'Northgate co',
      { client_task_billing: 0 });

    const mine = (await t.fetchJson('POST', '/api/entries', {
      date: TODAY, cm_id: acme.id, narrative: '',
      tasks: [
        { task_code: 'Review', duration: 0.5, fragment: 'review lease' },
        { task_code: 'Draft', duration: 0.5, fragment: 'draft email to landlord' },
      ],
    })).body;
    const other = (await t.fetchJson('POST', '/api/entries', {
      date: TODAY, cm_id: northgate.id,
      narrative: 'Telephone conference with R. Voss regarding the Northgate indemnity cap.',
      tasks: [{ task_code: 'Call/Conference', duration: 0.4, fragment: '' }],
    })).body;

    await t.fetchJson('POST', '/api/entries/bulk', {
      ids: [mine.id], action: 'set_cm', cm_id: northgate.id,
    });

    const movedText = rawRow(t, mine.id).narrative;
    assert.ok(!movedText.includes('R. Voss'),
      'the moved entry picked up the destination matter’s own narrative text');
    assert.equal(rawRow(t, other.id).narrative,
      'Telephone conference with R. Voss regarding the Northgate indemnity cap.',
      'the destination matter’s entry was rewritten by the move');
  }));

// ---------------------------------------------------------------------------
// V7 — second control, and a correction to the claim's wording. The claim says
// bulk set_cm is "the ONLY matter-changing write that skips syncNarrative".
// PATCH /api/timers/:id also moves entries.cm_id directly (timers.js, the
// `associate` branch) with no syncNarrative call of its own — but the
// `cmChanged && fresh.cm_id` block right after it calls syncToEntry(), which
// DOES call syncNarrative. So that path self-heals and bulk set_cm really is
// the outlier. This test PASSES today; it exists to pin the difference.
// ---------------------------------------------------------------------------
test('V7 control: re-pointing a timer to a block-billed matter DOES reformat', () =>
  withServer(async (t, clock) => {
    const taskBilled = await mkCm(t, '100001-000012', 'Acme lease');
    const blockBilled = await mkCm(t, '300003-000001', 'Northgate co',
      { client_task_billing: 0 });

    const timer = (await t.fetchJson('POST', '/api/timers', {
      name: 'Acme lease', cm_id: taskBilled.id,
    })).body;
    await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
    clock.advance(3600);
    const entryId = (await t.fetchJson('POST', `/api/timers/${timer.id}/stop`)).body.entry.id;
    await t.fetchJson('PATCH', `/api/entries/${entryId}`, {
      tasks: [
        { task_code: 'Review', duration: 0.5, fragment: 'review lease' },
        { task_code: 'Draft', duration: 0.5, fragment: 'draft email to landlord' },
      ],
    });
    assert.equal(rawRow(t, entryId).narrative,
      'Review lease (0.5); draft email to landlord (0.5).');

    // move_entry: this control is ABOUT the entry being reformatted for the new
    // client, so the entry has to move. Since 2026-08-16 that takes the
    // attorney's say-so (the owner's "ask me each time" rule).
    await t.fetchJson('PATCH', `/api/timers/${timer.id}`,
      { cm_id: blockBilled.id, move_entry: true });

    const after = rawRow(t, entryId);
    assert.equal(after.task_billing, 0, 'the entry followed the timer to the block-billed client');
    assert.equal(after.narrative, 'Review lease; draft email to landlord.',
      'the timer re-point path is expected to reformat — bulk set_cm is the outlier');
  }));
