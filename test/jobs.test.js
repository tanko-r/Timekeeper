process.env.TZ = 'America/Los_Angeles';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, setSetting } from '../server/db.js';
import { runJobs } from '../server/jobs.js';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'tk-jobs-'));
  const db = openDb(join(dir, 't.db'));
  const config = { DATA_DIR: dir };
  db.prepare("INSERT INTO matters (cm_number, short_name, billable) VALUES ('100001-000012', 'Acme', 1)").run();
  return { dir, db, config, cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

const at = (iso) => () => new Date(iso);

test('runJobs banks stale timers via rollover', () => {
  const { db, config, cleanup } = setup();
  try {
    db.prepare(`INSERT INTO timers (name, cm_id, task_code, last_reset_date, accumulated_seconds, running)
      VALUES ('T', 1, 'Draft', '2026-07-05', 3600, 0)`).run();
    runJobs({ db, config, clock: at('2026-07-06T08:00:00-07:00') });
    const banked = db.prepare("SELECT * FROM entries WHERE date='2026-07-05'").all();
    assert.equal(banked.length, 1);
    assert.equal(banked[0].source, 'timer');
    const timer = db.prepare('SELECT * FROM timers').get();
    assert.equal(timer.accumulated_seconds, 0);
    assert.equal(timer.last_reset_date, '2026-07-06');
  } finally { cleanup(); }
});

test('nightly backup: once per day, pruned to keep-N', () => {
  const { db, config, cleanup, dir } = setup();
  try {
    setSetting(db, 'backup', { keep: 2 });
    const backups = () => readdirSync(join(dir, 'backups')).sort();

    runJobs({ db, config, clock: at('2026-07-06T00:10:00-07:00') });
    runJobs({ db, config, clock: at('2026-07-06T12:00:00-07:00') }); // same day → no second file
    assert.deepEqual(backups(), ['timekeeper-2026-07-06.db']);

    runJobs({ db, config, clock: at('2026-07-07T00:10:00-07:00') });
    assert.equal(backups().length, 2);

    runJobs({ db, config, clock: at('2026-07-08T00:10:00-07:00') });
    assert.deepEqual(backups(), ['timekeeper-2026-07-07.db', 'timekeeper-2026-07-08.db']);
  } finally { cleanup(); }
});

test('soft-deleted entries older than 7 days are purged, recent kept', () => {
  const { db, config, cleanup } = setup();
  try {
    const ins = db.prepare(`INSERT INTO entries (date, cm_id, narrative, billable, status, source, deleted_at)
      VALUES ('2026-07-01', 1, 'n', 1, 'draft', 'manual', ?)`);
    ins.run('2026-06-27T10:00:00Z'); // 9 days before clock → purge
    ins.run('2026-07-05T10:00:00Z'); // 1 day before clock → keep
    runJobs({ db, config, clock: at('2026-07-06T08:00:00-07:00') });
    const rows = db.prepare('SELECT deleted_at FROM entries').all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].deleted_at, '2026-07-05T10:00:00Z');
  } finally { cleanup(); }
});

test('expired sessions pruned', () => {
  const { db, config, cleanup } = setup();
  try {
    const ins = db.prepare(
      'INSERT INTO sessions (token_hash, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?)');
    ins.run('old', '2026-06-01T00:00:00Z', '2026-06-01T00:00:00Z', '2026-07-01T00:00:00Z');
    ins.run('live', '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z', '2026-08-01T00:00:00Z');
    runJobs({ db, config, clock: at('2026-07-06T08:00:00-07:00') });
    assert.deepEqual(db.prepare('SELECT token_hash FROM sessions').all().map((r) => r.token_hash), ['live']);
  } finally { cleanup(); }
});

test('first jobs tick backfills matter_people from existing entries', () => {
  const { db, config, cleanup } = setup();
  try {
    // rows written before the memory layer existed → no roster yet
    db.prepare(`INSERT INTO entries (date, cm_id, narrative, billable, status, source)
      VALUES ('2026-07-01', 1, 'Telephone conference with B. Novak regarding access road.', 1, 'draft', 'manual')`).run();
    assert.equal(db.prepare('SELECT COUNT(*) c FROM matter_people').get().c, 0);

    runJobs({ db, config, clock: at('2026-07-06T08:00:00-07:00') });
    assert.deepEqual(
      db.prepare('SELECT matter_id, name, count, last_seen_at FROM matter_people').all(),
      [{ matter_id: 1, name: 'B. Novak', count: 1, last_seen_at: '2026-07-01' }]);

    // second tick is a no-op (flag set), not a duplicate or reset
    runJobs({ db, config, clock: at('2026-07-06T09:00:00-07:00') });
    assert.equal(db.prepare('SELECT COUNT(*) c FROM matter_people').get().c, 1);
  } finally { cleanup(); }
});
