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
  // v4 — client → matter split: add clients, rename cms→matters, link + backfill
  `
  CREATE TABLE clients (
    id            INTEGER PRIMARY KEY,
    client_number TEXT NOT NULL UNIQUE CHECK (client_number GLOB '${D6}' AND length(client_number) = 6),
    name          TEXT NOT NULL DEFAULT '',
    created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  ALTER TABLE cms RENAME TO matters;
  ALTER TABLE matters ADD COLUMN client_id INTEGER REFERENCES clients(id);
  ALTER TABLE matters ADD COLUMN matter_number TEXT;

  INSERT OR IGNORE INTO clients (client_number)
    SELECT DISTINCT substr(cm_number, 1, 6) FROM matters;

  UPDATE matters SET
    matter_number = substr(cm_number, 8, 6),
    client_id = (SELECT c.id FROM clients c WHERE c.client_number = substr(matters.cm_number, 1, 6));

  CREATE UNIQUE INDEX idx_matters_client_matter ON matters(client_id, matter_number);
  `,
  // memory layer (spec §5): per-matter people roster cache. Derived from
  // entries — rebuilt by the app on entry writes; backfilled from existing
  // history on the first jobs tick after upgrade (SQL can't run the JS
  // extractor, so the backfill lives in jobs.js, not here).
  // last_seen_at stores the ENTRY DATE (YYYY-MM-DD), not a wall clock.
  `
  CREATE TABLE matter_people (
    id           INTEGER PRIMARY KEY,
    matter_id    INTEGER NOT NULL REFERENCES matters(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    count        INTEGER NOT NULL DEFAULT 0,
    last_seen_at TEXT,
    UNIQUE(matter_id, name)
  );
  `,
  // Phase 3 (spec §6): user-defined text-expansion shortcuts — a deterministic
  // abbreviation → phrase dictionary, distinct from the derived phrasebook.
  // abbrev is case-insensitively unique ("ia" and "IA" are the same shortcut).
  // Expansion itself runs in the browser (public/js/lib/expand.js); this is
  // just the store, built IN-FLOW via select-text → "save as shortcut".
  `
  CREATE TABLE shortcuts (
    id         INTEGER PRIMARY KEY,
    abbrev     TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK (length(abbrev) > 0),
    phrase     TEXT NOT NULL CHECK (length(phrase) > 0),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  `,
  // Phase 3 (spec §6): a likely narrative pre-computed at timer START so it's
  // ready before stop — the phrasebook top hit lands synchronously, and an
  // optional background local-LLM pass refines it while the session runs.
  // Stored on the timer row (not in memory / localStorage): survives server
  // restarts, works when start and stop come from different devices, and
  // gives the async refinement a durable place to write.
  `
  ALTER TABLE timers ADD COLUMN suggested_narrative TEXT;
  `,
  // Entry editor rework (2026-07-09): per-client billing style. 1 = task-billed
  // — consolidated narratives carry per-task time allocations in parens, e.g.
  // "Review lease (0.5)" (today's behavior, preserved for all existing
  // clients). 0 = block-billed — fragments are joined without allocations.
  // David flips individual clients to 0 himself; new clients default to 1.
  `
  ALTER TABLE clients ADD COLUMN task_billing INTEGER NOT NULL DEFAULT 1;
  `,
  // Entry editor rework Task 4 (2026-07-09): durable manual-narrative flag.
  // 1 = the user detached the narrative from its task lines (typed over the
  // AUTO box until it no longer parses back); syncNarrative must leave the
  // stored text alone from then on instead of regenerating it on every
  // task-touching save. 0 (default) = today's behavior — keep regenerating.
  `
  ALTER TABLE entries ADD COLUMN narrative_manual INTEGER NOT NULL DEFAULT 0;
  `,
  // Quick timers (2026-07-09): a timer may exist without a client/matter —
  // just time and an optional caption; a matter gets assigned later and the
  // held time files on the next stop. SQLite can't drop NOT NULL in place,
  // so rebuild the table with cm_id nullable (column set matches v1 + the
  // ALTERs from v2/v5).
  `
  CREATE TABLE timers_new (
    id                  INTEGER PRIMARY KEY,
    name                TEXT NOT NULL,
    cm_id               INTEGER REFERENCES matters(id),
    task_code           TEXT,
    sort_order          INTEGER NOT NULL DEFAULT 0,
    running             INTEGER NOT NULL DEFAULT 0,
    accumulated_seconds INTEGER NOT NULL DEFAULT 0,
    last_started_at     TEXT,
    last_reset_date     TEXT NOT NULL,
    created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    group_id            INTEGER REFERENCES timer_groups(id),
    linked_entry_id     INTEGER,
    last_stopped_at     TEXT,
    suggested_narrative TEXT
  );
  INSERT INTO timers_new (id, name, cm_id, task_code, sort_order, running,
    accumulated_seconds, last_started_at, last_reset_date, created_at,
    group_id, linked_entry_id, last_stopped_at, suggested_narrative)
    SELECT id, name, cm_id, task_code, sort_order, running,
      accumulated_seconds, last_started_at, last_reset_date, created_at,
      group_id, linked_entry_id, last_stopped_at, suggested_narrative
    FROM timers;
  DROP TABLE timers;
  ALTER TABLE timers_new RENAME TO timers;
  `,
  // held_since: the day an unassigned quick timer's carried-over clock came
  // from (set at the midnight rollover, cleared on assign/zero) — lets the
  // UI say WHY a timer from yesterday is still sitting there.
  'ALTER TABLE timers ADD COLUMN held_since TEXT;',
  // AOT float window (2026-07-13 spec): pinned keeps a timer in the PiP list
  // across days; draft_narrative stashes narrative text typed before an entry
  // exists (consumed by the next entry the timer creates).
  `ALTER TABLE timers ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE timers ADD COLUMN draft_narrative TEXT;`,
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
