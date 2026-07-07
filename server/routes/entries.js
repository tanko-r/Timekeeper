import { Router } from 'express';
import { getSetting } from '../db.js';
import { isValidDate } from '../lib/dates.js';
import { buildNarrative } from '../lib/narrative.js';
import { validateEntry, canFinalize } from '../lib/validation.js';

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

  r.post('/bulk', (req, res) => {
    const { ids, action, cm_id, ack } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'ids array required.' });
    }
    const done = [];
    const failed = [];
    for (const id of ids) {
      const row = db.prepare(`SELECT ${ENTRY_COLS} FROM entries WHERE id=?`).get(id);
      if (!row) { failed.push({ id, error: 'not found' }); continue; }
      try {
        switch (action) {
          case 'finalize': {
            const result = finalizeOne(db, id, !!ack, now());
            if (result.ok) done.push(id);
            else failed.push({ id, blocks: result.blocks, warns: result.warns });
            break;
          }
          case 'unlock':
            unlockOne(db, row, now());
            done.push(id);
            break;
          case 'delete':
            db.prepare('UPDATE entries SET deleted_at=?, updated_at=? WHERE id=?').run(now(), now(), id);
            done.push(id);
            break;
          case 'restore':
            db.prepare('UPDATE entries SET deleted_at=NULL, updated_at=? WHERE id=?').run(now(), id);
            done.push(id);
            break;
          case 'set_cm': {
            if (row.status === 'finalized') { failed.push({ id, error: 'finalized' }); break; }
            const cm = db.prepare('SELECT id FROM cms WHERE id=?').get(cm_id);
            if (!cm) return res.status(400).json({ error: 'Unknown CM.' });
            db.transaction(() => {
              db.prepare('UPDATE entries SET cm_id=?, updated_at=? WHERE id=?').run(cm.id, now(), id);
              touchCm(db, cm.id, now());
              recordAudit(db, row, { cm_id: cm.id }, now());
            })();
            done.push(id);
            break;
          }
          default:
            return res.status(400).json({ error: `Unknown bulk action "${action}".` });
        }
      } catch (e) {
        failed.push({ id, error: String(e.message) });
      }
    }
    res.json({ done, failed });
  });

  r.get('/:id', (req, res) => {
    const entry = loadEntry(db, req.params.id);
    if (!entry) return res.status(404).json({ error: 'Entry not found.' });
    res.json(entry);
  });

  r.post('/:id/finalize', (req, res) => {
    const row = db.prepare('SELECT id, deleted_at FROM entries WHERE id=?').get(req.params.id);
    if (!row || row.deleted_at) return res.status(404).json({ error: 'Entry not found.' });
    const result = finalizeOne(db, row.id, !!(req.body || {}).ack, now());
    if (!result.ok) {
      return res.status(422).json({ error: 'Entry cannot be finalized yet.', blocks: result.blocks, warns: result.warns });
    }
    res.json(loadEntry(db, row.id));
  });

  r.post('/:id/unlock', (req, res) => {
    const row = db.prepare(`SELECT ${ENTRY_COLS} FROM entries WHERE id=?`).get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Entry not found.' });
    if (row.status !== 'finalized') return res.status(409).json({ error: 'Entry is not finalized.' });
    unlockOne(db, row, now());
    res.json(loadEntry(db, row.id));
  });

  r.get('/:id/audit', (req, res) => {
    const rows = db.prepare(
      'SELECT id, action, detail, created_at FROM audit_log WHERE entry_id=? ORDER BY id DESC'
    ).all(req.params.id);
    res.json(rows.map((a) => ({ ...a, detail: JSON.parse(a.detail) })));
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

export function finalizeOne(db, id, ack, nowIso) {
  const entry = loadEntry(db, id);
  if (!entry) return { ok: false, blocks: [{ code: 'not_found', message: 'Entry not found.' }], warns: [] };
  if (entry.status === 'finalized') return { ok: true };
  if (ack && !entry.ack_validation) {
    db.prepare('UPDATE entries SET ack_validation=1 WHERE id=?').run(id);
    entry.ack_validation = 1;
  }
  const gate = canFinalize(entry, getSetting(db, 'validation'));
  if (!gate.ok) return { ok: false, blocks: gate.blocks, warns: gate.warns };
  db.prepare(
    "UPDATE entries SET status='finalized', finalized_at=?, ever_finalized=1, updated_at=? WHERE id=?"
  ).run(nowIso, nowIso, id);
  return { ok: true };
}

function unlockOne(db, row, nowIso) {
  db.transaction(() => {
    db.prepare("UPDATE entries SET status='draft', updated_at=? WHERE id=?").run(nowIso, row.id);
    db.prepare('INSERT INTO audit_log (entry_id, action, detail, created_at) VALUES (?, ?, ?, ?)')
      .run(row.id, 'unlock', JSON.stringify({ was_finalized_at: row.finalized_at }), nowIso);
  })();
}

// POST /api/finalize-day {date | from,to, ack?}
export function finalizeDayRouter({ db, clock }) {
  const r = Router();
  r.post('/finalize-day', (req, res) => {
    const b = req.body || {};
    const from = b.from || b.date;
    const to = b.to || b.date;
    if (!isValidDate(from) || !isValidDate(to)) {
      return res.status(400).json({ error: 'Provide date or from/to as YYYY-MM-DD.' });
    }
    const drafts = db.prepare(
      "SELECT id FROM entries WHERE status='draft' AND deleted_at IS NULL AND date >= ? AND date <= ?"
    ).all(from, to);
    const finalized = [];
    const blocked = [];
    for (const { id } of drafts) {
      const result = finalizeOne(db, id, !!b.ack, clock().toISOString());
      if (result.ok) finalized.push(id);
      else blocked.push({ id, blocks: result.blocks, warns: result.warns });
    }
    res.json({ finalized, blocked });
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
