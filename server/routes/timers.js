import { Router } from 'express';
import { getSetting } from '../db.js';
import { todayLocal, localMidnightMs } from '../lib/dates.js';
import { secondsToHours } from '../lib/rounding.js';
import { elapsedSeconds, rollover } from '../lib/timerlogic.js';
import { parseCsv } from '../lib/csv.js';
import { detectMapping, normalizeMapping, planImport } from '../lib/timerimport.js';
import { loadEntry, syncNarrative, rebuildMatterPeople } from './entries.js';
import { ensureClient } from './cms.js';
import { splitCmNumber } from '../lib/cmNumber.js';
import { matterSuggestions } from './matters.js';
import { refineSuggestedNarrative } from './ai.js';
import { containsTimeAmounts } from '../lib/timeAmounts.js';

// Round-2 timer model: the clock accumulates for the whole day across
// start/stops. Each stop syncs the day total into ONE linked draft entry.
// "fresh" zeroes the clock and unlinks so later time files to a new entry.

const TIMER_COLS = `id, name, cm_id, task_code, sort_order, running,
  accumulated_seconds, last_started_at, last_reset_date, created_at,
  group_id, linked_entry_id, last_stopped_at, suggested_narrative`;

const TENTH_SECONDS = 360;

function roundingCfg(db) {
  return getSetting(db, 'rounding') || {};
}

function minIncrement(db) {
  return (getSetting(db, 'validation') || {}).minIncrement || 0.1;
}

// File `hours` into the timer's linked entry for `dateStr`, creating and
// (re)linking as needed. Returns { entryId, relinked, previousTotal }.
function syncToEntry(db, timer, hours, dateStr, nowIso) {
  let relinked = false;
  let previousTotal = null;
  let entry = null;
  if (timer.linked_entry_id) {
    entry = db.prepare(
      'SELECT id, cm_id, date, status, deleted_at, total_override FROM entries WHERE id=?'
    ).get(timer.linked_entry_id);
    const valid = entry && !entry.deleted_at && entry.status === 'draft'
      && entry.date === dateStr && entry.cm_id === timer.cm_id;
    if (!valid) {
      relinked = !!entry;
      previousTotal = entry ? entry.total_override : null;
      entry = null;
    }
  }

  let entryId;
  db.transaction(() => {
    if (entry) {
      db.prepare('UPDATE entries SET total_override=?, updated_at=? WHERE id=?')
        .run(hours, nowIso, entry.id);
      const lines = db.prepare(
        'SELECT id FROM entry_tasks WHERE entry_id=? ORDER BY sort_order, id').all(entry.id);
      if (lines.length === 1) {
        // single line mirrors the total; user-added splits are left alone
        db.prepare('UPDATE entry_tasks SET duration=? WHERE id=?').run(hours, lines[0].id);
      }
      syncNarrative(db, entry.id);
      entryId = entry.id;
    } else {
      const cm = db.prepare('SELECT id, billable FROM matters WHERE id=?').get(timer.cm_id);
      const info = db.prepare(`INSERT INTO entries
        (date, cm_id, narrative, billable, status, total_override, source, created_at, updated_at)
        VALUES (?, ?, '', ?, 'draft', ?, 'timer', ?, ?)`)
        .run(dateStr, timer.cm_id, cm ? cm.billable : 1, hours, nowIso, nowIso);
      db.prepare(
        'INSERT INTO entry_tasks (entry_id, task_code, duration, fragment, sort_order) VALUES (?, ?, ?, ?, 0)'
      ).run(info.lastInsertRowid, timer.task_code || '', hours, '');
      entryId = info.lastInsertRowid;
      db.prepare('UPDATE timers SET linked_entry_id=? WHERE id=?').run(entryId, timer.id);
    }
    db.prepare('UPDATE matters SET last_used_at=? WHERE id=?').run(nowIso, timer.cm_id);
    rebuildMatterPeople(db, timer.cm_id);
  })();

  return { entryId, relinked, previousTotal };
}

// Lazy midnight reset — safe to call on every request; no-op when up to date.
export function applyRollovers(db, clock) {
  const today = todayLocal(clock());
  const stale = db.prepare(`SELECT ${TIMER_COLS} FROM timers WHERE last_reset_date < ?`).all(today);
  if (stale.length === 0) return;
  const rounding = roundingCfg(db);
  const minInc = minIncrement(db);
  const nowIso = clock().toISOString();
  for (const timer of stale) {
    const r = rollover(timer, today);
    const hours = secondsToHours(r.bankSeconds, rounding);
    if (hours >= minInc - 1e-9 && hours > 0) {
      syncToEntry(db, timer, hours, r.bankDate, nowIso);
    } else if (r.bankSeconds > 0) {
      console.log(`timer ${timer.id} (${timer.name}): dropped ${r.bankSeconds}s below minimum increment at midnight reset`);
    }
    db.prepare(
      'UPDATE timers SET accumulated_seconds=0, last_started_at=?, last_reset_date=?, linked_entry_id=NULL WHERE id=?'
    ).run(timer.running ? r.restartIso : null, today, timer.id);
  }
}

export function timersRouter({ db, clock }) {
  const r = Router();
  const now = () => clock().toISOString();
  const getTimer = db.prepare(`SELECT ${TIMER_COLS} FROM timers WHERE id=?`);

  const withElapsed = (t) => ({ ...t, elapsed_seconds: elapsedSeconds(t, clock().getTime()) });

  const listStmt = () => db.prepare(`SELECT ${TIMER_COLS},
      (SELECT cm_number FROM matters WHERE matters.id = timers.cm_id) AS cm_number,
      (SELECT short_name FROM matters WHERE matters.id = timers.cm_id) AS cm_short_name,
      (SELECT billable FROM matters WHERE matters.id = timers.cm_id) AS cm_billable,
      (SELECT client_id FROM matters WHERE matters.id = timers.cm_id) AS client_id,
      (SELECT c.client_number FROM matters m JOIN clients c ON c.id = m.client_id WHERE m.id = timers.cm_id) AS client_number,
      (SELECT c.name FROM matters m JOIN clients c ON c.id = m.client_id WHERE m.id = timers.cm_id) AS client_name
    FROM timers ORDER BY sort_order, id`);

  r.get('/', (req, res) => {
    applyRollovers(db, clock);
    res.json(listStmt().all().map(withElapsed));
  });

  r.post('/', (req, res) => {
    const b = req.body || {};
    const name = String(b.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Timer name required.' });
    const cm = db.prepare('SELECT id FROM matters WHERE id=?').get(b.cm_id);
    if (!cm) return res.status(400).json({ error: 'Unknown CM.' });
    if (b.group_id != null && !db.prepare('SELECT id FROM timer_groups WHERE id=?').get(b.group_id)) {
      return res.status(400).json({ error: 'Unknown group.' });
    }
    const max = db.prepare('SELECT COALESCE(MAX(sort_order), -1) m FROM timers').get().m;
    const info = db.prepare(
      'INSERT INTO timers (name, cm_id, task_code, group_id, sort_order, last_reset_date, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(name, cm.id, b.task_code ? String(b.task_code) : null,
      b.group_id ?? null, max + 1, todayLocal(clock()), now());
    res.status(201).json(withElapsed(getTimer.get(info.lastInsertRowid)));
  });

  // --- CSV batch import: map columns → create new matters + timers ---

  // Parse the CSV and build a plan against current DB state. Shared by the
  // preview (dry-run) and commit endpoints so both see identical decisions.
  function buildPlan(body) {
    const rows = parseCsv(String(body.csv || ''));
    if (rows.length === 0) return { error: 'CSV appears to be empty.' };
    const headers = rows[0].map((h) => String(h ?? ''));
    const mapping = body.mapping
      ? normalizeMapping(body.mapping, headers.length)
      : detectMapping(headers);
    const existingCmNumbers = db.prepare('SELECT cm_number FROM matters').all().map((x) => x.cm_number);
    const nonBillableGroups = (getSetting(db, 'import') || {}).nonBillableGroups || [];
    const { plan, counts } = planImport(rows, mapping, { existingCmNumbers, nonBillableGroups });
    return { headers, mapping, plan, counts };
  }

  r.post('/import/preview', (req, res) => {
    const out = buildPlan(req.body || {});
    if (out.error) return res.status(400).json({ error: out.error });
    res.json(out);
  });

  r.post('/import', (req, res) => {
    const out = buildPlan(req.body || {});
    if (out.error) return res.status(400).json({ error: out.error });
    const toCreate = out.plan.filter((p) => p.action === 'create');
    const nowIso = now();
    const today = todayLocal(clock());
    const timerIds = [];

    db.transaction(() => {
      const groupByName = new Map(
        db.prepare('SELECT id, name FROM timer_groups').all()
          .map((g) => [g.name.toLowerCase(), g.id]));
      let groupOrder = db.prepare('SELECT COALESCE(MAX(sort_order), -1) m FROM timer_groups').get().m;
      let timerOrder = db.prepare('SELECT COALESCE(MAX(sort_order), -1) m FROM timers').get().m;
      const insCm = db.prepare(
        'INSERT INTO matters (cm_number, short_name, billable, favorite, client_id, matter_number, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?, ?, ?)');
      const insGroup = db.prepare('INSERT INTO timer_groups (name, sort_order) VALUES (?, ?)');
      const insTimer = db.prepare(
        'INSERT INTO timers (name, cm_id, task_code, group_id, sort_order, last_reset_date, created_at) VALUES (?, ?, NULL, ?, ?, ?, ?)');

      const nameClient = db.prepare(
        "UPDATE clients SET name=?, updated_at=? WHERE id=? AND (name IS NULL OR name='')");
      for (const p of toCreate) {
        const parts = splitCmNumber(p.cm_number);
        const clientId = ensureClient(db, parts.clientNumber, nowIso);
        // CSV client name fills a blank client; a client already named in the
        // app keeps its name (imports never rename).
        if (p.client_name) nameClient.run(p.client_name, nowIso, clientId);
        const cmId = insCm.run(p.cm_number, p.matter_name, p.billable, clientId, parts.matterNumber, nowIso, nowIso).lastInsertRowid;
        let groupId = null;
        if (p.group) {
          const key = p.group.toLowerCase();
          groupId = groupByName.get(key);
          if (groupId === undefined) {
            groupId = insGroup.run(p.group, ++groupOrder).lastInsertRowid;
            groupByName.set(key, groupId);
          }
        }
        timerIds.push(insTimer.run(p.matter_name, cmId, groupId, ++timerOrder, today, nowIso).lastInsertRowid);
      }
    })();

    res.status(201).json({ created: timerIds.length, skipped: out.counts.skip, timerIds });
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
    if (b.cm_id !== undefined && !db.prepare('SELECT id FROM matters WHERE id=?').get(b.cm_id)) {
      return res.status(400).json({ error: 'Unknown CM.' });
    }
    if (b.group_id != null && !db.prepare('SELECT id FROM timer_groups WHERE id=?').get(b.group_id)) {
      return res.status(400).json({ error: 'Unknown group.' });
    }
    const name = b.name !== undefined ? String(b.name).trim() : timer.name;
    if (!name) return res.status(400).json({ error: 'Timer name required.' });
    const cmChanged = b.cm_id !== undefined && b.cm_id !== timer.cm_id;
    db.prepare('UPDATE timers SET name=?, cm_id=?, task_code=?, group_id=?, linked_entry_id=?, suggested_narrative=? WHERE id=?').run(
      name,
      b.cm_id !== undefined ? b.cm_id : timer.cm_id,
      b.task_code !== undefined ? (b.task_code ? String(b.task_code) : null) : timer.task_code,
      b.group_id !== undefined ? b.group_id : timer.group_id,
      cmChanged ? null : timer.linked_entry_id, // new CM → old entry no longer its home
      cmChanged ? null : timer.suggested_narrative, // suggestion belonged to the old matter
      timer.id);
    res.json(withElapsed(getTimer.get(timer.id)));
  });

  r.delete('/:id', (req, res) => {
    const timer = getTimer.get(req.params.id);
    if (!timer) return res.status(404).json({ error: 'Timer not found.' });
    db.prepare('DELETE FROM timers WHERE id=?').run(timer.id);
    res.json({ ok: true });
  });

  r.post('/:id/duplicate', (req, res) => {
    const timer = getTimer.get(req.params.id);
    if (!timer) return res.status(404).json({ error: 'Timer not found.' });
    const max = db.prepare('SELECT COALESCE(MAX(sort_order), -1) m FROM timers').get().m;
    const info = db.prepare(
      'INSERT INTO timers (name, cm_id, task_code, group_id, sort_order, last_reset_date, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(`${timer.name} (copy)`, timer.cm_id, timer.task_code, timer.group_id,
      max + 1, todayLocal(clock()), now());
    res.status(201).json(withElapsed(getTimer.get(info.lastInsertRowid)));
  });

  r.post('/:id/start', (req, res) => {
    applyRollovers(db, clock);
    const timer = getTimer.get(req.params.id);
    if (!timer) return res.status(404).json({ error: 'Timer not found.' });
    const b = req.body || {};
    const backdated = b.minutesAgo != null || b.atLastStop;

    if (timer.running) {
      if (backdated) {
        return res.status(409).json({ error: 'Timer is already running — pause it before a backdated start.' });
      }
    } else {
      let startMs = clock().getTime();
      if (b.atLastStop && timer.last_stopped_at) {
        startMs = Date.parse(timer.last_stopped_at);
      } else if (b.minutesAgo != null) {
        const mins = Number(b.minutesAgo);
        if (!Number.isFinite(mins) || mins < 0 || mins > 24 * 60) {
          return res.status(400).json({ error: 'minutesAgo must be 0–1440.' });
        }
        startMs = clock().getTime() - mins * 60_000;
      }
      // never reach behind today's midnight — yesterday is banked and closed
      startMs = Math.max(startMs, localMidnightMs(todayLocal(clock())));
      db.prepare('UPDATE timers SET running=1, last_started_at=? WHERE id=?')
        .run(new Date(startMs).toISOString(), timer.id);
      // Pre-compute the likely narrative NOW so it's ready before stop (spec
      // §6): deterministic phrasebook top hit synchronously; the optional
      // local-LLM pass refines it in the background and never blocks. Skip
      // any top-ranked phrase that carries a baked-in time amount (e.g. an
      // old free-text narrative like "Drafted agreement (0.5)...") — time is
      // unknown at start (often zero) and must never be invented.
      const sugg = matterSuggestions(db, timer.cm_id, todayLocal(clock()));
      const cleanPhrase = sugg && sugg.phrases.find((p) => !containsTimeAmounts(p.text));
      db.prepare('UPDATE timers SET suggested_narrative=? WHERE id=?')
        .run(cleanPhrase ? cleanPhrase.text : null, timer.id);
      refineSuggestedNarrative({ db, clock }, timer.id).catch(() => {});
    }

    const others = db.prepare(
      'SELECT name FROM timers WHERE running=1 AND id != ?').all(timer.id).map((t) => t.name);
    const out = { timer: withElapsed(getTimer.get(timer.id)) };
    if (others.length > 0) {
      out.warning = `${others.join(', ')} ${others.length === 1 ? 'is' : 'are'} also running.`;
    }
    res.json(out);
  });

  // Stop = pause + file the day total into the linked entry (create/relink as
  // needed). Never zeroes the clock; sub-increment totals just wait for more.
  r.post('/:id/stop', (req, res) => {
    applyRollovers(db, clock);
    const timer = getTimer.get(req.params.id);
    if (!timer) return res.status(404).json({ error: 'Timer not found.' });

    // Misclick grace: a running stretch of ≤2 seconds vanishes entirely —
    // nothing accumulates, nothing files, the last-stop anchor doesn't move.
    if (timer.running && timer.last_started_at
      && clock().getTime() - Date.parse(timer.last_started_at) <= 2000) {
      db.prepare('UPDATE timers SET running=0, last_started_at=NULL WHERE id=?').run(timer.id);
      return res.json({
        entry: null, hours: 0, discarded: true,
        seconds: timer.accumulated_seconds,
        timer: withElapsed(getTimer.get(timer.id)),
      });
    }

    const seconds = elapsedSeconds(timer, clock().getTime());
    db.prepare('UPDATE timers SET running=0, accumulated_seconds=?, last_started_at=NULL, last_stopped_at=? WHERE id=?')
      .run(seconds, now(), timer.id);

    const hours = secondsToHours(seconds, roundingCfg(db));
    if (hours < minIncrement(db) - 1e-9 || hours <= 0) {
      return res.json({ entry: null, hours: 0, seconds, timer: withElapsed(getTimer.get(timer.id)) });
    }
    const synced = syncToEntry(db, getTimer.get(timer.id), hours, todayLocal(clock()), now());
    res.json({
      entry: loadEntry(db, synced.entryId),
      hours,
      seconds,
      relinked: synced.relinked || undefined,
      previousTotal: synced.previousTotal ?? undefined,
      timer: withElapsed(getTimer.get(timer.id)),
    });
  });

  // Zero the clock and unlink — the next stop files a brand-new entry.
  r.post('/:id/fresh', (req, res) => {
    applyRollovers(db, clock);
    const timer = getTimer.get(req.params.id);
    if (!timer) return res.status(404).json({ error: 'Timer not found.' });
    db.prepare(
      'UPDATE timers SET accumulated_seconds=0, last_started_at=?, linked_entry_id=NULL WHERE id=?'
    ).run(timer.running ? now() : null, timer.id);
    res.json({ timer: withElapsed(getTimer.get(timer.id)) });
  });

  // Edit the clock: {hours} sets it, {deltaHours} nudges it. Tenths only.
  // While paused and linked, the entry follows immediately.
  r.put('/:id/clock', (req, res) => {
    applyRollovers(db, clock);
    const timer = getTimer.get(req.params.id);
    if (!timer) return res.status(404).json({ error: 'Timer not found.' });
    const b = req.body || {};
    const current = elapsedSeconds(timer, clock().getTime());
    let target;
    if (b.hours !== undefined) {
      const h = Number(b.hours);
      if (!Number.isFinite(h) || h < 0 || h > 24) {
        return res.status(400).json({ error: 'hours must be 0–24.' });
      }
      target = h * 3600;
    } else if (b.deltaHours !== undefined) {
      const d = Number(b.deltaHours);
      if (!Number.isFinite(d)) return res.status(400).json({ error: 'deltaHours must be a number.' });
      target = current + d * 3600;
    } else {
      return res.status(400).json({ error: 'Provide hours or deltaHours.' });
    }
    const snapped = Math.max(0, Math.round(target / TENTH_SECONDS) * TENTH_SECONDS);

    db.prepare('UPDATE timers SET accumulated_seconds=?, last_started_at=? WHERE id=?')
      .run(snapped, timer.running ? now() : null, timer.id);

    let entry = null;
    const fresh = getTimer.get(timer.id);
    const hours = secondsToHours(snapped, roundingCfg(db));
    if (!fresh.running && fresh.linked_entry_id && hours >= minIncrement(db) - 1e-9) {
      const synced = syncToEntry(db, fresh, hours, todayLocal(clock()), now());
      entry = loadEntry(db, synced.entryId);
    }
    res.json({ timer: withElapsed(getTimer.get(timer.id)), entry });
  });

  return r;
}

export function timerGroupsRouter({ db }) {
  const r = Router();
  const get = db.prepare('SELECT id, name, sort_order, collapsed FROM timer_groups WHERE id=?');

  r.get('/', (req, res) => {
    res.json(db.prepare('SELECT id, name, sort_order, collapsed FROM timer_groups ORDER BY sort_order, id').all());
  });

  r.post('/', (req, res) => {
    const name = String((req.body || {}).name || '').trim();
    if (!name) return res.status(400).json({ error: 'Group name required.' });
    const max = db.prepare('SELECT COALESCE(MAX(sort_order), -1) m FROM timer_groups').get().m;
    const info = db.prepare('INSERT INTO timer_groups (name, sort_order) VALUES (?, ?)').run(name, max + 1);
    res.status(201).json(get.get(info.lastInsertRowid));
  });

  r.put('/order', (req, res) => {
    const ids = (req.body || {}).ids;
    if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids array required.' });
    const upd = db.prepare('UPDATE timer_groups SET sort_order=? WHERE id=?');
    db.transaction(() => ids.forEach((id, i) => upd.run(i, id)))();
    res.json({ ok: true });
  });

  r.patch('/:id', (req, res) => {
    const group = get.get(req.params.id);
    if (!group) return res.status(404).json({ error: 'Group not found.' });
    const b = req.body || {};
    const name = b.name !== undefined ? String(b.name).trim() : group.name;
    if (!name) return res.status(400).json({ error: 'Group name required.' });
    const collapsed = b.collapsed !== undefined ? (b.collapsed ? 1 : 0) : group.collapsed;
    db.prepare('UPDATE timer_groups SET name=?, collapsed=? WHERE id=?').run(name, collapsed, group.id);
    res.json(get.get(group.id));
  });

  r.delete('/:id', (req, res) => {
    const group = get.get(req.params.id);
    if (!group) return res.status(404).json({ error: 'Group not found.' });
    db.transaction(() => {
      db.prepare('UPDATE timers SET group_id=NULL WHERE group_id=?').run(group.id);
      db.prepare('DELETE FROM timer_groups WHERE id=?').run(group.id);
    })();
    res.json({ ok: true });
  });

  return r;
}
