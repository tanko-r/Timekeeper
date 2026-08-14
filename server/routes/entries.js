import { Router } from 'express';
import { getSetting } from '../db.js';
import { isValidDate, todayLocal } from '../lib/dates.js';
import { buildNarrative } from '../lib/narrative.js';
import { validateEntry, canFinalize } from '../lib/validation.js';
import { extractPeople } from '../lib/people.js';
import { loadEffectiveFields } from './customfields.js';

const ENTRY_COLS = `id, date, cm_id, narrative, billable, status, total_override,
  source, ack_validation, ever_finalized, exported_at, finalized_at, deleted_at,
  narrative_manual, narrative_ai, ai_brief, ai_draft, created_at, updated_at`;

export function loadEntry(db, id) {
  const row = db.prepare(`SELECT ${ENTRY_COLS} FROM entries WHERE id=?`).get(id);
  if (!row) return null;
  return enrich(db, row);
}

export function enrich(db, row) {
  const tasks = db.prepare(
    'SELECT id, task_code, duration, fragment, sort_order FROM entry_tasks WHERE entry_id=? ORDER BY sort_order, id'
  ).all(row.id);
  const cm = db.prepare(`
    SELECT matters.id, matters.cm_number, matters.short_name, matters.billable,
      matters.status, matters.favorite,
      clients.name AS client_name, COALESCE(clients.task_billing, 1) AS client_task_billing
    FROM matters LEFT JOIN clients ON clients.id = matters.client_id
    WHERE matters.id=?
  `).get(row.cm_id);
  const sum = tasks.reduce((a, t) => a + (Number(t.duration) || 0), 0);
  const total = row.total_override != null ? row.total_override : Math.round(sum * 10000) / 10000;
  const customFields = loadEffectiveFields(db, row.cm_id);
  const customValues = {};
  for (const v of db.prepare('SELECT field_id, value FROM entry_custom_values WHERE entry_id=?').all(row.id)) {
    customValues[v.field_id] = v.value;
  }
  const entry = {
    // cm is null (not undefined) for a matterless entry so it survives JSON
    ...row, tasks, cm: cm || null, total,
    custom_fields: customFields, custom_values: customValues,
    narrative_auto: substantiveCount(tasks) >= 2 && !row.narrative_manual,
  };
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

// custom_values request shape: { [field_id]: value }. Keys that don't apply
// to the entry's matter (matter changed underneath an autosave, field
// deactivated) are SKIPPED, not errors — the editor keeps whatever keys it
// has in flight. Empty string deletes the stored value.
export function normalizeCustomValues(db, matterId, values) {
  if (values === undefined) return { ops: null };
  if (values === null || typeof values !== 'object' || Array.isArray(values)) {
    return { error: 'custom_values must be an object of { field_id: value }.' };
  }
  const effective = new Set(loadEffectiveFields(db, matterId).map((f) => f.id));
  const ops = [];
  for (const [k, raw] of Object.entries(values)) {
    const fieldId = Number(k);
    if (!Number.isInteger(fieldId) || !effective.has(fieldId)) continue;
    ops.push({ fieldId, value: String(raw ?? '').trim() });
  }
  return { ops };
}

export function applyCustomValues(db, entryId, ops) {
  if (!ops) return;
  const del = db.prepare('DELETE FROM entry_custom_values WHERE entry_id=? AND field_id=?');
  const up = db.prepare(`INSERT INTO entry_custom_values (entry_id, field_id, value) VALUES (?, ?, ?)
    ON CONFLICT(entry_id, field_id) DO UPDATE SET value=excluded.value`);
  for (const o of ops) {
    if (o.value === '') del.run(entryId, o.fieldId);
    else up.run(entryId, o.fieldId, o.value);
  }
}

// Regenerate the stored narrative when the entry is multi-line. Consolidation
// format follows the entry's matter → client task_billing flag (LEFT JOIN;
// a matter with no linked client defaults to task-billed, same as loadEntry's
// cm payload). Skipped entirely when the entry's narrative has been detached
// from its task lines (narrative_manual=1) — that's the durability contract:
// once the user has typed over the AUTO box past the point it parses back,
// task-touching saves must not silently revert the manual text.
export function syncNarrative(db, entryId) {
  const tasks = db.prepare(
    'SELECT task_code, duration, fragment FROM entry_tasks WHERE entry_id=? ORDER BY sort_order, id').all(entryId);
  const rounding = getSetting(db, 'rounding') || {};
  const client = db.prepare(`
    SELECT COALESCE(clients.task_billing, 1) AS task_billing,
      entries.narrative_manual AS narrative_manual, entries.narrative AS narrative
    FROM entries
    LEFT JOIN matters ON matters.id = entries.cm_id
    LEFT JOIN clients ON clients.id = matters.client_id
    WHERE entries.id = ?
  `).get(entryId);
  // An EMPTY narrative is never a manual narrative worth protecting. Clearing
  // the AUTO box detaches it (narrative_manual=1) with nothing left to keep,
  // and the entry would then sit blank forever with fully written task lines
  // right above it — no way back short of toggling AUTO (2026-08-14 feedback:
  // "task filling doesn't seem to be working here").
  if (client && client.narrative_manual && String(client.narrative || '').trim()) return;
  const taskBilling = !client || !!client.task_billing;
  const generated = buildNarrative(tasks, { increment: rounding.increment, taskBilling });
  if (generated != null) {
    // Clear the detach flag alongside the refill, or the entry would keep a
    // regenerated narrative that no longer tracks its task lines, and reopen
    // with AUTO showing off over text AUTO itself just wrote.
    db.prepare('UPDATE entries SET narrative=?, narrative_manual=0 WHERE id=?').run(generated, entryId);
  }
}

// The entry's hours as the app computes them: an explicit override, else the
// sum of its task lines (same rule as enrich()).
function effectiveTotal(db, entryId) {
  const row = db.prepare('SELECT total_override FROM entries WHERE id=?').get(entryId);
  if (!row) return null;
  if (row.total_override != null) return row.total_override;
  const sum = db.prepare(
    'SELECT COALESCE(SUM(duration), 0) s FROM entry_tasks WHERE entry_id=?').get(entryId).s;
  return Math.round(sum * 10000) / 10000;
}

// Reverse of syncToEntry (routes/timers.js): push an EDITED entry total back
// onto the day clock of whatever timer feeds it (2026-07-24 feedback — "I
// edited the time on the entry card; the timer should update along with it").
// Without this the clock keeps the old number and the next stop, which
// OVERWRITES the entry's total with the whole clock, silently undoes the edit.
// A running timer keeps running: the clock is re-based to the new total and
// counts up from now. Callers must only invoke this when the total actually
// changed — the editor resends total_override on every autosave, and re-basing
// a running clock on a narrative keystroke would throw away live time.
export function syncTimersToEntry(db, entryId, nowIso, todayStr) {
  const e = db.prepare('SELECT date, status, deleted_at FROM entries WHERE id=?').get(entryId);
  // only today's live draft is a timer's home — a moved, finalized, or deleted
  // entry has already parted ways with the clock
  if (!e || e.deleted_at || e.status !== 'draft' || e.date !== todayStr) return [];
  const seconds = Math.max(0, Math.round(effectiveTotal(db, entryId) * 3600));
  const timers = db.prepare('SELECT id, running FROM timers WHERE linked_entry_id=?').all(entryId);
  const upd = db.prepare('UPDATE timers SET accumulated_seconds=?, last_started_at=? WHERE id=?');
  for (const t of timers) upd.run(seconds, t.running ? nowIso : null, t.id);
  return timers.map((t) => t.id);
}

export function touchCm(db, cmId, nowIso) {
  db.prepare('UPDATE matters SET last_used_at=? WHERE id=?').run(nowIso, cmId);
}

// matter_people is a DERIVED CACHE: rebuild the whole roster for one matter
// from its live (non-deleted) entries. Idempotent — safe to call on every
// write, edit, move, copy, delete, and restore; a per-matter scan is cheap in
// a single-user DB and makes edits exactly correct with zero bookkeeping.
// Names come from the narrative plus all task fragments, deduped per entry,
// so count = number of live entries mentioning the person. last_seen_at
// stores the entry DATE (local YYYY-MM-DD), not a wall clock, so backfilled
// history ranks correctly by recency. Safe inside an outer db.transaction
// (better-sqlite3 nests transactions via savepoints).
export function rebuildMatterPeople(db, matterId) {
  const rows = db.prepare(`
    SELECT e.date, e.narrative,
      (SELECT group_concat(t.fragment, char(10)) FROM entry_tasks t WHERE t.entry_id = e.id) AS fragments
    FROM entries e WHERE e.cm_id = ? AND e.deleted_at IS NULL
  `).all(matterId);
  const agg = new Map(); // lower-cased name → { name, count, last }
  for (const row of rows) {
    for (const name of extractPeople(`${row.narrative}\n${row.fragments || ''}`)) {
      const key = name.toLowerCase();
      const cur = agg.get(key);
      if (!cur) {
        agg.set(key, { name, count: 1, last: row.date });
      } else {
        cur.count += 1;
        if (row.date >= cur.last) { cur.last = row.date; cur.name = name; }
      }
    }
  }
  db.transaction(() => {
    db.prepare('DELETE FROM matter_people WHERE matter_id=?').run(matterId);
    const ins = db.prepare(
      'INSERT INTO matter_people (matter_id, name, count, last_seen_at) VALUES (?, ?, ?, ?)');
    for (const p of agg.values()) ins.run(matterId, p.name, p.count, p.last);
  })();
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
    if (!['finalize', 'unlock', 'delete', 'restore', 'set_cm'].includes(action)) {
      return res.status(400).json({ error: `Unknown bulk action "${action}".` });
    }
    if (action === 'set_cm' && !db.prepare('SELECT id FROM matters WHERE id=?').get(cm_id)) {
      return res.status(400).json({ error: 'Unknown CM.' });
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
            if (row.status !== 'finalized') { failed.push({ id, error: 'not finalized' }); break; }
            unlockOne(db, row, now());
            done.push(id);
            break;
          case 'delete':
            if (row.status === 'finalized') { failed.push({ id, error: 'finalized — unlock first' }); break; }
            softDeleteEntry(db, row, now());
            done.push(id);
            break;
          case 'restore':
            restoreEntry(db, row, now());
            done.push(id);
            break;
          case 'set_cm': {
            if (row.status === 'finalized') { failed.push({ id, error: 'finalized' }); break; }
            db.transaction(() => {
              db.prepare('UPDATE entries SET cm_id=?, updated_at=? WHERE id=?').run(cm_id, now(), id);
              touchCm(db, cm_id, now());
              // same association glue as PATCH: a matterless timer follows
              if (row.cm_id == null) {
                db.prepare('UPDATE timers SET cm_id=?, suggested_narrative=NULL WHERE linked_entry_id=? AND cm_id IS NULL')
                  .run(cm_id, id);
              }
              recordAudit(db, row, { cm_id }, now());
              rebuildMatterPeople(db, cm_id);
              if (cm_id !== row.cm_id) rebuildMatterPeople(db, row.cm_id);
            })();
            done.push(id);
            break;
          }
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
    const cm = db.prepare('SELECT * FROM matters WHERE id=?').get(b.cm_id);
    if (!cm) return res.status(400).json({ error: 'Unknown CM.' });
    const norm = normalizeTasks(b.tasks || []);
    if (norm.error) return res.status(400).json({ error: norm.error });
    const cv = normalizeCustomValues(db, cm.id, b.custom_values);
    if (cv.error) return res.status(400).json({ error: cv.error });

    const billable = b.billable !== undefined ? (b.billable ? 1 : 0) : cm.billable;
    const totalOverride = b.total_override != null ? Number(b.total_override) : null;
    const narrativeManual = b.narrative_manual ? 1 : 0;
    // AI provenance (spec 2026-08-01 §5): narrative_ai=1 marks text the model
    // wrote and the attorney accepted untouched, keeping it out of the
    // exemplar and few-shot pools. ai_brief is the shorthand behind it, so a
    // later correction yields a labelled (brief → corrected narrative) pair.
    const narrativeAi = b.narrative_ai ? 1 : 0;
    const aiBrief = b.ai_brief != null && String(b.ai_brief).trim()
      ? String(b.ai_brief).trim().slice(0, 500) : null;
    // What the model actually wrote, kept whatever David does to it next.
    const aiDraft = b.ai_draft != null && String(b.ai_draft).trim()
      ? String(b.ai_draft).trim().slice(0, 2000) : null;
    const info = db.transaction(() => {
      const i = db.prepare(`INSERT INTO entries
        (date, cm_id, narrative, billable, status, total_override, source, narrative_manual, narrative_ai, ai_brief, ai_draft, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(b.date, cm.id, String(b.narrative || ''), billable, totalOverride,
          b.source === 'timer' ? 'timer' : 'manual', narrativeManual,
          narrativeAi, aiBrief, aiDraft, now(), now());
      writeTasks(db, i.lastInsertRowid, norm.tasks);
      applyCustomValues(db, i.lastInsertRowid, cv.ops);
      syncNarrative(db, i.lastInsertRowid);
      touchCm(db, cm.id, now());
      rebuildMatterPeople(db, cm.id);
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
      const cm = db.prepare('SELECT id FROM matters WHERE id=?').get(b.cm_id);
      if (!cm) return res.status(400).json({ error: 'Unknown CM.' });
      cmId = cm.id;
    }
    let norm = null;
    if (b.tasks !== undefined) {
      norm = normalizeTasks(b.tasks);
      if (norm.error) return res.status(400).json({ error: norm.error });
    }
    const cv = normalizeCustomValues(db, cmId, b.custom_values);
    if (cv.error) return res.status(400).json({ error: cv.error });

    const beforeTotal = effectiveTotal(db, row.id);
    // Server-authoritative provenance: any narrative text that differs from
    // what is stored is a correction, so the entry becomes the attorney's own
    // and joins the exemplar pool. An explicit narrative_ai in the payload
    // wins — that is the client saying "this new text IS the AI output I just
    // accepted". An autosave replaying identical text changes nothing.
    const nextNarrative = b.narrative !== undefined ? String(b.narrative) : row.narrative;
    let narrativeAi = row.narrative_ai;
    if (b.narrative_ai !== undefined) narrativeAi = b.narrative_ai ? 1 : 0;
    else if (b.narrative !== undefined && nextNarrative !== row.narrative) narrativeAi = 0;
    const aiBrief = b.ai_brief !== undefined
      ? (String(b.ai_brief).trim() ? String(b.ai_brief).trim().slice(0, 500) : null)
      : row.ai_brief;
    // ai_draft is deliberately NOT cleared by an edit — preserving what the
    // model got wrong is the entire point. Only a fresh generation replaces it.
    const aiDraft = b.ai_draft !== undefined && String(b.ai_draft || '').trim()
      ? String(b.ai_draft).trim().slice(0, 2000)
      : row.ai_draft;
    let timersSynced = [];
    db.transaction(() => {
      db.prepare(`UPDATE entries SET
          date=?, cm_id=?, narrative=?, billable=?, total_override=?, ack_validation=?, narrative_manual=?, narrative_ai=?, ai_brief=?, ai_draft=?, updated_at=?
        WHERE id=?`).run(
        b.date ?? row.date,
        cmId,
        nextNarrative,
        b.billable !== undefined ? (b.billable ? 1 : 0) : row.billable,
        b.total_override !== undefined ? (b.total_override == null ? null : Number(b.total_override)) : row.total_override,
        b.ack_validation !== undefined ? (b.ack_validation ? 1 : 0) : row.ack_validation,
        b.narrative_manual !== undefined ? (b.narrative_manual ? 1 : 0) : row.narrative_manual,
        narrativeAi, aiBrief, aiDraft,
        now(), row.id);
      if (norm) writeTasks(db, row.id, norm.tasks);
      applyCustomValues(db, row.id, cv.ops);
      syncNarrative(db, row.id);
      if (cmId !== row.cm_id) touchCm(db, cmId, now());
      // Association glue (2026-07-13): a matterless timer feeding this entry
      // follows the entry's new matter, so the link — and the no-relink,
      // no-double-file guarantee — survives the association.
      if (row.cm_id == null && cmId != null) {
        db.prepare('UPDATE timers SET cm_id=?, suggested_narrative=NULL WHERE linked_entry_id=? AND cm_id IS NULL')
          .run(cmId, row.id);
      }
      // The hours changed → the timer feeding this entry follows them.
      if (Math.abs(effectiveTotal(db, row.id) - beforeTotal) > 1e-9) {
        timersSynced = syncTimersToEntry(db, row.id, now(), todayLocal(clock()));
      }
      recordAudit(db, row, req.body, now());
      rebuildMatterPeople(db, cmId);
      if (cmId !== row.cm_id) rebuildMatterPeople(db, row.cm_id);
    })();
    // timers_synced tells the client to refresh the timer surfaces too — an
    // entry write otherwise only announces tk:entries-changed (see api.js).
    res.json({ ...loadEntry(db, row.id), timers_synced: timersSynced });
  });

  r.delete('/:id', (req, res) => {
    const row = db.prepare(`SELECT ${ENTRY_COLS} FROM entries WHERE id=?`).get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Entry not found.' });
    if (row.status === 'finalized') {
      return res.status(409).json({ error: 'Entry is finalized — unlock it before deleting.' });
    }
    softDeleteEntry(db, row, now());
    res.json({ ok: true, id: row.id });
  });

  r.post('/:id/restore', (req, res) => {
    const row = db.prepare(`SELECT ${ENTRY_COLS} FROM entries WHERE id=?`).get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Entry not found.' });
    restoreEntry(db, row, now());
    res.json(loadEntry(db, row.id));
  });

  r.post('/:id/copy', (req, res) => {
    const src = loadEntry(db, req.params.id);
    if (!src) return res.status(404).json({ error: 'Entry not found.' });
    const date = (req.body || {}).date;
    if (!isValidDate(date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD.' });
    const info = db.transaction(() => {
      const i = db.prepare(`INSERT INTO entries
        (date, cm_id, narrative, billable, status, total_override, source, narrative_manual, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'draft', ?, 'manual', ?, ?, ?)`)
        .run(date, src.cm_id, src.narrative, src.billable, src.total_override,
          src.narrative_manual ? 1 : 0, now(), now());
      writeTasks(db, i.lastInsertRowid, src.tasks);
      db.prepare(`INSERT INTO entry_custom_values (entry_id, field_id, value)
        SELECT ?, field_id, value FROM entry_custom_values WHERE entry_id=?`)
        .run(i.lastInsertRowid, src.id);
      touchCm(db, src.cm_id, now());
      rebuildMatterPeople(db, src.cm_id);
      return i;
    })();
    res.status(201).json(loadEntry(db, info.lastInsertRowid));
  });

  return r;
}

export function finalizeOne(db, id, ack, nowIso) {
  const entry = loadEntry(db, id);
  if (!entry || entry.deleted_at) {
    return { ok: false, blocks: [{ level: 'block', code: 'not_found', message: 'Entry not found.' }], warns: [] };
  }
  if (entry.status === 'finalized') return { ok: true };
  // Evaluate the gate with the ack applied hypothetically; persist it only on
  // success so a blocked attempt doesn't pre-acknowledge future warnings.
  const gate = canFinalize(
    { ...entry, ack_validation: ack ? 1 : entry.ack_validation },
    getSetting(db, 'validation'));
  if (!gate.ok) return { ok: false, blocks: gate.blocks, warns: gate.warns };
  db.transaction(() => {
    if (ack && !entry.ack_validation) {
      db.prepare('UPDATE entries SET ack_validation=1 WHERE id=?').run(id);
    }
    // A fresh finalization has not been exported yet — clearing the stamp makes
    // corrected entries resurface in the unexported alert.
    db.prepare(
      "UPDATE entries SET status='finalized', finalized_at=?, ever_finalized=1, exported_at=NULL, updated_at=? WHERE id=?"
    ).run(nowIso, nowIso, id);
    // The entry's time is now locked in, so any timer feeding it must NOT
    // keep that time on its day clock — the next stop would refile the whole
    // clock into a new entry, double-counting it (Acme duplicate,
    // 2026-07-10). Zero and unlink; a running timer keeps running but
    // restarts its count from this moment.
    for (const t of db.prepare('SELECT id, running FROM timers WHERE linked_entry_id=?').all(id)) {
      db.prepare(
        'UPDATE timers SET accumulated_seconds=0, last_started_at=?, linked_entry_id=NULL WHERE id=?'
      ).run(t.running ? nowIso : null, t.id);
    }
  })();
  return { ok: true };
}

function softDeleteEntry(db, row, nowIso) {
  db.transaction(() => {
    db.prepare('UPDATE entries SET deleted_at=?, updated_at=? WHERE id=?').run(nowIso, nowIso, row.id);
    if (row.ever_finalized) {
      db.prepare('INSERT INTO audit_log (entry_id, action, detail, created_at) VALUES (?, ?, ?, ?)')
        .run(row.id, 'delete', JSON.stringify({ date: row.date, narrative: row.narrative }), nowIso);
    }
    rebuildMatterPeople(db, row.cm_id);
  })();
}

function restoreEntry(db, row, nowIso) {
  db.transaction(() => {
    db.prepare('UPDATE entries SET deleted_at=NULL, updated_at=? WHERE id=?').run(nowIso, row.id);
    if (row.ever_finalized) {
      db.prepare('INSERT INTO audit_log (entry_id, action, detail, created_at) VALUES (?, ?, ?, ?)')
        .run(row.id, 'restore', '{}', nowIso);
    }
    rebuildMatterPeople(db, row.cm_id);
  })();
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
