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

    // The whole user action: re-point the timer at another matter.
    const patch = await t.fetchJson('PATCH', `/api/timers/${timerId}`, { cm_id: verity.id });
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
