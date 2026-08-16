// =========================================================================
// ADVERSARIAL VERIFICATION — "close-out pre-fills a sibling matter's
// narrative, then finalizes and exports it"
//
// EVERY TEST IN THIS FILE IS EXPECTED TO FAIL ON THE CURRENT CODE.
// They exist to PROVE a leak, not to pass. Do not "fix the test" — the
// assertion IS the specification (docs/ui/BRIEF.md, "Data integrity"):
//
//   A narrative — the client-facing sentence describing work done on a
//   specific matter — may never be shown as belonging to, suggested for,
//   pre-filled into, or written onto an entry for a DIFFERENT matter. Not
//   across clients, and not between two matters of the same client.
//
// This file was written independently of the claim under review. It walks
// the ORDINARY path a lawyer walks — a client with an old matter and a new
// one, a timer started and stopped on the new matter, then "Close the day" —
// and it replicates close-out's own client-side expressions LINE FOR LINE
// (public/js/components/closeout.js: the suggestions fetch at ~line 263,
// `valueOf` at ~line 199, `finalizeAndExport` at ~line 378) against a real
// server on a temp database. It then reads the stored rows and the exported
// CSV bytes directly.
//
// NOTE ON THE ASSERTIONS: the phrasebook normalizes text before ranking
// (server/lib/phrasebook.js `normalizePhrase` collapses whitespace and
// strips trailing punctuation), so what comes back is the narrative minus
// its final period. Asserting on the raw string alone gives a FALSE PASS —
// a naive `phrases.includes(NARRATIVE)` check looks clean while the whole
// sentence, every party and document intact, is sitting in the response.
// These tests assert on the normalized form.
//
// NOT tested here, because it is shared BY DESIGN and is not a defect: the
// phrasebook's role as reusable WORDING, text expansions, ghost text, and
// generic style guidance in prompts.
// =========================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';
import { containsTimeAmounts } from '../server/lib/timeAmounts.js';
import { normalizePhrase } from '../server/lib/phrasebook.js';

// A controllable clock, so a timer can run for a realistic stretch instead of
// tripping the 2-second misclick grace in routes/timers.js `stopAndFile`.
async function withServer(fn) {
  const state = { now: new Date('2026-08-15T10:00:00-07:00') };
  const t = await startTestServer({ clock: () => state.now });
  t.tick = (mins) => { state.now = new Date(state.now.getTime() + mins * 60_000); };
  try { return await fn(t); } finally { await t.close(); }
}

// House fictional names only (BRIEF: no real client/matter data in the repo).
const CLIENT = 'Northgate Partners';
const CM_WARM = '100001-000010'; // Harbor Lease — worked before
const CM_COLD = '100001-000020'; // Ridgeline Permit — brand new, no history

// A whole client-facing billing sentence, unmistakably about Harbor Lease.
// It carries a party name and a document. If these words ever appear on a
// Ridgeline Permit row, a narrative has crossed a matter boundary.
const WARM_NARRATIVE =
  'Review and analyze the Harbor Lease termination notice and confer with T. Vance regarding same.';
// what the phrasebook actually hands back (trailing period stripped)
const WARM_RANKED = normalizePhrase(WARM_NARRATIVE);

const mkCm = async (t, cm_number, short_name) =>
  (await t.fetchJson('POST', '/api/cms', { cm_number, short_name, client_name: CLIENT })).body;

// The ordinary setup: one client, two matters, history on the older one only.
async function seed(t) {
  const warm = await mkCm(t, CM_WARM, 'Harbor Lease');
  const cold = await mkCm(t, CM_COLD, 'Ridgeline Permit');
  const today = (await t.fetchJson('GET', '/api/dashboard')).body.date;
  const back = new Date(`${today}T12:00:00`);
  back.setDate(back.getDate() - 7);
  const then = back.toISOString().slice(0, 10);
  // One ordinary finished entry on the older matter last week: a narrative
  // plus the one task line a stopped timer leaves behind. Finalized, so it is
  // not part of today's close-out — only its WORDS travel.
  const e = (await t.fetchJson('POST', '/api/entries', {
    date: then, cm_id: warm.id, narrative: WARM_NARRATIVE,
    tasks: [{ task_code: 'A104', duration: 0.6, fragment: '' }],
  })).body;
  t.db.prepare("UPDATE entries SET status='finalized', ever_finalized=1 WHERE id=?").run(e.id);
  return { warm, cold, today, then };
}

// Stop a timer on the cold matter with no narrative written — the exact
// state close-out is built for: a draft that still needs words.
async function timerDraftOn(t, cmId, name) {
  const timer = (await t.fetchJson('POST', '/api/timers', { name, cm_id: cmId })).body;
  await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
  t.tick(24); // twenty-four minutes of real work
  const stopped = (await t.fetchJson('POST', `/api/timers/${timer.id}/stop`)).body;
  assert.ok(stopped.entry, `precondition: the stop should file an entry (got ${JSON.stringify(stopped)})`);
  return stopped.entry;
}

// closeout.js line ~263, verbatim:
//   .then((r) => [id, r.phrases.map((p) => p.text).filter((t) => !containsTimeAmounts(t))])
// closeout.js `valueOf` line ~199, verbatim, for an untouched field:
//   return (sugg[g.cm?.id] || [])[0] || '';
async function closeoutPrefillFor(t, cmId) {
  const r = await t.fetchJson('GET', `/api/matters/${cmId}/suggestions`);
  assert.equal(r.status, 200, 'suggestions endpoint should answer');
  const list = r.body.phrases.map((p) => p.text).filter((x) => !containsTimeAmounts(x));
  return { prefill: list[0] || '', list, body: r.body };
}

// -------------------------------------------------------------------------
// 1. THE SOURCE. A matter with no history of its own is served its sibling
//    matter's whole billing sentence, and close-out's own expression picks
//    that sentence as the VALUE of the narrative box.
// -------------------------------------------------------------------------
test('LEAK: close-out pre-fills a cold matter\'s box with its sibling matter\'s narrative', () =>
  withServer(async (t) => {
    const { cold } = await seed(t);
    await timerDraftOn(t, cold.id, 'Ridgeline Permit');

    const { prefill, list } = await closeoutPrefillFor(t, cold.id);

    // Ridgeline Permit has never been worked on. The only honest pre-fill is
    // an empty box or generic phrasing — never Harbor Lease's sentence.
    assert.notEqual(prefill, WARM_RANKED,
      'close-out\'s narrative box for Ridgeline Permit opens holding Harbor Lease\'s sentence.\n'
      + `  box value: ${JSON.stringify(prefill)}\n`
      + `  full list: ${JSON.stringify(list)}`);
  }));

// -------------------------------------------------------------------------
// 2. THE CONSEQUENCE. Nothing further is typed. The lawyer presses the one
//    primary button. `finalizeAndExport(false)` (closeout.js ~line 378)
//    writes every non-blank box, finalizes the day, and exports.
//
//    This test replicates that button's exact sequence and then reads the
//    STORED ROW and the CSV BYTES — the only proof that matters.
// -------------------------------------------------------------------------
test('LEAK: the sibling\'s narrative is saved, finalized and exported onto the cold matter', () =>
  withServer(async (t) => {
    const { warm, cold, today } = await seed(t);
    const draft = await timerDraftOn(t, cold.id, 'Ridgeline Permit');
    assert.equal(draft.narrative, '', 'precondition: the stopped timer left a blank narrative');

    const { prefill } = await closeoutPrefillFor(t, cold.id);

    // ---- finalizeAndExport(false), step for step ----
    // "for (const g of needs) { const text = valueOf(g); if (!text.trim())
    //   continue; for (const d of g.blank) await save(d, text); }"
    if (String(prefill).trim()) {
      await t.fetchJson('PATCH', `/api/entries/${draft.id}`, { narrative: prefill });
    }
    // "const r = await api.post('/api/finalize-day', { date, ack });"
    const fin = await t.fetchJson('POST', '/api/finalize-day', { date: today, ack: false });
    assert.equal(fin.status, 200);
    // "const r = await api.post('/api/export', { from: date, to: date });"
    const exp = await t.fetchJson('POST', '/api/export', { from: today, to: today });
    assert.equal(exp.status, 200);

    // ---- read the DATABASE directly ----
    const row = t.db.prepare(
      'SELECT e.id, e.cm_id, e.narrative, e.status, e.exported_at, m.short_name, m.client_id '
      + 'FROM entries e LEFT JOIN matters m ON m.id = e.cm_id WHERE e.id = ?'
    ).get(draft.id);

    assert.equal(row.cm_id, cold.id, 'precondition: the row belongs to the cold matter');
    assert.notEqual(normalizePhrase(row.narrative), WARM_RANKED,
      'the stored narrative on the Ridgeline Permit row is Harbor Lease\'s billing sentence.\n'
      + `  entry #${row.id} · matter ${JSON.stringify(row.short_name)} (id ${row.cm_id})\n`
      + `  status ${JSON.stringify(row.status)} · exported_at ${JSON.stringify(row.exported_at)}\n`
      + `  narrative ${JSON.stringify(row.narrative)}\n`
      + `  the same sentence lives on matter id ${warm.id} (Harbor Lease)`);

    // ---- read the exported CSV BYTES ----
    const csv = String(exp.body.csv || '');
    const leaked = csv.split('\n').filter((l) => l.includes('Ridgeline') && l.includes('Harbor Lease'));
    assert.deepEqual(leaked, [],
      'the CSV keyed into the billing system carries Harbor Lease\'s sentence on a '
      + `Ridgeline Permit line:\n${leaked.join('\n')}`);
  }));

// -------------------------------------------------------------------------
// 3. THE SOURCE, STATED PLAINLY. The endpoint hands out another matter's
//    narrative verbatim. `borrowed` is one flag for the whole list and
//    closeout.js keeps only `p.text`, so no consumer can tell which line
//    came from where even if it wanted to.
// -------------------------------------------------------------------------
test('LEAK: /api/matters/:id/suggestions returns another matter\'s narrative verbatim', () =>
  withServer(async (t) => {
    const { cold } = await seed(t);
    const r = await t.fetchJson('GET', `/api/matters/${cold.id}/suggestions`);
    const texts = r.body.phrases.map((p) => p.text);
    assert.ok(!texts.includes(WARM_RANKED),
      'the cold matter\'s phrasebook contains a sibling matter\'s whole billing sentence: '
      + JSON.stringify(r.body, null, 2));
  }));
