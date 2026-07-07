import { Router } from 'express';
import { getSetting } from '../db.js';
import { isValidDate } from '../lib/dates.js';
import { toCsv } from '../lib/csv.js';
import { durationLabel } from '../lib/narrative.js';
import { enrich } from './entries.js';

export const CSV_HEADER = [
  'date', 'cm_number', 'cm_short_name', 'billable', 'task', 'duration',
  'narrative', 'entry_total', 'entry_id',
];

export function buildExport(db, { from, to, includeDrafts = false }) {
  const rows = db.prepare(`
    SELECT * FROM entries
    WHERE deleted_at IS NULL AND date >= ? AND date <= ?
      ${includeDrafts ? '' : "AND status='finalized'"}
    ORDER BY date, cm_id, id
  `).all(from, to);
  const entries = rows.map((r) => enrich(db, r));
  const increment = (getSetting(db, 'rounding') || {}).increment || 0.1;

  const csvRows = [];
  for (const e of entries) {
    const billable = e.billable ? 'billable' : 'non-billable';
    const lines = e.tasks.length > 0
      ? e.tasks
      : [{ task_code: '', duration: e.total }];
    for (const t of lines) {
      csvRows.push([
        e.date, e.cm.cm_number, e.cm.short_name, billable,
        t.task_code, durationLabel(t.duration, increment),
        e.narrative, durationLabel(e.total, increment), e.id,
      ]);
    }
  }

  const text = entries.map((e) => {
    const head = `${e.date} — ${e.cm.cm_number} ${e.cm.short_name} [${e.billable ? 'billable' : 'non-billable'}] — ${durationLabel(e.total, increment)}h${e.status === 'draft' ? ' (DRAFT)' : ''}`;
    return `${head}\n  ${e.narrative || '(no narrative)'}`;
  }).join('\n\n');

  return {
    count: entries.length,
    entry_ids: entries.map((e) => e.id),
    entries,
    csv: toCsv(CSV_HEADER, csvRows),
    text,
  };
}

export function exportRouter({ db, clock }) {
  const r = Router();

  const validRange = (q) => isValidDate(q.from) && isValidDate(q.to);

  r.post('/export', (req, res) => {
    const b = req.body || {};
    if (!validRange(b)) return res.status(400).json({ error: 'from/to must be YYYY-MM-DD.' });
    const result = buildExport(db, { from: b.from, to: b.to, includeDrafts: !!b.includeDrafts });
    if (b.markExported !== false && result.entry_ids.length > 0) {
      const stamp = clock().toISOString();
      const upd = db.prepare('UPDATE entries SET exported_at=? WHERE id=?');
      db.transaction(() => result.entry_ids.forEach((id) => upd.run(stamp, id)))();
    }
    const { entries, ...out } = result;
    res.json(out);
  });

  r.get('/export/preview', (req, res) => {
    const q = req.query;
    if (!validRange(q)) return res.status(400).json({ error: 'from/to must be YYYY-MM-DD.' });
    const { csv, ...out } = buildExport(db, {
      from: q.from, to: q.to, includeDrafts: q.includeDrafts === '1' || q.includeDrafts === 'true',
    });
    res.json(out);
  });

  return r;
}
