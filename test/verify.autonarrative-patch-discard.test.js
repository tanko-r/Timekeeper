// ===========================================================================
// ADVERSARIAL VERIFICATION — independently written by the verifier, not the
// claimant. Claim under test:
//
//   "A narrative-only PATCH is silently discarded on an AUTO entry."
//   server/routes/entries.js — syncNarrative() is called unconditionally from
//   PATCH /api/entries/:id, AFTER the UPDATE that stores the client's text.
//   On an entry with >=2 substantive task lines and narrative_manual=0 it
//   regenerates the task-line join over whatever the client just sent, and
//   answers 200.
//
// THE DEFECT TESTS BELOW PROVE THE DISCARD BY FAILING. Do not "make them pass"
// by weakening an assertion. The assertion is the specification
// (docs/ui/BRIEF.md, "Data integrity: non-negotiable"): "No time and no
// narrative may ever be lost. No silent overwrite without an undo." A write
// the app answers 200 to, reports to the lawyer as "Narrative saved", and
// offers an Undo for, must reach the row — or must be refused.
//
// This is NOT a cross-matter leak. Every narrative here belongs to the matter
// its entry belongs to; nothing crosses a matter boundary. What is lost is the
// sentence the lawyer chose, replaced by machine-built text, with a success
// message on screen.
//
// REACHABLE TODAY, not only if a gate is dropped. Verified by driving the real
// UI in headless Chromium (see the report): stop a timer whose entry has two
// task lines -> the stop offer mounts -> "More from this matter" -> pick
// yesterday's narrative on the same matter -> "Use it". The toast reads
// "Narrative saved · Undo" and the sqlite row still holds the task-line join.
// public/js/components/stopchips.js pick() sends {narrative, narrative_ai} and
// never narrative_manual; the "More from this matter" button that reaches it
// is NOT behind the `offerChips` gate that protects the chips themselves.
//
// Every assertion reads the REAL sqlite row through a real server started by
// test/helpers.js. Nothing is inferred from source code.
//
// Expected against ui-overhaul-2026-08 as of this run:
//   DISCARD A, DISCARD B, DISCARD C  -> FAIL   (the defect)
//   CONTROL 1, CONTROL 2, CONTROL 3  -> PASS   (scopes the mechanism)
// ===========================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

const TODAY = '2026-08-14';

function makeClock(iso) {
  let now = new Date(iso).getTime();
  const clock = () => new Date(now);
  clock.advance = (s) => { now += s * 1000; };
  return clock;
}

async function withServer(fn) {
  const t = await startTestServer({ clock: makeClock('2026-08-14T09:00:00-07:00') });
  try { return await fn(t); } finally { await t.close(); }
}

const mkCm = async (t, cm_number, short_name, client_name) => (
  await t.fetchJson('POST', '/api/cms', { cm_number, short_name, client_name })).body;

// An entry in exactly the state the app calls AUTO: two substantive task
// lines, narrative_manual=0, narrative built by the server from the lines.
async function autoEntry(t, cmId) {
  const { body: e } = await t.fetchJson('POST', '/api/entries', {
    date: TODAY,
    cm_id: cmId,
    tasks: [
      { task_code: 'A104', duration: 0.3, fragment: 'Review lease' },
      { task_code: 'A103', duration: 0.2, fragment: 'draft email to counsel' },
    ],
  });
  assert.equal(e.narrative_auto, true, 'fixture: entry must be AUTO');
  assert.equal(e.narrative_manual, 0, 'fixture: entry must not be detached');
  assert.equal(e.narrative, 'Review lease (0.3); draft email to counsel (0.2).');
  return e;
}

const stored = (t, id) => t.db.prepare(
  'SELECT narrative, narrative_manual, narrative_ai FROM entries WHERE id=?').get(id);

// The sentence the lawyer picks. Deliberately a real billing narrative for
// THIS matter — the phrasebook's job — so a failure here is "the lawyer's own
// choice was thrown away", not "an unrelated string was rejected".
const CHOSEN = 'Telephone conference with landlord counsel regarding rent abatement.';

// ---------------------------------------------------------------------------
// DISCARD A — the exact payload public/js/components/stopchips.js pick() sends
// ---------------------------------------------------------------------------
test('DISCARD A: a stop-offer pick on an AUTO entry answers 200 and stores nothing',
  () => withServer(async (t) => {
    const cm = await mkCm(t, '100001-000012', 'Northgate lease', 'Northgate Partners');
    const e = await autoEntry(t, cm.id);

    // stopchips.js:426 — pick(): { narrative, narrative_ai }, no narrative_manual
    const res = await t.fetchJson('PATCH', `/api/entries/${e.id}`,
      { narrative: CHOSEN, narrative_ai: 0 });

    assert.equal(res.status, 200, 'the server accepts the write');

    const row = stored(t, e.id);
    assert.equal(row.narrative, CHOSEN,
      `PATCH answered 200 and the UI said "Narrative saved", but the row still reads `
      + `${JSON.stringify(row.narrative)}. The chosen narrative never reached the database.`);
  }));

// ---------------------------------------------------------------------------
// DISCARD B — the response lies in the same breath as the row
// ---------------------------------------------------------------------------
test('DISCARD B: the 200 response body echoes the machine text, not what was sent',
  () => withServer(async (t) => {
    const cm = await mkCm(t, '100001-000013', 'Northgate arbitration', 'Northgate Partners');
    const e = await autoEntry(t, cm.id);

    const res = await t.fetchJson('PATCH', `/api/entries/${e.id}`,
      { narrative: CHOSEN, narrative_ai: 0 });

    // A silent discard has to be either stored or refused. Answering 200 with
    // different text is what lets every client draw a success state over it.
    assert.equal(res.body.narrative, CHOSEN,
      'the write was neither stored nor refused: status 200, body.narrative = '
      + `${JSON.stringify(res.body.narrative)}`);
  }));

// ---------------------------------------------------------------------------
// DISCARD C — the wave-2c source_cm_id fence does not cover this
// ---------------------------------------------------------------------------
test('DISCARD C: stamping source_cm_id (the new matter fence) does not save the write',
  () => withServer(async (t) => {
    const cm = await mkCm(t, '100001-000014', 'Northgate renewal', 'Northgate Partners');
    const e = await autoEntry(t, cm.id);

    // The in-flight stopchips rewrite adds `stamped()` — source_cm_id names the
    // matter the suggestion was built for. It matches here, so the fence passes
    // the write through, and the write is still thrown away.
    const res = await t.fetchJson('PATCH', `/api/entries/${e.id}`,
      { narrative: CHOSEN, narrative_ai: 0, source_cm_id: cm.id });

    assert.equal(res.status, 200, 'same-matter write is not fenced off');
    assert.equal(stored(t, e.id).narrative, CHOSEN,
      'the matter fence guards WHICH matter the text lands on, not WHETHER it lands');
  }));

// ---------------------------------------------------------------------------
// CONTROLS — these pass, and they scope the mechanism precisely
// ---------------------------------------------------------------------------

// What public/js/components/entryeditor.js and entrylist.js send: the same
// text plus an explicit detach. This is why those two surfaces are safe.
test('CONTROL 1: the same text WITH narrative_manual=1 is stored',
  () => withServer(async (t) => {
    const cm = await mkCm(t, '100001-000015', 'Northgate sublease', 'Northgate Partners');
    const e = await autoEntry(t, cm.id);

    await t.fetchJson('PATCH', `/api/entries/${e.id}`,
      { narrative: CHOSEN, narrative_ai: 0, narrative_manual: 1 });

    const row = stored(t, e.id);
    assert.equal(row.narrative, CHOSEN);
    assert.equal(row.narrative_manual, 1);
  }));

// One substantive line is not an AUTO entry, so nothing regenerates over it.
test('CONTROL 2: the identical bare payload IS stored on a single-line entry',
  () => withServer(async (t) => {
    const cm = await mkCm(t, '100001-000016', 'Northgate estoppel', 'Northgate Partners');
    const { body: e } = await t.fetchJson('POST', '/api/entries', {
      date: TODAY, cm_id: cm.id,
      tasks: [{ task_code: 'A104', duration: 0.5, fragment: 'Review lease' }],
    });
    assert.equal(e.narrative_auto, false, 'fixture: single-line entry is not AUTO');

    await t.fetchJson('PATCH', `/api/entries/${e.id}`, { narrative: CHOSEN, narrative_ai: 0 });
    assert.equal(stored(t, e.id).narrative, CHOSEN);
  }));

// The durability contract the discard exists to serve: once an entry is
// detached, a task-touching save must NOT revert the lawyer's own sentence.
// This is deliberate behaviour and must keep working — a fix for the discard
// above must not be a fix that breaks this.
test('CONTROL 3: a detached narrative survives a task-only save (the contract)',
  () => withServer(async (t) => {
    const cm = await mkCm(t, '100001-000017', 'Northgate CAM audit', 'Northgate Partners');
    const e = await autoEntry(t, cm.id);

    await t.fetchJson('PATCH', `/api/entries/${e.id}`,
      { narrative: CHOSEN, narrative_manual: 1 });
    await t.fetchJson('PATCH', `/api/entries/${e.id}`, {
      tasks: [
        { task_code: 'A104', duration: 0.4, fragment: 'Review lease' },
        { task_code: 'A103', duration: 0.2, fragment: 'draft email to counsel' },
      ],
    });

    assert.equal(stored(t, e.id).narrative, CHOSEN,
      'the manual narrative must survive a later task edit');
  }));
