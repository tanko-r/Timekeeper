import { Router } from 'express';
import { getSetting } from '../db.js';
import { todayLocal, localMidnightMs } from '../lib/dates.js';
import { secondsToHours } from '../lib/rounding.js';
import { elapsedSeconds, rollover } from '../lib/timerlogic.js';
import { parseCsv } from '../lib/csv.js';
import { detectMapping, normalizeMapping, planImport } from '../lib/timerimport.js';
import {
  loadEntry, syncNarrative, rebuildMatterPeople, recordAudit, retractsNarrative,
} from './entries.js';
import { ensureClient } from './cms.js';
import { splitCmNumber } from '../lib/cmNumber.js';
import { matterSuggestions } from './matters.js';
import { refineSuggestedNarrative } from './ai.js';
import { containsTimeAmounts } from '../lib/timeAmounts.js';
// The one rule that keeps an entry's task lines equal to its billed total.
// Lives in server/lib/ because all THREE write paths need it — the day clock
// here, PATCH /api/entries/:id, and close-out's settleRunningTimers — and a
// second copy is how the other two drifted (Stage 1e landed it on one only).
import { reconcileLines } from '../lib/reconcile.js';

// Round-2 timer model: the clock accumulates for the whole day across
// start/stops. Each stop syncs the day total into ONE linked draft entry.
// "fresh" zeroes the clock and unlinks so later time files to a new entry.

// Caption a matterless quick timer carries until it's named or gets a matter.
const QUICK_TIMER_NAME = 'Quick timer';

const TIMER_COLS = `id, name, cm_id, task_code, sort_order, running,
  accumulated_seconds, last_started_at, last_reset_date, created_at,
  group_id, linked_entry_id, last_stopped_at, suggested_narrative, held_since,
  pinned, draft_narrative, narrative_template`;

const TENTH_SECONDS = 360;

function roundingCfg(db) {
  return getSetting(db, 'rounding') || {};
}

function minIncrement(db) {
  return (getSetting(db, 'validation') || {}).minIncrement || 0.1;
}

const round4 = (n) => Math.round(n * 10000) / 10000;

// The entry's hours as the app computes them: an explicit override, else the
// sum of its task lines (same rule as enrich() in routes/entries.js).
function storedTotal(db, entry) {
  if (entry.total_override != null) return Number(entry.total_override);
  return round4(db.prepare(
    'SELECT COALESCE(SUM(duration), 0) s FROM entry_tasks WHERE entry_id=?').get(entry.id).s);
}

// File `hours` into the timer's linked entry for `dateStr`, creating and
// (re)linking as needed. Works for MATTERLESS timers too (2026-07-13): the
// entry is created with cm_id NULL and carries the time — it just can't
// finalize or export until a matter is assigned. Returns
// { entryId, relinked, previousTotal }.
function syncToEntry(db, timer, hours, dateStr, nowIso) {
  let relinked = false;
  let previousTotal = null;
  let entry = null;
  if (timer.linked_entry_id) {
    entry = db.prepare(
      'SELECT id, cm_id, date, status, deleted_at, total_override FROM entries WHERE id=?'
    ).get(timer.linked_entry_id);
    const valid = entry && !entry.deleted_at && entry.status === 'draft'
      && entry.date === dateStr && entry.cm_id === timer.cm_id;
    if (!valid) {
      relinked = !!entry;
      // Only an entry that SURVIVES the break is a settled home for the hours
      // it was given — one that moved to another matter or date, or was
      // finalized. A SOFT-DELETED entry keeps nothing: it is off every bill,
      // every export and every total, so deducting its hours from the clock
      // would drop them out of the day entirely. They stay on the clock and
      // reach the next entry, which is what this code did before the deduct
      // was added and what the "nothing dropped" rule requires.
      previousTotal = entry && !entry.deleted_at ? storedTotal(db, entry) : null;
      entry = null;
    }
  }

  // The link just broke: the entry moved to another matter or date, was
  // deleted, or was finalized. It KEEPS the hours already filed onto it, so
  // those hours are settled and must LEAVE the day clock before the remainder
  // opens a new entry — otherwise the same time is billed on both rows (the
  // Acme duplicate, 2026-07-10). finalizeOne() in routes/entries.js resolves
  // the identical situation the same way; it can simply zero the clock because
  // the whole of it went to the entry it locked. Here only part of the day did,
  // so deduct exactly that part and rebase the accumulator to the remainder —
  // a running timer keeps running and counts up from now.
  let rebaseSeconds = null;
  if (relinked && previousTotal > 0) {
    const settled = Math.min(previousTotal, hours);
    hours = round4(hours - settled);
    rebaseSeconds = Math.max(
      0, elapsedSeconds(timer, Date.parse(nowIso)) - Math.round(settled * 3600));
  }

  // Nothing left to file. The departed entry kept the whole clock, so opening
  // a new entry here would manufacture a 0.0h draft with an empty narrative on
  // the new matter — invisible at the time and a hard block at close-out since
  // a zero-hour entry stopped being finalizable. It fires on the commonest
  // flow there is: stop a timer, re-point it, before any time on the new
  // matter. Rebase the clock, drop the stale link, and open nothing.
  if (entry === null && rebaseSeconds != null && !(hours > 0)) {
    db.prepare('UPDATE timers SET accumulated_seconds=?, last_started_at=?, linked_entry_id=NULL WHERE id=?')
      .run(rebaseSeconds, timer.running ? nowIso : null, timer.id);
    return { entryId: null, relinked, previousTotal, filedHours: 0 };
  }

  let entryId;
  db.transaction(() => {
    if (entry) {
      db.prepare('UPDATE entries SET total_override=?, updated_at=? WHERE id=?')
        .run(hours, nowIso, entry.id);
      const lines = db.prepare(
        'SELECT id, duration FROM entry_tasks WHERE entry_id=? ORDER BY sort_order, id').all(entry.id);
      reconcileLines(db, lines, hours, roundingCfg(db));
      syncNarrative(db, entry.id);
      entryId = entry.id;
    } else {
      const cm = timer.cm_id
        ? db.prepare('SELECT id, billable FROM matters WHERE id=?').get(timer.cm_id)
        : null;
      // Every entry this timer creates STARTS with its template narrative
      // (2026-07-13 feedback); any stashed text follows it.
      const seedNarrative = [timer.narrative_template, timer.draft_narrative]
        .filter(Boolean).join(' ').trim();
      const info = db.prepare(`INSERT INTO entries
        (date, cm_id, narrative, billable, status, total_override, source, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'draft', ?, 'timer', ?, ?)`)
        .run(dateStr, timer.cm_id ?? null, seedNarrative,
          cm ? cm.billable : 1, hours, nowIso, nowIso);
      db.prepare(
        'INSERT INTO entry_tasks (entry_id, task_code, duration, fragment, sort_order) VALUES (?, ?, ?, ?, 0)'
      ).run(info.lastInsertRowid, timer.task_code || '', hours, '');
      entryId = info.lastInsertRowid;
      // stash consumed: text typed before this entry existed now lives on it
      db.prepare('UPDATE timers SET linked_entry_id=?, draft_narrative=NULL WHERE id=?')
        .run(entryId, timer.id);
      // …and the hours the departed entry kept leave the clock with it
      if (rebaseSeconds != null) {
        db.prepare('UPDATE timers SET accumulated_seconds=?, last_started_at=? WHERE id=?')
          .run(rebaseSeconds, timer.running ? nowIso : null, timer.id);
      }
    }
    if (timer.cm_id) {
      db.prepare('UPDATE matters SET last_used_at=? WHERE id=?').run(nowIso, timer.cm_id);
      rebuildMatterPeople(db, timer.cm_id);
    }
  })();

  // `filedHours` is what actually landed on the entry — the caller's `hours`
  // MINUS anything the departed entry had already settled. The stop response
  // reports this rather than the pre-deduction figure, so the stop chip never
  // tells the attorney "1.5h filed" when 0.5h was filed.
  return { entryId, relinked, previousTotal, filedHours: hours };
}

// A start-created entry that never got real content (no time, no narrative,
// no user-touched task lines) is noise — remove it where the user's action
// means "that start didn't count": misclick grace and "fresh". NEVER called
// from the midnight reset — entries always survive the day boundary.
function deleteIfUntouched(db, timer, nowIso) {
  const entryId = timer && timer.linked_entry_id;
  if (!entryId) return false;
  const e = db.prepare(`SELECT id, narrative FROM entries WHERE id=? AND deleted_at IS NULL
    AND status='draft' AND ever_finalized=0
    AND COALESCE(total_override, 0) = 0`).get(entryId);
  if (!e) return false;
  // "Untouched" means the ATTORNEY put nothing into it. Text the START seeded
  // from the timer's own template or stash still counts as untouched — it came
  // from the timer, not from him, and syncToEntry writes exactly this string.
  // Requiring narrative='' instead meant every timer carrying a template left a
  // 0.0h stray behind on a misclick: silent at the time, and a hard block at
  // close-out once a zero-hour entry stopped being finalizable.
  const seeded = [timer.narrative_template, timer.draft_narrative]
    .filter(Boolean).join(' ').trim();
  const narrative = String(e.narrative || '').trim();
  if (narrative && narrative !== seeded) return false;
  const touched = db.prepare(`SELECT COUNT(*) c FROM entry_tasks
    WHERE entry_id=? AND (COALESCE(duration, 0) != 0 OR COALESCE(fragment, '') != '')`).get(entryId).c;
  if (touched > 0) return false;
  db.prepare('UPDATE entries SET deleted_at=?, updated_at=? WHERE id=?').run(nowIso, nowIso, entryId);
  return true;
}

// Lazy midnight reset — safe to call on every request; no-op when up to date.
export function applyRollovers(db, clock) {
  const today = todayLocal(clock());
  const stale = db.prepare(`SELECT ${TIMER_COLS} FROM timers WHERE last_reset_date < ?`).all(today);
  if (stale.length === 0) return;
  const rounding = roundingCfg(db);
  const minInc = minIncrement(db);
  const nowIso = clock().toISOString();
  for (const timer of stale) {
    const r = rollover(timer, today);
    // Matterless timers bank like any other (2026-07-13): the time lives in
    // a matterless entry dated the day it was worked, and the clock resets —
    // the old carry-the-clock/held_since model is retired.
    const hours = secondsToHours(r.bankSeconds, rounding);
    if (hours >= minInc - 1e-9 && hours > 0) {
      syncToEntry(db, timer, hours, r.bankDate, nowIso);
    } else if (r.bankSeconds > 0) {
      console.log(`timer ${timer.id} (${timer.name}): dropped ${r.bankSeconds}s below minimum increment at midnight reset`);
    }
    // The midnight reset NEVER deletes: whatever entry the timer was linked
    // to is preserved as-is (David, 2026-07-10) — it only banks and unlinks.
    db.prepare(
      'UPDATE timers SET accumulated_seconds=0, last_started_at=?, last_reset_date=?, linked_entry_id=NULL WHERE id=?'
    ).run(timer.running ? r.restartIso : null, today, timer.id);
    if (timer.running) {
      // running through midnight: the new day's entry exists from its first
      // moment, same as a fresh start
      const freshTimer = db.prepare(`SELECT ${TIMER_COLS} FROM timers WHERE id=?`).get(timer.id);
      const hoursToday = secondsToHours(elapsedSeconds(freshTimer, clock().getTime()), rounding);
      syncToEntry(db, freshTimer, hoursToday, today, nowIso);
    }
  }
}

export function timersRouter({ db, clock }) {
  const r = Router();
  const now = () => clock().toISOString();
  const getTimer = db.prepare(`SELECT ${TIMER_COLS} FROM timers WHERE id=?`);

  const withElapsed = (t) => ({ ...t, elapsed_seconds: elapsedSeconds(t, clock().getTime()) });

  const listStmt = () => db.prepare(`SELECT ${TIMER_COLS},
      (SELECT cm_number FROM matters WHERE matters.id = timers.cm_id) AS cm_number,
      (SELECT short_name FROM matters WHERE matters.id = timers.cm_id) AS cm_short_name,
      (SELECT billable FROM matters WHERE matters.id = timers.cm_id) AS cm_billable,
      (SELECT client_id FROM matters WHERE matters.id = timers.cm_id) AS client_id,
      (SELECT c.client_number FROM matters m JOIN clients c ON c.id = m.client_id WHERE m.id = timers.cm_id) AS client_number,
      (SELECT c.name FROM matters m JOIN clients c ON c.id = m.client_id WHERE m.id = timers.cm_id) AS client_name,
      (SELECT narrative FROM entries WHERE entries.id = timers.linked_entry_id) AS entry_narrative,
      (SELECT narrative_manual FROM entries WHERE entries.id = timers.linked_entry_id) AS entry_narrative_manual,
      (SELECT COUNT(*) FROM entry_tasks WHERE entry_tasks.entry_id = timers.linked_entry_id
        AND (TRIM(COALESCE(entry_tasks.fragment, '')) != ''
          OR TRIM(COALESCE(entry_tasks.task_code, '')) != ''
          OR COALESCE(entry_tasks.duration, 0) > 0)) AS entry_substantive_lines
    FROM timers ORDER BY sort_order, id`);

  r.get('/', (req, res) => {
    applyRollovers(db, clock);
    res.json(listStmt().all().map(withElapsed));
  });

  r.post('/', (req, res) => {
    const b = req.body || {};
    let name = String(b.name || '').trim();
    // Quick timers: no client/matter — just time and an optional caption.
    // Starts/stops file into a MATTERLESS entry like any other timer; a
    // matter assigned later (PATCH) associates that entry in place.
    let cm = null;
    if (b.cm_id != null) {
      cm = db.prepare('SELECT id FROM matters WHERE id=?').get(b.cm_id);
      if (!cm) return res.status(400).json({ error: 'Unknown CM.' });
      if (!name) return res.status(400).json({ error: 'Timer name required.' });
    }
    if (!name) name = QUICK_TIMER_NAME;
    if (b.group_id != null && !db.prepare('SELECT id FROM timer_groups WHERE id=?').get(b.group_id)) {
      return res.status(400).json({ error: 'Unknown group.' });
    }
    const max = db.prepare('SELECT COALESCE(MAX(sort_order), -1) m FROM timers').get().m;
    const info = db.prepare(
      'INSERT INTO timers (name, cm_id, task_code, group_id, sort_order, last_reset_date, created_at, narrative_template) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(name, cm ? cm.id : null, b.task_code ? String(b.task_code) : null,
      b.group_id ?? null, max + 1, todayLocal(clock()), now(),
      String(b.narrative_template ?? '').trim() || null);
    res.status(201).json(withElapsed(getTimer.get(info.lastInsertRowid)));
  });

  // --- CSV batch import: map columns → create new matters + timers ---

  // Parse the CSV and build a plan against current DB state. Shared by the
  // preview (dry-run) and commit endpoints so both see identical decisions.
  function buildPlan(body) {
    const rows = parseCsv(String(body.csv || ''));
    if (rows.length === 0) return { error: 'CSV appears to be empty.' };
    const headers = rows[0].map((h) => String(h ?? ''));
    const mapping = body.mapping
      ? normalizeMapping(body.mapping, headers.length)
      : detectMapping(headers);
    const existingCmNumbers = db.prepare('SELECT cm_number FROM matters').all().map((x) => x.cm_number);
    const nonBillableGroups = (getSetting(db, 'import') || {}).nonBillableGroups || [];
    const { plan, counts } = planImport(rows, mapping, { existingCmNumbers, nonBillableGroups });
    return { headers, mapping, plan, counts };
  }

  r.post('/import/preview', (req, res) => {
    const out = buildPlan(req.body || {});
    if (out.error) return res.status(400).json({ error: out.error });
    res.json(out);
  });

  r.post('/import', (req, res) => {
    const out = buildPlan(req.body || {});
    if (out.error) return res.status(400).json({ error: out.error });
    const toCreate = out.plan.filter((p) => p.action === 'create');
    const nowIso = now();
    const today = todayLocal(clock());
    const timerIds = [];

    db.transaction(() => {
      const groupByName = new Map(
        db.prepare('SELECT id, name FROM timer_groups').all()
          .map((g) => [g.name.toLowerCase(), g.id]));
      let groupOrder = db.prepare('SELECT COALESCE(MAX(sort_order), -1) m FROM timer_groups').get().m;
      let timerOrder = db.prepare('SELECT COALESCE(MAX(sort_order), -1) m FROM timers').get().m;
      const insCm = db.prepare(
        'INSERT INTO matters (cm_number, short_name, billable, favorite, client_id, matter_number, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?, ?, ?)');
      const insGroup = db.prepare('INSERT INTO timer_groups (name, sort_order) VALUES (?, ?)');
      const insTimer = db.prepare(
        'INSERT INTO timers (name, cm_id, task_code, group_id, sort_order, last_reset_date, created_at) VALUES (?, ?, NULL, ?, ?, ?, ?)');

      const nameClient = db.prepare(
        "UPDATE clients SET name=?, updated_at=? WHERE id=? AND (name IS NULL OR name='')");
      for (const p of toCreate) {
        const parts = splitCmNumber(p.cm_number);
        const clientId = ensureClient(db, parts.clientNumber, nowIso);
        // CSV client name fills a blank client; a client already named in the
        // app keeps its name (imports never rename).
        if (p.client_name) nameClient.run(p.client_name, nowIso, clientId);
        const cmId = insCm.run(p.cm_number, p.matter_name, p.billable, clientId, parts.matterNumber, nowIso, nowIso).lastInsertRowid;
        let groupId = null;
        if (p.group) {
          const key = p.group.toLowerCase();
          groupId = groupByName.get(key);
          if (groupId === undefined) {
            groupId = insGroup.run(p.group, ++groupOrder).lastInsertRowid;
            groupByName.set(key, groupId);
          }
        }
        timerIds.push(insTimer.run(p.matter_name, cmId, groupId, ++timerOrder, today, nowIso).lastInsertRowid);
      }
    })();

    res.status(201).json({ created: timerIds.length, skipped: out.counts.skip, timerIds });
  });

  r.put('/order', (req, res) => {
    const ids = (req.body || {}).ids;
    if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids array required.' });
    const upd = db.prepare('UPDATE timers SET sort_order=? WHERE id=?');
    db.transaction(() => ids.forEach((id, i) => upd.run(i, id)))();
    res.json({ ok: true });
  });

  r.patch('/:id', (req, res) => {
    // A re-pointed matter MOVES the linked entry (below), so the link must not
    // be a stale one pointing at yesterday's entry.
    applyRollovers(db, clock);
    const timer = getTimer.get(req.params.id);
    if (!timer) return res.status(404).json({ error: 'Timer not found.' });
    const b = req.body || {};
    // cm_id: undefined = leave alone, null = un-assign (quick timer), id = validate
    if (b.cm_id != null && !db.prepare('SELECT id FROM matters WHERE id=?').get(b.cm_id)) {
      return res.status(400).json({ error: 'Unknown CM.' });
    }
    if (b.group_id != null && !db.prepare('SELECT id FROM timer_groups WHERE id=?').get(b.group_id)) {
      return res.status(400).json({ error: 'Unknown group.' });
    }
    let name = b.name !== undefined ? String(b.name).trim() : timer.name;
    if (!name) return res.status(400).json({ error: 'Timer name required.' });
    const cmChanged = b.cm_id !== undefined && (b.cm_id ?? null) !== (timer.cm_id ?? null);
    // Auto-caption (2026-07-17 / 2026-07-21 feedback): assigning a matter to a
    // still-default "Quick timer" renames it to the matter's short name. Only
    // when the request isn't setting a name itself and the timer hasn't been
    // named by hand — a deliberate label is never clobbered.
    if (b.name === undefined && cmChanged && b.cm_id != null && timer.name === QUICK_TIMER_NAME) {
      const m = db.prepare('SELECT short_name FROM matters WHERE id=?').get(b.cm_id);
      if (m && m.short_name) name = m.short_name;
    }
    // Re-pointing the matter MOVES the linked entry (2026-07-13 for the
    // matterless quick-timer case; extended 2026-07-31 to matter→matter): the
    // entry is this timer's block of time, so it follows the timer — same
    // entry, same time, same narrative, new matter. Orphaning it while the day
    // clock stayed put filed the SAME hours into a second entry, so switching
    // a timer off the "Pending" placeholder showed the time twice. Only a
    // deleted or already-finalized entry stays behind (its time is settled);
    // there the timer unlinks and opens a fresh entry.
    const linked = timer.linked_entry_id
      ? db.prepare(`SELECT id, cm_id, status, deleted_at, ever_finalized, narrative, total_override
           FROM entries WHERE id=?`).get(timer.linked_entry_id)
      : null;
    const liveLink = !!(linked && !linked.deleted_at && linked.status === 'draft');

    // ── the entry with FILED hours needs consent to move (owner, 2026-08-16)
    // Moving the linked entry carries its NARRATIVE across a matter boundary,
    // which docs/ui/BRIEF.md forbids outright. For a draft that the timer just
    // opened that is harmless — the sentence is the timer's own and no bill has
    // seen it. For an entry that has ALREADY BEEN FINALIZED once, the sentence
    // is a billing record written against the old matter, so the owner decided
    // the app must ASK every time: leave the time where it is, or move it too.
    //
    // The API is therefore EXPLICIT, and ABSENT MEANS DO NOT MOVE — the safe
    // half of the choice is the one a caller that says nothing gets.
    //
    // The gate keys on ever_finalized, NEVER on status: an entry is unlocked
    // back to draft to be corrected, and ~15 PATCH cm_id call sites across the
    // app and the suite legitimately move a plain draft.
    //
    // A MATTERLESS quick timer being given its FIRST matter is not this case at
    // all — nothing was ever written against another matter — so it keeps
    // following the timer silently, ever_finalized or not.
    const linkedSeed = [timer.narrative_template, timer.draft_narrative]
      .filter(Boolean).join(' ').trim();
    const linkedNarrative = liveLink ? String(linked.narrative || '').trim() : '';
    const holdsWork = liveLink
      && (storedTotal(db, linked) > 0
        || (linkedNarrative !== '' && linkedNarrative !== linkedSeed));
    const needsConsent = liveLink && holdsWork && timer.cm_id != null;
    const moveEntry = b.move_entry === true;
    const associate = cmChanged && b.cm_id != null && liveLink
      && (!needsConsent || moveEntry);

    // *** THE DOUBLE-FILE TRAP ***
    // When the entry stays behind, the hours already on it are SETTLED — they
    // are on a real matter's books. The day clock, however, still holds them.
    // Nulling the link here and then syncing the FULL clock into a brand-new
    // entry files 2.0 h for 1.0 h worked (the Acme duplicate, 2026-07-10). So
    // the stale link is deliberately KEPT across the update: syncToEntry() then
    // sees an entry whose cm_id no longer matches the timer's, deducts exactly
    // what that entry kept, and rebases the accumulator to the remainder — the
    // Stage 1e mechanism, unchanged. The settle below is unconditional in this
    // case so the stale link is always resolved before the response.
    const leaveEntryBehind = cmChanged && b.cm_id != null && liveLink && !associate;

    // A timer carries THREE pieces of armed narrative state — draft_narrative
    // (the float window's stash), narrative_template (the Edit-timer dialog's
    // seed) and suggested_narrative — and syncToEntry() writes the first two
    // onto every entry the timer opens from then on. All three are composed
    // for a SPECIFIC matter, so re-pointing the timer must disarm them:
    // docs/ui/INTEGRITY.md — a narrative may never cross a matter boundary,
    // not even between two matters of the same client. Leaving them armed put
    // one client's sentence on another's entry, and it finalized and exported
    // there.
    //
    // Two cases are NOT a carry and must survive:
    //  - matterless → matter (a quick timer being named): the text was never
    //    written against another matter, so it follows the timer as designed;
    //  - a value the SAME request supplies that differs from what the timer
    //    was holding: that is the user typing for the NEW matter, and it is
    //    honoured. TimerModal.save() re-sends the template textarea exactly as
    //    it loaded it, so an identical value is the old matter's text coming
    //    back round, not intent — it still goes.
    const disarm = cmChanged && timer.cm_id != null;
    const nextNarrative = (bodyValue, current) => {
      const next = bodyValue !== undefined
        ? (String(bodyValue ?? '').trim() || null)
        : current;
      return disarm && next === current ? null : next;
    };

    db.prepare('UPDATE timers SET name=?, cm_id=?, task_code=?, group_id=?, linked_entry_id=?, suggested_narrative=?, pinned=?, draft_narrative=?, narrative_template=? WHERE id=?').run(
      name,
      b.cm_id !== undefined ? b.cm_id : timer.cm_id,
      b.task_code !== undefined ? (b.task_code ? String(b.task_code) : null) : timer.task_code,
      b.group_id !== undefined ? b.group_id : timer.group_id,
      // new CM → the old entry is no longer this timer's home, EXCEPT while the
      // deduct still needs it (see THE DOUBLE-FILE TRAP above)
      cmChanged && !associate && !leaveEntryBehind ? null : timer.linked_entry_id,
      cmChanged ? null : timer.suggested_narrative, // suggestion belonged to the old matter
      b.pinned !== undefined ? (b.pinned ? 1 : 0) : timer.pinned,
      // user text — survives everything EXCEPT a move off a real matter,
      // where it belonged to the matter left behind (see nextNarrative above)
      nextNarrative(b.draft_narrative, timer.draft_narrative),
      nextNarrative(b.narrative_template, timer.narrative_template),
      timer.id);

    let entry = null;
    const fresh = getTimer.get(timer.id);
    if (associate) {
      db.transaction(() => {
        const cmRow = db.prepare('SELECT id, billable FROM matters WHERE id=?').get(fresh.cm_id);
        // The row as it stood BEFORE the move, so the audit can name where the
        // entry came from. Only the columns recordAudit() compares.
        const beforeEntry = db.prepare(`SELECT id, date, cm_id, narrative, billable,
          total_override, ever_finalized, narrative_src_cm_id FROM entries WHERE id=?`).get(linked.id);
        // the entry's billable was a matterless placeholder, or the OLD
        // matter's flag — either way the new matter's flag takes over
        db.prepare('UPDATE entries SET cm_id=?, billable=?, updated_at=? WHERE id=?')
          .run(fresh.cm_id, cmRow ? cmRow.billable : 1, now(), linked.id);
        // Same retraction as PATCH /api/entries/:id and the bulk move: a
        // sentence the app composed for the matter this entry is LEAVING does
        // not travel with it. syncNarrative then refills the empty box from the
        // entry's own task lines in the new client's format. Hand-typed text
        // carries no provenance and is never touched.
        if (retractsNarrative(beforeEntry, fresh.cm_id)) {
          db.prepare(
            'UPDATE entries SET narrative=?, narrative_manual=0, narrative_ai=0, narrative_src_cm_id=NULL WHERE id=?')
            .run('', linked.id);
          syncNarrative(db, linked.id);
        }
        db.prepare('UPDATE matters SET last_used_at=? WHERE id=?').run(now(), fresh.cm_id);
        // The timer surface moves an entry exactly as PATCH /api/entries/:id
        // does, so it owes the same record. Without it an entry that had
        // already been billed once could change matter — and carry its old
        // matter's narrative — with nothing anywhere naming the matter it came
        // from. recordAudit's own gate keeps plain drafts unaudited, which is
        // the documented behaviour of both routes.
        recordAudit(db, beforeEntry, {}, now());
        rebuildMatterPeople(db, fresh.cm_id);
        // the entry left the old matter — its people roll-up must lose it too
        if (linked.cm_id) rebuildMatterPeople(db, linked.cm_id);
      })();
      entry = loadEntry(db, linked.id);
    }
    if (cmChanged && fresh.cm_id) {
      // Settle the clock into the (new or just-associated) entry: a RUNNING
      // timer links its entry immediately (feedback 2026-07-10) — the total
      // settles at stop; a PAUSED one files its settled clock right now.
      const hours = secondsToHours(elapsedSeconds(fresh, clock().getTime()), roundingCfg(db));
      // `leaveEntryBehind` forces the call even for a sub-increment clock: it
      // is what deducts the settled hours and clears the stale link.
      if (fresh.running || leaveEntryBehind || (hours >= minIncrement(db) - 1e-9 && hours > 0)) {
        const synced = syncToEntry(db, fresh, hours, todayLocal(clock()), now());
        // null when the departed entry kept the whole clock and nothing was left
        // to file — no entry is opened in that case, and none is reported.
        entry = synced.entryId ? loadEntry(db, synced.entryId) : null;
      }
    }
    res.json({ ...withElapsed(getTimer.get(timer.id)), entry });
  });

  r.delete('/:id', (req, res) => {
    const timer = getTimer.get(req.params.id);
    if (!timer) return res.status(404).json({ error: 'Timer not found.' });
    db.prepare('DELETE FROM timers WHERE id=?').run(timer.id);
    res.json({ ok: true });
  });

  // Multi-select delete (2026-08-06 feedback). All-or-nothing: a selection can
  // go stale between the right-click and the confirm (another tab, a rollover),
  // and half a delete is worse than none. Entries the timers filed are kept,
  // same as the single delete above.
  r.post('/batch-delete', (req, res) => {
    const ids = (req.body || {}).ids;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'ids array required.' });
    }
    const missing = ids.filter((id) => !getTimer.get(id));
    if (missing.length) return res.status(404).json({ error: 'Timer not found.' });
    const del = db.prepare('DELETE FROM timers WHERE id=?');
    let deleted = 0;
    db.transaction(() => { for (const id of ids) deleted += del.run(id).changes; })();
    res.json({ ok: true, deleted });
  });

  r.post('/:id/duplicate', (req, res) => {
    const timer = getTimer.get(req.params.id);
    if (!timer) return res.status(404).json({ error: 'Timer not found.' });
    const max = db.prepare('SELECT COALESCE(MAX(sort_order), -1) m FROM timers').get().m;
    const info = db.prepare(
      'INSERT INTO timers (name, cm_id, task_code, group_id, sort_order, last_reset_date, created_at, narrative_template) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(`${timer.name} (copy)`, timer.cm_id, timer.task_code, timer.group_id,
      max + 1, todayLocal(clock()), now(), timer.narrative_template);
    res.status(201).json(withElapsed(getTimer.get(info.lastInsertRowid)));
  });

  // Stop the timer and file the day total into its linked entry. Shared by
  // the stop route and the exclusive-start auto-stop so both behave the same.
  function stopAndFile(timer) {
    // Misclick grace: a running stretch of ≤2 seconds vanishes entirely —
    // nothing accumulates, nothing files, the last-stop anchor doesn't move.
    if (timer.running && timer.last_started_at
      && clock().getTime() - Date.parse(timer.last_started_at) <= 2000) {
      // "nothing happened" includes the entry the misclicked start created
      const removedEmpty = deleteIfUntouched(db, timer, now());
      db.prepare(`UPDATE timers SET running=0, last_started_at=NULL${removedEmpty ? ', linked_entry_id=NULL' : ''} WHERE id=?`)
        .run(timer.id);
      return {
        entry: null, hours: 0, discarded: true,
        seconds: timer.accumulated_seconds,
        timer: withElapsed(getTimer.get(timer.id)),
      };
    }

    const seconds = elapsedSeconds(timer, clock().getTime());
    db.prepare('UPDATE timers SET running=0, accumulated_seconds=?, last_started_at=NULL, last_stopped_at=? WHERE id=?')
      .run(seconds, now(), timer.id);

    // No matter yet? Doesn't matter (2026-07-13): the time files into the
    // timer's matterless entry, which holds it until a matter is assigned.
    const hours = secondsToHours(seconds, roundingCfg(db));
    if (hours < minIncrement(db) - 1e-9 || hours <= 0) {
      return { entry: null, hours: 0, seconds, timer: withElapsed(getTimer.get(timer.id)) };
    }
    const synced = syncToEntry(db, getTimer.get(timer.id), hours, todayLocal(clock()), now());
    return {
      entry: synced.entryId ? loadEntry(db, synced.entryId) : null,
      // what reached the entry, not what came off the clock — see syncToEntry
      hours: synced.filedHours ?? hours,
      seconds,
      relinked: synced.relinked || undefined,
      previousTotal: synced.previousTotal ?? undefined,
      timer: withElapsed(getTimer.get(timer.id)),
    };
  }

  // Core of a start: exclusivity stop of other timers, the running flag,
  // the pre-computed narrative suggestion, and the start-created entry.
  // Shared by POST /:id/start and POST /start-for-entry; returns
  // { status, body } for the route to send.
  function doStart(timer, b) {
    const backdated = b.minutesAgo != null || b.atLastStop;

    let startMs = null;
    if (timer.running) {
      if (backdated) {
        return { status: 409, body: { error: 'Timer is already running — pause it before a backdated start.' } };
      }
    } else {
      startMs = clock().getTime();
      if (b.atLastStop && timer.last_stopped_at) {
        startMs = Date.parse(timer.last_stopped_at);
      } else if (b.minutesAgo != null) {
        const mins = Number(b.minutesAgo);
        if (!Number.isFinite(mins) || mins < 0 || mins > 24 * 60) {
          return { status: 400, body: { error: 'minutesAgo must be 0–1440.' } };
        }
        startMs = clock().getTime() - mins * 60_000;
      }
      // never reach behind today's midnight — yesterday is banked and closed
      startMs = Math.max(startMs, localMidnightMs(todayLocal(clock())));
    }

    // Exclusive timers: one running timer at a time. Stop-and-file every
    // other running timer (same path as a manual stop) before this one
    // starts — server-side, so it holds across tabs and races. A backdated
    // start still stops the others at NOW; the resulting overlap is the
    // user's explicit claim, same as before exclusivity.
    const stopped = db.prepare(`SELECT ${TIMER_COLS} FROM timers WHERE running=1 AND id != ?`)
      .all(timer.id).map((other) => stopAndFile(other));

    if (startMs != null) {
      db.prepare('UPDATE timers SET running=1, last_started_at=? WHERE id=?')
        .run(new Date(startMs).toISOString(), timer.id);
      // Pre-compute the likely narrative NOW so it's ready before stop (spec
      // §6): deterministic phrasebook top hit synchronously; the optional
      // local-LLM pass refines it in the background and never blocks. Skip
      // any top-ranked phrase that carries a baked-in time amount (e.g. an
      // old free-text narrative like "Drafted agreement (0.5)...") — time is
      // unknown at start (often zero) and must never be invented.
      if (timer.cm_id) {
        const sugg = matterSuggestions(db, timer.cm_id, todayLocal(clock()));
        // source === 'matter' is the matter boundary (docs/ui/BRIEF.md, "Data
        // integrity"). suggested_narrative becomes a whole billing sentence —
        // the stop chip offers it, the close-out sheet prefills it — so it may
        // only ever be THIS matter's own text. matterSuggestions blends sibling
        // wording when a matter is thin, which is exactly when a first timer is
        // started on a brand-new matter; taking phrases[0] unchecked stamped
        // the sibling's phrase onto it. If this matter has nothing of its own,
        // the suggestion stays NULL — the brief's "offer nothing" case.
        const cleanPhrase = sugg && sugg.phrases.find(
          (p) => p.source === 'matter' && !containsTimeAmounts(p.text));
        db.prepare('UPDATE timers SET suggested_narrative=? WHERE id=?')
          .run(cleanPhrase ? cleanPhrase.text : null, timer.id);
        refineSuggestedNarrative({ db, clock }, timer.id).catch(() => {});
      }
    }

    // Feedback 2026-07-10: the entry exists from the moment the timer starts,
    // so Today's entries always shows what's accruing. Created at the current
    // clock value — 0.0 for a fresh timer; the first stop lifts it. Matterless
    // timers included (2026-07-13): their entry is simply unassociated.
    let entry = null;
    let relink = null;
    if (startMs != null) {
      const freshTimer = getTimer.get(timer.id);
      const hours = secondsToHours(elapsedSeconds(freshTimer, clock().getTime()), roundingCfg(db));
      const synced = syncToEntry(db, freshTimer, hours, todayLocal(clock()), now());
      entry = synced.entryId ? loadEntry(db, synced.entryId) : null;
      // The old linked entry may have been finalized/deleted meanwhile — the
      // relink (with its double-count risk) now surfaces at start, not stop.
      if (synced.relinked) relink = { relinked: true, previousTotal: synced.previousTotal ?? undefined };
    }

    const out = { timer: withElapsed(getTimer.get(timer.id)), entry, ...(relink || {}) };
    if (stopped.length > 0) out.stopped = stopped;
    return { status: 200, body: out };
  }

  // ── a re-pointed clock may not strand the entry it was serving ────────────
  // start-for-entry, finding no clock on the entry the attorney pressed, adopts
  // the most recent PAUSED timer on the same matter. That timer may still be
  // serving an earlier entry which holds filed time but no sentence yet — the
  // ordinary result of stopping a timer and dismissing the stop chip. Taking
  // the clock away left that entry with time on it, no words, and NOTHING on
  // the board pointing at it: the attorney was told nothing, and the entry then
  // hard-blocked close-out hours later, at the worst possible moment.
  //
  // So before the clock is re-pointed, leave a replacement clock on the entry
  // it is leaving. The tile stays on the board carrying that entry's own time,
  // which is the prompt to write the sentence, and the surprise at 6pm becomes
  // a visible, fixable row at the moment it is created.
  //
  // Only an entry that still OWES something gets one — live, still a draft,
  // holding time, and with no narrative. A settled entry needs no clock, and
  // manufacturing timers for those would litter a board that already carries
  // dozens. Nothing is copied across from the departing timer except its name:
  // `suggested_narrative` is a whole billing sentence and stays with the matter
  // it was composed for (docs/ui/BRIEF.md, "Data integrity").
  function keepClockOnStrandedEntry(timer, targetEntryId) {
    const strandedId = timer.linked_entry_id;
    if (!strandedId || strandedId === targetEntryId) return null;
    const stranded = loadEntry(db, strandedId);
    if (!stranded || stranded.deleted_at || stranded.status !== 'draft') return null;
    if (!(Number(stranded.total) > 0)) return null;
    if (String(stranded.narrative || '').trim()) return null;

    const max = db.prepare('SELECT COALESCE(MAX(sort_order), -1) m FROM timers').get().m;
    const info = db.prepare(
      `INSERT INTO timers (name, cm_id, task_code, sort_order, last_reset_date, created_at,
         linked_entry_id, accumulated_seconds, last_stopped_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(timer.name, stranded.cm_id, timer.task_code, max + 1, todayLocal(clock()), now(),
      stranded.id, Math.round(Number(stranded.total) * 3600), now());
    return getTimer.get(info.lastInsertRowid);
  }

  r.post('/:id/start', (req, res) => {
    applyRollovers(db, clock);
    const timer = getTimer.get(req.params.id);
    if (!timer) return res.status(404).json({ error: 'Timer not found.' });
    const { status, body } = doStart(timer, req.body || {});
    res.status(status).json(body);
  });

  // Start (or create) the timer behind an entry — the entry card's start
  // button (2026-07-11 feedback). Priority: the timer already linked to the
  // entry, else a paused same-matter timer (relinked here), else a brand-new
  // timer named after the matter. Because the day-accumulator clock
  // OVERWRITES the linked entry's total at stop, (re)linking aligns the
  // clock to the entry's current total first — resuming, never clobbering.
  r.post('/start-for-entry', (req, res) => {
    applyRollovers(db, clock);
    const entryId = Number((req.body || {}).entry_id);
    const entry = entryId ? loadEntry(db, entryId) : null;
    if (!entry || entry.deleted_at) return res.status(404).json({ error: 'Entry not found.' });
    if (entry.status !== 'draft') {
      return res.status(409).json({ error: 'Entry is finalized — unlock it before timing against it.' });
    }
    if (entry.date !== todayLocal(clock())) {
      return res.status(409).json({ error: 'Only today’s entries can take a timer (the clock is a day accumulator).' });
    }

    let timer = db.prepare(`SELECT ${TIMER_COLS} FROM timers WHERE linked_entry_id=?`).get(entry.id);
    if (!timer) {
      // a paused timer on the same matter is "the other timer" to link back
      // to; a running one is busy accruing into its own entry — leave it
      timer = db.prepare(
        `SELECT ${TIMER_COLS} FROM timers WHERE cm_id=? AND running=0 ORDER BY
           COALESCE(last_stopped_at, last_started_at, created_at) DESC, id DESC`
      ).get(entry.cm_id);
      if (!timer) {
        const max = db.prepare('SELECT COALESCE(MAX(sort_order), -1) m FROM timers').get().m;
        const info = db.prepare(
          'INSERT INTO timers (name, cm_id, task_code, sort_order, last_reset_date, created_at) VALUES (?, ?, ?, ?, ?, ?)'
        ).run(entry.cm ? entry.cm.short_name : 'Quick timer', entry.cm_id,
          (entry.tasks[0] && entry.tasks[0].task_code) || null,
          max + 1, todayLocal(clock()), now());
        timer = getTimer.get(info.lastInsertRowid);
      } else {
        keepClockOnStrandedEntry(timer, entry.id);
      }
      db.prepare('UPDATE timers SET linked_entry_id=?, accumulated_seconds=? WHERE id=?')
        .run(entry.id, Math.round(entry.total * 3600), timer.id);
      timer = getTimer.get(timer.id);
    }
    const { status, body } = doStart(timer, {});
    res.status(status).json(body);
  });

  // Stop = pause + file the day total into the linked entry (create/relink as
  // needed). Never zeroes the clock; sub-increment totals just wait for more.
  r.post('/:id/stop', (req, res) => {
    applyRollovers(db, clock);
    const timer = getTimer.get(req.params.id);
    if (!timer) return res.status(404).json({ error: 'Timer not found.' });
    res.json(stopAndFile(timer));
  });

  // Zero the clock and unlink — the next stop files a brand-new entry.
  r.post('/:id/fresh', (req, res) => {
    applyRollovers(db, clock);
    const timer = getTimer.get(req.params.id);
    if (!timer) return res.status(404).json({ error: 'Timer not found.' });
    // an untouched empty entry isn't "kept" — it never had anything to keep
    deleteIfUntouched(db, timer, now());
    db.prepare(
      'UPDATE timers SET accumulated_seconds=0, last_started_at=?, linked_entry_id=NULL WHERE id=?'
    ).run(timer.running ? now() : null, timer.id);
    // invariant: a RUNNING timer always has a linked entry (matterless too)
    let entry = null;
    const freshTimer = getTimer.get(timer.id);
    if (freshTimer.running) {
      const synced = syncToEntry(db, freshTimer, 0, todayLocal(clock()), now());
      entry = loadEntry(db, synced.entryId);
    }
    res.json({ timer: withElapsed(getTimer.get(timer.id)), entry });
  });

  // Edit the clock: {hours} sets it, {deltaHours} nudges it. Tenths only.
  // While paused and linked, the entry follows immediately.
  r.put('/:id/clock', (req, res) => {
    applyRollovers(db, clock);
    const timer = getTimer.get(req.params.id);
    if (!timer) return res.status(404).json({ error: 'Timer not found.' });
    const b = req.body || {};
    const current = elapsedSeconds(timer, clock().getTime());
    let target;
    if (b.hours !== undefined) {
      const h = Number(b.hours);
      if (!Number.isFinite(h) || h < 0 || h > 24) {
        return res.status(400).json({ error: 'hours must be 0–24.' });
      }
      target = h * 3600;
    } else if (b.deltaHours !== undefined) {
      const d = Number(b.deltaHours);
      if (!Number.isFinite(d)) return res.status(400).json({ error: 'deltaHours must be a number.' });
      target = current + d * 3600;
    } else {
      return res.status(400).json({ error: 'Provide hours or deltaHours.' });
    }
    const snapped = Math.max(0, Math.round(target / TENTH_SECONDS) * TENTH_SECONDS);

    db.prepare('UPDATE timers SET accumulated_seconds=?, last_started_at=? WHERE id=?')
      .run(snapped, timer.running ? now() : null, timer.id);

    let entry = null;
    const fresh = getTimer.get(timer.id);
    const hours = secondsToHours(snapped, roundingCfg(db));
    if (!fresh.running && hours >= minIncrement(db) - 1e-9) {
      const synced = syncToEntry(db, fresh, hours, todayLocal(clock()), now());
      entry = loadEntry(db, synced.entryId);
    }
    res.json({ timer: withElapsed(getTimer.get(timer.id)), entry });
  });

  return r;
}

export function timerGroupsRouter({ db }) {
  const r = Router();
  const get = db.prepare('SELECT id, name, sort_order, collapsed FROM timer_groups WHERE id=?');

  r.get('/', (req, res) => {
    res.json(db.prepare('SELECT id, name, sort_order, collapsed FROM timer_groups ORDER BY sort_order, id').all());
  });

  r.post('/', (req, res) => {
    const name = String((req.body || {}).name || '').trim();
    if (!name) return res.status(400).json({ error: 'Group name required.' });
    const max = db.prepare('SELECT COALESCE(MAX(sort_order), -1) m FROM timer_groups').get().m;
    const info = db.prepare('INSERT INTO timer_groups (name, sort_order) VALUES (?, ?)').run(name, max + 1);
    res.status(201).json(get.get(info.lastInsertRowid));
  });

  r.put('/order', (req, res) => {
    const ids = (req.body || {}).ids;
    if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids array required.' });
    const upd = db.prepare('UPDATE timer_groups SET sort_order=? WHERE id=?');
    db.transaction(() => ids.forEach((id, i) => upd.run(i, id)))();
    res.json({ ok: true });
  });

  r.patch('/:id', (req, res) => {
    const group = get.get(req.params.id);
    if (!group) return res.status(404).json({ error: 'Group not found.' });
    const b = req.body || {};
    const name = b.name !== undefined ? String(b.name).trim() : group.name;
    if (!name) return res.status(400).json({ error: 'Group name required.' });
    const collapsed = b.collapsed !== undefined ? (b.collapsed ? 1 : 0) : group.collapsed;
    db.prepare('UPDATE timer_groups SET name=?, collapsed=? WHERE id=?').run(name, collapsed, group.id);
    res.json(get.get(group.id));
  });

  r.delete('/:id', (req, res) => {
    const group = get.get(req.params.id);
    if (!group) return res.status(404).json({ error: 'Group not found.' });
    db.transaction(() => {
      db.prepare('UPDATE timers SET group_id=NULL WHERE group_id=?').run(group.id);
      db.prepare('DELETE FROM timer_groups WHERE id=?').run(group.id);
    })();
    res.json({ ok: true });
  });

  return r;
}
