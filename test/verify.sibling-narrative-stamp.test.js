// ===========================================================================
// ADVERSARIAL VERIFICATION — independently written by the verifier, not the
// claimant. Claim under test:
//
//   "A sibling matter's real narrative is stamped onto another matter's timer
//    as its suggested narrative."
//   server/routes/timers.js doStart() -> matterSuggestions()
//   (server/routes/matters.js:42, SIBLING_PHRASES)
//
// THESE TESTS PROVE A LEAK BY FAILING. Do not "make them pass" by weakening an
// assertion — the assertion IS the specification (docs/ui/BRIEF.md, "Data
// integrity: non-negotiable"): a narrative written for matter A may never be
// shown as belonging to, suggested for, pre-filled into, or written onto an
// entry for matter B — not across clients, and NOT between two matters of the
// SAME client. A matter with no prior narratives gets generic phrasing or
// nothing.
//
// Every assertion below reads the REAL sqlite row on a real server started by
// test/helpers.js, and proves ownership by joining the stored text back to the
// entry/matter it was written for. Nothing is inferred from source code.
//
// Expected against ui-overhaul-2026-08 as of this run:
//   LEAK A, LEAK B, LEAK C, LEAK D, LEAK E  -> FAIL   (the defect)
//   CONTROL 1, CONTROL 2                    -> PASS   (scopes the mechanism)
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
  const clock = makeClock('2026-08-14T09:00:00-07:00');
  const t = await startTestServer({ clock });
  try { return await fn(t, clock); } finally { await t.close(); }
}

const mkCm = async (t, cm_number, short_name, client_name) => {
  const r = await t.fetchJson('POST', '/api/cms', {
    cm_number, short_name, client_name, billable: 1,
  });
  assert.ok(r.status < 300, `cm create failed: ${JSON.stringify(r.body)}`);
  return r.body;
};

const addEntry = async (t, cm_id, date, narrative, task_code = 'Review') => {
  const r = await t.fetchJson('POST', '/api/entries', {
    date, cm_id, narrative, tasks: [{ task_code, duration: 0.5, fragment: '' }],
  });
  assert.ok(r.status < 300, `entry create failed: ${JSON.stringify(r.body)}`);
  return r.body;
};

const startTimer = async (t, name, cm_id) => {
  const timer = (await t.fetchJson('POST', '/api/timers', { name, cm_id })).body;
  const started = await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
  assert.equal(started.status, 200, JSON.stringify(started.body));
  return timer;
};

// PROVENANCE: which matters own an entry whose narrative is this text?
// rankPhrases -> normalizePhrase strips trailing punctuation, so match on the
// stored text as a prefix of the entry narrative.
function ownersOfText(t, text) {
  if (!text) return [];
  return t.db.prepare(`
    SELECT DISTINCT m.id AS matter_id, m.short_name, m.client_id, e.id AS entry_id
    FROM entries e JOIN matters m ON m.id = e.cm_id
    WHERE e.deleted_at IS NULL AND e.narrative LIKE ? || '%'
  `).all(text);
}

// House fictional names only (BRIEF: no real client/matter data in the repo).
const CLIENT_A = 'Northgate Partners';
const CM_BUSY = '900100-000011';   // Northgate — Harbor Lease   (has history)
const CM_NEW = '900100-000022';    // Northgate — Ridgeline Permit (brand new)
const CM_OTHER_CLIENT = '900200-000011'; // Acme Holdings — Borealis Merger

// A client-facing billing sentence: it names the matter, the document and a
// person. This is not reusable phrasing.
const BUSY_NARRATIVE =
  'Telephone conference with T. Vance regarding the Harbor Lease termination notice and the estoppel certificate.';

// ---------------------------------------------------------------------------
// LEAK A — the claim, exactly as described, verified in SQLite.
// ---------------------------------------------------------------------------
test('LEAK A: starting a timer on a new matter stores the SIBLING matter’s narrative in timers.suggested_narrative', () =>
  withServer(async (t) => {
    const busy = await mkCm(t, CM_BUSY, 'Harbor Lease', CLIENT_A);
    const fresh = await mkCm(t, CM_NEW, 'Ridgeline Permit', CLIENT_A);
    assert.equal(busy.client_id, fresh.client_id, 'precondition: same client');

    await addEntry(t, busy.id, TODAY, BUSY_NARRATIVE, 'Call/Conference');

    const timer = await startTimer(t, 'Ridgeline Permit', fresh.id);

    const row = t.db.prepare(
      'SELECT id, cm_id, suggested_narrative FROM timers WHERE id=?'
    ).get(timer.id);
    const owners = ownersOfText(t, row.suggested_narrative);
    const foreign = owners.filter((o) => o.matter_id !== fresh.id);

    assert.deepEqual(
      foreign, [],
      'SQLite row timers.id=' + row.id + ' (cm_id=' + row.cm_id + ' = Ridgeline '
      + 'Permit, which has ZERO entries of its own) holds suggested_narrative='
      + JSON.stringify(row.suggested_narrative)
      + ' — text owned by ' + JSON.stringify(foreign),
    );
  }));

// ---------------------------------------------------------------------------
// LEAK B — reachability. The value is served to the browser on GET /api/timers,
// which is where the stop-timer chip reads it (public/js/components/
// stopchips.js: add(timer.suggested_narrative, { ai: true, own: false })).
// ---------------------------------------------------------------------------
test('LEAK B: GET /api/timers hands the sibling narrative to the client as the new matter’s suggestion', () =>
  withServer(async (t) => {
    const busy = await mkCm(t, CM_BUSY, 'Harbor Lease', CLIENT_A);
    const fresh = await mkCm(t, CM_NEW, 'Ridgeline Permit', CLIENT_A);
    await addEntry(t, busy.id, TODAY, BUSY_NARRATIVE, 'Call/Conference');
    const timer = await startTimer(t, 'Ridgeline Permit', fresh.id);

    const served = (await t.fetchJson('GET', '/api/timers')).body
      .find((x) => x.id === timer.id);

    assert.ok(
      !/Harbor Lease termination notice/i.test(String(served.suggested_narrative || '')),
      'GET /api/timers served the Harbor Lease sentence on the Ridgeline Permit '
      + 'timer: ' + JSON.stringify(served.suggested_narrative),
    );
  }));

// ---------------------------------------------------------------------------
// LEAK C — the read endpoint every other consumer uses (stop chips, close-out,
// the entry list's inline narrative field, the editor) offers the same text,
// and labels it source:'client' — the server KNOWS it is borrowed and hands it
// over anyway; doStart never reads that field.
// ---------------------------------------------------------------------------
test('LEAK C: GET /api/matters/:id/suggestions offers the sibling’s sentence, flagged source:"client"', () =>
  withServer(async (t) => {
    const busy = await mkCm(t, CM_BUSY, 'Harbor Lease', CLIENT_A);
    const fresh = await mkCm(t, CM_NEW, 'Ridgeline Permit', CLIENT_A);
    await addEntry(t, busy.id, TODAY, BUSY_NARRATIVE, 'Call/Conference');

    const body = (await t.fetchJson('GET', `/api/matters/${fresh.id}/suggestions`)).body;
    const leaked = (body.phrases || []).filter(
      (p) => ownersOfText(t, p.text).some((o) => o.matter_id !== fresh.id)
    );

    assert.deepEqual(
      leaked, [],
      `GET /api/matters/${fresh.id}/suggestions (borrowed=${body.borrowed}) returned `
      + `narratives belonging to another matter: ${JSON.stringify(leaked)}`,
    );
  }));

// ---------------------------------------------------------------------------
// LEAK D (variation 1) — the REALISTIC shape, not the empty-matter one. The new
// matter is not empty: it has one narrative of its own from three weeks ago.
// The blend still fires (own ranked phrases < THIN_PHRASES = 5) and the busy
// sibling's sentence, used on three recent days, outranks the matter's own.
// This is the case a lawyer meets every time a second matter opens for a
// client he already works for.
// ---------------------------------------------------------------------------
test('LEAK D: a THIN (not empty) matter is stamped with the busy sibling’s sentence, outranking its own', () =>
  withServer(async (t) => {
    const busy = await mkCm(t, CM_BUSY, 'Harbor Lease', CLIENT_A);
    const thin = await mkCm(t, CM_NEW, 'Ridgeline Permit', CLIENT_A);

    await addEntry(t, thin.id, '2026-07-24',
      'Open file and calendar the Ridgeline Permit appeal deadline.', 'Other');
    for (const d of ['2026-08-11', '2026-08-12', '2026-08-13']) {
      await addEntry(t, busy.id, d, BUSY_NARRATIVE, 'Call/Conference');
    }

    const timer = await startTimer(t, 'Ridgeline Permit', thin.id);
    const got = t.db.prepare('SELECT suggested_narrative FROM timers WHERE id=?')
      .get(timer.id).suggested_narrative;
    const foreign = ownersOfText(t, got).filter((o) => o.matter_id !== thin.id);

    assert.deepEqual(
      foreign, [],
      'the thin matter’s timer suggestion is ' + JSON.stringify(got)
      + ' — owned by ' + JSON.stringify(foreign)
      + ' (thin matter is id ' + thin.id + ')',
    );
  }));

// ---------------------------------------------------------------------------
// LEAK E (variation 2) — the SAME root cause reaches the AI prompt. The brief:
// "Where a prompt includes before/after narrative pairs as examples, those
// pairs come from the same matter." matterAiContext() calls the same
// matterSuggestions(), and captions the borrowed sentences with a claim that
// is false: "The attorney's recent work on THIS matter".
// ---------------------------------------------------------------------------
test('LEAK E: matterAiContext puts the sibling’s narrative in the prompt under "this matter"', () =>
  withServer(async (t) => {
    const { matterAiContext } = await import('../server/routes/ai.js');
    const busy = await mkCm(t, CM_BUSY, 'Harbor Lease', CLIENT_A);
    const fresh = await mkCm(t, CM_NEW, 'Ridgeline Permit', CLIENT_A);
    await addEntry(t, busy.id, TODAY, BUSY_NARRATIVE, 'Call/Conference');

    const ctx = String(matterAiContext(t.db, fresh.id, TODAY) || '');

    assert.ok(
      !/Harbor Lease termination notice/i.test(ctx),
      'the prompt context built for the Ridgeline Permit matter contains the '
      + 'Harbor Lease matter’s billing sentence:\n' + ctx,
    );
  }));

// ---------------------------------------------------------------------------
// CONTROL 1 — a DIFFERENT client must not bleed. This passing while the tests
// above fail pins the mechanism to the client-scoped sibling blend
// (SIBLING_PHRASES joins on m.client_id), not to something wider.
// ---------------------------------------------------------------------------
test('CONTROL 1: another CLIENT’s narrative does not reach the new matter', () =>
  withServer(async (t) => {
    const other = await mkCm(t, CM_OTHER_CLIENT, 'Borealis Merger', 'Acme Holdings');
    const fresh = await mkCm(t, CM_NEW, 'Ridgeline Permit', CLIENT_A);
    await addEntry(t, other.id, TODAY,
      'Draft the Borealis Merger disclosure schedules and circulate to R. Okafor.', 'Draft');

    const timer = await startTimer(t, 'Ridgeline Permit', fresh.id);
    const got = t.db.prepare('SELECT suggested_narrative FROM timers WHERE id=?')
      .get(timer.id).suggested_narrative;

    assert.equal(got, null, 'cross-CLIENT bleed: ' + JSON.stringify(got));
  }));

// ---------------------------------------------------------------------------
// CONTROL 2 — a matter with a FAT history of its own (>= THIN_PHRASES ranked
// phrases) must not blend at all. This pins the trigger: the leak fires exactly
// when the matter is new or thin, which is exactly when a lawyer starts its
// first timers.
// ---------------------------------------------------------------------------
test('CONTROL 2: a matter with its own fat history does not borrow at all', () =>
  withServer(async (t) => {
    const busy = await mkCm(t, CM_BUSY, 'Harbor Lease', CLIENT_A);
    const fat = await mkCm(t, CM_NEW, 'Ridgeline Permit', CLIENT_A);
    await addEntry(t, busy.id, TODAY, BUSY_NARRATIVE, 'Call/Conference');
    const ownLines = [
      'Review the Ridgeline Permit staff report and prepare comments.',
      'Confer with the planning department regarding the Ridgeline Permit hearing date.',
      'Draft the Ridgeline Permit appeal statement of grounds.',
      'Revise the Ridgeline Permit appeal statement following review.',
      'Prepare the Ridgeline Permit exhibit index for the hearing binder.',
      'Attend the Ridgeline Permit pre-hearing conference.',
    ];
    for (let i = 0; i < ownLines.length; i += 1) {
      await addEntry(t, fat.id, `2026-08-0${i + 1}`, ownLines[i], 'Other');
    }

    const body = (await t.fetchJson('GET', `/api/matters/${fat.id}/suggestions`)).body;
    assert.equal(body.borrowed, false, 'a fat matter still borrowed');

    const timer = await startTimer(t, 'Ridgeline Permit', fat.id);
    const got = t.db.prepare('SELECT suggested_narrative FROM timers WHERE id=?')
      .get(timer.id).suggested_narrative;
    const foreign = ownersOfText(t, got).filter((o) => o.matter_id !== fat.id);
    assert.deepEqual(foreign, [], 'fat matter borrowed: ' + JSON.stringify(got));
  }));
