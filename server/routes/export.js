import { Router } from 'express';
import { getSetting } from '../db.js';
import { isValidDate } from '../lib/dates.js';
import { toCsv } from '../lib/csv.js';
import { durationLabel } from '../lib/narrative.js';
import { formatTimEntries } from '../lib/tim.js';
import { enrich } from './entries.js';

export const CSV_HEADER = [
  'date', 'cm_number', 'cm_short_name', 'billable', 'task', 'duration',
  'narrative', 'entry_total', 'entry_id',
];

export function buildExport(db, { from, to, includeDrafts = false }) {
  // Matterless entries are never exportable — there is nothing to key them
  // under in the billing system. They can only be drafts (finalize blocks on
  // no_matter), so this bites only in includeDrafts previews; the count is
  // returned so the UI can say what was left out.
  const rows = db.prepare(`
    SELECT * FROM entries
    WHERE deleted_at IS NULL AND date >= ? AND date <= ? AND cm_id IS NOT NULL
      ${includeDrafts ? '' : "AND status='finalized'"}
    ORDER BY date, cm_id, id
  `).all(from, to);
  const unassociated = db.prepare(`
    SELECT COUNT(*) c FROM entries
    WHERE deleted_at IS NULL AND date >= ? AND date <= ? AND cm_id IS NULL
  `).get(from, to).c;
  const entries = rows.map((r) => enrich(db, r));
  const increment = (getSetting(db, 'rounding') || {}).increment || 0.1;

  // Custom-field columns (2026-07-15): one per distinct effective-field name
  // across the exported entries, "field:"-prefixed so a custom field named
  // "task" can never collide with the fixed task column. Alphabetical for a
  // stable layout; blank where a field doesn't apply to that entry's matter.
  const fieldNames = [...new Set(entries.flatMap((e) => (e.custom_fields || []).map((f) => f.name)))]
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  const header = [...CSV_HEADER, ...fieldNames.map((n) => `field:${n}`)];

  const csvRows = [];
  for (const e of entries) {
    const billable = e.billable ? 'billable' : 'non-billable';
    const custom = fieldNames.map((n) => {
      const f = (e.custom_fields || []).find((x) => x.name === n);
      return f ? (e.custom_values?.[f.id] ?? '') : '';
    });
    const lines = e.tasks.length > 0
      ? e.tasks
      : [{ task_code: '', duration: e.total }];
    for (const t of lines) {
      // Durations go out as stored numbers — display rounding must never
      // change what the billing system receives.
      csvRows.push([
        e.date, e.cm.cm_number, e.cm.short_name, billable,
        t.task_code, Number(t.duration) || 0,
        e.narrative, Number(e.total) || 0, e.id,
        ...custom,
      ]);
    }
  }

  const text = entries.map((e) => {
    const head = `${e.date} — ${e.cm.cm_number} ${e.cm.short_name} [${e.billable ? 'billable' : 'non-billable'}] — ${durationLabel(e.total, increment)}h${e.status === 'draft' ? ' (DRAFT)' : ''}`;
    return `${head}\n  ${e.narrative || '(no narrative)'}`;
  }).join('\n\n');

  return {
    count: entries.length,
    unassociated,
    entry_ids: entries.map((e) => e.id),
    entries,
    csv: toCsv(header, csvRows),
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
      // Only finalized entries are "sent to the assistant" — a draft included
      // for preview must still alert as unexported once finalized.
      const upd = db.prepare("UPDATE entries SET exported_at=? WHERE id=? AND status='finalized'");
      db.transaction(() => result.entry_ids.forEach((id) => upd.run(stamp, id)))();
    }
    const { entries, ...out } = result;
    out.tim = formatTimEntries(entries, getSetting(db, 'tim') || {}, { now: clock().toISOString() });
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
