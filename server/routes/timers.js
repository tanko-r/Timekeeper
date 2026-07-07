import { Router } from 'express';
import { getSetting } from '../db.js';
import { todayLocal } from '../lib/dates.js';
import { secondsToHours } from '../lib/rounding.js';
import { elapsedSeconds, rollover } from '../lib/timerlogic.js';
import { loadEntry, syncNarrative, enrich } from './entries.js';

const TIMER_COLS = 'id, name, cm_id, task_code, sort_order, running, accumulated_seconds, last_started_at, last_reset_date, created_at';

function minIncrement(db) {
  return (getSetting(db, 'validation') || {}).minIncrement || 0.1;
}

// Create a draft entry from timer output (used by stop→new and midnight banking).
export function createTimerEntry(db, timer, date, hours, nowIso) {
  const cm = db.prepare('SELECT id, billable FROM cms WHERE id=?').get(timer.cm_id);
  const info = db.prepare(`INSERT INTO entries
    (date, cm_id, narrative, billable, status, source, created_at, updated_at)
    VALUES (?, ?, '', ?, 'draft', 'timer', ?, ?)`)
    .run(date, timer.cm_id, cm ? cm.billable : 1, nowIso, nowIso);
  db.prepare(
    'INSERT INTO entry_tasks (entry_id, task_code, duration, fragment, sort_order) VALUES (?, ?, ?, ?, 0)'
  ).run(info.lastInsertRowid, timer.task_code || '', hours, '');
  return info.lastInsertRowid;
}

// Lazy midnight reset — safe to call on every request; no-op when up to date.
export function applyRollovers(db, clock) {
  const today = todayLocal(clock());
  const stale = db.prepare(`SELECT ${TIMER_COLS} FROM timers WHERE last_reset_date < ?`).all(today);
  if (stale.length === 0) return;
  const rounding = getSetting(db, 'rounding') || {};
  const minInc = minIncrement(db);
  const nowIso = clock().toISOString();
  db.transaction(() => {
    for (const timer of stale) {
      const r = rollover(timer, today);
      const hours = secondsToHours(r.bankSeconds, rounding);
      if (hours >= minInc - 1e-9 && hours > 0) {
        createTimerEntry(db, timer, r.bankDate, hours, nowIso);
      } else if (r.bankSeconds > 0) {
        console.log(`timer ${timer.id} (${timer.name}): dropped ${r.bankSeconds}s below minimum increment at midnight reset`);
      }
      db.prepare(
        'UPDATE timers SET accumulated_seconds=0, last_started_at=?, last_reset_date=? WHERE id=?'
      ).run(timer.running ? r.restartIso : null, today, timer.id);
    }
  })();
}

export function timersRouter({ db, clock }) {
  const r = Router();
  const now = () => clock().toISOString();
  const getTimer = db.prepare(`SELECT ${TIMER_COLS} FROM timers WHERE id=?`);

  const withElapsed = (t) => ({ ...t, elapsed_seconds: elapsedSeconds(t, clock().getTime()) });

  r.get('/', (req, res) => {
    applyRollovers(db, clock);
    const rows = db.prepare(`SELECT ${TIMER_COLS},
        (SELECT cm_number FROM cms WHERE cms.id = timers.cm_id) AS cm_number,
        (SELECT short_name FROM cms WHERE cms.id = timers.cm_id) AS cm_short_name
      FROM timers ORDER BY sort_order, id`).all();
    res.json(rows.map(withElapsed));
  });

  r.post('/', (req, res) => {
    const b = req.body || {};
    const name = String(b.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Timer name required.' });
    const cm = db.prepare('SELECT id FROM cms WHERE id=?').get(b.cm_id);
    if (!cm) return res.status(400).json({ error: 'Unknown CM.' });
    const max = db.prepare('SELECT COALESCE(MAX(sort_order), -1) m FROM timers').get().m;
    const info = db.prepare(
      'INSERT INTO timers (name, cm_id, task_code, sort_order, last_reset_date, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(name, cm.id, b.task_code ? String(b.task_code) : null, max + 1, todayLocal(clock()), now());
    res.status(201).json(withElapsed(getTimer.get(info.lastInsertRowid)));
  });

  r.put('/order', (req, res) => {
    const ids = (req.body || {}).ids;
    if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids array required.' });
    const upd = db.prepare('UPDATE timers SET sort_order=? WHERE id=?');
    db.transaction(() => ids.forEach((id, i) => upd.run(i, id)))();
    res.json({ ok: true });
  });

  r.patch('/:id', (req, res) => {
    const timer = getTimer.get(req.params.id);
    if (!timer) return res.status(404).json({ error: 'Timer not found.' });
    const b = req.body || {};
    if (b.cm_id !== undefined && !db.prepare('SELECT id FROM cms WHERE id=?').get(b.cm_id)) {
      return res.status(400).json({ error: 'Unknown CM.' });
    }
    const name = b.name !== undefined ? String(b.name).trim() : timer.name;
    if (!name) return res.status(400).json({ error: 'Timer name required.' });
    db.prepare('UPDATE timers SET name=?, cm_id=?, task_code=? WHERE id=?').run(
      name,
      b.cm_id !== undefined ? b.cm_id : timer.cm_id,
      b.task_code !== undefined ? (b.task_code ? String(b.task_code) : null) : timer.task_code,
      timer.id);
    res.json(withElapsed(getTimer.get(timer.id)));
  });

  r.delete('/:id', (req, res) => {
    const timer = getTimer.get(req.params.id);
    if (!timer) return res.status(404).json({ error: 'Timer not found.' });
    db.prepare('DELETE FROM timers WHERE id=?').run(timer.id);
    res.json({ ok: true });
  });

  r.post('/:id/start', (req, res) => {
    applyRollovers(db, clock);
    const timer = getTimer.get(req.params.id);
    if (!timer) return res.status(404).json({ error: 'Timer not found.' });
    const others = db.prepare(
      'SELECT name FROM timers WHERE running=1 AND id != ?').all(timer.id).map((t) => t.name);
    if (!timer.running) {
      db.prepare('UPDATE timers SET running=1, last_started_at=? WHERE id=?').run(now(), timer.id);
    }
    const out = { timer: withElapsed(getTimer.get(timer.id)) };
    if (others.length > 0) {
      out.warning = `${others.join(', ')} ${others.length === 1 ? 'is' : 'are'} also running.`;
    }
    res.json(out);
  });

  r.post('/:id/pause', (req, res) => {
    applyRollovers(db, clock);
    const timer = getTimer.get(req.params.id);
    if (!timer) return res.status(404).json({ error: 'Timer not found.' });
    pauseTimer(timer);
    res.json({ timer: withElapsed(getTimer.get(timer.id)) });
  });

  r.get('/:id/stop-context', (req, res) => {
    applyRollovers(db, clock);
    const timer = getTimer.get(req.params.id);
    if (!timer) return res.status(404).json({ error: 'Timer not found.' });
    const seconds = elapsedSeconds(timer, clock().getTime());
    const rounding = getSetting(db, 'rounding') || {};
    const drafts = db.prepare(
      "SELECT id FROM entries WHERE cm_id=? AND date=? AND status='draft' AND deleted_at IS NULL ORDER BY id DESC"
    ).all(timer.cm_id, todayLocal(clock()));
    res.json({
      timer: withElapsed(timer),
      hours_preview: secondsToHours(seconds, rounding),
      todayDrafts: drafts.map((d) => loadEntry(db, d.id)),
    });
  });

  r.post('/:id/stop', (req, res) => {
    applyRollovers(db, clock);
    const timer = getTimer.get(req.params.id);
    if (!timer) return res.status(404).json({ error: 'Timer not found.' });
    const b = req.body || {};
    const seconds = elapsedSeconds(timer, clock().getTime());
    const rounding = getSetting(db, 'rounding') || {};
    const hours = secondsToHours(seconds, rounding);

    // Zero the clock regardless — stopping is always a reset.
    db.prepare('UPDATE timers SET running=0, accumulated_seconds=0, last_started_at=NULL WHERE id=?')
      .run(timer.id);

    if (hours < minIncrement(db) - 1e-9 || hours <= 0) {
      return res.json({ entry: null, hours: 0, seconds });
    }

    let entryId;
    let appended = false;
    if (b.action === 'append') {
      let target = null;
      if (b.entry_id) {
        target = db.prepare(
          "SELECT id, status, deleted_at FROM entries WHERE id=?").get(b.entry_id);
        if (!target || target.deleted_at) return res.status(400).json({ error: 'Target entry not found.' });
        if (target.status === 'finalized') return res.status(409).json({ error: 'Target entry is finalized.' });
      } else {
        target = db.prepare(
          "SELECT id FROM entries WHERE cm_id=? AND date=? AND status='draft' AND deleted_at IS NULL ORDER BY id DESC LIMIT 1"
        ).get(timer.cm_id, todayLocal(clock()));
      }
      if (target) {
        const maxOrder = db.prepare(
          'SELECT COALESCE(MAX(sort_order), -1) m FROM entry_tasks WHERE entry_id=?').get(target.id).m;
        db.transaction(() => {
          db.prepare(
            'INSERT INTO entry_tasks (entry_id, task_code, duration, fragment, sort_order) VALUES (?, ?, ?, ?, ?)'
          ).run(target.id, timer.task_code || '', hours, '', maxOrder + 1);
          db.prepare('UPDATE entries SET updated_at=? WHERE id=?').run(now(), target.id);
          syncNarrative(db, target.id);
        })();
        entryId = target.id;
        appended = true;
      }
    }
    if (!entryId) {
      entryId = db.transaction(() =>
        createTimerEntry(db, timer, todayLocal(clock()), hours, now()))();
    }
    res.json({ entry: loadEntry(db, entryId), hours, seconds, appended });
  });

  function pauseTimer(timer) {
    if (!timer.running) return;
    const secs = elapsedSeconds(timer, clock().getTime());
    db.prepare('UPDATE timers SET running=0, accumulated_seconds=?, last_started_at=NULL WHERE id=?')
      .run(secs, timer.id);
  }

  return r;
}
