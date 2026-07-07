import { Router } from 'express';
import { getSetting } from '../db.js';
import { isValidDate } from '../lib/dates.js';
import { buildNarrative } from '../lib/narrative.js';
import { validateEntry } from '../lib/validation.js';

const ENTRY_COLS = `id, date, cm_id, narrative, billable, status, total_override,
  source, ack_validation, ever_finalized, exported_at, finalized_at, deleted_at,
  created_at, updated_at`;

export function loadEntry(db, id) {
  const row = db.prepare(`SELECT ${ENTRY_COLS} FROM entries WHERE id=?`).get(id);
  if (!row) return null;
  return enrich(db, row);
}

export function enrich(db, row) {
  const tasks = db.prepare(
    'SELECT id, task_code, duration, fragment, sort_order FROM entry_tasks WHERE entry_id=? ORDER BY sort_order, id'
  ).all(row.id);
  const cm = db.prepare(
    'SELECT id, cm_number, short_name, billable, status, favorite FROM cms WHERE id=?'
  ).get(row.cm_id);
  const sum = tasks.reduce((a, t) => a + (Number(t.duration) || 0), 0);
  const total = row.total_override != null ? row.total_override : Math.round(sum * 10000) / 10000;
  const entry = { ...row, tasks, cm, total, narrative_auto: substantiveCount(tasks) >= 2 };
  entry.validation = validateEntry(entry, getSetting(db, 'validation'));
  return entry;
}

function substantiveCount(tasks) {
  return tasks.filter((t) => (t.fragment || '').trim() || (t.task_code || '').trim() || Number(t.duration) > 0).length;
}

function normalizeTasks(tasks) {
  if (!Array.isArray(tasks)) return { error: 'tasks must be an array.' };
  const out = [];
  for (const t of tasks) {
    const duration = Number(t.duration) || 0;
    if (duration < 0) return { error: 'Task durations must be ≥ 0.' };
    out.push({
      task_code: String(t.task_code || '').trim(),
      duration,
      fragment: String(t.fragment || ''),
    });
  }
  return { tasks: out };
}

export function writeTasks(db, entryId, tasks) {
  db.prepare('DELETE FROM entry_tasks WHERE entry_id=?').run(entryId);
  const ins = db.prepare(
    'INSERT INTO entry_tasks (entry_id, task_code, duration, fragment, sort_order) VALUES (?, ?, ?, ?, ?)');
  tasks.forEach((t, i) => ins.run(entryId, t.task_code, t.duration, t.fragment, i));
}

// Regenerate the stored narrative when the entry is multi-line.
export function syncNarrative(db, entryId) {
  const tasks = db.prepare(
    'SELECT task_code, duration, fragment FROM entry_tasks WHERE entry_id=? ORDER BY sort_order, id').all(entryId);
  const rounding = getSetting(db, 'rounding') || {};
  const generated = buildNarrative(tasks, { increment: rounding.increment });
  if (generated != null) {
    db.prepare('UPDATE entries SET narrative=? WHERE id=?').run(generated, entryId);
  }
}

export function touchCm(db, cmId, nowIso) {
  db.prepare('UPDATE cms SET last_used_at=? WHERE id=?').run(nowIso, cmId);
}

export function entriesRouter({ db, clock }) {
  const r = Router();
  const now = () => clock().toISOString();

  r.get('/', (req, res) => {
    const q = req.query;
    const where = [];
    const params = [];
    if (q.includeDeleted !== '1') where.push('deleted_at IS NULL');
    if (q.date) { where.push('date = ?'); params.push(q.date); }
    if (q.from) { where.push('date >= ?'); params.push(q.from); }
    if (q.to) { where.push('date <= ?'); params.push(q.to); }
    if (q.cm_id) { where.push('cm_id = ?'); params.push(q.cm_id); }
    if (q.billable === '0' || q.billable === '1') { where.push('billable = ?'); params.push(Number(q.billable)); }
    if (q.status) { where.push('status = ?'); params.push(q.status); }
    if (q.q) { where.push('narrative LIKE ?'); params.push(`%${q.q}%`); }
    if (q.task) {
      where.push('EXISTS (SELECT 1 FROM entry_tasks et WHERE et.entry_id = entries.id AND et.task_code = ?)');
      params.push(q.task);
    }
    const sql = `SELECT ${ENTRY_COLS} FROM entries
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY date DESC, id DESC LIMIT 1000`;
    res.json(db.prepare(sql).all(...params).map((row) => enrich(db, row)));
  });

  r.get('/:id', (req, res) => {
    const entry = loadEntry(db, req.params.id);
    if (!entry) return res.status(404).json({ error: 'Entry not found.' });
    res.json(entry);
  });

  r.post('/', (req, res) => {
    const b = req.body || {};
    if (!isValidDate(b.date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD.' });
    const cm = db.prepare('SELECT * FROM cms WHERE id=?').get(b.cm_id);
    if (!cm) return res.status(400).json({ error: 'Unknown CM.' });
    const norm = normalizeTasks(b.tasks || []);
    if (norm.error) return res.status(400).json({ error: norm.error });

    const billable = b.billable !== undefined ? (b.billable ? 1 : 0) : cm.billable;
    const totalOverride = b.total_override != null ? Number(b.total_override) : null;
    const info = db.transaction(() => {
      const i = db.prepare(`INSERT INTO entries
        (date, cm_id, narrative, billable, status, total_override, source, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?)`)
        .run(b.date, cm.id, String(b.narrative || ''), billable, totalOverride,
          b.source === 'timer' ? 'timer' : 'manual', now(), now());
      writeTasks(db, i.lastInsertRowid, norm.tasks);
      syncNarrative(db, i.lastInsertRowid);
      touchCm(db, cm.id, now());
      return i;
    })();
    res.status(201).json(loadEntry(db, info.lastInsertRowid));
  });

  r.patch('/:id', (req, res) => {
    const row = db.prepare(`SELECT ${ENTRY_COLS} FROM entries WHERE id=?`).get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Entry not found.' });
    if (row.status === 'finalized') {
      return res.status(409).json({ error: 'Entry is finalized — unlock it before editing.' });
    }
    const b = req.body || {};
    if (b.date !== undefined && !isValidDate(b.date)) {
      return res.status(400).json({ error: 'date must be YYYY-MM-DD.' });
    }
    let cmId = row.cm_id;
    if (b.cm_id !== undefined) {
      const cm = db.prepare('SELECT id FROM cms WHERE id=?').get(b.cm_id);
      if (!cm) return res.status(400).json({ error: 'Unknown CM.' });
      cmId = cm.id;
    }
    let norm = null;
    if (b.tasks !== undefined) {
      norm = normalizeTasks(b.tasks);
      if (norm.error) return res.status(400).json({ error: norm.error });
    }

    db.transaction(() => {
      db.prepare(`UPDATE entries SET
          date=?, cm_id=?, narrative=?, billable=?, total_override=?, ack_validation=?, updated_at=?
        WHERE id=?`).run(
        b.date ?? row.date,
        cmId,
        b.narrative !== undefined ? String(b.narrative) : row.narrative,
        b.billable !== undefined ? (b.billable ? 1 : 0) : row.billable,
        b.total_override !== undefined ? (b.total_override == null ? null : Number(b.total_override)) : row.total_override,
        b.ack_validation !== undefined ? (b.ack_validation ? 1 : 0) : row.ack_validation,
        now(), row.id);
      if (norm) writeTasks(db, row.id, norm.tasks);
      syncNarrative(db, row.id);
      if (cmId !== row.cm_id) touchCm(db, cmId, now());
      recordAudit(db, row, req.body, now());
    })();
    res.json(loadEntry(db, row.id));
  });

  r.delete('/:id', (req, res) => {
    const row = db.prepare('SELECT id, deleted_at FROM entries WHERE id=?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Entry not found.' });
    db.prepare('UPDATE entries SET deleted_at=?, updated_at=? WHERE id=?').run(now(), now(), row.id);
    res.json({ ok: true, id: row.id });
  });

  r.post('/:id/restore', (req, res) => {
    const row = db.prepare('SELECT id FROM entries WHERE id=?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Entry not found.' });
    db.prepare('UPDATE entries SET deleted_at=NULL, updated_at=? WHERE id=?').run(now(), row.id);
    res.json(loadEntry(db, row.id));
  });

  r.post('/:id/copy', (req, res) => {
    const src = loadEntry(db, req.params.id);
    if (!src) return res.status(404).json({ error: 'Entry not found.' });
    const date = (req.body || {}).date;
    if (!isValidDate(date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD.' });
    const info = db.transaction(() => {
      const i = db.prepare(`INSERT INTO entries
        (date, cm_id, narrative, billable, status, total_override, source, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'draft', ?, 'manual', ?, ?)`)
        .run(date, src.cm_id, src.narrative, src.billable, src.total_override, now(), now());
      writeTasks(db, i.lastInsertRowid, src.tasks);
      touchCm(db, src.cm_id, now());
      return i;
    })();
    res.status(201).json(loadEntry(db, info.lastInsertRowid));
  });

  return r;
}

// Audit trail for entries that have ever been finalized: record what changed.
function recordAudit(db, beforeRow, patch, nowIso) {
  if (!beforeRow.ever_finalized) return;
  const after = db.prepare(`SELECT ${ENTRY_COLS} FROM entries WHERE id=?`).get(beforeRow.id);
  const changes = {};
  for (const k of ['date', 'cm_id', 'narrative', 'billable', 'total_override']) {
    if (beforeRow[k] !== after[k]) changes[k] = [beforeRow[k], after[k]];
  }
  if (patch.tasks !== undefined) changes.tasks = 'replaced';
  if (Object.keys(changes).length === 0) return;
  db.prepare('INSERT INTO audit_log (entry_id, action, detail, created_at) VALUES (?, ?, ?, ?)')
    .run(beforeRow.id, 'edit', JSON.stringify(changes), nowIso);
}
