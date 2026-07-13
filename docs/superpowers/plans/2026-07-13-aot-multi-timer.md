# AOT Multi-Timer Window Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expand the always-on-top PiP timer window into a compact multi-timer panel: all timers with time today, expand-on-click narrative entry, server-side pins, and a `+` quick-timer button.

**Architecture:** Vanilla-DOM rewrite of the Document PiP window in `public/js/lib/pip.js` over new unit-tested pure helpers; two new `timers` columns (`pinned`, `draft_narrative`); the timer list API carries the linked entry's narrative + editability so the window needs no extra fetches. Spec: `docs/superpowers/specs/2026-07-13-aot-multi-timer-design.md`.

**Tech Stack:** Node 24 ESM, Express 5, better-sqlite3, no-build browser ES modules, node:test.

## Global Constraints

- Runtime deps are exactly `express` + `better-sqlite3`; frontend is no-build (no bundler, no new vendor files).
- Schema changes = append a NEW string to `MIGRATIONS` in `server/db.js`; never edit existing entries.
- All server writes via prepared statements; business rules in pure functions with unit tests; TDD (failing test first).
- Tests: `npm test` (node:test). E2E: `node scripts/e2e-smoke.mjs`.
- After changing `public/js/**` or `public/css/*.css`: bump `CACHE` in `public/sw.js` (currently `timekeeper-v25` → `timekeeper-v26`, once, in the final task).
- After changing server code: `systemctl --user restart timekeeper` (final task).
- Dates are local `YYYY-MM-DD`; durations are decimal hours; timer clock is a day accumulator (see comments in `server/routes/timers.js`).
- Atomic commits, one per task, message style: `feat(scope): summary`.

---

### Task 1: Migration — `pinned` + `draft_narrative` columns on timers

**Files:**
- Modify: `server/db.js` (append to `MIGRATIONS`, currently ends at index 28 with `'ALTER TABLE timers ADD COLUMN held_since TEXT;'` on line 228)
- Modify: `server/routes/timers.js:19-21` (`TIMER_COLS`)
- Test: `test/api.timers.test.js`

**Interfaces:**
- Consumes: existing `MIGRATIONS` array / `TIMER_COLS` constant.
- Produces: every timer row (all `getTimer`/`listStmt` reads use `TIMER_COLS`) now carries `pinned` (0/1) and `draft_narrative` (string|null). Later tasks rely on these exact names.

- [ ] **Step 1: Write the failing test**

Append to `test/api.timers.test.js`:

```js
test('timers carry pinned + draft_narrative with defaults', () =>
  withServer('2026-07-13T09:00:00-07:00', async (t, cm) => {
    await t.fetchJson('POST', '/api/timers', { name: 'A', cm_id: cm.id });
    const list = (await t.fetchJson('GET', '/api/timers')).body;
    assert.equal(list[0].pinned, 0);
    assert.equal(list[0].draft_narrative, null);
  }));
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/api.timers.test.js 2>&1 | tail -20`
Expected: FAIL — `list[0].pinned` is `undefined` (column doesn't exist / not selected).

- [ ] **Step 3: Implement**

In `server/db.js`, append to `MIGRATIONS` (after the `held_since` entry, before the closing `];`):

```js
  // AOT float window (2026-07-13 spec): pinned keeps a timer in the PiP list
  // across days; draft_narrative stashes narrative text typed before an entry
  // exists (consumed by the next entry the timer creates).
  `ALTER TABLE timers ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE timers ADD COLUMN draft_narrative TEXT;`,
```

In `server/routes/timers.js`, extend `TIMER_COLS`:

```js
const TIMER_COLS = `id, name, cm_id, task_code, sort_order, running,
  accumulated_seconds, last_started_at, last_reset_date, created_at,
  group_id, linked_entry_id, last_stopped_at, suggested_narrative, held_since,
  pinned, draft_narrative`;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/api.timers.test.js 2>&1 | tail -5` → PASS. Then `npm test 2>&1 | tail -5` → all pass (migration must not break `test/db.test.js`).

- [ ] **Step 5: Commit**

```bash
git add server/db.js server/routes/timers.js test/api.timers.test.js
git commit -m "feat(db): pinned + draft_narrative columns on timers"
```

---

### Task 2: `PATCH /api/timers/:id` accepts `pinned` and `draft_narrative`

**Files:**
- Modify: `server/routes/timers.js:267-313` (the `r.patch('/:id', …)` handler)
- Test: `test/api.timers.test.js`

**Interfaces:**
- Consumes: Task 1 columns.
- Produces: `PATCH /api/timers/:id` body may include `pinned` (truthy→1, falsy→0) and `draft_narrative` (string; empty/whitespace stores NULL). **`draft_narrative` and `pinned` survive a matter change** (unlike `suggested_narrative`/`held_since`, which the handler clears on `cmChanged`).

- [ ] **Step 1: Write the failing tests**

Append to `test/api.timers.test.js`:

```js
test('PATCH pinned + draft_narrative round-trip; unrelated PATCH leaves them alone', () =>
  withServer('2026-07-13T09:00:00-07:00', async (t, cm) => {
    const timer = (await t.fetchJson('POST', '/api/timers', { name: 'A', cm_id: cm.id })).body;
    await t.fetchJson('PATCH', `/api/timers/${timer.id}`, {
      pinned: 1, draft_narrative: 'Call with opposing counsel re discovery.',
    });
    let got = (await t.fetchJson('GET', '/api/timers')).body[0];
    assert.equal(got.pinned, 1);
    assert.equal(got.draft_narrative, 'Call with opposing counsel re discovery.');

    await t.fetchJson('PATCH', `/api/timers/${timer.id}`, { name: 'B' });
    got = (await t.fetchJson('GET', '/api/timers')).body[0];
    assert.equal(got.pinned, 1, 'pinned survives an unrelated PATCH');
    assert.equal(got.draft_narrative, 'Call with opposing counsel re discovery.');

    await t.fetchJson('PATCH', `/api/timers/${timer.id}`, { pinned: 0, draft_narrative: '  ' });
    got = (await t.fetchJson('GET', '/api/timers')).body[0];
    assert.equal(got.pinned, 0);
    assert.equal(got.draft_narrative, null, 'blank stash stores NULL');
  }));
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/api.timers.test.js 2>&1 | tail -20`
Expected: FAIL — PATCH ignores `pinned`, so the first `assert.equal(got.pinned, 1)` sees `0`.

- [ ] **Step 3: Implement**

In the `r.patch('/:id', …)` handler, replace the `UPDATE timers SET …` statement (currently `name=?, cm_id=?, task_code=?, group_id=?, linked_entry_id=?, suggested_narrative=?, held_since=? WHERE id=?`) with:

```js
    db.prepare('UPDATE timers SET name=?, cm_id=?, task_code=?, group_id=?, linked_entry_id=?, suggested_narrative=?, held_since=?, pinned=?, draft_narrative=? WHERE id=?').run(
      name,
      b.cm_id !== undefined ? b.cm_id : timer.cm_id,
      b.task_code !== undefined ? (b.task_code ? String(b.task_code) : null) : timer.task_code,
      b.group_id !== undefined ? b.group_id : timer.group_id,
      cmChanged ? null : timer.linked_entry_id, // new CM → old entry no longer its home
      cmChanged ? null : timer.suggested_narrative, // suggestion belonged to the old matter
      cmChanged ? null : timer.held_since, // assigned → the held time files below
      b.pinned !== undefined ? (b.pinned ? 1 : 0) : timer.pinned,
      // user text — deliberately SURVIVES cmChanged; the assignment's
      // syncToEntry below is exactly where the stash gets consumed (Task 3)
      b.draft_narrative !== undefined
        ? (String(b.draft_narrative ?? '').trim() || null)
        : timer.draft_narrative,
      timer.id);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/api.timers.test.js 2>&1 | tail -5` → PASS.

- [ ] **Step 5: Commit**

```bash
git add server/routes/timers.js test/api.timers.test.js
git commit -m "feat(timers): PATCH accepts pinned + draft_narrative"
```

---

### Task 3: `syncToEntry` applies + clears the stash on new-entry creation

**Files:**
- Modify: `server/routes/timers.js:35-82` (`syncToEntry`)
- Test: `test/api.timers.test.js`

**Interfaces:**
- Consumes: `timer.draft_narrative` from Task 1/2 (all `syncToEntry` callers already pass a fresh `TIMER_COLS` row).
- Produces: when `syncToEntry` INSERTs a new entry, the entry's `narrative` is `timer.draft_narrative || ''` and the stash is cleared in the same transaction. The update path (existing linked entry) never touches the stash or the entry narrative.

- [ ] **Step 1: Write the failing tests**

Append to `test/api.timers.test.js`:

```js
test('stash: start on a matter timer creates the entry WITH the stashed narrative and clears it', () =>
  withServer('2026-07-13T09:00:00-07:00', async (t, cm) => {
    const timer = (await t.fetchJson('POST', '/api/timers', { name: 'A', cm_id: cm.id })).body;
    await t.fetchJson('PATCH', `/api/timers/${timer.id}`, {
      draft_narrative: 'Drafted motion to compel further responses.',
    });
    const started = (await t.fetchJson('POST', `/api/timers/${timer.id}/start`)).body;
    assert.equal(started.entry.narrative, 'Drafted motion to compel further responses.');
    const got = (await t.fetchJson('GET', '/api/timers')).body[0];
    assert.equal(got.draft_narrative, null, 'stash consumed');
  }));

test('stash: quick-timer flow — stop holds, assign files held time with the stash', () =>
  withServer('2026-07-13T09:00:00-07:00', async (t, cm, clock) => {
    const timer = (await t.fetchJson('POST', '/api/timers', {})).body; // no matter
    await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
    await t.fetchJson('PATCH', `/api/timers/${timer.id}`, {
      draft_narrative: 'Call with client re scheduling order.',
    });
    clock.advance(1800);
    const stop = (await t.fetchJson('POST', `/api/timers/${timer.id}/stop`)).body;
    assert.equal(stop.unassigned, true);
    assert.equal(stop.entry, null, 'no matter yet — time held, no entry');

    const assigned = (await t.fetchJson('PATCH', `/api/timers/${timer.id}`, { cm_id: cm.id })).body;
    assert.ok(assigned.entry, 'held time files on assignment');
    assert.equal(assigned.entry.narrative, 'Call with client re scheduling order.');
    assert.equal(assigned.draft_narrative, null);
  }));

test('stash: NOT applied to an existing linked entry; stays until a new entry consumes it', () =>
  withServer('2026-07-13T09:00:00-07:00', async (t, cm, clock) => {
    const timer = (await t.fetchJson('POST', '/api/timers', { name: 'A', cm_id: cm.id })).body;
    await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
    clock.advance(1200);
    const stop1 = (await t.fetchJson('POST', `/api/timers/${timer.id}/stop`)).body;
    await t.fetchJson('PATCH', `/api/entries/${stop1.entry.id}`, { narrative: 'Original narrative kept.' });

    await t.fetchJson('PATCH', `/api/timers/${timer.id}`, { draft_narrative: 'Late stash.' });
    await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
    clock.advance(1200);
    const stop2 = (await t.fetchJson('POST', `/api/timers/${timer.id}/stop`)).body;
    assert.equal(stop2.entry.id, stop1.entry.id);
    assert.equal(stop2.entry.narrative, 'Original narrative kept.', 'existing entry narrative wins');
    const got = (await t.fetchJson('GET', '/api/timers')).body[0];
    assert.equal(got.draft_narrative, 'Late stash.', 'stash waits for a NEW entry');
  }));
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/api.timers.test.js 2>&1 | tail -30`
Expected: first two stash tests FAIL (`started.entry.narrative` is `''`); the third PASSES already (update path never wrote narrative) — that's fine, it pins the invariant.

- [ ] **Step 3: Implement**

In `syncToEntry`, the `else` (INSERT) branch becomes:

```js
    } else {
      const cm = db.prepare('SELECT id, billable FROM matters WHERE id=?').get(timer.cm_id);
      const info = db.prepare(`INSERT INTO entries
        (date, cm_id, narrative, billable, status, total_override, source, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'draft', ?, 'timer', ?, ?)`)
        .run(dateStr, timer.cm_id, timer.draft_narrative || '',
          cm ? cm.billable : 1, hours, nowIso, nowIso);
      db.prepare(
        'INSERT INTO entry_tasks (entry_id, task_code, duration, fragment, sort_order) VALUES (?, ?, ?, ?, 0)'
      ).run(info.lastInsertRowid, timer.task_code || '', hours, '');
      entryId = info.lastInsertRowid;
      // stash consumed: text typed before this entry existed now lives on it
      db.prepare('UPDATE timers SET linked_entry_id=?, draft_narrative=NULL WHERE id=?')
        .run(entryId, timer.id);
    }
```

(Only two changes: `narrative` VALUES slot takes `timer.draft_narrative || ''`, and the linking UPDATE also nulls `draft_narrative`.)

Note: `deleteIfUntouched` only removes entries with `narrative=''` — an entry born from a stash survives misclick grace, which is correct (the text is worth keeping).

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/api.timers.test.js 2>&1 | tail -5` → PASS. Then `npm test 2>&1 | tail -5` → all pass.

- [ ] **Step 5: Commit**

```bash
git add server/routes/timers.js test/api.timers.test.js
git commit -m "feat(timers): stashed draft_narrative files with newly created entries"
```

---

### Task 4: `GET /api/timers` carries linked-entry narrative + editability

**Files:**
- Modify: `server/routes/timers.js:153-160` (`listStmt`)
- Test: `test/api.timers.test.js`

**Interfaces:**
- Consumes: `linked_entry_id`; `entries.narrative`, `entries.narrative_manual`, `entry_tasks`.
- Produces: each timer in `GET /api/timers` gains `entry_narrative` (string|null), `entry_narrative_manual` (0/1|null), `entry_substantive_lines` (int; 0 when unlinked). "Substantive" mirrors `substantiveCount` in `server/routes/entries.js:39`: non-blank fragment OR non-blank task_code OR duration > 0. Client editability rule (Task 5): editable ⇔ `entry_substantive_lines < 2 || entry_narrative_manual`.

- [ ] **Step 1: Write the failing test**

Append to `test/api.timers.test.js`:

```js
test('timer list exposes linked-entry narrative + substantive line count', () =>
  withServer('2026-07-13T09:00:00-07:00', async (t, cm, clock) => {
    const timer = (await t.fetchJson('POST', '/api/timers', { name: 'A', cm_id: cm.id })).body;
    await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
    clock.advance(3600);
    const stop = (await t.fetchJson('POST', `/api/timers/${timer.id}/stop`)).body;

    let got = (await t.fetchJson('GET', '/api/timers')).body[0];
    assert.equal(got.entry_narrative, '');
    assert.equal(got.entry_narrative_manual, 0);
    assert.equal(got.entry_substantive_lines, 1, 'timer entries start single-line');

    await t.fetchJson('PATCH', `/api/entries/${stop.entry.id}`, {
      tasks: [
        { task_code: 'Research', duration: 0.6, fragment: 'research preemption' },
        { task_code: 'Draft', duration: 0.4, fragment: 'draft memo' },
      ],
    });
    got = (await t.fetchJson('GET', '/api/timers')).body[0];
    assert.equal(got.entry_substantive_lines, 2);
    assert.ok(got.entry_narrative.includes('Research preemption'), 'generated narrative rides along');

    const quick = (await t.fetchJson('POST', '/api/timers', {})).body;
    got = (await t.fetchJson('GET', '/api/timers')).body.find((x) => x.id === quick.id);
    assert.equal(got.entry_narrative, null);
    assert.equal(got.entry_substantive_lines, 0, 'unlinked timer counts zero lines');
  }));
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/api.timers.test.js 2>&1 | tail -20`
Expected: FAIL — `got.entry_narrative` is `undefined`.

- [ ] **Step 3: Implement**

In `listStmt`, add three subselects after the existing `client_name` one (before `FROM timers`):

```js
      (SELECT c.name FROM matters m JOIN clients c ON c.id = m.client_id WHERE m.id = timers.cm_id) AS client_name,
      (SELECT narrative FROM entries WHERE entries.id = timers.linked_entry_id) AS entry_narrative,
      (SELECT narrative_manual FROM entries WHERE entries.id = timers.linked_entry_id) AS entry_narrative_manual,
      (SELECT COUNT(*) FROM entry_tasks WHERE entry_tasks.entry_id = timers.linked_entry_id
        AND (TRIM(COALESCE(entry_tasks.fragment, '')) != ''
          OR TRIM(COALESCE(entry_tasks.task_code, '')) != ''
          OR COALESCE(entry_tasks.duration, 0) > 0)) AS entry_substantive_lines
    FROM timers ORDER BY sort_order, id`);
```

(The COUNT mirrors `substantiveCount` in `server/routes/entries.js` — keep the OR clauses in the same order for greppability.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/api.timers.test.js 2>&1 | tail -5` → PASS.

- [ ] **Step 5: Commit**

```bash
git add server/routes/timers.js test/api.timers.test.js
git commit -m "feat(timers): timer list carries linked-entry narrative + editability"
```

---

### Task 5: Pure row-model helpers in `lib/pip.js`

**Files:**
- Modify: `public/js/lib/pip.js` (add `buildPipRows`, `narrativeMode`, `narrativeValue`, `fmtDayTotal`; DELETE `pickPipTimer` — nothing outside its own tests imports it, `app.js` only uses `pipSupported`/`toggleTimerPip`; verify with `grep -rn pickPipTimer public/ test/`)
- Test: `test/pip.test.js` (rewrite: drop `pickPipTimer` tests, add new-helper tests; keep `fmtClock` + `pipSupported` tests)

**Interfaces:**
- Consumes: timer objects from `GET /api/timers` (Tasks 1–4 fields: `running`, `elapsed_seconds`, `pinned`, `linked_entry_id`, `draft_narrative`, `entry_narrative`, `entry_narrative_manual`, `entry_substantive_lines`).
- Produces (Task 6 relies on these exact signatures):
  - `buildPipRows(timers) → timer[]` — running first, then input order; includes running OR `elapsed_seconds > 0` OR pinned.
  - `narrativeMode(t) → 'stash' | 'readonly' | 'entry'`
  - `narrativeValue(t) → string` — what the field shows for `t` (stash text or entry narrative, `''` fallback).
  - `fmtDayTotal(totalSeconds) → string` — e.g. `'1.1h today'`.

- [ ] **Step 1: Write the failing tests**

Replace the `pickPipTimer` tests in `test/pip.test.js` (keep the `fmtClock` and `pipSupported` tests) so the file reads:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPipRows, narrativeMode, narrativeValue, fmtDayTotal, fmtClock, pipSupported,
} from '../public/js/lib/pip.js';

const T = (id, extra = {}) => ({
  id, running: 0, elapsed_seconds: 0, pinned: 0, linked_entry_id: null,
  draft_narrative: null, entry_narrative: null, entry_narrative_manual: null,
  entry_substantive_lines: 0, ...extra,
});

test('buildPipRows: running OR time-today OR pinned; running first, input order kept', () => {
  const timers = [
    T(1),                                  // idle, no time — hidden
    T(2, { elapsed_seconds: 600 }),        // time today
    T(3, { pinned: 1 }),                   // pinned at zero
    T(4, { running: 1, elapsed_seconds: 60 }),
    T(5, { elapsed_seconds: 30 }),
  ];
  assert.deepEqual(buildPipRows(timers).map((t) => t.id), [4, 2, 3, 5]);
  assert.deepEqual(buildPipRows([]), []);
  assert.deepEqual(buildPipRows(null), []);
});

test('narrativeMode: stash without an entry, readonly for auto split entries, else entry', () => {
  assert.equal(narrativeMode(T(1)), 'stash');
  assert.equal(narrativeMode(T(1, { linked_entry_id: 9, entry_substantive_lines: 1 })), 'entry');
  assert.equal(narrativeMode(T(1, { linked_entry_id: 9, entry_substantive_lines: 2 })), 'readonly');
  assert.equal(
    narrativeMode(T(1, { linked_entry_id: 9, entry_substantive_lines: 2, entry_narrative_manual: 1 })),
    'entry', 'detached narrative is free text even on a split entry');
});

test('narrativeValue: stash text before an entry exists, entry narrative after', () => {
  assert.equal(narrativeValue(T(1, { draft_narrative: 'Stashed.' })), 'Stashed.');
  assert.equal(narrativeValue(T(1, { linked_entry_id: 9, entry_narrative: 'Filed.', entry_substantive_lines: 1 })), 'Filed.');
  assert.equal(narrativeValue(T(1)), '');
});

test('fmtDayTotal formats decimal hours', () => {
  assert.equal(fmtDayTotal(0), '0.0h today');
  assert.equal(fmtDayTotal(3960), '1.1h today');
  assert.equal(fmtDayTotal(-5), '0.0h today');
});

test('fmtClock matches the titlebar/ui format', () => {
  assert.equal(fmtClock(0), '00:00');
  assert.equal(fmtClock(75), '01:15');
  assert.equal(fmtClock(3600), '1:00:00');
  assert.equal(fmtClock(4271.9), '1:11:11');
});

test('pipSupported is false outside a browser', () => {
  assert.equal(pipSupported(), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/pip.test.js 2>&1 | tail -10`
Expected: FAIL — `buildPipRows` is not exported.

- [ ] **Step 3: Implement**

In `public/js/lib/pip.js`, delete `pickPipTimer` and add (between `pipSupported` and `fmtClock`):

```js
// Which timers earn a row: running, any clock time today (includes held time
// carried from earlier days), or pinned (timers.pinned — the whole point of
// pinning is surviving the midnight reset). Running first; otherwise the
// server's dashboard order is preserved — never time-sorted, rows must not
// jump while the user watches. Pure — unit-tested in test/pip.test.js.
export function buildPipRows(timers) {
  const list = (timers || []).filter((t) => t.running || t.elapsed_seconds > 0 || t.pinned);
  return [...list.filter((t) => t.running), ...list.filter((t) => !t.running)];
}

// How the expanded row's narrative surface behaves:
//   'stash'    — no linked entry: text goes to timers.draft_narrative and is
//                consumed by the next entry the timer creates (server Task 3)
//   'readonly' — split entry (2+ substantive lines, auto-generated
//                narrative): view only; edit-through stays in the main editor
//   'entry'    — edits the linked entry's narrative directly
export function narrativeMode(t) {
  if (!t.linked_entry_id) return 'stash';
  if (t.entry_substantive_lines >= 2 && !t.entry_narrative_manual) return 'readonly';
  return 'entry';
}

export function narrativeValue(t) {
  return (narrativeMode(t) === 'stash' ? t.draft_narrative : t.entry_narrative) || '';
}

export function fmtDayTotal(totalSeconds) {
  return `${(Math.max(0, totalSeconds) / 3600).toFixed(1)}h today`;
}
```

`toggleTimerPip` still references `pickPipTimer` in two places (its `render` and toggle-click handlers). Replace both calls with `buildPipRows(timers)[0] || null` as a temporary shim so this commit stands alone; Task 6 rewrites the function wholesale.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/pip.test.js 2>&1 | tail -5` → PASS. Then `grep -rn pickPipTimer public/ test/ server/` → no hits.

- [ ] **Step 5: Commit**

```bash
git add public/js/lib/pip.js test/pip.test.js
git commit -m "feat(pip): row-model helpers for the multi-timer float window"
```

---

### Task 6: Rewrite the PiP window — rows, narratives, pins, quick `+`

**Files:**
- Modify: `public/js/lib/pip.js` (replace `PIP_CSS` and `toggleTimerPip` entirely; header comment updated to describe the panel)

**Interfaces:**
- Consumes: Task 5 helpers; endpoints `GET /api/timers`, `POST /api/timers` (empty body → quick timer), `POST /api/timers/:id/start|stop`, `PATCH /api/timers/:id` (`pinned`, `draft_narrative`), `PATCH /api/entries/:id` (`narrative`).
- Produces: same public API as today — `toggleTimerPip()` (used by `app.js:305-307`, no app.js change needed) opens/closes the window and returns true/false.

No unit test — this is the thin DOM layer over the tested helpers (Document PiP cannot run under node:test or headless Chromium). Verification is the smoke run in Task 8 plus a manual checklist below.

- [ ] **Step 1: Replace the header comment, `PIP_CSS`, and `toggleTimerPip`**

Header comment (replace the first paragraph block, keep the api.js lazy-import note):

```js
// Always-on-top floating multi-timer panel (Document Picture-in-Picture).
//
// A PWA window can't set itself always-on-top, but Chrome 116+'s Document
// Picture-in-Picture API can open a small utility window the OS keeps above
// everything. It shares this page's JS context and origin, so the same
// api.js client and session cookie work inside it. Caveats:
//   - Chrome/Edge desktop only; needs a secure context and a user gesture.
//   - One PiP window per tab; closing the tab closes it. The dashboard
//     re-polls every 5s, so actions taken here show up there within a poll.
//   - Chromeless: stylesheets are NOT inherited — inline CSS only.
//
// The panel lists every timer that is running, has clock time today, or is
// pinned (spec docs/superpowers/specs/2026-07-13-aot-multi-timer-design.md).
// Clicking a row expands a narrative field that edits the linked entry's
// narrative — or stashes to timers.draft_narrative when no entry exists yet.
// Footer: ticking day total + a `+` quick-timer button.
```

New `PIP_CSS`:

```js
const PIP_CSS = `
  * { margin: 0; box-sizing: border-box; }
  body {
    font: 12px/1.35 system-ui, sans-serif;
    background: #14161b; color: #e8eaf0;
    height: 100vh; display: flex; flex-direction: column;
    border-left: 4px solid #3a3f4b; user-select: none;
  }
  body.running { border-left-color: #e11d48; }
  .rows { flex: 1; overflow-y: auto; }
  .row { border-bottom: 1px solid #23262e; }
  .rowbar { display: flex; align-items: center; gap: 7px; padding: 6px 8px; cursor: pointer; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: #3a3f4b; flex: none; }
  .row.running .dot { background: #e11d48; animation: pulse 1.6s ease-in-out infinite; }
  @keyframes pulse { 50% { opacity: 0.35; } }
  .clock { font-family: ui-monospace, monospace; font-weight: 700; font-size: 14px; flex: none; min-width: 54px; }
  .name { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: #aab0bf; }
  .row.running .name { color: #e8eaf0; }
  .pin { background: none; border: none; cursor: pointer; font-size: 12px; opacity: 0.18; padding: 2px; flex: none; }
  .pin:hover { opacity: 0.6; }
  .pin.on { opacity: 1; }
  .act {
    font: 600 11px system-ui, sans-serif; color: #e8eaf0;
    background: #262a33; border: 1px solid #3a3f4b; border-radius: 5px;
    padding: 3px 9px; cursor: pointer; flex: none;
  }
  .act:hover { background: #313644; }
  .row.running .act { background: #b3123a; border-color: #e11d48; }
  .detail { padding: 0 8px 8px 23px; }
  .cap { color: #8b93a5; font-size: 11px; margin-bottom: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  textarea {
    width: 100%; font: 12px/1.35 system-ui, sans-serif; color: #e8eaf0;
    background: #1b1e25; border: 1px solid #3a3f4b; border-radius: 5px;
    padding: 4px 6px; resize: none;
  }
  textarea:focus { outline: none; border-color: #5b6373; }
  .ro { color: #c6cbd6; }
  .hint { color: #8b93a5; font-size: 10px; margin-top: 2px; }
  .saved { color: #4ade80; font-size: 11px; opacity: 0; transition: opacity 0.2s; }
  .saved.show { opacity: 1; }
  .rowerr { color: #f0a5b8; font-size: 11px; margin-top: 3px; }
  .empty { flex: 1; display: flex; align-items: center; justify-content: center; color: #8b93a5; padding: 12px; text-align: center; }
  .err { color: #f0a5b8; font-size: 11px; padding: 4px 8px; }
  .foot { flex: none; display: flex; align-items: center; justify-content: space-between; padding: 5px 8px; border-top: 1px solid #2a2e37; }
  .total { color: #aab0bf; font-family: ui-monospace, monospace; font-size: 11px; }
  .quick {
    font: 700 14px/1 system-ui, sans-serif; color: #e8eaf0;
    background: #262a33; border: 1px solid #3a3f4b; border-radius: 5px;
    width: 24px; height: 22px; cursor: pointer;
  }
  .quick:hover { background: #313644; }
`;
```

New `toggleTimerPip` (complete replacement):

```js
let pipWin = null; // one floating window per tab (mirrors the API's own limit)

export async function toggleTimerPip() {
  if (pipWin && !pipWin.closed) { pipWin.close(); pipWin = null; return false; }

  // requestWindow first — it consumes the click's transient activation, and
  // an awaited import in front of it could outlive that window. Height comes
  // from the row count cached at the last render (PiP windows can't be
  // resized programmatically); the list scrolls if the guess is off.
  const cachedRows = Math.max(1, Number(localStorage.getItem('tk:pipRows')) || 3);
  pipWin = await window.documentPictureInPicture.requestWindow({
    width: 320,
    height: Math.min(64 + 34 * cachedRows, 320),
  });
  const { api } = await import('/js/api.js');
  const doc = pipWin.document;
  doc.head.appendChild(doc.createElement('style')).textContent = PIP_CSS;
  doc.body.innerHTML = `
    <div class="rows" data-rows></div>
    <div class="empty" data-empty hidden>No time today — pin a timer or hit +.</div>
    <div class="err" data-err hidden></div>
    <div class="foot">
      <span class="total" data-total>…</span>
      <button class="quick" data-quick title="Quick timer — starts now; assign a matter later">+</button>
    </div>`;

  const rowsEl = doc.querySelector('[data-rows]');
  const emptyEl = doc.querySelector('[data-empty]');
  const errEl = doc.querySelector('[data-err]');
  const totalEl = doc.querySelector('[data-total]');

  let timers = [];
  let fetchedAt = 0;
  let expandedId = null; // one expanded row at a time
  const drafts = new Map(); // timer id → unsaved narrative text
  const debounces = new Map(); // timer id → save debounce handle
  let pendingRender = false; // a render was skipped to protect a focused textarea

  const secsOf = (t) => t.elapsed_seconds + (t.running ? Math.max(0, (Date.now() - fetchedAt) / 1000) : 0);
  const narrFocused = () => doc.activeElement && doc.activeElement.tagName === 'TEXTAREA';

  const showErr = (e) => { errEl.textContent = e.message; errEl.hidden = false; };

  const poll = () => api.get('/api/timers')
    .then((t) => { timers = t; fetchedAt = Date.now(); errEl.hidden = true; render(); })
    .catch((e) => showErr(new Error(`Can’t reach server — ${e.message}`)));

  // Save the draft for timer id. Looks the timer up fresh: by save time a
  // poll may have created/relinked its entry, which changes WHERE the text
  // belongs (narrativeMode). Only clears the draft if the text didn't change
  // while the request was in flight.
  async function saveNarrative(id) {
    clearTimeout(debounces.get(id));
    if (!drafts.has(id)) return;
    const t = timers.find((x) => x.id === id);
    if (!t) return;
    const text = drafts.get(id);
    const rowErr = rowsEl.querySelector(`.row[data-id="${id}"] [data-rowerr]`);
    try {
      if (narrativeMode(t) === 'stash') {
        await api.patch(`/api/timers/${id}`, { draft_narrative: text });
      } else {
        await api.patch(`/api/entries/${t.linked_entry_id}`, { narrative: text });
      }
      if (drafts.get(id) === text) drafts.delete(id);
      if (rowErr) rowErr.textContent = '';
      const flash = rowsEl.querySelector(`.row[data-id="${id}"] [data-saved]`);
      if (flash) {
        flash.classList.add('show');
        pipWin.setTimeout(() => flash.classList.remove('show'), 1200);
      }
      poll();
    } catch (e) {
      if (rowErr) rowErr.textContent = e.message; else showErr(e);
    }
  }

  function focusNarrative(id) {
    const ta = rowsEl.querySelector(`.row[data-id="${id}"] textarea`);
    if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
  }

  function buildDetail(t) {
    const detail = doc.createElement('div');
    detail.className = 'detail';
    const cap = doc.createElement('div');
    cap.className = 'cap';
    cap.textContent = t.cm_id
      ? `${t.cm_short_name} · ${t.cm_number}`
      : (t.held_since
        ? `no matter yet — holding time since ${t.held_since}`
        : 'no matter yet — narrative is stashed until one is assigned');
    detail.appendChild(cap);

    if (narrativeMode(t) === 'readonly') {
      const ro = doc.createElement('div');
      ro.className = 'ro';
      ro.textContent = narrativeValue(t);
      const hint = doc.createElement('div');
      hint.className = 'hint';
      hint.textContent = 'split entry — edit in app';
      detail.append(ro, hint);
      return detail;
    }

    const ta = doc.createElement('textarea');
    ta.rows = 2;
    ta.value = drafts.has(t.id) ? drafts.get(t.id) : narrativeValue(t);
    ta.addEventListener('input', () => {
      drafts.set(t.id, ta.value);
      clearTimeout(debounces.get(t.id));
      debounces.set(t.id, pipWin.setTimeout(() => saveNarrative(t.id), 600));
    });
    ta.addEventListener('blur', () => {
      saveNarrative(t.id);
      if (pendingRender) { pendingRender = false; render(); }
    });
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        // collapse: blur triggers the save AND the deferred re-render
        expandedId = null;
        pendingRender = true;
        ta.blur();
      }
    });
    const saved = doc.createElement('span');
    saved.className = 'saved';
    saved.dataset.saved = '';
    saved.textContent = '✓ saved';
    const rowErr = doc.createElement('div');
    rowErr.className = 'rowerr';
    rowErr.dataset.rowerr = '';
    detail.append(ta, saved, rowErr);
    return detail;
  }

  function buildRow(t) {
    const row = doc.createElement('div');
    row.className = `row${t.running ? ' running' : ''}`;
    row.dataset.id = t.id;

    const bar = doc.createElement('div');
    bar.className = 'rowbar';
    bar.innerHTML = `
      <span class="dot"></span>
      <span class="clock" data-clock></span>
      <span class="name"></span>
      <button class="pin${t.pinned ? ' on' : ''}" data-pin></button>
      <button class="act" data-act></button>`;
    bar.querySelector('[data-clock]').textContent = fmtClock(secsOf(t));
    bar.querySelector('.name').textContent = t.name;
    const pinBtn = bar.querySelector('[data-pin]');
    pinBtn.textContent = '📌';
    pinBtn.title = t.pinned
      ? 'Unpin — drops off this window once its day is over'
      : 'Pin — keeps this timer here across days';
    const actBtn = bar.querySelector('[data-act]');
    actBtn.textContent = t.running ? 'Stop' : 'Start';
    actBtn.title = t.running ? 'Stop & file time' : 'Start';

    bar.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      expandedId = expandedId === t.id ? null : t.id;
      render();
      if (expandedId === t.id) focusNarrative(t.id);
    });
    pinBtn.addEventListener('click', async () => {
      try {
        await api.patch(`/api/timers/${t.id}`, { pinned: t.pinned ? 0 : 1 });
        await poll();
      } catch (e) { showErr(e); }
    });
    actBtn.addEventListener('click', async () => {
      actBtn.disabled = true;
      try {
        await api.post(`/api/timers/${t.id}/${t.running ? 'stop' : 'start'}`);
        localStorage.setItem('tk:lastTimer', String(t.id));
        await poll();
      } catch (e) { showErr(e); } finally { actBtn.disabled = false; }
    });

    row.appendChild(bar);
    if (t.id === expandedId) row.appendChild(buildDetail(t));
    return row;
  }

  function render() {
    // never rebuild under a focused textarea — the blur handler re-renders
    if (narrFocused()) { pendingRender = true; return; }
    const rows = buildPipRows(timers);
    localStorage.setItem('tk:pipRows', String(rows.length || 1));
    if (expandedId !== null && !rows.some((t) => t.id === expandedId)) expandedId = null;
    rowsEl.replaceChildren(...rows.map(buildRow));
    emptyEl.hidden = rows.length > 0;
    totalEl.textContent = fmtDayTotal(rows.reduce((s, t) => s + secsOf(t), 0));
    doc.body.classList.toggle('running', rows.some((t) => t.running));
  }

  // 1s tick: clocks + total only — no DOM rebuild, so typing is undisturbed
  const tick = () => {
    const rows = buildPipRows(timers);
    for (const t of rows) {
      const el = rowsEl.querySelector(`.row[data-id="${t.id}"] [data-clock]`);
      if (el) el.textContent = fmtClock(secsOf(t));
    }
    totalEl.textContent = fmtDayTotal(rows.reduce((s, t) => s + secsOf(t), 0));
  };

  doc.querySelector('[data-quick]').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      const t = await api.post('/api/timers', {});
      await api.post(`/api/timers/${t.id}/start`);
      localStorage.setItem('tk:lastTimer', String(t.id));
      expandedId = t.id;
      await poll();
      focusNarrative(t.id);
    } catch (err) { showErr(err); } finally { btn.disabled = false; }
  });

  await poll();
  const p = pipWin.setInterval(poll, 5000);
  const k = pipWin.setInterval(tick, 1000);
  pipWin.addEventListener('pagehide', () => {
    pipWin.clearInterval(p);
    pipWin.clearInterval(k);
    pipWin = null;
  });
  return true;
}
```

- [ ] **Step 2: Verify no test regressions and no dangling references**

Run: `npm test 2>&1 | tail -5` → all pass. Run: `grep -n pickPipTimer public/js/lib/pip.js` → no hits.

- [ ] **Step 3: Manual checklist (record results in the commit message body if any item can't be verified now)**

Serve locally (`npm start` or the running service after Task 8's restart) in desktop Chrome:
1. Toggle the float window: rows appear (running first), clocks tick, footer total ticks.
2. Click a row → expands, caption + narrative field; type → ✓ saved appears; text survives the next poll; check the entry on the dashboard shows the narrative.
3. Esc collapses and saves. Clicking another row switches expansion.
4. Pin a zero-time timer from its 📌 → survives in the list; unpin drops it.
5. `+` creates + starts a quick timer, expands focused; typed text lands in `draft_narrative` (visible after assigning a matter → entry narrative).
6. Split an entry into 2 lines in the app → its timer row shows read-only narrative + "split entry — edit in app".
7. Stop/start from rows; exclusivity stops the other running timer.

- [ ] **Step 4: Commit**

```bash
git add public/js/lib/pip.js
git commit -m "feat(pip): multi-timer AOT window — rows, narratives, pins, quick +"
```

---

### Task 7: Dashboard pin toggle + badge

**Files:**
- Modify: `public/js/icons.js` (add `pin` icon)
- Modify: `public/js/components/timergrid.js` (menu item in `menuItems` after 'Duplicate timer' ~line 361; badge in `TimerCard` after the `held-over` flag ~line 845)
- Modify: `public/css/app.css` (after `.held-over` rule, line 279)

**Interfaces:**
- Consumes: `timer.pinned` from Task 1; `PATCH /api/timers/:id { pinned }` from Task 2; existing `api`, `guard`, `reload`, `Icon`, `html` in timergrid.js.
- Produces: UI only — no new exports.

- [ ] **Step 1: Add the icon**

In `public/js/icons.js`, add alongside the other entries (lucide "pin", same inner-SVG string format as the existing `timer:` entry):

```js
  pin: "<path d=\"M12 17v5\" /><path d=\"M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1z\" />",
```

- [ ] **Step 2: Menu item**

In `menuItems(timer)` in `timergrid.js`, insert after the `{ label: 'Duplicate timer', … }` item:

```js
      {
        label: timer.pinned ? 'Unpin from float window' : 'Pin to float window',
        icon: 'pin',
        onClick: () => guard(api.patch(`/api/timers/${timer.id}`, {
          pinned: timer.pinned ? 0 : 1,
        }).then(reload)),
      },
```

- [ ] **Step 3: Card badge**

In `TimerCard`, after the `held-over` flag block (`${timer.held_since && !timer.cm_id ? html\`…\` : null}`), add:

```js
      ${timer.pinned ? html`
        <span class="timer-flag pinned"
          title="Pinned to the always-on-top float window — it stays there across days">
          <${Icon} name="pin" size=${12} /></span>` : null}
```

- [ ] **Step 4: CSS**

In `public/css/app.css`, after the `.held-over { color: var(--status-warning); }` rule:

```css
.timer-flag.pinned { color: var(--accent); }
```

- [ ] **Step 5: Verify + commit**

Run: `npm test 2>&1 | tail -5` → all pass (no component tests exist; this guards against syntax slips via any import-touching tests). Manual: dashboard card shows the pin badge when pinned; menu toggles it.

```bash
git add public/js/icons.js public/js/components/timergrid.js public/css/app.css
git commit -m "feat(timers): pin toggle + badge on dashboard cards"
```

---

### Task 8: Cache bump, full verification, deploy

**Files:**
- Modify: `public/sw.js:9` (`CACHE = 'timekeeper-v25'` → `'timekeeper-v26'`)

- [ ] **Step 1: Bump the service worker cache**

```js
const CACHE = 'timekeeper-v26';
```

- [ ] **Step 2: Full test suite**

Run: `npm test 2>&1 | tail -10`
Expected: all pass, 0 failures.

- [ ] **Step 3: E2E smoke**

Run: `node scripts/e2e-smoke.mjs`
Expected: exits 0 (headless Chromium can't open Document PiP, so this covers the app shell + dashboard, i.e. Task 7's changes and any regression from pip.js loading).

- [ ] **Step 4: Restart the service and spot-check**

```bash
systemctl --user restart timekeeper
sleep 1 && curl -sf http://127.0.0.1:4747/api/timers | head -c 300
```
Expected: JSON timer list including `pinned`, `draft_narrative`, `entry_narrative` fields.

- [ ] **Step 5: Run the Task 6 manual checklist against the live app** (desktop Chrome at `http://192.168.1.100:4747` or via the tunnel).

- [ ] **Step 6: Commit**

```bash
git add public/sw.js
git commit -m "chore: bump SW cache to v26 for the AOT multi-timer window"
```
