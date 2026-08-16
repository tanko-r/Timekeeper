// =============================================================================
// DATA-INTEGRITY AUDIT — close-the-day flow and the timer→entry lifecycle.
//
// ⚠️  MOST OF THE TESTS IN THIS FILE ARE **EXPECTED TO FAIL**. ⚠️
//
// They are written to PROVE defects that exist on `ui-overhaul-2026-08`, per
// docs/ui/BRIEF.md §"Data integrity: non-negotiable". Every failing test is
// named `LEAK:` or `LOSS:` and carries a comment saying exactly what the
// failure demonstrates. DO NOT "fix" a failing test by weakening its
// assertion — the assertion is the contract; the code is what is wrong.
//
// The findings these prove are written up in docs/ui/integrity-closeout.md.
//
// Tests named `OK:` currently pass and are here as guard rails: they pin
// behaviour that is correct today and must stay correct after the fixes.
// =============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';
import { allocateTenths } from '../server/lib/allocate.js';

// A controllable clock. The whole file works inside one local day so nothing
// depends on the machine's real time.
const DAY = '2026-08-14';
const at = (hhmm) => new Date(`${DAY}T${hhmm}:00-07:00`);

async function withClock(start, fn) {
  const state = { now: at(start) };
  const t = await startTestServer({ clock: () => state.now });
  const set = (hhmm) => { state.now = at(hhmm); };
  try {
    await fn(t, set);
  } finally {
    await t.close();
  }
}

const mkMatter = (t, cm_number, short_name, extra = {}) =>
  t.fetchJson('POST', '/api/cms', { cm_number, short_name, billable: 1, ...extra })
    .then((r) => r.body);

// A distinctive, unmistakably matter-specific billing sentence. It names a
// party and a document — exactly the kind of fact the brief says may never
// cross a matter boundary.
const BOREALIS = 'Telephone conference with J. Ruiz regarding the Borealis '
  + 'share purchase agreement and the closing conditions schedule.';

// Give matter `cmId` a history of free-text narratives (one substantive task
// line each, so each entry counts as a "free narrative" occurrence in
// matters.js OWN_PHRASES / SIBLING_PHRASES).
async function seedHistory(t, cmId, narrative, dates) {
  for (const date of dates) {
    // eslint-disable-next-line no-await-in-loop
    await t.fetchJson('POST', '/api/entries', {
      date, cm_id: cmId, narrative, tasks: [{ task_code: 'Conf', duration: 0.5, fragment: '' }],
    });
  }
}

// ---------------------------------------------------------------------------
// 1. THE CLOSE-OUT PRE-FILL: where does the suggested sentence come from?
// ---------------------------------------------------------------------------

test('LEAK: a sibling matter’s narrative is served as this matter’s top suggestion', () =>
  withClock('17:00', async (t) => {
    // Two matters of the SAME client (client 100001).
    const merger = await mkMatter(t, '100001-000012', 'Acme — Borealis merger');
    const lease = await mkMatter(t, '100001-000044', 'Acme — office lease');

    await seedHistory(t, merger.id, BOREALIS, ['2026-08-10', '2026-08-11', '2026-08-12']);

    // The lease matter is brand new: no history of its own. This is exactly the
    // case BRIEF.md addresses — "If the matter has no prior narratives, offer
    // generic phrasing or offer nothing — never another matter's sentence."
    const r = await t.fetchJson('GET', `/api/matters/${lease.id}/suggestions`);
    assert.equal(r.status, 200);

    const texts = r.body.phrases.map((p) => p.text);
    // ⚠️ FAILS. server/routes/matters.js SIBLING_PHRASES unions
    // `SELECT e.narrative … WHERE m.client_id = ? AND m.id != ?` — the whole
    // free-text narrative of every OTHER matter of the same client — into the
    // phrase ranking whenever this matter's own history is "thin" (< 5 ranked
    // phrases). A brand-new matter is always thin, so phrases[0] IS the
    // sibling's billing sentence.
    assert.deepEqual(
      texts.filter((x) => x.includes('Borealis')), [],
      'the Borealis-merger narrative must never be offered on the office-lease matter');
  }));

test('LEAK: the close-out pre-fill writes a sibling matter’s narrative onto this '
  + 'matter’s entry and exports it', () =>
  withClock('17:00', async (t) => {
    const merger = await mkMatter(t, '100001-000012', 'Acme — Borealis merger');
    const lease = await mkMatter(t, '100001-000044', 'Acme — office lease');
    await seedHistory(t, merger.id, BOREALIS, ['2026-08-10', '2026-08-11', '2026-08-12']);

    // Today: a stopped timer left a blank draft on the LEASE matter.
    const draft = (await t.fetchJson('POST', '/api/entries', {
      date: DAY, cm_id: lease.id, narrative: '',
      tasks: [{ task_code: 'Review', duration: 0.8, fragment: '' }],
    })).body;

    // ---- replicate public/js/components/closeout.js exactly ----
    // useEffect → GET /api/matters/:id/suggestions for every matter that still
    // needs words;  valueOf(g) → (sugg[g.cm.id] || [])[0] || '';
    // finalizeAndExport(false) → save(d, text) → PATCH, then finalize-day,
    // then POST /api/export.
    const sugg = (await t.fetchJson('GET', `/api/matters/${lease.id}/suggestions`)).body;
    const prefill = (sugg.phrases[0] || {}).text || '';
    if (prefill) await t.fetchJson('PATCH', `/api/entries/${draft.id}`, { narrative: prefill });
    await t.fetchJson('POST', '/api/finalize-day', { date: DAY, ack: true });
    const exp = await t.fetchJson('POST', '/api/export', { from: DAY, to: DAY });

    // ⚠️ FAILS. The CSV row keyed to the office-lease matter carries the
    // Borealis-merger sentence. This is the sentence that lands on a bill.
    const leaseRows = exp.body.csv.split('\n').filter((l) => l.includes('100001-000044'));
    assert.equal(leaseRows.length, 1, 'the lease entry should export exactly once');
    assert.ok(!leaseRows[0].includes('Borealis'),
      `another matter's narrative reached the office-lease bill line:\n${leaseRows[0]}`);
  }));

test('OK: a matter with no client siblings gets no borrowed narrative', () =>
  withClock('17:00', async (t) => {
    const merger = await mkMatter(t, '100001-000012', 'Acme — Borealis merger');
    const stranger = await mkMatter(t, '777777-000001', 'Northgate — zoning');
    await seedHistory(t, merger.id, BOREALIS, ['2026-08-10', '2026-08-11', '2026-08-12']);

    const r = await t.fetchJson('GET', `/api/matters/${stranger.id}/suggestions`);
    assert.deepEqual(r.body.phrases.map((p) => p.text).filter((x) => x.includes('Borealis')), [],
      'cross-CLIENT narratives are correctly walled off — only the same-client path leaks');
  }));

// ---------------------------------------------------------------------------
// 2. THE TIMER SIDE — the stop chip's pre-computed narrative
// ---------------------------------------------------------------------------

test('LEAK: starting a timer stamps a sibling matter’s narrative into '
  + 'timers.suggested_narrative (the stop chip’s first offer)', () =>
  withClock('09:00', async (t) => {
    const merger = await mkMatter(t, '100001-000012', 'Acme — Borealis merger');
    const lease = await mkMatter(t, '100001-000044', 'Acme — office lease');
    await seedHistory(t, merger.id, BOREALIS, ['2026-08-10', '2026-08-11', '2026-08-12']);

    const timer = (await t.fetchJson('POST', '/api/timers', {
      name: 'Office lease', cm_id: lease.id,
    })).body;
    await t.fetchJson('POST', `/api/timers/${timer.id}/start`);

    const stored = t.db.prepare('SELECT suggested_narrative FROM timers WHERE id=?').get(timer.id);
    // ⚠️ FAILS. server/routes/timers.js doStart() takes the top clean phrase
    // from matterSuggestions() — which is the sibling matter's narrative for a
    // thin matter — and persists it as this timer's suggested_narrative. That
    // string is chip #1 on the stop sheet (stopchips.js line 283).
    assert.ok(!String(stored.suggested_narrative || '').includes('Borealis'),
      `stop chip pre-loaded with another matter's sentence: ${stored.suggested_narrative}`);
  }));

test('LEAK: a timer’s stashed draft narrative follows a matter change onto the '
  + 'new matter’s entry', () =>
  withClock('09:00', async (t, set) => {
    const merger = await mkMatter(t, '100001-000012', 'Acme — Borealis merger');
    const lease = await mkMatter(t, '100001-000044', 'Acme — office lease');

    const timer = (await t.fetchJson('POST', '/api/timers', {
      name: 'Borealis merger', cm_id: merger.id,
    })).body;

    // The lawyer types what he is doing into the timer row before any entry
    // exists. pip.js narrativeMode() === 'stash' → PATCH draft_narrative.
    await t.fetchJson('PATCH', `/api/timers/${timer.id}`, {
      draft_narrative: 'Reviewed the Borealis share purchase agreement redline from opposing counsel.',
    });

    // He then re-points the same timer at a different matter for the next
    // block of work.
    await t.fetchJson('PATCH', `/api/timers/${timer.id}`, { cm_id: lease.id });

    set('10:00');
    const started = await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
    const entry = started.body.entry;
    assert.equal(entry.cm.id, lease.id);

    // ⚠️ FAILS. routes/timers.js PATCH deliberately keeps draft_narrative
    // across a matter change ("user text — deliberately SURVIVES cmChanged"),
    // and syncToEntry() seeds every entry the timer creates with
    // `narrative_template + draft_narrative`. The merger sentence is now the
    // office-lease entry's narrative.
    assert.ok(!String(entry.narrative || '').includes('Borealis'),
      `matter A's stashed narrative was written onto matter B's entry: ${entry.narrative}`);
  }));

test('OK: the suggested_narrative IS cleared when the timer changes matter', () =>
  withClock('09:00', async (t) => {
    const merger = await mkMatter(t, '100001-000012', 'Acme — Borealis merger');
    const lease = await mkMatter(t, '100001-000044', 'Acme — office lease');
    await seedHistory(t, merger.id, BOREALIS, ['2026-08-10', '2026-08-11', '2026-08-12']);
    const timer = (await t.fetchJson('POST', '/api/timers', {
      name: 'Borealis merger', cm_id: merger.id,
    })).body;
    await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
    await t.fetchJson('POST', `/api/timers/${timer.id}/stop`);
    await t.fetchJson('PATCH', `/api/timers/${timer.id}`, { cm_id: lease.id });
    const stored = t.db.prepare('SELECT suggested_narrative FROM timers WHERE id=?').get(timer.id);
    assert.equal(stored.suggested_narrative, null,
      'the suggestion belonged to the old matter and is correctly dropped');
  }));

// ---------------------------------------------------------------------------
// 3. TIME LOSS — closing the day on top of a running timer
// ---------------------------------------------------------------------------

test('LOSS: closing the day finalizes a running timer’s entry at its stale total '
  + 'and then zeroes the live clock', () =>
  withClock('09:00', async (t, set) => {
    const cm = await mkMatter(t, '100001-000012', 'Acme lease');
    const timer = (await t.fetchJson('POST', '/api/timers', {
      name: 'Acme lease', cm_id: cm.id,
    })).body;

    // 09:00 → 11:00, stopped: two hours land on the entry.
    await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
    set('11:00');
    const stopped = await t.fetchJson('POST', `/api/timers/${timer.id}/stop`);
    const entryId = stopped.body.entry.id;
    assert.equal(stopped.body.entry.total, 2);

    await t.fetchJson('PATCH', `/api/entries/${entryId}`, {
      narrative: 'Reviewed and revised the lease renewal amendment and conferred with the client.',
    });

    // 13:00 he starts the same timer again and works the whole afternoon…
    set('13:00');
    await t.fetchJson('POST', `/api/timers/${timer.id}/start`);

    // …and at 17:00 closes the day WITHOUT stopping it. Four hours are on the
    // clock; the entry still says 2.0 because total_override is only written
    // at stop (the live tick in the UI is client-side display only).
    set('17:00');
    const fin = await t.fetchJson('POST', '/api/finalize-day', { date: DAY });

    // Note how quiet this is: no block, no warning, nothing to acknowledge.
    assert.deepEqual(fin.body.blocked, [], 'nothing warns the lawyer at all');

    const after = (await t.fetchJson('GET', `/api/entries/${entryId}`)).body;
    const timerRow = t.db.prepare(
      'SELECT running, accumulated_seconds, linked_entry_id FROM timers WHERE id=?').get(timer.id);

    // ⚠️ FAILS: after.total is 2, and the timer's clock has been zeroed by
    // finalizeOne() (entries.js), so the four hours exist nowhere. Six hours
    // were worked; 2.0 was billed; there is no undo and no audit entry.
    assert.equal(
      after.total + timerRow.accumulated_seconds / 3600, 6,
      'every hour worked must survive close-out — either filed on the entry or '
      + `still on the clock (entry ${after.total}h + clock `
      + `${timerRow.accumulated_seconds / 3600}h)`);
  }));

test('OK: stopping the timer first files every hour', () =>
  withClock('09:00', async (t, set) => {
    const cm = await mkMatter(t, '100001-000012', 'Acme lease');
    const timer = (await t.fetchJson('POST', '/api/timers', {
      name: 'Acme lease', cm_id: cm.id,
    })).body;
    await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
    set('11:00');
    const stopped = await t.fetchJson('POST', `/api/timers/${timer.id}/stop`);
    set('13:00');
    await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
    set('17:00');
    const stopped2 = await t.fetchJson('POST', `/api/timers/${timer.id}/stop`);
    assert.equal(stopped2.body.entry.id, stopped.body.entry.id, 'same entry, one block of time');
    assert.equal(stopped2.body.entry.total, 6, 'the day accumulator files all six hours');
  }));

// ---------------------------------------------------------------------------
// 4. TIME DOUBLE-COUNT — a moved entry orphans the clock without emptying it
// ---------------------------------------------------------------------------

test('LOSS: moving an entry to another date leaves the hours on the clock, so the '
  + 'next stop files them a second time', () =>
  withClock('09:00', async (t, set) => {
    const cm = await mkMatter(t, '100001-000012', 'Acme lease');
    const timer = (await t.fetchJson('POST', '/api/timers', {
      name: 'Acme lease', cm_id: cm.id,
    })).body;

    await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
    set('11:00');
    const first = (await t.fetchJson('POST', `/api/timers/${timer.id}/stop`)).body.entry;
    assert.equal(first.total, 2);

    // "That was actually yesterday's work" — a legal, ordinary edit.
    await t.fetchJson('PATCH', `/api/entries/${first.id}`, { date: '2026-08-13' });

    // Another hour on the same timer, then stop.
    set('13:00');
    await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
    set('14:00');
    const second = (await t.fetchJson('POST', `/api/timers/${timer.id}/stop`)).body.entry;

    const total = (await t.fetchJson('GET', '/api/entries')).body
      .reduce((a, e) => a + e.total, 0);
    // ⚠️ FAILS: 5.0 recorded for 3.0 worked. syncToEntry() saw the linked
    // entry's date no longer matched today, so it opened a NEW entry and wrote
    // the WHOLE day clock (3.0h) into it, while the moved entry kept its 2.0h.
    // The response does carry `relinked` so the timer grid can offer "Deduct
    // 2.0h", but the over-count is already committed and one dismissed toast
    // makes it permanent.
    assert.equal(total, 3,
      `three hours were worked; ${total} are recorded (entry ${first.id} + entry ${second.id})`);
  }));

test('LEAK/LOSS: re-pointing a timer mid-day re-bills the morning’s hours — and the '
  + 'morning’s narrative — to the new matter', () =>
  withClock('09:00', async (t, set) => {
    const merger = await mkMatter(t, '100001-000012', 'Acme — Borealis merger');
    const lease = await mkMatter(t, '100001-000044', 'Acme — office lease');
    const timer = (await t.fetchJson('POST', '/api/timers', {
      name: 'Borealis merger', cm_id: merger.id,
    })).body;

    // Two hours of merger work, stopped and written up.
    await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
    set('11:00');
    const entry = (await t.fetchJson('POST', `/api/timers/${timer.id}/stop`)).body.entry;
    await t.fetchJson('PATCH', `/api/entries/${entry.id}`, { narrative: BOREALIS });

    // After lunch he re-points the SAME timer at the office-lease matter for
    // the next block of work.
    set('13:00');
    await t.fetchJson('PATCH', `/api/timers/${timer.id}`, { cm_id: lease.id });

    const moved = (await t.fetchJson('GET', `/api/entries/${entry.id}`)).body;
    // Was ⚠️ FAILS on both counts: routes/timers.js PATCH `associate` MOVED the
    // linked draft entry to the new matter — "same entry, same time, same
    // narrative, new matter" — so the morning's 2.0 merger hours were billed to
    // the office lease and the Borealis sentence went with them, unaudited and
    // undoable. Closed 2026-08-16: an entry holding real hours or a real
    // narrative now stays where the work was done unless the attorney asks for
    // the move (the owner's "ask me each time" rule; silence means leave it).
    assert.equal(moved.cm.id, merger.id,
      'hours already recorded against the merger must not follow the timer to another matter');

    // SCAFFOLD REPAIR, same date. This assertion read `moved` — the MERGER's
    // own entry — and demanded it not contain "Borealis". That was only ever
    // true while the leak existed and the entry had been dragged onto the
    // lease; once the entry correctly stays put it must KEEP its own Borealis
    // sentence, so the old form asserted the leak rather than the rule. The
    // rule it means is what it says: the merger's narrative must not become the
    // OFFICE-LEASE entry's narrative. So it now reads every entry on the lease.
    assert.ok(String(moved.narrative).includes('Borealis'),
      'the merger entry must KEEP its own sentence — it is the merger’s work');
    const leaseEntries = (await t.fetchJson('GET', '/api/entries')).body
      .filter((e) => e.cm && e.cm.id === lease.id);
    assert.deepEqual(leaseEntries.filter((e) => String(e.narrative).includes('Borealis')), [],
      'the merger narrative must not become the office-lease entry’s narrative');
  }));

test('OK: a timer running through midnight banks yesterday and restarts today', async () => {
  // Needs a clock that crosses the day boundary, so it builds its own server.
  const state = { now: new Date('2026-08-14T23:00:00-07:00') };
  const t = await startTestServer({ clock: () => state.now });
  try {
    const cm = await mkMatter(t, '100001-000012', 'Acme lease');
    const timer = (await t.fetchJson('POST', '/api/timers', {
      name: 'Acme lease', cm_id: cm.id,
    })).body;
    await t.fetchJson('POST', `/api/timers/${timer.id}/start`);

    // 23:00 → 01:00 the next day, without ever stopping.
    state.now = new Date('2026-08-15T01:00:00-07:00');
    await t.fetchJson('GET', '/api/timers'); // any request triggers applyRollovers
    await t.fetchJson('POST', `/api/timers/${timer.id}/stop`);

    const rows = (await t.fetchJson('GET', '/api/entries')).body;
    const byDate = Object.fromEntries(rows.map((e) => [e.date, e.total]));
    assert.equal(byDate['2026-08-14'], 1, 'the hour before midnight is banked to the 14th');
    assert.equal(byDate['2026-08-15'], 1, 'the hour after midnight belongs to the 15th');
    assert.equal(rows.reduce((a, e) => a + e.total, 0), 2, 'two hours in, two hours recorded');
  } finally { await t.close(); }
});

// -- Correction, 2026-08-16 ---------------------------------------------------
// This test used to be called "…and throws its unfiled seconds away" and it
// asserted `after.accumulated_seconds >= 3600 + 180`. That assertion stated the
// defect, not the spec, and was retired for a demonstrably false premise:
//
//   * Its comment claimed a three-minute stretch is "under the 0.1h minimum
//     increment, so the stop files nothing". Not true under the shipped
//     defaults. server/db.js seeds rounding {enabled, increment 0.1, mode 'up'}
//     and validation.minIncrement 0.1; server/lib/rounding.js rounds 180 s UP
//     to 0.1 h, which is NOT below the minimum. The stop FILES 0.1 h. Probed:
//     POST /stop returns hours 0.1 and an entry whose total is 0.1.
//   * So the three minutes are already on the books. Demanding that the clock
//     ALSO carry them onto the next entry asks for them to be billed twice —
//     syncToEntry SETS an entry's total from accumulated_seconds (the clock is
//     a day accumulator per linked entry), it does not add to it. Probed:
//     carrying 3780 s instead of 3600 s and stopping 30 min later files 1.6 h
//     onto an entry that is owed 1.5 h, on top of the 0.1 h already banked.
//     No correct implementation can satisfy the old assertion.
//
// The family's intent — "no time may be lost on start-for-entry" — is kept and
// stated correctly below: the ledger after the hijack must equal the time
// actually worked, neither lost NOR double-counted. What IS wrong on this path
// is covered too: the hijack strands the entry the clock used to serve as a
// timed, narrative-less draft that nothing points at, and that orphan
// hard-blocks close-out.
// -----------------------------------------------------------------------------
test('LOSS: start-for-entry hijacks a paused timer that belongs to another entry '
  + 'and strands that entry as a timed, narrative-less draft that blocks close-out', () =>
  withClock('09:00', async (t, set) => {
    const cm = await mkMatter(t, '100001-000012', 'Acme lease');
    const timer = (await t.fetchJson('POST', '/api/timers', {
      name: 'Acme lease', cm_id: cm.id,
    })).body;

    // A three-minute stretch. Rounding is "up to the next tenth" and the
    // minimum increment is 0.1 h, so 180 s rounds UP to 0.1 h and the stop
    // files it into the entry the start opened. Those minutes are on the books
    // from here on — anything that counts them a second time is over-billing.
    await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
    set('09:03');
    const stop = (await t.fetchJson('POST', `/api/timers/${timer.id}/stop`)).body;
    assert.equal(stop.hours, 0.1, 'a three-minute stretch rounds up onto the books');
    const opened = stop.entry;
    assert.equal(opened.total, 0.1, 'the start-created entry now holds the three minutes');
    assert.equal(String(opened.narrative || '').trim(), '',
      'and it still has no narrative — the stop chip is where that sentence gets written');
    const held = t.db.prepare('SELECT accumulated_seconds, linked_entry_id FROM timers WHERE id=?')
      .get(timer.id);
    assert.equal(held.accumulated_seconds, 180,
      'the clock reads the same three minutes it just filed (day accumulator, not an increment)');
    assert.equal(held.linked_entry_id, opened.id, 'and it is still serving that entry');

    // A separate entry on the same matter — a manual one, say — gets its own
    // timer started from the entry card.
    const other = (await t.fetchJson('POST', '/api/entries', {
      date: DAY, cm_id: cm.id, tasks: [{ task_code: 'Draft', duration: 1.0, fragment: 'draft notice' }],
      narrative: 'Drafted the notice of intent to renew and circulated it internally.',
    })).body;
    assert.equal(other.total, 1);
    await t.fetchJson('POST', '/api/timers/start-for-entry', { entry_id: other.id });

    const after = t.db.prepare('SELECT accumulated_seconds, linked_entry_id FROM timers WHERE id=?')
      .get(timer.id);
    // start-for-entry finds no timer linked to `other`, so it grabs the most
    // recent PAUSED same-matter timer — this one — and re-points it. Re-seeding
    // the clock with the TARGET entry's own total is the correct move: the
    // clock is that entry's running total, and the 180 s it was carrying are
    // already 0.1 h on `opened`. Carrying them across would bill them twice.
    assert.equal(after.linked_entry_id, other.id, 'the clock now serves the target entry');
    assert.equal(after.accumulated_seconds, 3600,
      `a re-pointed clock must read the target entry's own time — no more (double billing), `
      + `no less (lost time); it reads ${after.accumulated_seconds}s`);

    // Half an hour of real work against `other`, then stop.
    set('09:33');
    await t.fetchJson('POST', `/api/timers/${timer.id}/stop`);

    // The ledger. Claimed: 1.0 h keyed by hand + 3 min on the clock before the
    // hijack + 30 min after it = 1.55 h. Filed: 0.1 h on `opened` (180 s rounded
    // up) + 1.5 h on `other` (3600 + 1800 s, exact) = 1.6 h. Round-up may only
    // ever push a filing to the next tenth; it may never drop a stretch, and it
    // may never book the same stretch onto two entries.
    const rows = (await t.fetchJson('GET', '/api/entries')).body;
    const recorded = Math.round(rows.reduce((a, e) => a + e.total, 0) * 100) / 100;
    assert.ok(recorded >= 1.55,
      `time went missing across the hijack: ${recorded} h recorded for 1.55 h worked`);
    assert.equal(recorded, 1.6,
      `1.55 h worked files as 1.6 h once round-up is applied per entry; got ${recorded} h`);
    assert.equal(rows.find((e) => e.id === other.id).total, 1.5,
      'the target entry holds its own hour plus the half hour actually timed against it');
    assert.equal(rows.find((e) => e.id === opened.id).total, 0.1,
      'and the three minutes stay where they were filed');

    // ⚠️ FAILS — and this is what is actually broken on this path. `opened` is
    // now a 0.1 h draft with an EMPTY narrative and NO timer pointing at it:
    // one ordinary click on another entry's start button took away the clock
    // whose stop chip was the only prompt to write that sentence. The user is
    // told nothing.
    const orphan = rows.find((e) => e.id === opened.id
      && e.total > 0
      && !String(e.narrative || '').trim()
      && !t.db.prepare('SELECT 1 FROM timers WHERE linked_entry_id=?').get(e.id));
    assert.equal(orphan, undefined,
      'start-for-entry left a timed, narrative-less draft behind with no timer to explain it');

    // …and that orphan is not a cosmetic loose end: it hard-blocks close-out on
    // narrative_empty, and "accept warnings & finalize" cannot clear a block.
    const fin = await t.fetchJson('POST', '/api/finalize-day', { date: DAY, ack: true });
    const stuck = (fin.body.blocked || []).find((b) => b.id === opened.id);
    assert.equal(stuck, undefined,
      `an ordinary click manufactured an entry that blocks the day: ${JSON.stringify(stuck)}`);
  }));

// ---------------------------------------------------------------------------
// 5. ZERO-HOUR ENTRIES — finalized clean, exported as a blank line
// ---------------------------------------------------------------------------

test('LOSS: a zero-hour entry on a block-billed client finalizes with no warning '
  + 'and exports as a 0.0 line', () =>
  withClock('17:00', async (t) => {
    const cm = await mkMatter(t, '222333-000001', 'Verity retainer', { client_task_billing: 0 });
    const e = (await t.fetchJson('POST', '/api/entries', {
      date: DAY, cm_id: cm.id, tasks: [],
      narrative: 'Attended the quarterly board meeting and advised on the retainer scope.',
    })).body;
    assert.equal(e.total, 0);

    const fin = await t.fetchJson('POST', '/api/finalize-day', { date: DAY });
    // ⚠️ FAILS. validation.js only raises `zero_duration` when
    // `tasks.length > 0`, and `no_task_lines` is waived for block-billed
    // clients — so an entry holding NO time passes the gate in complete
    // silence, is locked, and becomes a CSV row with duration 0.
    assert.ok(fin.body.blocked.length === 1,
      'an entry with no time on it must not finalize silently');

    const exp = await t.fetchJson('POST', '/api/export', { from: DAY, to: DAY });
    const row = exp.body.csv.split('\n').find((l) => l.includes('222333-000001'));
    assert.equal(row, undefined, `a zero-hour line reached the billing CSV: ${row}`);
  }));

test('LOSS: a zero-hour entry WITH task lines only warns, so “accept warnings & '
  + 'finalize” locks it at 0.0h', () =>
  withClock('17:00', async (t) => {
    const cm = await mkMatter(t, '100001-000012', 'Acme lease');
    const e = (await t.fetchJson('POST', '/api/entries', {
      date: DAY, cm_id: cm.id, tasks: [{ task_code: 'Review', duration: 0, fragment: 'review lease' }],
      narrative: 'Reviewed the lease renewal amendment and conferred with the client about it.',
    })).body;
    assert.equal(e.total, 0);

    // The close-out warn screen's only affirmative control is "Accept warnings
    // & finalize", which sends ack date-wide.
    const fin = await t.fetchJson('POST', '/api/finalize-day', { date: DAY, ack: true });
    // ⚠️ FAILS. `zero_duration` is a warn, and one ack covers the whole day, so
    // an entry that holds no time is locked and exported alongside good ones.
    assert.deepEqual(fin.body.finalized, [],
      'no acknowledgement should be able to finalize an entry holding zero time');
  }));

// ---------------------------------------------------------------------------
// 6. ALLOCATION — does the sum before equal the sum after?
// ---------------------------------------------------------------------------

test('OK: allocateTenths preserves a tenth-based total exactly', () => {
  for (const [total, shares] of [[2.3, [0.17, 0.29, 0.54]], [7.7, [1, 2, 3, 4]]]) {
    const out = allocateTenths(total, shares);
    assert.equal(Math.round(out.reduce((a, b) => a + b, 0) * 10) / 10, total);
  }
});

test('LOSS: allocateTenths silently changes the total when the firm bills in '
  + 'quarter hours', () => {
  // rounding.increment is a user setting (Settings → rounding). Set to 0.25,
  // every entry total is a multiple of 0.25 — and allocateTenths (used by
  // POST /api/ai/expand to split an entry's hours across the task lines the
  // model proposed) quantises to TENTHS.
  const out = allocateTenths(0.75, [0.5, 0.5]);
  const sum = Math.round(out.reduce((a, b) => a + b, 0) * 100) / 100;
  // ⚠️ FAILS: 0.8 out for 0.75 in. 0.25 → 0.3 (+0.05), 1.25 → 1.3, and
  // allocateTenths(0.24, …) rounds DOWN, losing time.
  assert.equal(sum, 0.75, `split 0.75h across two lines and got ${sum}h`);
});
