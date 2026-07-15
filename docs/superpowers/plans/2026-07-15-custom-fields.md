# Custom Fields per Client / Matter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-client / per-matter custom entry fields (e.g. "Phase", "Task") with dropdown options or format regexes, entered in the entry editor, enforced at finalize, exported as extra CSV columns.

**Architecture:** Two new tables (`custom_fields` definitions, `entry_custom_values`); pure merge/validate rules in `server/lib/customfields.js`; a task-codes-style CRUD router at `/api/custom-fields` that also serves the merged "effective" field set per matter; `enrich()` attaches fields+values to every entry payload so validation and export get them for free; UI = a management modal on the Clients & Matters page + an input row in the entry editor.

**Tech Stack:** Express 5, better-sqlite3 (migration v15), node:test, no-build React 18 UMD + htm.

**Spec:** `docs/superpowers/specs/2026-07-15-custom-fields-design.md` — read the ⚠️ assumptions before changing behavior.

## Global Constraints

- Runtime deps stay exactly `express` + `better-sqlite3`.
- Schema changes = append a migration to `MIGRATIONS` in `server/db.js`; never mutate old ones. This plan appends **v15** (index 14 in the array, after the v14 `narrative_template` entry).
- All server writes via prepared statements; business rules in `server/lib/*` pure functions with unit tests; routes stay thin.
- TDD: failing test first; `npm test` (node:test). E2E: `node scripts/e2e-smoke.mjs`.
- Options are stored as JSON text in SQLite but cross the API as real arrays — parse at the route boundary, both directions.
- `custom_values` keys that don't apply to the entry's matter are **silently skipped** (autosave-safe), never 400s.
- After server changes: `systemctl --user restart timekeeper`. After `public/js/**`/CSS changes: bump `CACHE` in `public/sw.js` (once, in the final task).
- Commit each task atomically; push when the plan is done.

---

### Task 1: Migration v15 — the two tables

**Files:**
- Modify: `server/db.js` (append to `MIGRATIONS`)
- Test: `test/db.test.js` (append)

**Interfaces:**
- Produces: tables `custom_fields` (`id, client_id, matter_id, name, type, options, pattern, pattern_hint, required, active, sort_order`) and `entry_custom_values` (`id, entry_id, field_id, value`). Every later task reads/writes exactly these columns.

- [ ] **Step 1: Write the failing test**

Append to `test/db.test.js` (it already imports `openDb` and node:test/assert — reuse its imports; add this at the end):

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/db.test.js`
Expected: FAIL — `no such table: custom_fields`

- [ ] **Step 3: Append the migration**

In `server/db.js`, append to the `MIGRATIONS` array (after the v14
`narrative_template` entry):

```js
  // v15 — custom fields (2026-07-15 TODO): definitions live on a client
  // (apply to every matter under it) or on one matter; values live on
  // entries. Deleting a client/matter cascades its definitions; deleting an
  // entry cascades its values. The API blocks hard-deleting a definition
  // that has recorded values — deactivate instead (task-codes philosophy:
  // config changes never rewrite past entries). options is a JSON array of
  // strings; pattern is a JS regex source applied to text-type values.
  `
  CREATE TABLE custom_fields (
    id           INTEGER PRIMARY KEY,
    client_id    INTEGER REFERENCES clients(id) ON DELETE CASCADE,
    matter_id    INTEGER REFERENCES matters(id) ON DELETE CASCADE,
    name         TEXT NOT NULL CHECK (length(trim(name)) > 0),
    type         TEXT NOT NULL DEFAULT 'text' CHECK (type IN ('text','select')),
    options      TEXT NOT NULL DEFAULT '[]',
    pattern      TEXT,
    pattern_hint TEXT,
    required     INTEGER NOT NULL DEFAULT 0,
    active       INTEGER NOT NULL DEFAULT 1,
    sort_order   INTEGER NOT NULL DEFAULT 0,
    CHECK ((client_id IS NULL) <> (matter_id IS NULL))
  );
  CREATE UNIQUE INDEX idx_cf_client_name ON custom_fields(client_id, name) WHERE client_id IS NOT NULL;
  CREATE UNIQUE INDEX idx_cf_matter_name ON custom_fields(matter_id, name) WHERE matter_id IS NOT NULL;

  CREATE TABLE entry_custom_values (
    id       INTEGER PRIMARY KEY,
    entry_id INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
    field_id INTEGER NOT NULL REFERENCES custom_fields(id),
    value    TEXT NOT NULL DEFAULT '',
    UNIQUE(entry_id, field_id)
  );
  CREATE INDEX idx_ecv_entry ON entry_custom_values(entry_id);
  `,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS (new test green, migration count sanity tests in db.test.js may assert `user_version` — if one pins the version number, update it to 15).

- [ ] **Step 5: Commit**

```bash
git add server/db.js test/db.test.js
git commit -m "feat(custom-fields): schema v15 — field definitions + per-entry values"
```

---

### Task 2: Pure rules — effective merge + value validation

**Files:**
- Create: `server/lib/customfields.js`
- Test: `test/customfields.test.js`

**Interfaces:**
- Produces: `effectiveFields(clientFields, matterFields) → field[]` — client-level first (sort_order, id), then matter-level; a matter field removes a same-named (case-insensitive) client field.
- Produces: `validateFieldValues(fields, values) → findings[]` — `{level, code, message}` items; codes `custom_required` (block), `custom_format` (warn), `custom_option` (warn). `values` is `{ [field_id]: string }`.
- Produces: `parseOptions(text) → string[]` — safe JSON-array parse, `[]` on garbage.

- [ ] **Step 1: Write the failing test**

Create `test/customfields.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { effectiveFields, validateFieldValues, parseOptions } from '../server/lib/customfields.js';

const f = (over) => ({
  id: 1, client_id: 10, matter_id: null, name: 'Phase', type: 'text',
  options: '[]', pattern: null, pattern_hint: null, required: 0, active: 1, sort_order: 0,
  ...over,
});

test('effectiveFields: client fields first, matter overrides same name case-insensitively', () => {
  const client = [f({ id: 1, name: 'Phase', sort_order: 1 }), f({ id: 2, name: 'Task', sort_order: 0 })];
  const matter = [f({ id: 3, client_id: null, matter_id: 20, name: 'phase', sort_order: 0 })];
  const out = effectiveFields(client, matter);
  assert.deepEqual(out.map((x) => x.id), [2, 3]); // Task (client), phase (matter override)
});

test('effectiveFields: empty inputs', () => {
  assert.deepEqual(effectiveFields([], []), []);
  assert.equal(effectiveFields([f()], []).length, 1);
});

test('validateFieldValues: required + empty blocks; filled passes', () => {
  const fields = [f({ id: 1, required: 1 })];
  assert.deepEqual(validateFieldValues(fields, {}).map((x) => [x.level, x.code]),
    [['block', 'custom_required']]);
  assert.deepEqual(validateFieldValues(fields, { 1: '  ' }).map((x) => x.code), ['custom_required']);
  assert.deepEqual(validateFieldValues(fields, { 1: 'P100' }), []);
});

test('validateFieldValues: pattern mismatch warns, match passes, bad regex ignored', () => {
  const fields = [f({ id: 1, pattern: 'P\\d{3}', pattern_hint: 'P###' })];
  const warn = validateFieldValues(fields, { 1: 'X9' });
  assert.equal(warn[0].level, 'warn');
  assert.equal(warn[0].code, 'custom_format');
  assert.match(warn[0].message, /P###/);
  assert.deepEqual(validateFieldValues(fields, { 1: 'P123' }), []);
  assert.deepEqual(validateFieldValues([f({ id: 1, pattern: '(' })], { 1: 'anything' }), []);
});

test('validateFieldValues: select value must be an option; empty non-required is fine', () => {
  const fields = [f({ id: 1, type: 'select', options: '["P100","P200"]' })];
  assert.deepEqual(validateFieldValues(fields, { 1: 'P300' }).map((x) => x.code), ['custom_option']);
  assert.deepEqual(validateFieldValues(fields, { 1: 'P100' }), []);
  assert.deepEqual(validateFieldValues(fields, {}), []);
});

test('parseOptions: JSON text or already-parsed array in, junk out safely', () => {
  assert.deepEqual(parseOptions('["a","b"]'), ['a', 'b']);
  assert.deepEqual(parseOptions(['a', 'b']), ['a', 'b']); // enrich() hands routes' pre-parsed arrays through
  assert.deepEqual(parseOptions('not json'), []);
  assert.deepEqual(parseOptions(''), []);
  assert.deepEqual(parseOptions('{"a":1}'), []);
});

test('validateFieldValues works when options arrive pre-parsed (enrich path)', () => {
  const fields = [f({ id: 1, type: 'select', options: ['P100', 'P200'] })];
  assert.deepEqual(validateFieldValues(fields, { 1: 'P300' }).map((x) => x.code), ['custom_option']);
  assert.deepEqual(validateFieldValues(fields, { 1: 'P100' }), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/customfields.test.js`
Expected: FAIL — cannot find module `../server/lib/customfields.js`

- [ ] **Step 3: Write the implementation**

Create `server/lib/customfields.js`:

```js
// Custom fields (spec 2026-07-15): pure rules only — the merge that decides
// which definitions apply to a matter, and the per-entry value validation.
// DB access lives in routes/customfields.js.

// Accepts the stored JSON text OR an already-parsed array — enrich() attaches
// fields whose options the route layer has already parsed, and validation
// must work on both shapes.
export function parseOptions(text) {
  if (Array.isArray(text)) return text.map(String);
  try {
    const a = JSON.parse(text || '[]');
    return Array.isArray(a) ? a.map(String) : [];
  } catch {
    return [];
  }
}

// Client-level fields apply to every matter under the client; a matter-level
// field with the same name (case-insensitive) OVERRIDES the client one, so a
// one-off matter can tighten or replace its client's field without a dupe.
export function effectiveFields(clientFields = [], matterFields = []) {
  const bySort = (a, b) => (a.sort_order - b.sort_order) || (a.id - b.id);
  const overridden = new Set(matterFields.map((f) => String(f.name).toLowerCase()));
  return [
    ...clientFields.filter((f) => !overridden.has(String(f.name).toLowerCase())).sort(bySort),
    ...[...matterFields].sort(bySort),
  ];
}

// findings shaped like lib/validation.js: {level, code, message}.
// required+empty BLOCKS (the billing system would bounce the entry);
// format/option mismatches WARN (ack-able — a mistyped regex or a stale
// option list must never deadlock billing).
export function validateFieldValues(fields, values) {
  const findings = [];
  for (const f of fields) {
    const v = String((values || {})[f.id] ?? '').trim();
    if (!v) {
      if (f.required) {
        findings.push({
          level: 'block', code: 'custom_required',
          message: `"${f.name}" is required for this ${f.matter_id != null ? 'matter' : 'client'}.`,
        });
      }
      continue;
    }
    if (f.type === 'select') {
      const opts = parseOptions(f.options);
      if (opts.length > 0 && !opts.includes(v)) {
        findings.push({
          level: 'warn', code: 'custom_option',
          message: `"${f.name}" value "${v}" is not one of its dropdown options.`,
        });
      }
    } else if (f.pattern) {
      let re = null;
      try { re = new RegExp(`^(?:${f.pattern})$`); } catch { /* bad pattern never blocks billing */ }
      if (re && !re.test(v)) {
        findings.push({
          level: 'warn', code: 'custom_format',
          message: `"${f.name}" value "${v}" doesn't match the required format${f.pattern_hint ? ` (${f.pattern_hint})` : ''}.`,
        });
      }
    }
  }
  return findings;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/customfields.test.js` then `npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/lib/customfields.js test/customfields.test.js
git commit -m "feat(custom-fields): pure effective-merge and value-validation rules"
```

---

### Task 3: /api/custom-fields router

**Files:**
- Create: `server/routes/customfields.js`
- Modify: `server/app.js` (mount)
- Test: `test/api.customfields.test.js`

**Interfaces:**
- Consumes: `effectiveFields`, `parseOptions` from Task 2.
- Produces: `customFieldsRouter({ db })` and `loadEffectiveFields(db, matterId) → field[]` (options already parsed to arrays) — Task 4's `enrich()` imports the latter from this module.
- REST shape (all field payloads carry `options` as arrays):
  - `GET /api/custom-fields[?client_id=|?matter_id=][&includeInactive=1]`
  - `GET /api/custom-fields/effective/:matterId` → merged active fields (404 unknown matter)
  - `POST /api/custom-fields` `{client_id XOR matter_id, name, type?, options?, pattern?, pattern_hint?, required?}` → 201
  - `PATCH /api/custom-fields/:id` (any of name/type/options/pattern/pattern_hint/required/active)
  - `PUT /api/custom-fields/order` `{ids}`
  - `DELETE /api/custom-fields/:id` → 409 when values exist

- [ ] **Step 1: Write the failing test**

Create `test/api.customfields.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

// One server for the file, task-codes test style.
const srv = await startTestServer();
test.after(() => srv.close());
const { fetchJson, db } = srv;

// seed: client 111111 with matters -000001 and -000002
const { body: m1 } = await fetchJson('POST', '/api/cms', { cm_number: '111111-000001', short_name: 'Meridian A' });
const { body: m2 } = await fetchJson('POST', '/api/cms', { cm_number: '111111-000002', short_name: 'Meridian B' });
const clientId = db.prepare("SELECT id FROM clients WHERE client_number='111111'").get().id;

test('POST validates ownership and shape', async () => {
  assert.equal((await fetchJson('POST', '/api/custom-fields', { name: 'Phase' })).status, 400);
  assert.equal((await fetchJson('POST', '/api/custom-fields',
    { client_id: clientId, matter_id: m1.id, name: 'Phase' })).status, 400);
  assert.equal((await fetchJson('POST', '/api/custom-fields', { client_id: 999999, name: 'Phase' })).status, 400);
  assert.equal((await fetchJson('POST', '/api/custom-fields', { client_id: clientId, name: '  ' })).status, 400);
  assert.equal((await fetchJson('POST', '/api/custom-fields',
    { client_id: clientId, name: 'Bad', pattern: '(' })).status, 400);
  assert.equal((await fetchJson('POST', '/api/custom-fields',
    { client_id: clientId, name: 'Bad', options: 'P100,P200' })).status, 400); // must be an array
});

let phaseId, taskId, matterPhaseId;

test('CRUD round-trip with parsed options', async () => {
  const phase = await fetchJson('POST', '/api/custom-fields', {
    client_id: clientId, name: 'Phase', type: 'select', options: ['P100', 'P200'], required: true,
  });
  assert.equal(phase.status, 201);
  assert.deepEqual(phase.body.options, ['P100', 'P200']);
  phaseId = phase.body.id;

  const dup = await fetchJson('POST', '/api/custom-fields', { client_id: clientId, name: 'Phase' });
  assert.equal(dup.status, 409);

  const task = await fetchJson('POST', '/api/custom-fields', {
    client_id: clientId, name: 'Task', pattern: 'A\\d{3}', pattern_hint: 'A###',
  });
  assert.equal(task.status, 201);
  taskId = task.body.id;

  const list = await fetchJson('GET', `/api/custom-fields?client_id=${clientId}`);
  assert.deepEqual(list.body.map((f) => f.name), ['Phase', 'Task']);

  const patched = await fetchJson('PATCH', `/api/custom-fields/${taskId}`, { required: true, pattern_hint: 'A### (UTBMS)' });
  assert.equal(patched.body.required, 1);

  await fetchJson('PUT', '/api/custom-fields/order', { ids: [taskId, phaseId] });
  const reordered = await fetchJson('GET', `/api/custom-fields?client_id=${clientId}`);
  assert.deepEqual(reordered.body.map((f) => f.name), ['Task', 'Phase']);
  await fetchJson('PUT', '/api/custom-fields/order', { ids: [phaseId, taskId] }); // restore
});

test('effective merge: matter override wins, inactive drop out', async () => {
  const mp = await fetchJson('POST', '/api/custom-fields', {
    matter_id: m1.id, name: 'phase', type: 'text', pattern: 'PH-\\d+',
  });
  matterPhaseId = mp.body.id;
  const eff1 = await fetchJson('GET', `/api/custom-fields/effective/${m1.id}`);
  assert.deepEqual(eff1.body.map((f) => f.id), [taskId, matterPhaseId]); // client Task + matter phase (override)
  const eff2 = await fetchJson('GET', `/api/custom-fields/effective/${m2.id}`);
  assert.deepEqual(eff2.body.map((f) => f.id), [phaseId, taskId]); // sibling matter: client set untouched
  assert.equal((await fetchJson('GET', '/api/custom-fields/effective/424242')).status, 404);

  await fetchJson('PATCH', `/api/custom-fields/${matterPhaseId}`, { active: false });
  const eff3 = await fetchJson('GET', `/api/custom-fields/effective/${m1.id}`);
  assert.deepEqual(eff3.body.map((f) => f.id), [phaseId, taskId]); // override released
  await fetchJson('PATCH', `/api/custom-fields/${matterPhaseId}`, { active: true });
});

test('DELETE blocked once values exist', async () => {
  const e = await fetchJson('POST', '/api/entries', {
    date: '2026-07-15', cm_id: m1.id, narrative: 'seed', tasks: [{ duration: 0.5 }],
  });
  db.prepare('INSERT INTO entry_custom_values (entry_id, field_id, value) VALUES (?, ?, ?)')
    .run(e.body.id, matterPhaseId, 'PH-1');
  const blocked = await fetchJson('DELETE', `/api/custom-fields/${matterPhaseId}`);
  assert.equal(blocked.status, 409);
  db.prepare('DELETE FROM entry_custom_values WHERE field_id=?').run(matterPhaseId);
  assert.equal((await fetchJson('DELETE', `/api/custom-fields/${matterPhaseId}`)).status, 200);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/api.customfields.test.js`
Expected: FAIL — 404s (`not_found`) from the unmounted router.

- [ ] **Step 3: Write the router**

Create `server/routes/customfields.js`:

```js
import { Router } from 'express';
import { effectiveFields, parseOptions } from '../lib/customfields.js';

const COLS = 'id, client_id, matter_id, name, type, options, pattern, pattern_hint, required, active, sort_order';

// options are stored as JSON text but cross the API as real arrays.
function pub(row) {
  return { ...row, options: parseOptions(row.options) };
}

// Effective definitions for a matter: its client's fields plus its own,
// matter overriding same-named client fields (lib/customfields.js). Exported
// for entries.js — enrich() attaches this to every entry payload.
export function loadEffectiveFields(db, matterId) {
  if (matterId == null) return [];
  const m = db.prepare('SELECT id, client_id FROM matters WHERE id=?').get(matterId);
  if (!m) return [];
  const list = (col, id) => db.prepare(
    `SELECT ${COLS} FROM custom_fields WHERE ${col}=? AND active=1 ORDER BY sort_order, id`).all(id);
  return effectiveFields(
    m.client_id != null ? list('client_id', m.client_id) : [],
    list('matter_id', m.id)).map(pub);
}

export function customFieldsRouter({ db }) {
  const r = Router();
  const get = db.prepare(`SELECT ${COLS} FROM custom_fields WHERE id=?`);

  // Shared POST/PATCH normalization; `existing` = row being patched, or null.
  function normalizeBody(b, existing) {
    const name = b.name !== undefined ? String(b.name).trim() : existing?.name;
    if (!name) return { error: 'Field name required.' };
    const type = b.type !== undefined ? String(b.type) : (existing?.type || 'text');
    if (!['text', 'select'].includes(type)) return { error: "type must be 'text' or 'select'." };
    let options = existing ? existing.options : '[]';
    if (b.options !== undefined) {
      if (!Array.isArray(b.options) || b.options.some((o) => typeof o !== 'string')) {
        return { error: 'options must be an array of strings.' };
      }
      options = JSON.stringify(b.options.map((o) => o.trim()).filter(Boolean));
    }
    const pattern = b.pattern !== undefined ? (String(b.pattern).trim() || null) : (existing?.pattern ?? null);
    if (pattern != null) {
      try { new RegExp(pattern); } catch { return { error: 'pattern is not a valid regular expression.' }; }
    }
    return {
      name, type, options, pattern,
      pattern_hint: b.pattern_hint !== undefined ? (String(b.pattern_hint).trim() || null) : (existing?.pattern_hint ?? null),
      required: b.required !== undefined ? (b.required ? 1 : 0) : (existing?.required ?? 0),
      active: b.active !== undefined ? (b.active ? 1 : 0) : (existing?.active ?? 1),
    };
  }

  r.get('/', (req, res) => {
    const q = req.query;
    const incl = q.includeInactive === '1' ? '' : ' AND active=1';
    let rows;
    if (q.client_id) {
      rows = db.prepare(`SELECT ${COLS} FROM custom_fields WHERE client_id=?${incl} ORDER BY sort_order, id`).all(q.client_id);
    } else if (q.matter_id) {
      rows = db.prepare(`SELECT ${COLS} FROM custom_fields WHERE matter_id=?${incl} ORDER BY sort_order, id`).all(q.matter_id);
    } else {
      rows = db.prepare(`SELECT ${COLS} FROM custom_fields WHERE 1=1${incl} ORDER BY client_id, matter_id, sort_order, id`).all();
    }
    res.json(rows.map(pub));
  });

  r.get('/effective/:matterId', (req, res) => {
    if (!db.prepare('SELECT id FROM matters WHERE id=?').get(req.params.matterId)) {
      return res.status(404).json({ error: 'Matter not found.' });
    }
    res.json(loadEffectiveFields(db, req.params.matterId));
  });

  r.post('/', (req, res) => {
    const b = req.body || {};
    const hasClient = b.client_id != null;
    const hasMatter = b.matter_id != null;
    if (hasClient === hasMatter) {
      return res.status(400).json({ error: 'Provide exactly one of client_id or matter_id.' });
    }
    if (hasClient && !db.prepare('SELECT id FROM clients WHERE id=?').get(b.client_id)) {
      return res.status(400).json({ error: 'Unknown client.' });
    }
    if (hasMatter && !db.prepare('SELECT id FROM matters WHERE id=?').get(b.matter_id)) {
      return res.status(400).json({ error: 'Unknown matter.' });
    }
    const v = normalizeBody(b, null);
    if (v.error) return res.status(400).json({ error: v.error });
    const max = db.prepare(
      'SELECT COALESCE(MAX(sort_order), -1) m FROM custom_fields WHERE client_id IS ? AND matter_id IS ?'
    ).get(hasClient ? b.client_id : null, hasMatter ? b.matter_id : null).m;
    try {
      const info = db.prepare(`INSERT INTO custom_fields
        (client_id, matter_id, name, type, options, pattern, pattern_hint, required, active, sort_order)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(hasClient ? b.client_id : null, hasMatter ? b.matter_id : null,
          v.name, v.type, v.options, v.pattern, v.pattern_hint, v.required, v.active, max + 1);
      res.status(201).json(pub(get.get(info.lastInsertRowid)));
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) {
        return res.status(409).json({ error: `A field named "${v.name}" already exists here.` });
      }
      throw e;
    }
  });

  r.patch('/:id', (req, res) => {
    const row = get.get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Field not found.' });
    const v = normalizeBody(req.body || {}, row);
    if (v.error) return res.status(400).json({ error: v.error });
    try {
      db.prepare('UPDATE custom_fields SET name=?, type=?, options=?, pattern=?, pattern_hint=?, required=?, active=? WHERE id=?')
        .run(v.name, v.type, v.options, v.pattern, v.pattern_hint, v.required, v.active, row.id);
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) {
        return res.status(409).json({ error: `A field named "${v.name}" already exists here.` });
      }
      throw e;
    }
    res.json(pub(get.get(row.id)));
  });

  r.put('/order', (req, res) => {
    const ids = (req.body || {}).ids;
    if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids array required.' });
    const upd = db.prepare('UPDATE custom_fields SET sort_order=? WHERE id=?');
    db.transaction(() => ids.forEach((id, i) => upd.run(i, id)))();
    res.json({ ok: true });
  });

  r.delete('/:id', (req, res) => {
    const row = get.get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Field not found.' });
    const used = db.prepare('SELECT COUNT(*) c FROM entry_custom_values WHERE field_id=?').get(row.id).c;
    if (used > 0) {
      return res.status(409).json({
        error: `"${row.name}" has ${used} recorded value${used === 1 ? '' : 's'} — deactivate it instead.`,
      });
    }
    db.prepare('DELETE FROM custom_fields WHERE id=?').run(row.id);
    res.json({ ok: true });
  });

  return r;
}
```

- [ ] **Step 4: Mount it**

In `server/app.js` add the import after the task-codes import:

```js
import { customFieldsRouter } from './routes/customfields.js';
```

and the mount after the `/api/task-codes` line:

```js
  app.use('/api/custom-fields', customFieldsRouter(deps));
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test test/api.customfields.test.js` then `npm test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add server/routes/customfields.js server/app.js test/api.customfields.test.js
git commit -m "feat(custom-fields): CRUD + effective-set API at /api/custom-fields"
```

---

### Task 4: Entries carry fields + values; finalize enforces them

**Files:**
- Modify: `server/routes/entries.js` (enrich, POST, PATCH, copy; two new helpers)
- Modify: `server/lib/validation.js` (consume the findings)
- Test: append to `test/api.entries.test.js` and `test/api.finalize.test.js`

**Interfaces:**
- Consumes: `loadEffectiveFields(db, matterId)` from Task 3; `validateFieldValues` from Task 2.
- Produces: entry payloads gain `custom_fields` (effective defs, options as arrays) and `custom_values` (`{field_id: value}`); POST/PATCH `/api/entries` accept `custom_values`; `POST /api/entries/:id/copy` duplicates values.
- Produces (module-internal): `normalizeCustomValues(db, matterId, values) → {ops|error}`, `applyCustomValues(db, entryId, ops)`.

- [ ] **Step 1: Write the failing tests**

Append to `test/api.entries.test.js` (adapt the seed to that file's existing server/matter setup — it already creates matters via `/api/cms`; use its `fetchJson`/`db` and a fresh matter so other tests are undisturbed):

```js
test('custom_values: round-trip, empty-string delete, non-applicable keys skipped', async () => {
  const { body: cm } = await fetchJson('POST', '/api/cms', { cm_number: '222333-000001', short_name: 'CF Matter' });
  const clientId = db.prepare("SELECT id FROM clients WHERE client_number='222333'").get().id;
  const { body: field } = await fetchJson('POST', '/api/custom-fields', {
    client_id: clientId, name: 'Phase', type: 'select', options: ['P100', 'P200'],
  });

  const created = await fetchJson('POST', '/api/entries', {
    date: '2026-07-15', cm_id: cm.id, narrative: 'CF round trip narrative',
    tasks: [{ duration: 0.5 }],
    custom_values: { [field.id]: 'P100', 424242: 'ignored' }, // unknown id silently skipped
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.custom_values[field.id], 'P100');
  assert.equal(created.body.custom_fields.some((f) => f.id === field.id), true);
  assert.equal(created.body.custom_values[424242], undefined);

  const patched = await fetchJson('PATCH', `/api/entries/${created.body.id}`,
    { custom_values: { [field.id]: 'P200' } });
  assert.equal(patched.body.custom_values[field.id], 'P200');

  const cleared = await fetchJson('PATCH', `/api/entries/${created.body.id}`,
    { custom_values: { [field.id]: '' } });
  assert.equal(cleared.body.custom_values[field.id], undefined);

  const bad = await fetchJson('PATCH', `/api/entries/${created.body.id}`, { custom_values: ['nope'] });
  assert.equal(bad.status, 400);

  // copy duplicates values
  await fetchJson('PATCH', `/api/entries/${created.body.id}`, { custom_values: { [field.id]: 'P100' } });
  const copy = await fetchJson('POST', `/api/entries/${created.body.id}/copy`, { date: '2026-07-16' });
  assert.equal(copy.body.custom_values[field.id], 'P100');
});
```

Append to `test/api.finalize.test.js` (same adaptation note):

```js
test('finalize: required custom field blocks until filled; format mismatch is ack-able', async () => {
  const { body: cm } = await fetchJson('POST', '/api/cms', { cm_number: '333444-000001', short_name: 'CF Gate' });
  const { body: req } = await fetchJson('POST', '/api/custom-fields', {
    matter_id: cm.id, name: 'Task', pattern: 'A\\d{3}', pattern_hint: 'A###', required: true,
  });
  const { body: entry } = await fetchJson('POST', '/api/entries', {
    date: '2026-07-15', cm_id: cm.id,
    narrative: 'A long enough narrative describing real substantive work.',
    tasks: [{ duration: 0.5, fragment: 'real work' }],
  });

  const blocked = await fetchJson('POST', `/api/entries/${entry.id}/finalize`, {});
  assert.equal(blocked.status, 422);
  assert.equal(blocked.body.blocks.some((b) => b.code === 'custom_required'), true);

  await fetchJson('PATCH', `/api/entries/${entry.id}`, { custom_values: { [req.id]: 'WRONG' } });
  const warned = await fetchJson('POST', `/api/entries/${entry.id}/finalize`, {});
  assert.equal(warned.status, 422);
  assert.equal(warned.body.blocks.length, 0);
  assert.equal(warned.body.warns.some((w) => w.code === 'custom_format'), true);

  const acked = await fetchJson('POST', `/api/entries/${entry.id}/finalize`, { ack: true });
  assert.equal(acked.status, 200); // warn is ack-able

  await fetchJson('POST', `/api/entries/${entry.id}/unlock`, {});
  await fetchJson('PATCH', `/api/entries/${entry.id}`, { custom_values: { [req.id]: 'A103' }, ack_validation: 0 });
  const clean = await fetchJson('POST', `/api/entries/${entry.id}/finalize`, {});
  assert.equal(clean.status, 200);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/api.entries.test.js test/api.finalize.test.js`
Expected: FAIL — `custom_values` come back undefined / finalize doesn't block.

- [ ] **Step 3: Wire the server**

In `server/routes/entries.js`:

(a) Add to the imports:

```js
import { loadEffectiveFields } from './customfields.js';
```

(b) In `enrich()`, after the `total` computation and before `const entry = {`:

```js
  const customFields = loadEffectiveFields(db, row.cm_id);
  const customValues = {};
  for (const v of db.prepare('SELECT field_id, value FROM entry_custom_values WHERE entry_id=?').all(row.id)) {
    customValues[v.field_id] = v.value;
  }
```

and extend the entry literal:

```js
  const entry = {
    // cm is null (not undefined) for a matterless entry so it survives JSON
    ...row, tasks, cm: cm || null, total,
    custom_fields: customFields, custom_values: customValues,
    narrative_auto: substantiveCount(tasks) >= 2 && !row.narrative_manual,
  };
```

(c) Below `writeTasks`, add the two helpers:

```js
// custom_values request shape: { [field_id]: value }. Keys that don't apply
// to the entry's matter (matter changed underneath an autosave, field
// deactivated) are SKIPPED, not errors — the editor keeps whatever keys it
// has in flight. Empty string deletes the stored value.
export function normalizeCustomValues(db, matterId, values) {
  if (values === undefined) return { ops: null };
  if (values === null || typeof values !== 'object' || Array.isArray(values)) {
    return { error: 'custom_values must be an object of { field_id: value }.' };
  }
  const effective = new Set(loadEffectiveFields(db, matterId).map((f) => f.id));
  const ops = [];
  for (const [k, raw] of Object.entries(values)) {
    const fieldId = Number(k);
    if (!Number.isInteger(fieldId) || !effective.has(fieldId)) continue;
    ops.push({ fieldId, value: String(raw ?? '').trim() });
  }
  return { ops };
}

export function applyCustomValues(db, entryId, ops) {
  if (!ops) return;
  const del = db.prepare('DELETE FROM entry_custom_values WHERE entry_id=? AND field_id=?');
  const up = db.prepare(`INSERT INTO entry_custom_values (entry_id, field_id, value) VALUES (?, ?, ?)
    ON CONFLICT(entry_id, field_id) DO UPDATE SET value=excluded.value`);
  for (const o of ops) {
    if (o.value === '') del.run(entryId, o.fieldId);
    else up.run(entryId, o.fieldId, o.value);
  }
}
```

(d) In `r.post('/')`, after the `normalizeTasks` guard add:

```js
    const cv = normalizeCustomValues(db, cm.id, b.custom_values);
    if (cv.error) return res.status(400).json({ error: cv.error });
```

and inside the transaction, after `writeTasks(...)`:

```js
      applyCustomValues(db, i.lastInsertRowid, cv.ops);
```

(e) In `r.patch('/:id')`, after the tasks normalization block add:

```js
    const cv = normalizeCustomValues(db, cmId, b.custom_values);
    if (cv.error) return res.status(400).json({ error: cv.error });
```

and inside the transaction, after `if (norm) writeTasks(db, row.id, norm.tasks);`:

```js
      applyCustomValues(db, row.id, cv.ops);
```

(f) In `r.post('/:id/copy')`, inside the transaction after `writeTasks(...)`:

```js
      db.prepare(`INSERT INTO entry_custom_values (entry_id, field_id, value)
        SELECT ?, field_id, value FROM entry_custom_values WHERE entry_id=?`)
        .run(i.lastInsertRowid, src.id);
```

(g) In `server/lib/validation.js`, add the import at the top:

```js
import { validateFieldValues } from './customfields.js';
```

and in `validateEntry`, after the task-billing enforcement block (just before
`return findings;`):

```js
  // Client/matter custom fields (2026-07-15): a required field with no value
  // blocks finalize (the billing system would bounce the entry); format and
  // dropdown-option mismatches warn (ack-able).
  findings.push(...validateFieldValues(entry.custom_fields || [], entry.custom_values || {}));
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — including every pre-existing entries/finalize/validation test (entries with no fields defined get `custom_fields: []` and validate exactly as before).

- [ ] **Step 5: Commit**

```bash
git add server/routes/entries.js server/lib/validation.js test/api.entries.test.js test/api.finalize.test.js
git commit -m "feat(custom-fields): entries carry values; required fields gate finalize"
```

---

### Task 5: CSV export columns

**Files:**
- Modify: `server/routes/export.js` (`buildExport`)
- Test: append to `test/api.export.test.js`

**Interfaces:**
- Consumes: `e.custom_fields` / `e.custom_values` from Task 4's `enrich()`.
- Produces: CSV header = `CSV_HEADER` + one `field:<Name>` column per distinct effective-field name (alphabetical, case-insensitive) across exported entries; every task-line row of an entry repeats its entry's values. No fields → header/rows byte-identical to today.

- [ ] **Step 1: Write the failing test**

Append to `test/api.export.test.js` (adapt seeds to that file's setup):

```js
test('CSV grows field:<Name> columns; no fields = legacy header', async () => {
  const { body: cm } = await fetchJson('POST', '/api/cms', { cm_number: '555666-000001', short_name: 'CF Export' });
  const clientId = db.prepare("SELECT id FROM clients WHERE client_number='555666'").get().id;
  const { body: phase } = await fetchJson('POST', '/api/custom-fields',
    { client_id: clientId, name: 'Phase', type: 'select', options: ['P100'] });
  await fetchJson('POST', '/api/entries', {
    date: '2031-01-05', cm_id: cm.id, narrative: 'Exported with a phase code narrative.',
    tasks: [{ duration: 0.3, fragment: 'phase-coded work' }],
    custom_values: { [phase.id]: 'P100' },
  });

  const withField = await fetchJson('POST', '/api/export',
    { from: '2031-01-05', to: '2031-01-05', includeDrafts: true, markExported: false });
  const header = withField.body.csv.split('\r\n')[0];
  assert.equal(header.endsWith(',field:Phase'), true);
  assert.equal(withField.body.csv.includes('P100'), true);

  // a range with no custom-field entries keeps the legacy header exactly
  const plain = await fetchJson('POST', '/api/export',
    { from: '2031-02-01', to: '2031-02-01', includeDrafts: true, markExported: false });
  assert.equal(plain.body.csv.split('\r\n')[0],
    'date,cm_number,cm_short_name,billable,task,duration,narrative,entry_total,entry_id');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/api.export.test.js`
Expected: FAIL — header has no `field:Phase`.

- [ ] **Step 3: Implement**

In `server/routes/export.js` `buildExport`, replace:

```js
  const csvRows = [];
  for (const e of entries) {
    const billable = e.billable ? 'billable' : 'non-billable';
    const lines = e.tasks.length > 0
      ? e.tasks
      : [{ task_code: '', duration: e.total }];
    for (const t of lines) {
      // Durations go out as stored numbers — display rounding must never
      // change what the billing system receives.
      csvRows.push([
        e.date, e.cm.cm_number, e.cm.short_name, billable,
        t.task_code, Number(t.duration) || 0,
        e.narrative, Number(e.total) || 0, e.id,
      ]);
    }
  }
```

with:

```js
  // Custom-field columns (2026-07-15): one per distinct effective-field name
  // across the exported entries, "field:"-prefixed so a custom field named
  // "task" can never collide with the fixed task column. Alphabetical for a
  // stable layout; blank where a field doesn't apply to that entry's matter.
  const fieldNames = [...new Set(entries.flatMap((e) => (e.custom_fields || []).map((f) => f.name)))]
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  const header = [...CSV_HEADER, ...fieldNames.map((n) => `field:${n}`)];

  const csvRows = [];
  for (const e of entries) {
    const billable = e.billable ? 'billable' : 'non-billable';
    const custom = fieldNames.map((n) => {
      const f = (e.custom_fields || []).find((x) => x.name === n);
      return f ? (e.custom_values?.[f.id] ?? '') : '';
    });
    const lines = e.tasks.length > 0
      ? e.tasks
      : [{ task_code: '', duration: e.total }];
    for (const t of lines) {
      // Durations go out as stored numbers — display rounding must never
      // change what the billing system receives.
      csvRows.push([
        e.date, e.cm.cm_number, e.cm.short_name, billable,
        t.task_code, Number(t.duration) || 0,
        e.narrative, Number(e.total) || 0, e.id,
        ...custom,
      ]);
    }
  }
```

and change the return's `csv:` line from `csv: toCsv(CSV_HEADER, csvRows),`
to `csv: toCsv(header, csvRows),`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS (existing export tests unaffected — no fields defined in their fixtures means the legacy header).

- [ ] **Step 5: Commit**

```bash
git add server/routes/export.js test/api.export.test.js
git commit -m "feat(custom-fields): CSV export grows field:<Name> columns"
```

---

### Task 6: Entry editor inputs

**Files:**
- Modify: `public/js/components/entryeditor.js`
- Modify: `public/css/app.css` (one rule)

**Interfaces:**
- Consumes: `GET /api/custom-fields/effective/:matterId` (options as arrays); entry payload `custom_values`; POST/PATCH `custom_values` body key.
- Produces: `local.custom_values` (`{field_id: value}`) included in every autosave.

- [ ] **Step 1: Carry values through local state**

In `public/js/components/entryeditor.js`:

(a) In `toLocal(e)`, add after `ack_validation: e.ack_validation,`:

```js
      custom_values: { ...(e.custom_values || {}) },
```

(b) In the new-entry template (`setLocal({ ... })` in the load effect), add after `ack_validation: 0,`:

```js
            custom_values: {},
```

(c) In `doPersist`, add to the `body` object after `narrative_manual: ...`:

```js
      custom_values: l.custom_values || {},
```

- [ ] **Step 2: Fetch the effective fields for the picked matter**

After the `const phrases = useMatterSuggestions(local?.cm?.id);` line add:

```js
  // Custom fields for the picked matter (client-level + matter-level —
  // spec 2026-07-15). Values live in local.custom_values keyed by field id
  // and ride the normal autosave.
  const [customFields, setCustomFields] = useState([]);
  useEffect(() => {
    const mid = local?.cm?.id;
    if (!mid) { setCustomFields([]); return undefined; }
    let alive = true;
    api.get(`/api/custom-fields/effective/${mid}`)
      .then((f) => { if (alive) setCustomFields(f); })
      .catch(() => { if (alive) setCustomFields([]); });
    return () => { alive = false; };
  }, [local?.cm?.id]);
```

- [ ] **Step 3: Render the inputs**

In the render, directly after the closing `</div>` of the header grid (the
`140px 1fr 110px auto` grid with Date/Client-Matter/Total/Billable) and before
the `Task lines` `section-title`, insert:

```js
      ${customFields.length > 0 ? html`
        <div class="custom-fields-row">
          ${customFields.map((f) => html`
            <${Field} key=${f.id} label=${f.name + (f.required ? ' *' : '')}>
              ${f.type === 'select' ? html`
                <select value=${local.custom_values?.[f.id] || ''} disabled=${finalized}
                  onChange=${(e) => update({ custom_values: { ...local.custom_values, [f.id]: e.target.value } })}>
                  <option value=""></option>
                  ${f.options.map((o) => html`<option key=${o} value=${o}>${o}</option>`)}
                </select>` : html`
                <input type="text" value=${local.custom_values?.[f.id] || ''} disabled=${finalized}
                  placeholder=${f.pattern_hint || ''}
                  onInput=${(e) => update({ custom_values: { ...local.custom_values, [f.id]: e.target.value } })} />`}
            <//>`)}
        </div>` : null}
```

- [ ] **Step 4: CSS**

Append to `public/css/app.css`:

```css
/* Entry editor: custom client/matter fields (Phase, Task, …) — a compact
   row between the header grid and the task lines. */
.custom-fields-row {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  gap: 10px; margin: 10px 0 4px;
}
```

- [ ] **Step 5: Verify by hand + regression**

Run: `npm test` → PASS.
Restart (`systemctl --user restart timekeeper`), hard-reload, then: define a
field on a client via `curl` or the API console, open a new entry on one of
its matters — the input renders, a typed value survives close/reopen, and
Finalize surfaces `custom_required` when the field is required and empty.
(The scripted e2e for this whole flow lands in Task 7.)

- [ ] **Step 6: Commit**

```bash
git add public/js/components/entryeditor.js public/css/app.css
git commit -m "feat(custom-fields): entry editor renders and autosaves field values"
```

---

### Task 7: Definitions UI on Clients & Matters + e2e + ship

**Files:**
- Create: `public/js/components/customfields.js`
- Modify: `public/js/views/cms.js`
- Modify: `scripts/e2e-smoke.mjs` (new step)
- Modify: `public/sw.js` (CACHE bump), `TODO.md`

**Interfaces:**
- Consumes: the full `/api/custom-fields` REST surface from Task 3.
- Produces: `CustomFieldsModal({ owner, title, onClose })` where `owner` is `{ client_id }` or `{ matter_id }`.

- [ ] **Step 1: Write the management modal**

Create `public/js/components/customfields.js`:

```js
import { api } from '/js/api.js';
import { html, useState, useEffect, Modal, emitToast } from '/js/ui.js';

// Manage custom-field definitions for one owner: { client_id } (applies to
// every matter under the client) or { matter_id } (that matter only; a
// same-named matter field overrides the client one). Values themselves are
// entered on entries — this is definitions only, task-codes style.
export function CustomFieldsModal({ owner, title, onClose }) {
  const [fields, setFields] = useState(null);
  const blank = { name: '', type: 'text', options: '', pattern: '', required: false };
  const [draft, setDraft] = useState(blank);

  const ownerQuery = owner.client_id ? `client_id=${owner.client_id}` : `matter_id=${owner.matter_id}`;
  const reload = () => api.get(`/api/custom-fields?${ownerQuery}&includeInactive=1`).then(setFields);
  useEffect(() => { reload().catch((e) => emitToast(e.message, { error: true })); }, []);

  const guard = (p) => p.catch((e) => emitToast(e.message, { error: true }));

  async function add(e) {
    e.preventDefault();
    if (!draft.name.trim()) return;
    await guard(api.post('/api/custom-fields', {
      ...owner,
      name: draft.name.trim(),
      type: draft.type,
      options: draft.type === 'select' ? splitOptions(draft.options) : [],
      pattern: draft.type === 'text' ? draft.pattern.trim() : '',
      required: draft.required,
    }).then(() => { setDraft(blank); return reload(); }));
  }

  const patch = (id, body) => guard(api.patch(`/api/custom-fields/${id}`, body).then(reload));

  async function move(i, dir) {
    const ids = fields.map((f) => f.id);
    const j = i + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    await guard(api.put('/api/custom-fields/order', { ids }).then(reload));
  }

  return html`
    <${Modal} title=${title} onClose=${onClose} wide=${true}>
      <p class="muted small">
        These fields appear on every time entry ${owner.client_id ? 'for matters under this client' : 'for this matter'} —
        e.g. a "Phase" or "Task" code the billing system requires. Values ride along on the CSV export.
        Required fields block finalizing until filled.
      </p>
      ${fields === null ? null : fields.length === 0 ? html`<p class="muted small">No fields yet.</p>` : html`
        <div class="grid" style=${{ gap: '6px' }}>
          ${fields.map((f, i) => html`
            <div key=${f.id} class="row custom-field-row" style=${{ flexWrap: 'nowrap', opacity: f.active ? 1 : 0.5 }}>
              <div class="reorder" style=${{ display: 'flex', flexDirection: 'column' }}>
                <button class="btn btn-ghost btn-sm" style=${{ padding: '0 6px' }} onClick=${() => move(i, -1)}>▲</button>
                <button class="btn btn-ghost btn-sm" style=${{ padding: '0 6px' }} onClick=${() => move(i, 1)}>▼</button>
              </div>
              <input type="text" defaultValue=${f.name} style=${{ width: '120px' }} title="Field name"
                onBlur=${(e) => { const v = e.target.value.trim(); if (v && v !== f.name) patch(f.id, { name: v }); }} />
              <select value=${f.type} title="Field type" onChange=${(e) => patch(f.id, { type: e.target.value })}>
                <option value="text">Text</option>
                <option value="select">Dropdown</option>
              </select>
              ${f.type === 'select' ? html`
                <input type="text" placeholder="options, comma-separated" title="Dropdown options"
                  defaultValue=${f.options.join(', ')}
                  onBlur=${(e) => patch(f.id, { options: splitOptions(e.target.value) })} />` : html`
                <input type="text" placeholder="format regex (optional), e.g. P\\d{3}" title="Format regex"
                  defaultValue=${f.pattern || ''}
                  onBlur=${(e) => patch(f.id, { pattern: e.target.value })} />`}
              <input type="text" placeholder="hint, e.g. P###" title="Shown as the input placeholder"
                defaultValue=${f.pattern_hint || ''} style=${{ width: '100px' }}
                onBlur=${(e) => patch(f.id, { pattern_hint: e.target.value })} />
              <label class="checkbox-row small" title="Finalize blocks while this field is empty">
                <input type="checkbox" checked=${!!f.required} onChange=${(e) => patch(f.id, { required: e.target.checked })} />
                req
              </label>
              <button class="btn btn-sm" title=${f.active ? 'Hide from entries (values kept)' : 'Reactivate'}
                onClick=${() => patch(f.id, { active: f.active ? 0 : 1 })}>${f.active ? 'Active' : 'Hidden'}</button>
              <button class="btn btn-ghost btn-sm" title="Delete (blocked once values exist — deactivate instead)"
                onClick=${() => guard(api.del(`/api/custom-fields/${f.id}`).then(reload))}>🗑</button>
            </div>`)}
        </div>`}
      <form class="row" style=${{ marginTop: '12px', flexWrap: 'nowrap' }} onSubmit=${add}>
        <input type="text" placeholder="New field name, e.g. Phase" value=${draft.name}
          onInput=${(e) => setDraft({ ...draft, name: e.target.value })} />
        <select value=${draft.type} onChange=${(e) => setDraft({ ...draft, type: e.target.value })}>
          <option value="text">Text</option>
          <option value="select">Dropdown</option>
        </select>
        ${draft.type === 'select' ? html`
          <input type="text" placeholder="options, comma-separated" value=${draft.options}
            onInput=${(e) => setDraft({ ...draft, options: e.target.value })} />` : html`
          <input type="text" placeholder="format regex (optional)" value=${draft.pattern}
            onInput=${(e) => setDraft({ ...draft, pattern: e.target.value })} />`}
        <label class="checkbox-row small">
          <input type="checkbox" checked=${draft.required}
            onChange=${(e) => setDraft({ ...draft, required: e.target.checked })} />
          required
        </label>
        <button class="btn">Add</button>
      </form>
    <//>`;
}

function splitOptions(text) {
  return String(text || '').split(',').map((s) => s.trim()).filter(Boolean);
}
```

- [ ] **Step 2: Wire it into CmsView**

In `public/js/views/cms.js`:

(a) Add the import:

```js
import { CustomFieldsModal } from '/js/components/customfields.js';
```

(b) Add state next to `editing`:

```js
  const [fieldsFor, setFieldsFor] = useState(null); // { owner: {client_id}|{matter_id}, title }
```

(c) In the client row's `<td colSpan="5">` cell, after the `ClientNameCell`:

```js
                    ${g.client_id != null ? html`
                      <button class="btn btn-ghost btn-sm" title="Custom fields for every matter under this client"
                        onClick=${() => setFieldsFor({
                          owner: { client_id: g.client_id },
                          title: `Custom fields — client ${clientLabel(g) || g.client_number}`,
                        })}><${Icon} name="settings" size=${14} /> Fields</button>` : null}
```

(d) In the matter row's action `.row`, before the Edit button:

```js
                        <button class="btn btn-ghost btn-sm" title="Custom fields for this matter only"
                          onClick=${() => setFieldsFor({
                            owner: { matter_id: cm.id },
                            title: `Custom fields — ${cm.short_name || cm.cm_number}`,
                          })}><${Icon} name="settings" size=${16} /></button>
```

(e) At the bottom, next to the `NewCmModal` render:

```js
    ${fieldsFor ? html`
      <${CustomFieldsModal} owner=${fieldsFor.owner} title=${fieldsFor.title}
        onClose=${() => { setFieldsFor(null); bumpRefresh(); }} />` : null}
```

- [ ] **Step 3: e2e — full flow**

In `scripts/e2e-smoke.mjs`, add a step after the CMS-related steps (anywhere
after matters exist; before the export steps is ideal):

```js
await step('custom fields: define on client, entry enforces + carries value', async () => {
  // define a required dropdown "Phase" on the first client
  await page.goto(`${base}/#/cms`, { waitUntil: 'networkidle0' });
  await waitFor('.client-row');
  await clickText('.client-row .btn', 'Fields');
  await waitFor('.modal form input[placeholder="New field name, e.g. Phase"]');
  await page.type('.modal form input[placeholder="New field name, e.g. Phase"]', 'Phase');
  await page.select('.modal form select', 'select');
  await page.type('.modal form input[placeholder="options, comma-separated"]', 'P100, P200');
  await page.click('.modal form .checkbox-row input');
  await clickText('.modal form button', 'Add');
  await page.waitForFunction(() => document.querySelectorAll('.modal .custom-field-row').length >= 1, { timeout: 4000 });
  await page.keyboard.press('Escape');

  // a new entry on a matter under that client renders the field and gates finalize
  await page.goto(`${base}/#/`, { waitUntil: 'networkidle0' });
  await page.keyboard.press('n');
  await waitFor('.modal .cmpicker input');
  await page.click('.modal .cmpicker input');
  await clickText('.cmpicker-item .name', 'Acme');
  await waitFor('.custom-fields-row select');
  await page.type('.modal-wide .total-input', '0.5');
  await page.type('.modal-wide .narrative-preview textarea, .modal-wide .narrative-preview .ghost-input textarea',
    'Reviewed the phase-coded workstream in detail today.');
  await clickText('.modal-wide button', 'Finalize');
  await page.waitForFunction(() => document.body.textContent.includes('"Phase" is required'), { timeout: 4000 });
  await page.select('.custom-fields-row select', 'P100');
  await clickText('.modal-wide button', 'Finalize');
  await page.waitForFunction(() => !document.querySelector('.modal-wide'), { timeout: 5000 });
});
```

(Adapt the two selectors marked with matter name `'Acme'` and the narrative
textarea to the seed data / DOM the smoke script already uses in its other
entry-editor steps — copy whatever the AUTO-narrative step uses to open an
editor and type a narrative.)

- [ ] **Step 4: CACHE bump + full verification**

- Bump `CACHE` in `public/sw.js` by one.
- Run: `npm test` → PASS.
- Run: `systemctl --user restart timekeeper && node scripts/e2e-smoke.mjs` → PASS.

- [ ] **Step 5: Update TODO.md and commit**

Remove the custom-fields line from `## Manual Notes from David:` in `TODO.md`.

```bash
git add public/js/components/customfields.js public/js/views/cms.js scripts/e2e-smoke.mjs public/sw.js TODO.md
git commit -m "feat(custom-fields): definitions UI on Clients & Matters + e2e"
```

---

## Deploy

```bash
systemctl --user restart timekeeper
```

## Follow-up for David (from the spec's ⚠️ list)

- Should the .TIM export carry Phase/Task values? Needs a phase-coded sample
  from the firm's importer to learn the field keys.
- Ratify: required=block / format=warn severity split; `field:` CSV header
  prefix; matter-overrides-client merge; no per-task-line values.
