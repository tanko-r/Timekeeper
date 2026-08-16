// ADVERSARIAL VERIFICATION — independent reproduction of the claim:
//   "POST /api/entries/:id/copy will copy a SOFT-DELETED entry, resurrecting
//    deleted narrative text."
//
// VERDICT: CONFIRMED as a resurrection defect. REFUTED as a matter-boundary
// leak — the copy lands on the SOURCE entry's own matter (see CONTROL 3), so
// no narrative crosses a matter boundary and BRIEF.md's non-negotiable rule
// is NOT violated. What IS violated is the weaker but real promise that the
// attorney's deletion sticks: text he deleted comes back as a LIVE billable
// draft and reaches the export file (REPRO 2).
//
// REPRO 1, REPRO 2 and REPRO 3 are written to FAIL while the defect exists.
// Do not "fix" them by relaxing the assertions — the fix belongs in
// server/routes/entries.js POST /:id/copy, which calls loadEntry() (no
// deleted_at guard) where every sibling route re-reads the row and rejects a
// deleted one. Compare:
//
//   r.post('/:id/finalize', …)  →  if (!row || row.deleted_at) return 404
//   r.post('/:id/copy', …)      →  if (!src) return 404        // <-- no guard
//
// CONTROL 3 and CONTROL 4 are expected to PASS. They prove (a) the copy stays
// on its own matter, and (b) the deleted_at guard genuinely works on the
// sibling route — so the omission in /copy is a real outlier, not a guard that
// never worked anywhere.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

// A narrative carrying matter-specific facts, of the kind an attorney deletes
// precisely because he does not want it on a bill.
const DELETED_TEXT =
  'Draft and revise settlement demand letter to opposing counsel re: Foster deposition exhibits.';

async function withServer(fn) {
  const t = await startTestServer();
  try {
    const a = (await t.fetchJson('POST', '/api/cms', {
      cm_number: '100001-000012', short_name: 'Acme lease', billable: 1,
    })).body;
    const b = (await t.fetchJson('POST', '/api/cms', {
      cm_number: '100002-000030', short_name: 'Northgate merger', billable: 1,
    })).body;
    await fn(t, a, b);
  } finally { await t.close(); }
}

async function makeEntry(t, cm, date, narrative = DELETED_TEXT) {
  const r = await t.fetchJson('POST', '/api/entries', {
    date, cm_id: cm.id, narrative,
    tasks: [{ task_code: 'Draft', duration: 0.7, fragment: 'demand letter' }],
  });
  assert.equal(r.status, 201, 'setup: entry created');
  return r.body;
}

test('REPRO 1 (expected to FAIL): copying a soft-deleted entry must 404, not resurrect it', () =>
  withServer(async (t, a) => {
    const src = await makeEntry(t, a, '2026-08-10');

    const del = await t.fetchJson('DELETE', `/api/entries/${src.id}`);
    assert.equal(del.status, 200, 'setup: entry soft-deleted');

    // Read the database directly: the source really is soft-deleted.
    const srcRow = t.db.prepare(
      'SELECT cm_id, narrative, deleted_at FROM entries WHERE id=?'
    ).get(src.id);
    assert.notEqual(srcRow.deleted_at, null, 'setup: deleted_at stamped on the source');

    const copy = await t.fetchJson('POST', `/api/entries/${src.id}/copy`, { date: '2026-08-14' });

    assert.equal(copy.status, 404,
      `a deleted entry is not copyable; got ${copy.status} carrying ` +
      `${JSON.stringify(copy.body?.narrative)}`);
  }));

test('REPRO 2 (expected to FAIL): the resurrected copy must not reach the export file', () =>
  withServer(async (t, a) => {
    const src = await makeEntry(t, a, '2026-08-10');
    await t.fetchJson('DELETE', `/api/entries/${src.id}`);

    const copy = await t.fetchJson('POST', `/api/entries/${src.id}/copy`, { date: '2026-08-14' });
    if (copy.status === 404) return; // defect fixed; REPRO 1 covers it

    // The copy is a live draft, so finalize it the way the day close-out does
    // and export the day. Deleted text the attorney removed now bills.
    await t.fetchJson('POST', `/api/entries/${copy.body.id}/finalize`, { ack: true });
    const exp = await t.fetchJson('POST', '/api/export',
      { from: '2026-08-14', to: '2026-08-14' });

    const csv = String(exp.body?.csv ?? JSON.stringify(exp.body ?? ''));
    assert.ok(!csv.includes('Foster deposition exhibits'),
      'narrative the attorney DELETED reached the export file via copy-to-today');
  }));

test('REPRO 3 (expected to FAIL): the realistic path — a stale row on a second surface', () =>
  withServer(async (t, a) => {
    // David runs this as a desktop browser tab AND an installed Android PWA.
    // The Day/ledger list and Search view do not poll (only the timer grid
    // does, every 5s), so a row deleted on one surface stays on screen on the
    // other indefinitely, still offering "Copy to today" in its row menu.
    const src = await makeEntry(t, a, '2026-08-10');

    // Surface 1 (desktop) lists the day and holds the row object.
    const listed = await t.fetchJson('GET', '/api/entries?from=2026-08-10&to=2026-08-10');
    const rows = Array.isArray(listed.body) ? listed.body : (listed.body.entries || []);
    const staleRow = rows.find((e) => e.id === src.id);
    assert.ok(staleRow, 'setup: desktop surface holds the row');

    // Surface 2 (phone) deletes it.
    await t.fetchJson('DELETE', `/api/entries/${src.id}`);

    // Surface 1 never heard. The attorney uses the row menu it still shows —
    // exactly what public/js/components/menu.js does:
    //   items.push({ label: 'Copy to today', onClick: () => a.copyToToday(focus) })
    // → openEditor({ copyFrom: e.id }) → POST /api/entries/:id/copy
    const copy = await t.fetchJson('POST', `/api/entries/${staleRow.id}/copy`, { date: '2026-08-14' });

    assert.equal(copy.status, 404,
      'a stale row must not be able to resurrect a deleted entry');
  }));

test('CONTROL 3 (expected to PASS): the copy stays on its own matter — NOT a boundary leak', () =>
  withServer(async (t, a, b) => {
    const src = await makeEntry(t, a, '2026-08-10');
    await t.fetchJson('DELETE', `/api/entries/${src.id}`);
    const copy = await t.fetchJson('POST', `/api/entries/${src.id}/copy`, { date: '2026-08-14' });
    if (copy.status === 404) return; // defect fixed

    const copyRow = t.db.prepare('SELECT cm_id, narrative FROM entries WHERE id=?').get(copy.body.id);
    assert.equal(copyRow.cm_id, a.id, 'copy carries the SOURCE matter, not another');

    // Matter B must hold nothing of matter A's text.
    const bRows = t.db.prepare(
      'SELECT id FROM entries WHERE cm_id=? AND narrative LIKE ?'
    ).all(b.id, '%Foster deposition exhibits%');
    assert.equal(bRows.length, 0, 'no matter-A narrative landed on matter B');
  }));

test('CONTROL 4 (expected to PASS): the deleted_at guard works on the sibling route', () =>
  withServer(async (t, a) => {
    const src = await makeEntry(t, a, '2026-08-10');
    await t.fetchJson('DELETE', `/api/entries/${src.id}`);

    // finalize re-reads the row and checks deleted_at — copy does not.
    const fin = await t.fetchJson('POST', `/api/entries/${src.id}/finalize`, { ack: true });
    assert.equal(fin.status, 404, 'finalize correctly refuses a deleted entry');
  }));
