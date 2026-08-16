// =========================================================================
// VERIFICATION TEST — ghost-text completion offers a SIBLING MATTER's whole
// narrative, and Tab writes it onto this matter's entry.
//
// EVERY TEST IN THIS FILE IS EXPECTED TO FAIL ON THE CURRENT CODE. They are
// written to PROVE a leak, not to pass. Do not "fix the test" — the assertion
// is the specification (docs/ui/BRIEF.md, "Data integrity"):
//
//   "A narrative written for matter A may never be shown as belonging to,
//    suggested for, pre-filled into, or written onto an entry for matter B.
//    Not across clients, and not between two matters of the SAME client."
//
// WHAT IS NOT BEING CLAIMED HERE. Ghost text as a MECHANISM is shared by
// design and is not a defect; neither is the phrasebook, nor text expansion.
// The brief's line is "reusable wording is shared; a sentence describing what
// happened on a particular matter is not." The string this file tracks —
// naming the matter, the document and the counterparty — is squarely on the
// wrong side of that line. The defect is the CONTENT of the completion pool,
// not the existence of the pool.
//
// Chain under test:
//   server/routes/matters.js matterSuggestions()  — blends SIBLING_PHRASES
//     into a matter's own phrasebook whenever it has < THIN_PHRASES (5) own
//     ranked phrases, and SIBLING_PHRASES' second UNION arm selects whole
//     e.narrative rows, not just task fragments.
//   public/js/components/ghosttext.js useMatterSuggestions() line 30 —
//     `r.phrases.map((p) => p.text)` keeps the text and DROPS `source`, so
//     nothing downstream can tell a borrowed sentence from an own one.
//   public/js/lib/ghost.js ghostCompletion() — case-insensitive prefix match
//     over that array at minChars 2, first hit anywhere in the list wins
//     (rank does not gate reachability).
//   consumed by: entryeditor.js:156 → the narrative box (:783) and EVERY task
//     fragment (:919), entrylist.js:111 → the inline row editor (:176),
//     closeout.js:263 → the close-out narrative box (:618), stopchips.js:287
//     → the stop offer's own field (:628).
// =========================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';
import { ghostCompletion } from '../public/js/lib/ghost.js';

async function withServer(fn) {
  const t = await startTestServer();
  try { return await fn(t); } finally { await t.close(); }
}

const mkCm = async (t, cm_number, short_name, client_name) =>
  (await t.fetchJson('POST', '/api/cms', { cm_number, short_name, client_name })).body;

// House fictional names only (BRIEF: no real client/matter data in the repo).
const CM_HARBOR = '100001-000010';  // Northgate Partners — Harbor Lease
const CM_RIDGE = '100001-000020';   // Northgate Partners — Ridgeline Permit

// A whole client-facing billing sentence: it names the matter, the document
// and the counterparty. This is not reusable phrasing by any reading.
const HARBOR_NARRATIVE =
  'Review and analyze the Harbor Lease termination notice and confer with T. Vance regarding same.';

// Exactly what ghosttext.js useMatterSuggestions() hands to GhostInput.
const poolFor = async (t, matterId) => {
  const r = await t.fetchJson('GET', `/api/matters/${matterId}/suggestions`);
  assert.equal(r.status, 200);
  return r.body.phrases.map((p) => p.text);   // ghosttext.js:30 — `source` dropped
};

// ---------------------------------------------------------------------------
// 1 — the ghost pool for a cold matter IS its sibling's billing sentence, and
// two characters complete the whole thing.
//
// Observed in the real UI (headless Chromium, real server, temp DB): with the
// entry editor open on "Ridgeline Permit · 100001-000020 · Northgate
// Partners", typing the two characters "Re" rendered
//   .ghost-typed = "Re"
//   .ghost-hint  = "view and analyze the Harbor Lease termination notice and
//                   confer with T. Vance regarding same"
// in grey, with no marking of any kind that it came from another matter.
// ---------------------------------------------------------------------------
test('LEAK: ghost text completes a sibling matter\'s whole narrative from two characters', () =>
  withServer(async (t) => {
    const harbor = await mkCm(t, CM_HARBOR, 'Harbor Lease', 'Northgate Partners');
    const ridge = await mkCm(t, CM_RIDGE, 'Ridgeline Permit', 'Northgate Partners');

    await t.fetchJson('POST', '/api/entries', {
      date: '2026-08-10', cm_id: harbor.id, narrative: HARBOR_NARRATIVE,
      tasks: [{ task_code: 'Review', duration: 0.6, fragment: '' }],
    });

    const pool = await poolFor(t, ridge.id);
    const ghost = ghostCompletion('Re', 2, pool);

    assert.equal(ghost, null,
      `typing "Re" on Ridgeline Permit offers Harbor Lease's sentence: ${JSON.stringify('Re' + ghost)}`);
  }));

// ---------------------------------------------------------------------------
// 2 — the accepted text lands in the database ON THE OTHER MATTER'S ENTRY.
//
// This is the same PATCH the entry editor's autosave issues after Tab. In the
// real UI the identical row appeared without this test's help: entry id 2,
// cm_id = Ridgeline Permit, narrative = Harbor Lease's sentence, status draft
// — i.e. already queued for the day's finalize and export.
// ---------------------------------------------------------------------------
test('LEAK: Tab-accepting the ghost stores a sibling\'s narrative on this matter\'s entry row', () =>
  withServer(async (t) => {
    const harbor = await mkCm(t, CM_HARBOR, 'Harbor Lease', 'Northgate Partners');
    const ridge = await mkCm(t, CM_RIDGE, 'Ridgeline Permit', 'Northgate Partners');
    await t.fetchJson('POST', '/api/entries', {
      date: '2026-08-10', cm_id: harbor.id, narrative: HARBOR_NARRATIVE,
      tasks: [{ task_code: 'Review', duration: 0.6, fragment: '' }],
    });

    // the lawyer opens a new entry on Ridgeline Permit and types two letters
    const mine = (await t.fetchJson('POST', '/api/entries', {
      date: '2026-08-14', cm_id: ridge.id, narrative: '',
      tasks: [{ task_code: 'Review', duration: 0.5, fragment: '' }],
    })).body;

    const typed = 'Re';
    const ghost = ghostCompletion(typed, typed.length, await poolFor(t, ridge.id));
    const accepted = typed + (ghost || '');           // GhostInput handleKeyDown, Tab branch
    await t.fetchJson('PATCH', `/api/entries/${mine.id}`, { narrative: accepted });

    const row = t.db.prepare(`
      SELECT e.id, e.cm_id, m.short_name, e.status, e.narrative
      FROM entries e JOIN matters m ON m.id = e.cm_id WHERE e.id = ?`).get(mine.id);

    assert.equal(row.short_name, 'Ridgeline Permit');
    assert.ok(!row.narrative.includes('Harbor Lease'),
      `stored entry ${row.id} on ${row.short_name} (status ${row.status}) holds Harbor Lease's narrative: ${JSON.stringify(row.narrative)}`);
  }));

// ---------------------------------------------------------------------------
// 3 — it is NOT confined to a matter with no history, and rank does not save
// it. A matter with four days of its own work still borrows (THIN_PHRASES is
// 5), and ghostCompletion returns the first prefix hit ANYWHERE in the list —
// so the borrowed sentence ranked last is still offered the moment no own
// phrase starts with the same two characters. Mid-narrative counts too: the
// segment restarts after ";", so it fires in the middle of a normal
// multi-clause narrative.
// ---------------------------------------------------------------------------
test('LEAK: a matter with its own history still gets the sibling sentence, from last place', () =>
  withServer(async (t) => {
    const harbor = await mkCm(t, CM_HARBOR, 'Harbor Lease', 'Northgate Partners');
    const ridge = await mkCm(t, CM_RIDGE, 'Ridgeline Permit', 'Northgate Partners');
    await t.fetchJson('POST', '/api/entries', {
      date: '2026-08-10', cm_id: harbor.id, narrative: HARBOR_NARRATIVE,
      tasks: [{ task_code: 'Review', duration: 0.6, fragment: '' }],
    });

    const own = [
      'Telephone conference with county planner regarding permit conditions',
      'Draft memorandum on setback variance',
      'Prepare exhibits for the permit application',
      'Attend hearing on the permit application',
    ];
    for (let i = 0; i < own.length; i++) {
      await t.fetchJson('POST', '/api/entries', {
        date: `2026-08-1${i + 1}`, cm_id: ridge.id, narrative: own[i],
        tasks: [{ task_code: 'Review', duration: 0.4, fragment: '' }],
      });
    }

    const pool = await poolFor(t, ridge.id);
    assert.ok(!pool.some((p) => p.includes('Harbor Lease')),
      `a worked matter's ghost pool still carries its sibling's sentence, at rank ${pool.findIndex((p) => p.includes('Harbor Lease'))} of ${pool.length}`);

    // and mid-narrative, after a clause break, in the middle of normal typing
    const mid = 'Attend hearing; Re';
    assert.equal(ghostCompletion(mid, mid.length, pool), null,
      'the sibling sentence is offered mid-narrative, after a clause break');
  }));
