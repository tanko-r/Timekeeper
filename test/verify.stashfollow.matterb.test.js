// =========================================================================
// ADVERSARIAL VERIFICATION — independent reproduction of the claim:
//
//   "A timer's stashed draft narrative follows the timer onto a different
//    matter and seeds its entry"
//   (server/routes/timers.js PATCH /:id line ~329 + syncToEntry() line ~78)
//
// THESE TESTS ARE WRITTEN TO PROVE A LEAK BY FAILING. Do not "fix the test"
// to make it pass. The assertion IS the specification (docs/ui/BRIEF.md,
// "Data integrity: non-negotiable"): a narrative written for matter A may
// never be shown as belonging to, suggested for, pre-filled into, or WRITTEN
// ONTO an entry for matter B — not across clients, and not between two
// matters of the SAME client.
//
// Written from scratch by the verifier, not copied from the claimant's
// test/integrity.entries.test.js. Every leak assertion reads the real SQLite
// row on a real server (test/helpers.js startTestServer) — nothing here is
// judged from an HTTP response body alone.
//
// The request bodies are the exact shapes the real UI sends:
//   stash   → public/js/lib/pip.js:444  PATCH {draft_narrative: text}
//   repoint → public/js/components/timergrid.js:1699 TimerModal.save
//             PATCH {name, cm_id, task_code, group_id, narrative_template}
//             — note it sends NOTHING about draft_narrative, so the stash is
//             invisible in the dialog that moves the matter.
//
// Expected on current code: LEAK A / B / C / D FAIL, CONTROL 1 / 2 pass.
// =========================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

function makeClock(startIso) {
  let now = new Date(startIso).getTime();
  const clock = () => new Date(now);
  clock.advance = (seconds) => { now += seconds * 1000; };
  return clock;
}

async function withServer(fn, startIso = '2026-08-14T09:00:00-07:00') {
  const clock = makeClock(startIso);
  const t = await startTestServer({ clock });
  try { return await fn(t, clock); } finally { await t.close(); }
}

async function mkCm(t, cm_number, short_name, client_name) {
  const r = await t.fetchJson('POST', '/api/cms', { cm_number, short_name, client_name, billable: 1 });
  assert.ok(r.status < 300, `cm create failed: ${JSON.stringify(r.body)}`);
  return r.body;
}

// House fictional names only (BRIEF: no real client/matter data in the repo).
const CM_PIER = '700010-000001';   // Northgate Partners — Pier 9 Sublease
const CM_YARD = '700010-000002';   // Northgate Partners — Yard Rezoning (SAME client)
const CM_ORION = '700020-000001';  // Verity Labs — Orion Acquisition (other client)

// A billing narrative, not reusable phrasing: it names the matter, the
// document, a counterparty and a date. Nothing about this sentence is
// "generic language" the brief says may be shared.
const PIER_NARRATIVE =
  'Revise Pier 9 sublease consent letter and confer with R. Okonkwo regarding '
  + 'the August 28 landlord response deadline.';
const PIER_FINGERPRINT = 'Pier 9 sublease consent letter';

// Every entry row in the database whose narrative carries the sentence, with
// the matter it is filed under. This is the "point at a row" evidence.
function rowsCarrying(t, fingerprint) {
  return t.db.prepare(
    `SELECT e.id AS entry_id, e.cm_id, e.date, e.status, e.deleted_at,
            m.cm_number, m.short_name, e.narrative
       FROM entries e LEFT JOIN matters m ON m.id = e.cm_id
      WHERE e.narrative LIKE '%' || ? || '%'
      ORDER BY e.id`
  ).all(fingerprint);
}

const foreignRows = (rows, ownCmId) =>
  rows.filter((r) => !r.deleted_at && r.cm_id !== ownCmId);

// -------------------------------------------------------------------------
// LEAK A — the claim as stated, cross-CLIENT, driven only through the API
// surfaces the real UI uses.
//
// Ordinary sequence: a pinned timer shows in the float window with no linked
// entry (every pinned timer is in that state each morning — applyRollovers
// sets linked_entry_id=NULL at the midnight reset). The attorney expands the
// row and types the narrative BEFORE starting the clock; pip.js narrativeMode
// === 'stash' so it goes to timers.draft_narrative. He then realises the work
// belongs to a different client, opens Edit timer, and switches the matter.
// -------------------------------------------------------------------------
test('LEAK A: a stash typed on Pier 9 is written onto the Orion entry (cross-client)', () =>
  withServer(async (t, clock) => {
    const pier = await mkCm(t, CM_PIER, 'Pier 9 Sublease', 'Northgate Partners');
    const orion = await mkCm(t, CM_ORION, 'Orion Acquisition', 'Verity Labs');

    const timer = (await t.fetchJson('POST', '/api/timers', {
      name: 'Pier 9 sublease', cm_id: pier.id,
    })).body;

    // float window, stash mode
    const stashed = await t.fetchJson('PATCH', `/api/timers/${timer.id}`,
      { draft_narrative: PIER_NARRATIVE });
    assert.equal(stashed.status, 200);
    assert.equal(
      t.db.prepare('SELECT draft_narrative d FROM timers WHERE id=?').get(timer.id).d,
      PIER_NARRATIVE, 'precondition: the stash is on the timer');

    // Edit-timer dialog, exact body shape (timergrid.js TimerModal.save)
    const repoint = await t.fetchJson('PATCH', `/api/timers/${timer.id}`, {
      name: 'Orion acquisition', cm_id: orion.id, task_code: null,
      group_id: null, narrative_template: null,
    });
    assert.equal(repoint.status, 200);
    assert.equal(repoint.body.cm_id, orion.id, 'precondition: the timer moved matters');

    // work the new matter normally
    await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
    clock.advance(1200);
    await t.fetchJson('POST', `/api/timers/${timer.id}/stop`);

    // ---- evidence: read SQLite, not the HTTP response ----
    const carriers = rowsCarrying(t, PIER_FINGERPRINT);
    assert.deepEqual(foreignRows(carriers, pier.id), [],
      'Pier 9’s billing sentence is stored on an entry belonging to another '
      + `client’s matter:\n${JSON.stringify(carriers, null, 2)}`);
  }));

// -------------------------------------------------------------------------
// LEAK B — same CLIENT, two matters. The brief bans this case explicitly
// ("not between two matters of the SAME client"), and it is the likelier one:
// re-pointing a timer between two matters of a client you already act for is
// a routine correction.
// -------------------------------------------------------------------------
test('LEAK B: the same stash lands on a SIBLING matter of the same client', () =>
  withServer(async (t, clock) => {
    const pier = await mkCm(t, CM_PIER, 'Pier 9 Sublease', 'Northgate Partners');
    const yard = await mkCm(t, CM_YARD, 'Yard Rezoning', 'Northgate Partners');

    const timer = (await t.fetchJson('POST', '/api/timers', {
      name: 'Pier 9 sublease', cm_id: pier.id,
    })).body;
    await t.fetchJson('PATCH', `/api/timers/${timer.id}`, { draft_narrative: PIER_NARRATIVE });
    await t.fetchJson('PATCH', `/api/timers/${timer.id}`, {
      name: 'Yard rezoning', cm_id: yard.id, task_code: null,
      group_id: null, narrative_template: null,
    });
    await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
    clock.advance(900);
    await t.fetchJson('POST', `/api/timers/${timer.id}/stop`);

    const carriers = rowsCarrying(t, PIER_FINGERPRINT);
    assert.deepEqual(foreignRows(carriers, pier.id), [],
      'Pier 9’s billing sentence is stored on a sibling matter’s entry:\n'
      + JSON.stringify(carriers, null, 2));
  }));

// -------------------------------------------------------------------------
// LEAK C — VARIATION: no start and no stop required; the re-point PATCH
// itself does it. Finalizing an entry zeroes and UNLINKS its timer while
// leaving it running (entries.js:513-522), so a running timer sits with
// linked_entry_id = NULL — pip.js narrativeMode() is 'stash' again and the
// next thing typed into the float window goes to draft_narrative. A running
// timer's matter change files its clock immediately (timers.js:353-362), so
// the PATCH creates the new matter's entry already carrying the old matter's
// sentence.
// -------------------------------------------------------------------------
test('LEAK C: the re-point PATCH alone files the stash into the new matter’s entry', () =>
  withServer(async (t, clock) => {
    const pier = await mkCm(t, CM_PIER, 'Pier 9 Sublease', 'Northgate Partners');
    const orion = await mkCm(t, CM_ORION, 'Orion Acquisition', 'Verity Labs');

    const timer = (await t.fetchJson('POST', '/api/timers', {
      name: 'Pier 9 sublease', cm_id: pier.id,
    })).body;

    // a block of Pier 9 time, finalized while the clock keeps running
    const started = (await t.fetchJson('POST', `/api/timers/${timer.id}/start`)).body;
    clock.advance(1800);
    await t.fetchJson('PATCH', `/api/entries/${started.entry.id}`,
      { narrative: 'Attend to Pier 9 sublease file.' });
    const fin = await t.fetchJson('POST', `/api/entries/${started.entry.id}/finalize`, { ack: true });
    assert.equal(fin.status, 200, `finalize failed: ${JSON.stringify(fin.body)}`);
    const after = t.db.prepare('SELECT running, linked_entry_id l FROM timers WHERE id=?')
      .get(timer.id);
    assert.equal(after.running, 1, 'precondition: the timer is still running');
    assert.equal(after.l, null, 'precondition: finalize unlinked it → stash mode');

    // more work happens, and the attorney types the next narrative into the
    // float window while the clock runs — stash mode, so it lands on the timer
    clock.advance(900);
    await t.fetchJson('PATCH', `/api/timers/${timer.id}`, { draft_narrative: PIER_NARRATIVE });

    // re-point only. No start. No stop.
    await t.fetchJson('PATCH', `/api/timers/${timer.id}`, {
      name: 'Orion acquisition', cm_id: orion.id, task_code: null,
      group_id: null, narrative_template: null,
    });

    const carriers = rowsCarrying(t, PIER_FINGERPRINT);
    assert.deepEqual(foreignRows(carriers, pier.id), [],
      'the re-point PATCH itself filed Pier 9’s sentence onto another '
      + `client’s entry:\n${JSON.stringify(carriers, null, 2)}`);
  }));

// -------------------------------------------------------------------------
// LEAK D — how far it travels. The seeded entry is an ordinary draft: it
// finalizes and exports like any other, so the leak leaves the building on a
// CSV line stamped with the OTHER client's matter number.
// -------------------------------------------------------------------------
test('LEAK D: the leaked sentence reaches the export CSV under the other client’s number', () =>
  withServer(async (t, clock) => {
    const pier = await mkCm(t, CM_PIER, 'Pier 9 Sublease', 'Northgate Partners');
    const orion = await mkCm(t, CM_ORION, 'Orion Acquisition', 'Verity Labs');
    const timer = (await t.fetchJson('POST', '/api/timers', {
      name: 'Pier 9 sublease', cm_id: pier.id, task_code: 'Research',
    })).body;
    await t.fetchJson('PATCH', `/api/timers/${timer.id}`, { draft_narrative: PIER_NARRATIVE });
    await t.fetchJson('PATCH', `/api/timers/${timer.id}`, {
      name: 'Orion acquisition', cm_id: orion.id, task_code: 'Research',
      group_id: null, narrative_template: null,
    });
    const started = (await t.fetchJson('POST', `/api/timers/${timer.id}/start`)).body;
    clock.advance(1800);
    await t.fetchJson('POST', `/api/timers/${timer.id}/stop`);
    const fin = await t.fetchJson('POST', `/api/entries/${started.entry.id}/finalize`, { ack: true });
    assert.equal(fin.status, 200, `finalize failed: ${JSON.stringify(fin.body)}`);
    const out = await t.fetchJson('POST', '/api/export', { from: '2026-08-14', to: '2026-08-14' });
    const csv = String((out.body && out.body.csv) || '');
    assert.equal(csv.includes(PIER_FINGERPRINT), false,
      `Pier 9’s sentence is in the exported CSV, on ${CM_ORION}’s line:\n${csv}`);
  }));

// -------------------------------------------------------------------------
// CONTROL 1 — the rig can tell "kept" from "cleared". suggested_narrative is
// nulled by the very same PATCH (timers.js:325); if this passes while the
// leaks fail, the difference is real and specific to draft_narrative.
// -------------------------------------------------------------------------
test('CONTROL 1: suggested_narrative IS dropped by the same re-point PATCH', () =>
  withServer(async (t) => {
    const pier = await mkCm(t, CM_PIER, 'Pier 9 Sublease', 'Northgate Partners');
    const orion = await mkCm(t, CM_ORION, 'Orion Acquisition', 'Verity Labs');
    const timer = (await t.fetchJson('POST', '/api/timers', {
      name: 'Pier 9 sublease', cm_id: pier.id,
    })).body;
    t.db.prepare('UPDATE timers SET suggested_narrative=? WHERE id=?')
      .run(PIER_NARRATIVE, timer.id);
    await t.fetchJson('PATCH', `/api/timers/${timer.id}`, {
      name: 'Orion acquisition', cm_id: orion.id, task_code: null,
      group_id: null, narrative_template: null,
    });
    assert.equal(
      t.db.prepare('SELECT suggested_narrative s FROM timers WHERE id=?').get(timer.id).s,
      null);
  }));

// -------------------------------------------------------------------------
// CONTROL 2 — the intended behaviour, which any fix must preserve:
//   (a) with NO matter change, the stash seeds the timer's next entry;
//   (b) a MATTERLESS quick timer's stash survives being given a matter — the
//       text was never written against another matter, so it is not a leak.
// A fix that just deletes the stash breaks both and is wrong.
// -------------------------------------------------------------------------
test('CONTROL 2: the stash still seeds its own matter, and survives matterless→matter', () =>
  withServer(async (t) => {
    const pier = await mkCm(t, CM_PIER, 'Pier 9 Sublease', 'Northgate Partners');

    // (a) same matter, no change
    const named = (await t.fetchJson('POST', '/api/timers', {
      name: 'Pier 9 sublease', cm_id: pier.id,
    })).body;
    await t.fetchJson('PATCH', `/api/timers/${named.id}`, { draft_narrative: PIER_NARRATIVE });
    const startedA = (await t.fetchJson('POST', `/api/timers/${named.id}/start`)).body;
    const rowA = t.db.prepare('SELECT cm_id, narrative FROM entries WHERE id=?')
      .get(startedA.entry.id);
    assert.equal(rowA.cm_id, pier.id);
    assert.equal(rowA.narrative, PIER_NARRATIVE, 'the stash must still seed its own matter');

    // (b) quick timer with no matter at all, then assigned
    const quick = (await t.fetchJson('POST', '/api/timers', {})).body;
    assert.equal(quick.cm_id, null, 'precondition: matterless quick timer');
    await t.fetchJson('PATCH', `/api/timers/${quick.id}`, { draft_narrative: PIER_NARRATIVE });
    await t.fetchJson('PATCH', `/api/timers/${quick.id}`, { cm_id: pier.id });
    const startedB = (await t.fetchJson('POST', `/api/timers/${quick.id}/start`)).body;
    const rowB = t.db.prepare('SELECT cm_id, narrative FROM entries WHERE id=?')
      .get(startedB.entry.id);
    assert.equal(rowB.cm_id, pier.id);
    assert.equal(rowB.narrative, PIER_NARRATIVE,
      'matterless→matter is the designed case and must keep working');
  }));
