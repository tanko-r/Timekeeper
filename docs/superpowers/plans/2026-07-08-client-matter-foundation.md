# Client/Matter Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the flat `cms` table into a proper client → matter data model — a new `clients` table, `cms` renamed to `matters` with `client_id`/`matter_number`, and a `/api/clients` API — while the app keeps behaving identically.

**Architecture:** A v4 SQLite migration renames `cms`→`matters` (SQLite 3.53 auto-updates the `entries.cm_id`/`timers.cm_id` foreign-key references), adds a `clients` table, and backfills a blank-named client per distinct client-number prefix. A pure `cmNumber` helper centralizes the derived `xxxxxx-xxxxxx` string. Every matter-creation path ensures its client exists. The existing `/api/cms` route keeps its name and its `cm_number`/`short_name`/`cm_id` fields, so the frontend is untouched by this phase.

**Tech Stack:** Node 24 ESM, Express 5, better-sqlite3 (WAL, SQLite 3.53), `node:test`. No build step. No new runtime dependencies.

## Global Constraints

- Runtime deps stay exactly `express` + `better-sqlite3`. Do not add any dependency.
- Schema changes = **append** a migration to the `MIGRATIONS` array in `server/db.js`, guarded by `PRAGMA user_version`. **Never mutate an existing migration** (migration v1's `CREATE TABLE cms` stays exactly as-is; the rename happens only in the new v4).
- Business logic goes in `server/lib/*` as **pure functions** with `node:test` unit tests. Routes stay thin. All writes go through prepared statements.
- Client and matter numbers are 6 digits; CM# is the derived string `client_number-matter_number` (`xxxxxx-xxxxxx`). Export/CSV/`.TIM` shape must not change.
- Tests run with `npm test` (`node --test test/*.test.js`). The **entire suite must be green at the end of every task.**
- Dates are local `YYYY-MM-DD`; box TZ `America/Los_Angeles` (tests set `process.env.TZ`).
- This plan is **Phase 1a (data foundation)**. The client-aware CM picker UI (spec §3.4) and the timer-grid grouping selector (spec §4) are **Phase 1b — a separate follow-on plan**, and are intentionally out of scope here.

---

### Task 1: `cmNumber` helper library

**Files:**
- Create: `server/lib/cmNumber.js`
- Test: `test/cmNumber.test.js`

**Interfaces:**
- Produces:
  - `buildCmNumber(clientNumber: string, matterNumber: string): string` → `"100001-000012"`
  - `splitCmNumber(cm: string): { clientNumber: string, matterNumber: string } | null`
  - `SIX: RegExp` — matches exactly 6 digits.

- [ ] **Step 1: Write the failing test**

Create `test/cmNumber.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCmNumber, splitCmNumber, SIX } from '../server/lib/cmNumber.js';

test('buildCmNumber joins client and matter with a hyphen', () => {
  assert.equal(buildCmNumber('100001', '000012'), '100001-000012');
});

test('splitCmNumber parses a valid CM number', () => {
  assert.deepEqual(splitCmNumber('100001-000012'), { clientNumber: '100001', matterNumber: '000012' });
});

test('splitCmNumber returns null for malformed input', () => {
  assert.equal(splitCmNumber('123-456'), null);
  assert.equal(splitCmNumber('abcdef-000012'), null);
  assert.equal(splitCmNumber('1045330-00012'), null);
  assert.equal(splitCmNumber(''), null);
  assert.equal(splitCmNumber(null), null);
});

test('round-trips', () => {
  const cm = '222222-000001';
  const { clientNumber, matterNumber } = splitCmNumber(cm);
  assert.equal(buildCmNumber(clientNumber, matterNumber), cm);
});

test('SIX matches exactly six digits', () => {
  assert.ok(SIX.test('000000'));
  assert.ok(!SIX.test('00000'));
  assert.ok(!SIX.test('0000000'));
  assert.ok(!SIX.test('12345a'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/cmNumber.test.js`
Expected: FAIL — `Cannot find module '../server/lib/cmNumber.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `server/lib/cmNumber.js`:

```js
// The CM number (client/matter) is the derived string client_number-matter_number,
// e.g. "100001-000012". Client and matter numbers are each exactly six digits.
export const SIX = /^\d{6}$/;

export function buildCmNumber(clientNumber, matterNumber) {
  return `${clientNumber}-${matterNumber}`;
}

export function splitCmNumber(cm) {
  const m = /^(\d{6})-(\d{6})$/.exec(String(cm ?? ''));
  return m ? { clientNumber: m[1], matterNumber: m[2] } : null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/cmNumber.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add server/lib/cmNumber.js test/cmNumber.test.js
git commit -m "feat(lib): cmNumber build/split helper for client-matter split"
```

---

### Task 2: v4 migration — add `clients`, rename `cms`→`matters`, backfill

**Files:**
- Modify: `server/db.js` (append migration v4 to `MIGRATIONS`; do NOT touch v1–v3)
- Modify (rename `cms`→`matters` in SQL only): `server/routes/cms.js`, `server/routes/dashboard.js:34-35`, `server/routes/entries.js:22,69,106,188,221`, `server/routes/timers.js:61,72,108,109,121,145,172,207`, `server/routes/backup.js:24`
- Modify (tests referencing the `cms` table by name): `test/db.test.js:18,67,71,86`, `test/jobs.test.js:14`, `test/api.timers.test.js:316`, `test/api.backup.test.js:19`
- Test: `test/db.test.js` (add migration assertions)

**Interfaces:**
- Consumes: `D6` constant already defined at `server/db.js:5` (`'[0-9][0-9][0-9][0-9][0-9][0-9]'`).
- Produces: schema with `clients(id, client_number, name, created_at, updated_at)` and `matters` (was `cms`) carrying new nullable-then-backfilled `client_id`, `matter_number`; `entries.cm_id`/`timers.cm_id` now reference `matters(id)`.

- [ ] **Step 1: Write the failing migration tests**

Add these tests to the end of `test/db.test.js`:

```js
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
  // simulate a pre-v4 database with cms rows
  db1.pragma('user_version = 3');
  db1.exec("ALTER TABLE matters RENAME TO cms"); // undo v4 rename to fake an old db
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
```

Also update the existing v1 table-list test at `test/db.test.js:18` — change `'cms'` to `'matters'` in the array:

```js
  for (const t of ['settings', 'matters', 'task_codes', 'entries', 'entry_tasks', 'timers', 'sessions', 'audit_log']) {
```

And update the two raw-SQL `cms` references in the same file: `test/db.test.js:67` and `:71` (inside the `cm_number format` test) and `:86` (inside the cascade test) — replace `cms` with `matters`:

```js
// line ~67
    "INSERT INTO matters (cm_number, short_name, billable) VALUES (?, ?, 1)");
// line ~71
  assert.equal(db.prepare('SELECT COUNT(*) c FROM matters').get().c, 1);
// line ~86
  db.prepare("INSERT INTO matters (cm_number, short_name, billable) VALUES ('111111-222222', 'x', 1)").run();
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/db.test.js`
Expected: FAIL — new tests error (no `clients`/`matters` table); the edited v1 test fails (still `cms`).

- [ ] **Step 3: Append migration v4 in `server/db.js`**

In the `MIGRATIONS` array, after the v3 entry (the `UPDATE settings ... rounding` string at `db.js:114-116`), add a 4th element:

```js
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
```

Notes for the implementer:
- `ALTER TABLE cms RENAME TO matters` automatically rewrites the `REFERENCES cms(id)` in `entries` and `timers` to `REFERENCES matters(id)` (SQLite ≥ 3.25 with the default `legacy_alter_table=OFF`). The migration runs inside a transaction with `foreign_keys=ON` (see `openDb`/`migrate`) — this is supported.
- The `cm_number` column keeps its original `UNIQUE` + `GLOB` CHECK from the v1 `cms` definition (constraints survive a table rename).
- `substr(cm_number, 8, 6)` takes the 6 digits after the hyphen at position 7.

- [ ] **Step 4: Rename `cms`→`matters` in every server SQL site**

Make these exact replacements (SQL table name only — column names, `cm_id`, `/api/cms` route path all stay unchanged):

`server/routes/cms.js`:
- `getCm` (line 10): `FROM cms` → `FROM matters`
- `/picker` (line 16): `FROM cms` → `FROM matters`
- `/` list (lines 26-29): `FROM entries e WHERE e.cm_id = cms.id` → `... = matters.id`; `FROM cms ${...` → `FROM matters ${...`
- POST (line 42): `INSERT INTO cms (` → `INSERT INTO matters (`
- PATCH (line 72): `UPDATE cms SET` → `UPDATE matters SET`
- DELETE (line 93): `DELETE FROM cms WHERE id=?` → `DELETE FROM matters WHERE id=?`

`server/routes/dashboard.js` (lines 34-35): `cms.cm_number, cms.short_name AS cm_short_name` → `matters.cm_number, matters.short_name AS cm_short_name`; `FROM timers JOIN cms ON cms.id = timers.cm_id` → `FROM timers JOIN matters ON matters.id = timers.cm_id`

`server/routes/entries.js`: line 22 `FROM cms WHERE id=?` → `FROM matters WHERE id=?`; line 69 `UPDATE cms SET last_used_at=?` → `UPDATE matters SET last_used_at=?`; line 106 `FROM cms WHERE id=?` → `FROM matters WHERE id=?`; line 188 `FROM cms WHERE id=?` → `FROM matters WHERE id=?`; line 221 `FROM cms WHERE id=?` → `FROM matters WHERE id=?`

`server/routes/timers.js`: line 61 `FROM cms WHERE id=?` → `FROM matters WHERE id=?`; line 72 `UPDATE cms SET last_used_at=?` → `UPDATE matters SET last_used_at=?`; lines 108-109 `FROM cms WHERE cms.id = timers.cm_id` → `FROM matters WHERE matters.id = timers.cm_id` (both subqueries); line 121 `FROM cms WHERE id=?` → `FROM matters WHERE id=?`; line 145 `FROM cms` → `FROM matters`; line 172 `INSERT INTO cms (` → `INSERT INTO matters (`; line 207 `FROM cms WHERE id=?` → `FROM matters WHERE id=?`

`server/routes/backup.js` (line 24): `cms: db.prepare('SELECT * FROM cms ORDER BY id').all(),` → `matters: db.prepare('SELECT * FROM matters ORDER BY id').all(),`

- [ ] **Step 5: Update the remaining tests that name the `cms` table**

- `test/jobs.test.js:14`: `INSERT INTO cms (` → `INSERT INTO matters (`
- `test/api.timers.test.js:316`: `SELECT last_used_at FROM cms WHERE id=?` → `FROM matters WHERE id=?`
- `test/api.backup.test.js:19`: `assert.equal(json.body.cms.length, 1);` → `assert.equal(json.body.matters.length, 1);`

- [ ] **Step 6: Run the full suite to verify green**

Run: `npm test`
Expected: PASS — all suites green, including the three new v4 tests in `test/db.test.js`.

- [ ] **Step 7: Commit**

```bash
git add server/db.js server/routes/*.js test/db.test.js test/jobs.test.js test/api.timers.test.js test/api.backup.test.js
git commit -m "feat(db): v4 migration — clients table, rename cms->matters, backfill links"
```

---

### Task 3: Every matter-creation path ensures its client

**Files:**
- Modify: `server/routes/cms.js` (POST + PATCH: link a client, set `matter_number`)
- Modify: `server/routes/timers.js` (import: create/link clients for imported matters)
- Test: `test/api.cms.test.js` (add a linking test), `test/api.timerimport.test.js` (assert import links clients)

**Interfaces:**
- Consumes: `splitCmNumber`, `buildCmNumber` from `server/lib/cmNumber.js` (Task 1).
- Produces: exported helper `ensureClient(db, clientNumber, nowIso): number` (returns `clients.id`) from `server/routes/cms.js`, reused by `timers.js`. Every row written to `matters` has non-null `client_id` and `matter_number`.

- [ ] **Step 1: Write the failing test**

Add to `test/api.cms.test.js`:

```js
test('creating a CM links (and creates) its client and sets matter_number', () => withServer(async (t) => {
  const created = await t.fetchJson('POST', '/api/cms', {
    cm_number: '777001-000042', short_name: 'Linked matter', billable: 1,
  });
  assert.equal(created.status, 201);
  const row = t.db.prepare('SELECT client_id, matter_number FROM matters WHERE id=?').get(created.body.id);
  assert.equal(row.matter_number, '000042');
  const client = t.db.prepare('SELECT client_number, name FROM clients WHERE id=?').get(row.client_id);
  assert.equal(client.client_number, '777001');
  assert.equal(client.name, ''); // blank until named

  // a second matter for the same client reuses the client row
  const second = await t.fetchJson('POST', '/api/cms', { cm_number: '777001-000043', short_name: 'Second' });
  const row2 = t.db.prepare('SELECT client_id FROM matters WHERE id=?').get(second.body.id);
  assert.equal(row2.client_id, row.client_id);
  assert.equal(t.db.prepare("SELECT COUNT(*) c FROM clients WHERE client_number='777001'").get().c, 1);
}));
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/api.cms.test.js`
Expected: FAIL — `matter_number` is null (POST doesn't set it yet).

- [ ] **Step 3: Add `ensureClient` and wire it into POST/PATCH**

In `server/routes/cms.js`, add the import at the top and an exported helper, then call it in POST and PATCH.

Add import (top of file, after the existing `validateCmNumber` import):

```js
import { splitCmNumber } from '../lib/cmNumber.js';
```

Add this exported helper (module scope, e.g. below the imports):

```js
// Upsert the client for a 6-digit client number and return its id. Blank name;
// the user fills it in later via /api/clients. Reused by the timer importer.
export function ensureClient(db, clientNumber, nowIso) {
  db.prepare('INSERT OR IGNORE INTO clients (client_number, created_at, updated_at) VALUES (?, ?, ?)')
    .run(clientNumber, nowIso, nowIso);
  return db.prepare('SELECT id FROM clients WHERE client_number=?').get(clientNumber).id;
}
```

Replace the POST insert (`cms.js:41-43`) so it links the client and stores `matter_number`:

```js
    try {
      const { clientNumber, matterNumber } = splitCmNumber(cm_number);
      const clientId = ensureClient(db, clientNumber, now());
      const info = db.prepare(
        'INSERT INTO matters (cm_number, short_name, billable, favorite, client_id, matter_number, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(cm_number, String(short_name), billable ? 1 : 0, favorite ? 1 : 0, clientId, matterNumber, now(), now());
      res.status(201).json(getCm.get(info.lastInsertRowid));
    } catch (e) {
```

(The `validateCmNumber(cm_number)` guard above already guarantees `splitCmNumber` returns non-null.)

In PATCH, when `cm_number` changes, re-link. Replace the `UPDATE matters SET ...` block (`cms.js:70-73`) with:

```js
    try {
      let clientId = null;
      let matterNumber = null;
      if (b.cm_number !== undefined && b.cm_number !== cm.cm_number) {
        const parts = splitCmNumber(next.cm_number);
        clientId = ensureClient(db, parts.clientNumber, now());
        matterNumber = parts.matterNumber;
      }
      db.prepare(
        `UPDATE matters SET cm_number=?, short_name=?, billable=?, status=?, favorite=?, updated_at=?
         ${clientId ? ', client_id=?, matter_number=?' : ''} WHERE id=?`
      ).run(next.cm_number, next.short_name, next.billable, next.status, next.favorite, now(),
        ...(clientId ? [clientId, matterNumber] : []), cm.id);
    } catch (e) {
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/api.cms.test.js`
Expected: PASS.

- [ ] **Step 5: Link clients in the timer importer**

Add to `test/api.timerimport.test.js` a check that committing an import creates linked clients. First read the file's existing commit test to match its setup, then add:

```js
test('timer import links imported matters to clients', () => withServer(async (t) => {
  const csv = 'CM Number,Matter Name,Group\n888001-000001,Imported A,Litigation\n888001-000002,Imported B,Litigation\n';
  const preview = await t.fetchJson('POST', '/api/timers/import/preview', { csv });
  assert.equal(preview.status, 200);
  const commit = await t.fetchJson('POST', '/api/timers/import', { csv, mapping: preview.body.mapping });
  assert.equal(commit.status, 200);
  const clients = t.db.prepare("SELECT COUNT(*) c FROM clients WHERE client_number='888001'").get().c;
  assert.equal(clients, 1);
  const linked = t.db.prepare("SELECT COUNT(*) c FROM matters WHERE matter_number IN ('000001','000002') AND client_id IS NOT NULL").get().c;
  assert.equal(linked, 2);
}));
```

Adjust the CSV header/body and the request bodies to match the importer's actual contract if the existing tests in this file differ (read `test/api.timerimport.test.js` and `server/routes/timers.js:134-193` first).

- [ ] **Step 6: Wire client linking into the importer**

In `server/routes/timers.js`, add the import at the top:

```js
import { ensureClient } from './cms.js';
import { splitCmNumber } from '../lib/cmNumber.js';
```

At the matter-insert in the import commit (`timers.js:172`), the current insert is:

```js
        'INSERT INTO matters (cm_number, short_name, billable, favorite, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)');
```

Change it to include `client_id` and `matter_number`, and set them when running it (`timers.js:178` area):

```js
        'INSERT INTO matters (cm_number, short_name, billable, favorite, client_id, matter_number, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?, ?, ?)');
```

At the call site where `insCm.run(p.cm_number, p.matter_name, p.billable, nowIso, nowIso)` is invoked (`timers.js:178`), replace with:

```js
        const parts = splitCmNumber(p.cm_number);
        const clientId = ensureClient(db, parts.clientNumber, nowIso);
        const cmId = insCm.run(p.cm_number, p.matter_name, p.billable, clientId, parts.matterNumber, nowIso, nowIso).lastInsertRowid;
```

(The importer already skips rows whose `cm_number` fails `CM_RE` — `timerimport.js:72` — so `splitCmNumber` is non-null here.)

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: PASS — all suites green.

- [ ] **Step 8: Commit**

```bash
git add server/routes/cms.js server/routes/timers.js test/api.cms.test.js test/api.timerimport.test.js
git commit -m "feat(cms): link every matter to a client on create/edit/import"
```

---

### Task 4: `/api/clients` CRUD router

**Files:**
- Create: `server/routes/clients.js`
- Modify: `server/app.js` (import + mount at `/api/clients`)
- Test: `test/api.clients.test.js`

**Interfaces:**
- Consumes: `deps = { db, clock }` (same shape as every other router — see `cmsRouter` at `cms.js:6`).
- Produces: `clientsRouter(deps)` with:
  - `GET /api/clients` → `[{ id, client_number, name, matter_count, created_at, updated_at }]` ordered by `client_number`.
  - `GET /api/clients/:id` → one client or 404.
  - `PATCH /api/clients/:id` → update `name` (and optionally `client_number`, validated 6-digit, 409 on duplicate).

- [ ] **Step 1: Write the failing test**

Create `test/api.clients.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

async function withServer(fn) {
  const t = await startTestServer();
  try { await fn(t); } finally { await t.close(); }
}

test('clients: list reflects migrated/created clients with matter counts', () => withServer(async (t) => {
  await t.fetchJson('POST', '/api/cms', { cm_number: '505001-000001', short_name: 'M1' });
  await t.fetchJson('POST', '/api/cms', { cm_number: '505001-000002', short_name: 'M2' });
  await t.fetchJson('POST', '/api/cms', { cm_number: '505002-000001', short_name: 'Other' });

  const list = (await t.fetchJson('GET', '/api/clients')).body;
  const c1 = list.find((c) => c.client_number === '505001');
  const c2 = list.find((c) => c.client_number === '505002');
  assert.equal(c1.matter_count, 2);
  assert.equal(c2.matter_count, 1);
  assert.equal(c1.name, ''); // blank until named
}));

test('clients: PATCH sets the name', () => withServer(async (t) => {
  await t.fetchJson('POST', '/api/cms', { cm_number: '606001-000001', short_name: 'M' });
  const client = (await t.fetchJson('GET', '/api/clients')).body[0];
  const patched = await t.fetchJson('PATCH', `/api/clients/${client.id}`, { name: 'Meridian' });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.name, 'Meridian');

  const get = await t.fetchJson('GET', `/api/clients/${client.id}`);
  assert.equal(get.body.name, 'Meridian');
}));

test('clients: 404 for unknown id, 400 for bad client_number', () => withServer(async (t) => {
  assert.equal((await t.fetchJson('GET', '/api/clients/9999')).status, 404);
  await t.fetchJson('POST', '/api/cms', { cm_number: '707001-000001', short_name: 'M' });
  const client = (await t.fetchJson('GET', '/api/clients')).body[0];
  const bad = await t.fetchJson('PATCH', `/api/clients/${client.id}`, { client_number: '12345' });
  assert.equal(bad.status, 400);
}));
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/api.clients.test.js`
Expected: FAIL — 404s for `/api/clients` (route not mounted).

- [ ] **Step 3: Create the router**

Create `server/routes/clients.js`:

```js
import { Router } from 'express';
import { SIX } from '../lib/cmNumber.js';

const CLIENT_COLS = 'id, client_number, name, created_at, updated_at';

export function clientsRouter({ db, clock }) {
  const r = Router();
  const now = () => clock().toISOString();
  const getClient = db.prepare(`SELECT ${CLIENT_COLS} FROM clients WHERE id=?`);

  r.get('/', (req, res) => {
    const rows = db.prepare(`
      SELECT ${CLIENT_COLS},
        (SELECT COUNT(*) FROM matters m WHERE m.client_id = clients.id) AS matter_count
      FROM clients ORDER BY client_number
    `).all();
    res.json(rows);
  });

  r.get('/:id', (req, res) => {
    const c = getClient.get(req.params.id);
    if (!c) return res.status(404).json({ error: 'Client not found.' });
    res.json(c);
  });

  r.patch('/:id', (req, res) => {
    const c = getClient.get(req.params.id);
    if (!c) return res.status(404).json({ error: 'Client not found.' });
    const b = req.body || {};
    if (b.client_number !== undefined && !SIX.test(String(b.client_number))) {
      return res.status(400).json({ error: 'Client number must be 6 digits.' });
    }
    const next = {
      client_number: b.client_number ?? c.client_number,
      name: b.name ?? c.name,
    };
    try {
      db.prepare('UPDATE clients SET client_number=?, name=?, updated_at=? WHERE id=?')
        .run(String(next.client_number), String(next.name), now(), c.id);
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) {
        return res.status(409).json({ error: `Client ${b.client_number} already exists.` });
      }
      throw e;
    }
    res.json(getClient.get(c.id));
  });

  return r;
}
```

- [ ] **Step 4: Mount it in `server/app.js`**

Add the import alongside the other route imports (near `app.js:4`):

```js
import { clientsRouter } from './routes/clients.js';
```

Add the mount next to the CMs mount (after `app.use('/api/cms', cmsRouter(deps));` at `app.js:27`):

```js
  app.use('/api/clients', clientsRouter(deps));
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test test/api.clients.test.js`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add server/routes/clients.js server/app.js test/api.clients.test.js
git commit -m "feat(api): /api/clients CRUD (list with matter counts, get, patch name)"
```

---

### Task 5: Enrich matter payloads with client fields; back up clients; regression

**Files:**
- Modify: `server/routes/cms.js` (add client fields to matter payloads via JOIN)
- Modify: `server/routes/backup.js` (add `clients` to the JSON dump)
- Test: `test/api.cms.test.js` (assert client fields present), `test/api.backup.test.js` (assert `clients` in dump)

**Interfaces:**
- Consumes: `matters.client_id`, `clients` (Tasks 2–4).
- Produces: every `/api/cms` payload (`getCm`, `/picker`, `/`) additionally carries `client_id`, `matter_number`, `client_number`, `client_name`. Existing fields (`cm_number`, `short_name`, etc.) are unchanged, so the frontend is unaffected.

- [ ] **Step 1: Write the failing test**

Add to `test/api.cms.test.js`:

```js
test('matter payloads include client fields', () => withServer(async (t) => {
  const created = (await t.fetchJson('POST', '/api/cms', { cm_number: '909001-000007', short_name: 'Enriched' })).body;
  assert.equal(created.client_number, '909001');
  assert.equal(created.matter_number, '000007');
  assert.equal(created.client_name, '');
  assert.ok(created.client_id);

  const picker = (await t.fetchJson('GET', '/api/cms/picker?q=909001')).body;
  assert.equal(picker[0].client_number, '909001');

  const list = (await t.fetchJson('GET', '/api/cms')).body;
  assert.ok(list.every((m) => 'client_number' in m));
}));
```

Add to `test/api.backup.test.js` (inside the existing dump test, after the `matters` assertion at line ~19):

```js
    assert.ok(Array.isArray(json.body.clients));
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/api.cms.test.js test/api.backup.test.js`
Expected: FAIL — `client_number` undefined in payloads; `clients` missing from dump.

- [ ] **Step 3: Add client fields to the matter queries**

In `server/routes/cms.js`, replace the `CM_COLS` constant (line 4) with a qualified/joined column set and a shared FROM clause:

```js
const CM_COLS = `matters.id, matters.cm_number, matters.short_name, matters.billable,
  matters.status, matters.favorite, matters.last_used_at, matters.created_at, matters.updated_at,
  matters.client_id, matters.matter_number,
  clients.client_number, clients.name AS client_name`;
const CM_FROM = 'FROM matters LEFT JOIN clients ON clients.id = matters.client_id';
```

Update the three read queries to use `CM_FROM` and qualify `id`/`status`/`cm_number`/`short_name` where they appear in WHERE/ORDER BY:

- `getCm` (line 10): `SELECT ${CM_COLS} ${CM_FROM} WHERE matters.id=?`
- `/picker` (lines 15-20):

```js
      SELECT ${CM_COLS} ${CM_FROM}
      WHERE matters.status='active' AND (? = '' OR matters.cm_number LIKE ? OR matters.short_name LIKE ? COLLATE NOCASE)
      ORDER BY matters.favorite DESC, matters.last_used_at IS NULL, matters.last_used_at DESC, matters.short_name COLLATE NOCASE
      LIMIT 25
```

- `/` list (lines 26-31):

```js
      SELECT ${CM_COLS},
        (SELECT COUNT(*) FROM entries e WHERE e.cm_id = matters.id AND e.deleted_at IS NULL) AS entry_count
      ${CM_FROM} ${includeArchived ? '' : "WHERE matters.status='active'"}
      ORDER BY matters.favorite DESC, matters.short_name COLLATE NOCASE
```

- [ ] **Step 4: Add `clients` to the backup dump**

In `server/routes/backup.js`, add a line next to the `matters:` line (line 24):

```js
      clients: db.prepare('SELECT * FROM clients ORDER BY id').all(),
      matters: db.prepare('SELECT * FROM matters ORDER BY id').all(),
```

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS — all suites green.

- [ ] **Step 6: Run the E2E smoke test**

Run: `node scripts/e2e-smoke.mjs`
Expected: all steps ✔, zero entries in `problems` (the frontend still uses `cm_number`/`short_name`, which are unchanged, so the existing flows pass).

- [ ] **Step 7: Commit**

```bash
git add server/routes/cms.js server/routes/backup.js test/api.cms.test.js test/api.backup.test.js
git commit -m "feat(cms): expose client fields in matter payloads; back up clients"
```

---

## Self-Review

**Spec coverage (Phase 1a scope):**
- §3.2 `clients` + `matters` tables, `client_id`/`matter_number` → Task 2. ✓
- §3.2 CM# derived string preserved (export unchanged) → `cm_number` column kept + `cmNumber` helper (Task 1). ✓
- §3.3 v4 migration, split existing rows, **blank** client names, repoint FKs → Task 2. ✓
- §3.4 `cmNumber` helper centralizing the derived value → Task 1; validation still validates the derived `cm_number` (unchanged `validateCmNumber`). ✓
- Client entity + API (needed by later phases' client-aware picker) → Task 4. ✓
- Every matter linked to a client (invariant for the memory layer's client-sibling borrowing) → Task 3. ✓
- **Deferred to Phase 1b (noted):** client-aware CM picker UI (§3.4 frontend) and timer-grid grouping selector (§4). Not in this plan.

**Placeholder scan:** No TBD/TODO; every code step has complete code; the two "adjust to match existing test setup" notes (Task 3 Step 5, referencing `api.timerimport.test.js`) point at a real file to read, not a placeholder — the assertion logic is fully specified.

**Type consistency:** `ensureClient(db, clientNumber, nowIso)` defined in `cms.js` (Task 3) and imported in `timers.js` (Task 3) — same signature. `splitCmNumber`/`buildCmNumber`/`SIX` names consistent across Tasks 1, 3, 4. Payload fields `client_id`/`matter_number`/`client_number`/`client_name` consistent between Task 4 tests and Task 5 implementation. `/api/clients` shape (`matter_count`) consistent between router (Task 4) and its test.

**Note on scope split:** Phase 1 in the spec bundles data model + picker UI + grouping selector. Per the writing-plans Scope Check, this plan delivers the data foundation as an independently shippable, fully-tested unit (the app behaves identically); Phase 1b (the two UI pieces) will be its own plan.
