import { Router } from 'express';
import { isValidDate } from '../lib/dates.js';
import { enrich } from './entries.js';

const round2 = (x) => Math.round(x * 100) / 100;

export function statsRouter({ db }) {
  const r = Router();

  r.get('/stats', (req, res) => {
    const { from, to } = req.query;
    if (!isValidDate(from) || !isValidDate(to)) {
      return res.status(400).json({ error: 'from/to must be YYYY-MM-DD.' });
    }
    const entries = db.prepare(
      'SELECT * FROM entries WHERE deleted_at IS NULL AND date >= ? AND date <= ? ORDER BY date'
    ).all(from, to).map((row) => enrich(db, row));

    const byCm = new Map();
    const byTask = new Map();
    const byDay = new Map();
    let total = 0;
    let billable = 0;

    for (const e of entries) {
      total += e.total;
      if (e.billable) billable += e.total;

      // matterless (quick-timer) entries bucket together until associated
      const cmKey = e.cm ? e.cm.id : null;
      if (!byCm.has(cmKey)) {
        byCm.set(cmKey, {
          cm_id: cmKey,
          cm_number: e.cm ? e.cm.cm_number : null,
          short_name: e.cm ? e.cm.short_name : 'No matter yet',
          hours: 0, billableHours: 0, entries: 0,
        });
      }
      const c = byCm.get(cmKey);
      c.hours = round2(c.hours + e.total);
      if (e.billable) c.billableHours = round2(c.billableHours + e.total);
      c.entries += 1;

      if (!byDay.has(e.date)) byDay.set(e.date, { date: e.date, hours: 0, billableHours: 0 });
      const d = byDay.get(e.date);
      d.hours = round2(d.hours + e.total);
      if (e.billable) d.billableHours = round2(d.billableHours + e.total);

      for (const t of e.tasks) {
        const key = t.task_code || '(none)';
        if (!byTask.has(key)) byTask.set(key, { task: key, hours: 0 });
        byTask.get(key).hours = round2(byTask.get(key).hours + (Number(t.duration) || 0));
      }
    }

    res.json({
      from, to,
      totalHours: round2(total),
      billableHours: round2(billable),
      billableRatio: total > 0 ? billable / total : 0,
      byCm: [...byCm.values()].sort((a, b) => b.hours - a.hours),
      byTask: [...byTask.values()].sort((a, b) => b.hours - a.hours),
      byDay: [...byDay.values()],
    });
  });

  return r;
}
