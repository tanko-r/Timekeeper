# Phase 1b — Client-Aware Picker & Timer Grouping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the CM picker client-aware (one unified fuzzy search over client name/number + matter name/number, hierarchy shown, client→matter create path) and give the timer dashboard a persisted grouping selector (**By client · By group · Flat**), with a minimal inline client-naming affordance.

**Architecture:** A pure ranking function `rankMatters` in `server/lib/matterSearch.js` (unit-tested) powers `/api/cms/picker` — the route loads active matters (they already carry `client_id`/`client_number`/`client_name` from Phase 1a) and ranks them in JS; fine at single-user scale. `POST /api/cms` gains an optional `client_name` input that names a still-blank client. `/api/timers` list gains the same client fields so the grid can group by client. The frontend extends `cmpicker.js` (hierarchy rows + a client→matter create modal), `timergrid.js` (grouping selector persisted in localStorage), and `views/cms.js` (client header rows with inline rename via `PATCH /api/clients/:id`).

**Tech Stack:** Node 24 ESM, Express 5, better-sqlite3 (WAL), `node:test`. Frontend: no-build React 18 UMD + htm, plain ES modules in `public/js/`. E2E: `scripts/e2e-smoke.mjs` (headless system Chromium).

## Global Constraints

- Runtime deps stay exactly `express` + `better-sqlite3`. Do not add any dependency.
- **No schema change is needed in this phase.** Do not touch `server/db.js`. (If a migration ever became necessary it would be **appended** to `MIGRATIONS` guarded by `PRAGMA user_version` — never mutate old migrations.)
- Business logic goes in `server/lib/*` as **pure functions** with `node:test` unit tests. Routes stay thin. All server writes go through prepared statements.
- **No bundler, ever.** Browser code is plain ES modules under `public/js/`; React 18 UMD + htm only (vendored in `public/vendor/`).
- **`/api/cms` response field names are unchanged** (`cm_number`, `short_name`, `client_id`, `matter_number`, `client_number`, `client_name`, …). Export/CSV/`.TIM` shape must not change.
- The compact single-line timer card (`.timer-card`) is the **ratified baseline — extend, don't redesign**.
- Micro-animations are **NOT in this phase** (spec §7 is Phase 4).
- Migrated client names are **blank**; anything displaying a client renders the 6-digit `client_number` until the name is filled in.
- Persisting UI preferences in `localStorage` is fine (single-user app).
- Tests run with `npm test` (`node --test test/*.test.js`). The **entire suite must be green at the end of every task**; tasks that touch the frontend also end with `node scripts/e2e-smoke.mjs` ALL CLEAR.
- Dates are local `YYYY-MM-DD`; box TZ `America/Los_Angeles` (tests set `process.env.TZ`).
- **Phase 1b scope is exactly** spec §3.4 (client-aware picker) + the grouping selector from §3.4/§4 bullet 1. The other §4 items — **type-to-filter, worked-today highlight, keyboard focus model, the animated today footer — are Phase 3/4 and are explicitly OUT OF SCOPE here.**

Binding language from the spec (§3.4, §4):

> **CM picker (`cmpicker.js`)** becomes client-aware: one unified fuzzy search over client name/number + matter name/number (typing "meri harbor" matches), showing the hierarchy; a client→matter path when creating a new matter.

> **Both grouping axes coexist** (decided): timers can be organized **by client** (auto, like Intapp's client tabs) *and* by the existing user-defined `timer_groups` (e.g. "Litigation", cutting across clients). The timer dashboard gains a grouping selector (e.g. *By client · By group · Flat*).

---

### Task 1: `matterSearch` fuzzy-ranking library

**Files:**
- Create: `server/lib/matterSearch.js`
- Test: `test/matterSearch.test.js`

**Interfaces:**
- Consumes: matter row shape produced by Phase 1a's `/api/cms` queries — `{ id, cm_number, short_name, favorite, last_used_at, client_id, matter_number, client_number, client_name }`.
- Produces: `rankMatters(query: string, matters: object[], opts?: { limit?: number }): object[]` — filters + orders matters. Every whitespace-separated token of `query` must match (case-insensitive substring) at least one of `short_name`, `client_name`, `cm_number`, `matter_number`, `client_number`; word-start matches score higher. Empty query returns all, ordered favorite → recency → name (the classic picker order, which is also the tie-break order). Default `limit` 25.

- [ ] **Step 1: Write the failing test**

Create `test/matterSearch.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rankMatters } from '../server/lib/matterSearch.js';

// Minimal matter-row factory matching the /api/cms payload shape.
const M = (over = {}) => ({
  id: 1, cm_number: '100001-000012', short_name: 'Acme lease', favorite: 0,
  last_used_at: null, client_id: 1, matter_number: '000012',
  client_number: '100001', client_name: '', ...over,
});

test('empty query keeps favorites → recency → alpha ordering', () => {
  const zebra = M({ id: 1, short_name: 'Zenith Corp', last_used_at: '2026-07-06T10:00:00Z' });
  const apple = M({ id: 2, short_name: 'Aspen Partners' });
  const fav = M({ id: 3, short_name: 'Favorite Client', favorite: 1 });
  const out = rankMatters('', [zebra, apple, fav]);
  assert.deepEqual(out.map((m) => m.id), [3, 1, 2]);
});

test('multi-token query matches across client name and matter name', () => {
  const harbor = M({ id: 1, short_name: 'Harbor Lease', client_name: 'Meridian', client_number: '100004', cm_number: '100004-000001', matter_number: '000001' });
  const other = M({ id: 2, short_name: 'Summit Development', client_name: 'Meridian', client_number: '100004', cm_number: '100004-000002', matter_number: '000002' });
  const out = rankMatters('meri harbor', [other, harbor]);
  assert.deepEqual(out.map((m) => m.id), [1]);
});

test('every token must match somewhere (AND semantics)', () => {
  const a = M({ id: 1, short_name: 'Cedar Lease', client_name: 'Ironwood' });
  assert.deepEqual(rankMatters('ironwood lease', [a]).map((m) => m.id), [1]);
  assert.deepEqual(rankMatters('ironwood merger', [a]), []);
});

test('blank client names are handled; client numbers still match', () => {
  const a = M({ id: 1, client_name: '', client_number: '100001' });
  assert.deepEqual(rankMatters('100001', [a]).map((m) => m.id), [1]);
  assert.deepEqual(rankMatters('1000', [a]).map((m) => m.id), [1]);
});

test('word-start matches outrank mid-word matches', () => {
  const start = M({ id: 1, short_name: 'Lease renewal' });
  const mid = M({ id: 2, short_name: 'Sublease dispute' });
  const out = rankMatters('lease', [mid, start]);
  assert.deepEqual(out.map((m) => m.id), [1, 2]);
});

test('exact cm_number query matches only that matter; respects limit', () => {
  const rows = Array.from({ length: 30 }, (_, i) => M({
    id: i + 1,
    cm_number: `300000-${String(i + 1).padStart(6, '0')}`,
    matter_number: String(i + 1).padStart(6, '0'),
    short_name: `Matter ${i + 1}`,
  }));
  assert.deepEqual(rankMatters('300000-000002', rows).map((m) => m.id), [2]);
  assert.equal(rankMatters('', rows).length, 25);
  assert.equal(rankMatters('', rows, { limit: 5 }).length, 5);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/matterSearch.test.js`
Expected: FAIL — `Cannot find module '../server/lib/matterSearch.js'`.

- [ ] **Step 3: Write the implementation**

Create `server/lib/matterSearch.js`:

```js
// Unified fuzzy search over client + matter fields for the CM picker (spec
// §3.4: typing "meri harbor" matches client "Meridian" matter "Harbor…").
// Deterministic and dependency-free: every whitespace-separated query token
// must match (case-insensitive substring) at least one field; matches at the
// start of a word score higher. Ties fall back to the classic picker order:
// favorite DESC, last_used_at DESC (nulls last), short_name alpha.

const FIELDS = ['short_name', 'client_name', 'cm_number', 'matter_number', 'client_number'];
const WORD_SEP = /[\s\-–—.,/()&_]/;

function tokenScore(token, matter) {
  let best = 0;
  for (const field of FIELDS) {
    const value = String(matter[field] ?? '').toLowerCase();
    if (!value) continue; // blank client names post-migration
    const idx = value.indexOf(token);
    if (idx === -1) continue;
    best = Math.max(best, idx === 0 || WORD_SEP.test(value[idx - 1]) ? 2 : 1);
    if (best === 2) break;
  }
  return best; // 0 = this token matched nothing
}

export function rankMatters(query, matters, { limit = 25 } = {}) {
  const tokens = String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const scored = [];
  for (const m of matters) {
    let score = 0;
    let ok = true;
    for (const t of tokens) {
      const s = tokenScore(t, m);
      if (s === 0) { ok = false; break; } // AND semantics
      score += s;
    }
    if (ok) scored.push({ m, score });
  }
  const recency = (m) => (m.last_used_at ? Date.parse(m.last_used_at) : 0);
  scored.sort((a, b) =>
    b.score - a.score
    || (b.m.favorite ? 1 : 0) - (a.m.favorite ? 1 : 0)
    || recency(b.m) - recency(a.m)
    || String(a.m.short_name || '').localeCompare(String(b.m.short_name || ''), undefined, { sensitivity: 'base' }));
  return scored.slice(0, limit).map((s) => s.m);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/matterSearch.test.js`
Expected: PASS (6 tests).

- [ ] **Step 5: Run the full suite, then commit**

Run: `npm test` — Expected: PASS.

```bash
git add server/lib/matterSearch.js test/matterSearch.test.js
git commit -m "feat(lib): matterSearch fuzzy ranking over client + matter fields"
```

---

### Task 2: Picker endpoint goes fuzzy; `POST /api/cms` accepts `client_name`

**Files:**
- Modify: `server/routes/cms.js` (the `/picker` handler and the `POST /` handler)
- Test: `test/api.cms.test.js` (append two tests)

**Interfaces:**
- Consumes: `rankMatters` from `server/lib/matterSearch.js` (Task 1); `ensureClient`, `CM_COLS`, `CM_FROM`, `getCm` already in `server/routes/cms.js`.
- Produces: `GET /api/cms/picker?q=` — same response shape as today, now fuzzy-ranked across client + matter fields. `POST /api/cms` — accepts optional request field `client_name: string`; when the matter's client has a **blank** name it is set (never overwrites a non-blank name). Response shape unchanged.

- [ ] **Step 1: Write the failing tests**

Append to `test/api.cms.test.js`:

```js
test('picker: one unified fuzzy search over client and matter fields', () => withServer(async (t) => {
  await t.fetchJson('POST', '/api/cms', { cm_number: '100004-000001', short_name: 'Harbor Lease' });
  await t.fetchJson('POST', '/api/cms', { cm_number: '100004-000002', short_name: 'Summit Development' });
  await t.fetchJson('POST', '/api/cms', { cm_number: '100001-000012', short_name: 'Acme lease' });
  const client = (await t.fetchJson('GET', '/api/clients')).body.find((c) => c.client_number === '100004');
  await t.fetchJson('PATCH', `/api/clients/${client.id}`, { name: 'Meridian' });

  // "meri harbor" → client name + matter name, one result
  const fuzzy = (await t.fetchJson('GET', '/api/cms/picker?q=meri%20harbor')).body;
  assert.deepEqual(fuzzy.map((m) => m.short_name), ['Harbor Lease']);

  // client name alone matches all of that client's matters
  const byClient = (await t.fetchJson('GET', '/api/cms/picker?q=meridian')).body;
  assert.equal(byClient.length, 2);

  // 6-digit client number matches its matters
  const byClientNum = (await t.fetchJson('GET', '/api/cms/picker?q=100004')).body;
  assert.equal(byClientNum.length, 2);
}));

test('POST /api/cms client_name names a blank client but never overwrites', () => withServer(async (t) => {
  const a = (await t.fetchJson('POST', '/api/cms', {
    cm_number: '512001-000001', short_name: 'First', client_name: 'Brightwater',
  })).body;
  assert.equal(a.client_name, 'Brightwater');

  const b = (await t.fetchJson('POST', '/api/cms', {
    cm_number: '512001-000002', short_name: 'Second', client_name: 'WRONG',
  })).body;
  assert.equal(b.client_name, 'Brightwater'); // existing name kept
}));
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/api.cms.test.js`
Expected: FAIL — the fuzzy test gets 0 results for `meri harbor`/`meridian` (LIKE search doesn't see client names); the `client_name` test sees `''`.

- [ ] **Step 3: Implement**

In `server/routes/cms.js`, add the import at the top (after the `splitCmNumber` import):

```js
import { rankMatters } from '../lib/matterSearch.js';
```

Replace the entire `/picker` handler (currently the `r.get('/picker', …)` block using `LIKE`) with a prepared statement + pure ranking:

```js
  // Fuzzy picker: load active matters (with their client fields) and rank in
  // JS via the pure lib — single-user scale, so O(n) per keystroke is fine.
  const pickerStmt = db.prepare(`SELECT ${CM_COLS} ${CM_FROM} WHERE matters.status='active'`);

  r.get('/picker', (req, res) => {
    const q = String(req.query.q || '').trim();
    res.json(rankMatters(q, pickerStmt.all()));
  });
```

(Place `pickerStmt` where the old handler was, inside `cmsRouter` after `getCm`.)

Replace the `POST /` handler body so it destructures and applies `client_name`:

```js
  r.post('/', (req, res) => {
    const { cm_number, short_name = '', billable = 1, favorite = 0, client_name } = req.body || {};
    if (!validateCmNumber(cm_number)) {
      return res.status(400).json({ error: 'CM number must match format 123456-123456.' });
    }
    try {
      const { clientNumber, matterNumber } = splitCmNumber(cm_number);
      const clientId = ensureClient(db, clientNumber, now());
      if (client_name !== undefined && String(client_name).trim() !== '') {
        // Name a still-blank client at creation time; never overwrite a real name.
        db.prepare("UPDATE clients SET name=?, updated_at=? WHERE id=? AND name=''")
          .run(String(client_name).trim(), now(), clientId);
      }
      const info = db.prepare(
        'INSERT INTO matters (cm_number, short_name, billable, favorite, client_id, matter_number, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(cm_number, String(short_name), billable ? 1 : 0, favorite ? 1 : 0, clientId, matterNumber, now(), now());
      res.status(201).json(getCm.get(info.lastInsertRowid));
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) {
        return res.status(409).json({ error: `CM ${cm_number} already exists.` });
      }
      throw e;
    }
  });
```

- [ ] **Step 4: Run the cms tests, then the full suite**

Run: `node --test test/api.cms.test.js` — Expected: PASS, **including** the pre-existing tests `archive hides from picker but keeps CM` and `picker: favorites first, then recent, then alpha; searches number and name` (`rankMatters`' empty-query/tie-break order reproduces the old SQL ordering).
Run: `npm test` — Expected: PASS (note `test/api.timers.test.js` › `timer-created entries bump the CM picker recency` also exercises the picker order).

- [ ] **Step 5: Commit**

```bash
git add server/routes/cms.js test/api.cms.test.js
git commit -m "feat(api): unified fuzzy picker search; optional client_name on matter create"
```

---

### Task 3: `/api/timers` list carries client fields

**Files:**
- Modify: `server/routes/timers.js` (the `listStmt` query only)
- Test: `test/api.timers.test.js` (append one test)

**Interfaces:**
- Consumes: `matters.client_id`, `clients` (Phase 1a schema).
- Produces: every row from `GET /api/timers` additionally carries `client_id`, `client_number`, `client_name` (all `null` only if the matter row is somehow missing; `client_name` is `''` for blank-named clients). Existing fields unchanged. Task 5's grid relies on exactly these three names.

- [ ] **Step 1: Write the failing test**

Append to `test/api.timers.test.js` (uses that file's existing `withServer(startIso, fn)` helper, which pre-creates CM `100001-000012` "Acme lease"):

```js
test('timer list carries client fields for by-client grouping', () =>
  withServer('2026-07-06T09:00:00-07:00', async (t, cm) => {
    await t.fetchJson('POST', '/api/timers', { name: 'Acme research', cm_id: cm.id });
    let list = (await t.fetchJson('GET', '/api/timers')).body;
    assert.equal(list[0].client_number, '100001');
    assert.equal(list[0].client_name, ''); // blank until named
    assert.ok(list[0].client_id);

    const client = (await t.fetchJson('GET', '/api/clients')).body[0];
    await t.fetchJson('PATCH', `/api/clients/${client.id}`, { name: 'Acme Holdings' });
    list = (await t.fetchJson('GET', '/api/timers')).body;
    assert.equal(list[0].client_name, 'Acme Holdings');
  }));
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/api.timers.test.js`
Expected: FAIL — `client_number` is `undefined` on the timer row.

- [ ] **Step 3: Extend `listStmt`**

In `server/routes/timers.js`, replace the `listStmt` definition (inside `timersRouter`, currently two subselects for `cm_number`/`cm_short_name`) with:

```js
  const listStmt = () => db.prepare(`SELECT ${TIMER_COLS},
      (SELECT cm_number FROM matters WHERE matters.id = timers.cm_id) AS cm_number,
      (SELECT short_name FROM matters WHERE matters.id = timers.cm_id) AS cm_short_name,
      (SELECT client_id FROM matters WHERE matters.id = timers.cm_id) AS client_id,
      (SELECT c.client_number FROM matters m JOIN clients c ON c.id = m.client_id WHERE m.id = timers.cm_id) AS client_number,
      (SELECT c.name FROM matters m JOIN clients c ON c.id = m.client_id WHERE m.id = timers.cm_id) AS client_name
    FROM timers ORDER BY sort_order, id`);
```

- [ ] **Step 4: Run test to verify it passes, then the full suite**

Run: `node --test test/api.timers.test.js` — Expected: PASS.
Run: `npm test` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/routes/timers.js test/api.timers.test.js
git commit -m "feat(api): timer list carries client fields for by-client grouping"
```

---

### Task 4: Client-aware CM picker UI (hierarchy rows + client→matter create path)

**Files:**
- Modify: `public/js/ui.js` (add `clientLabel` helper)
- Rewrite: `public/js/components/cmpicker.js`
- Modify: `public/css/app.css` (one new rule in the cm-picker block)
- Modify: `scripts/e2e-smoke.mjs` (rewrite the create-CM step; add a fuzzy-search step)

**Interfaces:**
- Consumes: `GET /api/cms/picker` (Task 2 fuzzy), `GET /api/clients` (Phase 1a: `[{ id, client_number, name, matter_count, … }]`), `POST /api/cms` with optional `client_name` (Task 2).
- Produces: `clientLabel(x): string` exported from `public/js/ui.js` — display label for anything carrying client fields; `NewCmModal` keeps its export name and props (`{ initialQ, onCreated, onClose, existing }`) so `views/cms.js` needs no change in this task. Create-modal inputs carry stable e2e hooks: `[data-nc-client]`, `[data-nc-client-name]`, `[data-nc-matter]`, `[data-nc-name]`. The create button is labeled **"Create matter"** (distinct from other modals' "Create"). Task 5/6 consume `clientLabel`.

- [ ] **Step 1: Update the e2e script first (failing tests, in e2e form)**

In `scripts/e2e-smoke.mjs`, replace the whole step `await step('create CM through picker inside the editor (portal modals)', …)` with:

```js
await step('create client+matter through picker (client→matter path, prefilled)', async () => {
  await page.keyboard.press('n');
  await waitFor('.modal .cmpicker input');
  await type('.modal .cmpicker input', '100001-000012');
  await clickText('.cmpicker-item .name', 'New client/matter');
  await waitFor('[data-nc-matter]');
  // typed CM number pre-splits into client + matter numbers
  const cpre = await page.$eval('[data-nc-client]', (el) => el.value);
  if (cpre !== '100001') throw new Error(`client prefill wrong: ${cpre}`);
  const mpre = await page.$eval('[data-nc-matter]', (el) => el.value);
  if (mpre !== '000012') throw new Error(`matter prefill wrong: ${mpre}`);
  // deliberately leave the client UNNAMED (blank names must render as the number)
  await type('[data-nc-name]', 'Acme lease dispute');
  await clickText('.modal button', 'Create matter');
  await sleep(400);
});
```

Then insert this **new** step immediately after the `await step('timer clock is editable in place', …)` block:

```js
await step('picker: client→matter create + fuzzy client-name search', async () => {
  await clickText('button', 'New timer');
  await waitFor('.modal .cmpicker input');
  await page.click('.modal .cmpicker input');
  await clickText('.cmpicker-item .name', 'New client/matter');
  await waitFor('[data-nc-client]');
  await type('[data-nc-client]', '100004');
  await type('[data-nc-client-name]', 'Meridian'); // appears for new clients
  await type('[data-nc-matter]', '000001');
  await type('[data-nc-name]', 'Harbor Lease');
  await clickText('.modal button', 'Create matter');
  // back in the timer modal with the matter picked — reopen and fuzzy-search
  await waitFor('.modal .cmpicker button[title="Change CM"]');
  await page.click('.modal .cmpicker button[title="Change CM"]');
  await type('.modal .cmpicker input', 'meri harbor');
  await page.waitForFunction(() => [...document.querySelectorAll('.cmpicker-item')]
    .some((el) => el.textContent.includes('Meridian') && el.textContent.includes('Harbor Lease')),
  { timeout: 4000 });
  await clickText('.modal button', 'Cancel'); // no timer created
});
```

(The later `create timer` step's `clickText('.cmpicker-item .name', 'Acme')` keeps working: `.name` still holds the matter short name.)

- [ ] **Step 2: Run e2e to verify the new steps fail**

Run: `node scripts/e2e-smoke.mjs`
Expected: the rewritten create step and the new picker step FAIL (`[data-nc-matter]` never appears); exit code 1.

- [ ] **Step 3: Add `clientLabel` to `public/js/ui.js`**

Insert after the `fmtStamp` function:

```js
// Display label for anything carrying client fields: prefer the client's
// name, fall back to the 6-digit client number (migrated clients start with
// blank names). Accepts matter/timer payloads ({ client_name, client_number })
// and /api/clients rows ({ name, client_number }). NOTE: when a `client_name`
// key exists it wins even when blank — never falls through to an unrelated
// `name` field (e.g. a timer's button name).
export function clientLabel(x) {
  if (!x) return '';
  const name = x.client_name !== undefined ? x.client_name : x.name;
  return name || x.client_number || '';
}
```

- [ ] **Step 4: Rewrite `public/js/components/cmpicker.js`**

Replace the entire file with:

```js
import { api } from '/js/api.js';
import {
  html, useState, useEffect, useRef, Field, Modal, emitToast, clientLabel,
} from '/js/ui.js';

const SIX_RE = /^\d{6}$/;
const CM_RE = /^\d{6}-\d{6}$/;

// Type-ahead Client/Matter picker. value = cm object or null.
// onChange(cm). allowCreate shows a "New client/matter…" row.
// Search is one unified fuzzy query over client name/number + matter
// name/number (ranked server-side by /api/cms/picker).
export function CmPicker({ value, onChange, autoFocus, allowCreate = true, placeholder = 'Search client or matter…' }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState([]);
  const [hover, setHover] = useState(0);
  const [creating, setCreating] = useState(false);
  const boxRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    api.get(`/api/cms/picker?q=${encodeURIComponent(q)}`)
      .then((rows) => { if (alive) { setItems(rows); setHover(0); } })
      .catch(() => {});
    return () => { alive = false; };
  }, [q, open]);

  useEffect(() => {
    const onDoc = (e) => {
      if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  function pick(cm) {
    onChange(cm);
    setOpen(false);
    setQ('');
  }

  function onKey(e) {
    if (!open) return;
    const max = items.length - 1 + (allowCreate ? 1 : 0);
    if (e.key === 'ArrowDown') { e.preventDefault(); setHover((h) => Math.min(h + 1, max)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHover((h) => Math.max(h - 1, 0)); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      if (hover < items.length) pick(items[hover]);
      else if (allowCreate) setCreating(true);
    } else if (e.key === 'Escape') { setOpen(false); }
  }

  const favorites = items.filter((c) => c.favorite);
  const rest = items.filter((c) => !c.favorite);

  // Hierarchy shown per row: client (name, or number while unnamed) › matter.
  const renderItem = (cm, idx) => html`
    <div key=${cm.id} class=${'cmpicker-item' + (hover === idx ? ' hover' : '')}
      onMouseEnter=${() => setHover(idx)} onMouseDown=${(e) => { e.preventDefault(); pick(cm); }}>
      ${cm.favorite ? html`<span title="Favorite">★</span>` : null}
      ${clientLabel(cm) ? html`<span class="client" title=${clientLabel(cm)}>${clientLabel(cm)} ›</span>` : null}
      <span class="name">${cm.short_name || '(unnamed)'}</span>
      <span class="num">${cm.cm_number}</span>
    </div>`;

  return html`
    <div class="cmpicker" ref=${boxRef}>
      ${value && !open ? html`
        <div class="row" style=${{ flexWrap: 'nowrap' }}>
          <button type="button" class="btn" style=${{ flex: 1, justifyContent: 'space-between', overflow: 'hidden' }}
            onClick=${() => setOpen(true)} title="Change CM">
            <span style=${{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
              ${value.favorite ? '★ ' : ''}${value.short_name || '(unnamed)'}
            </span>
            <span class="muted mono small">${value.cm_number}</span>
          </button>
        </div>` : html`
        <input type="search" value=${q} placeholder=${placeholder} autoFocus=${autoFocus}
          onFocus=${() => setOpen(true)}
          onInput=${(e) => { setQ(e.target.value); setOpen(true); }}
          onKeyDown=${onKey} />`}
      ${open ? html`
        <div class="cmpicker-menu">
          ${favorites.length ? html`<div class="cmpicker-section">Favorites</div>` : null}
          ${favorites.map((cm) => renderItem(cm, items.indexOf(cm)))}
          ${favorites.length && rest.length ? html`<div class="cmpicker-section">Recent & all</div>` : null}
          ${rest.map((cm) => renderItem(cm, items.indexOf(cm)))}
          ${items.length === 0 ? html`<div class="cmpicker-item muted">No matches</div>` : null}
          ${allowCreate ? html`
            <div class=${'cmpicker-item' + (hover === items.length ? ' hover' : '')}
              onMouseEnter=${() => setHover(items.length)}
              onMouseDown=${(e) => { e.preventDefault(); setCreating(true); }}>
              <span class="name" style=${{ color: 'var(--accent)' }}>＋ New client/matter…</span>
            </div>` : null}
        </div>` : null}
      ${creating ? html`
        <${NewCmModal} initialQ=${q}
          onCreated=${(cm) => { setCreating(false); pick(cm); }}
          onClose=${() => setCreating(false)} />` : null}
    </div>`;
}

// Kept export name/props: edit mode is unchanged; create mode is the new
// client→matter path (spec §3.4).
export function NewCmModal(props) {
  return props.existing
    ? html`<${EditCmModal} ...${props} />`
    : html`<${CreateMatterModal} ...${props} />`;
}

// ---------- edit (unchanged behavior from the old modal) ----------

function EditCmModal({ existing, onCreated, onClose }) {
  const [num, setNum] = useState(existing.cm_number);
  const [name, setName] = useState(existing.short_name);
  const [billable, setBillable] = useState(!!existing.billable);
  const [favorite, setFavorite] = useState(!!existing.favorite);
  const [error, setError] = useState(null);

  const valid = CM_RE.test(num);

  async function save(e) {
    e.preventDefault();
    setError(null);
    try {
      const body = { cm_number: num, short_name: name, billable: billable ? 1 : 0, favorite: favorite ? 1 : 0 };
      const cm = await api.patch(`/api/cms/${existing.id}`, body);
      emitToast('CM updated');
      onCreated(cm);
    } catch (err) {
      setError(err.message);
    }
  }

  return html`
    <${Modal} title="Edit client/matter" onClose=${onClose}>
      <form onSubmit=${save} class="grid">
        <${Field} label="CM number" hint="Format: 123456-123456">
          <input type="text" value=${num} maxLength=${13}
            onInput=${(e) => setNum(e.target.value.replace(/[^\d-]/g, ''))} />
        <//>
        <${Field} label="Short name" hint="Your own shorthand — searchable">
          <input type="text" value=${name} onInput=${(e) => setName(e.target.value)} />
        <//>
        <label class="checkbox-row">
          <input type="checkbox" checked=${billable} onChange=${(e) => setBillable(e.target.checked)} />
          Billable by default
        </label>
        <label class="checkbox-row">
          <input type="checkbox" checked=${favorite} onChange=${(e) => setFavorite(e.target.checked)} />
          Pin as favorite
        </label>
        ${error ? html`<div class="error-box">${error}</div>` : null}
        <div class="row-end">
          <button type="button" class="btn" onClick=${onClose}>Cancel</button>
          <button class="btn btn-primary" disabled=${!valid}>Save</button>
        </div>
      </form>
    <//>`;
}

// ---------- create: client → matter path ----------

function CreateMatterModal({ initialQ = '', onCreated, onClose }) {
  const digits = String(initialQ).replace(/\D/g, ''); // "100001-000012" → prefill both
  const [clients, setClients] = useState([]);
  const [clientQ, setClientQ] = useState(digits.slice(0, 6));
  const [picked, setPicked] = useState(null); // existing client chosen from the list
  const [clientName, setClientName] = useState('');
  const [listOpen, setListOpen] = useState(false);
  const [matterNum, setMatterNum] = useState(digits.slice(6, 12));
  const [name, setName] = useState(/^[\d\s-]*$/.test(initialQ) ? '' : initialQ);
  const [billable, setBillable] = useState(true);
  const [favorite, setFavorite] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => { api.get('/api/clients').then(setClients).catch(() => {}); }, []);

  const ql = clientQ.trim().toLowerCase();
  const matches = (ql
    ? clients.filter((c) => c.client_number.includes(ql) || (c.name || '').toLowerCase().includes(ql))
    : clients).slice(0, 8);
  const exact = clients.find((c) => c.client_number === clientQ.trim()) || null;
  const effective = picked || exact; // existing client this matter will join
  const newNumber = !effective && SIX_RE.test(clientQ.trim()) ? clientQ.trim() : null;
  const clientNumber = effective ? effective.client_number : newNumber;
  const needsName = !!newNumber || (effective && !effective.name);
  const valid = !!clientNumber && SIX_RE.test(matterNum.trim());

  async function save(e) {
    e.preventDefault();
    setError(null);
    try {
      const body = {
        cm_number: `${clientNumber}-${matterNum.trim()}`,
        short_name: name, billable: billable ? 1 : 0, favorite: favorite ? 1 : 0,
      };
      if (needsName && clientName.trim()) body.client_name = clientName.trim();
      const cm = await api.post('/api/cms', body);
      emitToast(`CM ${cm.cm_number} created`);
      onCreated(cm);
    } catch (err) {
      setError(err.message);
    }
  }

  return html`
    <${Modal} title="New client/matter" onClose=${onClose}>
      <form onSubmit=${save} class="grid">
        <${Field} label="Client" hint=${effective
          ? `Existing client ${effective.client_number}${effective.name ? '' : ' (unnamed)'}`
          : newNumber ? `New client ${newNumber} will be created` : 'Search by name, or type a 6-digit client number'}>
          ${picked ? html`
            <button type="button" class="btn" style=${{ justifyContent: 'space-between' }} title="Change client"
              onClick=${() => { setPicked(null); setClientQ(''); setListOpen(true); }}>
              <span>${clientLabel(picked)}</span>
              <span class="muted mono small">${picked.client_number}</span>
            </button>` : html`
            <div class="cmpicker">
              <input type="search" data-nc-client value=${clientQ} autoFocus placeholder="e.g. Meridian or 100004"
                onFocus=${() => setListOpen(true)}
                onInput=${(e) => { setClientQ(e.target.value); setListOpen(true); }}
                onBlur=${() => setTimeout(() => setListOpen(false), 150)} />
              ${listOpen && matches.length > 0 && !exact ? html`
                <div class="cmpicker-menu">
                  ${matches.map((c) => html`
                    <div key=${c.id} class="cmpicker-item"
                      onMouseDown=${(ev) => { ev.preventDefault(); setPicked(c); setListOpen(false); }}>
                      <span class="name">${clientLabel(c)}</span>
                      <span class="num">${c.client_number} · ${c.matter_count} matter${c.matter_count === 1 ? '' : 's'}</span>
                    </div>`)}
                </div>` : null}
            </div>`}
        <//>
        ${needsName ? html`
          <${Field} label="Client name" hint="Optional — shown instead of the bare number everywhere">
            <input type="text" data-nc-client-name value=${clientName} placeholder="e.g. Meridian"
              onInput=${(e) => setClientName(e.target.value)} />
          <//>` : null}
        <${Field} label="Matter number" hint="6 digits">
          <input type="text" data-nc-matter value=${matterNum} placeholder="000012" maxLength=${6}
            onInput=${(e) => setMatterNum(e.target.value.replace(/\D/g, ''))} />
        <//>
        <${Field} label="Short name" hint="Your own shorthand — searchable">
          <input type="text" data-nc-name value=${name} onInput=${(e) => setName(e.target.value)} />
        <//>
        <label class="checkbox-row">
          <input type="checkbox" checked=${billable} onChange=${(e) => setBillable(e.target.checked)} />
          Billable by default
        </label>
        <label class="checkbox-row">
          <input type="checkbox" checked=${favorite} onChange=${(e) => setFavorite(e.target.checked)} />
          Pin as favorite
        </label>
        ${error ? html`<div class="error-box">${error}</div>` : null}
        <div class="row-end">
          <button type="button" class="btn" onClick=${onClose}>Cancel</button>
          <button class="btn btn-primary" disabled=${!valid}>Create matter</button>
        </div>
      </form>
    <//>`;
}
```

- [ ] **Step 5: Add the picker-client CSS rule**

In `public/css/app.css`, inside the `/* ---------- cm picker ---------- */` block, add after the `.cmpicker-item .num` rule:

```css
.cmpicker-item .client {
  color: var(--text-muted); font-size: 12px; flex: none; max-width: 45%;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
```

- [ ] **Step 6: Run the unit suite and the e2e**

Run: `npm test` — Expected: PASS (no server changes in this task).
Run: `node scripts/e2e-smoke.mjs` — Expected: all steps ✔ including the rewritten create step and the new fuzzy step; `E2E SMOKE: ALL CLEAR`.

- [ ] **Step 7: Commit**

```bash
git add public/js/ui.js public/js/components/cmpicker.js public/css/app.css scripts/e2e-smoke.mjs
git commit -m "feat(ui): client-aware CM picker with client->matter create path"
```

---

### Task 5: Timer dashboard grouping selector (By group · By client · Flat, persisted)

**Files:**
- Modify: `public/js/components/timergrid.js` (grouping state, header selector, section builder, `TimerCard` gets `canDrag`)
- Modify: `public/css/app.css` (segmented-control rules)
- Modify: `scripts/e2e-smoke.mjs` (add one step)

**Interfaces:**
- Consumes: `client_id`/`client_number`/`client_name` on `GET /api/timers` rows (Task 3); `clientLabel` from `public/js/ui.js` (Task 4).
- Produces: grouping selector persisted under localStorage key `tk:timerGrouping` (values `'group' | 'client' | 'flat'`, default `'group'`); CSS classes `.seg`, `.seg button.on`. Drag-and-drop and the "Drop timers here" affordance are only active in By-group mode (dropping re-assigns `timer_groups`, which is meaningless in the other views). The compact card itself is unchanged apart from the `canDrag` prop.

- [ ] **Step 1: Add the failing e2e step**

In `scripts/e2e-smoke.mjs`, insert immediately after the `await step('groups: create, assign via menu, collapse; A-Z present', …)` block:

```js
await step('grouping selector: by client / flat / persists across reload', async () => {
  await clickText('.seg button', 'By client');
  // Acme's client is unnamed → its section is labeled by the 6-digit number
  await page.waitForFunction(() => [...document.querySelectorAll('.group-head .group-name')]
    .some((el) => el.textContent.trim() === '100001'), { timeout: 4000 });
  await clickText('.seg button', 'Flat');
  await page.waitForFunction(() => document.querySelectorAll('.group-head').length === 0
    && document.querySelectorAll('.timer-card').length >= 1, { timeout: 4000 });
  await page.reload({ waitUntil: 'networkidle0' });
  await waitFor('.timer-card');
  const on = await page.$eval('.seg button.on', (el) => el.textContent.trim());
  if (on !== 'Flat') throw new Error(`grouping did not persist: ${on}`);
  await clickText('.seg button', 'By group');
  await page.waitForFunction(() => [...document.querySelectorAll('.group-name')]
    .some((el) => el.textContent.includes('Litigation')), { timeout: 4000 });
});
```

Run: `node scripts/e2e-smoke.mjs` — Expected: the new step FAILS (`.seg` doesn't exist yet); all prior steps stay ✔.

- [ ] **Step 2: Add grouping state to `TimerGrid`**

In `public/js/components/timergrid.js`:

Add `clientLabel` to the `/js/ui.js` import list (it currently imports `html, useState, useEffect, useRef, useCallback, fmtClock, fmtHours, fmtTenths, emitToast, Modal, Confirm, ContextMenu, Field, Icon`).

Then, directly after `const dragId = useRef(null);`, add:

```js
  // Grouping view (spec §3.4/§4): 'group' = user-defined timer_groups,
  // 'client' = the matter's client, 'flat' = one list. Persisted per-browser.
  const [grouping, setGroupingState] = useState(() => {
    const v = localStorage.getItem('tk:timerGrouping');
    return ['group', 'client', 'flat'].includes(v) ? v : 'group';
  });
  const setGrouping = (v) => { localStorage.setItem('tk:timerGrouping', v); setGroupingState(v); };
```

- [ ] **Step 3: Replace the render prelude, header, and sections map**

Still in `timergrid.js`, replace everything from `if (!timers) return null;` down through the `})}` that closes `${sections.map(({ group, list }) => { … })}` (leave `${timers.length === 0 ? …}` and everything after it untouched) with:

```js
  if (!timers) return null;
  const idleAfter = (settings.idleNudgeHours ?? 3) * 3600;
  const hasGroups = groups.length > 0;
  const byGroupMode = grouping === 'group';

  let sections; // [{ key, group, label, list }] — group is non-null only in by-group mode
  if (grouping === 'client') {
    const byClient = new Map();
    for (const t of timers) {
      const key = t.client_id ?? 'none';
      if (!byClient.has(key)) {
        byClient.set(key, { key: `client-${key}`, group: null, label: clientLabel(t) || 'No client', list: [] });
      }
      byClient.get(key).list.push(t);
    }
    sections = [...byClient.values()].sort((a, b) =>
      a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }));
  } else if (grouping === 'flat') {
    sections = [{ key: 'flat', group: null, label: null, list: timers }];
  } else {
    sections = [
      ...groups.map((g) => ({ key: `group-${g.id}`, group: g, label: g.name, list: timers.filter((t) => t.group_id === g.id) })),
      { key: 'ungrouped', group: null, label: null, list: timers.filter((t) => t.group_id == null) },
    ];
  }

  return html`
    <div class="section-title">
      <h2>Timers</h2>
      <div class="seg" role="group" aria-label="Timer grouping">
        ${[['group', 'By group'], ['client', 'By client'], ['flat', 'Flat']].map(([v, label]) => html`
          <button key=${v} class=${grouping === v ? 'on' : ''} title=${`Show timers: ${label.toLowerCase()}`}
            onClick=${() => setGrouping(v)}>${label}</button>`)}
      </div>
      <div class="spacer" style=${{ flex: 1 }}></div>
      <button class="btn btn-sm" title="Sort by CM name within groups" onClick=${() => guard(sortAZ())}>
        <${Icon} name="sortAZ" size=${16} /> A–Z
      </button>
      <button class="btn btn-sm" onClick=${() => setGroupModal('new')}>
        <${Icon} name="folder" size=${16} /> New group
      </button>
      <button class="btn btn-sm" title="Batch-create timers from a CSV" onClick=${() => setImporting(true)}>
        <${Icon} name="download" size=${16} /> Import
      </button>
      <button class="btn btn-sm btn-primary" onClick=${() => setEditing('new')}>
        <${Icon} name="plus" size=${16} /> New timer
      </button>
    </div>

    ${sections.map((sec) => {
      const { group, list } = sec;
      if (byGroupMode && !group && list.length === 0 && hasGroups) return null;
      const collapsed = byGroupMode && group && group.collapsed;
      const showHead = byGroupMode ? (group || hasGroups) : grouping === 'client';
      return html`
        <div key=${sec.key} class="timer-section"
          onDragOver=${byGroupMode ? (e) => e.preventDefault() : undefined}
          onDrop=${byGroupMode ? (e) => { e.preventDefault(); guard(dropOn({ kind: 'group', groupId: group ? group.id : null })); } : undefined}>
          ${showHead ? html`
            <div class="group-head">
              ${group ? html`
                <button class="btn btn-ghost btn-sm" title=${collapsed ? 'Expand' : 'Collapse'}
                  onClick=${() => guard(api.patch(`/api/timer-groups/${group.id}`, { collapsed: collapsed ? 0 : 1 }).then(reload))}>
                  <${Icon} name=${collapsed ? 'chevronRight' : 'chevronDown'} size=${16} />
                </button>
                <span class="group-name">${group.name}</span>
                <span class="muted small">${list.length}</span>
                <span class="group-tools">
                  <button class="btn btn-ghost btn-sm" title="Rename group" onClick=${() => setGroupModal(group)}>
                    <${Icon} name="edit" size=${14} /></button>
                  <button class="btn btn-ghost btn-sm" title="Delete group (timers kept)"
                    onClick=${() => guard(api.del(`/api/timer-groups/${group.id}`).then(reload))}>
                    <${Icon} name="trash" size=${14} /></button>
                </span>` : sec.label != null ? html`
                <span class="group-name">${sec.label}</span>
                <span class="muted small">${list.length}</span>` : html`
                <span class="group-name muted">Ungrouped</span>
                <span class="muted small">${list.length}</span>`}
            </div>` : null}
          ${collapsed ? null : html`
            <div class="timer-grid">
              ${list.map((t) => html`
                <${TimerCard} key=${t.id} timer=${t} secs=${liveElapsed(t)} idleAfter=${idleAfter}
                  canDrag=${byGroupMode}
                  roundMode=${settings.rounding?.enabled === false ? 'nearest' : (settings.rounding?.mode || 'up')}
                  onStart=${() => guard(start(t))} onStop=${() => guard(stop(t))}
                  onDelta=${(d) => guard(clockDelta(t, d))} onSet=${(h) => guard(clockSet(t, h))}
                  onMenu=${(x, y) => setMenu({ x, y, timer: t })}
                  onDragStart=${() => { dragId.current = t.id; }}
                  onDropOn=${() => guard(dropOn({ kind: 'timer', timer: t }))} />`)}
              ${byGroupMode && list.length === 0 ? html`<div class="muted small" style=${{ padding: '8px' }}>Drop timers here</div>` : null}
            </div>`}
        </div>`;
    })}
```

- [ ] **Step 4: Give `TimerCard` the `canDrag` prop**

Change the `TimerCard` function signature to:

```js
function TimerCard({ timer, secs, idleAfter, roundMode, canDrag = true, onStart, onStop, onDelta, onSet, onMenu, onDragStart, onDropOn }) {
```

and replace the card container's drag attributes (`draggable="true"` and the three `onDrag*`/`onDrop` handlers) with:

```js
      draggable=${canDrag ? 'true' : 'false'}
      title=${`${timer.name} — ${fmtClock(secs)} elapsed`}
      onDragStart=${(e) => { if (!canDrag) { e.preventDefault(); return; } e.dataTransfer.effectAllowed = 'move'; onDragStart(); }}
      onDragOver=${(e) => { if (!canDrag) return; e.preventDefault(); e.stopPropagation(); }}
      onDrop=${(e) => { if (!canDrag) return; e.preventDefault(); e.stopPropagation(); onDropOn(); }}
```

(Everything else inside `TimerCard` stays exactly as-is — the compact card is the ratified baseline.)

- [ ] **Step 5: Add the segmented-control CSS**

In `public/css/app.css`, in the `/* ---------- timers (compact, grouped) ---------- */` block, add after the `.group-head:hover .group-tools` rule:

```css
.seg { display: inline-flex; border: 1px solid var(--border); border-radius: 7px; overflow: hidden; margin-left: 10px; }
.seg button {
  border: 0; background: none; padding: 3px 10px; font-size: 12px; cursor: pointer;
  color: var(--text-muted);
}
.seg button + button { border-left: 1px solid var(--border); }
.seg button.on { background: var(--surface-2); color: var(--text-primary); font-weight: 600; }
```

- [ ] **Step 6: Run the unit suite and the e2e**

Run: `npm test` — Expected: PASS.
Run: `node scripts/e2e-smoke.mjs` — Expected: all steps ✔ including `grouping selector: by client / flat / persists across reload`; ALL CLEAR.

- [ ] **Step 7: Commit**

```bash
git add public/js/components/timergrid.js public/css/app.css scripts/e2e-smoke.mjs
git commit -m "feat(ui): timer grouping selector - by client / by group / flat, persisted"
```

---

### Task 6: Inline client naming in the Clients & Matters view

**Files:**
- Rewrite: `public/js/views/cms.js`
- Modify: `public/css/app.css` (client-row rule)
- Modify: `scripts/e2e-smoke.mjs` (add one step)

**Interfaces:**
- Consumes: `/api/cms` rows carrying `client_id`/`client_number`/`client_name` (Phase 1a); `PATCH /api/clients/:id { name }` (Phase 1a); `clientLabel` from `public/js/ui.js` (Task 4); `NewCmModal` (Task 4, same props).
- Produces: the matters table grouped under `tr.client-row` header rows with an inline rename (`button[title="Name client"]` → text input → PATCH). This is the minimal naming affordance — a full Clients view is out of scope.

- [ ] **Step 1: Add the failing e2e step**

In `scripts/e2e-smoke.mjs`, insert immediately after the Task 5 step (`grouping selector: …`):

```js
await step('client rename: inline on CMs view, reflected in by-client grouping', async () => {
  await page.goto(`${base}/#/cms`, { waitUntil: 'networkidle0' });
  await waitFor('.client-row');
  await page.evaluate(() => {
    const row = [...document.querySelectorAll('.client-row')].find((r) => r.textContent.includes('100001'));
    row.querySelector('button[title="Name client"]').click();
  });
  await type('.client-row input', 'Acme Holdings');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => [...document.querySelectorAll('.client-row')]
    .some((r) => r.textContent.includes('Acme Holdings')), { timeout: 4000 });
  // the by-client grouping now shows the name instead of the number
  await page.goto(`${base}/#/`, { waitUntil: 'networkidle0' });
  await clickText('.seg button', 'By client');
  await page.waitForFunction(() => [...document.querySelectorAll('.group-head .group-name')]
    .some((el) => el.textContent.trim() === 'Acme Holdings'), { timeout: 4000 });
  await clickText('.seg button', 'By group'); // restore for later steps
});
```

Run: `node scripts/e2e-smoke.mjs` — Expected: the new step FAILS (`.client-row` never appears); prior steps stay ✔.

- [ ] **Step 2: Rewrite `public/js/views/cms.js`**

Replace the entire file with:

```js
import { api } from '/js/api.js';
import {
  html, useState, useAsync, Spinner, ErrorBox, emitToast, BillableBadge, fmtStamp, Icon, clientLabel,
} from '/js/ui.js';
import { NewCmModal } from '/js/components/cmpicker.js';

export function CmsView({ refreshKey, bumpRefresh }) {
  const [q, setQ] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [editing, setEditing] = useState(null); // 'new' | cm

  const { loading, data, error, reload } = useAsync(
    () => api.get(`/api/cms?includeArchived=${showArchived ? 1 : 0}`),
    [showArchived, refreshKey]);

  const ql = q.toLowerCase();
  const rows = (data || []).filter((c) =>
    !q
    || c.cm_number.includes(q)
    || (c.short_name || '').toLowerCase().includes(ql)
    || (c.client_name || '').toLowerCase().includes(ql)
    || (c.client_number || '').includes(q));

  // Group matters under their client (blank names render as the number —
  // the visible prompt to name them).
  const byClient = new Map();
  for (const cm of rows) {
    const key = cm.client_id ?? `none-${cm.id}`;
    if (!byClient.has(key)) {
      byClient.set(key, {
        client_id: cm.client_id, client_number: cm.client_number,
        client_name: cm.client_name, matters: [],
      });
    }
    byClient.get(key).matters.push(cm);
  }
  const clientGroups = [...byClient.values()].sort((a, b) =>
    (clientLabel(a) || '').localeCompare(clientLabel(b) || '', undefined, { sensitivity: 'base' }));

  async function toggleFavorite(cm) {
    await api.patch(`/api/cms/${cm.id}`, { favorite: cm.favorite ? 0 : 1 });
    reload();
  }

  async function toggleArchive(cm) {
    await api.patch(`/api/cms/${cm.id}`, { status: cm.status === 'archived' ? 'active' : 'archived' });
    emitToast(cm.status === 'archived' ? 'Restored to active' : 'Archived — hidden from pickers, entries kept');
    reload();
  }

  async function del(cm) {
    try {
      await api.del(`/api/cms/${cm.id}`);
      emitToast('CM deleted');
      reload();
    } catch (e) {
      emitToast(e.message, { error: true });
    }
  }

  return html`
    <div class="page-head"><h1>Clients & Matters</h1>
      <div class="spacer"></div>
      <label class="checkbox-row">
        <input type="checkbox" checked=${showArchived} onChange=${(e) => setShowArchived(e.target.checked)} />
        Show archived
      </label>
      <button class="btn btn-primary" onClick=${() => setEditing('new')}><${Icon} name="plus" size=${16} /> New CM</button>
    </div>

    <div class="card" style=${{ marginBottom: '12px' }}>
      <input type="search" placeholder="Filter by client, number, or name…" value=${q} onInput=${(e) => setQ(e.target.value)} />
    </div>

    ${error ? html`<${ErrorBox} error=${error} />` : loading && !data ? html`<${Spinner} />` : html`
      <div class="card table-wrap" style=${{ padding: 0 }}>
        <table class="tk">
          <thead><tr>
            <th style=${{ width: '30px' }}></th><th>CM number</th><th>Short name</th>
            <th>Default</th><th>Entries</th><th>Last used</th><th></th>
          </tr></thead>
          <tbody>
            ${clientGroups.map((g) => html`
              <${React.Fragment} key=${g.client_id ?? g.matters[0].id}>
                <tr class="client-row">
                  <td></td>
                  <td class="mono">${g.client_number || '—'}</td>
                  <td colSpan="5"><${ClientNameCell} group=${g} onSaved=${() => { reload(); bumpRefresh(); }} /></td>
                </tr>
                ${g.matters.map((cm) => html`
                  <tr key=${cm.id} style=${{ opacity: cm.status === 'archived' ? 0.55 : 1 }}>
                    <td><button class=${'star' + (cm.favorite ? ' on' : '')} title="Favorite"
                      onClick=${() => toggleFavorite(cm)}>★</button></td>
                    <td class="mono">${cm.cm_number}</td>
                    <td>${cm.short_name} ${cm.status === 'archived' ? html`<span class="chip">archived</span>` : ''}</td>
                    <td><${BillableBadge} billable=${cm.billable} /></td>
                    <td class="mono">${cm.entry_count ?? 0}</td>
                    <td class="small muted">${cm.last_used_at ? fmtStamp(cm.last_used_at) : '—'}</td>
                    <td>
                      <div class="row" style=${{ gap: '2px', flexWrap: 'nowrap', justifyContent: 'flex-end' }}>
                        <button class="btn btn-ghost btn-sm" title="Edit" onClick=${() => setEditing(cm)}><${Icon} name="edit" size=${16} /></button>
                        <button class="btn btn-ghost btn-sm" title=${cm.status === 'archived' ? 'Unarchive' : 'Archive'}
                          onClick=${() => toggleArchive(cm)}><${Icon} name=${cm.status === 'archived' ? 'archiveRestore' : 'archive'} size=${16} /></button>
                        <button class="btn btn-ghost btn-sm" title=${cm.entry_count > 0 ? 'Has entries — archive instead' : 'Delete'}
                          disabled=${cm.entry_count > 0} onClick=${() => del(cm)}><${Icon} name="trash" size=${16} /></button>
                      </div>
                    </td>
                  </tr>`)}
              <//>`)}
            ${clientGroups.length === 0 ? html`
              <tr><td colSpan="7" class="muted" style=${{ textAlign: 'center', padding: '30px' }}>
                No client/matters yet — create your first.
              </td></tr>` : null}
          </tbody>
        </table>
      </div>`}

    ${editing ? html`
      <${NewCmModal} existing=${editing === 'new' ? null : editing}
        onCreated=${() => { setEditing(null); reload(); bumpRefresh(); }}
        onClose=${() => setEditing(null)} />` : null}
  `;
}

// Inline client naming — the minimal affordance from spec §3.3 ("a visible
// prompt to name it"). Enter/blur saves via PATCH /api/clients/:id.
function ClientNameCell({ group, onSaved }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(group.client_name || '');

  async function save() {
    setEditing(false);
    const name = text.trim();
    if (name === (group.client_name || '')) return;
    try {
      await api.patch(`/api/clients/${group.client_id}`, { name });
      emitToast(name ? 'Client named' : 'Client name cleared');
      onSaved();
    } catch (e) {
      emitToast(e.message, { error: true });
    }
  }

  if (editing) {
    return html`
      <input type="text" value=${text} autoFocus placeholder="Client name…"
        style=${{ maxWidth: '280px' }}
        onInput=${(e) => setText(e.target.value)}
        onBlur=${save}
        onKeyDown=${(e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setEditing(false); }} />`;
  }
  return html`
    <span class="client-name-cell">
      <strong>${clientLabel(group) || '(no client)'}</strong>
      ${!group.client_name ? html`<span class="muted small">— unnamed</span>` : null}
      <button class="btn btn-ghost btn-sm" title="Name client" disabled=${!group.client_id}
        onClick=${() => { setText(group.client_name || ''); setEditing(true); }}>
        <${Icon} name="edit" size=${14} /></button>
    </span>`;
}
```

Note: `React` is a named export of `/js/ui.js` (`export const React = window.React;`) — add it to this file's import list from `/js/ui.js` (it is in the list above via `clientLabel`; make sure the final import line reads `html, useState, useAsync, Spinner, ErrorBox, emitToast, BillableBadge, fmtStamp, Icon, clientLabel, React`).

- [ ] **Step 3: Add the client-row CSS**

In `public/css/app.css`, after the `table.tk tr.clickable` rule, add:

```css
table.tk tr.client-row td {
  background: var(--surface-2); font-size: 12.5px; padding: 5px 10px;
}
.client-name-cell { display: inline-flex; align-items: center; gap: 6px; }
```

- [ ] **Step 4: Run the unit suite and the e2e**

Run: `npm test` — Expected: PASS.
Run: `node scripts/e2e-smoke.mjs` — Expected: all steps ✔ including `client rename: inline on CMs view, reflected in by-client grouping`; ALL CLEAR.

- [ ] **Step 5: Commit**

```bash
git add public/js/views/cms.js public/css/app.css scripts/e2e-smoke.mjs
git commit -m "feat(ui): inline client naming on the Clients & Matters view"
```

---

## Self-Review

**Spec coverage (Phase 1b scope):**
- §3.4 "one unified fuzzy search over client name/number + matter name/number (typing 'meri harbor' matches)" → Task 1 (ranking lib, unit-tested with exactly that query) + Task 2 (endpoint) + Task 4 (UI) + e2e fuzzy step. ✓
- §3.4 "showing the hierarchy" → Task 4 per-row `client › matter` rendering (per-row rather than client section headers, so the fuzzy *rank* order stays visible; favorites section retained). ✓
- §3.4 "a client→matter path when creating a new matter" → Task 4 `CreateMatterModal` (pick existing client or type a new 6-digit number, optional client name, then matter number + short name), e2e-covered both for a brand-new client (Acme, left unnamed) and a new named client (Meridian). ✓
- §3.3/§3.4 blank client names render as the 6-digit number → `clientLabel` (Task 4), asserted in the Task 5 e2e (`100001` section label) and Task 3 unit test. ✓
- §4 bullet 1 / §3.4 "grouping selector (By client · By group · Flat)" with both axes coexisting → Task 5 (needs Task 3's payload fields); persisted via localStorage (allowed: single-user). ✓
- Client-naming affordance (needed so "by client" ever shows names) → Task 6 inline rename via existing `PATCH /api/clients/:id`. ✓
- §10 testing: every new lib function unit-tested (Task 1); e2e extended for picker client-name match, client→matter create, grouping switch + persistence, inline rename; existing e2e assertions kept green (the create-CM step is *deliberately* rewritten for the new modal, like the compact-grid commit did). ✓
- **Explicitly out of scope (Phase 3/4, per §9):** type-to-filter, worked-today highlight, keyboard focus model, animated today footer, micro-animations, memory layer, quick-capture, close-out. No task touches them.

**Placeholder scan:** No TBD/TODO/"handle edge cases". Every code step contains complete, transcribable code (full file rewrites for `cmpicker.js` and `views/cms.js`; bounded region replacement with full replacement text for `timergrid.js`). The only "keep unchanged" directions point at code that stays byte-identical, with its boundaries named.

**Type consistency:** `rankMatters(query, matters, { limit })` — Task 1 definition = Task 2 usage. Payload fields `client_id`/`client_number`/`client_name` — Task 2/3 producers = Task 4/5/6 consumers (`client_name` is `''`, never null, for blank-named linked clients — asserted in Tasks 2–3). `clientLabel(x)` handles both `{ client_name }` (matters/timers, key present even when blank) and `{ name }` (client rows) — Task 4 definition, used in Tasks 4, 5, 6. localStorage key `tk:timerGrouping` consistent between Task 5 code and its e2e. e2e hooks `[data-nc-*]`, button label "Create matter", `.seg`, `.client-row`, `button[title="Name client"]` each defined in the same task as the e2e that uses them.

**Known deliberate choices (not defects):**
- The picker loads all active matters per keystroke and ranks in JS — O(n) is fine for a single-user practice (hundreds of matters), and it keeps the fuzzy logic pure and unit-testable.
- Drag-and-drop (and "Drop timers here") is disabled outside By-group mode because dropping re-assigns `timer_groups` membership, which would be an invisible side effect in By-client/Flat views. A–Z / New group / Import stay available in all modes.
- `NewCmModal`'s **edit** mode is intentionally unchanged (still edits the raw `cm_number` string); the client→matter path applies to creation, which is what §3.4 asks for.
