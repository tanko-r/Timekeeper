import { mkdirSync, readdirSync, unlinkSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { getSetting, setSetting } from './db.js';
import { todayLocal } from './lib/dates.js';
import { applyRollovers } from './routes/timers.js';
import { rebuildMatterPeople } from './routes/entries.js';

const UNDO_WINDOW_DAYS = 7;

// One idempotent tick: midnight timer banking, daily backup, purges.
// Called every 30s by startJobs and safe to call ad hoc.
export function runJobs({ db, config, clock }) {
  const today = todayLocal(clock());

  applyRollovers(db, clock);

  const state = getSetting(db, 'jobs_state') || {};
  if (state.lastBackupDate !== today) {
    try {
      backup(db, config, today);
      setSetting(db, 'jobs_state', { ...state, lastBackupDate: today });
    } catch (e) {
      console.error('nightly backup failed:', e.message);
    }
  }

  // One-time (per upgrade) roster backfill: matter_people arrived with the
  // memory-layer migration, but SQL migrations can't run the JS name
  // extractor — so the first tick derives the roster from all existing
  // entries. Re-read jobs_state at write time: the backup block above may
  // have just updated it.
  if (!state.peopleBackfillDone) {
    const matterIds = db.prepare(
      'SELECT DISTINCT cm_id FROM entries WHERE deleted_at IS NULL').all();
    for (const { cm_id } of matterIds) rebuildMatterPeople(db, cm_id);
    setSetting(db, 'jobs_state',
      { ...(getSetting(db, 'jobs_state') || {}), peopleBackfillDone: true });
  }

  const purgeBefore = new Date(clock().getTime() - UNDO_WINDOW_DAYS * 86400_000).toISOString();
  db.prepare('DELETE FROM entries WHERE deleted_at IS NOT NULL AND deleted_at < ?').run(purgeBefore);
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(clock().toISOString());
}

function backup(db, config, today) {
  const dir = join(config.DATA_DIR, 'backups');
  mkdirSync(dir, { recursive: true });
  // Write to a temp name and rename in — a crashed VACUUM must not leave a
  // half-written file blocking every retry that day.
  for (const stale of readdirSync(dir).filter((f) => f.startsWith('.tmp-'))) {
    try { unlinkSync(join(dir, stale)); } catch { /* best effort */ }
  }
  const file = join(dir, `timekeeper-${today}.db`);
  const tmp = join(dir, `.tmp-${today}-${process.pid}.db`);
  db.prepare('VACUUM INTO ?').run(tmp);
  renameSync(tmp, file);

  const keep = (getSetting(db, 'backup') || {}).keep || 14;
  const files = readdirSync(dir).filter((f) => /^timekeeper-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort();
  for (const f of files.slice(0, Math.max(0, files.length - keep))) {
    unlinkSync(join(dir, f));
  }
  console.log(`backup written: ${file}`);
}

export function startJobs(deps) {
  const tick = () => {
    try { runJobs(deps); } catch (e) { console.error('jobs tick failed:', e); }
  };
  tick();
  const handle = setInterval(tick, 30_000);
  handle.unref();
  return handle;
}
