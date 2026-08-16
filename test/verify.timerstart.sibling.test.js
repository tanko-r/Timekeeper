// =========================================================================
// ADVERSARIAL VERIFICATION — independent reproduction of the claim:
//   "Starting a timer on a cold matter stamps a sibling matter's narrative
//    onto timers.suggested_narrative"  (server/routes/timers.js doStart)
//
// THESE TESTS ARE WRITTEN TO PROVE A LEAK BY FAILING. Do not "fix the test".
// The assertion is the specification (docs/ui/BRIEF.md, "Data integrity"):
// a narrative written for matter A may never be shown as belonging to,
// suggested for, or pre-filled into an entry for matter B — not across
// clients, and not between two matters of the SAME client.
//
// Written by the verifier, independently of the claimant's
// test/integrity.suggestions.test.js. Every assertion reads the real SQLite
// row on a real server started by test/helpers.js.
//
// Expected on current code: the three LEAK tests FAIL, the CONTROL passes.
// =========================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

async function withServer(fn) {
  const t = await startTestServer();
  try { return await fn(t); } finally { await t.close(); }
}

const mkCm = async (t, cm_number, short_name, client_name) => {
  const r = await t.fetchJson('POST', '/api/cms', { cm_number, short_name, client_name });
  assert.equal(r.status < 300, true, `cm create failed: ${JSON.stringify(r.body)}`);
  return r.body;
};

// House fictional names only. Two matters of the SAME client.
const CM_WARM = '900001-000010'; // Northgate Partners — Harbor Lease (has history)
const CM_COLD = '900001-000020'; // Northgate Partners — Ridgeline Permit (cold)
const CM_OTHERCLIENT = '900002-000010'; // Acme Holdings — Borealis Merger

// A sentence unmistakably ABOUT Harbor Lease and nobody else: it names the
// matter, the document, and a person. This is a billing narrative, not
// reusable phrasing.
const WARM_NARRATIVE =
  'Review and analyze the Harbor Lease termination notice and confer with T. Vance regarding same.';

// Find every matter whose entries carry this text. rankPhrases ->
// normalizePhrase strips the trailing period, so match on a prefix.
function ownersOf(t, text) {
  return t.db.prepare(
    `SELECT DISTINCT m.id, m.short_name FROM entries e JOIN matters m ON m.id = e.cm_id
      WHERE e.deleted_at IS NULL AND e.narrative LIKE ? || '%'`
  ).all(text || 'never-matches-anything');
}

// -------------------------------------------------------------------------
// REPRO 1 — exactly as claimed: one prior narrative on the sibling matter,
// then start a timer on the cold matter, then read the DB row.
// -------------------------------------------------------------------------
test('LEAK: timer start on a cold matter persists the sibling matter\'s narrative', () =>
  withServer(async (t) => {
    const warm = await mkCm(t, CM_WARM, 'Harbor Lease', 'Northgate Partners');
    const cold = await mkCm(t, CM_COLD, 'Ridgeline Permit', 'Northgate Partners');

    await t.fetchJson('POST', '/api/entries', {
      date: '2026-08-10',
      cm_id: warm.id,
      narrative: WARM_NARRATIVE,
      tasks: [{ task_code: 'Review', duration: 0.6, fragment: '' }],
    });

    const timer = (await t.fetchJson('POST', '/api/timers',
      { name: 'Ridgeline Permit', cm_id: cold.id })).body;
    const started = await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
    assert.equal(started.status, 200, JSON.stringify(started.body));

    // Read the stored row directly — this is the evidence that matters.
    const row = t.db.prepare(
      'SELECT id, cm_id, suggested_narrative FROM timers WHERE id=?'
    ).get(timer.id);
    const owners = ownersOf(t, row.suggested_narrative);

    assert.equal(
      row.suggested_narrative, null,
      `timers.suggested_narrative for the COLD matter (cm_id=${row.cm_id} = `
      + `Ridgeline Permit) holds ${JSON.stringify(row.suggested_narrative)} — text `
      + `owned by matter(s) ${JSON.stringify(owners)}`
    );
  }));

// -------------------------------------------------------------------------
// REPRO 2 (variation) — the phrase the endpoint ranks first is exactly what
// got stamped, and the endpoint itself labels it source:'client'. This pins
// the mechanism: doStart takes phrases[0] and never reads p.source.
// -------------------------------------------------------------------------
test('LEAK: the stamped text is the endpoint\'s own source:"client" phrase', () =>
  withServer(async (t) => {
    const warm = await mkCm(t, CM_WARM, 'Harbor Lease', 'Northgate Partners');
    const cold = await mkCm(t, CM_COLD, 'Ridgeline Permit', 'Northgate Partners');
    await t.fetchJson('POST', '/api/entries', {
      date: '2026-08-10', cm_id: warm.id, narrative: WARM_NARRATIVE,
      tasks: [{ task_code: 'Review', duration: 0.6, fragment: '' }],
    });

    const sugg = (await t.fetchJson('GET', `/api/matters/${cold.id}/suggestions`)).body;
    const top = (sugg.phrases || [])[0];

    const timer = (await t.fetchJson('POST', '/api/timers',
      { name: 'Ridgeline Permit', cm_id: cold.id })).body;
    await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
    const row = t.db.prepare('SELECT suggested_narrative FROM timers WHERE id=?').get(timer.id);

    assert.notEqual(
      top && top.source, 'client',
      `/api/matters/${cold.id}/suggestions ranks a source:"client" phrase first `
      + `(${JSON.stringify(top)}), and timers.suggested_narrative now holds `
      + `${JSON.stringify(row.suggested_narrative)}`
    );
  }));

// -------------------------------------------------------------------------
// REPRO 3 (variation) — the realistic shape. The cold matter is NOT empty: it
// has one narrative of its own from three weeks ago. The sibling matter is
// the busy one. The blend still fires (own ranked phrases < THIN_PHRASES=5)
// and the sibling's sentence outranks the matter's own.
// -------------------------------------------------------------------------
test('LEAK: a thin (not empty) matter is stamped with the busy sibling\'s sentence', () =>
  withServer(async (t) => {
    const warm = await mkCm(t, CM_WARM, 'Harbor Lease', 'Northgate Partners');
    const cold = await mkCm(t, CM_COLD, 'Ridgeline Permit', 'Northgate Partners');

    // the cold matter's own single prior narrative, three weeks back
    await t.fetchJson('POST', '/api/entries', {
      date: '2026-07-20', cm_id: cold.id,
      narrative: 'Open file and calendar the Ridgeline Permit appeal deadline.',
      tasks: [{ task_code: 'Other', duration: 0.2, fragment: '' }],
    });
    // the sibling is the busy matter — same sentence used on three recent days
    for (const date of ['2026-08-10', '2026-08-11', '2026-08-12']) {
      await t.fetchJson('POST', '/api/entries', {
        date, cm_id: warm.id, narrative: WARM_NARRATIVE,
        tasks: [{ task_code: 'Review', duration: 0.6, fragment: '' }],
      });
    }

    const timer = (await t.fetchJson('POST', '/api/timers',
      { name: 'Ridgeline Permit', cm_id: cold.id })).body;
    await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
    const got = t.db.prepare('SELECT suggested_narrative FROM timers WHERE id=?')
      .get(timer.id).suggested_narrative;

    assert.equal(
      ownersOf(t, got).every((m) => m.id === cold.id), true,
      `Ridgeline's timer suggestion is ${JSON.stringify(got)}, owned by `
      + `${JSON.stringify(ownersOf(t, got))} — cold matter is id ${cold.id}`
    );
  }));

// -------------------------------------------------------------------------
// CONTROL — a DIFFERENT client must not bleed. This passing while the tests
// above fail confirms the mechanism is the client-scoped sibling blend
// (SIBLING_PHRASES joins on m.client_id), not something wider.
// -------------------------------------------------------------------------
test('CONTROL: a different client\'s narrative does NOT reach the cold matter', () =>
  withServer(async (t) => {
    const other = await mkCm(t, CM_OTHERCLIENT, 'Borealis Merger', 'Acme Holdings');
    const cold = await mkCm(t, CM_COLD, 'Ridgeline Permit', 'Northgate Partners');
    await t.fetchJson('POST', '/api/entries', {
      date: '2026-08-10', cm_id: other.id,
      narrative: 'Draft the Borealis Merger disclosure schedules and circulate to R. Okafor.',
      tasks: [{ task_code: 'Draft', duration: 0.6, fragment: '' }],
    });

    const timer = (await t.fetchJson('POST', '/api/timers',
      { name: 'Ridgeline Permit', cm_id: cold.id })).body;
    await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
    const got = t.db.prepare('SELECT suggested_narrative FROM timers WHERE id=?')
      .get(timer.id).suggested_narrative;
    assert.equal(got, null, `cross-CLIENT bleed: ${JSON.stringify(got)}`);
  }));
