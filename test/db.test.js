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
  // simulate a pre-v3 database that still has nearest-rounding; also undo
  // every later migration's schema changes (openDb ran all migrations fresh)
  // so reopening replays them cleanly instead of re-creating existing objects.
  // entries survives every later migration untouched (only ever gains ADD
  // COLUMNs, never dropped/recreated), so its added columns must be dropped
  // explicitly too, or replaying entry-editor-rework Task 4's ADD COLUMN
  // against a column that's still there errors "duplicate column name".
  db1.prepare(`UPDATE settings SET value='{"enabled":true,"increment":0.1,"mode":"nearest"}' WHERE key='rounding'`).run();
  db1.exec(`
    ALTER TABLE entries DROP COLUMN narrative_manual;
    ALTER TABLE timers DROP COLUMN suggested_narrative;
    DROP TABLE shortcuts;
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
  // drop the indexed/referenced columns; then drop the later migrations'
  // tables (openDb ran all migrations fresh) and roll back user_version so
  // reopening replays v4 onward against a genuine pre-v4 shape). entries
  // survives untouched across all of this, so its later ADD COLUMN
  // (narrative_manual) must be dropped too or the replay errors on it.
  db1.exec(`
    ALTER TABLE entries DROP COLUMN narrative_manual;
    ALTER TABLE timers DROP COLUMN suggested_narrative;
    DROP TABLE shortcuts;
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
  // fake a db from just before this migration: undo everything added by the
  // last nine migrations (matter_people, phase-3's shortcuts, phase-3's
  // timers column, entry-editor-rework's clients.task_billing column, Task
  // 4's entries.narrative_manual column, the quick-timer timers rebuild and
  // the entries rebuild — which need no undo SQL: replaying a rebuild is
  // schema-idempotent, its only effect is making cm_id nullable — the
  // timers.held_since column, the AOT-window timers.pinned/
  // draft_narrative columns, and the timers.narrative_template column) and
  // roll user_version back by ten (positional — no hardcoded version numbers)
  const v = db1.pragma('user_version', { simple: true });
  db1.exec(`
    ALTER TABLE timers DROP COLUMN narrative_template;
    ALTER TABLE timers DROP COLUMN draft_narrative;
    ALTER TABLE timers DROP COLUMN pinned;
    ALTER TABLE timers DROP COLUMN held_since;
    ALTER TABLE entries DROP COLUMN narrative_manual;
    ALTER TABLE clients DROP COLUMN task_billing;
    ALTER TABLE timers DROP COLUMN suggested_narrative;
    DROP TABLE shortcuts;
    DROP TABLE matter_people;
  `);
  db1.pragma(`user_version = ${v - 10}`);
  db1.close();
  const db2 = openDb(path);
  assert.ok(db2.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='matter_people'").get());
  assert.ok(db2.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='shortcuts'").get());
  assert.ok(db2.prepare('PRAGMA table_info(timers)').all()
    .some((c) => c.name === 'suggested_narrative'));
  assert.ok(db2.prepare('PRAGMA table_info(clients)').all()
    .some((c) => c.name === 'task_billing'));
  assert.ok(db2.prepare('PRAGMA table_info(entries)').all()
    .some((c) => c.name === 'narrative_manual'));
  assert.equal(db2.prepare('PRAGMA table_info(timers)').all()
    .find((c) => c.name === 'cm_id').notnull, 0, 'quick-timer rebuild made cm_id nullable');
  assert.ok(db2.prepare('PRAGMA table_info(timers)').all()
    .some((c) => c.name === 'draft_narrative'), 'AOT-window columns replayed');
  db2.close();
  cleanup();
});

test('phase-3 migration: shortcuts table with case-insensitive unique abbrev', () => {
  const db = openDb(':memory:');
  const cols = db.prepare('PRAGMA table_info(shortcuts)').all().map((c) => c.name);
  assert.deepEqual(cols, ['id', 'abbrev', 'phrase', 'created_at']);
  db.prepare("INSERT INTO shortcuts (abbrev, phrase) VALUES ('IA', 'Interconnect Agreement')").run();
  assert.throws(() => db.prepare("INSERT INTO shortcuts (abbrev, phrase) VALUES ('ia', 'dup')").run(), /UNIQUE/);
  db.close();
});

test('phase-3 migration: timers gain suggested_narrative', () => {
  const db = openDb(':memory:');
  const cols = db.prepare('PRAGMA table_info(timers)').all().map((c) => c.name);
  assert.ok(cols.includes('suggested_narrative'));
  db.close();
});

test('entry-editor-rework migration: clients gain task_billing, defaults to 1 (task-billed)', () => {
  const db = openDb(':memory:');
  const cols = db.prepare('PRAGMA table_info(clients)').all().map((c) => c.name);
  assert.ok(cols.includes('task_billing'));
  db.prepare("INSERT INTO clients (client_number) VALUES ('999999')").run();
  assert.equal(
    db.prepare("SELECT task_billing FROM clients WHERE client_number='999999'").get().task_billing, 1);
  db.close();
});

test('task_billing column accepts 0 for block-billing clients', () => {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO clients (client_number, task_billing) VALUES ('888888', 0)").run();
  assert.equal(
    db.prepare("SELECT task_billing FROM clients WHERE client_number='888888'").get().task_billing, 0);
  db.close();
});

test('entry-editor-rework Task 4 migration: entries gain narrative_manual, defaults to 0', () => {
  const db = openDb(':memory:');
  const cols = db.prepare('PRAGMA table_info(entries)').all().map((c) => c.name);
  assert.ok(cols.includes('narrative_manual'));
  db.prepare("INSERT INTO matters (cm_number, short_name, billable) VALUES ('111111-333333', 'x', 1)").run();
  const e = db.prepare(
    "INSERT INTO entries (date, cm_id, narrative, billable, status, source) VALUES ('2026-07-06', 1, 'n', 1, 'draft', 'manual')"
  ).run();
  assert.equal(
    db.prepare('SELECT narrative_manual FROM entries WHERE id=?').get(e.lastInsertRowid).narrative_manual, 0);
  db.close();
});

test('entries-rebuild migration: cm_id nullable, data + task lines survive, held_since cleared', () => {
  const { path, cleanup } = tempDbPath();
  const db1 = openDb(path);
  // Populate a realistic pre-migration state, then roll user_version back by
  // one and replay: the rebuild is schema-idempotent, so replaying it against
  // live rows proves data survives the DROP TABLE round-trip (entry_tasks
  // would be emptied by the ON DELETE CASCADE if the backup step regressed).
  db1.prepare("INSERT INTO matters (cm_number, short_name, billable) VALUES ('100001-000012', 'Acme lease', 1)").run();
  const eid = db1.prepare(`INSERT INTO entries (date, cm_id, narrative, status, source, total_override)
    VALUES ('2026-07-10', 1, 'Reviewed lease.', 'draft', 'timer', 0.5)`).run().lastInsertRowid;
  db1.prepare("INSERT INTO entry_tasks (entry_id, task_code, duration, fragment, sort_order) VALUES (?, 'Review', 0.5, 'lease', 0)").run(eid);
  db1.prepare(`INSERT INTO timers (name, last_reset_date, held_since, accumulated_seconds)
    VALUES ('Quick timer', '2026-07-11', '2026-07-10', 1800)`).run();
  // narrative_template landed after the rebuild — undo it too so the replay
  // window (rebuild + template column) applies cleanly
  db1.exec('ALTER TABLE timers DROP COLUMN narrative_template');
  const v = db1.pragma('user_version', { simple: true });
  db1.pragma(`user_version = ${v - 2}`);
  db1.close();

  const db2 = openDb(path);
  assert.equal(db2.prepare('PRAGMA table_info(entries)').all()
    .find((c) => c.name === 'cm_id').notnull, 0, 'entries.cm_id is nullable');
  const e = db2.prepare('SELECT * FROM entries WHERE id=?').get(eid);
  assert.equal(e.narrative, 'Reviewed lease.');
  assert.equal(e.total_override, 0.5);
  const tasks = db2.prepare('SELECT * FROM entry_tasks WHERE entry_id=?').all(eid);
  assert.equal(tasks.length, 1, 'task lines survived the rebuild');
  assert.equal(tasks[0].fragment, 'lease');
  assert.equal(db2.prepare('SELECT held_since FROM timers WHERE id=1').get().held_since, null,
    'held_since retired — the held-time model is gone');
  // matterless entries are now legal; bogus matters still are not
  db2.prepare("INSERT INTO entries (date, cm_id, narrative, status, source) VALUES ('2026-07-13', NULL, '', 'draft', 'timer')").run();
  assert.throws(() => db2.prepare(
    "INSERT INTO entries (date, cm_id, narrative, status, source) VALUES ('2026-07-13', 999, '', 'draft', 'timer')").run(), /FOREIGN KEY/);
  // the rebuilt table kept its indexes and the entry_tasks cascade
  const idx = db2.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='entries'").all().map((r) => r.name);
  assert.ok(idx.includes('idx_entries_date') && idx.includes('idx_entries_cm'), 'indexes recreated');
  db2.prepare('DELETE FROM entries WHERE id=?').run(eid);
  assert.equal(db2.prepare('SELECT COUNT(*) c FROM entry_tasks WHERE entry_id=?').get(eid).c, 0, 'cascade intact');
  db2.close();
  cleanup();
});

test('v15 custom_fields: exactly one owner, unique name per owner, value cascade', () => {
  const db = openDb(':memory:');
  const clientId = db.prepare("INSERT INTO clients (client_number) VALUES ('123456')").run().lastInsertRowid;
  const matterId = db.prepare(
    "INSERT INTO matters (cm_number, client_id, matter_number) VALUES ('123456-000001', ?, '000001')"
  ).run(clientId).lastInsertRowid;

  // neither owner / both owners → CHECK violation
  assert.throws(() => db.prepare("INSERT INTO custom_fields (name) VALUES ('Phase')").run());
  assert.throws(() => db.prepare(
    "INSERT INTO custom_fields (client_id, matter_id, name) VALUES (?, ?, 'Phase')").run(clientId, matterId));

  const fieldId = db.prepare(
    "INSERT INTO custom_fields (client_id, name, type, options) VALUES (?, 'Phase', 'select', '[\"P100\",\"P200\"]')"
  ).run(clientId).lastInsertRowid;
  // duplicate name on the same owner → UNIQUE violation; same name on the matter is fine (override)
  assert.throws(() => db.prepare(
    "INSERT INTO custom_fields (client_id, name) VALUES (?, 'Phase')").run(clientId));
  db.prepare("INSERT INTO custom_fields (matter_id, name) VALUES (?, 'Phase')").run(matterId);

  // entry values cascade with the entry
  const entryId = db.prepare(
    "INSERT INTO entries (date, cm_id) VALUES ('2026-07-15', ?)").run(matterId).lastInsertRowid;
  db.prepare('INSERT INTO entry_custom_values (entry_id, field_id, value) VALUES (?, ?, ?)')
    .run(entryId, fieldId, 'P100');
  assert.throws(() => db.prepare( // one value per (entry, field)
    'INSERT INTO entry_custom_values (entry_id, field_id, value) VALUES (?, ?, ?)').run(entryId, fieldId, 'P200'));
  db.prepare('DELETE FROM entries WHERE id=?').run(entryId);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM entry_custom_values').get().c, 0);
  db.close();
});
