import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const D6 = '[0-9][0-9][0-9][0-9][0-9][0-9]';

const MIGRATIONS = [
  // v1 — initial schema
  `
  CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE cms (
    id           INTEGER PRIMARY KEY,
    cm_number    TEXT NOT NULL UNIQUE CHECK (cm_number GLOB '${D6}-${D6}' AND length(cm_number) = 13),
    short_name   TEXT NOT NULL DEFAULT '',
    billable     INTEGER NOT NULL DEFAULT 1,
    status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
    favorite     INTEGER NOT NULL DEFAULT 0,
    last_used_at TEXT,
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  CREATE TABLE task_codes (
    id         INTEGER PRIMARY KEY,
    name       TEXT NOT NULL UNIQUE,
    sort_order INTEGER NOT NULL DEFAULT 0,
    active     INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE entries (
    id             INTEGER PRIMARY KEY,
    date           TEXT NOT NULL CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    cm_id          INTEGER NOT NULL REFERENCES cms(id),
    narrative      TEXT NOT NULL DEFAULT '',
    billable       INTEGER NOT NULL DEFAULT 1,
    status         TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','finalized')),
    total_override REAL,
    source         TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','timer')),
    ack_validation INTEGER NOT NULL DEFAULT 0,
    ever_finalized INTEGER NOT NULL DEFAULT 0,
    exported_at    TEXT,
    finalized_at   TEXT,
    deleted_at     TEXT,
    created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX idx_entries_date ON entries(date);
  CREATE INDEX idx_entries_cm ON entries(cm_id);

  CREATE TABLE entry_tasks (
    id         INTEGER PRIMARY KEY,
    entry_id   INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
    task_code  TEXT NOT NULL DEFAULT '',
    duration   REAL NOT NULL DEFAULT 0,
    fragment   TEXT NOT NULL DEFAULT '',
    sort_order INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX idx_entry_tasks_entry ON entry_tasks(entry_id);

  CREATE TABLE timers (
    id                  INTEGER PRIMARY KEY,
    name                TEXT NOT NULL,
    cm_id               INTEGER NOT NULL REFERENCES cms(id),
    task_code           TEXT,
    sort_order          INTEGER NOT NULL DEFAULT 0,
    running             INTEGER NOT NULL DEFAULT 0,
    accumulated_seconds INTEGER NOT NULL DEFAULT 0,
    last_started_at     TEXT,
    last_reset_date     TEXT NOT NULL,
    created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  CREATE TABLE sessions (
    token_hash   TEXT PRIMARY KEY,
    created_at   TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    expires_at   TEXT NOT NULL,
    user_agent   TEXT NOT NULL DEFAULT ''
  );

  CREATE TABLE audit_log (
    id         INTEGER PRIMARY KEY,
    entry_id   INTEGER NOT NULL,
    action     TEXT NOT NULL,
    detail     TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  `,
];

const SEED_TASK_CODES = [
  'Review', 'Draft', 'Revise', 'Research', 'Correspondence', 'Call/Conference',
  'Negotiate', 'Travel', 'Court Appearance', 'Due Diligence', 'Closing',
];

const SEED_SETTINGS = {
  validation: {
    minNarrativeChars: 20,
    bannedPhrases: ['work on', 'attention to', 'review file'],
    blockBillingHours: 3.0,
    minIncrement: 0.1,
  },
  rounding: { enabled: true, increment: 0.1, mode: 'nearest' },
  targets: { dailyHours: 8.0 },
  timerStopAction: 'ask',
  idleNudgeHours: 3,
  backup: { keep: 14 },
  auth: { mode: 'remote-only' },
  theme: 'auto',
};

export function openDb(dbPath) {
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(db) {
  const current = db.pragma('user_version', { simple: true });
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
  seed(db);
}

function seed(db) {
  const insCode = db.prepare(
    'INSERT OR IGNORE INTO task_codes (name, sort_order) VALUES (?, ?)');
  const insSetting = db.prepare(
    'INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  db.transaction(() => {
    SEED_TASK_CODES.forEach((name, i) => insCode.run(name, i));
    for (const [key, value] of Object.entries(SEED_SETTINGS)) {
      insSetting.run(key, JSON.stringify(value));
    }
  })();
}

// --- tiny settings helpers used across routes ---
export function getSetting(db, key) {
  const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
  return row ? JSON.parse(row.value) : undefined;
}

export function setSetting(db, key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
  ).run(key, JSON.stringify(value));
}

export function nowIso(clock = () => new Date()) {
  return clock().toISOString();
}
