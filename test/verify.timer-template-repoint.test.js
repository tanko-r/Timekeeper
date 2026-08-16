// =========================================================================
// ADVERSARIAL VERIFICATION — independent reproduction of the claim:
//   "A timer's narrative template survives a matter re-point and seeds every
//    entry on the new matter"
//   (server/routes/timers.js — PATCH /:id lines 319-335, syncToEntry line 78)
//
// THESE "LEAK" TESTS ARE WRITTEN TO PROVE A LEAK BY FAILING. Do not "fix the
// test". The assertion is the specification (docs/ui/BRIEF.md, "Data
// integrity"): a narrative written for matter A may never be shown as
// belonging to, suggested for, pre-filled into, or WRITTEN ONTO an entry for
// matter B — not across clients, and not between two matters of the same
// client.
//
// Written by the verifier, independently of the claimant's
// test/integrity.suggestions.test.js LEAK 7. Every assertion reads the real
// SQLite row on a real server started by test/helpers.js, and reports which
// matter the offending text actually belongs to.
//
// Expected when written: LEAK 1-3 FAIL, both CONTROLs pass.
//
// 2026-08-16 (Stage 1d): the fence landed in server/routes/timers.js PATCH
// /:id (`disarm`), so all four LEAKs now PASS. LEAK 4 needed its SCAFFOLD
// repaired, not its assertion. Two scaffold faults, both masking the CSV
// check: (1) it stopped the timer within the 2-second misclick grace, which
// files nothing AND deletes the untouched entry the start opened, so finalize
// returned 404; (2) it assumed the entry arrived pre-seeded with the template.
// It now advances a fake clock by half an hour, reads the seeded row directly
// (the stronger check), then supplies the NEW matter's own words so the chain
// can still be driven to the CSV. Verified by disabling `disarm`: all four
// LEAKs fail again. No assertion was removed or relaxed.
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

// House fictional names only (BRIEF: no real client/matter data in the repo).
const CM_HARBOR = '910001-000010';   // Northgate Partners — Harbor Lease
const CM_RIDGE = '910001-000020';    // Northgate Partners — Ridgeline Permit
const CM_BOREALIS = '910002-000010'; // Acme Holdings — Borealis Merger

// A TEMPLATE in the shape the app's own placeholder teaches
// (public/js/components/timergrid.js: "e.g. Attend weekly all-hands call with
// Meridian and Calloway teams regarding"). It is not reusable phrasing: it
// names the matter, the document and a person, so it is a billing narrative
// about Harbor Lease and nobody else.
const HARBOR_TEMPLATE =
  'Attend weekly Harbor Lease status call with T. Vance regarding the termination notice;';

// Every entry, with the matter and client it belongs to — the evidence.
function entryRows(t) {
  return t.db.prepare(
    `SELECT e.id, e.cm_id, e.date, e.narrative, m.short_name, m.cm_number, c.name AS client
       FROM entries e
       LEFT JOIN matters m ON m.id = e.cm_id
       LEFT JOIN clients c ON c.id = m.client_id
      WHERE e.deleted_at IS NULL ORDER BY e.id`
  ).all();
}

// -------------------------------------------------------------------------
// LEAK 1 — exactly as claimed. Template set on a Northgate matter's timer,
// timer re-pointed at an ACME matter, timer started. Read the entries table.
// -------------------------------------------------------------------------
test('LEAK: a re-pointed timer writes the old matter\'s template onto the new matter\'s entry', () =>
  withServer(async (t) => {
    const harbor = await mkCm(t, CM_HARBOR, 'Harbor Lease', 'Northgate Partners');
    const borealis = await mkCm(t, CM_BOREALIS, 'Borealis Merger', 'Acme Holdings');

    const timer = (await t.fetchJson('POST', '/api/timers', {
      name: 'Harbor Lease', cm_id: harbor.id, narrative_template: HARBOR_TEMPLATE,
    })).body;
    assert.equal(timer.narrative_template, HARBOR_TEMPLATE);

    const patched = await t.fetchJson('PATCH', `/api/timers/${timer.id}`, { cm_id: borealis.id });
    assert.equal(patched.status, 200, JSON.stringify(patched.body));

    const started = await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
    assert.equal(started.status, 200, JSON.stringify(started.body));

    // ---- the stored rows, read straight out of SQLite ----
    const rows = entryRows(t);
    const offenders = rows.filter(
      (r) => r.narrative.includes('Harbor Lease') && r.cm_id !== harbor.id);

    assert.deepEqual(offenders, [],
      'entries rows carrying Harbor Lease text under a DIFFERENT matter:\n'
      + JSON.stringify(offenders, null, 2)
      + `\nall entries:\n${JSON.stringify(rows, null, 2)}`);
  }));

// -------------------------------------------------------------------------
// LEAK 2 (variation) — the ORDINARY-USE path, byte for byte.
//
// The only surface in the whole client that can change a timer's matter is
// TimerModal in public/js/components/timergrid.js, and its save() posts every
// field at once:
//   { name, cm_id, task_code, group_id, narrative_template }
// with narrative_template taken from the textarea, pre-loaded from the timer.
// So the realistic re-point RE-SENDS the old matter's template rather than
// omitting it. This test sends exactly that body.
// -------------------------------------------------------------------------
test('LEAK: the edit-timer dialog\'s own save body carries the template across the re-point', () =>
  withServer(async (t) => {
    const harbor = await mkCm(t, CM_HARBOR, 'Harbor Lease', 'Northgate Partners');
    const ridge = await mkCm(t, CM_RIDGE, 'Ridgeline Permit', 'Northgate Partners');

    const timer = (await t.fetchJson('POST', '/api/timers', {
      name: 'Harbor Lease', cm_id: harbor.id, task_code: null,
      narrative_template: HARBOR_TEMPLATE,
    })).body;

    // GET /api/timers is what the dialog renders from
    const listed = (await t.fetchJson('GET', '/api/timers')).body
      .find((x) => x.id === timer.id);
    // ...and this is TimerModal.save()'s body verbatim, matter swapped, the
    // template textarea left exactly as the dialog loaded it.
    const r = await t.fetchJson('PATCH', `/api/timers/${timer.id}`, {
      name: listed.name,
      cm_id: ridge.id,
      task_code: listed.task_code || null,
      group_id: listed.group_id ?? null,
      narrative_template: (listed.narrative_template || '').trim() || null,
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));

    await t.fetchJson('POST', `/api/timers/${timer.id}/start`);

    const rows = entryRows(t);
    const offenders = rows.filter(
      (x) => x.narrative.includes('Harbor Lease') && x.cm_id !== harbor.id);
    assert.deepEqual(offenders, [],
      'SAME-CLIENT sibling leak through the real dialog body — Harbor Lease\'s '
      + 'sentence is now on a Ridgeline Permit entry:\n'
      + JSON.stringify(offenders, null, 2));
  }));

// -------------------------------------------------------------------------
// LEAK 3 (variation) — "seeds EVERY entry", not just the first. Stop, take a
// fresh entry, start again: the second entry on the new matter is seeded too.
// This is what makes it a standing condition rather than a one-off.
// -------------------------------------------------------------------------
test('LEAK: the carried template keeps seeding new entries on the new matter', () =>
  withServer(async (t) => {
    const harbor = await mkCm(t, CM_HARBOR, 'Harbor Lease', 'Northgate Partners');
    const borealis = await mkCm(t, CM_BOREALIS, 'Borealis Merger', 'Acme Holdings');

    const timer = (await t.fetchJson('POST', '/api/timers', {
      name: 'Harbor Lease', cm_id: harbor.id, narrative_template: HARBOR_TEMPLATE,
    })).body;
    await t.fetchJson('PATCH', `/api/timers/${timer.id}`, { cm_id: borealis.id });

    await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
    await t.fetchJson('POST', `/api/timers/${timer.id}/stop`);
    await t.fetchJson('POST', `/api/timers/${timer.id}/fresh`);
    await t.fetchJson('POST', `/api/timers/${timer.id}/start`);

    const rows = entryRows(t);
    const seeded = rows.filter(
      (x) => x.cm_id === borealis.id && x.narrative.includes('Harbor Lease'));
    assert.equal(seeded.length, 0,
      `${seeded.length} Acme Holdings / Borealis Merger entries opened holding `
      + `Northgate Partners' Harbor Lease sentence:\n${JSON.stringify(seeded, null, 2)}`);
  }));

// -------------------------------------------------------------------------
// LEAK 4 (variation) — the whole chain, to the bill. Re-point, start, stop,
// finalize, export. The exported CSV row for the ACME matter carries the
// NORTHGATE sentence. This is the difference between "a draft field is wrong"
// and "the wrong client's facts left the building".
// -------------------------------------------------------------------------
test('LEAK: the carried template reaches the exported CSV under the new matter', () =>
  withServer(async (t, clock) => {
    const harbor = await mkCm(t, CM_HARBOR, 'Harbor Lease', 'Northgate Partners');
    const borealis = await mkCm(t, CM_BOREALIS, 'Borealis Merger', 'Acme Holdings');

    const timer = (await t.fetchJson('POST', '/api/timers', {
      name: 'Harbor Lease', cm_id: harbor.id, narrative_template: HARBOR_TEMPLATE,
    })).body;
    await t.fetchJson('PATCH', `/api/timers/${timer.id}`, { cm_id: borealis.id });
    const started = (await t.fetchJson('POST', `/api/timers/${timer.id}/start`)).body;
    const entryId = started.entry.id;
    // a real half-hour of work on the NEW matter. The clock is advanced rather
    // than set through PUT /clock: a stop within 2s of a start is the misclick
    // grace, which files nothing AND deletes the untouched entry the start
    // opened (routes/timers.js stopAndFile → deleteIfUntouched).
    clock.advance(1800);
    await t.fetchJson('POST', `/api/timers/${timer.id}/stop`);

    // Read the seeded row BEFORE writing anything of our own. This is the
    // assertion that catches a regression of the template fence, and it names
    // the offending row when it fires.
    const seeded = t.db.prepare(
      'SELECT id, cm_id, narrative, deleted_at FROM entries WHERE id=?').get(entryId);
    assert.ok(seeded && !seeded.deleted_at, `the half-hour entry survived the stop: ${JSON.stringify(seeded)}`);
    assert.equal(String(seeded.narrative || '').includes('Harbor Lease'), false,
      `the Borealis entry opened already carrying Harbor Lease’s template: ${JSON.stringify(seeded)}`);

    // With the fence holding, the entry opens blank, so the attorney types
    // Borealis’s OWN words before finalizing. This cannot mask a leak: the
    // seeded value was already asserted on above.
    if (!String(seeded.narrative || '').trim()) {
      await t.fetchJson('PATCH', `/api/entries/${entryId}`,
        { narrative: 'Attend weekly Borealis Merger status call regarding the termination notice;' });
    }
    const fin = await t.fetchJson('POST', `/api/entries/${entryId}/finalize`, { ack: true });
    assert.equal(fin.status, 200, JSON.stringify(fin.body));

    const stored = t.db.prepare(
      'SELECT id, cm_id, status, narrative FROM entries WHERE id=?').get(entryId);
    const day = stored ? t.db.prepare('SELECT date FROM entries WHERE id=?').get(entryId).date : null;
    const exp = await t.fetchJson('POST', '/api/export',
      { from: day, to: day, markExported: false });
    assert.equal(exp.status, 200, JSON.stringify(exp.body));

    assert.equal(exp.body.csv.includes('Harbor Lease'), false,
      `the export CSV bills Northgate Partners' Harbor Lease sentence to Acme Holdings `
      + `(${CM_BOREALIS}).\nstored entry row: ${JSON.stringify(stored)}\nCSV:\n${exp.body.csv}`);
  }));

// -------------------------------------------------------------------------
// CONTROL A — the template on its OWN matter is the intended feature and must
// keep working. If this fails, the fix went too far.
// -------------------------------------------------------------------------
test('CONTROL: the template still seeds entries on the matter it was written for', () =>
  withServer(async (t) => {
    const harbor = await mkCm(t, CM_HARBOR, 'Harbor Lease', 'Northgate Partners');
    const timer = (await t.fetchJson('POST', '/api/timers', {
      name: 'Harbor Lease', cm_id: harbor.id, narrative_template: HARBOR_TEMPLATE,
    })).body;
    const started = (await t.fetchJson('POST', `/api/timers/${timer.id}/start`)).body;
    assert.equal(started.entry.cm.id, harbor.id);
    assert.equal(started.entry.narrative, HARBOR_TEMPLATE);
  }));

// -------------------------------------------------------------------------
// CONTROL B — the user CAN clear it. Pins that the field is under the user's
// control (this is why the claim is not critical), and that the leak is the
// silent CARRY, not an inability to remove the text.
// -------------------------------------------------------------------------
test('CONTROL: clearing the template in the same PATCH stops the carry', () =>
  withServer(async (t) => {
    const harbor = await mkCm(t, CM_HARBOR, 'Harbor Lease', 'Northgate Partners');
    const borealis = await mkCm(t, CM_BOREALIS, 'Borealis Merger', 'Acme Holdings');
    const timer = (await t.fetchJson('POST', '/api/timers', {
      name: 'Harbor Lease', cm_id: harbor.id, narrative_template: HARBOR_TEMPLATE,
    })).body;
    await t.fetchJson('PATCH', `/api/timers/${timer.id}`,
      { cm_id: borealis.id, narrative_template: null });
    const started = (await t.fetchJson('POST', `/api/timers/${timer.id}/start`)).body;
    assert.equal(started.entry.cm.id, borealis.id);
    assert.equal(started.entry.narrative, '');
  }));
