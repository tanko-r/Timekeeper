// ---------------------------------------------------------------------------
// ADVERSARIAL VERIFICATION of the claim:
//   "Bulk matter reassignment has no audit row and no route back"
//   (server/routes/entries.js — POST /api/entries/bulk case 'set_cm', and
//    recordAudit()'s `if (!beforeRow.ever_finalized) return;` gate)
//
// EVERY TEST IN THIS FILE IS A *PROVING* TEST. Each asserts the rule the brief
// states (docs/ui/BRIEF.md §"Data integrity") and each FAILS against the code
// as it stands on ui-overhaul-2026-08. Do NOT weaken an assertion to make the
// suite green — fix the server.
//
// Unlike the claimant's version, these tests read the SQLite database directly
// after the write, so the evidence is stored rows, not API shape:
//   V1  two matters' narratives land on a third matter and NO row in ANY table
//       records the cm_id they came from  (proves: no route back)
//   V2  control — the same bulk call on an entry that has EVER been finalized
//       DOES write the audit row, so the gate is `ever_finalized` and nothing
//       else (proves the mechanism, not a coincidence)
//   V3  a SOFT-DELETED entry is silently reassigned by the same bulk call and
//       resurfaces on the wrong matter when restored
//   V4  the reassigned entry keeps the OLD matter's billable flag, unlike the
//       timer re-point path (routes/timers.js line ~344) which adopts the new
//       matter's flag
// ---------------------------------------------------------------------------
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

const TODAY = '2026-08-14';
const START = '2026-08-14T09:00:00-07:00';

function makeClock(startIso) {
  let now = new Date(startIso).getTime();
  const clock = () => new Date(now);
  clock.set = (iso) => { now = new Date(iso).getTime(); };
  clock.advance = (seconds) => { now += seconds * 1000; };
  return clock;
}

async function withServer(fn, startIso = START) {
  const clock = makeClock(startIso);
  const t = await startTestServer({ clock });
  try { await fn(t, clock); } finally { await t.close(); }
}

const mkCm = (t, cm_number, short_name, extra = {}) =>
  t.fetchJson('POST', '/api/cms', { cm_number, short_name, billable: 1, ...extra })
    .then((r) => r.body);

const mkEntry = (t, cm_id, narrative, extra = {}) =>
  t.fetchJson('POST', '/api/entries', {
    date: TODAY, cm_id, narrative,
    tasks: [{ task_code: 'Review', duration: 0.5, fragment: '' }],
    ...extra,
  }).then((r) => r.body);

// Every user-visible table in the schema, so "nothing anywhere records it" is
// a statement about the whole database and not about one table I happened to
// think of.
function everyTable(db) {
  return db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
  ).all().map((r) => r.name);
}

// Does ANY row in ANY table still hold the old matter id in a way that could
// reconstruct the assignment? Returns the matching rows.
function tracesOf(db, entryId, oldCmId) {
  const hits = [];
  for (const table of everyTable(db)) {
    let rows;
    try { rows = db.prepare(`SELECT * FROM "${table}"`).all(); } catch { continue; }
    for (const row of rows) {
      const blob = JSON.stringify(row);
      // a trace has to tie THIS entry to the OLD matter to be a route back
      if (blob.includes(`"entry_id":${entryId}`) || (row.id === entryId && table === 'entries')) {
        if (blob.includes(String(oldCmId))) hits.push({ table, row });
      }
    }
  }
  return hits;
}

// ---------------------------------------------------------------------------
// V1 — the claim itself. A draft entry (the overwhelmingly common case: an
// entry that has never been finalized) is bulk-reassigned, and the database
// keeps no record of where it came from.
//
// BRIEF: "No silent overwrite without an undo." The narrative is the thing
// that moves, and it moves onto a matter it was not written for.
// ---------------------------------------------------------------------------
test('V1 (PROVING — expected to FAIL): a bulk matter reassignment of DRAFT entries leaves no stored record of the previous matter', () =>
  withServer(async (t) => {
    const easement = await mkCm(t, '100001-000012', 'Fairview easement');
    const lease = await mkCm(t, '100001-000077', 'Northgate lease');
    const merger = await mkCm(t, '200002-000001', 'Verity merger');

    const a = await mkEntry(t, easement.id,
      'Review recorded easement and prepare title objection letter.');
    const b = await mkEntry(t, lease.id,
      'Negotiate percentage rent clause with landlord counsel.');

    // Neither has ever been finalized — the ordinary state of an entry keyed
    // today and reassigned before the day is closed out.
    for (const e of [a, b]) {
      assert.equal(t.db.prepare('SELECT ever_finalized FROM entries WHERE id=?')
        .get(e.id).ever_finalized, 0);
    }

    const r = (await t.fetchJson('POST', '/api/entries/bulk', {
      ids: [a.id, b.id], action: 'set_cm', cm_id: merger.id,
    })).body;
    assert.deepEqual([...r.done].sort(), [a.id, b.id].sort());

    // READ THE DATABASE DIRECTLY. Two matters' narratives now sit on a third.
    const moved = t.db.prepare(
      'SELECT id, cm_id, narrative FROM entries WHERE cm_id=? ORDER BY id').all(merger.id);
    assert.equal(moved.length, 2, 'both narratives landed on the merger matter');
    assert.match(moved[0].narrative, /recorded easement/);
    assert.match(moved[1].narrative, /percentage rent/);

    // …and the audit table is empty, for both of them and in total.
    const auditRows = t.db.prepare('SELECT * FROM audit_log').all();
    assert.notEqual(
      auditRows.length, 0,
      `audit_log is EMPTY after reassigning ${r.done.length} entries across matters — ` +
      'the previous matter of every one of them is unrecoverable',
    );

    // And nothing anywhere else in the schema holds the old assignment either.
    for (const [e, oldCm] of [[a, easement.id], [b, lease.id]]) {
      const traces = tracesOf(t.db, e.id, oldCm);
      assert.notEqual(
        traces.length, 0,
        `no row in any table ties entry ${e.id} back to matter ${oldCm}`,
      );
    }
  }));

// ---------------------------------------------------------------------------
// V2 — CONTROL, and it PASSES today. The identical bulk call on an entry that
// has been finalized once (then unlocked) DOES write the audit row. This is
// what proves the mechanism the claimant named: recordAudit()'s ever_finalized
// gate, not some unrelated failure.
// ---------------------------------------------------------------------------
test('V2 (control — passes): the same bulk call DOES audit an entry that has ever been finalized', () =>
  withServer(async (t) => {
    const easement = await mkCm(t, '100001-000012', 'Fairview easement');
    const merger = await mkCm(t, '200002-000001', 'Verity merger');
    const e = await mkEntry(t, easement.id, 'Review recorded easement and prepare objection.');

    await t.fetchJson('POST', `/api/entries/${e.id}/finalize`, { ack: true });
    await t.fetchJson('POST', `/api/entries/${e.id}/unlock`);
    assert.equal(t.db.prepare('SELECT ever_finalized FROM entries WHERE id=?')
      .get(e.id).ever_finalized, 1);

    await t.fetchJson('POST', '/api/entries/bulk', {
      ids: [e.id], action: 'set_cm', cm_id: merger.id,
    });

    const edits = t.db.prepare(
      "SELECT detail FROM audit_log WHERE entry_id=? AND action='edit'").all(e.id);
    const withCm = edits.map((x) => JSON.parse(x.detail)).filter((d) => d.cm_id);
    assert.equal(withCm.length, 1, 'the ever-finalized entry got its matter move recorded');
    assert.deepEqual(withCm[0].cm_id, [easement.id, merger.id]);
  }));

// ---------------------------------------------------------------------------
// V3 — the same handler does not filter deleted_at. A soft-deleted entry is
// reassigned along with the live selection and comes back on the wrong matter.
// ---------------------------------------------------------------------------
test('V3 (PROVING — expected to FAIL): bulk set_cm must not reassign a SOFT-DELETED entry', () =>
  withServer(async (t) => {
    const acme = await mkCm(t, '100001-000012', 'Acme lease');
    const verity = await mkCm(t, '200002-000001', 'Verity merger');
    const e = await mkEntry(t, acme.id, 'Call with Acme GC re assignment consent.');

    await t.fetchJson('DELETE', `/api/entries/${e.id}`);
    assert.ok(t.db.prepare('SELECT deleted_at FROM entries WHERE id=?').get(e.id).deleted_at);

    const r = (await t.fetchJson('POST', '/api/entries/bulk', {
      ids: [e.id], action: 'set_cm', cm_id: verity.id,
    })).body;

    const after = t.db.prepare('SELECT cm_id, deleted_at, narrative FROM entries WHERE id=?').get(e.id);
    assert.equal(
      after.cm_id, acme.id,
      `a soft-deleted entry was reassigned from matter ${acme.id} to ${after.cm_id} ` +
      `(bulk reported done=${JSON.stringify(r.done)}); restoring it now surfaces ` +
      `"${after.narrative}" on the wrong matter`,
    );
  }));

// ---------------------------------------------------------------------------
// V4 — the new matter's billable flag is not adopted, unlike the timer
// re-point path (routes/timers.js: "the entry's billable was … the OLD
// matter's flag — either way the new matter's flag takes over").
// ---------------------------------------------------------------------------
test('V4 (PROVING — expected to FAIL): bulk set_cm must adopt the new matter’s billable flag', () =>
  withServer(async (t) => {
    const billed = await mkCm(t, '100001-000012', 'Acme lease', { billable: 1 });
    const pro = await mkCm(t, '900009-000001', 'Firm admin', { billable: 0 });
    const e = await mkEntry(t, billed.id, 'Review lease amendment.');
    assert.equal(t.db.prepare('SELECT billable FROM entries WHERE id=?').get(e.id).billable, 1);

    await t.fetchJson('POST', '/api/entries/bulk', {
      ids: [e.id], action: 'set_cm', cm_id: pro.id,
    });

    const after = t.db.prepare('SELECT cm_id, billable FROM entries WHERE id=?').get(e.id);
    assert.equal(after.cm_id, pro.id);
    assert.equal(
      after.billable, 0,
      'entry moved to a NON-billable matter but kept billable=1 — it will export as billable time',
    );
  }));

// ---------------------------------------------------------------------------
// V5 — the same billable defect, followed into the exported FILE, in the
// direction that costs money: an entry that started life on a non-billable
// matter is reassigned to a BILLABLE one and goes out of the door marked
// "non-billable".
//
// BRIEF: "Nothing that could cause the owner to leak billable time before an
// export or during one."
// ---------------------------------------------------------------------------
test('V5 (PROVING — expected to FAIL): time reassigned onto a billable matter must not export as non-billable', () =>
  withServer(async (t) => {
    const admin = await mkCm(t, '900009-000001', 'Firm admin', { billable: 0 });
    const acme = await mkCm(t, '100001-000012', 'Acme lease', { billable: 1 });

    const e = await mkEntry(t, admin.id, 'Review lease amendment and mark up assignment clause.');
    assert.equal(t.db.prepare('SELECT billable FROM entries WHERE id=?').get(e.id).billable, 0);

    await t.fetchJson('POST', '/api/entries/bulk', {
      ids: [e.id], action: 'set_cm', cm_id: acme.id,
    });
    await t.fetchJson('POST', `/api/entries/${e.id}/finalize`, { ack: true });

    const out = (await t.fetchJson('POST', '/api/export', {
      from: TODAY, to: TODAY, markExported: false,
    })).body;
    const line = out.csv.split('\n').find((l) => l.includes('100001-000012'));
    assert.ok(line, 'the reassigned entry reached the CSV');
    assert.match(
      line, /,billable,/,
      `0.5h on billable matter 100001-000012 exported as NON-billable: ${line}`,
    );
  }));
