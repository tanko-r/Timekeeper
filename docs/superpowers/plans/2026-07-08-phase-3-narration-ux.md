# Phase 3 — Narration UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make narration confirm-and-tweak instead of compose-from-blank: ghost-text autocomplete from the matter's phrasebook (Tab accepts), non-blocking narrative chips on timer stop (replacing the StopPopup modal), a narrative pre-computed at timer *start*, user-defined text-expansion shortcuts built in-flow, streamed LLM narration with regenerate/shorter/longer — plus the remaining grid extensions: keyboard focus model, worked-today highlight, and type-to-filter.

**Architecture:** Everything deterministic consumes Phase 2's memory endpoints (`GET /api/matters/:id/suggestions`, already landed). Two tiny **pure browser modules** (`public/js/lib/ghost.js`, `public/js/lib/expand.js`) hold the completion/expansion engines — zero imports, so the same no-build ES modules are unit-tested under `node:test` and imported by the browser (the strongest form of "pure + tested"; the `server/lib` convention covers server logic, and these are keystroke-latency UI logic). Server side: a `shortcuts` table + thin CRUD router, a `timers.suggested_narrative` column filled at start (phrasebook synchronously; optional Ollama refinement fire-and-forget), and a streaming NDJSON `/api/ai/narrate` endpoint. Frontend: a reusable `GhostInput` component (entry editor now; Phase 4's close-out mounts the same component), a `StopChips` portal card, and `timergrid.js` gains roving-tabindex focus, worked-today styling, and in-place type-to-filter.

**Tech Stack:** Node 24 ESM, Express 5, better-sqlite3 (WAL), `node:test`. Frontend: no-build React 18 UMD + htm, plain ES modules in `public/js/`. E2E: `scripts/e2e-smoke.mjs` (headless system Chromium). AI: local Ollama only (`llama3.1:8b`, ~180 s on CPU — hence streaming); tests use a stub Ollama HTTP server, never a live model.

## Global Constraints

- Runtime deps stay exactly `express` + `better-sqlite3`. Do not add any dependency.
- **Migrations are appended positionally**: each new migration is the **NEXT (last) element** of `MIGRATIONS` in `server/db.js`, guarded by `PRAGMA user_version` vs. array length. Phase 2 appended the `matter_people` migration before this phase; **never hardcode a version number — find the current end of the array at execution time.** This phase appends TWO migrations, in task order: Task 1 (`shortcuts` table), then Task 2 (`timers.suggested_narrative`). Never mutate an existing migration.
- **Phase 2 must be fully landed before executing** (`server/lib/phrasebook.js`, `server/lib/people.js`, `server/routes/matters.js` mounted at `/api/matters`, `matter_people` migration). Verify with `git log`/`ls` first. All edit locations below are **content anchors, never line numbers** — the tree has drifted and will drift.
- Phase 2 interface contracts consumed here (treat as landed):
  - `GET /api/matters/:id/suggestions` → `{ matter_id, borrowed, phrases: [{ text, count, score, last_used, source: "matter"|"client" }] }`, `phrases` sorted by score desc, max 15. `404 { error: "Matter not found." }` for unknown ids.
  - `GET /api/matters/:id/people` → `{ matter_id, borrowed, people: [{ name, count, last_seen, source }] }` (not consumed by any Phase 3 UI; do not break it — Task 2 rewrites `matters.js` and must keep it byte-compatible).
- Server business logic goes in `server/lib/*` / route modules as **pure functions + thin routes with `node:test` tests**; all server writes via prepared statements. Browser-side pure logic goes in `public/js/lib/*` with zero imports and `node:test` tests (deliberate — see Architecture).
- **No bundler, ever.** Browser code is plain ES modules under `public/js/`; React 18 UMD + htm only.
- **`/api/cms` response field names are unchanged.** Export/CSV/`.TIM` shape must not change. Neither is touched by this plan — keep it that way.
- The compact single-line timer card (`.timer-card`) is the ratified baseline — extend, don't redesign.
- **Micro-animations are Phase 4** (spec §7). All keyboard/filter/highlight styling in this phase is functional, not animated. **NO close-out screen, NO animated today footer, NO bill-from-a-sentence** (all Phase 4).
- Ghost-text mounts in the **entry editor only** this phase; Phase 4's close-out consumes the same component; it does **NOT** go into any quick-capture surface (controller resolution of the spec's open question).
- Unit/e2e tests must **NOT depend on a live Ollama**: follow `test/api.ai.test.js`'s stub-server pattern; the e2e runs with AI disabled (its default), so no e2e step may require AI.
- Tests run with `npm test` (`node --test test/*.test.js`). The **entire suite must be green at the end of every task**; tasks that touch the frontend also end with `node scripts/e2e-smoke.mjs` → `E2E SMOKE: ALL CLEAR`.
- Dates are local `YYYY-MM-DD`; box TZ `America/Los_Angeles` (tests set `process.env.TZ`). Durations are decimal hours.

Binding language from the spec (§4, §6):

> **Ghost-text narrative autocomplete** (magic #2): as you type a fragment, a grey completion appears from the matter's phrasebook (prefix + rank); **Tab** accepts. **Deterministic — no LLM** — so it's Copilot-fast and private.

> **Tap-able narrative chips on stop** (magic #3 support): the stop step offers 2–3 ready narratives for *this* matter (frequency over history) — tap = filed. The per-stop modal (`StopPopup`) is replaced by this lightweight, non-blocking affordance. *(Controller resolution: keep instant chips for one-tap cases; everything else defers to Phase 4's close-out — a dismissed/ignored stop still files silently as a draft.)*

> **Suggested narrative on timer start**: starting a timer pre-computes a likely narrative (phrasebook first; optional async `llama3.1` pass) so it's ready before you stop.

> **Text-expansion shortcuts**: a user-defined abbreviation → phrase dictionary, expanded inline in fragment/narrative fields (`IA` → `Interconnect Agreement`, `tc/oc` → `telephone conference with opposing counsel`). Deterministic, distinct from the semantic phrasebook. **The dictionary is managed as a separate store — the Settings chip-UI approach is paused.** The design emphasis is *building the dictionary in-flow* … (e.g. select text → "save as shortcut"). *(Do not build a Settings management screen beyond a minimal list/delete.)*

> **Faster AI narration:** where the LLM *is* used (novel narratives), stream tokens to the UI and add regenerate + shorter/longer, replacing the single blocking spinner.

> **Type-to-filter** (§4): typing while the grid is focused live-filters cards by client/matter name, short name, and timer label — in place, no navigation (distinct from the `/` full-text search that leaves the page).

> **Worked-today highlight** (§4): a distinct, theme-aware treatment for timers with accumulated time today (elapsed > 0 or `linked_entry_id` set) vs. still-at-zero, separate from `.running` and from `.idle-nudge`.

> **Keyboard focus model** (§4): a real "focused timer" concept (roving `tabindex`) so start/stop, nudge (±0.1/±0.2), edit, and quick-note are reachable by key without the mouse.

The 1b grouping selector (`.seg`, `tk:timerGrouping`) is landed — **integrate with it, don't rework it.**

---

### Task 1: Shortcuts store — migration, `/api/shortcuts` CRUD, pure expansion engine

**Files:**
- Modify: `server/db.js` (append the NEXT migration — do NOT touch existing elements)
- Create: `server/routes/shortcuts.js`
- Modify: `server/app.js` (mount)
- Modify: `server/routes/backup.js` (include `shortcuts` in the JSON dump)
- Create: `public/js/lib/expand.js`
- Test: `test/api.shortcuts.test.js` (new), `test/expand.test.js` (new), `test/db.test.js` (append), `test/api.backup.test.js` (one assertion)

**Interfaces:**
- Consumes: `startTestServer` from `test/helpers.js`; `openDb` from `server/db.js`.
- Produces:
  - Table `shortcuts(id, abbrev TEXT COLLATE NOCASE UNIQUE, phrase, created_at)`.
  - `GET /api/shortcuts` → `[{ id, abbrev, phrase, created_at }]` ordered by abbrev (case-insensitive). `POST /api/shortcuts { abbrev, phrase }` → 201 row | 400 | 409 on duplicate. `DELETE /api/shortcuts/:id` → `{ ok: true }` | 404.
  - `expandShortcuts(text: string, caret: number, shortcuts: [{abbrev, phrase}]): { text, caret } | null` from `public/js/lib/expand.js` — Tasks 4 and Phase 4 rely on this exact signature.

- [ ] **Step 1: Write the failing migration test**

Append to `test/db.test.js`:

```js
test('phase-3 migration: shortcuts table with case-insensitive unique abbrev', () => {
  const db = openDb(':memory:');
  const cols = db.prepare('PRAGMA table_info(shortcuts)').all().map((c) => c.name);
  assert.deepEqual(cols, ['id', 'abbrev', 'phrase', 'created_at']);
  db.prepare("INSERT INTO shortcuts (abbrev, phrase) VALUES ('IA', 'Interconnect Agreement')").run();
  assert.throws(() => db.prepare("INSERT INTO shortcuts (abbrev, phrase) VALUES ('ia', 'dup')").run(), /UNIQUE/);
  db.close();
});
```

Run: `node --test test/db.test.js` — Expected: the new test FAILS (`no such table: shortcuts`); existing tests pass.

- [ ] **Step 2: Append the migration**

In `server/db.js`, append a new element at the **end** of the `MIGRATIONS` array — after the last existing element (at time of writing, Phase 2's `matter_people` migration; verify it is still last) and immediately before the closing `];`:

```js
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
```

Run: `node --test test/db.test.js` — Expected: PASS.

- [ ] **Step 3: Write the failing API tests**

Create `test/api.shortcuts.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

async function withServer(fn) {
  const t = await startTestServer();
  try { await fn(t); } finally { await t.close(); }
}

test('shortcuts: create, list (alpha, case-insensitive), delete', () => withServer(async (t) => {
  const a = await t.fetchJson('POST', '/api/shortcuts', { abbrev: 'IA', phrase: 'Interconnect Agreement' });
  assert.equal(a.status, 201);
  assert.equal(a.body.abbrev, 'IA');
  await t.fetchJson('POST', '/api/shortcuts', { abbrev: 'agmt', phrase: '  access   agreement ' });

  const list = (await t.fetchJson('GET', '/api/shortcuts')).body;
  assert.deepEqual(list.map((s) => s.abbrev), ['agmt', 'IA']);
  assert.equal(list.find((s) => s.abbrev === 'agmt').phrase, 'access agreement'); // whitespace collapsed

  assert.equal((await t.fetchJson('DELETE', `/api/shortcuts/${a.body.id}`)).status, 200);
  assert.equal((await t.fetchJson('GET', '/api/shortcuts')).body.length, 1);
  assert.equal((await t.fetchJson('DELETE', '/api/shortcuts/999')).status, 404);
}));

test('shortcuts: validation and case-insensitive uniqueness', () => withServer(async (t) => {
  assert.equal((await t.fetchJson('POST', '/api/shortcuts', { abbrev: 'has space', phrase: 'x' })).status, 400);
  assert.equal((await t.fetchJson('POST', '/api/shortcuts', { abbrev: '', phrase: 'x' })).status, 400);
  assert.equal((await t.fetchJson('POST', '/api/shortcuts', { abbrev: 'ok', phrase: '' })).status, 400);
  assert.equal((await t.fetchJson('POST', '/api/shortcuts', { abbrev: 'IA', phrase: 'one' })).status, 201);
  assert.equal((await t.fetchJson('POST', '/api/shortcuts', { abbrev: 'ia', phrase: 'two' })).status, 409);
}));
```

Run: `node --test test/api.shortcuts.test.js` — Expected: FAIL — `/api/shortcuts` returns 404 `not_found` (not mounted).

- [ ] **Step 4: Create the router and mount it**

Create `server/routes/shortcuts.js`:

```js
import { Router } from 'express';

// User-defined text-expansion shortcuts (spec §6): "IA" → "Interconnect
// Agreement". Deterministic and distinct from the derived phrasebook; the
// dictionary is built IN-FLOW (select text → save as shortcut), so this API
// is deliberately tiny: list, create, delete. Expansion itself happens in the
// browser (public/js/lib/expand.js).
const ABBREV_RE = /^\S{1,24}$/;

export function shortcutsRouter({ db, clock }) {
  const r = Router();
  const get = db.prepare('SELECT id, abbrev, phrase, created_at FROM shortcuts WHERE id=?');

  r.get('/', (req, res) => {
    res.json(db.prepare(
      'SELECT id, abbrev, phrase, created_at FROM shortcuts ORDER BY abbrev COLLATE NOCASE').all());
  });

  r.post('/', (req, res) => {
    const b = req.body || {};
    const abbrev = String(b.abbrev || '').trim();
    const phrase = String(b.phrase || '').replace(/\s+/g, ' ').trim();
    if (!ABBREV_RE.test(abbrev)) {
      return res.status(400).json({ error: 'Abbreviation must be 1–24 characters with no spaces.' });
    }
    if (!phrase || phrase.length > 200) {
      return res.status(400).json({ error: 'Phrase must be 1–200 characters.' });
    }
    try {
      const info = db.prepare('INSERT INTO shortcuts (abbrev, phrase, created_at) VALUES (?, ?, ?)')
        .run(abbrev, phrase, clock().toISOString());
      res.status(201).json(get.get(info.lastInsertRowid));
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) {
        return res.status(409).json({ error: `Shortcut "${abbrev}" already exists.` });
      }
      throw e;
    }
  });

  r.delete('/:id', (req, res) => {
    const info = db.prepare('DELETE FROM shortcuts WHERE id=?').run(req.params.id);
    if (info.changes === 0) return res.status(404).json({ error: 'Shortcut not found.' });
    res.json({ ok: true });
  });

  return r;
}
```

In `server/app.js`, add the import next to the other route imports (anchor: after the line `import { mattersRouter } from './routes/matters.js';` — landed by Phase 2):

```js
import { shortcutsRouter } from './routes/shortcuts.js';
```

and the mount (anchor: after the line `app.use('/api/matters', mattersRouter(deps));`):

```js
  app.use('/api/shortcuts', shortcutsRouter(deps));
```

Run: `node --test test/api.shortcuts.test.js` — Expected: PASS (2 tests).

- [ ] **Step 5: Back up the new table**

In `test/api.backup.test.js`, next to the existing `matter_people` assertion (anchor: the line asserting `json.body.matter_people`), add:

```js
    assert.ok(Array.isArray(json.body.shortcuts), 'dump must include shortcuts');
```

Run it — Expected: FAIL. Then in `server/routes/backup.js`, inside the dump object literal, immediately after the `matter_people:` line (anchor: `matter_people: db.prepare(`), add:

```js
      shortcuts: db.prepare('SELECT * FROM shortcuts ORDER BY id').all(),
```

Run: `node --test test/api.backup.test.js` — Expected: PASS.

- [ ] **Step 6: Write the failing expansion-engine tests**

Create `test/expand.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expandShortcuts } from '../public/js/lib/expand.js';

const DICT = [
  { abbrev: 'IA', phrase: 'Interconnect Agreement' },
  { abbrev: 'tc/oc', phrase: 'telephone conference with opposing counsel' },
  { abbrev: 'mtge', phrase: 'mortgage' },
];

test('expands after a space, preserving the delimiter and caret', () => {
  const out = expandShortcuts('revise IA ', 10, DICT);
  assert.deepEqual(out, { text: 'revise Interconnect Agreement ', caret: 30 });
});

test('expands on punctuation delimiters', () => {
  const out = expandShortcuts('draft mtge.', 11, DICT);
  assert.equal(out.text, 'draft mortgage.');
  assert.equal(out.caret, 15);
});

test('abbreviations may contain punctuation that is not a delimiter', () => {
  const out = expandShortcuts('tc/oc ', 6, DICT);
  assert.equal(out.text, 'telephone conference with opposing counsel ');
});

test('case-insensitive match; a leading capital propagates to the phrase', () => {
  assert.equal(expandShortcuts('Mtge ', 5, DICT).text, 'Mortgage ');
  assert.equal(expandShortcuts('MTGE ', 5, DICT).text, 'Mortgage ');
  assert.equal(expandShortcuts('ia ', 3, DICT).text, 'Interconnect Agreement ');
});

test('mid-text expansion keeps the tail and places the caret after the delimiter', () => {
  const out = expandShortcuts('per IA terms', 7, DICT); // caret right after "IA "
  assert.equal(out.text, 'per Interconnect Agreement terms');
  assert.equal(out.caret, 27);
});

test('no expansion mid-word, without a delimiter, or for unknown words', () => {
  assert.equal(expandShortcuts('via ', 4, DICT), null);      // "via" is one word, not "IA"
  assert.equal(expandShortcuts('revise IA', 9, DICT), null); // no delimiter typed yet
  assert.equal(expandShortcuts('foo ', 4, DICT), null);
  assert.equal(expandShortcuts('', 0, DICT), null);
  assert.equal(expandShortcuts('IA ', 3, []), null);
});
```

Run: `node --test test/expand.test.js` — Expected: FAIL — `Cannot find module '../public/js/lib/expand.js'`.

- [ ] **Step 7: Implement the engine**

Create `public/js/lib/expand.js`:

```js
// Deterministic text-expansion engine (spec §6): expands a just-typed
// abbreviation into its phrase when a delimiter is typed after it
// ("tc/oc " → "telephone conference with opposing counsel ").
// ZERO imports on purpose: the same ES module runs in the browser (no-build)
// and under node:test (test/expand.test.js).
//
// Rules:
// - Expansion triggers only when the character just typed (the one before
//   `caret`) is a delimiter: whitespace or . , ; : ) — mid-word never expands.
// - The candidate abbreviation is the run of non-delimiter characters
//   immediately before that delimiter ("tc/oc" survives; "IA." → "IA").
//   Consequence: abbreviations cannot contain delimiter characters.
// - Matching is case-insensitive. If the typed abbreviation starts uppercase
//   and the phrase starts lowercase, the phrase is capitalized (sentence
//   starts stay sentences).
// - Returns { text, caret } with the delimiter preserved and the caret placed
//   after it, or null when nothing expands.

const DELIMS = new Set([' ', '\n', '\t', '.', ',', ';', ':', ')']);

export function expandShortcuts(text, caret, shortcuts) {
  if (!text || caret < 2 || !Array.isArray(shortcuts) || shortcuts.length === 0) return null;
  const delim = text[caret - 1];
  if (!DELIMS.has(delim)) return null;
  let start = caret - 1;
  while (start > 0 && !DELIMS.has(text[start - 1])) start--;
  const typed = text.slice(start, caret - 1);
  if (!typed) return null;
  const hit = shortcuts.find((s) => String(s.abbrev).toLowerCase() === typed.toLowerCase());
  if (!hit || typed === hit.phrase) return null;
  let phrase = String(hit.phrase);
  if (/^[A-Z]/.test(typed) && /^[a-z]/.test(phrase)) {
    phrase = phrase[0].toUpperCase() + phrase.slice(1);
  }
  return {
    text: text.slice(0, start) + phrase + text.slice(caret - 1),
    caret: start + phrase.length + 1,
  };
}
```

Run: `node --test test/expand.test.js` — Expected: PASS (6 tests).

- [ ] **Step 8: Run the full suite, then commit**

Run: `npm test` — Expected: PASS.

```bash
git add server/db.js server/routes/shortcuts.js server/app.js server/routes/backup.js public/js/lib/expand.js test/api.shortcuts.test.js test/expand.test.js test/db.test.js test/api.backup.test.js
git commit -m "feat(api): text-expansion shortcuts store + deterministic expansion engine"
```

---

### Task 2: Suggested narrative on timer start (column + phrasebook hook + optional LLM refine)

**Files:**
- Modify: `server/db.js` (append the NEXT migration)
- Rewrite: `server/routes/matters.js` (extract `matterSuggestions` for reuse; endpoints byte-compatible)
- Modify: `server/routes/timers.js` (`TIMER_COLS`, start hook, PATCH clears stale suggestion)
- Modify: `server/routes/ai.js` (add `buildNarrateMessages` + `refineSuggestedNarrative`)
- Test: `test/db.test.js`, `test/api.timers.test.js`, `test/api.ai.test.js` (append)

**Interfaces:**
- Consumes: `rankPhrases` (Phase 2 `server/lib/phrasebook.js`), `todayLocal` (`server/lib/dates.js`), `getSetting`/`DEFAULT_AI_INSTRUCTIONS` (existing), the stub-Ollama helper in `test/api.ai.test.js`.
- Produces:
  - `timers.suggested_narrative TEXT` column; every `/api/timers` row (list, start, stop, clock, patch responses) carries it.
  - `matterSuggestions(db, matterId, today): { matter_id, borrowed, phrases } | null` exported from `server/routes/matters.js` (same precedent as `loadEntry`/`syncNarrative` in `entries.js`). Task 5's chips read `timer.suggested_narrative` from the stop payload.
  - `buildNarrateMessages({ instructions, brief, narrative, mode, context }): messages[]` and `refineSuggestedNarrative({ db, clock }, timerId): Promise<void>` exported from `server/routes/ai.js`. Task 6 reuses `buildNarrateMessages`.

**Storage decision (justify in code comments too):** the suggestion lives on the **timer row via an appended migration**, not in memory or localStorage — the server restarts (systemd) while timers keep running, stops can come from a different device than the start, and the async LLM pass needs a durable place to land its result. One nullable TEXT column is the cheapest thing that satisfies all three.

- [ ] **Step 1: Write the failing migration test**

Append to `test/db.test.js`:

```js
test('phase-3 migration: timers gain suggested_narrative', () => {
  const db = openDb(':memory:');
  const cols = db.prepare('PRAGMA table_info(timers)').all().map((c) => c.name);
  assert.ok(cols.includes('suggested_narrative'));
  db.close();
});
```

Run: `node --test test/db.test.js` — Expected: the new test FAILS.

- [ ] **Step 2: Append the migration**

In `server/db.js`, append at the **end** of `MIGRATIONS` (after Task 1's `shortcuts` migration, which must now be the last element — verify):

```js
  // Phase 3 (spec §6): a likely narrative pre-computed at timer START so it's
  // ready before stop — the phrasebook top hit lands synchronously, and an
  // optional background local-LLM pass refines it while the session runs.
  // Stored on the timer row (not in memory / localStorage): survives server
  // restarts, works when start and stop come from different devices, and
  // gives the async refinement a durable place to write.
  `
  ALTER TABLE timers ADD COLUMN suggested_narrative TEXT;
  `,
```

Run: `node --test test/db.test.js` — Expected: PASS.

- [ ] **Step 3: Write the failing timer tests**

Append to `test/api.timers.test.js` (uses that file's `withServer(startIso, fn)` — pre-creates CM `100001-000012` "Acme lease" — and `clock`):

```js
test('start pre-computes a suggested narrative from the phrasebook', () =>
  withServer('2026-07-06T09:00:00-07:00', async (t, cm, clock) => {
    await t.fetchJson('POST', '/api/entries', {
      date: '2026-07-05', cm_id: cm.id,
      tasks: [{ task_code: 'Revise', duration: 0.5, fragment: 'revise lease legal description' }],
    });
    const timer = (await t.fetchJson('POST', '/api/timers', { name: 'Acme', cm_id: cm.id })).body;
    assert.equal(timer.suggested_narrative, null, 'nothing suggested before first start');

    await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
    let list = (await t.fetchJson('GET', '/api/timers')).body;
    assert.equal(list[0].suggested_narrative, 'revise lease legal description');

    // the stop payload carries it too — the chips UI reads it from there
    clock.advance(600);
    const stop = (await t.fetchJson('POST', `/api/timers/${timer.id}/stop`)).body;
    assert.equal(stop.timer.suggested_narrative, 'revise lease legal description');

    // re-pointing the timer at a different matter clears the stale suggestion
    const other = (await t.fetchJson('POST', '/api/cms', { cm_number: '100001-000099', short_name: 'Sibling' })).body;
    const patched = (await t.fetchJson('PATCH', `/api/timers/${timer.id}`, { cm_id: other.id })).body;
    assert.equal(patched.suggested_narrative, null);
  }));

test('start on a cold matter leaves the suggestion empty (and no LLM call when disabled)', () =>
  withServer('2026-07-06T09:00:00-07:00', async (t, cm) => {
    const timer = (await t.fetchJson('POST', '/api/timers', { name: 'Cold', cm_id: cm.id })).body;
    await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
    const list = (await t.fetchJson('GET', '/api/timers')).body;
    assert.equal(list[0].suggested_narrative, null);
  }));
```

Run: `node --test test/api.timers.test.js` — Expected: the two new tests FAIL (`suggested_narrative` is `undefined`).

- [ ] **Step 4: Rewrite `server/routes/matters.js` (extract the reusable helper)**

First **read the current file** — it should match Phase 2's Task 5 output; if it drifted, port this same refactor onto what's there instead of pasting blindly. Replace the file with:

```js
import { Router } from 'express';
import { rankPhrases } from '../lib/phrasebook.js';
import { todayLocal } from '../lib/dates.js';

// Memory-layer read endpoints (spec §5). Everything here is derived from the
// user's own entries history — deterministic, instant, no LLM.
// "Thin" own history borrows from client siblings so new matters start warm:
const THIN_PHRASES = 5; // fewer own ranked phrases than this → blend siblings
const THIN_PEOPLE = 3;  // fewer own people than this → append sibling roster

// A phrase occurrence is any non-blank task fragment, plus the narrative of
// entries with fewer than 2 substantive task lines (mirrors narrative_auto in
// entries.js) — auto-generated multi-line narratives are joins of their own
// fragments and would double-count.
const FREE_NARRATIVE = `TRIM(e.narrative) != ''
      AND (SELECT COUNT(*) FROM entry_tasks t WHERE t.entry_id = e.id
            AND (TRIM(t.fragment) != '' OR TRIM(t.task_code) != '' OR t.duration > 0)) < 2`;

const OWN_PHRASES = `
    SELECT et.fragment AS text, e.date FROM entry_tasks et
    JOIN entries e ON e.id = et.entry_id
    WHERE e.cm_id = ? AND e.deleted_at IS NULL AND TRIM(et.fragment) != ''
    UNION ALL
    SELECT e.narrative AS text, e.date FROM entries e
    WHERE e.cm_id = ? AND e.deleted_at IS NULL AND ${FREE_NARRATIVE}`;

const SIBLING_PHRASES = `
    SELECT et.fragment AS text, e.date FROM entry_tasks et
    JOIN entries e ON e.id = et.entry_id
    JOIN matters m ON m.id = e.cm_id
    WHERE m.client_id = ? AND m.id != ? AND e.deleted_at IS NULL AND TRIM(et.fragment) != ''
    UNION ALL
    SELECT e.narrative AS text, e.date FROM entries e
    JOIN matters m ON m.id = e.cm_id
    WHERE m.client_id = ? AND m.id != ? AND e.deleted_at IS NULL AND ${FREE_NARRATIVE}`;

// Suggestions for one matter — exported for reuse (precedent: loadEntry /
// syncNarrative in entries.js): timers.js calls this at timer START to
// pre-compute a suggested narrative. Returns null for an unknown matter.
// Statements are prepared per call — trivially cheap at single-user scale.
export function matterSuggestions(db, matterId, today) {
  const matter = db.prepare('SELECT id, client_id FROM matters WHERE id=?').get(matterId);
  if (!matter) return null;
  const own = db.prepare(OWN_PHRASES).all(matter.id, matter.id)
    .map((o) => ({ ...o, source: 'matter' }));
  let occurrences = own;
  let borrowed = false;
  if (rankPhrases(own, { today }).length < THIN_PHRASES && matter.client_id != null) {
    const sib = db.prepare(SIBLING_PHRASES).all(matter.client_id, matter.id, matter.client_id, matter.id)
      .map((o) => ({ ...o, source: 'client' }));
    if (sib.length > 0) { borrowed = true; occurrences = own.concat(sib); }
  }
  return { matter_id: matter.id, borrowed, phrases: rankPhrases(occurrences, { today }) };
}

export function mattersRouter({ db, clock }) {
  const r = Router();
  const getMatter = db.prepare('SELECT id, client_id FROM matters WHERE id=?');

  r.get('/:id/suggestions', (req, res) => {
    const out = matterSuggestions(db, req.params.id, todayLocal(clock()));
    if (!out) return res.status(404).json({ error: 'Matter not found.' });
    res.json(out);
  });

  const ownPeople = db.prepare(`
    SELECT name, count, last_seen_at AS last_seen FROM matter_people
    WHERE matter_id = ? ORDER BY last_seen_at DESC, count DESC, name
  `);

  const siblingPeople = db.prepare(`
    SELECT MIN(mp.name) AS name, SUM(mp.count) AS count, MAX(mp.last_seen_at) AS last_seen
    FROM matter_people mp JOIN matters m ON m.id = mp.matter_id
    WHERE m.client_id = ? AND m.id != ?
    GROUP BY LOWER(mp.name)
    ORDER BY last_seen DESC, count DESC, name
  `);

  r.get('/:id/people', (req, res) => {
    const matter = getMatter.get(req.params.id);
    if (!matter) return res.status(404).json({ error: 'Matter not found.' });
    const own = ownPeople.all(matter.id).map((p) => ({ ...p, source: 'matter' }));
    let people = own;
    let borrowed = false;
    if (own.length < THIN_PEOPLE && matter.client_id != null) {
      const have = new Set(own.map((p) => p.name.toLowerCase()));
      const sib = siblingPeople.all(matter.client_id, matter.id)
        .filter((p) => !have.has(p.name.toLowerCase()))
        .map((p) => ({ ...p, source: 'client' }));
      if (sib.length > 0) { borrowed = true; people = own.concat(sib); }
    }
    res.json({ matter_id: matter.id, borrowed, people });
  });

  return r;
}
```

Run: `node --test test/api.matters.test.js` — Expected: PASS (Phase 2's 5 tests — the refactor is behavior-preserving).

- [ ] **Step 5: Add the prompt builder + background refinement to `server/routes/ai.js`**

Add imports at the top (anchor: after `import { allocateTenths } from '../lib/allocate.js';`):

```js
import { matterSuggestions } from './matters.js';
import { todayLocal } from '../lib/dates.js';
```

Add below the existing `systemPrompt` function:

```js
// Plain-text narrative prompt (NO JSON contract — unlike /ai/expand) shared
// by the background suggested-narrative refinement and the streaming
// /api/ai/narrate endpoint (Task 6 / spec §6 "faster AI narration").
export function buildNarrateMessages({ instructions, brief, narrative, mode = 'draft', context }) {
  const base = String(instructions || '').trim() || DEFAULT_AI_INSTRUCTIONS;
  const system = `${base}\n\nRespond with ONLY the billing narrative itself — plain text. No JSON, no quotes, no preamble, no explanations.`;
  let user;
  if (mode === 'shorter') {
    user = `Rewrite this billing narrative to be tighter and shorter while keeping every distinct piece of work:\n\n${narrative}`;
  } else if (mode === 'longer') {
    user = `Rewrite this billing narrative with slightly more specific detail. Do not invent facts, names, or documents.  Include each distinct work component in the attorney's narrative.  If relevant, include context from previous entries, but be conservative.  The narrative to rewrite is:\n\n${narrative}`;
  } else {
    user = [context, `The attorney's manually entered narrative for the day is: ${brief}`].filter(Boolean).join('\n\n');
  }
  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

// Background refinement of a timer's pre-computed narrative (spec §6,
// "suggested narrative on timer start": phrasebook first, "optional async
// llama3.1 pass"). FIRE-AND-FORGET: callers must never block a request on
// this — timers.js calls it as `refineSuggestedNarrative(deps, id).catch(...)`.
// No-op when AI is disabled (the default, so tests without a stub are
// unaffected). The UPDATE is guarded by running=1 so a refinement finishing
// after the stop (llama3.1:8b can take minutes) can't clobber anything.
export async function refineSuggestedNarrative({ db, clock }, timerId) {
  const cfg = getSetting(db, 'ai') || {};
  if (!cfg.enabled) return;
  const timer = db.prepare(
    'SELECT t.id, t.name, t.cm_id, m.short_name FROM timers t JOIN matters m ON m.id = t.cm_id WHERE t.id=?'
  ).get(timerId);
  if (!timer) return;
  const sugg = matterSuggestions(db, timer.cm_id, todayLocal(clock ? clock() : new Date()));
  const recent = (sugg ? sugg.phrases : []).slice(0, 5).map((p) => `- ${p.text}`).join('\n');
  const messages = buildNarrateMessages({
    instructions: cfg.systemPrompt,
    brief: `Matter: ${timer.short_name || timer.name}. Timer label: ${timer.name}. Draft the single most likely billing narrative for today's work session on this matter.`,
    context: recent ? `The attorney's recent recurring work on this matter:\n${recent}` : null,
  });
  const resp = await fetch(`${cfg.url}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: cfg.model, stream: false, options: { temperature: 0.3 }, messages }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!resp.ok) return;
  const data = await resp.json();
  const text = String((data.message && data.message.content) || '')
    .trim().replace(/^["']|["']$/g, '').slice(0, 300);
  if (!text || text.includes('{')) return; // refuse JSON-ish garbage
  db.prepare('UPDATE timers SET suggested_narrative=? WHERE id=? AND running=1').run(text, timerId);
}
```

- [ ] **Step 6: Hook the start path in `server/routes/timers.js`**

1. Extend `TIMER_COLS` (anchor: the ``const TIMER_COLS = `id, name, ...` `` template) to end with `group_id, linked_entry_id, last_stopped_at, suggested_narrative`.

2. Add imports (anchor: after `import { splitCmNumber } from '../lib/cmNumber.js';`):

```js
import { matterSuggestions } from './matters.js';
import { refineSuggestedNarrative } from './ai.js';
```

3. In `r.post('/:id/start', ...)`, inside the `else` branch (the not-already-running path), immediately after the line `db.prepare('UPDATE timers SET running=1, last_started_at=? WHERE id=?')` / `.run(new Date(startMs).toISOString(), timer.id);`, add:

```js
      // Pre-compute the likely narrative NOW so it's ready before stop (spec
      // §6): deterministic phrasebook top hit synchronously; the optional
      // local-LLM pass refines it in the background and never blocks.
      const sugg = matterSuggestions(db, timer.cm_id, todayLocal(clock()));
      db.prepare('UPDATE timers SET suggested_narrative=? WHERE id=?')
        .run(sugg && sugg.phrases[0] ? sugg.phrases[0].text : null, timer.id);
      refineSuggestedNarrative({ db, clock }, timer.id).catch(() => {});
```

4. In `r.patch('/:id', ...)`, replace the UPDATE statement (anchor: `'UPDATE timers SET name=?, cm_id=?, task_code=?, group_id=?, linked_entry_id=? WHERE id=?'` and its `.run(...)`) with:

```js
    db.prepare('UPDATE timers SET name=?, cm_id=?, task_code=?, group_id=?, linked_entry_id=?, suggested_narrative=? WHERE id=?').run(
      name,
      b.cm_id !== undefined ? b.cm_id : timer.cm_id,
      b.task_code !== undefined ? (b.task_code ? String(b.task_code) : null) : timer.task_code,
      b.group_id !== undefined ? b.group_id : timer.group_id,
      cmChanged ? null : timer.linked_entry_id, // new CM → old entry no longer its home
      cmChanged ? null : timer.suggested_narrative, // suggestion belonged to the old matter
      timer.id);
```

Run: `node --test test/api.timers.test.js` — Expected: PASS.

- [ ] **Step 7: Write + pass the LLM-refinement test (stub Ollama, async poll)**

Append to `test/api.ai.test.js`:

```js
test('timer start refines the suggested narrative via the local model (async, non-blocking)', async () => {
  const stub = await startStubOllama('Reviewed and revised lease legal description; correspondence with counsel.');
  const t = await startTestServer();
  try {
    setSetting(t.db, 'ai', { enabled: true, model: 'llama3.1:8b', url: stub.url });
    const cm = (await t.fetchJson('POST', '/api/cms', { cm_number: '100001-000012', short_name: 'Cedar Lease' })).body;
    const timer = (await t.fetchJson('POST', '/api/timers', { name: 'MTR12', cm_id: cm.id })).body;
    await t.fetchJson('POST', `/api/timers/${timer.id}/start`); // returns before the LLM does
    let val = null;
    for (let i = 0; i < 40 && !val; i++) { // fire-and-forget → poll briefly
      await new Promise((r) => setTimeout(r, 50));
      val = t.db.prepare('SELECT suggested_narrative FROM timers WHERE id=?').get(timer.id).suggested_narrative;
    }
    assert.equal(val, 'Reviewed and revised lease legal description; correspondence with counsel.');
  } finally { await t.close(); await stub.close(); }
});
```

Run: `node --test test/api.ai.test.js` — Expected: PASS (6 tests).

- [ ] **Step 8: Run the full suite, then commit**

Run: `npm test` — Expected: PASS (timer/jobs suites exercise the new column; AI stays disabled by default everywhere else).

```bash
git add server/db.js server/routes/matters.js server/routes/timers.js server/routes/ai.js test/db.test.js test/api.timers.test.js test/api.ai.test.js
git commit -m "feat(timers): pre-computed suggested narrative on start (phrasebook + optional LLM refine)"
```

---

### Task 3: Ghost-text autocomplete — pure engine, `GhostInput`, entry-editor mount

**Files:**
- Create: `public/js/lib/ghost.js`
- Create: `public/js/components/ghosttext.js`
- Modify: `public/js/components/entryeditor.js` (imports, hook, narrative + fragment fields)
- Modify: `public/css/app.css` (new ghost block)
- Modify: `scripts/e2e-smoke.mjs` (one new step)
- Test: `test/ghost.test.js` (new)

**Interfaces:**
- Consumes: `GET /api/matters/:id/suggestions` (Phase 2); `api` from `public/js/api.js`; `html`/hooks from `public/js/ui.js`.
- Produces (Phase 4's close-out mounts these unchanged):
  - `ghostCompletion(value, caret, phrases, { minChars = 2 }): string | null` from `public/js/lib/ghost.js`.
  - `useMatterSuggestions(cmId): string[]` and `GhostInput({ value, onChange(text), suggestions, expand, multiline, rows, onSelectionChange, ...rest })` from `public/js/components/ghosttext.js`. `expand` is the Task 4 plug-in point: `fn(text, caret) → { text, caret } | null`. Tab accepts the ghost; a grey inline completion renders via a mirror overlay.
  - CSS classes `.ghost-wrap`, `.ghost-mirror`, `.ghost-typed`, `.ghost-hint`.

- [ ] **Step 1: Write the failing engine tests**

Create `test/ghost.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ghostCompletion } from '../public/js/lib/ghost.js';

const PHRASES = [
  'revise lease legal description',
  'telephone conference with A. Turner',
  'Review title commitment and survey',
];

test('completes a prefix from the ranked list; first (highest-ranked) hit wins', () => {
  assert.equal(ghostCompletion('rev', 3, PHRASES), 'ise lease legal description');
});

test('case-insensitive; remainder keeps the phrase casing after the typed part', () => {
  assert.equal(ghostCompletion('Rev', 3, PHRASES), 'ise lease legal description');
  assert.equal(ghostCompletion('review t', 8, PHRASES), 'itle commitment and survey');
});

test('completes the clause after the last sentence break', () => {
  const typed = 'Reviewed survey; tele';
  assert.equal(ghostCompletion(typed, typed.length, PHRASES), 'phone conference with A. Turner');
});

test('no ghost when the caret is not at the end, input too short, or no match', () => {
  assert.equal(ghostCompletion('rev', 2, PHRASES), null);
  assert.equal(ghostCompletion('r', 1, PHRASES), null);
  assert.equal(ghostCompletion('zzz', 3, PHRASES), null);
  assert.equal(ghostCompletion('', 0, PHRASES), null);
});

test('a fully typed phrase produces no ghost', () => {
  const full = 'revise lease legal description';
  assert.equal(ghostCompletion(full, full.length, PHRASES), null);
});
```

Run: `node --test test/ghost.test.js` — Expected: FAIL — `Cannot find module '../public/js/lib/ghost.js'`.

- [ ] **Step 2: Implement the engine**

Create `public/js/lib/ghost.js`:

```js
// Ghost-text completion engine (spec §6): deterministic, from the matter's
// phrasebook — NEVER an LLM. Pure and dependency-free so the same ES module
// runs in the browser (no-build) and under node:test (test/ghost.test.js).
//
// The "segment" being completed is the text after the last sentence break
// (. ; :) — narratives are chains of clauses, and each clause completes
// independently. Matching is a case-insensitive prefix test against the
// ranked phrase list; the first (highest-ranked) hit wins. Returns the
// remainder to append (phrase casing), or null.

const SEGMENT_BREAK = /[.;:]/;

export function ghostCompletion(value, caret, phrases, { minChars = 2 } = {}) {
  const text = String(value ?? '');
  if (caret !== text.length || text.length === 0) return null; // only complete at the end
  let cut = -1;
  for (let i = text.length - 1; i >= 0; i--) {
    if (SEGMENT_BREAK.test(text[i])) { cut = i; break; }
  }
  const seg = text.slice(cut + 1).replace(/^\s+/, '');
  if (seg.length < minChars) return null;
  const low = seg.toLowerCase();
  for (const p of phrases || []) {
    const phrase = String(p);
    const pl = phrase.toLowerCase();
    if (pl.length > low.length && pl.startsWith(low)) return phrase.slice(seg.length);
  }
  return null;
}
```

Run: `node --test test/ghost.test.js` — Expected: PASS (5 tests).

- [ ] **Step 3: Create the `GhostInput` component + suggestions hook**

Create `public/js/components/ghosttext.js`:

```js
import { api } from '/js/api.js';
import { html, useState, useEffect, useRef, useCallback } from '/js/ui.js';
import { ghostCompletion } from '/js/lib/ghost.js';

// Ghost-text narrative autocomplete (spec §6): a grey inline completion from
// the matter's phrasebook; Tab accepts. Deterministic — no LLM. Reusable:
// the entry editor mounts it now; Phase 4's close-out mounts the same
// component. NOT used in quick-capture (decided).

// --- phrasebook fetch, cached per matter (60s TTL, module-level) ---
const cache = new Map(); // cmId -> { at, phrases }
const TTL = 60_000;

export function useMatterSuggestions(cmId) {
  const [phrases, setPhrases] = useState([]);
  useEffect(() => {
    if (!cmId) { setPhrases([]); return undefined; }
    const hit = cache.get(cmId);
    if (hit && Date.now() - hit.at < TTL) { setPhrases(hit.phrases); return undefined; }
    let alive = true;
    api.get(`/api/matters/${cmId}/suggestions`)
      .then((r) => {
        const texts = r.phrases.map((p) => p.text);
        cache.set(cmId, { at: Date.now(), phrases: texts });
        if (alive) setPhrases(texts);
      })
      .catch(() => { if (alive) setPhrases([]); });
    return () => { alive = false; };
  }, [cmId]);
  return phrases;
}

// GhostInput: a drop-in <input>/<textarea> with inline ghost completion.
//   value / onChange(text)  — controlled; onChange gets TEXT, not an event
//   suggestions             — ranked phrase strings (useMatterSuggestions)
//   expand                  — optional fn(text, caret) → {text, caret}|null,
//                             applied on every input (the Task 4 shortcut
//                             engine plugs in here)
//   multiline               — textarea instead of input
//   onSelectionChange(el)   — fires on select/caret events (Task 4 uses it
//                             for the save-as-shortcut affordance)
// Rendering: a mirror <div> overlays the field (pointer-events: none); the
// typed part is transparent so the real field text shows through, and the
// ghost remainder renders grey after it. Escape is NOT used to dismiss (the
// editor modal owns Escape via a capture listener); typing past the ghost or
// moving the caret recomputes/hides it.
export function GhostInput({
  value, onChange, suggestions = [], expand = null,
  multiline = false, rows = 3, onSelectionChange, ...rest
}) {
  const fieldRef = useRef(null);
  const mirrorRef = useRef(null);
  const [ghost, setGhost] = useState(null);
  const pendingCaret = useRef(null);

  const recompute = useCallback((text, caret) => {
    setGhost(ghostCompletion(text, caret, suggestions));
  }, [suggestions]);

  // after programmatic edits (expansion / Tab accept): restore the caret;
  // always: keep the mirror scrolled with the field
  useEffect(() => {
    if (pendingCaret.current != null && fieldRef.current) {
      fieldRef.current.setSelectionRange(pendingCaret.current, pendingCaret.current);
      pendingCaret.current = null;
    }
    const el = fieldRef.current;
    const mir = mirrorRef.current;
    if (el && mir) { mir.scrollTop = el.scrollTop; mir.scrollLeft = el.scrollLeft; }
  });

  function handleInput(e) {
    let text = e.target.value;
    let caret = e.target.selectionStart;
    const expanded = expand ? expand(text, caret) : null;
    if (expanded) {
      text = expanded.text;
      caret = expanded.caret;
      pendingCaret.current = caret;
    }
    recompute(text, caret);
    onChange(text);
  }

  function handleKeyDown(e) {
    if (e.key === 'Tab' && ghost && !e.shiftKey) {
      e.preventDefault();
      const next = value + ghost;
      pendingCaret.current = next.length;
      setGhost(null);
      onChange(next);
    }
  }

  const shared = {
    ref: fieldRef,
    value,
    onInput: handleInput,
    onKeyDown: handleKeyDown,
    onSelect: (e) => {
      recompute(e.target.value, e.target.selectionStart);
      if (onSelectionChange) onSelectionChange(e.target);
    },
    onBlur: () => setGhost(null),
    ...rest,
  };

  return html`
    <div class=${'ghost-wrap' + (multiline ? ' multiline' : '')}>
      ${ghost ? html`
        <div class="ghost-mirror" ref=${mirrorRef} aria-hidden="true">
          <span class="ghost-typed">${value}</span><span class="ghost-hint">${ghost}</span>
        </div>` : null}
      ${multiline
        ? html`<textarea rows=${rows} ...${shared}></textarea>`
        : html`<input type="text" ...${shared} />`}
    </div>`;
}
```

- [ ] **Step 4: Add the ghost CSS**

In `public/css/app.css`, insert a new block immediately **before** the `/* ---------- CSV timer import ---------- */` block:

```css
/* ---------- ghost-text autocomplete ---------- */
.ghost-wrap { position: relative; min-width: 0; }
.ghost-mirror {
  position: absolute; inset: 0; z-index: 2; pointer-events: none; overflow: hidden;
  /* mirrors the shared field metrics (buttons/inputs block): 7px 10px padding + 1px border */
  padding: 8px 11px; font: inherit; white-space: pre; border-radius: 6px;
}
.ghost-wrap.multiline .ghost-mirror { white-space: pre-wrap; overflow-wrap: break-word; }
.ghost-typed { color: transparent; }
.ghost-hint { color: var(--text-muted); opacity: .75; }
```

- [ ] **Step 5: Mount it in the entry editor**

In `public/js/components/entryeditor.js`:

1. Add the import (anchor: after `import { CmPicker } from '/js/components/cmpicker.js';`):

```js
import { GhostInput, useMatterSuggestions } from '/js/components/ghosttext.js';
```

2. Add the hook (anchor: directly after the line `const increment = settings?.rounding?.increment || 0.1;`):

```js
  // Ghost-text autocomplete (spec §6): deterministic phrasebook completions
  // for the picked matter; Tab accepts. No LLM anywhere in this path.
  const phrases = useMatterSuggestions(local?.cm?.id);
```

3. Replace the free-narrative textarea (anchor: the `html` branch inside `.narrative-preview` beginning `<textarea value=${local.narrative} disabled=${finalized}`):

```js
          <${GhostInput} multiline rows=${3} value=${local.narrative} disabled=${finalized}
            suggestions=${phrases}
            placeholder="What did you do? (specific verbs — banned vague phrases are flagged)"
            onChange=${(v) => update({ narrative: v })} />`}
```

(The `isAuto` branch — `AUTO` badge + readOnly textarea — stays exactly as-is.)

4. Replace the fragment input in the task-line map (anchor: `<input type="text" value=${t.fragment} placeholder=${isAuto ? ...`):

```js
            <${GhostInput} value=${t.fragment} suggestions=${phrases} disabled=${finalized}
              placeholder=${isAuto ? 'narrative fragment for this task' : 'optional fragment (used if you add more lines)'}
              onChange=${(v) => updateLine(i, { fragment: v })} />
```

- [ ] **Step 6: Add the failing e2e step**

In `scripts/e2e-smoke.mjs`, insert this step immediately **after** the `await step('timer clock is editable in place', …)` block:

```js
await step('ghost-text: phrasebook completion in the entry editor, Tab accepts', async () => {
  await page.keyboard.press('n');
  await waitFor('.modal .cmpicker input');
  await page.click('.modal .cmpicker input');
  await clickText('.cmpicker-item .name', 'Acme');
  await waitFor('.modal-wide .narrative-preview textarea');
  await page.click('.modal-wide .narrative-preview textarea');
  await page.type('.modal-wide .narrative-preview textarea', 'Rev', { delay: 30 });
  await page.waitForFunction(() => {
    const hint = document.querySelector('.modal-wide .ghost-hint');
    return hint && hint.textContent.startsWith('iewed lease agreement');
  }, { timeout: 4000 });
  await page.keyboard.press('Tab');
  const val = await page.$eval('.modal-wide .narrative-preview textarea', (el) => el.value);
  if (val !== 'Reviewed lease agreement and drafted renewal-terms summary for client') {
    throw new Error(`Tab did not accept the ghost: "${val}"`);
  }
  await shot('ghost-text');
  // the editor autosaved an entry while we typed — delete it to leave the day clean
  await page.waitForFunction(() => document.querySelector('.saving-dot')?.textContent.includes('Saved'), { timeout: 6000 });
  await clickText('.modal-wide button', 'Delete');
  await page.waitForFunction(() => !document.querySelector('.modal-wide'), { timeout: 5000 });
});
```

(The phrasebook source is the finalized entry from the earlier `entry: total + task line…` step — a single-line free narrative, so it ranks as a phrase; `normalizePhrase` strips its trailing period.)

Run: `node scripts/e2e-smoke.mjs` — Expected: the new step FAILS before implementation is wired… (if Steps 3–5 are already done, it PASSES — the e2e is the test here, so if you prefer strict red-first, add this step before Step 3 and watch it fail on `.ghost-hint`).

- [ ] **Step 7: Run everything**

Run: `npm test` — Expected: PASS.
Run: `node scripts/e2e-smoke.mjs` — Expected: all steps ✔ including the new ghost step and the untouched pre-existing editor/stop steps; `E2E SMOKE: ALL CLEAR`.

- [ ] **Step 8: Commit**

```bash
git add public/js/lib/ghost.js public/js/components/ghosttext.js public/js/components/entryeditor.js public/css/app.css scripts/e2e-smoke.mjs test/ghost.test.js
git commit -m "feat(ui): ghost-text narrative autocomplete (GhostInput + phrasebook hook)"
```

---

### Task 4: Shortcuts in-flow — expansion wired in, save-from-selection, minimal Settings list

**Files:**
- Create: `public/js/components/shortcuts.js`
- Modify: `public/js/components/entryeditor.js` (wire `expand` + selection into both GhostInputs; render the save bar)
- Modify: `public/js/views/settings.js` (minimal `ShortcutsCard` — list/delete only)
- Modify: `public/css/app.css` (one rule)
- Modify: `scripts/e2e-smoke.mjs` (one new step)

**Interfaces:**
- Consumes: `/api/shortcuts` CRUD (Task 1), `expandShortcuts` (Task 1), `GhostInput`'s `expand`/`onSelectionChange` props (Task 3).
- Produces: `useShortcuts(): [{id, abbrev, phrase}]` and `refreshShortcuts(): Promise` and `SaveShortcutBar({ selection })` from `public/js/components/shortcuts.js` (Phase 4's close-out reuses all three). E2E hook: `[data-shortcut-save]`.

- [ ] **Step 1: Add the failing e2e step**

In `scripts/e2e-smoke.mjs`, insert immediately after the Task 3 ghost step:

```js
await step('shortcuts: save-from-selection, inline expansion, settings list', async () => {
  await page.keyboard.press('n');
  await waitFor('.modal .cmpicker input');
  await page.click('.modal .cmpicker input');
  await clickText('.cmpicker-item .name', 'Acme');
  await waitFor('.modal-wide .narrative-preview textarea');
  await page.type('.modal-wide .narrative-preview textarea', 'Interconnect Agreement');
  await page.evaluate(() => {
    const ta = document.querySelector('.modal-wide .narrative-preview textarea');
    ta.focus();
    ta.setSelectionRange(0, ta.value.length);
    ta.dispatchEvent(new Event('select', { bubbles: true }));
  });
  await waitFor('[data-shortcut-save]');
  await clickText('[data-shortcut-save] button', 'shortcut');
  await type('[data-shortcut-save] input', 'IA');
  await clickText('[data-shortcut-save] button', 'Save');
  await page.waitForFunction(() => document.body.textContent.includes('Shortcut saved'), { timeout: 4000 });
  // expansion: clear the field, then type the abbreviation + space
  await page.evaluate(() => {
    const ta = document.querySelector('.modal-wide .narrative-preview textarea');
    const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    set.call(ta, '');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.type('.modal-wide .narrative-preview textarea', 'review IA ', { delay: 20 });
  const val = await page.$eval('.modal-wide .narrative-preview textarea', (el) => el.value);
  if (val !== 'review Interconnect Agreement ') throw new Error(`expansion failed: "${val}"`);
  await clickText('.modal-wide button', 'Delete');
  await page.waitForFunction(() => !document.querySelector('.modal-wide'), { timeout: 5000 });
  // settings shows the minimal list (no management screen beyond list/delete)
  await page.goto(`${base}/#/settings`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => document.body.textContent.includes('Text-expansion shortcuts')
    && document.body.textContent.includes('Interconnect Agreement'), { timeout: 4000 });
  await page.goto(`${base}/#/`, { waitUntil: 'networkidle0' });
});
```

Run: `node scripts/e2e-smoke.mjs` — Expected: the new step FAILS (`[data-shortcut-save]` never appears); prior steps stay ✔.

- [ ] **Step 2: Create the shortcut kit**

Create `public/js/components/shortcuts.js`:

```js
import { api } from '/js/api.js';
import { html, useState, useEffect, emitToast } from '/js/ui.js';

// Text-expansion shortcut kit (spec §6). The dictionary is built IN-FLOW:
// select text in a narrative/fragment field → "save as shortcut". The
// Settings chip-management screen is deliberately paused — Settings only
// lists and deletes (ShortcutsCard in views/settings.js).

let cached = null; // module-level dictionary shared by every consumer

export async function refreshShortcuts() {
  cached = await api.get('/api/shortcuts');
  window.dispatchEvent(new CustomEvent('tk:shortcuts-changed'));
}

export function useShortcuts() {
  const [list, setList] = useState(cached || []);
  useEffect(() => {
    const sync = () => setList(cached || []);
    window.addEventListener('tk:shortcuts-changed', sync);
    if (cached == null) refreshShortcuts().catch(() => {});
    else sync();
    return () => window.removeEventListener('tk:shortcuts-changed', sync);
  }, []);
  return list;
}

// In-flow capture: appears when ≥3 chars are selected in a GhostInput
// (wired via its onSelectionChange). Inline — deliberately NOT a Modal, so
// Escape semantics inside the entry editor stay untouched.
export function SaveShortcutBar({ selection }) {
  const [open, setOpen] = useState(false);
  const [abbrev, setAbbrev] = useState('');
  const [error, setError] = useState(null);
  const phrase = String(selection || '').replace(/\s+/g, ' ').trim();
  useEffect(() => { setOpen(false); setAbbrev(''); setError(null); }, [phrase]);
  if (phrase.length < 3) return null;

  async function save() {
    try {
      await api.post('/api/shortcuts', { abbrev, phrase });
      await refreshShortcuts();
      emitToast(`Shortcut saved: ${abbrev} → ${phrase}`);
      setOpen(false);
    } catch (e) {
      setError(e.message);
    }
  }

  const label = phrase.length > 26 ? `${phrase.slice(0, 26)}…` : phrase;
  return html`
    <span class="shortcut-save" data-shortcut-save>
      ${open ? html`
        <input type="text" placeholder="abbreviation" value=${abbrev} autoFocus
          style=${{ width: '110px' }}
          onInput=${(e) => setAbbrev(e.target.value.replace(/\s/g, ''))}
          onKeyDown=${(e) => { if (e.key === 'Enter' && abbrev) { e.preventDefault(); save(); } }} />
        <button type="button" class="btn btn-sm btn-primary" disabled=${!abbrev} onClick=${save}>Save</button>
        <button type="button" class="btn btn-sm" onClick=${() => setOpen(false)}>Cancel</button>
        ${error ? html`<span class="small" style=${{ color: 'var(--status-critical)' }}>${error}</span>` : null}` : html`
        <button type="button" class="btn btn-sm" title=${`Save "${phrase}" as a text-expansion shortcut`}
          onClick=${() => setOpen(true)}>＋ shortcut: “${label}”</button>`}
    </span>`;
}
```

Add to `public/css/app.css`, directly after the `.ghost-hint` rule (Task 3 block):

```css
.shortcut-save { display: inline-flex; align-items: center; gap: 6px; }
```

- [ ] **Step 3: Wire the editor**

In `public/js/components/entryeditor.js`:

1. Add imports (anchor: after the `ghosttext.js` import from Task 3):

```js
import { useShortcuts, SaveShortcutBar } from '/js/components/shortcuts.js';
import { expandShortcuts } from '/js/lib/expand.js';
```

2. Directly after the `const phrases = useMatterSuggestions(...)` line (Task 3), add:

```js
  // Text-expansion shortcuts (spec §6): deterministic inline expansion in
  // fragment/narrative fields + in-flow capture from a text selection.
  const shortcuts = useShortcuts();
  const [selText, setSelText] = useState('');
  const expand = useCallback((text, caret) => expandShortcuts(text, caret, shortcuts), [shortcuts]);
  const onFieldSelect = useCallback((el) => setSelText(el.value.slice(el.selectionStart, el.selectionEnd)), []);
```

3. Add `expand=${expand} onSelectionChange=${onFieldSelect}` to **both** GhostInputs from Task 3 (the multiline narrative one and the task-line fragment one) — e.g. the narrative becomes:

```js
          <${GhostInput} multiline rows=${3} value=${local.narrative} disabled=${finalized}
            suggestions=${phrases} expand=${expand} onSelectionChange=${onFieldSelect}
            placeholder="What did you do? (specific verbs — banned vague phrases are flagged)"
            onChange=${(v) => update({ narrative: v })} />`}
```

and the fragment:

```js
            <${GhostInput} value=${t.fragment} suggestions=${phrases} disabled=${finalized}
              expand=${expand} onSelectionChange=${onFieldSelect}
              placeholder=${isAuto ? 'narrative fragment for this task' : 'optional fragment (used if you add more lines)'}
              onChange=${(v) => updateLine(i, { fragment: v })} />
```

4. Render the save bar in the Narrative section title (anchor: the `<div class="section-title"><h3 ...>Narrative</h3>` block) — replace that block with:

```js
      <div class="section-title"><h3 style=${{ margin: 0 }}>Narrative</h3>
        ${isAuto ? html`<span class="muted small">generated from task lines — edit the fragments above</span>` : null}
        <div class="spacer" style=${{ flex: 1 }}></div>
        <${SaveShortcutBar} selection=${selText} />
      </div>
```

- [ ] **Step 4: Minimal Settings card (list/delete only)**

In `public/js/views/settings.js`:

1. Add the import (anchor: after the `/js/ui.js` import):

```js
import { useShortcuts, refreshShortcuts } from '/js/components/shortcuts.js';
```

2. In `SettingsView`, add `<${ShortcutsCard} />` on its own line directly after `<${TaskCodesCard} />`.

3. Add the component at the end of the file:

```js
// Minimal by design (spec §6): the dictionary is BUILT in-flow (select text
// in a narrative field → "save as shortcut"); Settings only lists & deletes.
function ShortcutsCard() {
  const list = useShortcuts();
  return html`
    <div class="card">
      <h2>Text-expansion shortcuts</h2>
      <p class="muted small">
        Type an abbreviation in any narrative or fragment field and it expands when you
        hit space or punctuation. Add new ones in-flow: select text in a narrative
        field and click “＋ shortcut”.
      </p>
      ${list.length === 0 ? html`<p class="muted small">No shortcuts yet.</p>` : html`
        <div class="table-wrap"><table class="tk">
          <thead><tr><th>Abbreviation</th><th>Expands to</th><th></th></tr></thead>
          <tbody>${list.map((s) => html`
            <tr key=${s.id}>
              <td class="mono">${s.abbrev}</td>
              <td>${s.phrase}</td>
              <td><button class="btn btn-ghost btn-sm" title="Delete shortcut"
                onClick=${async () => { await api.del(`/api/shortcuts/${s.id}`); await refreshShortcuts(); }}>✕</button></td>
            </tr>`)}</tbody>
        </table></div>`}
    </div>`;
}
```

- [ ] **Step 5: Run everything**

Run: `npm test` — Expected: PASS (no server changes).
Run: `node scripts/e2e-smoke.mjs` — Expected: all steps ✔ including `shortcuts: save-from-selection…`; ALL CLEAR.

- [ ] **Step 6: Commit**

```bash
git add public/js/components/shortcuts.js public/js/components/entryeditor.js public/js/views/settings.js public/css/app.css scripts/e2e-smoke.mjs
git commit -m "feat(ui): in-flow shortcut capture + inline expansion; minimal settings list"
```

---

### Task 5: Non-blocking stop chips replace the StopPopup modal

**Files:**
- Create: `public/js/components/stopchips.js`
- Modify: `public/js/components/timergrid.js` (delete `StopPopup`, swap usage, trim imports)
- Modify: `public/js/views/settings.js` (AiCard copy no longer mentions the popup)
- Modify: `public/css/app.css` (`.stop-chips` block)
- Modify: `scripts/e2e-smoke.mjs` (rewrite the stop step)

**Interfaces:**
- Consumes: stop payload `{ entry, hours, seconds, relinked?, previousTotal?, timer }` (timer now carries `suggested_narrative`, Task 2); `GET /api/matters/:id/suggestions`; `loadEntry` shape (`entry.narrative_auto`, `entry.cm.short_name`); `openEditor` prop already on `TimerGrid`.
- Produces: `StopChips({ popup, openEditor, onFiled, onClose, onClockDeduct })` — a fixed bottom-right portal card, CSS `.stop-chips`, `.chip-btn`. Keys: `1–3` pick, `e` edit, `Esc` dismiss. Auto-dismisses after 15 s (hover pauses). **A dismissed/ignored stop costs nothing — the draft is already filed** (Phase 4's close-out picks it up).

Behavior rules (bake into the component): chips are offered only when the entry's narrative is **blank** and not auto-generated (`narrative_auto`) — never clobber an existing or generated narrative; candidates = `timer.suggested_narrative` first, then ranked phrasebook texts, deduped case-insensitively, max 3. Tapping a chip `PATCH`es the entry narrative (single-task timer entries keep a manually-set narrative — `syncNarrative` only regenerates multi-line ones). The `relinked` midnight/finalize edge case keeps its warning + deduct button, now inside the card.

- [ ] **Step 1: Rewrite the e2e stop step (failing first)**

In `scripts/e2e-smoke.mjs`, replace the whole step `await step('context menu: backdated start (10m ago) → stop → narrative popup', …)` with:

```js
await step('backdated start (10m ago) → stop → non-blocking chips file the narrative', async () => {
  await page.click('.timer-card button[title="Timer menu"]');
  await waitFor('.ctx-menu');
  await clickText('.ctx-menu .ctx-inline button', '10m');
  await page.waitForFunction(() => document.querySelector('.timer-card.running'), { timeout: 4000 });
  await page.click('.timer-card button[title="Stop & file time"]');
  await waitFor('.stop-chips'); // lightweight affordance…
  if (await page.$('.modal')) throw new Error('stop must not open a modal'); // …not a blocking one
  await shot('stop-chips');
  // one-tap narrative from the matter's history (the finalized Acme entry)
  await clickText('.stop-chips .chip-btn', 'Reviewed lease agreement');
  await page.waitForFunction(() => !document.querySelector('.stop-chips'), { timeout: 4000 });
  await sleep(400);
  const entries = await page.$$eval('.entry-card', (els) => els.length);
  if (entries < 2) throw new Error(`expected 2 entries on dashboard, got ${entries}`);
});
```

Run: `node scripts/e2e-smoke.mjs` — Expected: the rewritten step FAILS (`.stop-chips` never appears); prior steps ✔.

- [ ] **Step 2: Create `public/js/components/stopchips.js`**

```js
import { api } from '/js/api.js';
import { html, useState, useEffect, useRef, createPortal, fmtHours, emitToast, Icon } from '/js/ui.js';

// Non-blocking stop affordance (spec §6): replaces the per-stop StopPopup
// modal. The stop has ALREADY filed the draft entry when this appears — it
// offers 2–3 one-tap narratives for this matter (suggested-on-start first,
// then the phrasebook); dismissing or ignoring it costs nothing, the draft
// waits for Phase 4's close-out. Keys: 1–3 pick · e edit · Esc dismiss.

const AUTO_DISMISS_MS = 15_000;

export function StopChips({ popup, openEditor, onFiled, onClose, onClockDeduct }) {
  const { result } = popup;
  const entry = result.entry;
  const timer = result.timer || popup.timer; // stop payload carries the fresh row
  const [chips, setChips] = useState(null); // null = loading
  const dismissRef = useRef(null);

  // never clobber: chips only when the narrative is blank and not auto-generated
  const offerChips = !entry.narrative_auto && String(entry.narrative || '').trim() === '';

  useEffect(() => {
    if (!offerChips) { setChips([]); return undefined; }
    let alive = true;
    api.get(`/api/matters/${timer.cm_id}/suggestions`)
      .then((r) => { if (alive) setChips(dedupe([timer.suggested_narrative, ...r.phrases.map((p) => p.text)])); })
      .catch(() => { if (alive) setChips(dedupe([timer.suggested_narrative])); });
    return () => { alive = false; };
  }, []); // eslint-disable-line

  // auto-dismiss (hover pauses) — non-blocking must also mean non-nagging
  const startDismiss = () => {
    clearTimeout(dismissRef.current);
    dismissRef.current = setTimeout(() => onClose(false), AUTO_DISMISS_MS);
  };
  const pauseDismiss = () => clearTimeout(dismissRef.current);
  useEffect(() => { startDismiss(); return () => clearTimeout(dismissRef.current); }, []); // eslint-disable-line

  async function pick(text) {
    try {
      await api.patch(`/api/entries/${entry.id}`, { narrative: text });
      emitToast('Narrative filed ✓');
      onFiled();
    } catch (e) {
      emitToast(e.message, { error: true });
    }
  }

  function edit() { onClose(false); openEditor({ id: entry.id }); }

  useEffect(() => {
    const onKey = (e) => {
      const tag = (e.target.tagName || '').toLowerCase();
      if (['input', 'textarea', 'select'].includes(tag) || e.target.isContentEditable) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'Escape') { e.stopPropagation(); onClose(false); }
      else if (e.key === 'e') { e.preventDefault(); e.stopPropagation(); edit(); }
      else if (['1', '2', '3'].includes(e.key) && chips && chips[Number(e.key) - 1]) {
        e.preventDefault();
        e.stopPropagation();
        pick(chips[Number(e.key) - 1]);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [chips]); // eslint-disable-line

  return createPortal(html`
    <div class="stop-chips" onMouseEnter=${pauseDismiss} onMouseLeave=${startDismiss}>
      <div class="stop-chips-head">
        <${Icon} name="check" size=${14} />
        <strong>${fmtHours(result.hours)}h filed</strong>
        <span class="muted">— ${entry.cm.short_name}</span>
        <span class="spacer" style=${{ flex: 1 }}></span>
        <button class="btn btn-ghost btn-sm" title="Dismiss (Esc) — the draft is saved either way"
          onClick=${() => onClose(false)}><${Icon} name="x" size=${14} /></button>
      </div>
      ${result.relinked ? html`
        <div class="stop-chips-warn">
          The entry this timer was filling got finalized, so the full day clock
          (${fmtHours(result.hours)}h) went to a <strong>new</strong> entry.
          ${result.previousTotal ? html`
            <button class="btn btn-sm" onClick=${() => { onClockDeduct(result.previousTotal); onClose(true); }}>
              Deduct ${fmtHours(result.previousTotal)}h from the clock
            </button>` : null}
        </div>` : null}
      ${offerChips ? (chips === null ? null : chips.length > 0 ? html`
        <div class="stop-chips-list">
          ${chips.map((text, i) => html`
            <button key=${text} class="chip-btn" title=${text} onClick=${() => pick(text)}>
              <kbd>${i + 1}</kbd> <span>${text}</span>
            </button>`)}
        </div>` : html`
        <div class="muted small" style=${{ padding: '2px 0 6px' }}>
          No narrative yet — it’ll wait as a draft.
        </div>`) : null}
      <div class="stop-chips-foot">
        <button class="btn btn-sm" onClick=${edit}><${Icon} name="edit" size=${14} /> Edit entry <kbd>e</kbd></button>
      </div>
    </div>`, document.body);
}

function dedupe(list) {
  const seen = new Set();
  const out = [];
  for (const t of list) {
    const text = String(t || '').trim();
    if (!text) continue;
    const k = text.toLowerCase();
    if (!seen.has(k)) { seen.add(k); out.push(text); }
    if (out.length === 3) break;
  }
  return out;
}
```

- [ ] **Step 3: Swap it into `timergrid.js`**

1. Imports: in the `/js/ui.js` import list, **remove `fmtHours`** (its only user was StopPopup) — the list becomes `html, useState, useEffect, useRef, useCallback, fmtClock, fmtTenths, emitToast, Modal, Confirm, ContextMenu, Field, Icon, clientLabel`. Add after the `TimerImport` import:

```js
import { StopChips } from '/js/components/stopchips.js';
```

2. Delete the entire `StopPopup` function **and** its banner comment — everything from the line `// ---------- stop popup: narrative prompt (+ AI) ----------` down to (but not including) the line `// ---------- modals ----------`.

3. Replace the render usage (anchor: the `${stopPopup ? html\`` block near the end of `TimerGrid`) with:

```js
    ${stopPopup ? html`
      <${StopChips} popup=${stopPopup} openEditor=${openEditor}
        onClockDeduct=${(h) => guard(clockDelta(stopPopup.timer, -h))}
        onFiled=${() => { setStopPopup(null); onEntryChanged(); reload(); }}
        onClose=${(changed) => { setStopPopup(null); if (changed) onEntryChanged(); reload(); }} />` : null}
```

4. In `public/js/views/settings.js`, in `AiCard`'s intro paragraph, change the copy `Type a brief description in an entry (or the timer-stop popup) and it drafts the` to `Type a brief description in an entry and it drafts the` (the popup no longer exists).

- [ ] **Step 4: Add the CSS**

In `public/css/app.css`, add after the ghost/shortcut block (Tasks 3–4):

```css
/* ---------- stop chips (non-blocking stop affordance) ---------- */
.stop-chips {
  position: fixed; right: 18px; bottom: 18px; z-index: 250;
  width: 380px; max-width: calc(100vw - 36px);
  background: var(--surface-1); border: 1px solid var(--border); border-radius: 10px;
  box-shadow: var(--shadow); padding: 10px 12px;
}
.stop-chips-head { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; }
.stop-chips-list { display: flex; flex-direction: column; gap: 6px; margin: 4px 0 8px; }
.chip-btn {
  display: flex; align-items: flex-start; gap: 8px; text-align: left; width: 100%;
  border: 1px solid var(--border); background: var(--surface-2); color: var(--text-primary);
  border-radius: 7px; padding: 7px 9px; font-size: 13px; cursor: pointer;
}
.chip-btn:hover { border-color: var(--accent); background: var(--surface-1); }
.chip-btn kbd { flex: none; }
.stop-chips-warn {
  border: 1px solid var(--status-warning); border-radius: 7px; padding: 6px 8px;
  font-size: 12.5px; margin-bottom: 8px;
}
.stop-chips-foot { display: flex; justify-content: flex-end; }
```

- [ ] **Step 5: Run everything**

Run: `npm test` — Expected: PASS (no server changes).
Run: `node scripts/e2e-smoke.mjs` — Expected: all steps ✔ including the rewritten stop step (and the ghost/shortcut steps, which run after it); ALL CLEAR.

- [ ] **Step 6: Commit**

```bash
git add public/js/components/stopchips.js public/js/components/timergrid.js public/js/views/settings.js public/css/app.css scripts/e2e-smoke.mjs
git commit -m "feat(ui): non-blocking stop chips replace the StopPopup modal"
```

---

### Task 6: Streaming `/api/ai/narrate` endpoint (NDJSON tokens)

**Files:**
- Modify: `server/routes/ai.js` (new route)
- Test: `test/api.ai.test.js` (extend the stub for `stream:true`; two new tests)

**Interfaces:**
- Consumes: `buildNarrateMessages` (Task 2), `getSetting`, the stub-Ollama helper.
- Produces: `POST /api/ai/narrate` body `{ brief?, narrative?, mode?: 'draft'|'regenerate'|'shorter'|'longer', context? }`. Success streams `application/x-ndjson`: zero-or-more `{"token":"…"}` lines, then `{"done":true,"narrative":"…"}`. Pre-stream failures are normal JSON: `400 { error: 'ai_disabled' | '…' }`, `502 { error: 'ollama_unreachable', message }`. Mid-stream failure emits a final `{"error":"ai_stream_failed","message":"…"}` line. Task 7 and Phase 4 consume exactly this shape.

- [ ] **Step 1: Teach the stub Ollama to stream**

In `test/api.ai.test.js`, inside `startStubOllama`, replace the `/api/chat` branch body (anchor: `state.lastChat = JSON.parse(body);` and the `res.end(...)` after it) with:

```js
        req.on('end', () => {
          state.lastChat = JSON.parse(body);
          if (state.lastChat.stream) {
            // Ollama streaming shape: NDJSON chunks, each carrying a token
            res.setHeader('content-type', 'application/x-ndjson');
            for (const token of String(chatBody).match(/.{1,12}/gs) || []) {
              res.write(JSON.stringify({ message: { role: 'assistant', content: token }, done: false }) + '\n');
            }
            res.end(JSON.stringify({ message: { role: 'assistant', content: '' }, done: true }) + '\n');
          } else {
            res.end(JSON.stringify({ message: { role: 'assistant', content: chatBody } }));
          }
        });
```

Run: `node --test test/api.ai.test.js` — Expected: PASS (existing tests all use `stream:false` paths; the refine test from Task 2 still passes).

- [ ] **Step 2: Write the failing endpoint tests**

Append to `test/api.ai.test.js`:

```js
test('ai narrate streams NDJSON tokens and a final assembled narrative', async () => {
  const stub = await startStubOllama('Reviewed lease exhibit; revised legal description.');
  const t = await startTestServer();
  try {
    setSetting(t.db, 'ai', { enabled: true, model: 'llama3.1:8b', url: stub.url });
    const res = await fetch(`${t.base}/api/ai/narrate`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ brief: 'lease exhibit work', mode: 'draft' }),
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /x-ndjson/);
    const lines = (await res.text()).trim().split('\n').map((l) => JSON.parse(l));
    const last = lines.at(-1);
    assert.equal(last.done, true);
    assert.equal(last.narrative, 'Reviewed lease exhibit; revised legal description.');
    const tokens = lines.slice(0, -1);
    assert.ok(tokens.length >= 2, 'multiple token chunks streamed');
    assert.equal(tokens.map((x) => x.token).join(''), last.narrative);
    assert.equal(stub.state.lastChat.stream, true);
  } finally { await t.close(); await stub.close(); }
});

test('ai narrate: validation, shorter/longer rewrite modes, clean failures', async () => {
  const stub = await startStubOllama('Shorter version.');
  const t = await startTestServer();
  try {
    // disabled → clean 400 before any streaming
    assert.equal((await t.fetchJson('POST', '/api/ai/narrate', { brief: 'x' })).status, 400);
    setSetting(t.db, 'ai', { enabled: true, model: 'llama3.1:8b', url: stub.url });
    assert.equal((await t.fetchJson('POST', '/api/ai/narrate', { mode: 'shorter' })).status, 400); // no narrative
    assert.equal((await t.fetchJson('POST', '/api/ai/narrate', {})).status, 400);                  // no brief

    const res = await fetch(`${t.base}/api/ai/narrate`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'shorter', narrative: 'A very long narrative about the lease.' }),
    });
    assert.equal(res.status, 200);
    const last = JSON.parse((await res.text()).trim().split('\n').at(-1));
    assert.equal(last.narrative, 'Shorter version.');
    const user = stub.state.lastChat.messages[1].content;
    assert.ok(user.includes('A very long narrative about the lease.'));
    assert.match(stub.state.lastChat.messages[0].content, /plain text/);
    assert.ok(!stub.state.lastChat.messages[0].content.includes('Respond with ONLY this JSON'),
      'no JSON contract in narrate prompts');

    // unreachable ollama → clean 502 JSON (nothing streamed)
    setSetting(t.db, 'ai', { enabled: true, model: 'llama3.1:8b', url: 'http://127.0.0.1:1' });
    assert.equal((await t.fetchJson('POST', '/api/ai/narrate', { brief: 'x' })).status, 502);
  } finally { await t.close(); await stub.close(); }
});
```

Run: `node --test test/api.ai.test.js` — Expected: the two new tests FAIL (404 `not_found`).

- [ ] **Step 3: Implement the route**

In `server/routes/ai.js`, inside `aiRouter`, add after the `r.post('/ai/expand', …)` handler:

```js
  // Streamed narrative (spec §6 "faster AI narration"): plain-text tokens as
  // NDJSON lines — {"token":"…"} per chunk, then {"done":true,"narrative":…}
  // — so the UI renders while llama3.1:8b grinds (~180s on CPU). Fails as
  // normal JSON before the first byte; as an {"error":…} line after.
  // Unlike /ai/expand this never asks for JSON output — token streams of a
  // JSON document aren't displayable, so the structured task-split flow keeps
  // the blocking endpoint and this one owns narrative-only generation.
  r.post('/ai/narrate', async (req, res) => {
    const cfg = getSetting(db, 'ai') || {};
    if (!cfg.enabled) return res.status(400).json({ error: 'ai_disabled' });
    const b = req.body || {};
    const mode = ['draft', 'regenerate', 'shorter', 'longer'].includes(b.mode) ? b.mode : 'draft';
    const brief = String(b.brief || '').trim();
    const narrative = String(b.narrative || '').trim();
    if ((mode === 'shorter' || mode === 'longer') ? !narrative : !brief) {
      return res.status(400).json({ error: 'Describe the work first.' });
    }
    const messages = buildNarrateMessages({
      instructions: cfg.systemPrompt, brief, narrative, mode,
      context: b.context ? String(b.context).slice(0, 2000) : null,
    });

    let resp;
    try {
      resp = await fetch(`${cfg.url}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: cfg.model, stream: true,
          // regenerate wants a *different* sample; rewrites stay conservative
          options: { temperature: mode === 'regenerate' ? 0.8 : 0.3 },
          messages,
        }),
        signal: AbortSignal.timeout(180_000),
      });
      if (!resp.ok || !resp.body) throw new Error(`ollama returned ${resp.status}`);
    } catch (e) {
      return res.status(502).json({
        error: 'ollama_unreachable',
        message: `Could not reach the local model: ${e.message}`,
      });
    }

    res.setHeader('content-type', 'application/x-ndjson');
    res.setHeader('cache-control', 'no-store');
    const send = (obj) => res.write(JSON.stringify(obj) + '\n');
    let full = '';
    try {
      let buf = '';
      for await (const chunk of resp.body) {
        buf += Buffer.from(chunk).toString('utf8');
        let nl;
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let data;
          try { data = JSON.parse(line); } catch { continue; }
          const token = data.message && data.message.content;
          if (token) { full += token; send({ token }); }
        }
      }
      send({ done: true, narrative: full.trim() });
    } catch (e) {
      send({ error: 'ai_stream_failed', message: e.message });
    }
    res.end();
  });
```

- [ ] **Step 4: Run the tests, then the full suite**

Run: `node --test test/api.ai.test.js` — Expected: PASS (8 tests).
Run: `npm test` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/routes/ai.js test/api.ai.test.js
git commit -m "feat(api): streaming /api/ai/narrate endpoint (NDJSON tokens)"
```

---

### Task 7: Streamed narration UI — live tokens + regenerate / shorter / longer

**Files:**
- Modify: `public/js/api.js` (add `streamNdjson`)
- Modify: `public/js/components/entryeditor.js` (aiNarrate + reworked ai-row)

**Interfaces:**
- Consumes: `POST /api/ai/narrate` (Task 6 shape); existing `aiExpand`/`aiSplit` (the structured split path keeps the blocking `/ai/expand` — a JSON task split can't stream).
- Produces: `streamNdjson(path, body, onLine): Promise<void>` exported from `public/js/api.js` (Phase 4's close-out and bill-from-a-sentence fallback reuse it). Editor behavior: with "split into tasks" **unchecked**, the button reads **Write** and streams tokens live into the narrative field; when a run completes, **↻ Regenerate · Shorter · Longer** buttons appear (regenerate re-runs the brief; shorter/longer send the current narrative).

- [ ] **Step 1: Add the streaming client**

In `public/js/api.js`, append after the `api` export:

```js
// Streaming POST for NDJSON endpoints (/api/ai/narrate): calls onLine(obj)
// per line as tokens arrive. Non-2xx rejects with ApiError before any line
// is delivered (the server only streams after committing to 200).
export async function streamNdjson(path, body, onLine) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    credentials: 'same-origin',
  });
  if (res.status === 401) {
    window.dispatchEvent(new CustomEvent('tk:auth-required'));
    throw new ApiError(401, null);
  }
  if (!res.ok) {
    let json = null;
    try { json = await res.json(); } catch { /* keep null */ }
    throw new ApiError(res.status, json);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) onLine(JSON.parse(line));
    }
  }
}
```

- [ ] **Step 2: Wire the editor**

In `public/js/components/entryeditor.js`:

1. Change the api import line to `import { api, streamNdjson } from '/js/api.js';`

2. Add state (anchor: after the line `const [aiBusy, setAiBusy] = useState(false);`):

```js
  const [aiDone, setAiDone] = useState(false); // a narrate run finished → show rewrite controls
```

3. Add the streaming action (anchor: directly after the whole `async function aiExpand() { … }` function):

```js
  // Streamed narration (spec §6): tokens land in the narrative field live,
  // replacing the blocking spinner. The "split into tasks" path keeps the
  // JSON /ai/expand endpoint — a structured split can't stream. Each chunk
  // goes through update(), so the normal debounced autosave applies.
  async function aiNarrate(mode) {
    setAiBusy(true);
    try {
      let acc = '';
      await streamNdjson('/api/ai/narrate', {
        mode, brief, narrative: localRef.current?.narrative || '',
      }, (m) => {
        if (m.error) throw new Error(m.message || m.error);
        if (m.token) { acc += m.token; update({ narrative: acc }); }
        if (m.done) update({ narrative: m.narrative });
      });
      setAiDone(true);
    } catch (e) {
      emitToast(e.body?.message || e.message, { error: true });
    } finally {
      setAiBusy(false);
    }
  }
```

4. Replace the entire ai-row block (anchor: `${ai && ai.enabled && ai.reachable && !finalized ? html\`` through its closing `` \` : null}``) with:

```js
      ${ai && ai.enabled && ai.reachable && !finalized ? html`
        <div class="ai-row">
          <input type="text" value=${brief}
            placeholder=${`Brief description — ${ai.model} ${aiSplit ? 'expands it…' : 'writes it live…'}`}
            onInput=${(e) => setBrief(e.target.value)}
            onKeyDown=${(e) => { if (e.key === 'Enter' && brief && !aiBusy) (aiSplit ? aiExpand() : aiNarrate('draft')); }} />
          <label class="checkbox-row small">
            <input type="checkbox" checked=${aiSplit} onChange=${(e) => setAiSplit(e.target.checked)} />
            split into tasks
          </label>
          <button class="btn" disabled=${!brief || aiBusy} onClick=${() => (aiSplit ? aiExpand() : aiNarrate('draft'))}>
            <${Icon} name="sparkles" size=${16} />
            ${aiBusy ? (aiSplit ? 'Thinking…' : 'Streaming…') : (aiSplit ? 'Expand' : 'Write')}
          </button>
          ${aiDone && !aiBusy && !isAuto ? html`
            <span class="row" style=${{ gap: '4px', flexWrap: 'nowrap' }}>
              <button class="btn btn-sm" title="Try a different phrasing" disabled=${!brief}
                onClick=${() => aiNarrate('regenerate')}>↻ Regenerate</button>
              <button class="btn btn-sm" onClick=${() => aiNarrate('shorter')}>Shorter</button>
              <button class="btn btn-sm" onClick=${() => aiNarrate('longer')}>Longer</button>
            </span>` : null}
        </div>` : null}
```

- [ ] **Step 3: Run everything**

Run: `npm test` — Expected: PASS.
Run: `node scripts/e2e-smoke.mjs` — Expected: ALL CLEAR. (The e2e runs with AI **disabled**, so the ai-row never renders — this is regression cover only. Streaming behavior is covered by Task 6's stubbed API tests; do NOT add an e2e step that needs Ollama.)

Manual spot-check (optional, requires the box's Ollama): enable AI in Settings, open an entry, uncheck "split into tasks", type a brief → tokens should appear progressively, then the three rewrite buttons.

- [ ] **Step 4: Commit**

```bash
git add public/js/api.js public/js/components/entryeditor.js
git commit -m "feat(ui): streamed AI narration with regenerate/shorter/longer"
```

---

### Task 8: Grid keyboard focus model + worked-today highlight

**Files:**
- Modify: `server/routes/timers.js` (`cm_billable` in the list payload — needed by quick-note)
- Modify: `public/js/components/timergrid.js` (roving tabindex, board key handler, `worked` class)
- Modify: `public/css/app.css` (focus + worked rules)
- Modify: `scripts/e2e-smoke.mjs` (one new step)
- Test: `test/api.timers.test.js` (one assertion)

**Interfaces:**
- Consumes: `.seg` grouping selector + section builder (1b, landed); `clockDelta`/`start`/`stop`/`setEditing`/`openEditor` already in `TimerGrid`; `StopChips` (Task 5 — Enter-stop surfaces it).
- Produces: roving-tabindex focus model — exactly one `.timer-card` is tabbable (`tabIndex 0`), identified by `data-timer-id`; keys on the focused card: **arrows** move · **Enter/Space** start–stop · **Alt+↑/↓** ±0.1 h (**+Shift** ±0.2 h) · **Shift+Enter** edit timer · **Ctrl+Enter** quick-note (opens the linked entry, or a new-entry template on the timer's matter). CSS: `.timer-card:focus-visible`, `.timer-card.worked`. Task 9 extends the same key handler with printable-character filtering — **printable keys are reserved for the filter**, which is why every command here is a non-printable chord (deliberate resolution of the "typing filters vs. single-letter commands" conflict).

- [ ] **Step 1: `cm_billable` on the timer list (failing assertion first)**

In `test/api.timers.test.js`, inside the existing test `timer list carries client fields for by-client grouping`, add one line right after the `assert.ok(list[0].client_id);` assertion:

```js
    assert.equal(list[0].cm_billable, 1);
```

Run: `node --test test/api.timers.test.js` — Expected: that test FAILS (`cm_billable` undefined).

In `server/routes/timers.js`, in the `listStmt` query, add one subselect line after the `cm_short_name` line:

```js
      (SELECT billable FROM matters WHERE matters.id = timers.cm_id) AS cm_billable,
```

Run: `node --test test/api.timers.test.js` — Expected: PASS.

- [ ] **Step 2: Focus state + board key handler in `timergrid.js`**

1. Add state (anchor: directly after the `const setGrouping = (v) => …` line):

```js
  // Keyboard focus model (spec §4): ONE focused timer via roving tabindex.
  const [focusId, setFocusId] = useState(null);
```

2. In the render section, directly after the `let sections; … } else { sections = […] }` grouping builder (anchor: the closing brace before `return html\``), add:

```js
  // ordered list of cards actually on screen (collapse-aware); the roving
  // tabindex + arrow keys walk this list. Task 9 filters it further.
  const visible = sections.flatMap((sec) =>
    (byGroupMode && sec.group && sec.group.collapsed) ? [] : sec.list);
  const tabbableId = visible.some((t) => t.id === focusId) ? focusId : (visible[0] && visible[0].id);

  const focusCard = (id) => {
    setFocusId(id);
    requestAnimationFrame(() => {
      document.querySelector(`.timer-card[data-timer-id="${id}"]`)?.focus();
    });
  };

  // Keys for the focused card. Every command is a NON-PRINTABLE chord —
  // printable characters are reserved for type-to-filter (spec §4).
  // stopPropagation keeps these away from the app-level shortcuts (n/t/g/…).
  function onBoardKey(e) {
    const tag = (e.target.tagName || '').toLowerCase();
    if (['input', 'textarea', 'select'].includes(tag)) return; // in-card clock editing etc.
    const list = visible;
    if (list.length === 0) return;
    const idx = Math.max(0, list.findIndex((t) => t.id === focusId));
    const cur = list[idx];
    const done = () => { e.preventDefault(); e.stopPropagation(); };

    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      const step = (e.shiftKey ? 0.2 : 0.1) * (e.key === 'ArrowUp' ? 1 : -1);
      guard(clockDelta(cur, step));
      return done();
    }
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { focusCard(list[Math.min(idx + 1, list.length - 1)].id); return done(); }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { focusCard(list[Math.max(idx - 1, 0)].id); return done(); }
    if (e.key === 'Enter' && e.shiftKey) { setEditing(cur); return done(); }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      // quick-note: today's entry if linked, else a fresh entry on this matter
      if (cur.linked_entry_id) openEditor({ id: cur.linked_entry_id });
      else openEditor({ template: { cm: { id: cur.cm_id, cm_number: cur.cm_number, short_name: cur.cm_short_name, billable: cur.cm_billable ?? 1 } } });
      return done();
    }
    if (e.key === 'Enter' || e.key === ' ') {
      guard(cur.running ? stop(cur) : start(cur));
      return done();
    }
  }
```

3. Wrap the sections in a board container: in the returned html, insert `<div class="timer-board" tabIndex=${-1} onKeyDown=${onBoardKey}>` on a new line **after** the closing `</div>` of the `section-title` header block, and close it (`</div>`) **after** the `${timers.length === 0 ? … : null}` empty-state block (i.e. the board wraps `${sections.map(…)}` **and** the empty-state button; the modals/menus below stay outside).

4. Pass focus props to the card (anchor: the `<${TimerCard} key=${t.id} …` call): add these two props:

```js
                  tabbable=${tabbableId === t.id} onFocusCard=${() => setFocusId(t.id)}
```

5. Update `TimerCard`: change the signature to

```js
function TimerCard({ timer, secs, idleAfter, roundMode, canDrag = true, tabbable = false, onFocusCard, onStart, onStop, onDelta, onSet, onMenu, onDragStart, onDropOn }) {
```

add inside the function, before the `return`:

```js
  // Worked-today highlight (spec §4): accumulated time today (elapsed > 0 or
  // a linked entry) vs. still-at-zero — independent of .running / .idle-nudge.
  const worked = !!timer.linked_entry_id || secs > 0;
```

and change the card's opening div: the class expression becomes

```js
    <div class=${'timer-card' + (timer.running ? ' running' : '') + (worked ? ' worked' : '')}
      tabIndex=${tabbable ? 0 : -1}
      data-timer-id=${timer.id}
      onFocus=${() => onFocusCard && onFocusCard()}
```

(keep every other attribute — `draggable`, `title`, drag handlers, `onContextMenu` — exactly as-is).

- [ ] **Step 3: CSS**

In `public/css/app.css`, add after the `.timer-card.running .timer-clock` rule:

```css
.timer-card:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.timer-board:focus { outline: none; }
/* worked-today (spec §4): theme-aware via the status token; the 3px edge +
   reduced padding keeps content aligned with untouched cards. Functional
   only — motion is Phase 4. */
.timer-card.worked { border-left: 3px solid var(--status-good); padding-left: 4px; }
.timer-card.worked.running { border-left-color: var(--accent); }
```

- [ ] **Step 4: Add the failing e2e step**

In `scripts/e2e-smoke.mjs`, insert immediately after the `await step('client rename: inline on CMs view, …')` block:

```js
await step('grid keyboard: focus, Alt-nudge, Enter start/stop; worked-today highlight', async () => {
  // a second, untouched timer proves the worked/zero distinction
  await clickText('button', 'New timer');
  await type('.modal input[placeholder="e.g. Acme — research"]', 'Harbor drafting');
  await page.click('.modal .cmpicker input');
  await sleep(250);
  await clickText('.cmpicker-item .name', 'Harbor Lease');
  await clickText('.modal button', 'Create');
  await page.waitForFunction(() => document.querySelectorAll('.timer-card').length >= 2, { timeout: 4000 });

  const workedNames = await page.$$eval('.timer-card.worked .timer-name', (els) => els.map((e) => e.textContent));
  if (!workedNames.includes('Acme research')) throw new Error(`Acme not highlighted: ${workedNames}`);
  if (workedNames.includes('Harbor drafting')) throw new Error('zero timer must not be highlighted');

  const focusAcme = () => page.evaluate(() => {
    [...document.querySelectorAll('.timer-card')]
      .find((c) => c.textContent.includes('Acme research')).focus();
  });
  const acmeClockIs = (want) => page.waitForFunction((w) => {
    const card = [...document.querySelectorAll('.timer-card')]
      .find((c) => c.textContent.includes('Acme research'));
    return card && card.querySelector('.timer-clock')?.textContent.trim() === w;
  }, { timeout: 4000 }, want);

  await focusAcme();
  await page.keyboard.down('Alt');
  await page.keyboard.press('ArrowUp');           // +0.1 → 1.5
  await page.keyboard.up('Alt');
  await acmeClockIs('1.5');
  await page.keyboard.down('Alt');
  await page.keyboard.down('Shift');
  await page.keyboard.press('ArrowDown');          // −0.2 → 1.3
  await page.keyboard.up('Shift');
  await page.keyboard.up('Alt');
  await acmeClockIs('1.3');

  await page.keyboard.press('Enter');              // start
  await page.waitForFunction(() => document.querySelector('.timer-card.running'), { timeout: 4000 });
  await sleep(2500);                               // outlive the 2s misclick grace
  await focusAcme();
  await page.keyboard.press('Enter');              // stop → chips
  await waitFor('.stop-chips');
  await page.keyboard.press('Escape');             // dismiss — the draft is already filed
  await page.waitForFunction(() => !document.querySelector('.stop-chips'), { timeout: 4000 });
});
```

Run: `node scripts/e2e-smoke.mjs` — Expected: the new step FAILS (`.timer-card.worked` doesn't exist yet); prior steps ✔. Then re-run after Steps 1–3 are in place.

- [ ] **Step 5: Run everything**

Run: `npm test` — Expected: PASS.
Run: `node scripts/e2e-smoke.mjs` — Expected: all steps ✔; ALL CLEAR.

- [ ] **Step 6: Commit**

```bash
git add server/routes/timers.js public/js/components/timergrid.js public/css/app.css scripts/e2e-smoke.mjs test/api.timers.test.js
git commit -m "feat(ui): timer grid keyboard focus model + worked-today highlight"
```

---

### Task 9: Type-to-filter on the grid + keyboard help

**Files:**
- Modify: `public/js/components/timergrid.js` (filter state, key handling, pill, focus retention)
- Modify: `public/js/app.js` (KeyboardHelp rows)
- Modify: `public/css/app.css` (`.grid-filter`)
- Modify: `scripts/e2e-smoke.mjs` (one new step)

**Interfaces:**
- Consumes: Task 8's board key handler / `visible` list / `focusCard`; `client_name`/`client_number` on timer rows (1b).
- Produces: typing printable characters while a card is focused live-filters cards across **timer label, matter short name, CM number, client name, client number** — in place, distinct from `/` global search; Backspace edits; **Esc clears the filter** (a second Esc, with no filter, falls through to whoever owns it — e.g. StopChips). Pill UI `.grid-filter` shows the query + `shown/total` + a clear button. Space is NOT a filter character (it stays start–stop).

- [ ] **Step 1: Add the failing e2e step**

In `scripts/e2e-smoke.mjs`, insert immediately after Task 8's grid-keyboard step:

```js
await step('type-to-filter narrows the grid in place; Esc restores', async () => {
  await page.evaluate(() => {
    [...document.querySelectorAll('.timer-card')]
      .find((c) => c.textContent.includes('Acme research')).focus();
  });
  await page.keyboard.type('meridian', { delay: 20 });
  await waitFor('.grid-filter');
  await page.waitForFunction(() => {
    const names = [...document.querySelectorAll('.timer-card .timer-name')].map((e) => e.textContent);
    return names.length === 1 && names[0] === 'Harbor drafting'; // matched via CLIENT name
  }, { timeout: 4000 });
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('.grid-filter')
    && document.querySelectorAll('.timer-card').length >= 2, { timeout: 4000 });
});
```

Run: `node scripts/e2e-smoke.mjs` — Expected: the new step FAILS (`.grid-filter` never appears); prior steps ✔.

- [ ] **Step 2: Filter state + matching in `timergrid.js`**

1. Add state (anchor: directly after the `const [focusId, setFocusId] = useState(null);` line from Task 8):

```js
  // Type-to-filter (spec §4): live, in-place, distinct from the `/` global
  // search. Plain string state — no input element; the focused card (or the
  // board) receives the keystrokes.
  const [gridFilter, setGridFilter] = useState('');
```

2. In the render prelude, directly after the `const byGroupMode = grouping === 'group';` line, add:

```js
  const norm = gridFilter.trim().toLowerCase();
  const matchesFilter = (t) => !norm
    || [t.name, t.cm_short_name, t.client_name, t.client_number, t.cm_number]
      .some((v) => String(v || '').toLowerCase().includes(norm));
  const shown = norm ? timers.filter(matchesFilter) : timers;
```

3. In the three grouping branches (`grouping === 'client'`, `'flat'`, and the by-group `else`), replace every use of `timers` **as the section source** with `shown` (four spots: the `for (const t of timers)` loop, `list: timers` in flat, and the two `timers.filter(...)` calls in by-group). Do NOT touch `timers.length === 0` (empty-state) or anything else.

4. Hide filtered-empty sections: at the top of the `${sections.map((sec) => { … })}` callback, directly after `const { group, list } = sec;`, add:

```js
      if (norm && list.length === 0) return null; // filtering hides empty sections
```

5. Filter keys in `onBoardKey` — insert directly after the `const done = () => …` line (so they run before the command keys):

```js
    if (e.key.length === 1 && e.key !== ' ' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      setGridFilter((f) => f + e.key); // printable keys build the filter (space = start/stop)
      return done();
    }
    if (e.key === 'Backspace') { setGridFilter((f) => f.slice(0, -1)); return done(); }
    if (e.key === 'Escape' && gridFilter) { setGridFilter(''); return done(); }
    // Escape with no filter falls through (StopChips etc. listen on document)
```

6. Keep the keyboard anchored while the filter narrows the grid — add this effect next to the other `useEffect`s (anchor: after the `'t' shortcut` effect):

```js
  // while filtering, keep focus on a visible card (or the board itself when
  // nothing matches) so the next keystroke still reaches the filter
  useEffect(() => {
    if (!gridFilter) return;
    const active = document.activeElement;
    const stillVisible = visible.some((t) => t.id === focusId);
    if (stillVisible && active && active.dataset && active.dataset.timerId === String(focusId)) return;
    if (visible[0]) focusCard(visible[0].id);
    else document.querySelector('.timer-board')?.focus();
  }, [gridFilter]); // eslint-disable-line
```

(This references `visible`/`focusCard` from the render scope — like `onBoardKey`, declare it **after** they exist; place the effect right before the `return html` if hook-ordering with the early `if (!timers) return null;` is a concern: it is — **place this effect above the `if (!timers) return null;` line and guard it**: `if (!timers || !gridFilter) return;` and compute nothing else from render scope inside it except via `document`. Concretely, use this hook-safe version instead:)

```js
  // hook-safe: runs before the early return, touches only the DOM
  useEffect(() => {
    if (!gridFilter) return;
    const cards = [...document.querySelectorAll('.timer-card')];
    const active = document.activeElement;
    if (active && cards.includes(active)) return;
    if (cards[0]) { setFocusId(Number(cards[0].dataset.timerId)); cards[0].focus(); }
    else document.querySelector('.timer-board')?.focus();
  }, [gridFilter]);
```

7. Pill UI — in the `section-title` header, directly after the closing tag of the `.seg` div, add:

```js
      ${gridFilter ? html`
        <span class="grid-filter" title="Type-to-filter — Esc clears">
          <${Icon} name="search" size=${13} />
          <span class="mono">${gridFilter}</span>
          <span class="muted small">${shown.length}/${timers.length}</span>
          <button class="btn btn-ghost btn-sm" title="Clear filter" onClick=${() => setGridFilter('')}>✕</button>
        </span>` : null}
```

- [ ] **Step 3: CSS + keyboard help**

In `public/css/app.css`, after the `.timer-card.worked.running` rule (Task 8):

```css
.grid-filter {
  display: inline-flex; align-items: center; gap: 6px; margin-left: 10px;
  border: 1px solid var(--accent); border-radius: 999px; padding: 1px 4px 1px 10px;
  font-size: 12.5px; background: var(--accent-soft);
}
```

In `public/js/app.js`, in `KeyboardHelp`, append to the `rows` array (after the `['?', 'This help']` row — keys must stay unique, they're React keys):

```js
    ['Tab / click', 'Focus the timer grid'],
    ['← → ↑ ↓', 'Move between timer cards'],
    ['Enter or Space', 'Start–stop the focused timer'],
    ['a–z, 0–9', 'Filter the grid in place (Esc clears)'],
    ['Alt+↑ / Alt+↓', 'Nudge the focused timer ±0.1h (+Shift: ±0.2h)'],
    ['Shift+Enter', 'Edit the focused timer'],
    ['Ctrl+Enter (grid)', 'Open the focused timer’s entry'],
```

- [ ] **Step 4: Run everything**

Run: `npm test` — Expected: PASS.
Run: `node scripts/e2e-smoke.mjs` — Expected: all steps ✔ including `type-to-filter…` and every earlier step (the filter must not disturb the grouping/rename steps); ALL CLEAR.

- [ ] **Step 5: Commit**

```bash
git add public/js/components/timergrid.js public/js/app.js public/css/app.css scripts/e2e-smoke.mjs
git commit -m "feat(ui): grid type-to-filter in place + keyboard help updates"
```

---

## Self-Review

**Spec coverage (Phase 3 = §6 minus bill-from-a-sentence, plus §4 remainder):**
- Ghost-text autocomplete, deterministic, prefix+rank, Tab accepts, grey inline → Task 3 (pure engine unit-tested; reusable `GhostInput` + `useMatterSuggestions` for Phase 4's close-out; entry-editor mount; e2e Tab-accept). Controller resolution honored: editor only, no quick-capture. ✓
- Chips on stop replacing the blocking StopPopup; 2–3 ready narratives; tap = filed; dismiss/ignore = silent draft → Task 5 (portal card, suggested-on-start first + phrasebook, keyboard 1–3/e/Esc, auto-dismiss, relinked warning preserved, e2e rewritten; `if (.modal) throw` guards non-blockingness). ✓
- Suggested narrative on timer start; phrasebook first, optional async LLM non-blocking; storage decided & justified (timers column via appended migration — restarts, cross-device stops, durable LLM landing) → Task 2 (+ refine test with stub Ollama; `running=1` write guard; PATCH-cm clears stale suggestion). ✓
- Text-expansion shortcuts: new appended migration (`shortcuts` table), small API, deterministic inline expansion distinct from phrasebook, **in-flow** select-text → save-as-shortcut, Settings limited to list/delete → Tasks 1 + 4 (engine unit-tested incl. `tc/oc`; e2e saves + expands + checks the settings list). ✓
- Streamed AI narration with regenerate/shorter/longer replacing the spinner → Tasks 6 + 7 (NDJSON server route, stub-streaming tests, live-token UI; the JSON split path deliberately stays blocking — structured output can't stream; no test touches live Ollama). ✓
- §4 type-to-filter (client/matter/short-name/timer-label, in place, distinct from `/`) → Task 9; worked-today highlight (elapsed>0 or linked_entry_id, theme-aware token, separate from `.running`/`.idle-nudge`) → Task 8; keyboard focus model (roving tabindex; start/stop, ±0.1/±0.2 nudge, edit, quick-note) → Task 8. 1b grouping selector integrated (visible-list walks its sections), not reworked. ✓
- **Out of scope honored:** no close-out screen, no today footer, no bill-from-a-sentence, no micro-animations (all new CSS is static), `/api/cms` fields and export shape untouched.

**Placeholder scan:** no TBD/TODO/"handle edge cases"; every code step has complete code; every run step has an expected outcome; both frontend-visible key models are enumerated key-by-key.

**Type consistency:** `expandShortcuts(text, caret, shortcuts) → {text, caret}|null` — Task 1 definition = Task 3's `expand` prop contract = Task 4 usage. `ghostCompletion(value, caret, phrases, {minChars})` — Task 3 definition/tests/component agree. `matterSuggestions(db, matterId, today)` — Task 2 definition, consumed in `timers.js` and `ai.js` with that exact signature. `buildNarrateMessages({instructions, brief, narrative, mode, context})` — defined Task 2, reused Task 6. `refineSuggestedNarrative({db, clock}, timerId)` — defined Task 2, called in `timers.js` Task 2 Step 6. NDJSON line shapes `{token} / {done, narrative} / {error, message}` — Task 6 server = Task 6 tests = Task 7 client. `suggested_narrative` appears in `TIMER_COLS` (Task 2), stop payload assertion (Task 2 test), and `StopChips` read (Task 5). `cm_billable` — Task 8 producer = quick-note consumer. E2E hooks defined in the same task that asserts them: `.ghost-hint`, `[data-shortcut-save]`, `.stop-chips`/`.chip-btn`, `.timer-card.worked`, `data-timer-id`, `.grid-filter`.

**Known deliberate choices (not defects):**
- Pure browser modules live in `public/js/lib/*` with zero imports and are unit-tested by importing them directly under node — the no-build stack makes one file serve both runtimes; duplicating them into `server/lib` would create drift for logic the server never executes.
- Ghost dismissal is NOT on Escape: the editor Modal owns Escape via a capture-phase document listener; hijacking it would either break "Esc closes the editor" or silently eat keystrokes. Typing/caret movement/blur all clear the ghost.
- Task 2 rewrites `server/routes/matters.js` (Phase 2's file) only to extract `matterSuggestions`; endpoint behavior is byte-compatible and Phase 2's `test/api.matters.test.js` is the regression gate.
- Grid commands are all non-printable chords because printable keys feed the filter — the spec's "typing while the grid is focused live-filters" wins the letter keys; nudge/edit/quick-note get Alt/Shift/Ctrl chords, documented in `?` help.
- Chips never overwrite an existing or auto-generated narrative (second stop of the day on an already-narrated entry shows only the confirmation + Edit); the AI brief box moved from the dead StopPopup into the always-available editor rather than the transient card.
- The stop step's e2e now files via chip; the old typed-narrative path is covered instead by the ghost/shortcut editor steps.

**Executor risks flagged:** Task 3 Step 6/Task 5 Step 1 depend on e2e history seeded by earlier steps (the finalized "Reviewed lease agreement…" entry) — do not reorder e2e steps. Task 9's focus-retention effect must be the hook-safe DOM version (declared before the early `return null`). If any anchor in `timergrid.js`/`entryeditor.js` is missing at execution time, stop and re-read the file — the tree may have drifted — rather than guessing.
