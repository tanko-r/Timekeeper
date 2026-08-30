# Entity-Aware Ghost Text Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ghost text that completes the documents, organisations and people a matter has actually seen — "review and analyze " completes to a document name, "email with " completes to a person — from a deterministic index the attorney can correct in Settings.

**Architecture:** One new table (`matter_entities`) holding all three kinds, derived and hand-added, matter-scoped or global. A pure extractor (`server/lib/entities.js`) mines documents and organisations out of narrative text; people come from the existing `extractPeople`. One rebuild pass writes both caches on every entry write, as an **upsert** so hand edits survive. The existing `/api/matters/:id/suggestions` grows two fields. `ghostCompletion` gains a second tier under its existing whole-phrase matcher, reached through the options argument so every current caller is untouched. A `↓` candidate list and a Settings → Dictionary page sit on top.

**Tech Stack:** Node 24 ESM, Express 5, better-sqlite3 (migration v18), node:test, no-build React 18 UMD + htm.

**Spec:** `docs/superpowers/specs/2026-08-30-entity-ghost-text-design.md` — read it first, and read the ⚠️ assumptions before changing any behaviour it describes.

## Global Constraints

- Runtime deps stay exactly `express` + `better-sqlite3`. No bundler, no new dependency.
- Schema changes = append a migration to `MIGRATIONS` in `server/db.js`; never mutate an old one. This plan appends **v18** (index 17 in the array, after the v17 `ai_draft` entry).
- Business rules are pure functions in `server/lib/*` with unit tests. Routes stay thin. All writes go through prepared statements.
- TDD, every task: failing test first, watch it fail, minimal implementation, watch it pass, commit.
- `npm test` (node:test) must be green before every commit. `node scripts/e2e-smoke.mjs` when the change touches UI or request flow.
- Dates are local-time `YYYY-MM-DD` strings. `last_seen_at` stores an **entry date**, never a wall clock.
- **Never** put a real client, matter, firm or person name in code, tests, comments or commit messages. Use Acme, Cedar Lease, A. Turner, M. Smith.
- After changing `server/**`: `systemctl --user restart timekeeper`.
- After changing any `public/js/**` or `public/css/*.css`: bump `CACHE` in `public/sw.js`. Do it **once per stage**, in that stage's last UI task — not in every task.
- One atomic commit per task, pushed as you go. Commit body says what broke or was missing, what the change does, which files and why, and the test results actually observed.

## Stage map

**Stage A (Tasks 1–7)** ships working predictions with no way to edit them. It is a complete, useful feature on its own — stop here, live with it for a day, and let what annoys you shape Stage B.

**Stage B (Tasks 8–10)** adds the Settings dictionary and the ship-out. The v18 migration in Task 1 already carries every column Stage B needs, and the rebuild in Task 4 is already written as the upsert Stage B depends on. This is deliberate: doing it the easy way first would mean rewriting the rebuild later, and a rebuild that forgets a flag silently eats the attorney's corrections.

---

### Task 1: Migration v18 — the `matter_entities` table

**Files:**
- Modify: `server/db.js` (append one entry to `MIGRATIONS`)
- Test: `test/db.test.js` (append)

**Interfaces:**
- Produces: table `matter_entities` with columns `id, matter_id, name, derived_name, kind, count, last_seen_at, origin, hidden, locked`. Every later task reads and writes exactly these names.

- [ ] **Step 1: Write the failing test**

Append to `test/db.test.js`. It already imports `openDb`, `test` and `assert` — reuse them.

```js
test('v18 matter_entities: kinds constrained, global rows unique, matter rows cascade', () => {
  const db = openDb(':memory:');
  const clientId = db.prepare("INSERT INTO clients (client_number) VALUES ('100001')").run().lastInsertRowid;
  const matterId = db.prepare(
    "INSERT INTO matters (cm_number, client_id, matter_number) VALUES ('100001-000012', ?, '000012')"
  ).run(clientId).lastInsertRowid;

  const ins = db.prepare(
    'INSERT INTO matter_entities (matter_id, name, kind, count, last_seen_at) VALUES (?, ?, ?, ?, ?)');
  ins.run(matterId, 'Cedar Lease Agreement', 'document', 3, '2026-08-20');

  // an unknown kind is rejected
  assert.throws(() => ins.run(matterId, 'Something', 'gadget', 1, '2026-08-20'));

  // same name on the same matter is one row, case-insensitively
  assert.throws(() => ins.run(matterId, 'cedar lease agreement', 'document', 1, '2026-08-21'));

  // a GLOBAL row (matter_id NULL) is also unique — the plain UNIQUE(matter_id,
  // name) form would not constrain these, because SQLite treats each NULL as
  // distinct. This is the whole reason for the expression index.
  db.prepare("INSERT INTO matter_entities (name, kind) VALUES ('Letter of Intent', 'document')").run();
  assert.throws(() => db.prepare(
    "INSERT INTO matter_entities (name, kind) VALUES ('letter of intent', 'document')").run());
  // ...and a global row does not collide with a matter row of the same name
  ins.run(matterId, 'Letter of Intent', 'document', 1, '2026-08-21');

  // defaults
  const row = db.prepare("SELECT * FROM matter_entities WHERE name='Cedar Lease Agreement'").get();
  assert.equal(row.origin, 'derived');
  assert.equal(row.hidden, 0);
  assert.equal(row.locked, 0);
  assert.equal(row.derived_name, null);

  // matter rows follow the matter out; global rows do not
  db.prepare('DELETE FROM matters WHERE id=?').run(matterId);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM matter_entities').get().c, 1);
  assert.equal(db.prepare('SELECT name FROM matter_entities').get().name, 'Letter of Intent');
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test test/db.test.js`
Expected: FAIL — `no such table: matter_entities`.

- [ ] **Step 3: Append the migration**

In `server/db.js`, append this as the LAST element of the `MIGRATIONS` array (after the `ai_draft` entry). Do not touch any earlier element.

```js
  // Entity dictionary (spec 2026-08-30): the documents, organisations and
  // people a matter has seen, feeding the ghost-text second tier. One table
  // for all three kinds — matter_people stays exactly as it is and keeps
  // feeding the AI prompt, and rebuildMatterMemory writes both in one pass.
  //   matter_id NULL  = a global row, offered on every matter, ranked last.
  //   origin 'manual' = the attorney typed it; a rebuild must never remove it.
  //   hidden          = he suppressed it; a rebuild must never resurrect it.
  //   locked          = he edited name or kind; a rebuild must not overwrite
  //                     those two fields, but still updates count/last_seen_at.
  // last_seen_at is the ENTRY DATE (YYYY-MM-DD), not a wall clock.
  `
  CREATE TABLE matter_entities (
    id           INTEGER PRIMARY KEY,
    matter_id    INTEGER REFERENCES matters(id) ON DELETE CASCADE,
    name         TEXT NOT NULL CHECK (length(trim(name)) > 0),
    -- The name the extractor produced, frozen at insert. A renamed row must
    -- still MATCH its sighting on the next rebuild, or the old name comes
    -- straight back as a second row. NULL for a hand-added row.
    derived_name TEXT,
    kind         TEXT NOT NULL CHECK (kind IN ('document','org','person')),
    count        INTEGER NOT NULL DEFAULT 0,
    last_seen_at TEXT,
    origin       TEXT NOT NULL DEFAULT 'derived' CHECK (origin IN ('derived','manual')),
    hidden       INTEGER NOT NULL DEFAULT 0,
    locked       INTEGER NOT NULL DEFAULT 0
  );
  -- An EXPRESSION index, not UNIQUE(matter_id, name): SQLite treats every
  -- NULL as distinct, so the plain form would let the global rows duplicate
  -- each other freely.
  CREATE UNIQUE INDEX idx_matter_entities_key
    ON matter_entities(IFNULL(matter_id, 0), name COLLATE NOCASE);
  CREATE INDEX idx_matter_entities_lookup
    ON matter_entities(matter_id, kind, hidden);
  `,
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `node --test test/db.test.js`
Expected: PASS. Then `npm test` — everything else must still be green.

- [ ] **Step 5: Commit**

```bash
git add server/db.js test/db.test.js
git commit -m "feat(db): migration v18 — matter_entities dictionary table"
```

---

### Task 2: `extractEntities` — mine documents and organisations from text

**Files:**
- Create: `server/lib/entities.js`
- Test: `test/entities.test.js` (create)

**Interfaces:**
- Consumes: `stripMatterTag` from `server/lib/exemplars.js`, `extractPeople` from `server/lib/people.js` (both already exported).
- Produces: `extractEntities(text) → [{ name, kind }]` where `kind` is `'document'` or `'org'`. Pure: no DB, no clock. Task 4 calls it once per entry row.

- [ ] **Step 1: Write the failing test**

Create `test/entities.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractEntities } from '../server/lib/entities.js';

const names = (t) => extractEntities(t).map((e) => `${e.kind}:${e.name}`);

test('a capitalised run ending in a head noun is a document', () => {
  assert.deepEqual(names('Review and revise the Cedar Lease Agreement today.'),
    ['document:Cedar Lease Agreement']);
});

test('"and" inside a document name is part of the name', () => {
  assert.deepEqual(names('Circulate the Purchase and Sale Agreement.'),
    ['document:Purchase and Sale Agreement']);
});

test('lowercase joiners hold a document name together', () => {
  assert.deepEqual(names('Analyze the Letter of Intent.'), ['document:Letter of Intent']);
});

// The two junk shapes measured on the live database before this was designed.
test('a leading verb is stripped off its object', () => {
  assert.deepEqual(names('Prepare Closing Binder for the closing.'),
    ['document:Closing Binder']);
});

test('"and" between two organisations splits them', () => {
  assert.deepEqual(names('Call regarding Acme and Cedar Utility scheduling.'),
    ['org:Acme', 'org:Cedar Utility']);
});

test('a lone word at the start of a clause is not evidence of an organisation', () => {
  // sentence-initial capitals are grammar, not names
  assert.deepEqual(names('Analysis of the title chain.'), []);
  // ...but an acronym is, wherever it sits
  assert.deepEqual(names('BGE confirmed the route.'), ['org:BGE']);
});

test('people are never captured as entities', () => {
  assert.deepEqual(names('Telephone conference with A. Turner regarding access.'), []);
  assert.deepEqual(names('Email to M. Smith and J. Rowan about the survey.'), []);
});

test('a comma ends a run, and an initial disqualifies it', () => {
  assert.deepEqual(names('Call with A. Turner, M. Smith regarding scheduling.'), []);
});

test('the matter tag is stripped before anything else', () => {
  assert.deepEqual(names('(YEL) Revise the Access Agreement.'), ['document:Access Agreement']);
});

test('a bare head noun is not a document', () => {
  assert.deepEqual(names('Revise the Agreement.'), []);
});

test('duplicates within one text collapse', () => {
  assert.deepEqual(names('Revise the Access Agreement; recirculate the Access Agreement.'),
    ['document:Access Agreement']);
});

test('empty and missing input', () => {
  assert.deepEqual(extractEntities(''), []);
  assert.deepEqual(extractEntities(null), []);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test test/entities.test.js`
Expected: FAIL — `Cannot find module '.../server/lib/entities.js'`.

- [ ] **Step 3: Write the extractor**

Create `server/lib/entities.js`:

```js
// Deterministic document / organisation extraction from narrative text
// (spec 2026-08-30). The sibling of server/lib/people.js: pure functions
// only, no DB, no clock. The matter_entities cache that stores these lives in
// server/routes/entries.js (rebuildMatterMemory).
//
// Measured on the live database before this was written: a plain
// capitalised-run regex already recovers the real document names, and fails in
// exactly two ways — a verb glued to its object ("Prepare Closing Binder") and
// two organisations joined by "and" ("Acme and Cedar Utility"). The head-noun
// test below is what tells those two cases apart, so both rules can apply
// without fighting each other.
import { stripMatterTag } from './exemplars.js';
import { extractPeople } from './people.js';

// A capitalised run ENDING in one of these is a document, and an "and" inside
// it belongs to the name. Anything else is an organisation, and an "and"
// inside it joins two of them. Extend freely — a document type missing here is
// degraded, not broken: it still predicts, just filed as an organisation.
const HEAD_NOUNS = new Set([
  'agreement', 'agreements', 'amendment', 'amendments', 'lease', 'leases',
  'easement', 'easements', 'deed', 'deeds', 'contract', 'contracts',
  'memorandum', 'letter', 'letters', 'intent', 'survey', 'surveys', 'plat',
  'plats', 'binder', 'addendum', 'assignment', 'consent', 'notice', 'report',
  'reports', 'schedule', 'exhibit', 'ordinance', 'resolution', 'permit',
  'application', 'order', 'opinion', 'certificate', 'policy', 'commitment',
  'abstract', 'sheet', 'estoppel', 'affidavit', 'declaration', 'covenant',
  'covenants', 'plan', 'plans', 'addenda', 'amendments', 'entry', 'review',
]);

// A narrative starts with a verb, and the verb is capitalised because it
// starts the sentence — not because it is part of the thing's name.
const LEAD_VERBS = new Set([
  'draft', 'drafted', 'review', 'reviewed', 'revise', 'revised', 'prepare',
  'prepared', 'analyze', 'analyzed', 'analyse', 'analysed', 'negotiate',
  'negotiated', 'attend', 'attended', 'execute', 'executed', 'circulate',
  'circulated', 'update', 'updated', 'finalize', 'finalized', 'research',
  'researched', 'call', 'email', 'emails', 'emailed', 'compose', 'composed',
  'confirm', 'confirmed', 'conduct', 'conducted', 'create', 'created',
  'follow', 'followed', 'discuss', 'discussed', 'correspond', 'corresponded',
]);

// Lowercase words that may sit INSIDE a name without ending it.
const JOINERS = new Set(['of', 'and', 'the', 'to', 'for']);

const MAX_RUN = 5;
const ACRONYM = /^[A-Z]{2,}$/;

const isCapitalised = (w) => /^[A-Z]/.test(w);
const bareWord = (w) => w.replace(/^[^A-Za-z]+/, '').replace(/[^A-Za-z'’-]+$/, '');

export function extractEntities(text) {
  const clean = stripMatterTag(String(text ?? '').replace(/\s+/g, ' ').trim());
  if (!clean) return [];
  // Whatever people.js claims is a person is not ours to file. Doing this once
  // for the whole text (rather than per clause) is deliberate: the trigger
  // that identifies a name can sit in a different clause from the name.
  const people = new Set(extractPeople(clean).map((n) => n.toLowerCase()));
  const out = [];
  const seen = new Set();
  for (const clause of clean.split(/[.;:]/)) {
    for (const cand of clauseRuns(clause)) {
      for (const entity of classify(cand, people)) {
        const key = `${entity.kind}|${entity.name.toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(entity);
      }
    }
  }
  return out;
}

// Every maximal run of capitalised words in one clause, joiners allowed
// inside. `atStart` records whether the run opened the clause, because a
// capital there is grammar rather than evidence.
function clauseRuns(clause) {
  const words = clause.trim().split(/\s+/).filter(Boolean);
  const bare = words.map(bareWord);
  // A comma ends a run: "A. Turner, M. Smith" is two things, not one.
  const breaks = words.map((w) => /[,]/.test(w));
  const runs = [];
  let i = 0;
  while (i < words.length) {
    if (!bare[i] || !isCapitalised(bare[i])) { i += 1; continue; }
    const start = i;
    const run = [bare[i]];
    let j = i + 1;
    if (breaks[i]) { runs.push({ run, atStart: start === 0 }); i = j; continue; }
    while (j < words.length && run.length < MAX_RUN) {
      if (bare[j] && isCapitalised(bare[j])) {
        run.push(bare[j]);
        j += 1;
        if (breaks[j - 1]) break;
        continue;
      }
      // a joiner only survives if a capitalised word follows it
      if (JOINERS.has((bare[j] || '').toLowerCase())
        && j + 1 < words.length && bare[j + 1] && isCapitalised(bare[j + 1])) {
        run.push(bare[j].toLowerCase());
        j += 1;
        continue;
      }
      break;
    }
    runs.push({ run, atStart: start === 0 });
    i = Math.max(j, i + 1);
  }
  return runs;
}

function trimJoiners(words) {
  const out = words.slice();
  while (out.length && JOINERS.has(out[out.length - 1].toLowerCase())) out.pop();
  return out;
}

function classify({ run, atStart }, people) {
  let words = run;
  if (words.length && LEAD_VERBS.has(words[0].toLowerCase())) words = words.slice(1);
  words = trimJoiners(words);
  if (!words.length) return [];
  // A single letter is an initial, so the run is somebody's name that
  // extractPeople did not claim (a trigger it does not know). Never a thing.
  if (words.some((w) => w.length === 1)) return [];

  const last = words[words.length - 1].toLowerCase();
  if (HEAD_NOUNS.has(last)) {
    // "the Agreement" names nothing — a document needs a qualifier.
    if (words.length < 2) return [];
    const name = words.join(' ');
    return people.has(name.toLowerCase()) ? [] : [{ name, kind: 'document' }];
  }

  // organisation: "and" joins two of them
  const parts = [];
  let current = [];
  for (const w of words) {
    if (w.toLowerCase() === 'and') {
      if (current.length) parts.push(current);
      current = [];
      continue;
    }
    current.push(w);
  }
  if (current.length) parts.push(current);

  const out = [];
  parts.forEach((part, idx) => {
    const kept = trimJoiners(part.filter((w) => !JOINERS.has(w.toLowerCase())));
    if (!kept.length) return;
    // Only the FIRST part can be the clause opener, and only a lone opening
    // word is suspect — "Analysis of title" must not become an organisation.
    if (kept.length === 1 && atStart && idx === 0 && !ACRONYM.test(kept[0])) return;
    const name = kept.join(' ');
    if (people.has(name.toLowerCase())) return;
    out.push({ name, kind: 'org' });
  });
  return out;
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `node --test test/entities.test.js`
Expected: PASS, all cases.

If a case fails, fix the extractor, not the test — each test encodes a shape measured on real data. The one exception: if `Revise the Agreement.` surprises you, note that `review` is in BOTH `HEAD_NOUNS` (as in "Risk Review") and `LEAD_VERBS`; the lead-verb strip runs first, which is the intended precedence.

- [ ] **Step 5: Sanity-check it against the real database**

This is a read-only spot check, not a test. It is here because the extractor's whole justification is what it does to real entries.

```bash
node -e "
const Database=require('better-sqlite3');
import('./server/lib/entities.js').then(({extractEntities})=>{
  const db=new Database('data/timekeeper.db',{readonly:true});
  const rows=db.prepare(\"SELECT narrative FROM entries WHERE deleted_at IS NULL AND TRIM(narrative)!=''\").all();
  const c=new Map();
  for(const r of rows) for(const e of extractEntities(r.narrative)){
    const k=e.kind+':'+e.name; c.set(k,(c.get(k)||0)+1);
  }
  [...c.entries()].filter(([,n])=>n>=2).sort((a,b)=>b[1]-a[1]).slice(0,25)
    .forEach(([k,n])=>console.log(String(n).padStart(3),k));
});"
```

Expected: a list dominated by real document names. Do not paste its output into a commit message — those are real matter names.

- [ ] **Step 6: Commit**

```bash
git add server/lib/entities.js test/entities.test.js
git commit -m "feat(entities): deterministic document and organisation extraction"
```

---

### Task 3: `rankEntities` — frequency × recency

**Files:**
- Modify: `server/lib/entities.js`
- Test: `test/entities.test.js` (append)

**Interfaces:**
- Produces: `rankEntities(rows, { today, halfLifeDays = 30, minUses = 2, limit = 20 })` → the same row objects plus a numeric `score`, highest first, filtered. `rows` are `matter_entities` rows: `{ name, kind, count, last_seen_at, origin, hidden }`. Task 5 calls it.

- [ ] **Step 1: Write the failing test**

Append to `test/entities.test.js`:

```js
import { rankEntities } from '../server/lib/entities.js';

const row = (name, count, last, extra = {}) => ({
  name, kind: 'document', count, last_seen_at: last,
  origin: 'derived', hidden: 0, ...extra,
});

test('rankEntities: recent beats stale at equal count', () => {
  const out = rankEntities([
    row('Stale Agreement', 4, '2026-05-01'),
    row('Fresh Agreement', 4, '2026-08-29'),
  ], { today: '2026-08-30' });
  assert.deepEqual(out.map((e) => e.name), ['Fresh Agreement', 'Stale Agreement']);
  assert.ok(out[0].score > out[1].score);
});

test('rankEntities: a derived row needs two sightings, a manual row needs none', () => {
  const out = rankEntities([
    row('Once Seen Agreement', 1, '2026-08-29'),
    row('Typed By Hand', 0, null, { origin: 'manual', count: 0 }),
  ], { today: '2026-08-30' });
  assert.deepEqual(out.map((e) => e.name), ['Typed By Hand']);
});

test('rankEntities: hidden rows never rank', () => {
  const out = rankEntities([
    row('Wrong Capture Agreement', 9, '2026-08-29', { hidden: 1 }),
    row('Real Agreement', 2, '2026-08-29'),
  ], { today: '2026-08-30' });
  assert.deepEqual(out.map((e) => e.name), ['Real Agreement']);
});

test('rankEntities: a manual row with no date sorts below dated rows', () => {
  const out = rankEntities([
    row('Typed By Hand', 0, null, { origin: 'manual' }),
    row('Seen Twice Agreement', 2, '2026-08-29'),
  ], { today: '2026-08-30' });
  assert.deepEqual(out.map((e) => e.name), ['Seen Twice Agreement', 'Typed By Hand']);
});

test('rankEntities: empty and missing input', () => {
  assert.deepEqual(rankEntities([], { today: '2026-08-30' }), []);
  assert.deepEqual(rankEntities(undefined, { today: '2026-08-30' }), []);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test test/entities.test.js`
Expected: FAIL — `rankEntities is not a function`.

- [ ] **Step 3: Implement it**

Append to `server/lib/entities.js`:

```js
const DAY_MS = 86_400_000;
// A derived row must be seen twice before it predicts, so a one-off typo never
// becomes a suggestion. A row the attorney typed himself is wanted from the
// moment he types it, so the floor does not apply to it.
const MIN_USES = 2;

// Frequency × recency, the phrasebook's decay so the two tiers age at the same
// rate. rankPhrases decays each sighting separately; this table stores only a
// count and a last date, so this is that shape approximated. Accepted (spec):
// entities are ranked against each other, never against phrases.
export function rankEntities(rows, {
  today, halfLifeDays = 30, minUses = MIN_USES, limit = 20,
} = {}) {
  const todayMs = Date.parse(`${today}T00:00:00Z`);
  return (rows || [])
    .filter((r) => r && !r.hidden)
    .filter((r) => r.origin === 'manual' || (r.count || 0) >= minUses)
    .map((r) => {
      // No date = a hand-typed row that has never been seen in an entry. Score
      // it as a single fully-decayed sighting: present, but under anything the
      // matter actually used.
      const ageDays = r.last_seen_at
        ? Math.max(0, (todayMs - Date.parse(`${r.last_seen_at}T00:00:00Z`)) / DAY_MS)
        : Infinity;
      const decay = ageDays === Infinity ? 0 : Math.pow(0.5, ageDays / halfLifeDays);
      const score = Math.max(0, r.count || 0) * decay;
      return { ...r, score: Math.round(score * 1000) / 1000 };
    })
    .sort((a, b) => b.score - a.score
      || (b.count || 0) - (a.count || 0)
      || a.name.localeCompare(b.name))
    .slice(0, limit);
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `node --test test/entities.test.js` — PASS. Then `npm test` — all green.

- [ ] **Step 5: Commit**

```bash
git add server/lib/entities.js test/entities.test.js
git commit -m "feat(entities): rank by frequency and recency, with a two-sighting floor"
```

---

### Task 4: `rebuildMatterMemory` — one pass, two caches, an upsert that respects edits

**Files:**
- Modify: `server/routes/entries.js` (replace `rebuildMatterPeople`, lines ~183–208, and its 8 call sites)
- Modify: `server/jobs.js:6,27-37` (the backfill)
- Modify: `server/routes/matters.js` (`matterPeopleList` — drop hidden names)
- Test: `test/api.entries.test.js` (append)

**Interfaces:**
- Consumes: `extractEntities` (Task 2), `extractPeople` (existing).
- Produces: `rebuildMatterMemory(db, matterId)`, exported from `server/routes/entries.js`, replacing the exported `rebuildMatterPeople`. `server/jobs.js` imports the new name.

**The contract this task exists to protect: a derived row is disposable, a row the attorney touched is not.** Get this wrong and every correction he makes in Stage B is erased by his next entry write, minutes later, silently.

- [ ] **Step 1: Write the failing test**

Append to `test/api.entries.test.js` (it already has `withServer`-style helpers — match whatever that file uses; the shape below assumes `startTestServer` and `t.fetchJson` like `test/api.matters.test.js`):

```js
test('rebuild: derived rows refresh, but manual, hidden and locked rows survive', async () => {
  const t = await startTestServer();
  try {
    const cm = (await t.fetchJson('POST', '/api/cms',
      { cm_number: '100001-000012', short_name: 'Cedar Lease' })).body;
    await t.fetchJson('POST', '/api/entries', {
      date: '2026-08-20', cm_id: cm.id,
      narrative: 'Revise the Access Agreement and circulate it.',
      tasks: [{ task_code: 'Revise', duration: 0.5, fragment: '' }],
    });
    const rows = () => t.db.prepare(
      'SELECT * FROM matter_entities WHERE matter_id=? ORDER BY name').all(cm.id);
    assert.deepEqual(rows().map((r) => r.name), ['Access Agreement']);

    // three rows the attorney owns, in the three ways he can own one
    t.db.prepare(`INSERT INTO matter_entities (matter_id, name, kind, origin)
      VALUES (?, 'Hand Typed Agreement', 'document', 'manual')`).run(cm.id);
    t.db.prepare(`INSERT INTO matter_entities (matter_id, name, kind, hidden)
      VALUES (?, 'Bad Capture', 'org', 1)`).run(cm.id);
    t.db.prepare(`INSERT INTO matter_entities
      (matter_id, name, derived_name, kind, locked) VALUES
      (?, 'Sewer Use Agreement', 'Use Agreement', 'document', 1)`).run(cm.id);

    // a second entry forces a rebuild, and mentions the locked row's DERIVED name
    await t.fetchJson('POST', '/api/entries', {
      date: '2026-08-21', cm_id: cm.id,
      narrative: 'Revise the Use Agreement; recirculate the Access Agreement.',
      tasks: [{ task_code: 'Revise', duration: 0.4, fragment: '' }],
    });

    const after = rows();
    const byName = Object.fromEntries(after.map((r) => [r.name, r]));
    // manual survives untouched
    assert.ok(byName['Hand Typed Agreement']);
    // hidden is not resurrected and stays hidden
    assert.equal(byName['Bad Capture'].hidden, 1);
    // locked keeps HIS name, gains the count, and the derived name does not
    // come back as a second row
    assert.ok(byName['Sewer Use Agreement']);
    assert.equal(byName['Sewer Use Agreement'].count, 1);
    assert.equal(byName['Use Agreement'], undefined);
    // the plain derived row still refreshes
    assert.equal(byName['Access Agreement'].count, 2);
    assert.equal(byName['Access Agreement'].last_seen_at, '2026-08-21');
  } finally { await t.close(); }
});

test('rebuild: a derived row that stops appearing is dropped', async () => {
  const t = await startTestServer();
  try {
    const cm = (await t.fetchJson('POST', '/api/cms',
      { cm_number: '100001-000012', short_name: 'Cedar Lease' })).body;
    const e = (await t.fetchJson('POST', '/api/entries', {
      date: '2026-08-20', cm_id: cm.id,
      narrative: 'Revise the Access Agreement.',
      tasks: [{ task_code: 'Revise', duration: 0.5, fragment: '' }],
    })).body;
    await t.fetchJson('PATCH', `/api/entries/${e.id}`,
      { narrative: 'Revise the Utility Easement.' });
    const names = t.db.prepare(
      'SELECT name FROM matter_entities WHERE matter_id=?').all(cm.id).map((r) => r.name);
    assert.deepEqual(names, ['Utility Easement']);
  } finally { await t.close(); }
});

test('a person hidden in the dictionary leaves the AI prompt roster too', async () => {
  const t = await startTestServer();
  try {
    const cm = (await t.fetchJson('POST', '/api/cms',
      { cm_number: '100001-000012', short_name: 'Cedar Lease' })).body;
    await t.fetchJson('POST', '/api/entries', {
      date: '2026-08-20', cm_id: cm.id,
      narrative: 'Telephone conference with A. Turner regarding access.',
      tasks: [{ task_code: 'Call', duration: 0.3, fragment: '' }],
    });
    const before = await t.fetchJson('GET', `/api/matters/${cm.id}/people`);
    assert.ok(before.body.people.some((p) => p.name === 'A. Turner'));

    t.db.prepare(`UPDATE matter_entities SET hidden=1
      WHERE matter_id=? AND kind='person' AND name='A. Turner'`).run(cm.id);
    const after = await t.fetchJson('GET', `/api/matters/${cm.id}/people`);
    assert.ok(!after.body.people.some((p) => p.name === 'A. Turner'));
  } finally { await t.close(); }
});
```

If `test/helpers.js`'s `startTestServer` does not already expose the raw `db`, add it to the object it returns (`return { base, db, fetchJson, close }`) — a one-line change, and several of these tests need to reach past the API to assert on the cache.

- [ ] **Step 2: Run them and watch them fail**

Run: `node --test test/api.entries.test.js`
Expected: FAIL — `no such table` is already gone (Task 1), so these fail on empty `matter_entities`: nothing writes it yet.

- [ ] **Step 3: Replace the rebuild**

In `server/routes/entries.js`, add the import and replace the whole `rebuildMatterPeople` function:

```js
import { extractEntities } from '../lib/entities.js';
```

```js
// Rebuild BOTH derived caches for one matter from its entries, in one pass and
// one transaction, so they can never drift apart (2026-08-30: was
// rebuildMatterPeople, people only).
//
//   matter_people    — unchanged behaviour, a full replace. It feeds the AI
//                      prompt and /people and holds nothing the user owns.
//   matter_entities  — an UPSERT. Its rows carry the attorney's corrections,
//                      and this runs on EVERY entry write, so a full replace
//                      would erase an edit within minutes of him making it.
//
// The upsert contract, in four lines:
//   sighted + locked=0    → refresh name, kind, count, last_seen_at
//   sighted + locked=1    → refresh count and last_seen_at only
//   unsighted + purely derived → delete
//   anything he touched   → leave alone
// A locked row matches its sighting on derived_name, not on name — otherwise
// renaming a row makes the extractor's name reappear as a second row.
export function rebuildMatterMemory(db, matterId) {
  if (matterId == null) return;
  const rows = db.prepare(`
    SELECT e.date, e.narrative,
      (SELECT group_concat(t.fragment, char(10)) FROM entry_tasks t WHERE t.entry_id = e.id) AS fragments
    FROM entries e WHERE e.cm_id = ? AND e.deleted_at IS NULL
  `).all(matterId);

  const people = new Map();   // lower(name) → { name, count, last }
  const sighted = new Map();  // lower(name) → { name, kind, count, last }
  const bump = (map, name, kind, date) => {
    const key = name.toLowerCase();
    const cur = map.get(key);
    if (!cur) { map.set(key, { name, kind, count: 1, last: date }); return; }
    cur.count += 1;
    if (date >= cur.last) { cur.last = date; cur.name = name; }
  };

  for (const row of rows) {
    const text = `${row.narrative}\n${row.fragments || ''}`;
    for (const name of extractPeople(text)) {
      bump(people, name, 'person', row.date);
      bump(sighted, name, 'person', row.date);
    }
    for (const e of extractEntities(text)) {
      // A person already claimed under this name wins: people.js is the more
      // precise extractor, and one name is one dictionary row.
      const hit = sighted.get(e.name.toLowerCase());
      if (hit && hit.kind === 'person') continue;
      bump(sighted, e.name, e.kind, row.date);
    }
  }

  db.transaction(() => {
    db.prepare('DELETE FROM matter_people WHERE matter_id=?').run(matterId);
    const insPerson = db.prepare(
      'INSERT INTO matter_people (matter_id, name, count, last_seen_at) VALUES (?, ?, ?, ?)');
    for (const p of people.values()) insPerson.run(matterId, p.name, p.count, p.last);

    const existing = db.prepare(
      'SELECT id, name, derived_name, origin, hidden, locked FROM matter_entities WHERE matter_id=?'
    ).all(matterId);
    // Key on what the EXTRACTOR called it, falling back to the display name.
    const byKey = new Map(existing.map((r) => [(r.derived_name || r.name).toLowerCase(), r]));

    const insert = db.prepare(`INSERT INTO matter_entities
      (matter_id, name, derived_name, kind, count, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)`);
    const refreshAll = db.prepare(
      'UPDATE matter_entities SET name=?, kind=?, count=?, last_seen_at=? WHERE id=?');
    const refreshCount = db.prepare(
      'UPDATE matter_entities SET count=?, last_seen_at=? WHERE id=?');
    const drop = db.prepare('DELETE FROM matter_entities WHERE id=?');

    for (const e of sighted.values()) {
      const key = e.name.toLowerCase();
      const hit = byKey.get(key);
      if (!hit) { insert.run(matterId, e.name, e.name, e.kind, e.count, e.last); continue; }
      byKey.delete(key);
      if (hit.locked) refreshCount.run(e.count, e.last, hit.id);
      else refreshAll.run(e.name, e.kind, e.count, e.last, hit.id);
    }
    // Whatever is left was not sighted this pass.
    for (const stale of byKey.values()) {
      if (stale.origin === 'derived' && !stale.hidden && !stale.locked) drop.run(stale.id);
    }
  })();
}
```

- [ ] **Step 4: Rename every call site**

`server/routes/entries.js` — 8 call sites at roughly lines 285, 286, 364, 442, 443, 483, 534, 545. Rename each `rebuildMatterPeople(` to `rebuildMatterMemory(`. Nothing else about them changes.

```bash
sed -i 's/rebuildMatterPeople(/rebuildMatterMemory(/g' server/routes/entries.js
grep -n "rebuildMatter" server/routes/entries.js   # expect the definition + 8 calls
```

`server/jobs.js` — the import on line 6 and the backfill on line 35. Also give the backfill a NEW state key, so the entity half runs on this upgrade even though the people half already ran:

```js
import { rebuildMatterMemory } from './routes/entries.js';
```

```js
  // One-time (per upgrade) cache backfill: matter_people arrived with the
  // memory-layer migration and matter_entities with v18, and SQL migrations
  // cannot run the JS extractors — so the first tick derives both from all
  // existing entries. The key is versioned: peopleBackfillDone is already true
  // on this box, and the entity half still has to run.
  if (!state.memoryBackfillV18) {
    const matterIds = db.prepare(
      'SELECT DISTINCT cm_id FROM entries WHERE deleted_at IS NULL').all();
    for (const { cm_id } of matterIds) rebuildMatterMemory(db, cm_id);
    setSetting(db, 'jobs_state',
      { ...(getSetting(db, 'jobs_state') || {}), memoryBackfillV18: true });
  }
```

Leave the old `peopleBackfillDone` block in place. It is idempotent, it costs one pass on a fresh database, and deleting it would re-run the people backfill on any box that has not upgraded yet.

- [ ] **Step 5: Drop hidden people from the AI roster**

In `server/routes/matters.js`, `matterPeopleList` currently returns own names then sibling names. A name hidden in the dictionary must not reach the model either — otherwise hiding a mis-captured name fixes the ghost and leaves the prompt still saying it.

Replace the existing `return own.concat(sib).slice(0, limit);` with:

```js
  // A name he hid in the dictionary is hidden everywhere, the AI prompt
  // included (spec 2026-08-30). Matter-scoped and global hides both count.
  const hidden = new Set(db.prepare(`
    SELECT LOWER(name) AS n FROM matter_entities
    WHERE kind='person' AND hidden=1 AND (matter_id = ? OR matter_id IS NULL)
  `).all(matter.id).map((r) => r.n));
  return own.concat(sib).filter((n) => !hidden.has(n.toLowerCase())).slice(0, limit);
```

Task 5 rewrites this function into `matterPeopleRanked` and this filter moves
inside it. It belongs here anyway: the test above is part of THIS task, and
leaving the AI prompt quoting a hidden name for the length of one task is not
worth the tidier diff.

- [ ] **Step 6: Run the tests and watch them pass**

Run: `node --test test/api.entries.test.js` — PASS.
Run: `npm test` — all green. `test/jobs.test.js` and `test/people.test.js` must be untouched by this; if either fails, the rename missed a call site.

- [ ] **Step 7: Restart and commit**

```bash
systemctl --user restart timekeeper && curl -s localhost:4747/api/health
git add server/routes/entries.js server/jobs.js server/routes/matters.js test/api.entries.test.js test/helpers.js
git commit -m "feat(memory): rebuild people and entities in one pass, as an upsert"
```

---

### Task 5: `/api/matters/:id/suggestions` grows `entities` and `people`

**Files:**
- Modify: `server/routes/matters.js`
- Test: `test/api.matters.test.js` (append)

**Interfaces:**
- Consumes: `rankEntities` (Task 3).
- Produces: `matterSuggestions()` returns `{ matter_id, borrowed, phrases, entities, people }`. `entities` rows are `{ name, kind, count, last_seen, source }`; `people` rows are `{ name, source }`. `source` is `'matter' | 'client' | 'global'` and the array is ALREADY in that order — the browser never re-sorts.

- [ ] **Step 1: Write the failing test**

Append to `test/api.matters.test.js`:

```js
test('suggestions: documents stay on their matter, organisations and people cross', () =>
  withServer(async (t) => {
    const { warm, cold, other } = await seed(t);
    await t.fetchJson('POST', '/api/entries', {
      date: '2026-08-20', cm_id: warm.id,
      narrative: 'Revise the Access Agreement; call regarding Cedar Utility.',
      tasks: [{ task_code: 'Revise', duration: 0.5, fragment: '' }],
    });
    await t.fetchJson('POST', '/api/entries', {
      date: '2026-08-21', cm_id: warm.id,
      narrative: 'Recirculate the Access Agreement; email to A. Turner regarding Cedar Utility.',
      tasks: [{ task_code: 'Revise', duration: 0.4, fragment: '' }],
    });
    await t.fetchJson('POST', '/api/entries', {
      date: '2026-08-21', cm_id: other.id,
      narrative: 'Revise the Stranger Agreement twice; revise the Stranger Agreement again.',
      tasks: [{ task_code: 'Revise', duration: 0.4, fragment: '' }],
    });

    const r = await t.fetchJson('GET', `/api/matters/${cold.id}/suggestions`);
    const byName = Object.fromEntries(r.body.entities.map((e) => [e.name, e]));
    // the sibling's ORGANISATION crosses, ranked as borrowed
    assert.equal(byName['Cedar Utility'].source, 'client');
    // the sibling's DOCUMENT does not cross at all
    assert.equal(byName['Access Agreement'], undefined);
    // a different client's matter never crosses
    assert.equal(byName['Stranger Agreement'], undefined);
    // the sibling's person crosses
    assert.ok(r.body.people.some((p) => p.name === 'A. Turner' && p.source === 'client'));

    // ...and on the matter that owns them, both are its own
    const own = await t.fetchJson('GET', `/api/matters/${warm.id}/suggestions`);
    const ownNames = Object.fromEntries(own.body.entities.map((e) => [e.name, e]));
    assert.equal(ownNames['Access Agreement'].source, 'matter');
    assert.equal(ownNames['Access Agreement'].kind, 'document');
  }));

test('suggestions: a global dictionary row is offered everywhere, ranked last', () =>
  withServer(async (t) => {
    const { warm } = await seed(t);
    await t.fetchJson('POST', '/api/entries', {
      date: '2026-08-20', cm_id: warm.id,
      narrative: 'Revise the Access Agreement.',
      tasks: [{ task_code: 'Revise', duration: 0.5, fragment: '' }],
    });
    await t.fetchJson('POST', '/api/entries', {
      date: '2026-08-21', cm_id: warm.id,
      narrative: 'Recirculate the Access Agreement.',
      tasks: [{ task_code: 'Revise', duration: 0.4, fragment: '' }],
    });
    t.db.prepare(`INSERT INTO matter_entities (matter_id, name, kind, origin)
      VALUES (NULL, 'Standard Form Lease', 'document', 'manual')`).run();

    const r = await t.fetchJson('GET', `/api/matters/${warm.id}/suggestions`);
    const names = r.body.entities.map((e) => e.name);
    assert.ok(names.includes('Standard Form Lease'));
    assert.equal(r.body.entities.at(-1).name, 'Standard Form Lease');
    assert.equal(r.body.entities.at(-1).source, 'global');
  }));
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node --test test/api.matters.test.js`
Expected: FAIL — `r.body.entities` is undefined.

- [ ] **Step 3: Implement**

In `server/routes/matters.js`, import `rankEntities` and add two functions above `matterSuggestions`:

```js
import { rankEntities } from '../lib/entities.js';
```

```js
// Sibling matters are many; the same organisation on three of them is one
// suggestion carrying their combined weight.
function mergeByName(rows) {
  const out = new Map();
  for (const r of rows) {
    const key = r.name.toLowerCase();
    const cur = out.get(key);
    if (!cur) { out.set(key, { ...r }); continue; }
    cur.count += r.count;
    if ((r.last_seen_at || '') >= (cur.last_seen_at || '')) {
      cur.last_seen_at = r.last_seen_at;
      cur.name = r.name;
    }
  }
  return [...out.values()];
}

// The scope rule from the spec, in one place. A document belongs to one deal;
// an organisation and a person move around a client's matters. Everything
// borrowed ranks after everything the matter owns, and hand-added global rows
// come last of all — they are always available and never urgent.
export function matterEntityList(db, matterId, today) {
  const matter = db.prepare('SELECT id, client_id FROM matters WHERE id=?').get(matterId);
  if (!matter) return [];
  const own = db.prepare('SELECT * FROM matter_entities WHERE matter_id=?').all(matter.id);
  const sib = matter.client_id == null ? [] : mergeByName(db.prepare(`
    SELECT me.* FROM matter_entities me JOIN matters m ON m.id = me.matter_id
    WHERE m.client_id = ? AND m.id != ? AND me.kind IN ('org','person')
  `).all(matter.client_id, matter.id));
  const global = db.prepare('SELECT * FROM matter_entities WHERE matter_id IS NULL').all();

  const seen = new Set();
  const out = [];
  for (const [rows, source] of [[own, 'matter'], [sib, 'client'], [global, 'global']]) {
    for (const r of rankEntities(rows, { today })) {
      const key = r.name.toLowerCase();
      if (seen.has(key)) continue;   // the matter's own copy always wins
      seen.add(key);
      out.push({
        name: r.name, kind: r.kind, count: r.count,
        last_seen: r.last_seen_at, source,
      });
    }
  }
  return out;
}
```

Then split the people roster so both callers share one ranking. Replace the body of `matterPeopleList` with a thin wrapper and add the ranked form:

```js
// Ranked people with their provenance. matterPeopleList() becomes the
// flat-name view of exactly this list, so the AI prompt and the ghost can
// never disagree about who is on the matter or in what order. The hidden
// filter from Task 4 moves in here and therefore covers both callers.
export function matterPeopleRanked(db, matterId, limit = 20) {
  const matter = db.prepare('SELECT id, client_id FROM matters WHERE id=?').get(matterId);
  if (!matter) return [];
  const own = db.prepare(`
    SELECT name FROM matter_people WHERE matter_id = ?
    ORDER BY last_seen_at DESC, count DESC, name
  `).all(matter.id).map((p) => ({ name: p.name, source: 'matter' }));
  const have = new Set(own.map((p) => p.name.toLowerCase()));
  const sib = matter.client_id == null ? [] : db.prepare(`
    SELECT MIN(mp.name) AS name, SUM(mp.count) AS count, MAX(mp.last_seen_at) AS last_seen
    FROM matter_people mp JOIN matters m ON m.id = mp.matter_id
    WHERE m.client_id = ? AND m.id != ?
    GROUP BY LOWER(mp.name)
    ORDER BY last_seen DESC, count DESC, name
  `).all(matter.client_id, matter.id)
    .filter((p) => !have.has(p.name.toLowerCase()))
    .map((p) => ({ name: p.name, source: 'client' }));

  // A name he hid in the dictionary is hidden everywhere, the AI prompt
  // included (spec 2026-08-30). Matter-scoped and global hides both count.
  const hidden = new Set(db.prepare(`
    SELECT LOWER(name) AS n FROM matter_entities
    WHERE kind='person' AND hidden=1 AND (matter_id = ? OR matter_id IS NULL)
  `).all(matter.id).map((r) => r.n));

  // Hand-added people, matter-scoped then global, after everything derived.
  const manual = db.prepare(`
    SELECT name, matter_id FROM matter_entities
    WHERE kind='person' AND origin='manual' AND hidden=0
      AND (matter_id = ? OR matter_id IS NULL)
    ORDER BY (matter_id IS NULL), name COLLATE NOCASE
  `).all(matter.id)
    .map((r) => ({ name: r.name, source: r.matter_id == null ? 'global' : 'matter' }));

  const out = [];
  const seen = new Set();
  for (const p of [...own, ...sib, ...manual]) {
    const key = p.name.toLowerCase();
    if (seen.has(key) || hidden.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out.slice(0, limit);
}

export function matterPeopleList(db, matterId, limit = 20) {
  return matterPeopleRanked(db, matterId, limit).map((p) => p.name);
}
```

Delete the old `matterPeopleList` body entirely — the hidden filter added in
Task 4 Step 5 lives in `matterPeopleRanked` now, so keeping both would apply
it twice and diverge the moment one is edited.

Finally, in `matterSuggestions`, extend the return:

```js
  return {
    matter_id: matter.id,
    borrowed,
    phrases: rankPhrases(occurrences, { today }),
    entities: matterEntityList(db, matter.id, today),
    people: matterPeopleRanked(db, matter.id),
  };
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `node --test test/api.matters.test.js` — PASS, including every case already in the file.
Run: `npm test` — all green. Watch `test/api.ai.test.js` in particular: `ai.js` calls `matterSuggestions` and `matterPeopleList`, and both must behave exactly as before.

- [ ] **Step 5: Restart and commit**

```bash
systemctl --user restart timekeeper && curl -s localhost:4747/api/health
git add server/routes/matters.js test/api.matters.test.js
git commit -m "feat(api): serve matter entities and ranked people from /suggestions"
```

---

### Task 6: `ghostCompletion` tier 2 — the entity continuation

**Files:**
- Modify: `public/js/lib/ghost.js`
- Test: `test/ghost.test.js` (append)

**Interfaces:**
- Produces: `ghostCompletion(value, caret, phrases, { minChars, entities, people })`. `entities` is the API's `entities` array (already ranked), `people` the API's `people` array. Both default to `[]`, so **every existing caller and every existing test keeps today's behaviour** — that is the acceptance criterion for this task.

- [ ] **Step 1: Write the failing test**

Append to `test/ghost.test.js`:

```js
const ENTITIES = [
  { name: 'Development Agreement', kind: 'document' },
  { name: 'Cedar Utility', kind: 'org' },
];
const PEOPLE = [{ name: 'A. Turner' }, { name: 'M. Smith' }];
const OPTS = { entities: ENTITIES, people: PEOPLE };
const ghost = (typed, opts = OPTS) => ghostCompletion(typed, typed.length, PHRASES, opts);

test('a document verb offers the top entity', () => {
  assert.equal(ghost('Review and analyze '), 'Development Agreement');
});

test('regarding and re offer an entity too', () => {
  assert.equal(ghost('Call regarding '), 'Development Agreement');
  assert.equal(ghost('Email re '), 'Development Agreement');
});

test('with, to and from all offer a person', () => {
  assert.equal(ghost('Telephone conference with '), 'A. Turner');
  assert.equal(ghost('Email to '), 'A. Turner');
  assert.equal(ghost('Letter from '), 'A. Turner');
});

test('a part-typed word completes from either list, with no trigger needed', () => {
  assert.equal(ghost('Review and analyze Devel'), 'opment Agreement');
  assert.equal(ghost('Email to M. Sm'), 'ith');
});

test('an ordinary word offers nothing', () => {
  assert.equal(ghost('Attended the '), null);
  assert.equal(ghost('Reviewed it and then '), null);
});

test('never offers something already in the text — it offers the next one', () => {
  // 'Development Agreement' is spoken for, so the trigger falls through to the
  // next ranked entity rather than going quiet.
  assert.equal(ghost('Review Development Agreement and analyze '), 'Cedar Utility');
  // ...and with nothing left to offer, it does go quiet
  assert.equal(ghost('Review Development Agreement and Cedar Utility and analyze '), null);
});

test('a list of people continues after "and" or a comma', () => {
  assert.equal(ghost('Call with A. Turner and '), 'M. Smith');
  assert.equal(ghost('Call with A. Turner, '), 'M. Smith');
  // ...but only inside a clause that actually introduced a person
  assert.equal(ghost('Reviewed the file and '), null);
});

test('after a name with no document yet, the chain offers one', () => {
  assert.equal(ghost('Email to A. Turner '), 'regarding Development Agreement');
  // already has one → nothing to chain
  assert.equal(ghost('Email to A. Turner regarding Development Agreement '), null);
});

test('the phrasebook still wins when it matches', () => {
  // 'rev' is a phrase prefix; tier 2 must never get the chance
  assert.equal(ghost('rev'), 'ise lease legal description');
});

test('with no entities or people, behaviour is exactly as before', () => {
  assert.equal(ghostCompletion('Review and analyze ', 18, PHRASES), null);
  assert.equal(ghostCompletion('rev', 3, PHRASES), 'ise lease legal description');
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test test/ghost.test.js`
Expected: the new cases FAIL, and **the ten cases already in the file PASS**. If any of those ten fail at this point, stop — the test file was edited wrongly.

- [ ] **Step 3: Implement tier 2**

Rewrite `public/js/lib/ghost.js`. Tier 1 is unchanged; everything below it is new.

```js
// Ghost-text completion engine (spec §6; second tier added 2026-08-30):
// deterministic, from the matter's phrasebook and its entity dictionary —
// NEVER an LLM. Pure and dependency-free so the same ES module runs in the
// browser (no-build) and under node:test (test/ghost.test.js).
//
// TIER 1 completes a whole ranked PHRASE from the start of the clause. That is
// the proven behaviour and it always gets first refusal.
// TIER 2 completes a THING mid-clause — the documents, organisations and
// people this matter has seen — because "review and analyze " is not the start
// of any stored phrase and never will be.

const SEGMENT_BREAK = /[.;:]/;

// After a space, a guess needs a reason. These are the words that give one.
// The person set is deliberately the connector vocabulary server/lib/people.js
// uses to FIND names, so what the app learned from is what it predicts into.
const PERSON_TRIGGERS = new Set(['with', 'to', 'from']);
const ENTITY_TRIGGERS = new Set([
  'regarding', 're', 'about', 'concerning', 'of', 'on',
  'review', 'reviewed', 'analyze', 'analyzed', 'revise', 'revised', 'draft',
  'drafted', 'prepare', 'prepared', 'negotiate', 'negotiated', 'execute',
  'executed', 'circulate', 'circulated', 'update', 'updated', 'finalize',
  'finalized', 'comment',
]);

export function ghostCompletion(value, caret, phrases, {
  minChars = 2, entities = [], people = [],
} = {}) {
  const text = String(value ?? '');
  if (caret !== text.length || text.length === 0) return null; // only complete at the end
  let cut = -1;
  for (let i = text.length - 1; i >= 0; i--) {
    if (SEGMENT_BREAK.test(text[i])) { cut = i; break; }
  }
  const seg = text.slice(cut + 1).replace(/^\s+/, '');

  // ── tier 1: the phrasebook, unchanged ──────────────────────────────────
  if (seg.length >= minChars) {
    const low = seg.toLowerCase();
    for (const p of phrases || []) {
      const phrase = String(p);
      const pl = phrase.toLowerCase();
      if (pl.length > low.length && pl.startsWith(low)) return phrase.slice(seg.length);
    }
  }

  // ── tier 2: an entity, a person, or the chain ──────────────────────────
  return entityCompletion(seg, text, entities || [], people || [], minChars);
}

const nameOf = (x) => String((x && x.name) || x || '');
const already = (text, name) => text.toLowerCase().includes(name.toLowerCase());

function entityCompletion(seg, text, entities, people, minChars) {
  const docsAndOrgs = entities.map(nameOf);
  const persons = people.map(nameOf);

  // Mid-word: the attorney is typing the thing's name. No trigger needed —
  // a part-typed word is its own evidence.
  if (seg && !/\s$/.test(seg)) {
    const hit = prefixHit(seg, [...docsAndOrgs, ...persons], minChars);
    if (hit) return hit;
    return null;
  }

  const words = seg.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  const last = words[words.length - 1].replace(/[^A-Za-z,]/g, '').toLowerCase();
  const lastRaw = words[words.length - 1];

  // "call with A. Turner and " / "…, " — another person in the same list
  const isListJoin = last === 'and' || /,$/.test(lastRaw);
  const clauseHasPersonTrigger = words.some(
    (w) => PERSON_TRIGGERS.has(w.replace(/[^A-Za-z]/g, '').toLowerCase()));
  if (isListJoin && clauseHasPersonTrigger) return firstUnused(persons, text);

  if (PERSON_TRIGGERS.has(last)) return firstUnused(persons, text);
  if (ENTITY_TRIGGERS.has(last)) return firstUnused(docsAndOrgs, text);

  // The chain: a name has been accepted, the clause names no document yet.
  // Documents only — "email with M. Smith regarding Cedar Utility" reads wrong.
  if (clauseHasPersonTrigger && persons.some((n) => already(seg, n))) {
    const docs = entities.filter((e) => e && e.kind === 'document').map(nameOf);
    const next = firstUnused(docs, text);
    return next ? `regarding ${next}` : null;
  }
  return null;
}

// The longest typed word-prefix that starts one of the names, matched at a
// word boundary so "…analyze Devel" completes but "…analyzeDevel" does not.
function prefixHit(seg, names, minChars) {
  const starts = [0];
  for (let i = 0; i < seg.length; i++) if (/\s/.test(seg[i])) starts.push(i + 1);
  for (const pos of starts) {
    const typed = seg.slice(pos);
    if (typed.length < minChars) continue;
    const low = typed.toLowerCase();
    for (const name of names) {
      const nl = name.toLowerCase();
      if (nl.length > low.length && nl.startsWith(low)) return name.slice(typed.length);
    }
  }
  return null;
}

function firstUnused(names, text) {
  for (const name of names) if (!already(text, name)) return name;
  return null;
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `node --test test/ghost.test.js`
Expected: PASS — the new cases AND all ten originals.
Run: `npm test` — all green.

- [ ] **Step 5: Commit**

```bash
git add public/js/lib/ghost.js test/ghost.test.js
git commit -m "feat(ghost): complete documents, organisations and people mid-clause"
```

---

### Task 7: wire it into the fields, and the ↓ candidate list

**Files:**
- Modify: `public/js/components/ghosttext.js`
- Modify: `public/js/components/entryeditor.js` (two `GhostInput` uses, ~lines 716 and 784)
- Modify: `public/js/components/entrylist.js` (~line 71)
- Modify: `public/js/components/closeout.js` (~line 278)
- Modify: `public/css/app.css` (the list)
- Modify: `public/sw.js` (bump `CACHE` — once, here, for all of Stage A)
- Test: `scripts/e2e-smoke.mjs` (append a step)

**Interfaces:**
- Consumes: the API fields from Task 5, `ghostCompletion` from Task 6.
- Produces: `useMatterEntities(cmId) → { entities, people }`, exported from `ghosttext.js`; `GhostInput` accepts an `entities` prop of that shape.

- [ ] **Step 1: Write the failing e2e step**

Add to `scripts/e2e-smoke.mjs`, immediately after the step named `entry: total + task line + narrative autosave, allocation chip` (that step leaves the editor open on a matter with history):

```js
// 2026-08-30 feedback: ghost text should predict the matter's own documents
// and people, not only whole stored phrases.
await step('ghost text: a trigger word predicts an entity; ↓ opens the list', async () => {
  await page.click('.entry-card .btn[title="Edit"]');
  await waitFor('.modal-wide .narrative-preview textarea');
  const sel = '.modal-wide .narrative-preview textarea';
  await page.click(sel);
  await page.$eval(sel, (el) => { el.value = ''; });
  await page.type(sel, 'Review and analyze ');
  await page.waitForFunction(
    () => !!document.querySelector('.ghost-mirror .ghost-rest')?.textContent.trim(),
    { timeout: 4000 });
  const ghosted = await page.$eval('.ghost-mirror .ghost-rest', (el) => el.textContent.trim());
  if (!ghosted) throw new Error('no ghost text after a document trigger');

  await page.keyboard.press('ArrowDown');
  await waitFor('.ghost-list');
  const items = await page.$$eval('.ghost-list button', (els) => els.length);
  if (items < 1) throw new Error('↓ opened an empty candidate list');

  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('.ghost-list'), { timeout: 4000 });
  if (!(await page.$('.modal-wide'))) throw new Error('Escape closed the editor, not just the list');
  await clickText('.modal-wide button', 'Save & close');
  await page.waitForFunction(() => !document.querySelector('.modal-wide'), { timeout: 5000 });
});
```

Check the real class names for the ghost mirror in `ghosttext.js` before running this — if the rendered remainder is not `.ghost-mirror .ghost-rest`, use whatever it actually is and keep the assertion.

- [ ] **Step 2: Run it and watch it fail**

Run: `node scripts/e2e-smoke.mjs`
Expected: FAIL on the new step — no ghost after a trigger word.

- [ ] **Step 3: Extend the hook**

In `public/js/components/ghosttext.js`, the module-level cache entry becomes `{ at, phrases, entities, people }`. Keep `useMatterSuggestions` returning strings — three call sites depend on that — and add the sibling hook reading the same entry:

```js
const cache = new Map(); // cmId -> { at, phrases, entities, people }
const TTL = 60_000;

// One fetch per matter serves both hooks. Kept as two hooks rather than one
// returning an object: useMatterSuggestions' string[] contract is used by
// StopChips, the entry list and the close-out, and changing it would touch
// all of them for no gain.
function useMatterMemory(cmId) {
  const [mem, setMem] = useState({ phrases: [], entities: [], people: [] });
  useEffect(() => {
    if (!cmId) { setMem({ phrases: [], entities: [], people: [] }); return undefined; }
    const hit = cache.get(cmId);
    if (hit && hit.phrases.length > 0 && Date.now() - hit.at < TTL) { setMem(hit); return undefined; }
    let alive = true;
    api.get(`/api/matters/${cmId}/suggestions`)
      .then((r) => {
        const next = {
          phrases: r.phrases.map((p) => p.text),
          entities: r.entities || [],
          people: r.people || [],
        };
        if (next.phrases.length > 0) cache.set(cmId, { at: Date.now(), ...next });
        if (alive) setMem(next);
      })
      .catch(() => { if (alive) setMem({ phrases: [], entities: [], people: [] }); });
    return () => { alive = false; };
  }, [cmId]);
  return mem;
}

export function useMatterSuggestions(cmId) { return useMatterMemory(cmId).phrases; }

export function useMatterEntities(cmId) {
  const { entities, people } = useMatterMemory(cmId);
  return { entities, people };
}
```

- [ ] **Step 4: Teach `GhostInput` the second tier and the list**

Still in `ghosttext.js`. Add `entities = null` to the destructured props, pass it into `recompute`, and add the list.

```js
  const recompute = useCallback((text, caret) => {
    setGhost(ghostCompletion(text, caret, suggestions, {
      entities: entities?.entities || [],
      people: entities?.people || [],
    }));
  }, [suggestions, entities]);
```

Add list state and a candidate builder:

```js
  const [list, setList] = useState(null); // null = closed; else { items, index }

  // The candidates behind the ghost: the same two lists, minus anything
  // already written. Five is enough to choose from without becoming a menu.
  function candidates() {
    const used = String(value || '').toLowerCase();
    const all = [
      ...(entities?.entities || []).map((e) => e.name),
      ...(entities?.people || []).map((p) => p.name),
    ];
    return all.filter((n) => !used.includes(n.toLowerCase())).slice(0, 5);
  }
```

In `handleKeyDown`, before the existing Tab branch:

```js
    // ↓ opens the candidate list. The key is free because a ghost only ever
    // appears with the caret at the very END of the text, where ↓ has nothing
    // to do. With no ghost showing, ↓ is not touched at all.
    if (e.key === 'ArrowDown' && ghost && !list) {
      const items = candidates();
      if (items.length) { e.preventDefault(); setList({ items, index: 0 }); return; }
    }
    if (list) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setList({ ...list, index: (list.index + 1) % list.items.length }); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setList({ ...list, index: (list.index + list.items.length - 1) % list.items.length }); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); accept(list.items[list.index]); return; }
      if (e.key === 'Escape') {
        // The editor modal owns Escape through a capture listener, so closing
        // the list has to stop the event here or the whole editor closes with
        // it (the precedent StopChips documents).
        e.preventDefault();
        e.stopPropagation();
        setList(null);
        return;
      }
      setList(null); // any other key resumes typing
    }
```

and an `accept` helper beside the Tab branch, which both paths use:

```js
  function accept(textToAppend) {
    const next = value + textToAppend;
    pendingCaret.current = next.length;
    setGhost(null);
    setList(null);
    onChange(next);
  }
```

Render the list under the field (inside the wrapper the mirror already lives in):

```js
    ${list ? html`
      <div class="ghost-list">
        ${list.items.map((name, i) => html`
          <button key=${name} type="button" class=${i === list.index ? 'on' : ''}
            onMouseDown=${(ev) => { ev.preventDefault(); accept(name); }}>${name}</button>`)}
      </div>` : null}
```

`onMouseDown` with `preventDefault`, not `onClick`: a click would blur the field first, and the blur handler clears the ghost.

- [ ] **Step 5: Pass the prop at the four field sites**

Each of these already calls `useMatterSuggestions` with a matter id. Add the sibling call and the prop.

- `entryeditor.js` — `const ents = useMatterEntities(local?.cm?.id);` beside the existing `phrases` line (~90), then `entities=${ents}` on BOTH `GhostInput` uses (~716 task fragment, ~784 narrative).
- `entrylist.js` — `const ents = useMatterEntities(editing ? entry.cm?.id : null);` beside the existing hook (~25), then `entities=${ents}` on the `GhostInput` (~71).
- `closeout.js` — the same pair for its `GhostInput` (~278).

- [ ] **Step 6: Style the list**

Append to `public/css/app.css`:

```css
/* Ghost-text candidate list (↓). Sits under the field, above everything else
   in the editor; the field keeps focus, so it is a menu the keyboard drives. */
.ghost-list {
  position: absolute; z-index: 40; margin-top: 2px;
  background: var(--surface-1); border: 1px solid var(--border);
  border-radius: 6px; box-shadow: 0 6px 20px rgba(0,0,0,.12);
  max-width: min(420px, 90%); overflow: hidden;
}
.ghost-list button {
  display: block; width: 100%; text-align: left;
  padding: 5px 10px; border: 0; background: none; cursor: pointer;
  font: inherit; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.ghost-list button.on, .ghost-list button:hover { background: var(--surface-2); }
```

The `GhostInput` wrapper needs `position: relative` for this to anchor. Check whether it already has it; add it to that wrapper's rule if not.

- [ ] **Step 7: Bump the service worker**

`public/sw.js` — `const CACHE = 'timekeeper-vNNN';` → the next number. Once, here, covering every `public/**` change in Stage A.

- [ ] **Step 8: Verify**

```bash
npm test                        # all green
node scripts/e2e-smoke.mjs      # ALL CLEAR, new step included
```

If the e2e step `stalled time: banner pill → Export filtered` fails, check master before blaming this change — it is known to be order- and state-sensitive (noted 2026-08-30).

- [ ] **Step 9: Commit**

```bash
git add public/js/components/ghosttext.js public/js/components/entryeditor.js \
        public/js/components/entrylist.js public/js/components/closeout.js \
        public/css/app.css public/sw.js scripts/e2e-smoke.mjs
git commit -m "feat(ghost): entity predictions in every narrative field, ↓ for the list"
git push
```

**Stage A is done here.** The predictions work end to end and nothing can edit them yet. Stop, use it for a day, and let what actually annoys you shape Stage B.

---

## Stage B — the editable dictionary

### Task 8: `/api/dictionary` CRUD

**Files:**
- Create: `server/routes/dictionary.js`
- Modify: `server/app.js` (mount it, beside the other small routers around line 43)
- Test: `test/api.dictionary.test.js` (create)

**Interfaces:**
- Produces: `dictionaryRouter({ db, clock })`.
  - `GET /api/dictionary?matter_id=` → `{ rows: [...] }`. No `matter_id` = the global rows only. With one = that matter's rows followed by the global rows. Every row carries `id, matter_id, name, kind, count, last_seen_at, origin, hidden, locked`.
  - `POST /api/dictionary` `{ name, kind, matter_id? }` → 201 with the row. `matter_id` absent or null files a global row.
  - `PATCH /api/dictionary/:id` `{ name?, kind?, hidden? }` → the updated row. Changing `name` or `kind` sets `locked=1`.
  - `DELETE /api/dictionary/:id` → `{ ok: true, hidden: bool }`. A manual row is deleted; a derived row is hidden instead.

- [ ] **Step 1: Write the failing test**

Create `test/api.dictionary.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

async function withServer(fn) {
  const t = await startTestServer();
  try { await fn(t); } finally { await t.close(); }
}

const KINDS = ['document', 'org', 'person'];

test('dictionary: add a global row, list it, rename it', () =>
  withServer(async (t) => {
    const made = await t.fetchJson('POST', '/api/dictionary',
      { name: 'Standard Form Lease', kind: 'document' });
    assert.equal(made.status, 201);
    assert.equal(made.body.matter_id, null);
    assert.equal(made.body.origin, 'manual');

    const list = await t.fetchJson('GET', '/api/dictionary');
    assert.deepEqual(list.body.rows.map((r) => r.name), ['Standard Form Lease']);

    const patched = await t.fetchJson('PATCH', `/api/dictionary/${made.body.id}`,
      { name: 'Standard Lease Form' });
    assert.equal(patched.body.name, 'Standard Lease Form');
    assert.equal(patched.body.locked, 1);
  }));

test('dictionary: validation', () =>
  withServer(async (t) => {
    assert.equal((await t.fetchJson('POST', '/api/dictionary',
      { name: '   ', kind: 'document' })).status, 400);
    assert.equal((await t.fetchJson('POST', '/api/dictionary',
      { name: 'Thing', kind: 'gadget' })).status, 400);
    assert.equal((await t.fetchJson('POST', '/api/dictionary',
      { name: 'Thing', kind: 'org', matter_id: 9999 })).status, 404);
    await t.fetchJson('POST', '/api/dictionary', { name: 'Thing', kind: 'org' });
    assert.equal((await t.fetchJson('POST', '/api/dictionary',
      { name: 'thing', kind: 'org' })).status, 409);
    assert.equal((await t.fetchJson('PATCH', '/api/dictionary/9999',
      { name: 'x' })).status, 404);
    for (const kind of KINDS) {
      assert.equal((await t.fetchJson('POST', '/api/dictionary',
        { name: `Row ${kind}`, kind })).status, 201);
    }
  }));

test('dictionary: deleting a derived row hides it, deleting a manual row removes it', () =>
  withServer(async (t) => {
    const cm = (await t.fetchJson('POST', '/api/cms',
      { cm_number: '100001-000012', short_name: 'Cedar Lease' })).body;
    await t.fetchJson('POST', '/api/entries', {
      date: '2026-08-20', cm_id: cm.id,
      narrative: 'Revise the Access Agreement.',
      tasks: [{ task_code: 'Revise', duration: 0.5, fragment: '' }],
    });
    const rows = (await t.fetchJson('GET', `/api/dictionary?matter_id=${cm.id}`)).body.rows;
    const derived = rows.find((r) => r.name === 'Access Agreement');
    assert.equal(derived.origin, 'derived');

    const gone = await t.fetchJson('DELETE', `/api/dictionary/${derived.id}`);
    assert.equal(gone.body.hidden, true);
    const still = (await t.fetchJson('GET', `/api/dictionary?matter_id=${cm.id}`)).body.rows
      .find((r) => r.id === derived.id);
    assert.equal(still.hidden, 1);   // listed, so he can undo it

    const manual = (await t.fetchJson('POST', '/api/dictionary',
      { name: 'Typed Row', kind: 'org', matter_id: cm.id })).body;
    const removed = await t.fetchJson('DELETE', `/api/dictionary/${manual.id}`);
    assert.equal(removed.body.hidden, false);
    assert.ok(!(await t.fetchJson('GET', `/api/dictionary?matter_id=${cm.id}`)).body.rows
      .some((r) => r.id === manual.id));
  }));

test('dictionary: a matter listing carries its own rows then the global ones', () =>
  withServer(async (t) => {
    const cm = (await t.fetchJson('POST', '/api/cms',
      { cm_number: '100001-000012', short_name: 'Cedar Lease' })).body;
    await t.fetchJson('POST', '/api/dictionary', { name: 'Global Form', kind: 'document' });
    await t.fetchJson('POST', '/api/dictionary',
      { name: 'Matter Thing', kind: 'org', matter_id: cm.id });
    const rows = (await t.fetchJson('GET', `/api/dictionary?matter_id=${cm.id}`)).body.rows;
    assert.deepEqual(rows.map((r) => r.name), ['Matter Thing', 'Global Form']);
  }));

test('dictionary: a hidden row stops predicting immediately', () =>
  withServer(async (t) => {
    const cm = (await t.fetchJson('POST', '/api/cms',
      { cm_number: '100001-000012', short_name: 'Cedar Lease' })).body;
    for (const date of ['2026-08-20', '2026-08-21']) {
      await t.fetchJson('POST', '/api/entries', {
        date, cm_id: cm.id, narrative: 'Revise the Access Agreement.',
        tasks: [{ task_code: 'Revise', duration: 0.4, fragment: '' }],
      });
    }
    const before = await t.fetchJson('GET', `/api/matters/${cm.id}/suggestions`);
    assert.ok(before.body.entities.some((e) => e.name === 'Access Agreement'));

    const row = (await t.fetchJson('GET', `/api/dictionary?matter_id=${cm.id}`)).body.rows
      .find((r) => r.name === 'Access Agreement');
    await t.fetchJson('DELETE', `/api/dictionary/${row.id}`);

    const after = await t.fetchJson('GET', `/api/matters/${cm.id}/suggestions`);
    assert.ok(!after.body.entities.some((e) => e.name === 'Access Agreement'));
  }));
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test test/api.dictionary.test.js`
Expected: FAIL — every request 404s; the router is not mounted.

- [ ] **Step 3: Write the router**

Create `server/routes/dictionary.js`:

```js
import { Router } from 'express';

// The entity dictionary the attorney maintains by hand (spec 2026-08-30). The
// rows are mostly DERIVED from his entries, so this API is careful about the
// difference: it may add, rename, retype and hide, but it never pretends to
// delete something the extractor will simply find again on the next entry
// write. Deleting a derived row hides it; that is the honest operation.
//
// matter_id null = a global row, offered on every matter and ranked last.
const KINDS = new Set(['document', 'org', 'person']);
const COLS = `id, matter_id, name, derived_name, kind, count, last_seen_at,
  origin, hidden, locked`;

export function dictionaryRouter({ db }) {
  const r = Router();
  const get = db.prepare(`SELECT ${COLS} FROM matter_entities WHERE id=?`);

  // Own rows first, then the global ones: the same order the ghost ranks in,
  // so the page reads the way the predictions behave.
  r.get('/', (req, res) => {
    const raw = req.query.matter_id;
    if (raw == null || raw === '') {
      return res.json({
        rows: db.prepare(
          `SELECT ${COLS} FROM matter_entities WHERE matter_id IS NULL
             ORDER BY kind, name COLLATE NOCASE`).all(),
      });
    }
    const matterId = Number(raw);
    if (!db.prepare('SELECT id FROM matters WHERE id=?').get(matterId)) {
      return res.status(404).json({ error: 'Matter not found.' });
    }
    res.json({
      rows: db.prepare(
        `SELECT ${COLS} FROM matter_entities
           WHERE matter_id = ? OR matter_id IS NULL
           ORDER BY (matter_id IS NULL), kind, name COLLATE NOCASE`).all(matterId),
    });
  });

  r.post('/', (req, res) => {
    const b = req.body || {};
    const name = String(b.name || '').replace(/\s+/g, ' ').trim();
    const kind = String(b.kind || '');
    const matterId = b.matter_id == null || b.matter_id === '' ? null : Number(b.matter_id);
    if (!name || name.length > 120) {
      return res.status(400).json({ error: 'Name must be 1–120 characters.' });
    }
    if (!KINDS.has(kind)) {
      return res.status(400).json({ error: 'Kind must be document, org or person.' });
    }
    if (matterId != null && !db.prepare('SELECT id FROM matters WHERE id=?').get(matterId)) {
      return res.status(404).json({ error: 'Matter not found.' });
    }
    try {
      const info = db.prepare(
        `INSERT INTO matter_entities (matter_id, name, kind, origin) VALUES (?, ?, ?, 'manual')`
      ).run(matterId, name, kind);
      res.status(201).json(get.get(info.lastInsertRowid));
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) {
        return res.status(409).json({ error: `"${name}" is already in the dictionary here.` });
      }
      throw e;
    }
  });

  r.patch('/:id', (req, res) => {
    const row = get.get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Dictionary entry not found.' });
    const b = req.body || {};
    const name = b.name === undefined ? row.name : String(b.name).replace(/\s+/g, ' ').trim();
    const kind = b.kind === undefined ? row.kind : String(b.kind);
    const hidden = b.hidden === undefined ? row.hidden : (b.hidden ? 1 : 0);
    if (!name || name.length > 120) {
      return res.status(400).json({ error: 'Name must be 1–120 characters.' });
    }
    if (!KINDS.has(kind)) {
      return res.status(400).json({ error: 'Kind must be document, org or person.' });
    }
    // Editing name or kind locks the row: the next rebuild refreshes its
    // count but must never write his wording back to the extractor's.
    const locked = (name !== row.name || kind !== row.kind) ? 1 : row.locked;
    try {
      db.prepare('UPDATE matter_entities SET name=?, kind=?, hidden=?, locked=? WHERE id=?')
        .run(name, kind, hidden, locked, row.id);
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) {
        return res.status(409).json({ error: `"${name}" is already in the dictionary here.` });
      }
      throw e;
    }
    res.json(get.get(row.id));
  });

  r.delete('/:id', (req, res) => {
    const row = get.get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Dictionary entry not found.' });
    if (row.origin === 'manual') {
      db.prepare('DELETE FROM matter_entities WHERE id=?').run(row.id);
      return res.json({ ok: true, hidden: false });
    }
    // A derived row deleted outright returns on the next entry write. Hiding
    // is the operation that actually holds.
    db.prepare('UPDATE matter_entities SET hidden=1 WHERE id=?').run(row.id);
    res.json({ ok: true, hidden: true });
  });

  return r;
}
```

Mount it in `server/app.js`, beside the other small routers:

```js
  app.use('/api/dictionary', dictionaryRouter(deps));
```

with the matching import at the top of the file.

- [ ] **Step 4: Run the tests and watch them pass**

Run: `node --test test/api.dictionary.test.js` — PASS.
Run: `npm test` — all green.

- [ ] **Step 5: Restart and commit**

```bash
systemctl --user restart timekeeper && curl -s localhost:4747/api/health
git add server/routes/dictionary.js server/app.js test/api.dictionary.test.js
git commit -m "feat(dictionary): CRUD for the entity dictionary"
git push
```

---

### Task 9: Settings → Dictionary

**Files:**
- Modify: `public/js/views/settings.js` (add the category and the card)
- Modify: `public/css/app.css` (a couple of rules)
- Modify: `public/sw.js` (bump `CACHE` — once, here, for Stage B)
- Test: `scripts/e2e-smoke.mjs` (append a step)

**Interfaces:**
- Consumes: `/api/dictionary` (Task 8), `CmPicker` from `public/js/components/cmpicker.js` — its props are `{ value, onChange, autoFocus, allowCreate, placeholder }`; pass `allowCreate=${false}` here, because picking a scope must never create a matter.

- [ ] **Step 1: Write the failing e2e step**

Append near the other settings step in `scripts/e2e-smoke.mjs`:

```js
await step('settings: dictionary page adds a global row and hides it again', async () => {
  await page.goto(`${base}/#/settings/dictionary`, { waitUntil: 'domcontentloaded' });
  await waitFor('.dictionary-card');
  await type('.dictionary-card input[placeholder="Name"]', 'Standard Form Lease');
  await clickText('.dictionary-card button', 'Add');
  await page.waitForFunction(
    () => [...document.querySelectorAll('.dictionary-card td')]
      .some((td) => td.textContent.includes('Standard Form Lease')), { timeout: 4000 });

  await page.click('.dictionary-card tbody tr button[title="Hide"]');
  await page.waitForFunction(
    () => !!document.querySelector('.dictionary-card tbody tr.hidden-row'), { timeout: 4000 });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node scripts/e2e-smoke.mjs`
Expected: FAIL — no `.dictionary-card`.

- [ ] **Step 3: Add the category**

In `public/js/views/settings.js`:

```js
export const SETTINGS_CATEGORIES = [
  ['general', 'General'],
  ['ai', 'AI assist'],
  ['export', '.TIM export'],
  ['codes', 'Codes & shortcuts'],
  ['dictionary', 'Dictionary'],
  ['validation', 'Validation'],
  ['server', 'Remote & backups'],
];
```

and in `pages`:

```js
    dictionary: [html`<${DictionaryCard} key="dictionary" />`],
```

- [ ] **Step 4: Write the card**

Add to `public/js/views/settings.js`, following `ShortcutsCard`'s shape:

```js
const KIND_LABEL = { document: 'Document', org: 'Organisation', person: 'Person' };

// The entity dictionary behind ghost text (spec 2026-08-30). Most rows are
// derived from his own entries; this page is where a wrong one gets fixed and
// a missing one gets added. Hidden rows stay listed, struck through — a
// suppressed row he cannot see is a row he cannot restore.
function DictionaryCard() {
  const [scope, setScope] = useState(null);   // null = global rows
  const [rows, setRows] = useState([]);
  const [name, setName] = useState('');
  const [kind, setKind] = useState('document');

  const load = async () => {
    const q = scope ? `?matter_id=${scope.id}` : '';
    setRows((await api.get(`/api/dictionary${q}`)).rows);
  };
  useEffect(() => { load().catch((e) => emitToast(e.message, { error: true })); }, [scope]);

  const guard = (p) => p.then(load).catch((e) => emitToast(e.message, { error: true }));

  return html`
    <div class="card dictionary-card">
      <h2>Dictionary</h2>
      <p class="muted small">
        The documents, organisations and people ghost text offers while you type.
        Most of these are read out of your own entries — fix a wrong one here, or add
        one the app has not seen yet. A row needs two sightings before it starts
        predicting; one you add by hand predicts straight away.
      </p>

      <${Field} label="Scope" hint="Global rows are offered on every matter, ranked last.">
        <div class="row">
          <button class=${`btn btn-sm ${scope ? '' : 'on'}`}
            onClick=${() => setScope(null)}>Global</button>
          <${CmPicker} value=${scope} onChange=${setScope} allowCreate=${false}
            placeholder="…or one matter" />
        </div>
      <//>

      <div class="row">
        <input placeholder="Name" value=${name} onInput=${(e) => setName(e.target.value)} />
        <select value=${kind} onChange=${(e) => setKind(e.target.value)}>
          ${Object.entries(KIND_LABEL).map(([k, label]) => html`
            <option key=${k} value=${k}>${label}</option>`)}
        </select>
        <button class="btn btn-sm" onClick=${() => {
          if (!name.trim()) return;
          guard(api.post('/api/dictionary', {
            name, kind, matter_id: scope ? scope.id : null,
          }).then(() => setName('')));
        }}>Add</button>
      </div>

      ${rows.length === 0 ? html`<p class="muted small">Nothing here yet.</p>` : html`
        <div class="table-wrap"><table class="tk">
          <thead><tr>
            <th>Name</th><th>Kind</th><th>Uses</th><th>Last used</th><th>Where</th><th></th>
          </tr></thead>
          <tbody>${rows.map((row) => html`
            <tr key=${row.id} class=${row.hidden ? 'hidden-row' : ''}>
              <td>
                <input value=${row.name} class="inline-edit"
                  onBlur=${(e) => e.target.value !== row.name
                    && guard(api.patch(`/api/dictionary/${row.id}`, { name: e.target.value }))} />
              </td>
              <td>
                <select value=${row.kind}
                  onChange=${(e) => guard(api.patch(`/api/dictionary/${row.id}`, { kind: e.target.value }))}>
                  ${Object.entries(KIND_LABEL).map(([k, label]) => html`
                    <option key=${k} value=${k}>${label}</option>`)}
                </select>
              </td>
              <td class=${row.origin === 'derived' && row.count < 2 ? 'muted' : ''}
                  title=${row.origin === 'derived' && row.count < 2 ? 'Not predicting yet — seen once' : ''}>
                ${row.count}
              </td>
              <td class="muted small">${row.last_seen_at || '—'}</td>
              <td class="muted small">
                ${row.matter_id == null ? 'Global' : 'This matter'}${row.origin === 'manual' ? ' · added' : ''}
              </td>
              <td>
                ${row.hidden ? html`
                  <button class="btn btn-ghost btn-sm" title="Unhide"
                    onClick=${() => guard(api.patch(`/api/dictionary/${row.id}`, { hidden: 0 }))}>↩</button>` : html`
                  <button class="btn btn-ghost btn-sm" title="Hide"
                    onClick=${() => guard(api.del(`/api/dictionary/${row.id}`))}>✕</button>`}
              </td>
            </tr>`)}</tbody>
        </table></div>`}
    </div>`;
}
```

Add the imports this needs at the top of `settings.js`: `CmPicker` from `/js/components/cmpicker.js`, and `useEffect` if the file does not already import it.

- [ ] **Step 5: Style the hidden row**

Append to `public/css/app.css`:

```css
/* A hidden dictionary row stays visible, struck through — a suppression he
   cannot see is one he cannot undo. */
.dictionary-card tr.hidden-row td { opacity: .5; }
.dictionary-card tr.hidden-row td:first-child input { text-decoration: line-through; }
.dictionary-card .inline-edit { width: 100%; border: 0; background: none; font: inherit; }
.dictionary-card .inline-edit:focus { background: var(--surface-2); }
```

- [ ] **Step 6: Bump the service worker and verify**

`public/sw.js` — `CACHE` to the next number, once, for Stage B.

```bash
npm test                        # all green
node scripts/e2e-smoke.mjs      # ALL CLEAR, both new steps
```

Then look at it in a browser at a desktop width, and again at ~412px. The table is inside `.table-wrap`, which already scrolls horizontally; check that the scope row wraps rather than pushing the picker off screen.

- [ ] **Step 7: Commit**

```bash
git add public/js/views/settings.js public/css/app.css public/sw.js scripts/e2e-smoke.mjs
git commit -m "feat(settings): an editable dictionary behind ghost text"
git push
```

---

### Task 10: Ship it

**Files:**
- Modify: `TODO.md` (remove the item)
- Modify: `CHANGELOG.md` (one entry per stage, under today's date)

- [ ] **Step 1: Confirm the whole thing is green**

```bash
npm test
node scripts/e2e-smoke.mjs
systemctl --user restart timekeeper && curl -s localhost:4747/api/health
```

- [ ] **Step 2: Watch the backfill actually run**

The entity index for 475 existing entries is built by the `jobs.js` tick, not by the migration. It runs within 30 seconds of the restart. Confirm it happened:

```bash
node -e "
const Database=require('better-sqlite3');
const db=new Database('data/timekeeper.db',{readonly:true});
console.log('entities:', db.prepare('SELECT COUNT(*) c FROM matter_entities').get().c);
console.log('by kind:', db.prepare('SELECT kind, COUNT(*) c FROM matter_entities GROUP BY kind').all());
console.log('predicting (2+ uses):', db.prepare('SELECT COUNT(*) c FROM matter_entities WHERE count>=2').get().c);
"
```

Expected: a few hundred rows, most of them `document` and `person`, and a smaller number at two or more uses. Zero rows means the backfill did not run — check that `memoryBackfillV18` is absent from `jobs_state` and that the tick is firing.

- [ ] **Step 3: Remove the TODO item and write the changelog**

Delete the `2026-08-30 10:55` line from `TODO.md`. Prepend to `CHANGELOG.md` under today's date heading (create it if today's is missing), one entry per stage — they shipped separately and they read separately.

- [ ] **Step 4: Commit and push**

```bash
git add TODO.md CHANGELOG.md
git commit -m "docs: close out the entity ghost-text item"
git push
```

---

## Notes for whoever executes this

- **Read the spec first.** `docs/superpowers/specs/2026-08-30-entity-ghost-text-design.md`. It carries the reasoning and the ⚠️ assumptions; this plan carries only the moves.
- **The ⚠️ items are David's to overrule, not yours.** If one looks wrong while you are in the code, say so and ask. Do not quietly do it differently.
- **Task 4 is the one to be careful with.** Everything else can be rewritten later at the cost of an afternoon. A rebuild that forgets `hidden` or `locked` destroys work the attorney did by hand, silently, and there is no undo for it.
- **Do not tune the trigger sets by imagination.** They are throttles on how often the ghost fires, and the only real evidence is a day of use. Ship Stage A, wait, then tune.
- **The e2e step `stalled time: banner pill → Export filtered` is order- and state-sensitive** (found 2026-08-30: it failed on master, and passed once an unrelated new step filed a little more time before it). If it fails, check master before blaming your change.
- **Never put a real client, matter or person name anywhere** — not in a test fixture, not in a comment, not in a commit message. The sanity checks in Tasks 2 and 10 print real names to your terminal on purpose; do not paste that output anywhere.
