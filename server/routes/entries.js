import { Router } from 'express';
import { getSetting } from '../db.js';
import { isValidDate, todayLocal } from '../lib/dates.js';
import { buildNarrative } from '../lib/narrative.js';
import { validateEntry, canFinalize } from '../lib/validation.js';
import { extractPeople } from '../lib/people.js';
import { elapsedSeconds } from '../lib/timerlogic.js';
import { secondsToHours, quantizeBilled } from '../lib/rounding.js';
import { aiNarrativeProvenance } from '../lib/quickcapture.js';
import { reconcileEntryLines } from '../lib/reconcile.js';
import { loadEffectiveFields } from './customfields.js';
// Cyclic by module graph (timers.js imports loadEntry/syncNarrative from here),
// but safe: both sides only ever call each other's function DECLARATIONS, which
// are hoisted, and never at module-evaluation time.
import { applyRollovers } from './timers.js';

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

// ── the tenth-of-an-hour rule (owner decision, 2026-08-16) ────────────────
// "All billing should be done in 1/10 hr increments." So every figure this
// module STORES — an entry's total_override and each of its task lines — is
// snapped UP to the configured increment before it reaches SQLite. Doing it
// here, at storage, rather than in a formatter is what makes the ledger, the
// CSV, the .TIM and the narrative's own "(0.8)" brackets agree by
// construction: they all read the same stored number, and there is no second
// rounding rule to keep in sync. 0.75 h is never stored and never exported.
function billedHours(db, hours) {
  return quantizeBilled(hours, getSetting(db, 'rounding') || {});
}

function quantizeTasks(db, tasks) {
  return tasks.map((t) => ({ ...t, duration: billedHours(db, t.duration) }));
}

// `requireDuration` marks the EDIT path. writeTasks replaces an entry's lines
// wholesale, so a PATCH whose tasks carry no usable duration used to coerce
// every line to 0 (`Number(t.duration) || 0`) and answer 200 — recorded hours
// destroyed, narrative rewritten with (0.0) amounts, no signal of any kind.
// docs/ui/BRIEF.md forbids losing time, so on an edit an unusable duration is
// a 400 and nothing is written. A CREATE is the opposite case: an entry that
// does not exist yet has no hours to lose and legitimately starts with none,
// so a missing duration there still means 0.
function normalizeTasks(tasks, { requireDuration = false } = {}) {
  if (!Array.isArray(tasks)) return { error: 'tasks must be an array.' };
  const out = [];
  for (const t of tasks) {
    if (requireDuration) {
      const raw = t == null ? undefined : t.duration;
      // Only a number, or a string that is entirely a number, counts. '' and
      // null coerce to 0 in JS and would read as "zero these hours"; they are
      // far likelier to mean "I wasn't told", so they are refused.
      const usable = (typeof raw === 'number' || (typeof raw === 'string' && raw.trim() !== ''))
        && Number.isFinite(Number(raw));
      if (!usable) {
        return {
          error: 'Every task line must carry a numeric duration. Nothing was saved — '
            + 'a save that says nothing about a line\'s hours must not erase them.',
        };
      }
    }
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

// The task-line join this entry WOULD carry in AUTO, or null when it has too
// few substantive lines to have one. Consolidation format follows the entry's
// matter → client task_billing flag (LEFT JOIN; a matter with no linked client
// defaults to task-billed, same as loadEntry's cm payload). Exposed on its own
// so a caller can ask "is this text the machine text?" before deciding
// anything — the PATCH route does, to tell a chosen sentence from AUTO's.
export function autoNarrativeFor(db, entryId) {
  const tasks = db.prepare(
    'SELECT task_code, duration, fragment FROM entry_tasks WHERE entry_id=? ORDER BY sort_order, id').all(entryId);
  const rounding = getSetting(db, 'rounding') || {};
  const row = db.prepare(`
    SELECT COALESCE(clients.task_billing, 1) AS task_billing
    FROM entries
    LEFT JOIN matters ON matters.id = entries.cm_id
    LEFT JOIN clients ON clients.id = matters.client_id
    WHERE entries.id = ?
  `).get(entryId);
  return buildNarrative(tasks, {
    increment: rounding.increment,
    taskBilling: !row || !!row.task_billing,
  });
}

// Regenerate the stored narrative when the entry is multi-line. Skipped
// entirely when the entry's narrative has been detached from its task lines
// (narrative_manual=1) — that's the durability contract: once the user has
// typed over the AUTO box past the point it parses back, or picked a sentence
// of his own (see the PATCH route's "chosen sentence"), task-touching saves
// must not silently revert it.
export function syncNarrative(db, entryId) {
  const client = db.prepare(
    'SELECT narrative_manual, narrative FROM entries WHERE id=?').get(entryId);
  // An EMPTY narrative is never a manual narrative worth protecting. Clearing
  // the AUTO box detaches it (narrative_manual=1) with nothing left to keep,
  // and the entry would then sit blank forever with fully written task lines
  // right above it — no way back short of toggling AUTO (2026-08-14 feedback:
  // "task filling doesn't seem to be working here").
  if (client && client.narrative_manual && String(client.narrative || '').trim()) return;
  const generated = autoNarrativeFor(db, entryId);
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

// ── the suggestion fence ──────────────────────────────────────────────────
// A suggestion — a stop chip, a reused narrative, an AI draft, a close-out
// prefill — is BUILT for one matter and APPLIED some time later. In between,
// the entry's matter can move: the editor sat open while the timer under it was
// re-pointed, an autosave raced a matter change, a matterless entry got
// associated. Landing that text anyway puts one client's sentence on another
// client's bill, which docs/ui/BRIEF.md forbids outright ("Data integrity").
//
// So any client surface that writes SUGGESTED text sends `source_cm_id`: the
// matter the suggestion was built for. The server compares it with the entry's
// CURRENT matter and refuses the whole write with 409 when they differ —
// nothing is saved, not the narrative and not the rest of the payload. Absent
// `source_cm_id` the request behaves exactly as before, so hand-typed edits and
// every existing caller are untouched.
function matterLabel(db, cmId) {
  if (cmId == null) return 'no matter';
  const m = db.prepare('SELECT cm_number, short_name FROM matters WHERE id=?').get(cmId);
  if (!m) return `a matter that no longer exists (id ${cmId})`;
  return m.short_name ? `${m.short_name} (${m.cm_number})` : m.cm_number;
}

export function checkSourceMatter(db, row, sourceCmId) {
  if (sourceCmId === undefined || sourceCmId === null) return null;
  const src = Number(sourceCmId);
  if (!Number.isInteger(src)) {
    return { status: 400, body: { error: 'source_cm_id must be a matter id.' } };
  }
  if (row.cm_id != null && Number(row.cm_id) === src) return null;
  return {
    status: 409,
    body: {
      error: `That text was written for ${matterLabel(db, src)}, but this entry is now on `
        + `${matterLabel(db, row.cm_id)}. Nothing was saved — a narrative written for one `
        + 'matter must never be written onto another. Reopen the entry to get suggestions '
        + 'for its current matter.',
      code: 'matter_changed',
      source_cm_id: src,
      cm_id: row.cm_id,
    },
  };
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
    // ── the limit is OPT-IN ───────────────────────────────────────────────
    // This used to end `LIMIT 1000` unconditionally, with no total, no cursor
    // and no truncation flag. Everything older than the 1000th most recent
    // entry fell off the ledger silently — and, because public/js/views/search.js
    // derives the Export… range from the dates of the rows it can SEE, it fell
    // out of that range too. Unexported time is by its nature the old time you
    // forgot, so the rows most likely to be owed were the exact rows the screen
    // could not show and the export could not reach.
    //
    // A caller that genuinely wants a window now asks for one (?limit=N); the
    // default answers every row that matches the filters. Single-user SQLite —
    // a full scan of a few thousand rows is cheaper than losing one of them.
    const rawLimit = req.query.limit;
    const limit = rawLimit === undefined || rawLimit === '' ? null : Number(rawLimit);
    if (limit !== null && (!Number.isInteger(limit) || limit < 1)) {
      return res.status(400).json({ error: 'limit must be a positive integer.' });
    }
    const sql = `SELECT ${ENTRY_COLS} FROM entries
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY date DESC, id DESC${limit === null ? '' : ' LIMIT ?'}`;
    if (limit !== null) params.push(limit);
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
            // A soft-deleted entry is off every bill, export and total. Moving
            // it silently is a change nobody can see, and restoring it later
            // surfaces its narrative on a matter it was never written for —
            // so bulk refuses it exactly as /finalize and /copy do. Restore
            // it first if it is really meant to move.
            if (row.deleted_at) { failed.push({ id, error: 'deleted — restore it first' }); break; }
            const target = db.prepare('SELECT id, billable FROM matters WHERE id=?').get(cm_id);
            db.transaction(() => {
              // The new matter's billable flag takes over, mirroring the timer
              // re-point path (routes/timers.js). Without this, time moved onto
              // a billable matter goes out of the door marked non-billable —
              // and time moved onto a pro bono matter exports as billable.
              db.prepare('UPDATE entries SET cm_id=?, billable=?, updated_at=? WHERE id=?')
                .run(cm_id, target ? target.billable : row.billable, now(), id);
              touchCm(db, cm_id, now());
              // same association glue as PATCH: a matterless timer follows
              if (row.cm_id == null) {
                db.prepare('UPDATE timers SET cm_id=?, suggested_narrative=NULL WHERE linked_entry_id=? AND cm_id IS NULL')
                  .run(cm_id, id);
              }
              // The new client may bill in the other format — task-billed with
              // per-line "(0.5)" allocations, or block-billed without them.
              // Every other matter-changing write rebuilds the sentence; bulk
              // was the outlier, leaving the old client's format on the new
              // client's bill until some unrelated later save silently
              // reformatted it. BEFORE the audit, so the rebuilt narrative is
              // part of what the audit row records.
              syncNarrative(db, id);
              // Always audited, ever_finalized or not: a bulk move takes one
              // matter and applies it to many entries, and without a stored
              // "previous matter" per entry there is no route back. This is
              // the ONE recoverability record for the commonest case — a draft
              // keyed today and reassigned before close-out.
              recordAudit(db, row, { cm_id }, now(), { always: true });
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
    // The fence applies here too. On a create the two ids can only ever agree,
    // which is exactly why the check is here: every surface that writes a
    // suggested narrative names the matter it meant, and the one surface that
    // cannot disagree still says it — so the rule has no exception to remember.
    const fenced = checkSourceMatter(db, { cm_id: cm.id }, b.source_cm_id);
    if (fenced) return res.status(fenced.status).json(fenced.body);
    const norm = normalizeTasks(b.tasks || []);
    if (norm.error) return res.status(400).json({ error: norm.error });
    const cv = normalizeCustomValues(db, cm.id, b.custom_values);
    if (cv.error) return res.status(400).json({ error: cv.error });

    const billable = b.billable !== undefined ? (b.billable ? 1 : 0) : cm.billable;
    const totalOverride = b.total_override != null ? billedHours(db, Number(b.total_override)) : null;
    const narrativeManual = b.narrative_manual ? 1 : 0;
    // AI provenance (spec 2026-08-01 §5): narrative_ai=1 marks text the model
    // wrote and the attorney accepted untouched, keeping it out of the
    // exemplar and few-shot pools. ai_brief is the shorthand behind it, so a
    // later correction yields a labelled (brief → corrected narrative) pair.
    //
    // A client that says nothing about provenance is not asserting authorship:
    // quick capture posts { date, cm_id, narrative, tasks } and has no field to
    // say the model wrote the sentence. So when this text is one the server
    // itself just handed out as model output (see lib/quickcapture.js's
    // ledger), it is stored as the model's. An explicit narrative_ai in the
    // payload always wins.
    const qc = b.narrative_ai === undefined || b.ai_brief === undefined || b.ai_draft === undefined
      ? aiNarrativeProvenance(db, b.narrative)
      : null;
    const narrativeAi = b.narrative_ai !== undefined ? (b.narrative_ai ? 1 : 0) : (qc ? 1 : 0);
    const aiBrief = b.ai_brief != null && String(b.ai_brief).trim()
      ? String(b.ai_brief).trim().slice(0, 500) : (qc ? qc.brief : null);
    // What the model actually wrote, kept whatever David does to it next.
    const aiDraft = b.ai_draft != null && String(b.ai_draft).trim()
      ? String(b.ai_draft).trim().slice(0, 2000) : (qc ? qc.draft : null);
    const info = db.transaction(() => {
      const i = db.prepare(`INSERT INTO entries
        (date, cm_id, narrative, billable, status, total_override, source, narrative_manual, narrative_ai, ai_brief, ai_draft, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(b.date, cm.id, String(b.narrative || ''), billable, totalOverride,
          b.source === 'timer' ? 'timer' : 'manual', narrativeManual,
          narrativeAi, aiBrief, aiDraft, now(), now());
      writeTasks(db, i.lastInsertRowid, quantizeTasks(db, norm.tasks));
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
    // Fence first: a suggestion built for another matter must not write ANY
    // part of this payload, so this runs before every other check and before
    // the transaction opens.
    const fenced = checkSourceMatter(db, row, b.source_cm_id);
    if (fenced) return res.status(fenced.status).json(fenced.body);
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
      norm = normalizeTasks(b.tasks, { requireDuration: true });
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
    // ── the chosen sentence ────────────────────────────────────────────────
    // A PATCH that carries narrative TEXT and says nothing about
    // narrative_manual is a suggestion surface writing a sentence the lawyer
    // picked: a stop chip, "More from this matter", the PiP narrative box, a
    // close-out prefill. Until 2026-08-15 syncNarrative() then ran after the
    // UPDATE and rebuilt the task-line join straight over it on any ≥2-line
    // entry that was not already detached — the request answered 200, the
    // response echoed the machine text and the toast said "Narrative saved",
    // while the row never held the chosen sentence at all. docs/ui/BRIEF.md is
    // absolute on this: no narrative may be lost, and nothing may be silently
    // overwritten. So text that is NOT the join this entry would generate
    // detaches the narrative, exactly as the editor's own AUTO-off rule does
    // (entryeditor.js sends narrative_manual=1 for the same situation), and
    // syncNarrative then leaves it standing.
    //
    // Deliberately narrow, so the ordinary AUTO sync is untouched:
    //   • a client that states narrative_manual itself stays in charge;
    //   • replaying identical text (every editor autosave) changes nothing;
    //   • a blank narrative still refills from the task lines;
    //   • text that IS the generated join stays attached — that is the Undo
    //     path putting the AUTO sentence back, and it must land in AUTO.
    const chosen = b.narrative !== undefined && b.narrative_manual === undefined
      && nextNarrative.trim() && nextNarrative !== String(row.narrative ?? '')
      ? nextNarrative : null;
    let timersSynced = [];
    db.transaction(() => {
      db.prepare(`UPDATE entries SET
          date=?, cm_id=?, narrative=?, billable=?, total_override=?, ack_validation=?, narrative_manual=?, narrative_ai=?, ai_brief=?, ai_draft=?, updated_at=?
        WHERE id=?`).run(
        b.date ?? row.date,
        cmId,
        nextNarrative,
        b.billable !== undefined ? (b.billable ? 1 : 0) : row.billable,
        // Quantised whether it arrives in this payload or is carried over:
        // any write to the entry settles its billed figure on the increment,
        // so a total banked before the rule (or by a path that has not adopted
        // it yet) stops being a non-tenth the moment the entry is saved again.
        b.total_override !== undefined
          ? (b.total_override == null ? null : billedHours(db, Number(b.total_override)))
          : (row.total_override == null ? null : billedHours(db, row.total_override)),
        b.ack_validation !== undefined ? (b.ack_validation ? 1 : 0) : row.ack_validation,
        b.narrative_manual !== undefined ? (b.narrative_manual ? 1 : 0) : row.narrative_manual,
        narrativeAi, aiBrief, aiDraft,
        now(), row.id);
      if (norm) writeTasks(db, row.id, quantizeTasks(db, norm.tasks));
      applyCustomValues(db, row.id, cv.ops);
      // ── the lines follow the total ────────────────────────────────────────
      // An override says what this entry BILLS; the task lines say how those
      // hours are made up, and the CSV's per-line `duration` column, the .TIM
      // and the narrative's "(0.5)" brackets are all built from the lines. So a
      // save that moves the override without moving the lines ships two
      // different figures for the same entry in the same export — the one-tap
      // path (timergrid.js entryTotalSet PATCHes total_override alone) put 2.0
      // on screen and 1.5 in the CSV, and lines ABOVE the override over-billed
      // the other way. Reconciled here, right after the total is written and
      // BEFORE syncNarrative rebuilds the sentence, so the sentence is built
      // from the lines the file will carry.
      //
      // No override means the total IS the sum of the lines — nothing to
      // reconcile, and nothing is touched.
      //
      // WHICH WAY THE RECONCILE RUNS depends on what THIS request said, and
      // getting it backwards destroys recorded time. If the request restated
      // the task lines and said nothing about the override, the LINES are the
      // attorney's statement of the hours and the override must follow them.
      // Reconciling the other way silently shrank the lines back to a stale
      // override: a PATCH sending 0.5 + 0.8 stored 0.5 + 0.5 and answered 200,
      // so three tenths of an hour vanished with no error. The override only
      // wins when this request supplied it — then he has said both, and the
      // override is by definition what the entry bills.
      const overrideNow = db.prepare('SELECT total_override FROM entries WHERE id=?').get(row.id).total_override;
      const overrideThisRequest = b.total_override !== undefined;
      if (overrideNow != null && norm && !overrideThisRequest) {
        const lineSum = billedHours(db, db.prepare(
          'SELECT COALESCE(SUM(duration), 0) s FROM entry_tasks WHERE entry_id=?').get(row.id).s);
        db.prepare('UPDATE entries SET total_override=? WHERE id=?').run(lineSum, row.id);
      } else if (overrideNow != null) {
        reconcileEntryLines(db, row.id, overrideNow, getSetting(db, 'rounding') || {});
      }
      // Measured against the task lines as they stand AFTER this write, so a
      // save that changes lines and narrative together is judged on what the
      // entry actually holds now. An entry with no join to regenerate (fewer
      // than two substantive lines) has no AUTO box to detach from and keeps
      // its flag, exactly as entryeditor.js does.
      const join = chosen === null ? null : autoNarrativeFor(db, row.id);
      if (join != null) {
        db.prepare('UPDATE entries SET narrative_manual=? WHERE id=?')
          .run(chosen === join ? 0 : 1, row.id);
      }
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
    // A DELETED entry is not a source. The attorney affirmatively removed that
    // narrative; copying it puts the text back as a live billable draft that
    // finalizes and reaches the export CSV. Every sibling route re-reads
    // deleted_at and refuses (/finalize, and syncToEntry's validity check) —
    // copy was the outlier. The realistic path is a stale row on a second
    // surface: the ledger and Search views do not poll, so a row deleted on
    // the phone keeps offering "Copy to today" on the desktop indefinitely.
    if (!src || src.deleted_at) return res.status(404).json({ error: 'Entry not found.' });
    const date = (req.body || {}).date;
    if (!isValidDate(date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD.' });
    const info = db.transaction(() => {
      // AI provenance travels with the text. The copy IS the model's sentence,
      // byte for byte; storing it as the attorney's own would feed model output
      // back to the model as an example of HIS voice (server/lib/exemplars.js
      // and routes/ai.js both gate on narrative_ai = 0) — the exact loop the
      // flag exists to break. ai_brief and ai_draft come too, so a later
      // correction still yields a labelled (brief → corrected) pair.
      const i = db.prepare(`INSERT INTO entries
        (date, cm_id, narrative, billable, status, total_override, source, narrative_manual, narrative_ai, ai_brief, ai_draft, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'draft', ?, 'manual', ?, ?, ?, ?, ?, ?)`)
        .run(date, src.cm_id, src.narrative, src.billable,
          src.total_override == null ? null : billedHours(db, src.total_override),
          src.narrative_manual ? 1 : 0,
          src.narrative_ai ? 1 : 0, src.ai_brief, src.ai_draft, now(), now());
      writeTasks(db, i.lastInsertRowid, quantizeTasks(db, src.tasks));
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

// Settle the LIVE clock of any timer feeding this entry onto the entry itself,
// BEFORE the entry is locked. A timer's time only reaches its entry at stop:
// while it runs, the stored total is whatever the last stop left. finalizeOne
// then locks that stale total and zeroes the clock, so the unfiled hours end up
// on neither the entry nor the timer — pure loss (docs/ui/BRIEF.md, "no time
// may be lost"). Close-out must SETTLE, never refuse: the lawyer closing the
// day is not asking to be blocked, he is asking for the day to be right.
//
// Grow-only (strict '>'): a hand-edited total is never shrunk by a clock that
// happens to read lower, and an already-stopped timer (clock == entry total) is
// a no-op — which is what keeps the zero+unlink loop below unchanged and keeps
// verify.entry-repoint-doublefile's V4 control green.
//
// Only today's entry is settled. A yesterday-dated entry's clock belongs to
// yesterday and is the midnight rollover's job (applyRollovers); writing today's
// elapsed hours onto it would be a different kind of loss.
function settleRunningTimers(db, id, nowIso) {
  const entry = db.prepare('SELECT date FROM entries WHERE id=?').get(id);
  if (!entry || entry.date !== todayLocal(new Date(nowIso))) return false;
  const rounding = getSetting(db, 'rounding') || {};
  const nowMs = Date.parse(nowIso);
  const timers = db.prepare(
    'SELECT id, running, accumulated_seconds, last_started_at FROM timers WHERE linked_entry_id=?').all(id);
  let grew = false;
  for (const t of timers) {
    // Snapped to the billing increment before it is banked: close-out writes a
    // figure that goes straight onto the bill, so it obeys the tenth rule like
    // every other stored total.
    const liveHours = quantizeBilled(secondsToHours(elapsedSeconds(t, nowMs), rounding), rounding);
    if (!(liveHours > effectiveTotal(db, id) + 1e-9)) continue;
    grew = true;
    // Same shape as syncToEntry (routes/timers.js): the override carries the
    // hours and the task lines are reconciled to it.
    //
    // This used to move a SINGLE line only ("user-added splits are left
    // alone"), which stranded every split entry at close-out: finalizing a
    // 0.5+0.5 entry while its timer read 1.5 h stored total_override 1.5 with
    // lines still summing to 1.0, so the .TIM said am=5400 while the CSV
    // duration column — the one the assistant keys from — said 1.0. Half an
    // hour disappeared from a finalized, exportable entry. Same reconcile as
    // the other two write paths now; server/lib/reconcile.js holds the rule.
    db.prepare('UPDATE entries SET total_override=?, updated_at=? WHERE id=?')
      .run(liveHours, nowIso, id);
    reconcileEntryLines(db, id, liveHours, rounding);
    syncNarrative(db, id);
  }
  return grew;
}

export function finalizeOne(db, id, ack, nowIso) {
  const stale = loadEntry(db, id);
  if (!stale || stale.deleted_at) {
    return { ok: false, blocks: [{ level: 'block', code: 'not_found', message: 'Entry not found.' }], warns: [] };
  }
  if (stale.status === 'finalized') return { ok: true };
  const validation = getSetting(db, 'validation');
  // Settle BEFORE the gate: raising the total changes what canFinalize finds
  // (a 0.0h entry with four live hours on its clock is not a zero-hour entry),
  // so the gate must judge the settled entry, not the stale one.
  const grew = settleRunningTimers(db, id, nowIso);
  const entry = loadEntry(db, id);
  // Evaluate the gate with the ack applied hypothetically; persist it only on
  // success so a blocked attempt doesn't pre-acknowledge future warnings.
  const gate = canFinalize(
    { ...entry, ack_validation: ack ? 1 : entry.ack_validation },
    validation);
  if (!gate.ok) {
    // "Settle, do not refuse." Booking the live clock onto the entry is
    // bookkeeping the app owes the lawyer — it must never itself become the
    // reason his day won't close. So a settle that only raises WARNINGS (a
    // longer single line now trips block_billing, say) on an entry that was
    // about to finalize cleanly goes through; the hours are what matter, and
    // refusing here would leave the clock zeroed by a close-out that did
    // nothing. Anything that BLOCKS, and anything already unacknowledged
    // before the settle, still refuses exactly as before.
    const settleCausedIt = grew && gate.blocks.length === 0
      && canFinalize({ ...stale, ack_validation: ack ? 1 : stale.ack_validation }, validation).ok;
    if (!settleCausedIt) return { ok: false, blocks: gate.blocks, warns: gate.warns };
  }
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
    // Bank any overnight clock FIRST. Every other timer-aware surface
    // (dashboard, the timer routes, the nightly job) calls this; finalize-day
    // did not, so closing out yesterday from a machine that had been left
    // running erased the clock and locked yesterday's entry at its stale
    // total. It also has to run before finalizeOne's settle, or a clock that
    // has been ticking since last night would be booked onto a
    // yesterday-dated entry as if it were today's work.
    applyRollovers(db, clock);
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
// `always` overrides that gate for a write whose recoverability does not
// depend on the entry having been billed once — a bulk matter reassignment,
// where the previous matter of a plain draft is otherwise unrecoverable.
export function recordAudit(db, beforeRow, patch, nowIso, { always = false } = {}) {
  if (!always && !beforeRow.ever_finalized) return;
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
