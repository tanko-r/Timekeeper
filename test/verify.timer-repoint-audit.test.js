// ---------------------------------------------------------------------------
// ADVERSARIAL VERIFICATION of the claim:
//   "Re-pointing a timer moves an ever-finalized entry to a new matter with no
//    audit row" — server/routes/timers.js PATCH /:id, the `associate` branch.
//
// THIS FILE CONTAINS PROVING TESTS. They are written to FAIL while the defect
// exists. Do NOT weaken an assertion to make the suite green — fix the server.
//
// Test 1 (PROVING, expected to FAIL): the timer surface moves an entry that has
//   already been finalized once from matter A to matter B and writes no
//   audit_log row. Verified by reading the sqlite tables directly, not the API.
// Test 2 (CONTROL, expected to PASS): the identical move made through
//   PATCH /api/entries/:id on an identically-prepared entry DOES write an
//   audit row. This is what makes test 1 an inconsistency and not a policy.
// Test 3 (SCOPE, expected to PASS): a never-finalized entry is audited by
//   neither route — so the gap is specific to ever_finalized entries.
//
// --- SCAFFOLD REPAIR, 2026-08-16 (Lane C) ----------------------------------
// The owner decided on 2026-08-16 that re-pointing a timer whose linked entry
// already holds FILED hours must ASK each time — leave the time on the old
// matter, or move it too — because moving it carries the old matter's narrative
// across a matter boundary. So PATCH /api/timers/:id now takes an explicit
// `move_entry` flag and ABSENT MEANS DO NOT MOVE.
//
// That changes the STIMULUS these tests need, not what they prove. Test 1's
// specification assertion is unchanged and still reads exactly as written by
// the verifier: an ever-finalized entry that changes matter must leave an audit
// row. It is now driven with `move_entry: true`, which is the request the
// dialog makes when the owner says "move it too" — the only request that still
// performs the move test 1 was written about.
//
// Tests 4–6 were ADDED to cover the new default and the double-file trap it
// opens; none of them relaxes anything.
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

const START = '2026-08-14T09:00:00-07:00';

async function withServer(fn) {
  const clock = makeClock(START);
  const t = await startTestServer({ clock });
  try { await fn(t, clock); } finally { await t.close(); }
}

const mkCm = (t, cm_number, short_name) =>
  t.fetchJson('POST', '/api/cms', { cm_number, short_name, billable: 1 })
    .then((r) => r.body);

// Drive the app exactly as a user would: timer → stop → narrative → finalize →
// unlock → resume the timer from the entry card (POST /api/timers/start-for-entry,
// which is what the entry's "start timer" control calls) → stop.
// Returns { timerId, entryId } with the entry in status=draft, ever_finalized=1
// and a live timer link — the state the associate branch acts on.
async function unlockedEntryWithLiveTimer(t, clock, cm, narrative) {
  const timer = (await t.fetchJson('POST', '/api/timers', {
    name: cm.short_name, cm_id: cm.id,
  })).body;
  await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
  clock.advance(3600);
  const stop = (await t.fetchJson('POST', `/api/timers/${timer.id}/stop`)).body;
  const entryId = stop.entry.id;
  await t.fetchJson('PATCH', `/api/entries/${entryId}`, { narrative });
  const fin = await t.fetchJson('POST', `/api/entries/${entryId}/finalize`, { ack: true });
  assert.equal(fin.status, 200, `finalize failed: ${JSON.stringify(fin.body)}`);
  const unl = await t.fetchJson('POST', `/api/entries/${entryId}/unlock`);
  assert.equal(unl.status, 200, `unlock failed: ${JSON.stringify(unl.body)}`);
  const relink = await t.fetchJson('POST', '/api/timers/start-for-entry', { entry_id: entryId });
  assert.equal(relink.status, 200, `start-for-entry failed: ${JSON.stringify(relink.body)}`);
  clock.advance(60);
  await t.fetchJson('POST', `/api/timers/${timer.id}/stop`);
  return { timerId: timer.id, entryId };
}

// --- helpers that read the STORED rows, never the API's view of them --------
const auditRows = (t, entryId) => t.db
  .prepare('SELECT id, action, detail, created_at FROM audit_log WHERE entry_id=? ORDER BY id')
  .all(entryId)
  .map((r) => ({ ...r, detail: JSON.parse(r.detail) }));

const entryRow = (t, entryId) => t.db
  .prepare('SELECT id, cm_id, narrative, status, ever_finalized, billable FROM entries WHERE id=?')
  .get(entryId);

// ---------------------------------------------------------------------------
// 1. PROVING — expected to FAIL until timers.js PATCH /:id audits the move.
// ---------------------------------------------------------------------------
test('PROVING: re-pointing a timer moves an ever-finalized entry with no audit row', () =>
  withServer(async (t, clock) => {
    const acme = await mkCm(t, '100001-000012', 'Acme lease');
    const verity = await mkCm(t, '200002-000001', 'Verity merger');
    const NARR = 'Review and analyze Acme lease amendment; call with landlord counsel.';

    const { timerId, entryId } = await unlockedEntryWithLiveTimer(t, clock, acme, NARR);

    const before = entryRow(t, entryId);
    assert.equal(before.cm_id, acme.id);
    assert.equal(before.ever_finalized, 1, 'precondition: entry has been finalized once');
    assert.equal(before.status, 'draft', 'precondition: entry was unlocked');
    assert.equal(
      t.db.prepare('SELECT linked_entry_id FROM timers WHERE id=?').get(timerId).linked_entry_id,
      entryId, 'precondition: the timer is linked to that entry again');
    const auditBefore = auditRows(t, entryId);

    // The whole user action: re-point the timer at another matter, and answer
    // "move the time too" to the question the owner asked for (2026-08-16).
    const patch = await t.fetchJson('PATCH', `/api/timers/${timerId}`,
      { cm_id: verity.id, move_entry: true });
    assert.equal(patch.status, 200);

    const after = entryRow(t, entryId);
    assert.equal(after.cm_id, verity.id, 'the entry followed the timer (documented behaviour)');
    assert.equal(after.narrative, NARR, 'and carried its Acme narrative onto the Verity matter');

    const added = auditRows(t, entryId).slice(auditBefore.length);
    assert.ok(
      added.some((x) => x.action === 'edit' && x.detail && x.detail.cm_id),
      `an ever-finalized entry moved ${acme.id} → ${verity.id} with no audit row. `
      + `Rows added by the move: ${JSON.stringify(added)}`,
    );
  }));

// ---------------------------------------------------------------------------
// 2. CONTROL — the same move through the entry editor. Expected to PASS.
// ---------------------------------------------------------------------------
test('CONTROL: the same matter move via PATCH /api/entries/:id IS audited', () =>
  withServer(async (t, clock) => {
    const acme = await mkCm(t, '100001-000012', 'Acme lease');
    const verity = await mkCm(t, '200002-000001', 'Verity merger');
    const NARR = 'Review and analyze Acme lease amendment; call with landlord counsel.';

    const { entryId } = await unlockedEntryWithLiveTimer(t, clock, acme, NARR);
    const auditBefore = auditRows(t, entryId);

    const patch = await t.fetchJson('PATCH', `/api/entries/${entryId}`, { cm_id: verity.id });
    assert.equal(patch.status, 200);

    assert.equal(entryRow(t, entryId).cm_id, verity.id);
    const added = auditRows(t, entryId).slice(auditBefore.length);
    const edit = added.find((x) => x.action === 'edit' && x.detail && x.detail.cm_id);
    assert.ok(edit, `entry editor wrote no audit row either: ${JSON.stringify(added)}`);
    assert.deepEqual(edit.detail.cm_id, [acme.id, verity.id],
      'the audit row names the matter it came from and the one it went to');
  }));

// ---------------------------------------------------------------------------
// 3. SCOPE — a never-finalized entry is audited by neither route. Expected PASS.
//    (Establishes that the gap in test 1 is specific to ever_finalized entries,
//    which is the only class the audit trail claims to cover.)
// ---------------------------------------------------------------------------
test('SCOPE: a never-finalized entry is audited by neither route', () =>
  withServer(async (t, clock) => {
    const acme = await mkCm(t, '100001-000012', 'Acme lease');
    const verity = await mkCm(t, '200002-000001', 'Verity merger');
    const timer = (await t.fetchJson('POST', '/api/timers', {
      name: 'Acme lease', cm_id: acme.id,
    })).body;
    await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
    clock.advance(3600);
    const entryId = (await t.fetchJson('POST', `/api/timers/${timer.id}/stop`)).body.entry.id;
    await t.fetchJson('PATCH', `/api/entries/${entryId}`, { narrative: 'Draft lease abstract.' });

    await t.fetchJson('PATCH', `/api/timers/${timer.id}`, { cm_id: verity.id });
    assert.equal(entryRow(t, entryId).cm_id, verity.id);
    assert.equal(entryRow(t, entryId).ever_finalized, 0);
    assert.equal(auditRows(t, entryId).length, 0,
      'draft entries are deliberately not audited by either route');
  }));

// ---------------------------------------------------------------------------
// 4. DEFAULT (added 2026-08-16, Lane C) — a request that says nothing about the
//    linked entry must NOT move it. Moving it carries the old matter's billing
//    sentence onto the new matter, which docs/ui/BRIEF.md forbids outright, so
//    silence has to mean "leave it".
// ---------------------------------------------------------------------------
test('DEFAULT: with no move_entry flag an ever-finalized entry stays on its own matter', () =>
  withServer(async (t, clock) => {
    const acme = await mkCm(t, '100001-000012', 'Acme lease');
    const verity = await mkCm(t, '200002-000001', 'Verity merger');
    const NARR = 'Review and analyze Acme lease amendment; call with landlord counsel.';

    const { timerId, entryId } = await unlockedEntryWithLiveTimer(t, clock, acme, NARR);

    const patch = await t.fetchJson('PATCH', `/api/timers/${timerId}`, { cm_id: verity.id });
    assert.equal(patch.status, 200);

    const after = entryRow(t, entryId);
    assert.equal(after.cm_id, acme.id,
      'the filed hours stayed on the matter they were filed against');
    assert.equal(after.narrative, NARR, 'and so did the sentence written for it');

    // and no Verity entry carries a syllable of Acme's narrative
    const onVerity = t.db.prepare(
      'SELECT id, narrative FROM entries WHERE cm_id=? AND deleted_at IS NULL').all(verity.id);
    for (const row of onVerity) {
      assert.notEqual(String(row.narrative || '').trim(), NARR,
        `entry ${row.id} carried the Acme sentence across the matter boundary`);
    }
  }));

// ---------------------------------------------------------------------------
// 5. THE DOUBLE-FILE TRAP (added 2026-08-16, Lane C) — the entry stays behind
//    holding its hours, so those hours must LEAVE the day clock before the
//    timer opens its next entry. Without the rebase the books show 2.0 h for
//    1.0 h worked: rule 2 of docs/ui/BRIEF.md, in one PATCH.
//
//    Both branches of the flag are checked, paused AND running, because the
//    rebase only runs on one of the four and a regression on any of them is
//    invisible from the response.
// ---------------------------------------------------------------------------
const bookedHours = (t) => Math.round(t.db.prepare(`SELECT COALESCE(SUM(
    CASE WHEN total_override IS NOT NULL THEN total_override
    ELSE (SELECT COALESCE(SUM(duration), 0) FROM entry_tasks WHERE entry_id = entries.id) END
  ), 0) h FROM entries WHERE deleted_at IS NULL`).get().h * 1e4) / 1e4;

for (const running of [false, true]) {
  for (const move of [false, true]) {
    test(`BOOKS: re-pointing a ${running ? 'RUNNING' : 'paused'} timer with move_entry=${move} `
      + 'files exactly the hours worked, not twice', () =>
      withServer(async (t, clock) => {
        const acme = await mkCm(t, '100001-000012', 'Acme lease');
        const verity = await mkCm(t, '200002-000001', 'Verity merger');

        // 1.0 h filed and finalized on Acme, then unlocked and the timer
        // relinked — exactly the state the consent gate acts on.
        const timer = (await t.fetchJson('POST', '/api/timers', {
          name: 'Acme lease', cm_id: acme.id,
        })).body;
        await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
        clock.advance(3600);
        const entryId = (await t.fetchJson('POST', `/api/timers/${timer.id}/stop`)).body.entry.id;
        await t.fetchJson('PATCH', `/api/entries/${entryId}`, { narrative: 'Review Acme lease amendment.' });
        assert.equal((await t.fetchJson('POST', `/api/entries/${entryId}/finalize`, { ack: true })).status, 200);
        await t.fetchJson('POST', `/api/entries/${entryId}/unlock`);
        await t.fetchJson('POST', '/api/timers/start-for-entry', { entry_id: entryId });
        // six more minutes on the same matter — 1.1 h worked in total
        clock.advance(360);
        if (!running) await t.fetchJson('POST', `/api/timers/${timer.id}/stop`);

        const body = { cm_id: verity.id };
        if (move) body.move_entry = true;
        assert.equal((await t.fetchJson('PATCH', `/api/timers/${timer.id}`, body)).status, 200);
        // settle whatever the clock still holds, so nothing is in flight
        await t.fetchJson('POST', `/api/timers/${timer.id}/stop`);

        assert.equal(bookedHours(t), 1.1,
          'the books hold exactly the 1.1 h worked — '
          + `rows: ${JSON.stringify(t.db.prepare('SELECT id, cm_id, total_override FROM entries WHERE deleted_at IS NULL').all())}`);
      }));
  }
}

// ---------------------------------------------------------------------------
// 6. QUICK TIMER (added 2026-08-16, Lane C) — a MATTERLESS timer being given
//    its FIRST matter is not the consent case: nothing was ever written against
//    another matter, so the entry follows the timer silently, with or without
//    the flag, ever_finalized or not.
// ---------------------------------------------------------------------------
test('QUICK TIMER: a matterless entry still follows its timer silently, with no flag', () =>
  withServer(async (t, clock) => {
    const acme = await mkCm(t, '100001-000012', 'Acme lease');
    const timer = (await t.fetchJson('POST', '/api/timers', { name: 'Quick timer' })).body;
    assert.equal(timer.cm_id, null, 'precondition: no matter');
    await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
    clock.advance(3600);
    const entryId = (await t.fetchJson('POST', `/api/timers/${timer.id}/stop`)).body.entry.id;
    assert.equal(entryRow(t, entryId).cm_id, null, 'precondition: matterless entry holds the hour');

    assert.equal((await t.fetchJson('PATCH', `/api/timers/${timer.id}`, { cm_id: acme.id })).status, 200);

    assert.equal(entryRow(t, entryId).cm_id, acme.id,
      'the matterless entry was associated in place, not left behind');
    assert.equal(
      t.db.prepare('SELECT COUNT(*) c FROM entries WHERE deleted_at IS NULL').get().c, 1,
      'and no second entry opened — the hour is filed once');
  }));
