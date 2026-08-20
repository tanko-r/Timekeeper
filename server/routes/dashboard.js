import { Router } from 'express';
import { getSetting } from '../db.js';
import { todayLocal, addDays } from '../lib/dates.js';
import { ENTRY_HOURS_SQL, ATTENTION_WINDOW_DAYS } from '../lib/attention.js';
import { elapsedSeconds } from '../lib/timerlogic.js';
import { enrich } from './entries.js';
import { applyRollovers } from './timers.js';

const round2 = (x) => Math.round(x * 100) / 100;

// One bucket of stalled time: how much, how far back, and what to open.
// `oldest` is what the banner's click-through uses as the export range start,
// so the Export page opens on a window that actually contains the entries —
// no guessing, and nothing hidden behind a too-short default range.
function bucket(db, where, params) {
  const rows = db.prepare(`SELECT entries.id, entries.date, ${ENTRY_HOURS_SQL} AS hours
    FROM entries WHERE entries.deleted_at IS NULL AND ${where}
      AND ${ENTRY_HOURS_SQL} > 0
    ORDER BY entries.date, entries.id`).all(...params);
  return {
    count: rows.length,
    hours: round2(rows.reduce((a, r) => a + (Number(r.hours) || 0), 0)),
    oldest: rows.length ? rows[0].date : null,
    ids: rows.map((r) => r.id),
  };
}

export function dashboardRouter({ db, clock }) {
  const r = Router();

  r.get('/dashboard', (req, res) => {
    applyRollovers(db, clock);
    const today = todayLocal(clock());

    const todayEntries = db.prepare(
      'SELECT * FROM entries WHERE deleted_at IS NULL AND date = ? ORDER BY id DESC'
    ).all(today).map((row) => enrich(db, row));

    let total = 0;
    let billable = 0;
    for (const e of todayEntries) {
      total += e.total;
      if (e.billable) billable += e.total;
    }

    // Any draft with validation findings needs attention before finalizing —
    // except one whose timer is running right now (a start-created entry has
    // no narrative and 0.0h by definition; it alerts once the timer stops).
    const runningLinked = new Set(db.prepare(
      'SELECT linked_entry_id FROM timers WHERE running=1 AND linked_entry_id IS NOT NULL'
    ).all().map((x) => x.linked_entry_id));
    const draftRows = db.prepare(
      "SELECT * FROM entries WHERE deleted_at IS NULL AND status='draft' AND date <= ?"
    ).all(today).map((row) => enrich(db, row));
    const invalid = draftRows.filter((e) => e.validation.length > 0 && !runningLinked.has(e.id));

    // LEFT JOIN: unassigned quick timers ride along too (ghost row + footer)
    const timers = db.prepare(`SELECT timers.*, matters.cm_number, matters.short_name AS cm_short_name
      FROM timers LEFT JOIN matters ON matters.id = timers.cm_id ORDER BY timers.sort_order, timers.id`).all()
      .map((t) => ({ ...t, elapsed_seconds: elapsedSeconds(t, clock().getTime()) }));

    res.json({
      date: today,
      today: {
        total: round2(total),
        billable: round2(billable),
        nonbillable: round2(total - billable),
        target: (getSetting(db, 'targets') || {}).dailyHours ?? null,
        entryCount: todayEntries.length,
      },
      entries: todayEntries,
      timers,
      idleNudgeHours: getSetting(db, 'idleNudgeHours') ?? 3,
      alerts: {
        // Per-entry validation pills for PRIOR days only (windowed). Today's
        // drafts are just work in progress — an empty narrative or unassigned
        // matter is normal mid-day and does not earn a "needs attention" pill
        // until the day is over. Prior-day broken drafts stay actionable here,
        // one click to the entry that needs fixing.
        invalidDrafts: invalid
          .filter((e) => e.date < today && e.date >= addDays(today, -ATTENTION_WINDOW_DAYS))
          .map(alertShape),
        // Three ways time stalls on the way to the billing system. The buckets
        // are disjoint so the banner never counts one entry twice, and each
        // one links into the matching Export filter (see lib/attention.js).
        //
        // Never finalized, on a day that is already over — today's drafts are
        // just work in progress and are left alone. Windowed: an ancient stray
        // draft has stopped being a nudge.
        unfinalized: bucket(db,
          "entries.status='draft' AND entries.ever_finalized=0 AND entries.date < ? AND entries.date >= ?",
          [today, addDays(today, -ATTENTION_WINDOW_DAYS)]),
        // Finalized once and unlocked since — the leak that hides, because it
        // keeps the exported_at stamp it earned before the edit. Includes
        // today: this one already looked done, so it is never work in
        // progress.
        reverted: bucket(db,
          "entries.status='draft' AND entries.ever_finalized=1 AND entries.date >= ?",
          [addDays(today, -ATTENTION_WINDOW_DAYS)]),
        // Locked in but never sent. No window — unbilled finalized time is
        // unambiguous leakage at any age.
        unexported: bucket(db, "entries.status='finalized' AND entries.exported_at IS NULL", []),
        // (heldTimers retired 2026-07-13: matterless time lives in matterless
        // ENTRIES now, which surface through invalidDrafts and the unfinalized
        // bucket — and via their no_matter validation block.)
      },
    });
  });

  return r;
}

function alertShape(e) {
  return {
    id: e.id,
    date: e.date,
    cm_number: e.cm ? e.cm.cm_number : null,
    short_name: e.cm ? e.cm.short_name : null,
    codes: e.validation.map((v) => v.code),
  };
}
