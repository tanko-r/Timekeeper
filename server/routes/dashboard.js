import { Router } from 'express';
import { getSetting } from '../db.js';
import { todayLocal } from '../lib/dates.js';
import { elapsedSeconds } from '../lib/timerlogic.js';
import { enrich } from './entries.js';
import { applyRollovers } from './timers.js';

const round2 = (x) => Math.round(x * 100) / 100;

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

    // Any draft with validation findings needs attention before finalizing.
    const draftRows = db.prepare(
      "SELECT * FROM entries WHERE deleted_at IS NULL AND status='draft' AND date <= ?"
    ).all(today).map((row) => enrich(db, row));
    const invalid = draftRows.filter((e) => e.validation.length > 0);

    const timers = db.prepare(`SELECT timers.*, matters.cm_number, matters.short_name AS cm_short_name
      FROM timers JOIN matters ON matters.id = timers.cm_id ORDER BY timers.sort_order, timers.id`).all()
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
        invalidDrafts: invalid.filter((e) => e.date === today).map(alertShape),
        backlog: invalid.filter((e) => e.date < today).map(alertShape),
        backlogCount: invalid.filter((e) => e.date < today).length,
        unexportedFinalized: db.prepare(
          "SELECT COUNT(*) c FROM entries WHERE deleted_at IS NULL AND status='finalized' AND exported_at IS NULL"
        ).get().c,
      },
    });
  });

  return r;
}

function alertShape(e) {
  return {
    id: e.id,
    date: e.date,
    cm_number: e.cm.cm_number,
    short_name: e.cm.short_name,
    codes: e.validation.map((v) => v.code),
  };
}
