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
  for (const t of ['settings', 'cms', 'task_codes', 'entries', 'entry_tasks', 'timers', 'sessions', 'audit_log']) {
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
    "INSERT INTO cms (cm_number, short_name, billable) VALUES (?, ?, 1)");
  assert.throws(() => ins.run('12345-123456', 'bad'), /CHECK/);
  assert.throws(() => ins.run('abcdef-123456', 'bad'), /CHECK/);
  ins.run('123456-654321', 'good');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM cms').get().c, 1);
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
  db.prepare("INSERT INTO cms (cm_number, short_name, billable) VALUES ('111111-222222', 'x', 1)").run();
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
  // simulate a pre-v3 database that still has nearest-rounding
  db1.prepare(`UPDATE settings SET value='{"enabled":true,"increment":0.1,"mode":"nearest"}' WHERE key='rounding'`).run();
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
