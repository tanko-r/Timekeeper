# Phase 2 — Memory Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the memory layer from spec §5 — a per-matter phrasebook and a self-building people roster, both derived deterministically from the user's own `entries` / `entry_tasks` history, exposed via two new read endpoints. Backend only; the UI that consumes these lands in Phases 3–4.

**Architecture:** Two pure libraries (`server/lib/phrasebook.js` ranks past fragments/narratives by frequency × recency; `server/lib/people.js` extracts counterparty names from narrative text with deterministic patterns). A new `matter_people` table is a **derived cache**, rebuilt per-matter by `rebuildMatterPeople` (exported from `server/routes/entries.js`, the existing write hub) on every entry write path, and backfilled once from existing history on the first jobs tick after upgrade. A new thin `server/routes/matters.js` router serves `GET /api/matters/:id/suggestions` and `GET /api/matters/:id/people`; a brand-new matter with thin history borrows its client siblings' data (spec §5: "The client entity lets a **brand-new matter borrow its client siblings' phrasebook** so it starts warm").

**Tech Stack:** Node 24 ESM, Express 5, better-sqlite3 (WAL), `node:test`. No build step. No new runtime dependencies.

## Global Constraints

- Spec §5 binding language: both features are "**derived from the user's own `entries` / `entry_tasks` history** — deterministic, private, instant, and smarter the more the app is used. They start cold (test DB) and warm up naturally. New logic is pure functions in `server/lib/*` with unit tests; thin endpoints expose them." Phrasebook = "aggregate past task-line `fragment`s and narratives for a matter, ranked by frequency × recency → the matter's recurring 'moves.'" People roster = "extract counterparty names from narratives via deterministic patterns … as entries are saved, cached in a small `matter_people(matter_id, name, count, last_seen_at)` table, ranked by recency."
- Runtime deps stay exactly `express` + `better-sqlite3`. Do not add any dependency.
- Schema changes = **append** a new migration string as the **NEXT (last) element** of the `MIGRATIONS` array in `server/db.js`. Do NOT hardcode a version number anywhere — the guard is positional (`PRAGMA user_version` vs. array length). At the time of writing, the last element is the v4 client→matter migration; **verify at execution time by looking at the end of the array**, and never mutate an existing migration.
- **Coordination with Phase 1b (running concurrently):** this plan must NOT touch anything under `public/js/` and must NOT modify `server/routes/cms.js`. All edit locations below are given as **content anchors, not line numbers** — the tree will drift before execution; find the anchor text, don't count lines.
- Business logic goes in `server/lib/*` as **pure functions** (no DB, no clock reads) with `node:test` unit tests. Routes stay thin. All server writes go through prepared statements.
- DB-touching helpers follow the existing precedent: they live in the route module that owns the domain and are exported for reuse (like `writeTasks` / `syncNarrative` in `entries.js` and `ensureClient` in `cms.js`).
- Dates are local `YYYY-MM-DD`; box TZ `America/Los_Angeles` (tests set `process.env.TZ`). Durations are decimal hours.
- Tests run with `npm test` (`node --test test/*.test.js`). The **entire suite must be green at the end of every task.**
- No frontend work of any kind in this phase.

### Interface contracts produced by this plan (Phase 3 consumes these)

`GET /api/matters/:id/suggestions` → `200`:

```json
{
  "matter_id": 7,
  "borrowed": false,
  "phrases": [
    { "text": "revise lease", "count": 4, "score": 2.813,
      "last_used": "2026-07-07", "source": "matter" }
  ]
}
```

- `phrases` sorted by `score` desc (score = Σ per-occurrence `weight × 0.5^(ageDays/30)`; matter weight 1, client-borrowed weight 0.25), max 15.
- `source` per phrase: `"matter"` (own history) or `"client"` (borrowed from a client sibling). `borrowed` is true when sibling history was blended in (own ranked phrases < 5 and the client has sibling history).
- `404 { "error": "Matter not found." }` for unknown ids.

`GET /api/matters/:id/people` → `200`:

```json
{
  "matter_id": 7,
  "borrowed": true,
  "people": [
    { "name": "A. Turner", "count": 6, "last_seen": "2026-07-07", "source": "client" }
  ]
}
```

- `people` sorted by `last_seen` desc, then `count` desc. `count` = number of live entries on the matter mentioning the person. `last_seen` is the **entry date** (`YYYY-MM-DD`), not a wall-clock timestamp, so backfilled history ranks correctly.
- Borrowing: when the matter has fewer than 3 own people and belongs to a client with sibling rosters, sibling people are appended (deduped by name, own rows win) with `source: "client"`.

---

### Task 1: `server/lib/people.js` — deterministic counterparty-name extraction

**Files:**
- Create: `server/lib/people.js`
- Test: `test/people.test.js`

**Interfaces:**
- Produces: `extractPeople(text: string|null): string[]` — display-cased names in order of first appearance, deduped case-insensitively within the text. Pure; no DB.

Design decisions baked in (these are the "what's a name vs. a role" rules — keep them documented in code comments):
- **Trigger phrases** introduce a counterparty: `<meeting word> with X` (telephone/video/phone conference, call, meeting, confer, discussion, correspondence, zoom, negotiation, spoke/speak) and `<writing word> to/from X` (email/e-mail, letter, memo, voicemail, message, correspondence).
- **A name** is 1–4 capitalized tokens after the trigger (single-letter initials keep their period: "M. Smith"). Since `\w` never matches `.` or `,`, trailing sentence punctuation is naturally excluded.
- **Roles are not people:** a capture whose lowercased text is a generic role ("opposing counsel", "client", "lender", …) is dropped. Lowercase roles ("with opposing counsel") never capture at all.
- **Possessives are descriptions, not names:** "conference with Sam's counsel" describes someone by relation → dropped entirely.
- Courtesy titles (Mr./Ms./Mrs./Dr.) are consumed but not stored. Connector tokens (Re, Regarding, About, …) cut the capture. A bare single initial ("call with M.") is dropped. `and` / comma lists yield multiple names.

- [ ] **Step 1: Write the failing test**

Create `test/people.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractPeople } from '../server/lib/people.js';

test('extracts name after "telephone conference with"', () => {
  assert.deepEqual(
    extractPeople('Telephone conference with M. Smith regarding lease terms.'),
    ['M. Smith']);
});

test('extracts multiple names joined by "and" and commas', () => {
  assert.deepEqual(
    extractPeople('Email to John Smith and Mary Jones re revised draft'),
    ['John Smith', 'Mary Jones']);
  assert.deepEqual(
    extractPeople('email to A. Foo, B. Bar and C. Baz re closing'),
    ['A. Foo', 'B. Bar', 'C. Baz']);
});

test('generic roles are not people', () => {
  assert.deepEqual(extractPeople('Correspondence with opposing counsel regarding hearing.'), []);
  assert.deepEqual(extractPeople('Call with Opposing Counsel re schedule.'), []);
  assert.deepEqual(extractPeople('meeting with City of Springfield staff'), []);
});

test('possessive captures are descriptions, not names', () => {
  assert.deepEqual(extractPeople("Conference with Sam's counsel re lease."), []);
  assert.deepEqual(extractPeople('Call with Landlord’s broker.'), []);
});

test('trailing punctuation and duration labels never leak into names', () => {
  assert.deepEqual(
    extractPeople('Emails from A. Turner; revise lease (0.3).'),
    ['A. Turner']);
});

test('connector tokens cut the capture', () => {
  assert.deepEqual(
    extractPeople('Meeting with John Smith Re Draft Agreement'),
    ['John Smith']);
});

test('courtesy titles are consumed but not stored', () => {
  assert.deepEqual(extractPeople('Email from Dr. Jones re inspection'), ['Jones']);
});

test('hyphens and apostrophes survive', () => {
  assert.deepEqual(
    extractPeople("Zoom with Sarah O'Brien-Smith re closing checklist"),
    ["Sarah O'Brien-Smith"]);
});

test('dedupes case-insensitively within one text', () => {
  assert.deepEqual(
    extractPeople('Call with John Smith; follow-up call with JOHN SMITH.'),
    ['John Smith']);
});

test('a bare single initial is not a name', () => {
  assert.deepEqual(extractPeople('call with M. re lease'), []);
});

test('no triggers, empty, or non-string input → empty', () => {
  assert.deepEqual(extractPeople('Review lease agreement for renewal terms.'), []);
  assert.deepEqual(extractPeople(''), []);
  assert.deepEqual(extractPeople(null), []);
  assert.deepEqual(extractPeople(undefined), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/people.test.js`
Expected: FAIL — `Cannot find module '../server/lib/people.js'`.

- [ ] **Step 3: Write the implementation**

Create `server/lib/people.js`:

```js
// Deterministic counterparty-name extraction from narrative text (spec §5):
// "telephone conference with M. Smith", "email to John Doe", ...
// Pure functions only — no DB access, no clock. The matter_people cache that
// stores these lives in server/routes/entries.js (rebuildMatterPeople).

// Roles are not people: a capture whose lowercased form is one of these is
// dropped ("Opposing Counsel" describes a role, not a rosterable person).
const GENERIC_ROLES = new Set([
  'opposing counsel', 'counsel', 'co-counsel', 'client', 'clients',
  'opposing', 'counterparty', 'all parties', 'parties', 'team', 'staff',
  'lender', 'borrower', 'landlord', 'tenant', 'seller', 'buyer', 'broker',
  'title company', 'escrow', 'county', 'city', 'the county', 'the city',
]);

// Connector tokens end a name capture ("John Smith Re Draft" → "John Smith").
const CUT_WORDS = new Set(['re', 'regarding', 'about', 'concerning', 'and', 'for', 'on']);

// Trigger phrases that introduce a counterparty. Two families:
//   <meeting word> with X     (telephone conference with, call with, ...)
//   <writing word> to/from X  (email to, letter from, ...)
const TRIGGERS = /\b(?:(?:(?:telephone|video|phone)\s+)?(?:conference|conferences|call|calls|meeting|meetings|meet|confer|discussion|discussions|correspondence|correspond|zoom|negotiation|negotiations|negotiate|spoke|speak)\s+with|(?:e-?mail|e-?mails|letter|letters|memo|memos|voicemail|voicemails|message|messages|correspondence)\s+(?:to|from))\s+/gi;

// A name: optional courtesy title (consumed, not captured), then 1–4
// capitalized tokens; single-letter initials keep their period ("M. Smith").
// \w never matches "." or ",", so trailing sentence punctuation is excluded.
const NAME = /^(?:(?:Mr|Ms|Mrs|Dr)\.?\s+)?((?:[A-Z]\.|[A-Z][\w'’-]+)(?:\s+(?:[A-Z]\.|[A-Z][\w'’-]+)){0,3})/;

const POSSESSIVE = /['’]s$/i;
const SINGLE_INITIAL = /^[A-Z]\.$/;

export function extractPeople(text) {
  const s = String(text ?? '');
  const found = [];
  const seen = new Set();
  TRIGGERS.lastIndex = 0; // module-level /g regex is stateful — always reset
  let m;
  while ((m = TRIGGERS.exec(s)) !== null) {
    let rest = s.slice(TRIGGERS.lastIndex);
    // one trigger can introduce a list: "with A. Foo, B. Bar and C. Baz"
    for (;;) {
      const nm = NAME.exec(rest);
      if (!nm) break;
      const name = cleanName(nm[1]);
      if (name) {
        const key = name.toLowerCase();
        if (!seen.has(key)) { seen.add(key); found.push(name); }
      }
      const after = rest.slice(nm[0].length);
      const joiner = /^(?:\s*,)?\s+and\s+/i.exec(after) || /^\s*,\s*/.exec(after);
      if (!joiner) break;
      rest = after.slice(joiner[0].length);
    }
  }
  return found;
}

function cleanName(raw) {
  let words = raw.trim().split(/\s+/);
  const cut = words.findIndex((w) => CUT_WORDS.has(w.toLowerCase()));
  if (cut !== -1) words = words.slice(0, cut);
  if (words.length === 0) return null;
  // "Sam's counsel" describes someone by relation — not a name
  if (words.some((w) => POSSESSIVE.test(w))) return null;
  // a bare initial ("call with M.") carries no identity
  if (words.length === 1 && SINGLE_INITIAL.test(words[0])) return null;
  const name = words.join(' ');
  if (GENERIC_ROLES.has(name.toLowerCase())) return null;
  return name;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/people.test.js`
Expected: PASS (11 tests).

- [ ] **Step 5: Run the full suite, then commit**

Run: `npm test`
Expected: PASS — all suites green.

```bash
git add server/lib/people.js test/people.test.js
git commit -m "feat(lib): deterministic counterparty-name extraction (people.js)"
```

---

### Task 2: `server/lib/phrasebook.js` — frequency × recency phrase ranking

**Files:**
- Create: `server/lib/phrasebook.js`
- Test: `test/phrasebook.test.js`

**Interfaces:**
- Produces:
  - `normalizePhrase(text): string` — collapse whitespace, trim, strip trailing `.;,:`.
  - `rankPhrases(occurrences, { today, halfLifeDays = 30, minLength = 3, limit = 15, weights = { matter: 1, client: 0.25 } })` where `occurrences` is `[{ text, date: 'YYYY-MM-DD', source?: 'matter'|'client' }]` (missing `source` = `'matter'`). Returns `[{ text, count, score, last_used, source }]` sorted by score desc. Pure; the caller (Task 5's router) fetches DB rows and passes them in.

Ranking rules (document in code comments):
- Grouped case-insensitively; display text is the most recent occurrence's casing.
- Per `(source, phrase, date)` dedupe: the same phrase on the same day counts once — guards against a narrative mirroring its own fragment and against timer re-syncs.
- `score = Σ weight(source) × 0.5^(ageDays / halfLifeDays)` — frequency × recency in one number; client-borrowed occurrences weigh 0.25.
- A phrase's `source` is `'matter'` if it has any own-matter occurrence, else `'client'` (the borrowed flag Phase 3 renders differently).

- [ ] **Step 1: Write the failing test**

Create `test/phrasebook.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePhrase, rankPhrases } from '../server/lib/phrasebook.js';

test('normalizePhrase trims, collapses whitespace, strips trailing punctuation', () => {
  assert.equal(normalizePhrase('  revise   lease.  '), 'revise lease');
  assert.equal(normalizePhrase('draft email to landlord;'), 'draft email to landlord');
  assert.equal(normalizePhrase(null), '');
});

test('frequency wins between same-age phrases', () => {
  const out = rankPhrases([
    { text: 'revise lease', date: '2026-07-07' },
    { text: 'revise lease', date: '2026-07-06' },
    { text: 'draft access agreement', date: '2026-07-07' },
  ], { today: '2026-07-08' });
  assert.deepEqual(out.map((p) => p.text), ['revise lease', 'draft access agreement']);
  assert.equal(out[0].count, 2);
  assert.equal(out[0].last_used, '2026-07-07');
  assert.equal(out[0].source, 'matter');
  assert.ok(out[0].score > out[1].score);
});

test('recency beats a slightly higher stale count', () => {
  const out = rankPhrases([
    { text: 'old workhorse', date: '2025-01-01' },
    { text: 'old workhorse', date: '2025-01-02' },
    { text: 'old workhorse', date: '2025-01-03' },
    { text: 'fresh phrase', date: '2026-07-07' },
    { text: 'fresh phrase', date: '2026-07-06' },
  ], { today: '2026-07-08' });
  // three ~18-month-old uses decay to ~0; two this-week uses win
  assert.equal(out[0].text, 'fresh phrase');
});

test('same phrase on the same day counts once', () => {
  const out = rankPhrases([
    { text: 'revise lease', date: '2026-07-07' },
    { text: 'Revise lease.', date: '2026-07-07' },
  ], { today: '2026-07-08' });
  assert.equal(out.length, 1);
  assert.equal(out[0].count, 1);
});

test('case-insensitive grouping keeps the most recent casing', () => {
  const out = rankPhrases([
    { text: 'telephone conference with client', date: '2026-07-01' },
    { text: 'Telephone conference with client', date: '2026-07-07' },
  ], { today: '2026-07-08' });
  assert.equal(out.length, 1);
  assert.equal(out[0].text, 'Telephone conference with client');
  assert.equal(out[0].count, 2);
});

test('client-borrowed occurrences weigh less and are flagged', () => {
  const out = rankPhrases([
    { text: 'sibling phrase', date: '2026-07-07', source: 'client' },
    { text: 'own phrase', date: '2026-07-07', source: 'matter' },
  ], { today: '2026-07-08' });
  assert.equal(out[0].text, 'own phrase'); // weight 1.0 beats 0.25
  assert.equal(out[0].source, 'matter');
  assert.equal(out[1].source, 'client');
  assert.ok(out[1].score < out[0].score);
});

test('short scraps filtered, default limit 15, empty input ok', () => {
  const many = [];
  for (let i = 0; i < 20; i++) many.push({ text: `phrase number ${i}`, date: '2026-07-07' });
  const out = rankPhrases(many.concat([{ text: 'ok', date: '2026-07-07' }]),
    { today: '2026-07-08' });
  assert.equal(out.length, 15);
  assert.ok(!out.some((p) => p.text === 'ok')); // length 2 < minLength 3
  assert.deepEqual(rankPhrases([], { today: '2026-07-08' }), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/phrasebook.test.js`
Expected: FAIL — `Cannot find module '../server/lib/phrasebook.js'`.

- [ ] **Step 3: Write the implementation**

Create `server/lib/phrasebook.js`:

```js
// Per-matter phrasebook (spec §5): rank past task-line fragments and free
// narratives by frequency × recency → the matter's recurring "moves".
// Pure — callers fetch rows from the DB and pass them in.

const DAY_MS = 86_400_000;

export function normalizePhrase(text) {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.;,:\s]+$/, '');
}

// occurrences: [{ text, date: 'YYYY-MM-DD', source?: 'matter'|'client' }]
// Returns [{ text, count, score, last_used, source }] sorted by score desc.
// - grouped case-insensitively; display text = most recent occurrence's casing
// - per (source, phrase, date) dedupe: same phrase same day counts once
//   (guards against narrative-mirrors-fragment and timer re-syncs)
// - score = Σ weight(source) × 0.5^(ageDays / halfLifeDays)
// - source: 'matter' if the phrase has any own-matter occurrence, else
//   'client' — the borrowed flag consumers render differently
export function rankPhrases(occurrences, {
  today,
  halfLifeDays = 30,
  minLength = 3,
  limit = 15,
  weights = { matter: 1, client: 0.25 },
} = {}) {
  const todayMs = Date.parse(`${today}T00:00:00Z`);
  const groups = new Map();
  for (const occ of occurrences || []) {
    const text = normalizePhrase(occ.text);
    if (text.length < minLength) continue;
    const key = text.toLowerCase();
    let g = groups.get(key);
    if (!g) {
      g = { text, count: 0, score: 0, last_used: '', source: 'client', days: new Set() };
      groups.set(key, g);
    }
    const source = occ.source === 'client' ? 'client' : 'matter';
    const dayKey = `${source}|${occ.date}`;
    if (g.days.has(dayKey)) continue;
    g.days.add(dayKey);
    const ageDays = Math.max(0, (todayMs - Date.parse(`${occ.date}T00:00:00Z`)) / DAY_MS);
    g.count += 1;
    g.score += (weights[source] ?? 1) * Math.pow(0.5, ageDays / halfLifeDays);
    if (occ.date >= g.last_used) { g.last_used = occ.date; g.text = text; }
    if (source === 'matter') g.source = 'matter';
  }
  return [...groups.values()]
    .sort((a, b) => b.score - a.score || b.count - a.count || a.text.localeCompare(b.text))
    .slice(0, limit)
    .map(({ days, ...g }) => ({ ...g, score: Math.round(g.score * 1000) / 1000 }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/phrasebook.test.js`
Expected: PASS (7 tests).

- [ ] **Step 5: Run the full suite, then commit**

Run: `npm test`
Expected: PASS — all suites green.

```bash
git add server/lib/phrasebook.js test/phrasebook.test.js
git commit -m "feat(lib): phrasebook ranking — frequency x recency with client-borrow weights"
```

---

### Task 3: `matter_people` migration + roster rebuild on every entry write

**Files:**
- Modify: `server/db.js` (append the NEXT migration to `MIGRATIONS` — do NOT touch existing elements)
- Modify: `server/routes/entries.js` (add `rebuildMatterPeople` + hook all write paths)
- Modify: `server/routes/timers.js` (hook `syncToEntry`)
- Test: `test/db.test.js` (migration assertions), `test/api.entries.test.js` (roster maintenance)

**Interfaces:**
- Consumes: `extractPeople` from `server/lib/people.js` (Task 1).
- Produces:
  - Table `matter_people(id, matter_id → matters(id) ON DELETE CASCADE, name, count, last_seen_at, UNIQUE(matter_id, name))`. `last_seen_at` stores the **entry date** (`YYYY-MM-DD`).
  - `rebuildMatterPeople(db, matterId): void` exported from `server/routes/entries.js` — full derived-cache rebuild for one matter; idempotent; safe inside outer transactions (better-sqlite3 nests via savepoints). Tasks 4–6 rely on this exact name.

Design decision — **rebuild, not increment:** `matter_people` is a derived cache. Every write that can change a matter's narratives (create, edit, move, copy, delete, restore, timer sync) triggers a full per-matter rescan. This makes edits/moves/deletes exactly correct with zero bookkeeping, and a per-matter scan is trivially cheap in a single-user DB. Extraction runs on `narrative` **plus** all task `fragment`s per entry, deduped per entry, so `count` = number of live entries mentioning the person.

- [ ] **Step 1: Write the failing migration tests**

Add to the end of `test/db.test.js`:

```js
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
  // fake a db from just before this migration: drop the new table and roll
  // user_version back by one (positional — no hardcoded version numbers)
  const v = db1.pragma('user_version', { simple: true });
  db1.exec('DROP TABLE matter_people');
  db1.pragma(`user_version = ${v - 1}`);
  db1.close();
  const db2 = openDb(path);
  assert.ok(db2.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='matter_people'").get());
  db2.close();
  cleanup();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/db.test.js`
Expected: FAIL — the two new tests error (`no such table: matter_people`); all pre-existing tests still pass.

- [ ] **Step 3: Append the migration**

In `server/db.js`, append a new element at the **end** of the `MIGRATIONS` array — i.e. after the last existing migration string (at time of writing that is the one commented `// v4 — client → matter split…`; verify it is still last) and immediately before the closing `];`:

```js
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
```

Run: `node --test test/db.test.js` — Expected: PASS.

- [ ] **Step 4: Write the failing roster-maintenance tests**

Add to the end of `test/api.entries.test.js` (it already defines `withServer(fn)` that passes `(t, cm, nb)` — two matters under client `100001`):

```js
test('entry writes maintain the matter people roster', () =>
  withServer(async (t, cm) => {
    const created = (await t.fetchJson('POST', '/api/entries', {
      date: '2026-07-06', cm_id: cm.id,
      narrative: 'Telephone conference with M. Smith regarding lease terms.',
      tasks: [{ task_code: 'Call/Conference', duration: 0.5, fragment: '' }],
    })).body;
    const roster = () => t.db.prepare(
      'SELECT name, count, last_seen_at FROM matter_people WHERE matter_id=? ORDER BY name'
    ).all(cm.id);
    assert.deepEqual(roster(), [{ name: 'M. Smith', count: 1, last_seen_at: '2026-07-06' }]);

    // a second entry mentioning the same person bumps count and recency
    await t.fetchJson('POST', '/api/entries', {
      date: '2026-07-07', cm_id: cm.id,
      narrative: 'Email to M. Smith re revised legal description.',
      tasks: [{ task_code: 'Correspondence', duration: 0.2, fragment: '' }],
    });
    assert.deepEqual(roster(), [{ name: 'M. Smith', count: 2, last_seen_at: '2026-07-07' }]);

    // editing the mention away rebuilds — derived cache, not append-only
    await t.fetchJson('PATCH', `/api/entries/${created.id}`, {
      narrative: 'Review lease exhibit.',
    });
    assert.deepEqual(roster(), [{ name: 'M. Smith', count: 1, last_seen_at: '2026-07-07' }]);
  }));

test('moving or deleting an entry re-attributes its people', () =>
  withServer(async (t, cm, nb) => {
    const e = (await t.fetchJson('POST', '/api/entries', {
      date: '2026-07-06', cm_id: cm.id,
      narrative: 'Call with A. Turner re loading dock lease.',
      tasks: [{ task_code: 'Call/Conference', duration: 0.3, fragment: '' }],
    })).body;
    const count = (matterId) => t.db.prepare(
      'SELECT COUNT(*) c FROM matter_people WHERE matter_id=?').get(matterId).c;

    // move to the other matter → roster follows
    await t.fetchJson('PATCH', `/api/entries/${e.id}`, { cm_id: nb.id });
    assert.equal(count(cm.id), 0);
    assert.equal(t.db.prepare(
      'SELECT name FROM matter_people WHERE matter_id=?').get(nb.id).name, 'A. Turner');

    // soft delete → roster empties; restore → it returns
    await t.fetchJson('DELETE', `/api/entries/${e.id}`);
    assert.equal(count(nb.id), 0);
    await t.fetchJson('POST', `/api/entries/${e.id}/restore`);
    assert.equal(count(nb.id), 1);
  }));

test('names in task fragments count too, once per entry', () =>
  withServer(async (t, cm) => {
    await t.fetchJson('POST', '/api/entries', {
      date: '2026-07-06', cm_id: cm.id,
      tasks: [
        { task_code: 'Call/Conference', duration: 0.4, fragment: 'telephone conference with B. Novak re access road' },
        { task_code: 'Correspondence', duration: 0.2, fragment: 'email to B. Novak re same' },
      ],
    });
    const rows = t.db.prepare(
      'SELECT name, count FROM matter_people WHERE matter_id=?').all(cm.id);
    assert.deepEqual(rows, [{ name: 'B. Novak', count: 1 }]); // per-entry dedupe
  }));
```

Run: `node --test test/api.entries.test.js` — Expected: the three new tests FAIL (`matter_people` stays empty); existing tests pass.

- [ ] **Step 5: Add `rebuildMatterPeople` to `server/routes/entries.js`**

Add the import at the top of `server/routes/entries.js`, after the existing line `import { validateEntry, canFinalize } from '../lib/validation.js';`:

```js
import { extractPeople } from '../lib/people.js';
```

Add this exported function directly below the existing `touchCm` function:

```js
// matter_people is a DERIVED CACHE: rebuild the whole roster for one matter
// from its live (non-deleted) entries. Idempotent — safe to call on every
// write, edit, move, copy, delete, and restore; a per-matter scan is cheap in
// a single-user DB and makes edits exactly correct with zero bookkeeping.
// Names come from the narrative plus all task fragments, deduped per entry,
// so count = number of live entries mentioning the person. last_seen_at
// stores the entry DATE (local YYYY-MM-DD), not a wall clock, so backfilled
// history ranks correctly by recency. Safe inside an outer db.transaction
// (better-sqlite3 nests transactions via savepoints).
export function rebuildMatterPeople(db, matterId) {
  const rows = db.prepare(`
    SELECT e.date, e.narrative,
      (SELECT group_concat(t.fragment, char(10)) FROM entry_tasks t WHERE t.entry_id = e.id) AS fragments
    FROM entries e WHERE e.cm_id = ? AND e.deleted_at IS NULL
  `).all(matterId);
  const agg = new Map(); // lower-cased name → { name, count, last }
  for (const row of rows) {
    for (const name of extractPeople(`${row.narrative}\n${row.fragments || ''}`)) {
      const key = name.toLowerCase();
      const cur = agg.get(key);
      if (!cur) {
        agg.set(key, { name, count: 1, last: row.date });
      } else {
        cur.count += 1;
        if (row.date >= cur.last) { cur.last = row.date; cur.name = name; }
      }
    }
  }
  db.transaction(() => {
    db.prepare('DELETE FROM matter_people WHERE matter_id=?').run(matterId);
    const ins = db.prepare(
      'INSERT INTO matter_people (matter_id, name, count, last_seen_at) VALUES (?, ?, ?, ?)');
    for (const p of agg.values()) ins.run(matterId, p.name, p.count, p.last);
  })();
}
```

(`extractPeople` already dedupes within one text, so joining narrative + fragments into one string gives the per-entry dedupe.)

- [ ] **Step 6: Hook every entry write path**

All in `server/routes/entries.js`, located by content anchor:

1. **POST `/`** — inside the `db.transaction(() => { ... })` block of `r.post('/', ...)`, immediately after the line `touchCm(db, cm.id, now());`:

```js
      rebuildMatterPeople(db, cm.id);
```

2. **PATCH `/:id`** — inside its `db.transaction(() => { ... })` block, immediately after the line `recordAudit(db, row, req.body, now());`:

```js
      rebuildMatterPeople(db, cmId);
      if (cmId !== row.cm_id) rebuildMatterPeople(db, row.cm_id);
```

3. **POST `/bulk` `set_cm` case** — inside the `case 'set_cm':` transaction, immediately after the line `recordAudit(db, row, { cm_id }, now());`:

```js
              rebuildMatterPeople(db, cm_id);
              if (cm_id !== row.cm_id) rebuildMatterPeople(db, row.cm_id);
```

4. **`softDeleteEntry`** — inside its `db.transaction(() => { ... })`, as the last statement (after the `if (row.ever_finalized) { ... }` audit block):

```js
    rebuildMatterPeople(db, row.cm_id);
```

5. **`restoreEntry`** — same placement, last statement inside its transaction:

```js
    rebuildMatterPeople(db, row.cm_id);
```

(These two helpers also serve the `/bulk` delete/restore actions and `DELETE /:id` / `POST /:id/restore`, so hooking them once covers all four routes.)

6. **POST `/:id/copy`** — inside its transaction, immediately after `touchCm(db, src.cm_id, now());`:

```js
      rebuildMatterPeople(db, src.cm_id);
```

Then in `server/routes/timers.js`, extend the existing import from `./entries.js` (anchor: `import { loadEntry, syncNarrative } from './entries.js';`) to:

```js
import { loadEntry, syncNarrative, rebuildMatterPeople } from './entries.js';
```

and inside `syncToEntry`'s `db.transaction(() => { ... })` block, immediately after the line `db.prepare('UPDATE matters SET last_used_at=? WHERE id=?').run(nowIso, timer.cm_id);`:

```js
    rebuildMatterPeople(db, timer.cm_id);
```

(Timer syncs rarely change names — they regenerate narratives with new duration labels — but this one line keeps the invariant "roster always reflects live entries" airtight, including midnight rollovers.)

- [ ] **Step 7: Run the tests, then the full suite**

Run: `node --test test/api.entries.test.js test/db.test.js`
Expected: PASS.

Run: `npm test`
Expected: PASS — all suites green (timer and jobs suites exercise `syncToEntry`'s new hook).

- [ ] **Step 8: Commit**

```bash
git add server/db.js server/routes/entries.js server/routes/timers.js test/db.test.js test/api.entries.test.js
git commit -m "feat(db): matter_people roster cache — migration + rebuild on entry writes"
```

---

### Task 4: One-time roster backfill on the first jobs tick

**Files:**
- Modify: `server/jobs.js`
- Test: `test/jobs.test.js`

**Interfaces:**
- Consumes: `rebuildMatterPeople(db, matterId)` from `server/routes/entries.js` (Task 3); `getSetting`/`setSetting` from `server/db.js`.
- Produces: `jobs_state.peopleBackfillDone: true` after the first tick.

Design decision — **backfill on first run, not in the migration:** the migration is a pure SQL string and cannot run the JS name extractor, so David's existing history is derived on the first `runJobs` tick after upgrade (jobs run at server start and every 30s — `startJobs` calls `tick()` immediately). A flag in the existing `jobs_state` setting makes it run exactly once; the rebuild itself is idempotent, so a crash mid-backfill just retries next tick.

- [ ] **Step 1: Write the failing test**

Add to the end of `test/jobs.test.js` (it already defines `setup()` — matter id 1 exists — and `at(iso)`):

```js
test('first jobs tick backfills matter_people from existing entries', () => {
  const { db, config, cleanup } = setup();
  try {
    // rows written before the memory layer existed → no roster yet
    db.prepare(`INSERT INTO entries (date, cm_id, narrative, billable, status, source)
      VALUES ('2026-07-01', 1, 'Telephone conference with B. Novak regarding access road.', 1, 'draft', 'manual')`).run();
    assert.equal(db.prepare('SELECT COUNT(*) c FROM matter_people').get().c, 0);

    runJobs({ db, config, clock: at('2026-07-06T08:00:00-07:00') });
    assert.deepEqual(
      db.prepare('SELECT matter_id, name, count, last_seen_at FROM matter_people').all(),
      [{ matter_id: 1, name: 'B. Novak', count: 1, last_seen_at: '2026-07-01' }]);

    // second tick is a no-op (flag set), not a duplicate or reset
    runJobs({ db, config, clock: at('2026-07-06T09:00:00-07:00') });
    assert.equal(db.prepare('SELECT COUNT(*) c FROM matter_people').get().c, 1);
  } finally { cleanup(); }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/jobs.test.js`
Expected: the new test FAILS (`matter_people` stays empty after the tick); existing tests pass.

- [ ] **Step 3: Implement the backfill**

In `server/jobs.js`, add the import after the existing line `import { applyRollovers } from './routes/timers.js';`:

```js
import { rebuildMatterPeople } from './routes/entries.js';
```

Inside `runJobs`, insert this block after the nightly-backup `if (state.lastBackupDate !== today) { ... }` block and before the purge statements:

```js
  // One-time (per upgrade) roster backfill: matter_people arrived with the
  // memory-layer migration, but SQL migrations can't run the JS name
  // extractor — so the first tick derives the roster from all existing
  // entries. Re-read jobs_state at write time: the backup block above may
  // have just updated it.
  if (!state.peopleBackfillDone) {
    const matterIds = db.prepare(
      'SELECT DISTINCT cm_id FROM entries WHERE deleted_at IS NULL').all();
    for (const { cm_id } of matterIds) rebuildMatterPeople(db, cm_id);
    setSetting(db, 'jobs_state',
      { ...(getSetting(db, 'jobs_state') || {}), peopleBackfillDone: true });
  }
```

- [ ] **Step 4: Run test to verify it passes, then the full suite**

Run: `node --test test/jobs.test.js`
Expected: PASS (5 tests — the 4 existing ones must stay green; the backfill is a harmless no-op for their data).

Run: `npm test`
Expected: PASS — all suites green.

- [ ] **Step 5: Commit**

```bash
git add server/jobs.js test/jobs.test.js
git commit -m "feat(jobs): one-time matter_people backfill from existing entries"
```

---

### Task 5: `/api/matters/:id/suggestions` + `/api/matters/:id/people` endpoints

**Files:**
- Create: `server/routes/matters.js`
- Modify: `server/app.js` (import + mount at `/api/matters`)
- Test: `test/api.matters.test.js`

**Interfaces:**
- Consumes: `rankPhrases` from `server/lib/phrasebook.js` (Task 2); `matter_people` table (Task 3); `todayLocal` from `server/lib/dates.js`; `deps = { db, clock }` (same shape as every other router).
- Produces: `mattersRouter(deps)` serving the two endpoints with the exact response shapes in Global Constraints ("Interface contracts"). This is a **new** router — it does not touch `server/routes/cms.js` or the `/api/cms` paths, so it cannot collide with the concurrent Phase 1b work.

Design decisions:
- **What counts as a phrase:** every non-blank task-line `fragment`, plus the `narrative` of entries with fewer than 2 substantive task lines (mirroring `narrative_auto` in `entries.js`) — auto-generated multi-line narratives are joins of their own fragments and would double-count, so they are excluded in SQL.
- **Thin-history borrowing (resolves the spec's open question):** per-matter first; when the matter's own ranked phrases number fewer than 5 (or own people fewer than 3) and the matter belongs to a client with sibling history, sibling occurrences are blended in at 0.25 weight (phrases) or appended after own rows (people), flagged `source: 'client'`, and the response sets `borrowed: true`.

- [ ] **Step 1: Write the failing test**

Create `test/api.matters.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

async function withServer(fn) {
  const t = await startTestServer();
  try { await fn(t); } finally { await t.close(); }
}

// Two matters under one client + one matter under a different client.
async function seed(t) {
  const warm = (await t.fetchJson('POST', '/api/cms',
    { cm_number: '100001-000012', short_name: 'Cedar Lease' })).body;
  const cold = (await t.fetchJson('POST', '/api/cms',
    { cm_number: '100001-000099', short_name: 'New sibling' })).body;
  const other = (await t.fetchJson('POST', '/api/cms',
    { cm_number: '100005-000001', short_name: 'Unrelated client matter' })).body;
  return { warm, cold, other };
}

test('suggestions: ranked own fragments; generated narratives not double-counted', () =>
  withServer(async (t) => {
    const { warm } = await seed(t);
    await t.fetchJson('POST', '/api/entries', {
      date: '2026-07-01', cm_id: warm.id,
      tasks: [
        { task_code: 'Revise', duration: 0.5, fragment: 'revise lease' },
        { task_code: 'Draft', duration: 0.3, fragment: 'draft access agreement' },
      ],
    });
    await t.fetchJson('POST', '/api/entries', {
      date: '2026-07-02', cm_id: warm.id,
      tasks: [{ task_code: 'Revise', duration: 0.2, fragment: 'revise lease' }],
    });
    const r = await t.fetchJson('GET', `/api/matters/${warm.id}/suggestions`);
    assert.equal(r.status, 200);
    assert.equal(r.body.matter_id, warm.id);
    assert.equal(r.body.borrowed, false);
    const texts = r.body.phrases.map((p) => p.text);
    assert.equal(texts[0], 'revise lease'); // 2 uses beats 1
    assert.ok(texts.includes('draft access agreement'));
    // the auto-generated combined narrative must not appear as a phrase
    assert.ok(!texts.some((x) => x.includes('(0.5)')));
    const top = r.body.phrases[0];
    assert.equal(top.count, 2);
    assert.equal(top.source, 'matter');
    assert.equal(top.last_used, '2026-07-02');
    assert.ok(top.score > 0);
  }));

test('suggestions: single-line free narratives count as phrases', () =>
  withServer(async (t) => {
    const { warm } = await seed(t);
    await t.fetchJson('POST', '/api/entries', {
      date: '2026-07-03', cm_id: warm.id,
      narrative: 'Review title commitment and survey.',
      tasks: [{ task_code: 'Review', duration: 0.4, fragment: '' }],
    });
    const r = await t.fetchJson('GET', `/api/matters/${warm.id}/suggestions`);
    assert.deepEqual(r.body.phrases.map((p) => p.text),
      ['Review title commitment and survey']);
  }));

test('suggestions: a cold matter borrows client siblings, not strangers', () =>
  withServer(async (t) => {
    const { warm, cold, other } = await seed(t);
    await t.fetchJson('POST', '/api/entries', {
      date: '2026-07-05', cm_id: warm.id,
      tasks: [{ task_code: 'Negotiate', duration: 0.5, fragment: 'negotiate crossing agreement' }],
    });
    await t.fetchJson('POST', '/api/entries', {
      date: '2026-07-05', cm_id: other.id,
      tasks: [{ task_code: 'Draft', duration: 0.5, fragment: 'unrelated stranger fragment' }],
    });
    const r = await t.fetchJson('GET', `/api/matters/${cold.id}/suggestions`);
    assert.equal(r.body.borrowed, true);
    const texts = r.body.phrases.map((p) => p.text);
    assert.ok(texts.includes('negotiate crossing agreement'));
    assert.ok(!texts.includes('unrelated stranger fragment'));
    assert.equal(r.body.phrases.find((p) => p.text === 'negotiate crossing agreement').source, 'client');
  }));

test('people: roster ranked by recency; cold sibling borrows; strangers do not', () =>
  withServer(async (t) => {
    const { warm, cold, other } = await seed(t);
    await t.fetchJson('POST', '/api/entries', {
      date: '2026-07-01', cm_id: warm.id,
      narrative: 'Telephone conference with A. Turner regarding lease.',
      tasks: [{ task_code: 'Call/Conference', duration: 0.3, fragment: '' }],
    });
    await t.fetchJson('POST', '/api/entries', {
      date: '2026-07-05', cm_id: warm.id,
      narrative: 'Email to B. Novak re access road; call with A. Turner re same.',
      tasks: [{ task_code: 'Correspondence', duration: 0.2, fragment: '' }],
    });
    const own = await t.fetchJson('GET', `/api/matters/${warm.id}/people`);
    assert.equal(own.status, 200);
    assert.equal(own.body.borrowed, false);
    assert.deepEqual(
      own.body.people.map((p) => [p.name, p.count, p.last_seen, p.source]),
      [['A. Turner', 2, '2026-07-05', 'matter'],
       ['B. Novak', 1, '2026-07-05', 'matter']]);

    const borrowed = await t.fetchJson('GET', `/api/matters/${cold.id}/people`);
    assert.equal(borrowed.body.borrowed, true);
    assert.deepEqual(borrowed.body.people.map((p) => [p.name, p.source]),
      [['A. Turner', 'client'], ['B. Novak', 'client']]);

    const stranger = await t.fetchJson('GET', `/api/matters/${other.id}/people`);
    assert.equal(stranger.body.borrowed, false);
    assert.deepEqual(stranger.body.people, []);
  }));

test('404 for unknown matter on both endpoints', () =>
  withServer(async (t) => {
    assert.equal((await t.fetchJson('GET', '/api/matters/9999/suggestions')).status, 404);
    assert.equal((await t.fetchJson('GET', '/api/matters/9999/people')).status, 404);
  }));
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/api.matters.test.js`
Expected: FAIL — `/api/matters/...` returns 404 `not_found` (route not mounted), so the first test's `assert.equal(r.status, 200)` fails.

- [ ] **Step 3: Create the router**

Create `server/routes/matters.js`:

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

export function mattersRouter({ db, clock }) {
  const r = Router();
  const getMatter = db.prepare('SELECT id, client_id FROM matters WHERE id=?');

  const ownPhrases = db.prepare(`
    SELECT et.fragment AS text, e.date FROM entry_tasks et
    JOIN entries e ON e.id = et.entry_id
    WHERE e.cm_id = ? AND e.deleted_at IS NULL AND TRIM(et.fragment) != ''
    UNION ALL
    SELECT e.narrative AS text, e.date FROM entries e
    WHERE e.cm_id = ? AND e.deleted_at IS NULL AND ${FREE_NARRATIVE}
  `);

  const siblingPhrases = db.prepare(`
    SELECT et.fragment AS text, e.date FROM entry_tasks et
    JOIN entries e ON e.id = et.entry_id
    JOIN matters m ON m.id = e.cm_id
    WHERE m.client_id = ? AND m.id != ? AND e.deleted_at IS NULL AND TRIM(et.fragment) != ''
    UNION ALL
    SELECT e.narrative AS text, e.date FROM entries e
    JOIN matters m ON m.id = e.cm_id
    WHERE m.client_id = ? AND m.id != ? AND e.deleted_at IS NULL AND ${FREE_NARRATIVE}
  `);

  r.get('/:id/suggestions', (req, res) => {
    const matter = getMatter.get(req.params.id);
    if (!matter) return res.status(404).json({ error: 'Matter not found.' });
    const today = todayLocal(clock());
    const own = ownPhrases.all(matter.id, matter.id)
      .map((o) => ({ ...o, source: 'matter' }));
    let occurrences = own;
    let borrowed = false;
    if (rankPhrases(own, { today }).length < THIN_PHRASES && matter.client_id != null) {
      const sib = siblingPhrases.all(matter.client_id, matter.id, matter.client_id, matter.id)
        .map((o) => ({ ...o, source: 'client' }));
      if (sib.length > 0) { borrowed = true; occurrences = own.concat(sib); }
    }
    res.json({ matter_id: matter.id, borrowed, phrases: rankPhrases(occurrences, { today }) });
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

- [ ] **Step 4: Mount it in `server/app.js`**

Add the import next to the other route imports (anchor: after the line `import { clientsRouter } from './routes/clients.js';`):

```js
import { mattersRouter } from './routes/matters.js';
```

Add the mount (anchor: after the line `app.use('/api/clients', clientsRouter(deps));`):

```js
  app.use('/api/matters', mattersRouter(deps));
```

- [ ] **Step 5: Run test to verify it passes, then the full suite**

Run: `node --test test/api.matters.test.js`
Expected: PASS (5 tests).

Run: `npm test`
Expected: PASS — all suites green.

- [ ] **Step 6: Commit**

```bash
git add server/routes/matters.js server/app.js test/api.matters.test.js
git commit -m "feat(api): /api/matters/:id/suggestions + /people memory endpoints"
```

---

### Task 6: Back up `matter_people`; end-to-end regression

**Files:**
- Modify: `server/routes/backup.js` (add `matter_people` to the JSON dump)
- Test: `test/api.backup.test.js`

**Interfaces:**
- Consumes: `matter_people` table (Task 3).
- Produces: `/api/backup/json` dump additionally carries `matter_people: [...]` (the `.db` backup route needs nothing — `VACUUM INTO` copies every table).

- [ ] **Step 1: Write the failing test**

In `test/api.backup.test.js`, inside the existing JSON-dump test, add one assertion next to the existing `matters` assertion (anchor: the line asserting `json.body.matters.length`):

```js
    assert.ok(Array.isArray(json.body.matter_people), 'dump must include matter_people');
```

Run: `node --test test/api.backup.test.js`
Expected: FAIL — `matter_people` is `undefined` in the dump.

- [ ] **Step 2: Add the table to the dump**

In `server/routes/backup.js`, inside the `dump` object literal in the `/backup/json` handler, add one line immediately after the `matters:` line (anchor: `matters: db.prepare('SELECT * FROM matters ORDER BY id').all(),`):

```js
      matter_people: db.prepare('SELECT * FROM matter_people ORDER BY matter_id, id').all(),
```

- [ ] **Step 3: Run test to verify it passes**

Run: `node --test test/api.backup.test.js`
Expected: PASS.

- [ ] **Step 4: Full suite + E2E smoke regression**

Run: `npm test`
Expected: PASS — all suites green.

Run: `node scripts/e2e-smoke.mjs`
Expected: all steps pass, zero `problems` — this phase adds server-side tables/endpoints only and changes no existing payload shape, so every existing frontend flow is untouched. (Note: Phase 1b may be landing concurrently; if the smoke test fails, first check `git log` for whether the failure is in Phase 1b's territory — `public/js/*` / picker — before assuming this phase broke it.)

- [ ] **Step 5: Commit**

```bash
git add server/routes/backup.js test/api.backup.test.js
git commit -m "feat(backup): include matter_people in JSON dump"
```

---

## Self-Review

**Spec coverage (Phase 2 = spec §5, exactly):**
- Per-matter phrasebook as pure functions in `server/lib/phrasebook.js`, aggregating past task-line `fragment`s and narratives, ranked by frequency × recency → Tasks 2 + 5. ✓
- Brand-new matter borrows its client siblings' phrasebook (controller's resolution: per-matter first, blend siblings when own history is thin) → Task 5 (`THIN_PHRASES`, 0.25 weight, `source`/`borrowed` flags). ✓
- `GET /api/matters/:id/suggestions` thin route with documented response shape carrying text, score, count, last-used, and matter/client-borrowed flag (feeds Phase 3 ghost-text + chips + suggested-on-start) → Task 5 + "Interface contracts". ✓
- Self-building people roster: deterministic extraction (`server/lib/people.js`) of counterparty names via "telephone conference with X", "email to/from X", "correspondence with X", "call with X", "conference with X" and similar → Task 1; cached in `matter_people(matter_id, name, count, last_seen_at)` via an appended migration → Task 3; extraction runs as entries are saved/updated (all write paths incl. timers hooked) → Task 3; backfill of existing entries on first run, justified (SQL migrations can't run JS) → Task 4; ranked by recency → Tasks 3 + 5; `GET /api/matters/:id/people` with client-sibling warm start → Task 5. ✓
- Name-vs-role decisions documented (possessives, trailing punctuation, multi-word names, generic "opposing counsel"-style roles) → Task 1 header + tests. ✓
- Backup dump gains the new table → Task 6. ✓
- Tests: unit (ranking + extraction edge cases), API (both endpoints incl. 404s + borrowing), migration (columns, UNIQUE, cascade, replay-on-old-db) → Tasks 1–6. ✓
- Conventions: pure lib functions, thin routes, prepared statements, deps unchanged, append-only positional migration, `npm test` green per task. ✓
- Coordination: no `public/js/*` file appears anywhere in this plan; `server/routes/cms.js` is never modified (the new endpoints live in a new `matters.js` router); all edits cite content anchors; the migration is "append the NEXT element", verified positionally. ✓

**Placeholder scan:** No TBD/TODO/"handle edge cases"; every code step contains complete, runnable code; every test step has the actual test code; every run step states the expected outcome.

**Type consistency:** `extractPeople(text): string[]` — defined Task 1, consumed Task 3 with that exact signature. `rankPhrases(occurrences, { today, ... })` and its `{ text, count, score, last_used, source }` output — defined Task 2, consumed Task 5, mirrored in Task 5's test assertions and the interface contract. `rebuildMatterPeople(db, matterId)` — defined Task 3 (`entries.js`), imported by `timers.js` (Task 3) and `jobs.js` (Task 4) under the same name/signature. `matter_people` column set (`id, matter_id, name, count, last_seen_at`) consistent across migration (Task 3), rebuild insert (Task 3), backfill test (Task 4), people queries (Task 5), and dump (Task 6). `last_seen_at` = entry date everywhere; the people endpoint aliases it to `last_seen` in the response, and both the contract and tests use `last_seen`.

**Risk noted for the executor:** Task 3 touches `server/routes/entries.js` and `server/routes/timers.js`, which Phase 1b does not own but which sit near recently-migrated SQL. All anchors were verified against the current tree (post-Phase-1a); if an anchor is missing at execution time, stop and re-read the file rather than guessing.
