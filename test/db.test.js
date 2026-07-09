process.env.TZ = 'America/Los_Angeles';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../server/db.js';

function tempDbPath() {
  const dir = mkdtempSync(join(tmpdir(), 'tk-db-'));
  return { path: join(dir, 't.db'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('schema v1: all tables exist', () => {
  const db = openDb(':memory:');
  const names = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
  for (const t of ['settings', 'matters', 'task_codes', 'entries', 'entry_tasks', 'timers', 'sessions', 'audit_log']) {
    assert.ok(names.includes(t), `missing table ${t}`);
  }
  db.close();
});

test('task codes seeded in order', () => {
  const db = openDb(':memory:');
  const codes = db.prepare('SELECT name FROM task_codes ORDER BY sort_order').all().map(r => r.name);
  assert.equal(codes.length, 11);
  assert.equal(codes[0], 'Review');
  assert.ok(codes.includes('Court Appearance'));
  assert.equal(codes[10], 'Closing');
  db.close();
});

test('settings defaults seeded as JSON', () => {
  const db = openDb(':memory:');
  const get = (k) => JSON.parse(db.prepare('SELECT value FROM settings WHERE key=?').get(k).value);
  assert.equal(get('validation').minNarrativeChars, 20);
  assert.deepEqual(get('validation').bannedPhrases, ['work on', 'attention to', 'review file']);
  assert.equal(get('validation').blockBillingHours, 3.0);
  assert.equal(get('validation').minIncrement, 0.1);
  assert.equal(get('rounding').increment, 0.1);
  assert.equal(get('rounding').mode, 'up');
  assert.equal(get('targets').dailyHours, 8.0);
  assert.equal(get('idleNudgeHours'), 3);
  assert.equal(get('backup').keep, 14);
  assert.equal(get('auth').mode, 'remote-only');
  assert.equal(get('ai').enabled, false);
  assert.equal(get('ai').model, 'llama3.1:8b');
  assert.equal(get('tim').timekeeperId, '1001');
  db.close();
});

test('reopening an existing db is idempotent (no duplicate seeds)', () => {
  const { path, cleanup } = tempDbPath();
  const db1 = openDb(path);
  db1.close();
  const db2 = openDb(path);
  const n = db2.prepare('SELECT COUNT(*) c FROM task_codes').get().c;
  assert.equal(n, 11);
  db2.close();
  cleanup();
});

test('cm_number format enforced by CHECK constraint', () => {
  const db = openDb(':memory:');
  const ins = db.prepare(
    "INSERT INTO matters (cm_number, short_name, billable) VALUES (?, ?, 1)");
  assert.throws(() => ins.run('12345-123456', 'bad'), /CHECK/);
  assert.throws(() => ins.run('abcdef-123456', 'bad'), /CHECK/);
  ins.run('123456-654321', 'good');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM matters').get().c, 1);
  db.close();
});

test('foreign keys enforced', () => {
  const db = openDb(':memory:');
  assert.throws(() =>
    db.prepare(
      "INSERT INTO entries (date, cm_id, narrative, billable, status, source) VALUES ('2026-07-06', 999, '', 1, 'draft', 'manual')"
    ).run(), /FOREIGN KEY/);
  db.close();
});

test('deleting an entry cascades to its task lines', () => {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO matters (cm_number, short_name, billable) VALUES ('111111-222222', 'x', 1)").run();
  const e = db.prepare(
    "INSERT INTO entries (date, cm_id, narrative, billable, status, source) VALUES ('2026-07-06', 1, 'n', 1, 'draft', 'manual')"
  ).run();
  db.prepare(
    "INSERT INTO entry_tasks (entry_id, task_code, duration, fragment, sort_order) VALUES (?, 'Review', 1.0, '', 0)"
  ).run(e.lastInsertRowid);
  db.prepare('DELETE FROM entries WHERE id=?').run(e.lastInsertRowid);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM entry_tasks').get().c, 0);
  db.close();
});

test('migration v3 flips a pre-existing rounding mode to up', () => {
  const { path, cleanup } = tempDbPath();
  const db1 = openDb(path);
  // simulate a pre-v3 database that still has nearest-rounding; also undo v4's
  // and v5's schema changes (openDb ran all migrations fresh) so reopening
  // replays v3, v4, v5 cleanly instead of re-creating already-existing objects.
  db1.prepare(`UPDATE settings SET value='{"enabled":true,"increment":0.1,"mode":"nearest"}' WHERE key='rounding'`).run();
  db1.exec(`
    DROP TABLE matter_people;
    DROP INDEX idx_matters_client_matter;
    ALTER TABLE matters DROP COLUMN matter_number;
    ALTER TABLE matters DROP COLUMN client_id;
    ALTER TABLE matters RENAME TO cms;
    DROP TABLE clients;
  `);
  db1.pragma('user_version = 2');
  db1.close();
  const db2 = openDb(path);
  assert.equal(JSON.parse(db2.prepare("SELECT value FROM settings WHERE key='rounding'").get().value).mode, 'up');
  db2.close();
  cleanup();
});

test('deleting a seeded task code survives reopen (no resurrection)', () => {
  const { path, cleanup } = tempDbPath();
  const db1 = openDb(path);
  db1.prepare("DELETE FROM task_codes WHERE name='Travel'").run();
  db1.close();
  const db2 = openDb(path);
  assert.equal(db2.prepare("SELECT COUNT(*) c FROM task_codes WHERE name='Travel'").get().c, 0);
  assert.equal(db2.prepare('SELECT COUNT(*) c FROM task_codes').get().c, 10);
  db2.close();
  cleanup();
});

test('schema v4: clients table exists and matters replaces cms', () => {
  const db = openDb(':memory:');
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
  assert.ok(names.includes('clients'), 'missing clients table');
  assert.ok(names.includes('matters'), 'missing matters table');
  assert.ok(!names.includes('cms'), 'cms should have been renamed to matters');
  db.close();
});

test('migration v4 backfills clients and links matters', () => {
  const { path, cleanup } = tempDbPath();
  const db1 = openDb(path);
  // simulate a pre-v4 database with cms rows: fully undo v4's schema changes
  // (index + added columns must go before the rename, or SQLite refuses to
  // drop the indexed/referenced columns; then drop clients and v5's
  // matter_people (openDb ran all migrations fresh) and roll back
  // user_version so reopening replays v4 and v5 against a genuine pre-v4 shape).
  db1.exec(`
    DROP TABLE matter_people;
    DROP INDEX idx_matters_client_matter;
    ALTER TABLE matters DROP COLUMN matter_number;
    ALTER TABLE matters DROP COLUMN client_id;
    ALTER TABLE matters RENAME TO cms;
    DROP TABLE clients;
  `);
  db1.pragma('user_version = 3');
  db1.prepare("INSERT INTO cms (cm_number, short_name, billable) VALUES ('100001-000012', 'Acme lease', 1)").run();
  db1.prepare("INSERT INTO cms (cm_number, short_name, billable) VALUES ('100001-000099', 'Acme merger', 1)").run();
  db1.close();

  const db2 = openDb(path); // reopen → runs v4 again on the faked-old db
  const clients = db2.prepare('SELECT client_number, name FROM clients ORDER BY client_number').all();
  assert.deepEqual(clients, [{ client_number: '100001', name: '' }]); // one distinct client, blank name
  const matters = db2.prepare('SELECT cm_number, matter_number, client_id FROM matters ORDER BY cm_number').all();
  assert.equal(matters.length, 2);
  assert.equal(matters[0].matter_number, '000012');
  assert.ok(matters[0].client_id, 'matter must be linked to a client');
  assert.equal(matters[0].client_id, matters[1].client_id, 'same client for both matters');
  db2.close();
  cleanup();
});

test('client_number format enforced by CHECK', () => {
  const db = openDb(':memory:');
  const ins = db.prepare("INSERT INTO clients (client_number) VALUES (?)");
  assert.throws(() => ins.run('12345'), /CHECK/);
  assert.throws(() => ins.run('abcdef'), /CHECK/);
  ins.run('654321');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM clients').get().c, 1);
  db.close();
});

test('memory-layer migration: matter_people table, unique per-matter names, cascade', () => {
  const db = openDb(':memory:');
  const cols = db.prepare('PRAGMA table_info(matter_people)').all().map((c) => c.name);
  assert.deepEqual(cols, ['id', 'matter_id', 'name', 'count', 'last_seen_at']);
  db.prepare("INSERT INTO matters (cm_number, short_name, billable) VALUES ('111111-000001', 'x', 1)").run();
  const ins = db.prepare(
    "INSERT INTO matter_people (matter_id, name, count, last_seen_at) VALUES (1, 'M. Smith', 1, '2026-07-01')");
  ins.run();
  assert.throws(() => ins.run(), /UNIQUE/);
  db.prepare('DELETE FROM matters WHERE id=1').run();
  assert.equal(db.prepare('SELECT COUNT(*) c FROM matter_people').get().c, 0, 'cascade on matter delete');
  db.close();
});

test('memory-layer migration replays cleanly on a pre-upgrade db', () => {
  const { path, cleanup } = tempDbPath();
  const db1 = openDb(path);
  // fake a db from just before this migration: drop the new table and roll
  // user_version back by one (positional — no hardcoded version numbers)
  const v = db1.pragma('user_version', { simple: true });
  db1.exec('DROP TABLE matter_people');
  db1.pragma(`user_version = ${v - 1}`);
  db1.close();
  const db2 = openDb(path);
  assert.ok(db2.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='matter_people'").get());
  db2.close();
  cleanup();
});
