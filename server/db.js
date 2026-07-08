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

  -- Task codes seed once with the schema; deleting one must stick across
  -- restarts, so this is a migration, not a reseed.
  INSERT INTO task_codes (name, sort_order) VALUES
    ('Review', 0), ('Draft', 1), ('Revise', 2), ('Research', 3),
    ('Correspondence', 4), ('Call/Conference', 5), ('Negotiate', 6),
    ('Travel', 7), ('Court Appearance', 8), ('Due Diligence', 9),
    ('Closing', 10);
  `,
  // v2 — timer groups + day-accumulator timer model (round 2)
  `
  CREATE TABLE timer_groups (
    id         INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    collapsed  INTEGER NOT NULL DEFAULT 0
  );
  ALTER TABLE timers ADD COLUMN group_id INTEGER REFERENCES timer_groups(id);
  ALTER TABLE timers ADD COLUMN linked_entry_id INTEGER;
  ALTER TABLE timers ADD COLUMN last_stopped_at TEXT;
  `,
  // v3 — house rule: all time rounds UP to the next tenth
  `
  UPDATE settings SET value = json_set(value, '$.mode', 'up') WHERE key = 'rounding';
  `,
];

const SEED_SETTINGS = {
  validation: {
    minNarrativeChars: 20,
    bannedPhrases: ['work on', 'attention to', 'review file'],
    blockBillingHours: 3.0,
    minIncrement: 0.1,
  },
  rounding: { enabled: true, increment: 0.1, mode: 'up' },
  targets: { dailyHours: 8.0 },
  idleNudgeHours: 3,
  backup: { keep: 14 },
  auth: { mode: 'remote-only' },
  theme: 'auto',
  // Local-LLM narrative assist (Ollama). Off until enabled in Settings.
  ai: { enabled: false, model: 'llama3.1:8b', url: 'http://127.0.0.1:11434' },
  // DTE Axiom / Intapp TimeSaver .TIM export constants (from David's prototype).
  tim: { email: 'TIMEKEEPER@EXAMPLE.COM', timekeeperId: '1001', u2: 'GEN01' },
  // CSV timer import: matters whose Group matches one of these (case-insensitive)
  // are created non-billable (firm/internal time).
  import: { nonBillableGroups: ['firm', 'internal'] },
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

// Settings reseed on every open (INSERT OR IGNORE) so new settings keys added
// in upgrades appear with defaults; task codes seed via migration only.
function seed(db) {
  const insSetting = db.prepare(
    'INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  db.transaction(() => {
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
