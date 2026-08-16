// =========================================================================
// ADVERSARIAL VERIFICATION — independent reproduction of the claim:
//   "A timer's stashed narrative survives a matter re-point and is written
//    verbatim onto the new matter's first entry"
//   (server/routes/timers.js PATCH /:id lines 319-334 + syncToEntry line 78)
//
// THESE TESTS ARE WRITTEN TO PROVE A LEAK BY FAILING. Do not "fix the test".
// The assertion is the specification (docs/ui/BRIEF.md, "Data integrity"):
// a narrative written for matter A may never be shown as belonging to,
// suggested for, pre-filled into, or WRITTEN ONTO an entry for matter B —
// not across clients, and not between two matters of the SAME client.
//
// Written by the verifier, independently of the claimant's
// test/integrity.suggestions.test.js. Every assertion reads the real SQLite
// row on a real server started by test/helpers.js — nothing is judged from
// an API response body alone.
//
// Expected when written: LEAK 1, LEAK 2 and LEAK 3 FAIL; the CONTROLs pass.
//
// 2026-08-16 (Stage 1d): the fence landed in server/routes/timers.js PATCH
// /:id (`disarm`), so all four LEAKs now PASS. LEAK 4 needed its SCAFFOLD
// repaired, not its assertion: it drove finalize→export assuming the entry
// arrived pre-seeded with the leaked sentence, so once the fence held, the
// entry opened blank and finalize returned 422 narrative_empty before the CSV
// assertion was ever evaluated. It now reads the seeded row directly (the
// stronger check), then supplies the NEW matter's own words so the chain can
// still be driven to the CSV. Verified by disabling `disarm`: all four LEAKs
// fail again. No assertion was removed or relaxed.
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

const mkCm = async (t, cm_number, short_name, client_name) => {
  const r = await t.fetchJson('POST', '/api/cms', { cm_number, short_name, client_name });
  assert.equal(r.status < 300, true, `cm create failed: ${JSON.stringify(r.body)}`);
  return r.body;
};

// House fictional names only.
const CM_HARBOR = '900001-000010';   // Northgate Partners — Harbor Lease
const CM_RIDGE = '900001-000020';    // Northgate Partners — Ridgeline Permit (SAME client)
const CM_BOREALIS = '900002-000010'; // Acme Holdings — Borealis Merger (other client)

// A billing narrative, not reusable phrasing: it names the matter, the
// document, the counterparty and the deadline.
const HARBOR_NARRATIVE =
  'Review Harbor Lease estoppel certificate from T. Vance and calendar the '
  + 'September 3 landlord response deadline.';

// Every (entry id, matter, narrative) row that carries this sentence, read
// straight out of SQLite.
function rowsCarrying(t, text) {
  return t.db.prepare(
    `SELECT e.id AS entry_id, e.cm_id, e.narrative, e.status, e.deleted_at,
            m.short_name, m.cm_number
       FROM entries e LEFT JOIN matters m ON m.id = e.cm_id
      WHERE e.narrative LIKE '%' || ? || '%'`
  ).all(text);
}

// -------------------------------------------------------------------------
// LEAK 1 — cross-CLIENT, exactly as the claim describes it.
// Timer sits on Northgate/Harbor Lease. Attorney types a Harbor Lease
// sentence into the float window before starting (pip.js narrativeMode()
// === 'stash', because the timer has no linked entry yet) → it is stashed on
// timers.draft_narrative. The timer is then re-pointed at Acme/Borealis
// Merger through the Edit-timer dialog (timergrid.js TimerModal.save sends
// name/cm_id/task_code/group_id/narrative_template and NOTHING about the
// stash) and started.
// -------------------------------------------------------------------------
test('LEAK 1: stash typed on Harbor Lease is written onto the Borealis entry (cross-client)', () =>
  withServer(async (t) => {
    const harbor = await mkCm(t, CM_HARBOR, 'Harbor Lease', 'Northgate Partners');
    const borealis = await mkCm(t, CM_BOREALIS, 'Borealis Merger', 'Acme Holdings');

    const timer = (await t.fetchJson('POST', '/api/timers', {
      name: 'Harbor Lease', cm_id: harbor.id,
    })).body;

    // float window, stash mode (pip.js:444)
    const stash = await t.fetchJson('PATCH', `/api/timers/${timer.id}`, {
      draft_narrative: HARBOR_NARRATIVE,
    });
    assert.equal(stash.status, 200);
    assert.equal(
      t.db.prepare('SELECT draft_narrative d FROM timers WHERE id=?').get(timer.id).d,
      HARBOR_NARRATIVE, 'precondition: the stash is stored on the timer');

    // "wrong timer, fix it" — the Edit-timer dialog's exact body shape
    const repoint = await t.fetchJson('PATCH', `/api/timers/${timer.id}`, {
      name: 'Borealis Merger', cm_id: borealis.id, task_code: null,
      group_id: null, narrative_template: null,
    });
    assert.equal(repoint.status, 200);

    await t.fetchJson('POST', `/api/timers/${timer.id}/start`);

    // ---- read the DATABASE, not the response ----
    const carriers = rowsCarrying(t, 'Harbor Lease estoppel certificate');
    const foreign = carriers.filter((r) => r.cm_id !== harbor.id && !r.deleted_at);
    assert.deepEqual(foreign, [],
      'Harbor Lease’s sentence is stored on an entry belonging to another matter: '
      + JSON.stringify(carriers, null, 2));
  }));

// -------------------------------------------------------------------------
// LEAK 2 — same CLIENT, two matters. The brief bans this too.
// Variation on the mechanism: no start at all. A PAUSED timer that already
// holds clock time but has no linked entry (the state left by "New entry
// (zero clock)"/POST /fresh, or by a start that was later unlinked) files
// its clock the instant the matter changes — timers.js:353-362 — so the
// PATCH itself creates the new matter's entry carrying the old stash.
// -------------------------------------------------------------------------
test('LEAK 2: re-pointing a paused timer files the stash into a SIBLING matter’s new entry', () =>
  withServer(async (t, clock) => {
    const harbor = await mkCm(t, CM_HARBOR, 'Harbor Lease', 'Northgate Partners');
    const ridge = await mkCm(t, CM_RIDGE, 'Ridgeline Permit', 'Northgate Partners');

    const timer = (await t.fetchJson('POST', '/api/timers', {
      name: 'Harbor Lease', cm_id: harbor.id,
    })).body;

    // work some time on Harbor Lease, then finalize that block so the entry
    // is settled and the timer will open a NEW one next time
    await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
    clock.advance(1800);
    const stop = (await t.fetchJson('POST', `/api/timers/${timer.id}/stop`)).body;
    assert.ok(stop.entry, 'precondition: the Harbor block filed');
    await t.fetchJson('POST', `/api/timers/${timer.id}/fresh`); // zero clock + unlink
    clock.advance(60);
    await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
    clock.advance(1200);
    await t.fetchJson('POST', `/api/timers/${timer.id}/stop`);
    // unlink that second entry the way a finalize does, leaving the clock on
    const second = t.db.prepare(
      'SELECT linked_entry_id l FROM timers WHERE id=?').get(timer.id).l;
    assert.ok(second, 'precondition: a second entry exists');
    t.db.prepare('UPDATE timers SET linked_entry_id=NULL WHERE id=?').run(timer.id);

    await t.fetchJson('PATCH', `/api/timers/${timer.id}`, {
      draft_narrative: HARBOR_NARRATIVE,
    });

    // re-point only — no start, no stop
    await t.fetchJson('PATCH', `/api/timers/${timer.id}`, {
      name: 'Ridgeline Permit', cm_id: ridge.id, task_code: null,
      group_id: null, narrative_template: null,
    });

    const carriers = rowsCarrying(t, 'Harbor Lease estoppel certificate');
    const foreign = carriers.filter((r) => r.cm_id !== harbor.id && !r.deleted_at);
    assert.deepEqual(foreign, [],
      'Harbor Lease’s sentence landed on a sibling matter’s entry: '
      + JSON.stringify(carriers, null, 2));
  }));

// -------------------------------------------------------------------------
// LEAK 3 — the stash outlives the re-point even when nothing consumes it
// immediately, so the NEXT entry the timer ever creates (tomorrow, a
// different day, a different matter) still gets it. Reads timers.draft_narrative
// directly: after the matter changes, the old matter's sentence is still
// loaded in the chamber.
// -------------------------------------------------------------------------
test('LEAK 3: the stash is still loaded on the timer after the matter changed', () =>
  withServer(async (t) => {
    const harbor = await mkCm(t, CM_HARBOR, 'Harbor Lease', 'Northgate Partners');
    const borealis = await mkCm(t, CM_BOREALIS, 'Borealis Merger', 'Acme Holdings');
    const timer = (await t.fetchJson('POST', '/api/timers', {
      name: 'Harbor Lease', cm_id: harbor.id,
    })).body;
    await t.fetchJson('PATCH', `/api/timers/${timer.id}`, { draft_narrative: HARBOR_NARRATIVE });
    await t.fetchJson('PATCH', `/api/timers/${timer.id}`, {
      name: 'Borealis Merger', cm_id: borealis.id, task_code: null,
      group_id: null, narrative_template: null,
    });
    const row = t.db.prepare(
      'SELECT cm_id, draft_narrative FROM timers WHERE id=?').get(timer.id);
    assert.equal(row.cm_id, borealis.id, 'precondition: the timer moved matters');
    assert.equal(row.draft_narrative, null,
      'the old matter’s stashed sentence is still armed on a timer that now '
      + `points at another client: ${JSON.stringify(row)}`);
  }));

// -------------------------------------------------------------------------
// LEAK 4 — how far it travels. The entry the stash seeded is an ordinary
// draft: it finalizes and exports like any other, so Harbor Lease's sentence
// leaves the building on a CSV line stamped with Acme's matter number.
// -------------------------------------------------------------------------
test('LEAK 4: the leaked sentence reaches the export CSV under the other client’s number', () =>
  withServer(async (t, clock) => {
    const harbor = await mkCm(t, CM_HARBOR, 'Harbor Lease', 'Northgate Partners');
    const borealis = await mkCm(t, CM_BOREALIS, 'Borealis Merger', 'Acme Holdings');
    const timer = (await t.fetchJson('POST', '/api/timers', {
      name: 'Harbor Lease', cm_id: harbor.id, task_code: 'Research',
    })).body;
    await t.fetchJson('PATCH', `/api/timers/${timer.id}`, { draft_narrative: HARBOR_NARRATIVE });
    await t.fetchJson('PATCH', `/api/timers/${timer.id}`, {
      name: 'Borealis Merger', cm_id: borealis.id, task_code: 'Research',
      group_id: null, narrative_template: null,
    });
    const started = (await t.fetchJson('POST', `/api/timers/${timer.id}/start`)).body;
    clock.advance(1800);
    await t.fetchJson('POST', `/api/timers/${timer.id}/stop`);

    // Read the seeded row BEFORE writing anything of our own. This is the
    // assertion that catches a regression of the stash fence, and it names the
    // offending row when it fires.
    const seeded = t.db.prepare('SELECT id, cm_id, narrative FROM entries WHERE id=?')
      .get(started.entry.id);
    assert.equal(String(seeded.narrative || '').includes('Harbor Lease estoppel certificate'), false,
      'the Borealis entry opened already carrying Harbor Lease’s sentence: '
      + JSON.stringify(seeded));

    // With the fence holding, the entry opens blank, so the attorney types
    // Borealis’s OWN words before finalizing. This cannot mask a leak: the
    // seeded value was already asserted on above.
    if (!String(seeded.narrative || '').trim()) {
      await t.fetchJson('PATCH', `/api/entries/${started.entry.id}`,
        { narrative: 'Review Borealis Merger disclosure schedules.' });
    }
    const fin = await t.fetchJson('POST', `/api/entries/${started.entry.id}/finalize`, { ack: true });
    assert.equal(fin.status, 200, `finalize failed: ${JSON.stringify(fin.body)}`);
    const out = (await t.fetchJson('POST', '/api/export', {
      from: '2026-08-14', to: '2026-08-14',
    })).body;
    assert.equal(out.csv.includes('Harbor Lease estoppel certificate'), false,
      'Harbor Lease’s sentence is in the exported CSV, on Acme’s line:\n' + out.csv);
  }));

// -------------------------------------------------------------------------
// CONTROL A — the suggestion field IS cleared on a matter change
// (timers.js:325). Proves the test rig detects the difference between "kept"
// and "cleared", and that the claim is about draft_narrative specifically.
// -------------------------------------------------------------------------
test('CONTROL A: suggested_narrative IS cleared by the same PATCH', () =>
  withServer(async (t) => {
    const harbor = await mkCm(t, CM_HARBOR, 'Harbor Lease', 'Northgate Partners');
    const borealis = await mkCm(t, CM_BOREALIS, 'Borealis Merger', 'Acme Holdings');
    const timer = (await t.fetchJson('POST', '/api/timers', {
      name: 'Harbor Lease', cm_id: harbor.id,
    })).body;
    t.db.prepare('UPDATE timers SET suggested_narrative=? WHERE id=?')
      .run(HARBOR_NARRATIVE, timer.id);
    await t.fetchJson('PATCH', `/api/timers/${timer.id}`, {
      name: 'Borealis Merger', cm_id: borealis.id, task_code: null,
      group_id: null, narrative_template: null,
    });
    assert.equal(
      t.db.prepare('SELECT suggested_narrative s FROM timers WHERE id=?').get(timer.id).s,
      null, 'suggestion belonged to the old matter and is dropped');
  }));

// -------------------------------------------------------------------------
// CONTROL B — with NO re-point, the stash is supposed to seed the entry.
// This is the intended feature and must keep working; it is here so a fix
// cannot be "delete the stash".
// -------------------------------------------------------------------------
test('CONTROL B: without a matter change the stash still seeds the entry', () =>
  withServer(async (t) => {
    const harbor = await mkCm(t, CM_HARBOR, 'Harbor Lease', 'Northgate Partners');
    const timer = (await t.fetchJson('POST', '/api/timers', {
      name: 'Harbor Lease', cm_id: harbor.id,
    })).body;
    await t.fetchJson('PATCH', `/api/timers/${timer.id}`, { draft_narrative: HARBOR_NARRATIVE });
    const started = (await t.fetchJson('POST', `/api/timers/${timer.id}/start`)).body;
    const row = t.db.prepare('SELECT cm_id, narrative FROM entries WHERE id=?')
      .get(started.entry.id);
    assert.equal(row.cm_id, harbor.id);
    assert.equal(row.narrative, HARBOR_NARRATIVE);
  }));
