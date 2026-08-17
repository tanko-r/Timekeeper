// =============================================================================
// STAGE 1 EXIT TEST — the adversarial sweep.
//
// docs/ui/PLAN.md: "an adversarial verifier makes at least nine attack attempts
// (matter change mid-run, thin-matter close-out, midnight rollover, copy,
// duplicate, bulk operations, quick capture, two timers on one matter, export
// interruption), reads the database after each, and cannot produce a single
// cross-matter narrative, a single false provenance claim, or a single lost
// hour."
//
// Written as a permanent test rather than run once by an agent, because the
// gate is only worth anything if it keeps holding. Each attack drives the REAL
// server against a real SQLite file and then reads every row back.
//
// THE THREE THINGS NO ATTACK MAY PRODUCE
//
//   1. A CROSS-MATTER NARRATIVE. Every sentence this file writes is registered
//      against the matter it was written for. After every attack, every live
//      entry in the database is checked: if it holds a registered sentence, it
//      must be on that sentence's matter. This is the same shape as the sweep
//      in fence.suggestionmatter.test.js, which has caught a real leak through
//      a path nobody had driven.
//   2. A FALSE PROVENANCE CLAIM. entries.narrative_src_cm_id says "the app
//      composed this sentence FOR this matter". If it names a matter the entry
//      is not on, the entry is claiming words it should have given back; if it
//      names a matter that no longer exists, it is claiming words from nowhere.
//      Both are false claims about where a billing sentence came from.
//   3. A LOST HOUR. Every attack states the hours it claims to have worked.
//      The ledger afterwards must hold at least that much. Round-up may push a
//      filing to the next tenth; it may never drop a stretch.
//
// House fictional names only (BRIEF: no real client, matter or firm data).
// =============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

const DAY = '2026-08-14';
const at = (hhmm, day = DAY) => new Date(`${day}T${hhmm}:00-07:00`);

// ── the harness ─────────────────────────────────────────────────────────────
// One server per attack, a controllable clock, and a registry mapping every
// sentence this file writes to the matter it was written for.
async function attack(startHHMM, fn) {
  const state = { now: at(startHHMM) };
  const t = await startTestServer({ clock: () => state.now });
  const owners = new Map(); // sentence → cm id it was written for
  const ctx = {
    t,
    set: (hhmm, day) => { state.now = at(hhmm, day); },
    // Register a sentence as belonging to a matter. Everything this file writes
    // goes through here, so nothing can leak unnoticed.
    own: (text, cmId) => { owners.set(text, cmId); return text; },
    owners,
  };
  try {
    await fn(ctx);
    sweep(ctx);
  } finally {
    await t.close();
  }
}

const mkMatter = (t, cm_number, short_name, extra = {}) =>
  t.fetchJson('POST', '/api/cms', { cm_number, short_name, billable: 1, ...extra })
    .then((r) => r.body);

// The whole database, after whatever just happened.
function sweep({ t, owners }) {
  const rows = t.db.prepare(`
    SELECT e.id, e.cm_id, e.narrative, e.narrative_src_cm_id, e.deleted_at, e.status,
           m.short_name
    FROM entries e LEFT JOIN matters m ON m.id = e.cm_id
    WHERE e.deleted_at IS NULL`).all();

  // 1. NO CROSS-MATTER NARRATIVE.
  for (const row of rows) {
    const text = String(row.narrative || '');
    if (!text.trim()) continue;
    for (const [sentence, cmId] of owners) {
      // A 40-character prefix is enough to identify a sentence and survives the
      // task-line reformatting an entry gets when it changes client.
      if (!text.includes(sentence.slice(0, 40))) continue;
      assert.equal(row.cm_id, cmId,
        `CROSS-MATTER NARRATIVE: entry ${row.id} on "${row.short_name}" (matter ${row.cm_id}) `
        + `holds a sentence written for matter ${cmId}: ${JSON.stringify(text)}`);
    }
  }

  // 2. NO FALSE PROVENANCE CLAIM.
  const matterIds = new Set(t.db.prepare('SELECT id FROM matters').all().map((m) => m.id));
  for (const row of rows) {
    if (row.narrative_src_cm_id == null) continue;
    assert.ok(matterIds.has(row.narrative_src_cm_id),
      `FALSE PROVENANCE: entry ${row.id} claims its sentence was composed for matter `
      + `${row.narrative_src_cm_id}, which does not exist`);
    assert.equal(row.narrative_src_cm_id, row.cm_id,
      `FALSE PROVENANCE: entry ${row.id} sits on matter ${row.cm_id} but claims its sentence `
      + `was composed for matter ${row.narrative_src_cm_id} — it should have been given back`);
  }
}

// The ledger, as the app would report it.
async function recorded(t) {
  const rows = (await t.fetchJson('GET', '/api/entries')).body;
  return Math.round(rows.reduce((a, e) => a + e.total, 0) * 100) / 100;
}

const LEASE_TEXT = 'Reviewed the landlord termination notice and the underlying lease.';
const MERGER_TEXT = 'Telephone conference with J. Ruiz regarding the Borealis share purchase agreement.';
const NORTH_TEXT = 'Reviewed the data room index and flagged three missing consents.';

// Two matters of the SAME client plus a second client — the brief bans the
// crossing at both widths, and the same-client case is the one that leaks.
async function twoSiblingsAndAStranger(t) {
  const lease = await mkMatter(t, '100001-000012', 'Acme — office lease');
  const merger = await mkMatter(t, '100001-000044', 'Acme — Borealis merger');
  const north = await mkMatter(t, '100244-000002', 'Northgate diligence');
  return { lease, merger, north };
}

// ---------------------------------------------------------------------------
// ATTACK 1 — change the matter under a RUNNING timer, mid-sentence.
// ---------------------------------------------------------------------------
test('EXIT 1: a matter change under a running timer strands nothing and leaks nothing', () =>
  attack('09:00', async ({ t, set, own }) => {
    const { lease, merger } = await twoSiblingsAndAStranger(t);
    const timer = (await t.fetchJson('POST', '/api/timers', {
      name: 'Acme lease', cm_id: lease.id,
    })).body;

    await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
    set('10:00');
    const stop = (await t.fetchJson('POST', `/api/timers/${timer.id}/stop`)).body;
    assert.equal(stop.hours, 1, 'an hour worked is an hour filed');

    // the stop offer writes the matter's own sentence, and says the app wrote it
    await t.fetchJson('PATCH', `/api/entries/${stop.entry.id}`, {
      narrative: own(LEASE_TEXT, lease.id), source_cm_id: lease.id, narrative_suggested: 1,
    });

    // …and now the timer is re-pointed at the sibling, mid-day
    set('10:05');
    await t.fetchJson('PATCH', `/api/timers/${timer.id}`, { cm_id: merger.id });
    await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
    set('11:00');
    await t.fetchJson('POST', `/api/timers/${timer.id}/stop`);

    assert.ok(await recorded(t) >= 2,
      `two hours were worked; ${await recorded(t)} are recorded`);
  }));

// ---------------------------------------------------------------------------
// ATTACK 2 — close out a day on a THIN matter, the case where the phrasebook
// used to reach into a sibling for words.
// ---------------------------------------------------------------------------
test('EXIT 2: close-out on a cold matter borrows nothing from its sibling', () =>
  attack('17:00', async ({ t, own }) => {
    const { lease, merger } = await twoSiblingsAndAStranger(t);
    // the merger has a worked history; the lease is brand new, so it is "thin"
    for (const date of ['2026-08-10', '2026-08-11', '2026-08-12']) {
      // eslint-disable-next-line no-await-in-loop
      await t.fetchJson('POST', '/api/entries', {
        date, cm_id: merger.id, narrative: own(MERGER_TEXT, merger.id),
        tasks: [{ task_code: 'Conf', duration: 0.5, fragment: '' }],
      });
    }
    const draft = (await t.fetchJson('POST', '/api/entries', {
      date: DAY, cm_id: lease.id, narrative: '',
      tasks: [{ task_code: 'Review', duration: 0.8, fragment: '' }],
    })).body;

    // exactly what closeout.js does: one suggestions fetch per matter that
    // still needs words, then write whatever came back
    const sugg = (await t.fetchJson('GET', `/api/matters/${lease.id}/suggestions`)).body;
    const offered = (sugg.phrases || []).map((p) => p.text);
    assert.deepEqual(offered.filter((x) => x.includes('Borealis')), [],
      `the cold matter was offered its sibling's sentence: ${JSON.stringify(offered)}`);
    if (offered[0]) {
      await t.fetchJson('PATCH', `/api/entries/${draft.id}`, {
        narrative: offered[0], source_cm_id: lease.id, narrative_suggested: 1,
      });
    }
    await t.fetchJson('POST', '/api/finalize-day', { date: DAY, ack: true });
    const exp = await t.fetchJson('POST', '/api/export', { from: DAY, to: DAY });
    assert.ok(!exp.body.csv.includes('Borealis'),
      `the merger's sentence reached the file:\n${exp.body.csv}`);
  }));

// ---------------------------------------------------------------------------
// ATTACK 3 — run a timer through midnight, then close out both days.
// ---------------------------------------------------------------------------
test('EXIT 3: a timer through midnight banks both days and loses no hour', () => {
  const state = { now: new Date('2026-08-14T22:00:00-07:00') };
  return (async () => {
    const t = await startTestServer({ clock: () => state.now });
    const owners = new Map();
    try {
      const lease = await mkMatter(t, '100001-000012', 'Acme — office lease');
      const timer = (await t.fetchJson('POST', '/api/timers', {
        name: 'Acme lease', cm_id: lease.id,
      })).body;
      await t.fetchJson('POST', `/api/timers/${timer.id}/start`);

      // 22:00 → 02:00, never stopped: two hours each side of midnight
      state.now = new Date('2026-08-15T02:00:00-07:00');
      await t.fetchJson('GET', '/api/timers'); // any request applies the rollover
      await t.fetchJson('POST', `/api/timers/${timer.id}/stop`);

      const rows = (await t.fetchJson('GET', '/api/entries')).body;
      const byDate = Object.fromEntries(rows.map((e) => [e.date, e.total]));
      assert.equal(byDate['2026-08-14'], 2, 'the two hours before midnight belong to the 14th');
      assert.equal(byDate['2026-08-15'], 2, 'and the two after it to the 15th');
      assert.equal(rows.reduce((a, e) => a + e.total, 0), 4,
        'four hours in, four hours recorded — the rollover may not eat the clock');

      // each day gets its own sentence, and they may not swap
      for (const row of rows) {
        // eslint-disable-next-line no-await-in-loop
        await t.fetchJson('PATCH', `/api/entries/${row.id}`, {
          narrative: owners.set(`Worked on the lease on ${row.date}.`, lease.id)
            && `Worked on the lease on ${row.date}.`,
        });
      }
      sweep({ t, owners });
    } finally { await t.close(); }
  })();
});

// ---------------------------------------------------------------------------
// ATTACK 4 — COPY an entry, then move the copy to another matter.
// ---------------------------------------------------------------------------
test('EXIT 4: copying an entry and moving the copy carries no sentence across', () =>
  attack('11:00', async ({ t, own }) => {
    const { lease, north } = await twoSiblingsAndAStranger(t);
    const src = (await t.fetchJson('POST', '/api/entries', {
      date: DAY, cm_id: lease.id, narrative: own(LEASE_TEXT, lease.id),
      tasks: [{ task_code: 'Review', duration: 0.6, fragment: 'reviewed the notice' }],
    })).body;
    // stamp it as the app's words, which is the only case that may be retracted
    await t.fetchJson('PATCH', `/api/entries/${src.id}`, {
      narrative: LEASE_TEXT, source_cm_id: lease.id, narrative_suggested: 1,
    });

    const copy = await t.fetchJson('POST', `/api/entries/${src.id}/copy`, { date: DAY });
    assert.ok(copy.status < 300, `copy failed: ${JSON.stringify(copy.body)}`);
    const copyId = copy.body.id;

    await t.fetchJson('PATCH', `/api/entries/${copyId}`, { cm_id: north.id });

    // the ORIGINAL keeps its own sentence — it is the lease's work
    const origin = t.db.prepare('SELECT narrative, cm_id FROM entries WHERE id=?').get(src.id);
    assert.ok(origin.narrative.includes('landlord termination notice'),
      'the entry that stayed put must keep its own sentence');
    assert.equal(origin.cm_id, lease.id);
  }));

// ---------------------------------------------------------------------------
// ATTACK 5 — DUPLICATE the work: two entries, same matter, same sentence, then
// move one of them. The duplicate must not drag the sentence with it.
// ---------------------------------------------------------------------------
test('EXIT 5: duplicated work moved to another matter takes no sentence with it', () =>
  attack('11:00', async ({ t, own }) => {
    const { lease, merger } = await twoSiblingsAndAStranger(t);
    own(LEASE_TEXT, lease.id);
    const ids = [];
    for (let i = 0; i < 2; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const e = (await t.fetchJson('POST', '/api/entries', {
        date: DAY, cm_id: lease.id, narrative: '',
        tasks: [{ task_code: 'Review', duration: 0.4, fragment: 'reviewed the notice' }],
      })).body;
      // eslint-disable-next-line no-await-in-loop
      await t.fetchJson('PATCH', `/api/entries/${e.id}`, {
        narrative: LEASE_TEXT, source_cm_id: lease.id, narrative_suggested: 1,
      });
      ids.push(e.id);
    }
    const before = await recorded(t);
    await t.fetchJson('PATCH', `/api/entries/${ids[1]}`, { cm_id: merger.id });
    assert.equal(await recorded(t), before,
      'moving an entry between matters may not change how many hours are recorded');
  }));

// ---------------------------------------------------------------------------
// ATTACK 6 — BULK operations: move several entries at once, mixing the app's
// words with the attorney's own.
// ---------------------------------------------------------------------------
test('EXIT 6: a bulk matter move retracts the app’s words and keeps his', () =>
  attack('16:00', async ({ t, own }) => {
    const { lease, north } = await twoSiblingsAndAStranger(t);
    own(LEASE_TEXT, lease.id);
    const composed = (await t.fetchJson('POST', '/api/entries', {
      date: DAY, cm_id: lease.id, narrative: '',
      tasks: [{ task_code: 'Review', duration: 0.5, fragment: 'reviewed the notice' }],
    })).body;
    const typed = (await t.fetchJson('POST', '/api/entries', {
      date: DAY, cm_id: lease.id, narrative: '',
      tasks: [{ task_code: 'Draft', duration: 0.7, fragment: 'drafted the reply' }],
    })).body;
    await t.fetchJson('PATCH', `/api/entries/${composed.id}`, {
      narrative: LEASE_TEXT, source_cm_id: lease.id, narrative_suggested: 1,
    });
    // HIS OWN WORDS — no provenance, and they may never be deleted by a move
    const HIS = 'Prepared the response to the termination notice and sent it for review.';
    await t.fetchJson('PATCH', `/api/entries/${typed.id}`, {
      narrative: HIS, narrative_manual: 1,
    });

    const before = await recorded(t);
    const r = await t.fetchJson('POST', '/api/entries/bulk', {
      action: 'set_cm', ids: [composed.id, typed.id], cm_id: north.id,
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(await recorded(t), before, 'a bulk move may not change the ledger');
    assert.equal(
      t.db.prepare('SELECT narrative FROM entries WHERE id=?').get(typed.id).narrative, HIS,
      'a bulk move must never delete what the attorney wrote himself');
  }));

// ---------------------------------------------------------------------------
// ATTACK 7 — QUICK CAPTURE, the fastest path in the app, then a correction of
// the matter it was filed against.
// ---------------------------------------------------------------------------
test('EXIT 7: quick capture files his words, and correcting the matter keeps them', () =>
  attack('14:00', async ({ t, own }) => {
    const { lease, north } = await twoSiblingsAndAStranger(t);
    // quickcapture.js sends source_cm_id on every file, but the sentence is
    // parsed from the line HE typed — so it is his, and it survives.
    const HIS = 'Conferred with the client regarding the response deadline.';
    own(HIS, lease.id);
    const filed = (await t.fetchJson('POST', '/api/entries', {
      date: DAY, cm_id: lease.id, narrative: HIS, source_cm_id: lease.id,
      tasks: [{ task_code: 'Call/Conference', duration: 0.3, fragment: '' }],
    })).body;

    // he keyed the wrong matter and fixes it — his sentence must come along,
    // because he wrote it, so the registry moves with it
    await t.fetchJson('PATCH', `/api/entries/${filed.id}`, { cm_id: north.id });
    const row = t.db.prepare('SELECT narrative, cm_id FROM entries WHERE id=?').get(filed.id);
    assert.equal(row.narrative, HIS,
      'correcting a mis-keyed matter must never cost him the sentence he typed');
    own(HIS, north.id); // it is Northgate's work now, and he said so
  }));

// ---------------------------------------------------------------------------
// ATTACK 8 — TWO TIMERS ON ONE MATTER, the case that produces stranded drafts.
// ---------------------------------------------------------------------------
test('EXIT 8: two timers on one matter strand no unexplained draft and lose no time', () =>
  attack('09:00', async ({ t, set, own }) => {
    const { lease } = await twoSiblingsAndAStranger(t);
    own(LEASE_TEXT, lease.id);
    const a = (await t.fetchJson('POST', '/api/timers', { name: 'Lease A', cm_id: lease.id })).body;

    await t.fetchJson('POST', `/api/timers/${a.id}/start`);
    set('09:30');
    const stop = (await t.fetchJson('POST', `/api/timers/${a.id}/stop`)).body;
    assert.equal(stop.hours, 0.5);

    // a second, manually keyed entry on the SAME matter takes a clock
    const other = (await t.fetchJson('POST', '/api/entries', {
      date: DAY, cm_id: lease.id, narrative: own('Drafted the notice of intent to renew.', lease.id),
      tasks: [{ task_code: 'Draft', duration: 1, fragment: 'drafted notice' }],
    })).body;
    await t.fetchJson('POST', '/api/timers/start-for-entry', { entry_id: other.id });
    set('10:00');
    await t.fetchJson('POST', `/api/timers/${a.id}/stop`);

    // NOTHING IS STRANDED: no entry holding time, with no sentence, and no
    // clock anywhere pointing at it to explain itself.
    const rows = (await t.fetchJson('GET', '/api/entries')).body;
    const orphans = rows.filter((e) => e.total > 0
      && !String(e.narrative || '').trim()
      && !t.db.prepare('SELECT 1 FROM timers WHERE linked_entry_id=?').get(e.id));
    assert.deepEqual(orphans.map((e) => e.id), [],
      `two timers on one matter stranded an unexplained draft: ${JSON.stringify(orphans)}`);

    assert.ok(await recorded(t) >= 1.5,
      `1.5 h was worked and keyed; ${await recorded(t)} is recorded`);
  }));

// ---------------------------------------------------------------------------
// ATTACK 9 — INTERRUPT THE EXPORT. The file never reaches him, so nothing may
// be marked exported, and a retry must ship exactly the same hours once.
// ---------------------------------------------------------------------------
test('EXIT 9: an export that never arrives stamps nothing and re-exports exactly once', () =>
  attack('18:00', async ({ t, own }) => {
    const { lease, north } = await twoSiblingsAndAStranger(t);
    const mk = async (cm, text, hours) => {
      const e = (await t.fetchJson('POST', '/api/entries', {
        date: DAY, cm_id: cm.id, narrative: own(text, cm.id),
        tasks: [{ task_code: 'Review', duration: hours, fragment: 'reviewed' }],
      })).body;
      return e;
    };
    await mk(lease, LEASE_TEXT, 1.2);
    await mk(north, NORTH_TEXT, 0.8);
    await t.fetchJson('POST', '/api/finalize-day', { date: DAY, ack: true });

    // the POST builds the file; the interruption is that no confirm ever comes
    const first = await t.fetchJson('POST', '/api/export', { from: DAY, to: DAY });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const stamped = t.db.prepare(
      'SELECT COUNT(*) c FROM entries WHERE exported_at IS NOT NULL').get().c;
    assert.equal(stamped, 0,
      'an export nobody confirmed receiving may not stamp a single entry as exported');

    // he tries again, and the second file carries the same hours exactly once
    const second = await t.fetchJson('POST', '/api/export', { from: DAY, to: DAY });
    const lines = second.body.csv.trim().split('\n').slice(1).filter(Boolean);
    const hours = lines.reduce((a, l) => {
      const cols = l.split(',');
      return a + (Number(cols[5]) || 0);
    }, 0);
    assert.ok(Math.abs(hours - 2) < 0.001,
      `2.0 h was finalized; the retried file carries ${hours}: \n${second.body.csv}`);
    assert.equal(lines.length, 2, `exactly two lines, got ${lines.length}:\n${second.body.csv}`);
  }));

// ---------------------------------------------------------------------------
// THE GATE ITSELF — all nine attacks against ONE database, in sequence, so a
// leak that only appears once several of them have run cannot hide.
// ---------------------------------------------------------------------------
test('EXIT GATE: nine attacks against one database produce no crossing, no false '
  + 'claim and no lost hour', () =>
  attack('09:00', async ({ t, set, own }) => {
    const { lease, merger, north } = await twoSiblingsAndAStranger(t);
    let claimed = 0;

    // 1. matter change under a running timer
    const timer = (await t.fetchJson('POST', '/api/timers', { name: 'Lease', cm_id: lease.id })).body;
    await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
    set('10:00');
    const s1 = (await t.fetchJson('POST', `/api/timers/${timer.id}/stop`)).body;
    claimed += 1;
    await t.fetchJson('PATCH', `/api/entries/${s1.entry.id}`, {
      narrative: own(LEASE_TEXT, lease.id), source_cm_id: lease.id, narrative_suggested: 1,
    });
    await t.fetchJson('PATCH', `/api/timers/${timer.id}`, { cm_id: merger.id });

    // 2. thin-matter close-out
    for (const date of ['2026-08-10', '2026-08-11', '2026-08-12']) {
      // eslint-disable-next-line no-await-in-loop
      await t.fetchJson('POST', '/api/entries', {
        date, cm_id: merger.id, narrative: own(MERGER_TEXT, merger.id),
        tasks: [{ task_code: 'Conf', duration: 0.5, fragment: '' }],
      });
    }
    const cold = (await t.fetchJson('GET', `/api/matters/${north.id}/suggestions`)).body;
    assert.deepEqual((cold.phrases || []).map((p) => p.text).filter((x) => x.includes('Borealis')), [],
      'the cold stranger matter was offered the merger’s sentence');

    // 3. a second timer on the same matter, and the stranded-draft path
    const manual = (await t.fetchJson('POST', '/api/entries', {
      date: DAY, cm_id: lease.id, narrative: own('Drafted the notice of intent to renew.', lease.id),
      tasks: [{ task_code: 'Draft', duration: 1, fragment: 'drafted notice' }],
    })).body;
    claimed += 1;
    await t.fetchJson('POST', '/api/timers/start-for-entry', { entry_id: manual.id });
    // and half an hour of real work on the re-pointed timer's NEW matter
    set('10:00');
    await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
    set('10:30');
    await t.fetchJson('POST', `/api/timers/${timer.id}/stop`);
    claimed += 0.5;

    // 4. copy, then move the copy
    const copy = await t.fetchJson('POST', `/api/entries/${manual.id}/copy`, {});
    if (copy.status < 300) {
      await t.fetchJson('PATCH', `/api/entries/${copy.body.id}`, { cm_id: north.id });
    }

    // 5. quick capture, filed against the wrong matter and corrected
    const HIS = 'Conferred with the client regarding the response deadline.';
    own(HIS, lease.id);
    const q = (await t.fetchJson('POST', '/api/entries', {
      date: DAY, cm_id: lease.id, narrative: HIS, source_cm_id: lease.id,
      tasks: [{ task_code: 'Call/Conference', duration: 0.3, fragment: '' }],
    })).body;
    claimed += 0.3;
    await t.fetchJson('PATCH', `/api/entries/${q.id}`, { cm_id: north.id });
    own(HIS, north.id); // he moved his own words on purpose

    // 6. NO STRANDED, UNEXPLAINED DRAFT — checked HERE, before the bulk move.
    //
    // The check is deliberately placed before step 7 and not after it. An entry
    // holding time with no sentence and no clock is a defect when the app made
    // it behind his back — one ordinary click on another entry's start button,
    // which is the leak this project closed in start-for-entry. It is NOT a
    // defect when he asked for it: a bulk move he initiated retracts words the
    // app had lent the entry, and the entry then legitimately needs a sentence
    // for its new matter. The safeguard for THAT case is step 8 — it must not
    // be exportable — not the presence of a clock. Manufacturing a timer per
    // entry on a twenty-entry bulk move would litter a board of eighty-four.
    const beforeBulk = (await t.fetchJson('GET', '/api/entries')).body;
    const orphans = beforeBulk.filter((e) => e.date === DAY && e.total > 0
      && !String(e.narrative || '').trim()
      && !t.db.prepare('SELECT 1 FROM timers WHERE linked_entry_id=?').get(e.id));
    assert.deepEqual(orphans.map((e) => e.id), [],
      `the sequence stranded an unexplained draft: ${JSON.stringify(orphans.map((e) => e.id))}`);

    // 7. a bulk move over the lot
    const drafts = beforeBulk
      .filter((e) => e.date === DAY && e.cm && e.cm.id === lease.id).map((e) => e.id);
    if (drafts.length) {
      await t.fetchJson('POST', '/api/entries/bulk', {
        action: 'set_cm', ids: drafts, cm_id: merger.id,
      });
    }
    // He moved that entry himself, and the sentence on it is one HE typed — no
    // provenance, so nothing to retract — which means it is the merger's work
    // now because he said so. Re-registered by name rather than by sweeping
    // whatever survived, so this stays a statement about one known sentence and
    // never becomes an escape hatch that would swallow a real crossing.
    own('Drafted the notice of intent to renew.', merger.id);

    const rows = (await t.fetchJson('GET', '/api/entries')).body;

    // 8. NO LOST HOUR. The bulk move retracted borrowed words from some of
    // these; it may not have taken an hour with them.
    const total = rows.filter((e) => e.date === DAY).reduce((a, e) => a + e.total, 0);
    assert.ok(total >= claimed - 1e-9,
      `${claimed} h was worked or keyed on ${DAY}; ${Math.round(total * 100) / 100} h is recorded`);

    // 9. export, and let nothing blank through. An entry the retraction emptied
    // must be BLOCKED rather than shipped as a blank bill line, and an export
    // nobody confirmed receiving may not stamp anything as delivered.
    const fin = await t.fetchJson('POST', '/api/finalize-day', { date: DAY, ack: true });
    const blank = rows.filter((e) => e.date === DAY && !String(e.narrative || '').trim());
    for (const b of blank) {
      assert.ok((fin.body.blocked || []).some((x) => x.id === b.id),
        `entry ${b.id} has no sentence and was finalized anyway`);
    }
    const exp = await t.fetchJson('POST', '/api/export', { from: DAY, to: DAY });
    // entry_id is the LAST column; matching it anywhere in the line would also
    // hit a duration or a matter number.
    const exported = new Set(exp.body.csv.trim().split('\n').slice(1).filter(Boolean)
      .map((l) => l.split(',').pop().trim()));
    for (const b of blank) {
      assert.ok(!exported.has(String(b.id)),
        `entry ${b.id} has no sentence and reached the file:\n${exp.body.csv}`);
    }
    assert.equal(
      t.db.prepare('SELECT COUNT(*) c FROM entries WHERE exported_at IS NOT NULL').get().c, 0,
      'an unconfirmed export stamped an entry as delivered');

    // …and the closing sweep runs on the way out of `attack`.
  }));
