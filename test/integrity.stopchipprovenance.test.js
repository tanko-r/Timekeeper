// =========================================================================
// DATA-INTEGRITY — the STOP-TIMER OFFER's chips and the provenance it claims
//
// THE FIRST THREE TESTS IN THIS FILE ARE EXPECTED TO FAIL ON THE CURRENT
// CODE. They are written to PROVE a leak, not to pass. The assertion is the
// specification (docs/ui/BRIEF.md, "Data integrity"):
//
//   "Stop-timer chips suggest two things, both matter-scoped: 1. The last
//    couple of narratives used on THAT matter. 2. One AI-generated narrative
//    that extrapolates the likely next step from that matter's own prior
//    narratives. If the matter has no prior narratives, offer generic
//    phrasing or offer nothing — never another matter's sentence, however
//    good a match it looks."
//
// STATUS 2026-08-15: the three LEAK tests now PASS, and must keep passing.
// They are closed on two independent fences — the server no longer lends a
// sibling matter's NARRATIVE to a thin matter (matterSuggestions borrows task
// fragments only), and stopchips.js `build()` drops anything the endpoint
// marks `source: 'client'` before it can become a chip. Either fence alone
// would turn these green, which is why both are kept and why the copy below
// was re-derived rather than deleted.
//
// NOT tested here because the brief says they are shared BY DESIGN and are
// NOT defects: the phrasebook as a concept, text expansions, and ghost text.
//
// HOW THIS WAS VERIFIED BEYOND THIS FILE. These node tests drive the real
// endpoint the offer calls and then run a verbatim copy of the offer's own
// chip pipeline over the response (the copy is guarded by the last test).
// The same scenario was also driven end to end in headless Chromium against
// a real server and a temp database — stop a timer on the cold matter, tap a
// chip, then read SQLite. Observed there:
//
//   chip title : "You wrote this on this matter before — finish the entry
//                 with: Draft correspondence to landlord regarding the
//                 Harbor Lease holdover dispute."   (⟲ history icon)
//   entries    : {"id":5,"cm_id":2,"matter":"Ridgeline Permit",
//                 "narrative":"Draft correspondence to landlord regarding
//                 the Harbor Lease holdover dispute.","narrative_ai":0}
//   …which is verbatim entry id 2, cm_id 1, matter "Harbor Lease".
// =========================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startTestServer } from './helpers.js';
import { formatSuggestion } from '../public/js/lib/narrativesync.js';
import { containsTimeAmounts } from '../public/js/lib/timeamounts.js';

async function withServer(fn) {
  const t = await startTestServer();
  try { return await fn(t); } finally { await t.close(); }
}

const mkCm = async (t, cm_number, short_name, client_name) =>
  (await t.fetchJson('POST', '/api/cms', { cm_number, short_name, client_name })).body;

// House fictional names only. Two matters of the SAME client.
const CM_HARBOR = '100001-000010'; // Northgate Partners — Harbor Lease (worked)
const CM_RIDGE = '100001-000020';  // Northgate Partners — Ridgeline Permit (cold)

// Whole client-facing sentences, unmistakably about Harbor Lease and nothing
// else. Three of them, because that is the ordinary shape of a matter that
// has been worked more than once — and because the offer's top chip is
// deduped against timers.suggested_narrative, so a single-narrative sibling
// hides the mislabel behind the ✦ "suggested when this timer started" chip.
const HARBOR = [
  'Review and analyze the Harbor Lease termination notice and confer with T. Vance regarding same',
  'Draft correspondence to landlord regarding the Harbor Lease holdover dispute',
  'Telephone conference with T. Vance concerning Harbor Lease estoppel certificates',
];

async function coldMatterOffer(t, { ownNarrative = null } = {}) {
  const harbor = await mkCm(t, CM_HARBOR, 'Harbor Lease', 'Northgate Partners');
  const ridge = await mkCm(t, CM_RIDGE, 'Ridgeline Permit', 'Northgate Partners');
  let d = 10;
  for (const n of HARBOR) {
    await t.fetchJson('POST', '/api/entries', {
      date: `2026-08-${d++}`, cm_id: harbor.id, narrative: n,
      tasks: [{ task_code: 'Review', duration: 0.6, fragment: '' }],
    });
  }
  if (ownNarrative) {
    await t.fetchJson('POST', '/api/entries', {
      date: '2026-08-13', cm_id: ridge.id, narrative: ownNarrative,
      tasks: [{ task_code: 'Review', duration: 0.4, fragment: '' }],
    });
  }
  // The timer the offer belongs to: started on the cold matter, which is
  // where routes/timers.js stamps timers.suggested_narrative.
  const timer = (await t.fetchJson('POST', '/api/timers',
    { name: 'Ridgeline Permit', cm_id: ridge.id })).body;
  await t.fetchJson('POST', `/api/timers/${timer.id}/start`, { minutesAgo: 10 });
  const stamped = t.db.prepare('SELECT suggested_narrative FROM timers WHERE id=?').get(timer.id);
  const r = await t.fetchJson('GET', `/api/matters/${ridge.id}/suggestions`);
  return {
    harbor, ridge,
    chips: buildChips(stamped.suggested_narrative, r.body.phrases),
  };
}

// ---------------------------------------------------------------------------
// A VERBATIM COPY of the offer's chip pipeline — public/js/components/
// stopchips.js `build()` (the `borrowed` fence, the `add`/dedupe body and the
// slice) plus the title expression from the chip render. Copied rather than
// imported because stopchips.js is a browser module with absolute `/js/…`
// imports. The last test in this file fails if the original drifts from this
// copy.
//
// RE-DERIVED 2026-08-15 from the current stopchips.js, which the fence work
// edited legitimately: `build()` now drops every phrase marked
// `source: 'client'` BY TEXT before anything else runs ("MATTER FENCE 2"), so
// a borrowed sentence can reach neither the chip list nor the timer's stamped
// ✦ line. The three LEAK tests below were re-run against this re-derived copy
// and still hold. Nothing in their assertions was changed.
// ---------------------------------------------------------------------------
function buildChips(suggestedNarrative, phrases) {
  const borrowed = new Set();
  for (const p of phrases || []) {
    if (p.source !== 'client') continue;
    const text = formatSuggestion(String(p.text || '').trim());
    if (text) borrowed.add(text.toLowerCase());
  }
  const byKey = new Map();
  const order = [];
  const add = (raw, meta) => {
    const src = String(raw || '').trim();
    if (!src || containsTimeAmounts(src)) return;
    const text = formatSuggestion(src);
    if (!text) return;
    const k = text.toLowerCase();
    if (borrowed.has(k)) return; // fence 2 — another matter's sentence
    const had = byKey.get(k);
    if (had) {
      if (meta.own) { had.own = true; had.ai = false; }
      return;
    }
    const chip = { text, ai: !!meta.ai, own: !!meta.own };
    byKey.set(k, chip);
    order.push(chip);
  };
  add(suggestedNarrative, { ai: true, own: false });
  for (const p of phrases) {
    if (p.source === 'client') continue; // fence 2
    add(p.text, { ai: false, own: true });
  }
  return order.slice(0, 3);
}

// stopchips.js chip render, `title=` — the whole of it. `chip.ai` is still the
// only input, so this expression on its own STILL cannot tell a borrowed
// sentence from his own; what changed is that `build()` above no longer lets
// one through to be labelled.
const chipTitle = (chip) => (chip.ai
  ? `Suggested when this timer started — finish the entry with: ${chip.text}`
  : `You wrote this on this matter before — finish the entry with: ${chip.text}`);

const isHarbors = (text) => HARBOR.some((h) => formatSuggestion(h) === text);

// ---------------------------------------------------------------------------
// LEAK A — the offer on a cold matter renders its SIBLING matter's finished
// narratives as one-tap chips. Tapping one PATCHes that sentence onto this
// matter's entry (verified in the browser; see the header).
// ---------------------------------------------------------------------------
test('LEAK: the stop offer on a cold matter renders a sibling matter\'s narratives as chips', () =>
  withServer(async (t) => {
    const { chips } = await coldMatterOffer(t);
    const borrowed = chips.filter((c) => isHarbors(c.text));
    assert.deepEqual(borrowed.map((c) => c.text), [],
      'Ridgeline Permit\'s stop offer puts Harbor Lease\'s billing sentences one tap from its entry:\n'
      + chips.map((c) => `  ${c.ai ? '✦' : '⟲'} ${c.text}`).join('\n'));
  }));

// ---------------------------------------------------------------------------
// LEAK B — and it says they are HIS, ON THIS MATTER. The chip's provenance is
// derived from `chip.ai` alone; `source` never reaches the render, so every
// borrowed phrase that is not the timer's own stamped suggestion draws the ⟲
// history icon and the sentence "You wrote this on this matter before".
// That is the prohibited display plus an affirmative false claim about it.
// ---------------------------------------------------------------------------
test('LEAK: a borrowed sentence is labelled "You wrote this on this matter before"', () =>
  withServer(async (t) => {
    const { chips } = await coldMatterOffer(t);
    const lying = chips
      .map((c) => chipTitle(c))
      .filter((title) => title.startsWith('You wrote this on this matter before')
        && HARBOR.some((h) => title.includes(h)));
    assert.deepEqual(lying, [],
      'the offer claims Harbor Lease\'s work as Ridgeline Permit\'s own history');
  }));

// ---------------------------------------------------------------------------
// LEAK C — the same mislabel with the auto-write gate ENGAGED, which is the
// worst framing of it: the offer writes his real Ridgeline sentence, says
// "Written in from your own wording on this matter — already saved", and then
// heads the borrowed chips "Or use one of these instead:". Two sentences from
// a different matter, presented as peers of his own.
// ---------------------------------------------------------------------------
test('LEAK: "Or use one of these instead" offers another matter\'s sentences', () =>
  withServer(async (t) => {
    const own = 'Review the Ridgeline Permit application and the county checklist';
    const { chips } = await coldMatterOffer(t, { ownNarrative: own });
    const settled = chips.find((c) => !c.ai && c.own);
    assert.ok(settled && settled.text === formatSuggestion(own),
      'precondition: the pre-fill should write his own Ridgeline sentence');
    const alternatives = chips.filter((c) => c.text !== settled.text);
    assert.deepEqual(alternatives.filter((c) => isHarbors(c.text)).map((c) => c.text), [],
      'the alternatives under "Or use one of these instead" are Harbor Lease\'s narratives');
  }));

// ---------------------------------------------------------------------------
// GUARD — this one PASSES today and must keep passing. The unasked write is
// correctly gated: only `source: 'matter'` text can be PATCHed without a tap
// (`own: p.source !== 'client'`, and the pre-fill filters on `!c.ai && c.own`).
// Whoever fixes the render must not break this gate.
// ---------------------------------------------------------------------------
test('GATE HOLDS: nothing borrowed is ever eligible for the unasked pre-fill', () =>
  withServer(async (t) => {
    const own = 'Review the Ridgeline Permit application and the county checklist';
    for (const scenario of [{}, { ownNarrative: own }]) {
      const { chips } = await coldMatterOffer(t, scenario);
      const autoEligible = chips.filter((c) => !c.ai && c.own);
      assert.deepEqual(autoEligible.filter((c) => isHarbors(c.text)).map((c) => c.text), [],
        'a borrowed phrase became eligible for the write that happens with no tap');
      await t.db.prepare('DELETE FROM entries').run();
      await t.db.prepare('DELETE FROM timers').run();
      await t.db.prepare('DELETE FROM matters').run();
      await t.db.prepare('DELETE FROM clients').run();
    }
  }));

// ---------------------------------------------------------------------------
// GUARD — the copy above is only evidence while it is still a copy. If this
// fails, stopchips.js has been edited: re-derive `buildChips` / `chipTitle`
// from the new source and re-run the three LEAK tests before believing them.
// ---------------------------------------------------------------------------
test('GUARD: the pipeline copied into this file still matches stopchips.js', () => {
  const src = readFileSync(
    fileURLToPath(new URL('../public/js/components/stopchips.js', import.meta.url)), 'utf8');
  // Pinned to the three lines the copy above depends on: the fence that builds
  // the borrowed set, the fence that drops it inside `add`, and the fence in
  // the phrase loop. Any of them moving invalidates the copy.
  assert.ok(
    src.includes("if (p.source !== 'client') continue;")
    && src.includes('if (text) borrowed.add(text.toLowerCase());'),
    'stopchips.js borrowed-set fence changed — re-derive buildChips() in this file');
  assert.ok(
    src.includes('if (borrowed.has(k)) return;')
    && src.includes("if (p.source === 'client') continue;")
    && src.includes("add(p.text, { ai: false, own: true });"),
    'stopchips.js build() changed — re-derive buildChips() in this file');
  assert.ok(
    src.includes('`You wrote this on this matter before — finish the entry with: ${chip.text}`'),
    'stopchips.js chip title changed — re-derive chipTitle() in this file');
});
