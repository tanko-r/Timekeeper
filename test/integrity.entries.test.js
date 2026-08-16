// ---------------------------------------------------------------------------
// DATA-INTEGRITY AUDIT — entry mutation paths (docs/ui/BRIEF.md §"Data
// integrity: non-negotiable").
//
// EVERY TEST IN THIS FILE IS A *PROVING* TEST. Each one asserts the rule the
// brief states, and each one FAILS against the code as it stands on
// ui-overhaul-2026-08. They are the evidence for docs/ui/integrity-entries.md.
// Do NOT weaken an assertion to make the suite green — fix the server.
//
// Findings proven here, in severity order:
//   L1  a SIBLING matter's real narrative is written onto another matter's
//       timer as its suggested narrative (crosses a matter boundary)
//   L2  a timer's stashed draft narrative survives a matter change and seeds
//       the new matter's entry
//   L3  reassigning an entry's matter leaves its timer linked → the next stop
//       files the SAME day clock a second time (double-count)
//   L4  a second timer stop onto a split (multi-line) entry rewrites the
//       billed total but not the task lines → the narrative's allocations
//       contradict the exported hours
//   L5  POST /:id/copy drops AI provenance → model output re-enters the pool
//       the model learns "the attorney's voice" from
//   L6  bulk set_cm moves narratives between matters with no audit row and no
//       recorded previous matter → no route back
// ---------------------------------------------------------------------------
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

function makeClock(startIso) {
  let now = new Date(startIso).getTime();
  const clock = () => new Date(now);
  clock.set = (iso) => { now = new Date(iso).getTime(); };
  clock.advance = (seconds) => { now += seconds * 1000; };
  return clock;
}

const TODAY = '2026-08-14';
const START = '2026-08-14T09:00:00-07:00';

async function withServer(fn, startIso = START) {
  const clock = makeClock(startIso);
  const t = await startTestServer({ clock });
  try {
    await fn(t, clock);
  } finally { await t.close(); }
}

const mkCm = (t, cm_number, short_name, extra = {}) =>
  t.fetchJson('POST', '/api/cms', { cm_number, short_name, billable: 1, ...extra })
    .then((r) => r.body);

// ---------------------------------------------------------------------------
// L1 — CRITICAL. Sibling-matter narrative leak.
//
// BRIEF: "A narrative written for matter A may never be shown as belonging to,
// suggested for, pre-filled into, or written onto an entry for matter B. Not
// across clients, and NOT BETWEEN TWO MATTERS OF THE SAME CLIENT." And:
// stop-timer chips offer "the last couple of narratives used on THAT matter";
// where the matter has no history, "generic phrasing or nothing".
//
// WHAT HAPPENS: matterSuggestions() (server/routes/matters.js) blends
// SIBLING_PHRASES when the matter's own history is thin, and SIBLING_PHRASES
// selects `e.narrative` — whole client-facing sentences — from every OTHER
// matter of the same client. timers.js doStart() takes the top-ranked phrase
// and writes it to timers.suggested_narrative, which is what the stop-timer
// chip offers.
// ---------------------------------------------------------------------------
test('LEAK L1: a sibling matter’s narrative must never become another matter’s suggested narrative', () =>
  withServer(async (t) => {
    // Two matters of the SAME client (100001).
    const easement = await mkCm(t, '100001-000012', 'Fairview easement');
    const lease = await mkCm(t, '100001-000077', 'Northgate lease');

    // A real, matter-specific narrative on the FIRST matter. Single task line,
    // so it counts as a "free narrative" in the phrase index.
    const SECRET = 'Telephone conference with M. Alvarado regarding the Fairview easement survey dispute.';
    await t.fetchJson('POST', '/api/entries', {
      date: TODAY, cm_id: easement.id, narrative: SECRET,
      tasks: [{ task_code: 'Call/Conference', duration: 0.4, fragment: '' }],
    });

    // A brand-new timer on the SECOND matter, which has no history at all.
    const timer = (await t.fetchJson('POST', '/api/timers', {
      name: 'Northgate lease', cm_id: lease.id,
    })).body;
    await t.fetchJson('POST', `/api/timers/${timer.id}/start`);

    const fresh = (await t.fetchJson('GET', '/api/timers')).body
      .find((x) => x.id === timer.id);

    assert.ok(
      !/Fairview easement survey dispute/i.test(String(fresh.suggested_narrative || '')),
      `the Fairview matter's narrative was suggested for the Northgate matter: ${JSON.stringify(fresh.suggested_narrative)}`,
    );

    // And the read endpoint the chips/editor call must not offer it either.
    const sugg = (await t.fetchJson('GET', `/api/matters/${lease.id}/suggestions`)).body;
    assert.ok(
      !sugg.phrases.some((p) => /Fairview easement survey dispute/i.test(p.text)),
      'GET /api/matters/:id/suggestions offered a sibling matter’s narrative',
    );
  }));

// ---------------------------------------------------------------------------
// L2 — HIGH. Stashed draft narrative crosses a matter change.
//
// timers.js PATCH /:id keeps draft_narrative across a cm_id change on purpose
// ("user text — deliberately SURVIVES cmChanged"). That is right for the
// matterless→matter case it was written for. It is wrong for matter A →
// matter B: syncToEntry() seeds EVERY entry the timer later creates with
// `narrative_template + draft_narrative`, so matter A's typed narrative is
// pre-filled onto matter B's entry.
// ---------------------------------------------------------------------------
test('LEAK L2: a timer’s draft narrative must not follow the timer onto a different matter', () =>
  withServer(async (t, clock) => {
    const acme = await mkCm(t, '100001-000012', 'Acme lease');
    const verity = await mkCm(t, '200002-000001', 'Verity merger');

    const timer = (await t.fetchJson('POST', '/api/timers', {
      name: 'Acme lease', cm_id: acme.id,
    })).body;

    // The attorney types narrative text against the ACME timer before any
    // entry exists (the stash).
    const SECRET = 'Review Acme rent abatement schedule and confer with landlord counsel.';
    await t.fetchJson('PATCH', `/api/timers/${timer.id}`, { draft_narrative: SECRET });

    // The timer is re-pointed to a completely different client's matter.
    await t.fetchJson('PATCH', `/api/timers/${timer.id}`, { cm_id: verity.id });

    // Its next entry belongs to Verity.
    await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
    clock.advance(900);
    const stop = (await t.fetchJson('POST', `/api/timers/${timer.id}/stop`)).body;

    assert.equal(stop.entry.cm.id, verity.id);
    assert.ok(
      !/Acme rent abatement/i.test(String(stop.entry.narrative || '')),
      `Acme's narrative was pre-filled onto a Verity entry: ${JSON.stringify(stop.entry.narrative)}`,
    );
  }));

// ---------------------------------------------------------------------------
// L3 — CRITICAL (time loss / double count). Reassigning an entry's matter
// orphans the timer link, and the day-accumulator clock refiles from zero.
//
// finalizeOne() zeroes and unlinks the timer for exactly this reason ("the
// next stop would refile the whole clock into a new entry, double-counting
// it"). PATCH /api/entries/:id (and POST /api/entries/bulk set_cm) change the
// entry's matter without doing either, so syncToEntry()'s
// `entry.cm_id === timer.cm_id` validity check fails at the next stop and the
// WHOLE day clock is filed a second time.
// ---------------------------------------------------------------------------
test('LOSS L3: reassigning an entry’s matter must not let the day clock be filed twice', () =>
  withServer(async (t, clock) => {
    const acme = await mkCm(t, '100001-000012', 'Acme lease');
    const verity = await mkCm(t, '200002-000001', 'Verity merger');

    const timer = (await t.fetchJson('POST', '/api/timers', {
      name: 'Acme lease', cm_id: acme.id,
    })).body;

    await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
    clock.advance(3600); // 1.0h
    const first = (await t.fetchJson('POST', `/api/timers/${timer.id}/stop`)).body;
    assert.equal(first.hours, 1);

    // The attorney realises the hour belonged to a different matter and
    // reassigns the ENTRY (the timer keeps its own label).
    await t.fetchJson('PATCH', `/api/entries/${first.entry.id}`, { cm_id: verity.id });

    // More time on the same clock, then stop again. The clock is a day
    // accumulator: 1.5h TOTAL has now elapsed, not 1.5h more.
    await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
    clock.advance(1800);
    const second = (await t.fetchJson('POST', `/api/timers/${timer.id}/stop`)).body;
    // The clock is a day accumulator for time that is still UNFILED. The hour
    // that left on the reassigned entry is settled there, so it must no longer
    // be on the clock — reporting 1.5h here would BE the double-count this
    // test forbids. 1.0h on Verity's entry + 0.5h still running = 1.5h worked.
    assert.equal(second.hours, 0.5,
      'the clock keeps only the day’s unfiled remainder');

    const day = (await t.fetchJson('GET', `/api/entries?date=${TODAY}`)).body;
    const billed = day.reduce((a, e) => a + Number(e.total || 0), 0);
    assert.equal(
      Math.round(billed * 100) / 100, 1.5,
      `1.5h on the clock produced ${billed}h of entries: ${JSON.stringify(
        day.map((e) => [e.cm && e.cm.short_name, e.total]))}`,
    );
  }));

// ---------------------------------------------------------------------------
// L4 — HIGH. A stop onto a SPLIT entry rewrites the total but not the lines,
// so the client-facing narrative's allocations no longer add up to the hours
// that get exported.
//
// syncToEntry() only mirrors the clock into a task line when the entry has
// exactly ONE line ("user-added splits are left alone"), but it still sets
// total_override to the whole clock and then calls syncNarrative(), which
// rebuilds "…(0.5); …(0.5)." from the stale line durations.
// ---------------------------------------------------------------------------
test('LOSS L4: a narrative’s task allocations must add up to the hours the entry exports', () =>
  withServer(async (t, clock) => {
    const acme = await mkCm(t, '100001-000012', 'Acme lease');
    const timer = (await t.fetchJson('POST', '/api/timers', {
      name: 'Acme lease', cm_id: acme.id,
    })).body;

    await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
    clock.advance(3600); // 1.0h
    const first = (await t.fetchJson('POST', `/api/timers/${timer.id}/stop`)).body;
    const entryId = first.entry.id;

    // The attorney splits the recorded hour across two task lines.
    const split = (await t.fetchJson('PATCH', `/api/entries/${entryId}`, {
      total_override: 1,
      tasks: [
        { task_code: 'Review', duration: 0.5, fragment: 'review lease amendment' },
        { task_code: 'Draft', duration: 0.5, fragment: 'draft email to landlord' },
      ],
    })).body;
    assert.equal(split.total, 1);
    assert.equal(split.narrative, 'Review lease amendment (0.5); draft email to landlord (0.5).');

    // Back on the same matter for another half hour.
    await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
    clock.advance(1800);
    const second = (await t.fetchJson('POST', `/api/timers/${timer.id}/stop`)).body;
    assert.equal(second.entry.id, entryId, 'same linked entry');
    assert.equal(second.entry.total, 1.5);

    const allocated = (second.entry.narrative.match(/\((\d+\.\d+)\)/g) || [])
      .reduce((a, s) => a + Number(s.slice(1, -1)), 0);
    assert.equal(
      Math.round(allocated * 100) / 100, second.entry.total,
      `narrative bills ${allocated}h but the entry exports ${second.entry.total}h: ${JSON.stringify(second.entry.narrative)}`,
    );
  }));

// ---------------------------------------------------------------------------
// L5 — MEDIUM. POST /api/entries/:id/copy drops narrative_ai / ai_brief /
// ai_draft. server/routes/ai.js keeps model output out of the voice pool with
// `narrative_ai = 0`; a copy launders the flag off, so the model's own prose
// comes back to it as "the attorney's voice" — the exact feedback loop the
// exemplar filter exists to stop.
// ---------------------------------------------------------------------------
test('LOSS L5: copying an entry must carry its AI provenance', () =>
  withServer(async (t) => {
    const acme = await mkCm(t, '100001-000012', 'Acme lease');
    const src = (await t.fetchJson('POST', '/api/entries', {
      date: TODAY, cm_id: acme.id,
      narrative: 'Review and analyze lease amendment and confer with client regarding same.',
      narrative_ai: 1,
      ai_brief: 'rev lease amd; conf w client',
      ai_draft: 'Review and analyze lease amendment and confer with client regarding same.',
      tasks: [{ task_code: 'Review', duration: 0.6, fragment: '' }],
    })).body;
    assert.equal(src.narrative_ai, 1);

    const copy = (await t.fetchJson('POST', `/api/entries/${src.id}/copy`, { date: TODAY })).body;
    assert.equal(copy.narrative, src.narrative);
    assert.equal(copy.narrative_ai, 1, 'the copy is still the model’s text, not the attorney’s');
    assert.equal(copy.ai_brief, src.ai_brief);
    assert.equal(copy.ai_draft, src.ai_draft);
  }));

// ---------------------------------------------------------------------------
// L6 — HIGH. Bulk set_cm takes ONE matter and applies it to MANY entries,
// carrying each entry's narrative onto the target matter, with no audit row
// for entries that were never finalized and no record of where each came
// from. There is no route back: the UI offers Undo for bulk delete only.
// ---------------------------------------------------------------------------
test('LOSS L6: a bulk matter reassignment must be recoverable', () =>
  withServer(async (t) => {
    const easement = await mkCm(t, '100001-000012', 'Fairview easement');
    const lease = await mkCm(t, '100001-000077', 'Northgate lease');
    const merger = await mkCm(t, '200002-000001', 'Verity merger');

    const a = (await t.fetchJson('POST', '/api/entries', {
      date: TODAY, cm_id: easement.id,
      narrative: 'Review recorded easement and prepare title objection letter.',
      tasks: [{ task_code: 'Review', duration: 0.5, fragment: '' }],
    })).body;
    const b = (await t.fetchJson('POST', '/api/entries', {
      date: TODAY, cm_id: lease.id,
      narrative: 'Negotiate percentage rent clause with landlord counsel.',
      tasks: [{ task_code: 'Negotiate', duration: 0.7, fragment: '' }],
    })).body;

    const r = (await t.fetchJson('POST', '/api/entries/bulk', {
      ids: [a.id, b.id], action: 'set_cm', cm_id: merger.id,
    })).body;
    assert.deepEqual(r.done.sort(), [a.id, b.id].sort());

    // Two different matters' narratives now sit on one matter…
    const moved = (await t.fetchJson('GET', `/api/entries?cm_id=${merger.id}`)).body;
    assert.equal(moved.length, 2);

    // …and nothing anywhere records where they came from.
    for (const e of [a, b]) {
      const audit = (await t.fetchJson('GET', `/api/entries/${e.id}/audit`)).body;
      assert.ok(
        audit.some((x) => x.action === 'edit' && x.detail && x.detail.cm_id),
        `no audit trail for the reassignment of entry ${e.id} — its previous matter is unrecoverable`,
      );
    }
  }));

// ---------------------------------------------------------------------------
// L8 — MEDIUM. Bulk set_cm is the only matter-changing write that does NOT
// call syncNarrative(). PATCH /api/entries/:id rebuilds the narrative in the
// NEW client's billing format; bulk leaves a task-billed narrative — with its
// "(0.5)" allocations — sitting on a block-billed client's bill until some
// unrelated later save silently reformats it.
// ---------------------------------------------------------------------------
test('LOSS L8: a bulk matter reassignment must leave the narrative in the new client’s billing format', () =>
  withServer(async (t) => {
    const taskBilled = await mkCm(t, '100001-000012', 'Acme lease');
    const blockBilled = await mkCm(t, '300003-000001', 'Northgate co', { client_task_billing: 0 });

    const e = (await t.fetchJson('POST', '/api/entries', {
      date: TODAY, cm_id: taskBilled.id, narrative: '',
      tasks: [
        { task_code: 'Review', duration: 0.5, fragment: 'review lease' },
        { task_code: 'Draft', duration: 0.5, fragment: 'draft email to landlord' },
      ],
    })).body;
    assert.equal(e.narrative, 'Review lease (0.5); draft email to landlord (0.5).');

    await t.fetchJson('POST', '/api/entries/bulk', {
      ids: [e.id], action: 'set_cm', cm_id: blockBilled.id,
    });
    const moved = (await t.fetchJson('GET', `/api/entries/${e.id}`)).body;
    assert.equal(moved.cm.client_task_billing, 0);
    assert.equal(
      moved.narrative, 'Review lease; draft email to landlord.',
      'a block-billed client received a task-billed narrative with per-line allocations',
    );
  }));

// ---------------------------------------------------------------------------
// L7 — MEDIUM. PATCH /api/timers/:id moves the linked entry to the timer's new
// matter ("same entry, same time, same narrative, new matter") without writing
// an audit row, even for an entry that has already been finalized once.
// PATCH /api/entries/:id records exactly this change for the same entry.
// ---------------------------------------------------------------------------
test('LOSS L7: re-pointing a timer must audit the matter move it performs on a finalized-once entry', () =>
  withServer(async (t, clock) => {
    const acme = await mkCm(t, '100001-000012', 'Acme lease');
    const verity = await mkCm(t, '200002-000001', 'Verity merger');

    const timer = (await t.fetchJson('POST', '/api/timers', {
      name: 'Acme lease', cm_id: acme.id,
    })).body;
    await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
    clock.advance(3600);
    const stop = (await t.fetchJson('POST', `/api/timers/${timer.id}/stop`)).body;
    const entryId = stop.entry.id;

    await t.fetchJson('PATCH', `/api/entries/${entryId}`, {
      narrative: 'Review and analyze Acme lease amendment.',
    });
    await t.fetchJson('POST', `/api/entries/${entryId}/finalize`, { ack: true });
    await t.fetchJson('POST', `/api/entries/${entryId}/unlock`);
    // finalize unlinked the timer; relink it the way the entry card does.
    await t.fetchJson('POST', '/api/timers/start-for-entry', { entry_id: entryId });
    await t.fetchJson('POST', `/api/timers/${timer.id}/stop`);

    await t.fetchJson('PATCH', `/api/timers/${timer.id}`, { cm_id: verity.id, move_entry: true });

    const after = (await t.fetchJson('GET', `/api/entries/${entryId}`)).body;
    assert.equal(after.cm.id, verity.id, 'the entry followed the timer (documented behaviour)');

    const audit = (await t.fetchJson('GET', `/api/entries/${entryId}/audit`)).body;
    assert.ok(
      audit.some((x) => x.action === 'edit' && x.detail && x.detail.cm_id),
      'an ever-finalized entry changed matter with no audit row',
    );
  }));
