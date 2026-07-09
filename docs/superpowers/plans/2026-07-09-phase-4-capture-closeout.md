# Phase 4 — Capture & Close-out Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the last leg of the flow redesign: bill-from-a-sentence quick capture, the persistent animated today footer, the one-sweep close-out card stack that finalizes AND exports in one motion, the (very subtle) micro-animation language, and the Export view's billing-cadence date presets.

**Architecture:** One new pure parser (`server/lib/quickcapture.js`, unit-tested, consuming the existing `rankMatters` fuzzy search) behind one thin endpoint with an optional non-streaming LLM assist for messy lines (same JSON-contract pattern as `/ai/expand`). Frontend: three new components (`quickcapture.js` palette, `todayfooter.js`, `closeout.js`) — all plain ES modules mounting existing primitives (`GhostInput`, `useMatterSuggestions`, `Modal`-free overlays like StopChips). Close-out reuses `POST /api/finalize-day` + `POST /api/export` verbatim — no new server writes beyond the parse endpoint. Motion is CSS-only, opacity/transform, ≤300ms, gated by `prefers-reduced-motion`.

**Tech Stack:** Node 24 ESM, Express 5, better-sqlite3 (WAL), `node:test`. Frontend: no-build React 18 UMD + htm, plain ES modules in `public/js/`. E2E: `scripts/e2e-smoke.mjs`. AI: local Ollama only, stub-server tests.

## Global Constraints

- Runtime deps stay exactly `express` + `better-sqlite3`. No bundler, ever.
- **No schema changes in this phase** — do not touch `MIGRATIONS`.
- `/api/cms` response shapes and export/CSV/`.TIM` output are unchanged. `POST /api/export` and `POST /api/finalize-day` are consumed as-is, never modified.
- Server business logic = pure functions in `server/lib/*` with `node:test` tests; thin routes; prepared statements. Browser pure logic = zero-import modules in `public/js/lib/*` with tests.
- Tests must NOT depend on a live Ollama (stub pattern in `test/api.ai.test.js`); the e2e runs with AI disabled — no e2e step may require AI.
- `npm test` fully green at the end of every task; tasks touching the frontend also end with `node scripts/e2e-smoke.mjs` → `E2E SMOKE: ALL CLEAR`.
- Binding spec language (§7): **"Keep every animation _very_ subtle — restraint over flourish; when in doubt, less. This is a constraint, not a suggestion."** All motion respects `@media (prefers-reduced-motion: reduce)`.
- Existing keyboard map (do not collide): `n` new entry, `t` toggle last timer, `/` search (timer search on dashboard), `g`+`d/c/s/e` navigation, `?` help, grid arrows/Enter/Space/Alt-nudge/Shift+Enter/Ctrl+Enter, StopChips `1/2/3/e/Esc` (capture phase). **New keys this phase: `q` (global quick capture), `c` (dashboard-only: close the day).** Both must bail when typing in form fields, same as the existing handler.
- Ghost-text mounts in close-out (same `GhostInput`); it does NOT go into the quick-capture bar (spec open question — resolved: quick capture is a one-line parser input, not a narrative field).
- Controller resolution of spec §7 keys: close-out uses **Enter accept · `e` edit · ↓ skip** (spec said "Tab edit", but Tab is the app-wide ghost-accept key — consistency wins; `e` matches the stop-chips edit key).
- Dates are local `YYYY-MM-DD` (box TZ America/Los_Angeles); durations are decimal hours, round-up-to-tenth house rule (`allocateTenths`/rounding libs exist — quick capture rounds with `Math.round(x*10)/10` only for display; the entry POST handles real rounding).

Interface contracts consumed (verified against the tree at planning time):

- `rankMatters(query, matters, { limit }) → matter[]` from `server/lib/matterSearch.js` (AND-token fuzzy; fields incl. `client_name`, `short_name`).
- `GET /api/dashboard` → `{ date, today: { total, billable, nonbillable, target, entryCount }, entries: [enriched entries with .cm, .total, .validation, .narrative_auto], timers: [with elapsed_seconds], alerts: {...} }`.
- `POST /api/finalize-day { date, ack? }` → `{ finalized: [ids], blocked: [{ id, blocks, warns }] }`.
- `POST /api/export { from, to }` → `{ count, csv, text, tim, entry_ids }` and stamps `exported_at` on finalized entries.
- `PATCH /api/entries/:id { narrative }` → updated entry (used by StopChips already).
- `GhostInput({ value, onChange(text), suggestions, expand, multiline, rows, onSelectionChange, ...rest })` and `useMatterSuggestions(cmId) → string[]` from `public/js/components/ghosttext.js`.
- `containsTimeAmounts(text)` from `public/js/lib/timeamounts.js` (browser) / `server/lib/timeAmounts.js` (server).
- `downloadText(name, text)` from `public/js/ui.js` (used by dashboard's `exportToday`).
- Task codes (seeded): Review, Draft, Revise, Research, Correspondence, Call/Conference, Negotiate, Travel, Court Appearance, Due Diligence, Closing.

---

### Task 1: Export view billing-cadence presets (QW1)

**Files:**
- Modify: `public/js/views/exportview.js` (preset row)
- Modify: `scripts/e2e-smoke.mjs` (extend the export step)

**Interfaces:** none produced; purely additive UI.

- [ ] **Step 1: Add the two presets**

In `public/js/views/exportview.js`, the preset row (anchor: the `This week` button). Add immediately after it:

```js
        <button class="btn btn-sm" onClick=${() => {
          const t = todayStr();
          setFrom(t.slice(0, 8) + '01'); setTo(t);
        }}>This month</button>
        <button class="btn btn-sm" onClick=${() => {
          const t = todayStr();
          const firstOfThis = new Date(t.slice(0, 8) + '01T12:00:00');
          const lastMonthEnd = new Date(firstOfThis.getTime() - 86400000);
          const y = lastMonthEnd.getFullYear();
          const m = String(lastMonthEnd.getMonth() + 1).padStart(2, '0');
          const d = String(lastMonthEnd.getDate()).padStart(2, '0');
          setFrom(`${y}-${m}-01`); setTo(`${y}-${m}-${d}`);
        }}>Last month</button>
```

(Local-time month math via noon-anchored Date to dodge DST edges; `todayStr`/`addDays` already exist in the file — reuse, don't re-implement.)

- [ ] **Step 2: e2e assertion**

In `scripts/e2e-smoke.mjs`, inside the existing export-view step (anchor: the step asserting CSV/.TIM/text buttons), add: click the `This month` button (use the existing `clickText` helper), then assert the `from` date input's value ends in `-01` and the `to` input equals today's date (compute in `page.evaluate` with `new Date()` local parts).

- [ ] **Step 3: Verify + commit**

Run: `npm test` → PASS. Run: `node scripts/e2e-smoke.mjs` → `E2E SMOKE: ALL CLEAR`.

```bash
git add public/js/views/exportview.js scripts/e2e-smoke.mjs
git commit -m "feat(ui): This month / Last month presets on the Export view"
```

---

### Task 2: `server/lib/quickcapture.js` — pure bill-from-a-sentence parser

**Files:**
- Create: `server/lib/quickcapture.js`
- Test: `test/quickcapture.test.js`

**Interfaces:**
- Consumes: `rankMatters` from `server/lib/matterSearch.js`.
- Produces: `parseQuickCapture(line, { matters, taskCodes }) → { hours, task_code, person, topic, narrative, matterQuery, matches, missing }` — Task 3's endpoint and its tests rely on this exact shape. `matches` is `rankMatters(matterQuery, matters, { limit: 3 })` (empty when no query); `missing` is an array drawn from `'matter' | 'hours' | 'action'`.

Parsing rules (documented in the file header):
- **Duration** — first token matching `.3` / `0.3` / `1.25` (bare decimals ≤ 12), `18m` / `90min` (minutes → hours/60), `1h` / `1.5h` / `2hr` / `2hrs`. Token is consumed (removed from the remaining text). Missing → `hours: null`, `'hours'` in `missing`.
- **Action verb** — the FIRST word of the line, matched case-insensitively against a verb map: call/called/tc/phone → Call/Conference; email/emailed/e-mail/corr/correspondence/letter → Correspondence; draft/drafted/prepare/prepared → Draft; revise/revised/edit/edited → Revise; review/reviewed/read → Review; research/researched → Research; negotiate/negotiated → Negotiate; travel → Travel; meet/meeting/conference/confer → Call/Conference; only mapped if that task code exists in `taskCodes` (case-insensitive). No match → `task_code: null`, `'action'` in `missing`, and the first word is NOT consumed (it stays in the topic).
- **Counterparty** — `w/ Name` or `with Name` after the verb: `Name` = the following 1–2 capitalized-or-lowercase word tokens up to `re`/`re:`/duration/end. Captured as `person` (title-cased word by word), consumed.
- **Topic / matter query** — everything after `re` / `re:` (consumed marker), minus the duration token, is BOTH the `topic` and the `matterQuery`. If there is no `re`, the leftover tokens (after verb/person/duration consumption) serve as both.
- **Narrative stub** — Call/Conference → `Telephone conference with {person}` + (topic ? ` regarding {topic}` : ''); Correspondence → `Correspondence with {person}` + same; other codes → `{TaskCodeVerbForm} {topic}` where the verb form is the mapped first word capitalized (e.g. "Draft", "Review") — fall back to the task code word itself; no person → drop the "with" clause. Trimmed; empty when nothing to say.
- Pure and deterministic; no dates, no db, no LLM.

- [ ] **Step 1: Write the failing tests**

Create `test/quickcapture.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseQuickCapture } from '../server/lib/quickcapture.js';

const MATTERS = [
  { id: 1, short_name: 'Loading Dock Lease', client_name: 'Meridian', cm_number: '100001-000012', matter_number: '000012', client_number: '100001' },
  { id: 2, short_name: 'Harbor drafting', client_name: 'Meridian', cm_number: '100001-000099', matter_number: '000099', client_number: '100001' },
  { id: 3, short_name: 'Summit Development Agreement', client_name: 'Ironwood', cm_number: '100005-000001', matter_number: '000001', client_number: '100005' },
];
const CODES = ['Review', 'Draft', 'Revise', 'Research', 'Correspondence', 'Call/Conference', 'Negotiate', 'Travel'];
const parse = (line) => parseQuickCapture(line, { matters: MATTERS, taskCodes: CODES });

test('the spec example: call sam re loading dock lease .3', () => {
  const p = parse('call sam re loading dock lease .3');
  assert.equal(p.hours, 0.3);
  assert.equal(p.task_code, 'Call/Conference');
  assert.equal(p.person, 'Sam');
  assert.equal(p.topic, 'loading dock lease');
  assert.equal(p.narrative, 'Telephone conference with Sam regarding loading dock lease');
  assert.equal(p.matches[0].id, 1); // "loading dock" fuzzy-matches the lease matter
  assert.deepEqual(p.missing, []);
});

test('minutes and h-suffix durations', () => {
  assert.equal(parse('review lease 18m').hours, 0.3);
  assert.equal(parse('review lease 90min').hours, 1.5);
  assert.equal(parse('draft psa 1.5h').hours, 1.5);
  assert.equal(parse('draft psa 2hrs').hours, 2);
  assert.equal(parse('draft psa 0.4').hours, 0.4);
});

test('with-counterparty and correspondence mapping', () => {
  const p = parse('email w/ Alex Turner re summit development 0.2');
  assert.equal(p.task_code, 'Correspondence');
  assert.equal(p.person, 'Alex Turner');
  assert.equal(p.narrative, 'Correspondence with Alex Turner regarding summit development');
  assert.equal(p.matches[0].id, 3);
});

test('no re-marker: leftover tokens are the matter query', () => {
  const p = parse('revise harbor .5');
  assert.equal(p.task_code, 'Revise');
  assert.equal(p.topic, 'harbor');
  assert.equal(p.matches[0].id, 2);
  assert.equal(p.narrative, 'Revise harbor');
});

test('missing pieces are reported, first word kept when not a verb', () => {
  const p = parse('zoning setback issue');
  assert.equal(p.hours, null);
  assert.equal(p.task_code, null);
  assert.equal(p.topic, 'zoning setback issue');
  assert.deepEqual(p.missing.sort(), ['action', 'hours', 'matter']);
});

test('matter missing only when nothing matches', () => {
  const p = parse('call re nonexistent gibberish xyzzy .3');
  assert.ok(p.missing.includes('matter'));
  assert.deepEqual(p.matches, []);
});

test('empty and junk input', () => {
  const p = parse('   ');
  assert.deepEqual(p.missing.sort(), ['action', 'hours', 'matter']);
  assert.equal(p.narrative, '');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/quickcapture.test.js` — Expected: FAIL, `Cannot find module '../server/lib/quickcapture.js'`.

- [ ] **Step 3: Implement**

Create `server/lib/quickcapture.js`:

```js
import { rankMatters } from './matterSearch.js';

// Bill-from-a-sentence parser (spec §6, magic #1): one raw line —
// "call sam re loading dock lease .3" — into a proposed entry.
// Pure and deterministic; the LLM fallback for messy lines lives in the
// route (server/routes/quickcapture.js), never here.
//
// Grammar (all parts optional; `missing` reports what wasn't found):
//   <verb> [w/|with <Person…>] [re|re: <topic…>] [<duration>]
// - duration: ".3" "0.3" "1.25" (bare decimal ≤ 12) | "18m"/"90min" | "1h"/"1.5h"/"2hr(s)"
// - verb: first word, mapped to a task code (only if that code exists)
// - person: 1–2 tokens after w/ or with, stopped by re/duration/end
// - topic: text after re/re: (minus the duration) — doubles as the matter
//   fuzzy query; without re, the unconsumed remainder is used
// - narrative stub by code: Call/Conference → "Telephone conference with P
//   regarding T"; Correspondence → "Correspondence with P regarding T";
//   otherwise "<Verb> T".

const VERB_MAP = new Map(Object.entries({
  call: 'Call/Conference', called: 'Call/Conference', tc: 'Call/Conference', phone: 'Call/Conference',
  meet: 'Call/Conference', meeting: 'Call/Conference', conference: 'Call/Conference', confer: 'Call/Conference',
  email: 'Correspondence', emailed: 'Correspondence', 'e-mail': 'Correspondence',
  corr: 'Correspondence', correspondence: 'Correspondence', letter: 'Correspondence',
  draft: 'Draft', drafted: 'Draft', prepare: 'Draft', prepared: 'Draft',
  revise: 'Revise', revised: 'Revise', edit: 'Revise', edited: 'Revise',
  review: 'Review', reviewed: 'Review', read: 'Review',
  research: 'Research', researched: 'Research',
  negotiate: 'Negotiate', negotiated: 'Negotiate',
  travel: 'Travel',
}));

const DUR_RE = /^(?:(\d*\.\d+|\d+(?:\.\d+)?)(h|hrs?|)|(\d+)(m|min))$/i;

function parseDuration(token) {
  const m = DUR_RE.exec(token);
  if (!m) return null;
  if (m[3]) return Math.round((Number(m[3]) / 60) * 100) / 100; // minutes
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0 || n > 12) return null;
  if (!m[2] && !token.includes('.')) return null; // bare "3" is too ambiguous
  return n;
}

const titleCase = (w) => (w ? w[0].toUpperCase() + w.slice(1) : w);

export function parseQuickCapture(line, { matters = [], taskCodes = [] } = {}) {
  const tokens = String(line || '').trim().split(/\s+/).filter(Boolean);
  const codeSet = new Map(taskCodes.map((c) => [String(c).toLowerCase(), c]));

  // 1. duration: first parseable token anywhere, consumed
  let hours = null;
  for (let i = 0; i < tokens.length; i++) {
    const h = parseDuration(tokens[i]);
    if (h != null) { hours = h; tokens.splice(i, 1); break; }
  }

  // 2. verb: first word
  let task_code = null;
  let verbWord = null;
  if (tokens.length) {
    const mapped = VERB_MAP.get(tokens[0].toLowerCase());
    if (mapped && codeSet.has(mapped.toLowerCase())) {
      task_code = codeSet.get(mapped.toLowerCase());
      verbWord = tokens.shift();
    }
  }

  // 3. person: "w/ X [Y]" or "with X [Y]"
  let person = null;
  const wIdx = tokens.findIndex((t) => /^(w\/|with)$/i.test(t));
  if (wIdx !== -1) {
    const stop = (t) => /^re:?$/i.test(t);
    const names = [];
    let j = wIdx + 1;
    while (j < tokens.length && names.length < 2 && !stop(tokens[j])) { names.push(tokens[j]); j++; }
    if (names.length) {
      person = names.map(titleCase).join(' ');
      tokens.splice(wIdx, 1 + names.length);
    }
  }

  // 4. topic: after "re"/"re:", else the remainder
  let topicTokens;
  const reIdx = tokens.findIndex((t) => /^re:?$/i.test(t));
  if (reIdx !== -1) topicTokens = tokens.slice(reIdx + 1);
  else topicTokens = tokens.slice(task_code ? 0 : 0); // remainder (verb already consumed)
  const topic = topicTokens.join(' ');

  // 5. matter match from the topic
  const matterQuery = topic;
  const matches = matterQuery ? rankMatters(matterQuery, matters, { limit: 3 }) : [];

  // 6. narrative stub
  let narrative = '';
  if (task_code === 'Call/Conference') {
    narrative = `Telephone conference${person ? ` with ${person}` : ''}${topic ? ` regarding ${topic}` : ''}`;
  } else if (task_code === 'Correspondence') {
    narrative = `Correspondence${person ? ` with ${person}` : ''}${topic ? ` regarding ${topic}` : ''}`;
  } else if (task_code) {
    narrative = `${titleCase(verbWord || task_code)}${topic ? ` ${topic}` : ''}`;
  } else {
    narrative = topic;
  }
  narrative = narrative.trim();
  if (!task_code && !topic) narrative = '';

  const missing = [];
  if (matches.length === 0) missing.push('matter');
  if (hours == null) missing.push('hours');
  if (!task_code) missing.push('action');

  return { hours, task_code, person, topic, narrative, matterQuery, matches, missing };
}
```

- [ ] **Step 4: Run to green, adjust only the implementation (not the tests) until PASS**

Run: `node --test test/quickcapture.test.js` — Expected: PASS (7 tests). If a rule is genuinely ambiguous, the tests are the contract.

- [ ] **Step 5: Full suite + commit**

Run: `npm test` → PASS.

```bash
git add server/lib/quickcapture.js test/quickcapture.test.js
git commit -m "feat(lib): bill-from-a-sentence quick-capture parser"
```

---

### Task 3: `POST /api/quickcapture` — thin route + optional LLM assist for messy lines

**Files:**
- Create: `server/routes/quickcapture.js`
- Modify: `server/app.js` (import + mount after the shortcuts mount)
- Test: `test/api.quickcapture.test.js`

**Interfaces:**
- Consumes: `parseQuickCapture` (Task 2); `getSetting`, `DEFAULT_AI_INSTRUCTIONS` pattern from `server/routes/ai.js` (own JSON prompt here); `containsTimeAmounts` from `server/lib/timeAmounts.js`.
- Produces: `POST /api/quickcapture { line, ai? }` → `{ hours, task_code, person, topic, narrative, matterQuery, matches: [{id, cm_number, short_name, client_name}], missing }`. With `ai: true` AND fields missing AND AI enabled: one non-streaming Ollama call (JSON contract) fills ONLY the missing fields; deterministic results are never overwritten; LLM narrative suggestions containing time amounts are discarded. AI disabled + `ai: true` → same deterministic result (no error). Task 4's UI relies on this exact shape.

- [ ] **Step 1: Failing tests**

Create `test/api.quickcapture.test.js` (reuse `startTestServer` from `./helpers.js`; for the AI case reuse the `startStubOllama` pattern — import it if exported, else copy the ~25-line stub helper as `test/api.ai.test.js` defines it, with a comment pointing at the original):

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { startTestServer } from './helpers.js';
import { setSetting } from '../server/db.js';

function startStubOllama(chatBody) {
  return new Promise((resolve) => {
    const srv = createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => res.end(JSON.stringify({ message: { role: 'assistant', content: chatBody } })));
    });
    srv.listen(0, '127.0.0.1', () => resolve({
      url: `http://127.0.0.1:${srv.address().port}`,
      close: () => new Promise((r) => srv.close(r)),
    }));
  });
}

async function seed(t) {
  const cm = (await t.fetchJson('POST', '/api/cms',
    { cm_number: '100001-000012', short_name: 'Loading Dock Lease', client_name: 'Meridian' })).body;
  return cm;
}

test('deterministic parse over the live matter list', async () => {
  const t = await startTestServer();
  try {
    const cm = await seed(t);
    const r = await t.fetchJson('POST', '/api/quickcapture', { line: 'call sam re loading dock .3' });
    assert.equal(r.status, 200);
    assert.equal(r.body.hours, 0.3);
    assert.equal(r.body.task_code, 'Call/Conference');
    assert.equal(r.body.matches[0].id, cm.id);
    assert.deepEqual(r.body.missing, []);
  } finally { await t.close(); }
});

test('400 on empty line; archived matters excluded from matching', async () => {
  const t = await startTestServer();
  try {
    const cm = await seed(t);
    assert.equal((await t.fetchJson('POST', '/api/quickcapture', {})).status, 400);
    await t.fetchJson('PATCH', `/api/cms/${cm.id}`, { status: 'archived' });
    const r = await t.fetchJson('POST', '/api/quickcapture', { line: 'call re loading dock .3' });
    assert.ok(r.body.missing.includes('matter'));
  } finally { await t.close(); }
});

test('ai:true fills ONLY missing fields; deterministic wins; amounts rejected', async () => {
  const stub = await startStubOllama(JSON.stringify({
    hours: 2.5, task_code: 'Research', topic: 'zoning setback',
    narrative: 'Research zoning setback requirements (0.5)',
  }));
  const t = await startTestServer();
  try {
    await seed(t);
    setSetting(t.db, 'ai', { enabled: true, model: 'llama3.1:8b', url: stub.url });
    const r = await t.fetchJson('POST', '/api/quickcapture', { line: 'zoning setback question .3', ai: true });
    assert.equal(r.body.hours, 0.3, 'deterministic duration is kept');
    assert.equal(r.body.task_code, 'Research', 'missing action filled by the model');
    assert.ok(!r.body.narrative.includes('(0.5)'), 'amount-laden narrative discarded');
  } finally { await t.close(); await stub.close(); }
});

test('ai:true with AI disabled degrades to the deterministic result', async () => {
  const t = await startTestServer();
  try {
    await seed(t);
    const r = await t.fetchJson('POST', '/api/quickcapture', { line: 'zoning setback question', ai: true });
    assert.equal(r.status, 200);
    assert.ok(r.body.missing.includes('action'));
  } finally { await t.close(); }
});
```

- [ ] **Step 2: Verify failure** — `node --test test/api.quickcapture.test.js` → FAIL (404 not_found).

- [ ] **Step 3: Implement the route**

Create `server/routes/quickcapture.js`:

```js
import { Router } from 'express';
import { getSetting } from '../db.js';
import { parseQuickCapture } from '../lib/quickcapture.js';
import { containsTimeAmounts } from '../lib/timeAmounts.js';

// Bill from a sentence (spec §6): deterministic parse first (pure lib);
// optional single non-streaming LLM pass fills ONLY the fields the parser
// couldn't — deterministic results are never overwritten. The UI files the
// approved entry itself via POST /api/entries.
const MATTER_COLS = `m.id, m.cm_number, m.matter_number, m.short_name,
  m.favorite, m.last_used_at, c.name AS client_name, c.client_number`;

export function quickCaptureRouter({ db }) {
  const r = Router();

  r.post('/quickcapture', async (req, res) => {
    const line = String((req.body || {}).line || '').trim();
    if (!line) return res.status(400).json({ error: 'Type something first.' });
    const matters = db.prepare(`SELECT ${MATTER_COLS} FROM matters m
      LEFT JOIN clients c ON c.id = m.client_id
      WHERE m.status != 'archived'`).all();
    const taskCodes = db.prepare(
      'SELECT name FROM task_codes WHERE active=1 ORDER BY sort_order, id').all().map((x) => x.name);

    const parsed = parseQuickCapture(line, { matters, taskCodes });

    const cfg = getSetting(db, 'ai') || {};
    if ((req.body || {}).ai && cfg.enabled && parsed.missing.length > 0) {
      try {
        const filled = await llmFill(cfg, line, parsed, taskCodes);
        for (const k of ['hours', 'task_code', 'person', 'topic']) {
          if (parsed[k] == null && filled[k] != null) parsed[k] = filled[k];
        }
        if (filled.narrative && !containsTimeAmounts(filled.narrative)
            && (!parsed.narrative || parsed.missing.includes('action'))) {
          parsed.narrative = String(filled.narrative).slice(0, 300);
        }
        if (parsed.task_code && !taskCodes.includes(parsed.task_code)) parsed.task_code = null;
        if (parsed.matches.length === 0 && parsed.topic) {
          const re = parseQuickCapture(`re ${parsed.topic}`, { matters, taskCodes });
          parsed.matches = re.matches;
        }
        parsed.missing = [];
        if (parsed.matches.length === 0) parsed.missing.push('matter');
        if (parsed.hours == null) parsed.missing.push('hours');
        if (!parsed.task_code) parsed.missing.push('action');
      } catch { /* model down: deterministic result stands */ }
    }

    parsed.matches = parsed.matches.map((m) => ({
      id: m.id, cm_number: m.cm_number, short_name: m.short_name, client_name: m.client_name,
    }));
    res.json(parsed);
  });

  return r;
}

async function llmFill(cfg, line, parsed, taskCodes) {
  const system = `You extract structured billing data from an attorney's shorthand line.
Respond with ONLY JSON: {"hours": number|null, "task_code": string|null, "person": string|null, "topic": string|null, "narrative": string|null}.
task_code MUST be one of: ${taskCodes.join(', ')} (or null).
Never include time amounts or parentheticals like "(0.5)" inside the narrative.`;
  const resp = await fetch(`${cfg.url}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: cfg.model, stream: false, format: 'json', options: { temperature: 0.2 },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: `Line: ${line}\nAlready determined (do not change): ${JSON.stringify({ hours: parsed.hours, task_code: parsed.task_code })}` },
      ],
    }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!resp.ok) throw new Error(`ollama ${resp.status}`);
  const data = await resp.json();
  try { return JSON.parse(data.message.content); } catch { return {}; }
}
```

In `server/app.js`: `import { quickCaptureRouter } from './routes/quickcapture.js';` next to the other route imports, and `app.use('/api', quickCaptureRouter(deps));` after the shortcuts mount.

- [ ] **Step 4: Green** — `node --test test/api.quickcapture.test.js` → PASS (4 tests). Then `npm test` → PASS.

- [ ] **Step 5: Commit**

```bash
git add server/routes/quickcapture.js server/app.js test/api.quickcapture.test.js
git commit -m "feat(api): /api/quickcapture parse endpoint with optional LLM fill"
```

---

### Task 4: Quick-capture palette UI (global `q`)

**Files:**
- Create: `public/js/components/quickcapture.js`
- Modify: `public/js/app.js` (hotkey + mount + help row)
- Modify: `public/css/app.css` (palette styles)
- Modify: `scripts/e2e-smoke.mjs` (new step)

**Interfaces:**
- Consumes: `POST /api/quickcapture`; `POST /api/entries { date, cm_id, narrative, tasks: [{ task_code, duration, fragment }] }`; `todayLocal`-equivalent client date (`new Date()` local `YYYY-MM-DD` — the app's existing `todayStr` pattern in exportview; reuse `fmtHours` from ui.js).
- Produces: `QuickCapture({ onClose, onFiled })` — a centered overlay (portal, like StopChips — NOT the shared `Modal`: it has its own Escape/Enter handling). `onFiled()` fires after a successful POST so the app can `bumpRefresh()`.

Behavior:
- Centered card, single text input autofocused, placeholder `call sam re loading dock lease .3`.
- Debounced (200ms) `POST /api/quickcapture` as the user types (≥3 chars). Preview row shows: matched matter (top hit; click/⇥-cycle through `matches` — a simple click-to-select list of up to 3), hours, task code, narrative — each rendered as a small chip; missing pieces render as amber `?` chips (e.g. `? hours`).
- If AI is enabled and `missing.length > 0`, show an `AI parse` button → re-POST with `ai: true` (button shows a spinner while waiting; single-shot).
- **Enter** files when nothing is missing: `POST /api/entries { date: today, cm_id: chosen.id, narrative, tasks: [{ task_code, duration: hours, fragment: '' }] }` → toast `Filed ✓ — {hours}h on {short_name}`, `onFiled()`, close. If something is missing, Enter is a no-op (the chips show why).
- **Escape** closes (nothing filed). Clicking the backdrop closes.
- No ghost-text in this bar (decided).

- [ ] **Step 1: Component**

Create `public/js/components/quickcapture.js`:

```js
import { api } from '/js/api.js';
import { html, useState, useEffect, useRef, createPortal, emitToast, fmtHours, Icon } from '/js/ui.js';

// Bill from a sentence (spec §6, magic #1): one line in, a ready-to-approve
// entry out. Deterministic parse previews live; Enter approves and files.
// Deliberately NOT the shared Modal — this owns Enter/Escape itself.

const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export function QuickCapture({ onClose, onFiled }) {
  const [line, setLine] = useState('');
  const [parsed, setParsed] = useState(null);
  const [matterIdx, setMatterIdx] = useState(0);
  const [aiBusy, setAiBusy] = useState(false);
  const [ai, setAi] = useState(null);
  const inputRef = useRef(null);
  const timer = useRef(null);
  const seq = useRef(0);

  useEffect(() => { api.get('/api/ai/status').then(setAi).catch(() => {}); }, []);
  useEffect(() => () => clearTimeout(timer.current), []);

  function requestParse(text, useAi = false) {
    const mySeq = ++seq.current;
    const run = () => api.post('/api/quickcapture', { line: text, ai: useAi })
      .then((p) => { if (seq.current === mySeq) { setParsed(p); setMatterIdx(0); } })
      .catch(() => {})
      .finally(() => { if (useAi) setAiBusy(false); });
    if (useAi) { setAiBusy(true); run(); }
    else { clearTimeout(timer.current); timer.current = setTimeout(run, 200); }
  }

  function onInput(e) {
    const text = e.target.value;
    setLine(text);
    if (text.trim().length >= 3) requestParse(text);
    else setParsed(null);
  }

  const matter = parsed && parsed.matches[matterIdx];
  const ready = parsed && parsed.missing.length === 0 && matter;

  async function file() {
    if (!ready) return;
    try {
      await api.post('/api/entries', {
        date: todayStr(), cm_id: matter.id, narrative: parsed.narrative,
        tasks: [{ task_code: parsed.task_code, duration: parsed.hours, fragment: '' }],
      });
      emitToast(`Filed ✓ — ${fmtHours(parsed.hours)}h on ${matter.short_name}`);
      onFiled();
      onClose();
    } catch (e) { emitToast(e.message, { error: true }); }
  }

  function onKeyDown(e) {
    if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
    else if (e.key === 'Enter') { e.preventDefault(); file(); }
  }

  return createPortal(html`
    <div class="qc-backdrop" onMouseDown=${(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div class="qc-card" role="dialog" aria-label="Quick capture">
        <div class="qc-row">
          <${Icon} name="sparkles" size=${16} />
          <input ref=${inputRef} autoFocus type="text" value=${line}
            placeholder="call sam re loading dock lease .3"
            onInput=${onInput} onKeyDown=${onKeyDown} />
        </div>
        ${parsed ? html`
          <div class="qc-preview">
            ${parsed.matches.length ? html`
              <span class="qc-chips">
                ${parsed.matches.map((m, i) => html`
                  <button key=${m.id} class=${'qc-chip' + (i === matterIdx ? ' on' : '')}
                    onClick=${() => setMatterIdx(i)}>${m.client_name ? `${m.client_name} · ` : ''}${m.short_name}</button>`)}
              </span>` : html`<span class="qc-chip miss">? matter</span>`}
            ${parsed.hours != null ? html`<span class="qc-chip">${fmtHours(parsed.hours)}h</span>`
              : html`<span class="qc-chip miss">? hours</span>`}
            ${parsed.task_code ? html`<span class="qc-chip">${parsed.task_code}</span>`
              : html`<span class="qc-chip miss">? action</span>`}
          </div>
          ${parsed.narrative ? html`<div class="qc-narrative">${parsed.narrative}</div>` : null}
          <div class="qc-foot">
            ${ai && ai.enabled && parsed.missing.length > 0 ? html`
              <button class="btn btn-sm" disabled=${aiBusy} onClick=${() => requestParse(line, true)}>
                ${aiBusy ? 'Parsing…' : 'AI parse'}</button>` : null}
            <span class="spacer" style=${{ flex: 1 }}></span>
            <span class="muted small">${ready ? 'Enter files it · Esc closes' : 'fill the ? pieces, or edit the line'}</span>
          </div>` : html`
          <div class="qc-foot"><span class="muted small">one line: what · who · matter · time — Enter files it</span></div>`}
      </div>
    </div>`, document.body);
}
```

- [ ] **Step 2: Hotkey + mount + help**

In `public/js/app.js`: import the component; add `const [quickCapture, setQuickCapture] = useState(false);` next to `showHelp`; in the global key handler add (before the `?` branch) `else if (e.key === 'q') { e.preventDefault(); setQuickCapture(true); }`; render `${quickCapture ? html`<${QuickCapture} onClose=${() => setQuickCapture(false)} onFiled=${bumpRefresh} />` : null}` next to the KeyboardHelp mount. Help rows: add `['q', 'Quick capture — bill from a sentence']`.

- [ ] **Step 3: CSS**

In `public/css/app.css`, after the stop-chips block:

```css
/* ---------- quick capture (bill from a sentence) ---------- */
.qc-backdrop {
  position: fixed; inset: 0; z-index: 300; background: rgba(0,0,0,.25);
  display: flex; align-items: flex-start; justify-content: center; padding-top: 18vh;
}
.qc-card {
  width: 560px; max-width: calc(100vw - 36px);
  background: var(--surface-1); border: 1px solid var(--border); border-radius: 10px;
  box-shadow: var(--shadow); padding: 12px 14px;
}
.qc-row { display: flex; align-items: center; gap: 8px; }
.qc-row input { flex: 1; font-size: 15px; }
.qc-preview { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; align-items: center; }
.qc-chips { display: inline-flex; gap: 4px; flex-wrap: wrap; }
.qc-chip {
  border: 1px solid var(--border); background: var(--surface-2); color: var(--text-primary);
  border-radius: 999px; padding: 2px 10px; font-size: 12.5px; cursor: default;
}
button.qc-chip { cursor: pointer; }
button.qc-chip.on { border-color: var(--accent); background: var(--accent-soft); }
.qc-chip.miss { border-style: dashed; color: var(--status-warning); border-color: var(--status-warning); }
.qc-narrative { margin-top: 8px; font-size: 13.5px; }
.qc-foot { display: flex; align-items: center; margin-top: 10px; gap: 8px; }
```

- [ ] **Step 4: e2e step**

Add after the stop-chips step: press `q` (body focus), wait for `.qc-card input`, type `call re acme .3` (the e2e's `Acme lease` matter must fuzzy-match `acme`), wait for a `.qc-chip.on`-able matter chip AND absence of `.qc-chip.miss`, press Enter, assert a toast containing `Filed`, assert the qc card is gone, and assert today's entry count grew by one (query `/api/entries?date=` via `page.evaluate(fetch)` or reuse the harness's API helper pattern used by neighboring steps). Then delete the created entry via the API to leave the day as the later steps expect — mirror how neighboring steps clean up.

- [ ] **Step 5: Verify + commit**

`npm test` → PASS; `node scripts/e2e-smoke.mjs` → ALL CLEAR.

```bash
git add public/js/components/quickcapture.js public/js/app.js public/css/app.css scripts/e2e-smoke.mjs
git commit -m "feat(ui): quick-capture palette — bill from a sentence (q)"
```

---

### Task 5: Persistent animated today footer (+ `c` opens close-out)

**Files:**
- Create: `public/js/components/todayfooter.js`
- Modify: `public/js/views/dashboard.js` (mount at the end of the view)
- Modify: `public/js/app.js` (`c` key on dashboard dispatches `tk:close-day`; help row)
- Modify: `public/css/app.css`
- Modify: `scripts/e2e-smoke.mjs`

**Interfaces:**
- Consumes: the dashboard payload the view already holds (`data.today: { total, billable, target }`, `data.timers` with `elapsed_seconds`/`running`), passed down as props — no new fetch.
- Produces: `TodayFooter({ today, timers, onCloseDay })` — fixed footer on the dashboard only. Emits nothing; Task 6 wires `onCloseDay` to open the close-out. Also: app.js dispatches `window` CustomEvent `'tk:close-day'` on `c` (dashboard route only); the dashboard view listens and opens close-out (Task 6 — until then the footer button and the event no-op behind a `typeof onCloseDay === 'function'` guard).
- CSS class `.today-footer` and the total-bump animation class `.bump` (Task 7 refines motion; this task ships the functional footer with ONE subtle animation: the total pulses on change).

- [ ] **Step 1: Component**

Create `public/js/components/todayfooter.js`:

```js
import { html, useEffect, useRef, useState, fmtHours, fmtClock, Icon } from '/js/ui.js';

// Persistent "today" footer (spec §4): ambient awareness — live running
// clock, billable-vs-target meter, one key to close the day. Dashboard only.
export function TodayFooter({ today, timers, onCloseDay }) {
  const running = (timers || []).filter((t) => t.running);
  const [, tick] = useState(0);
  useEffect(() => {
    if (!running.length) return undefined;
    const h = setInterval(() => tick((x) => x + 1), 1000);
    return () => clearInterval(h);
  }, [running.length]);

  // subtle pulse when the filed total changes (Task 7 owns the wider motion language)
  const prev = useRef(today.total);
  const [bump, setBump] = useState(false);
  useEffect(() => {
    if (today.total !== prev.current) {
      prev.current = today.total;
      setBump(true);
      const t = setTimeout(() => setBump(false), 400);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [today.total]);

  const target = today.target || 0;
  const pct = target ? Math.min(100, Math.round((today.billable / target) * 100)) : 0;
  const liveSecs = running.reduce((s, t) => s + t.elapsed_seconds, 0)
    + (running.length ? Math.floor((Date.now() % 1000) / 1000) : 0);

  return html`
    <div class="today-footer">
      <span class=${'tf-total mono' + (bump ? ' bump' : '')} title="Filed today (all entries)">
        ${fmtHours(today.total)}h</span>
      <span class="muted small">filed</span>
      ${target ? html`
        <span class="tf-meter" title=${`${fmtHours(today.billable)}h billable of ${fmtHours(target)}h target`}>
          <span class="tf-meter-fill" style=${{ width: pct + '%' }}></span>
        </span>
        <span class="muted small">${pct}%</span>` : null}
      <span class="spacer" style=${{ flex: 1 }}></span>
      ${running.length ? html`
        <span class="tf-running" title=${running.map((t) => t.name).join(', ')}>
          <${Icon} name="timer" size=${14} />
          <span class="mono">${fmtClock(liveSecs)}</span>
          <span class="muted small">${running.length === 1 ? running[0].name : `${running.length} running`}</span>
        </span>` : null}
      <button class="btn btn-sm btn-primary" onClick=${onCloseDay} title="Review, finalize, and export today (c)">
        <${Icon} name="lock" size=${14} /> Close the day <kbd>c</kbd>
      </button>
    </div>`;
}
```

(Note on `liveSecs`: `elapsed_seconds` comes from the last fetch; the interval re-render makes the clock tick visibly. Matching TimerGrid's `liveElapsed` precision is not required here — this is ambient, one-second-granularity display. If the drift bothers in practice, thread `fetchedAt` through as a prop the way TimerGrid does.)

- [ ] **Step 2: Mount + key**

`public/js/views/dashboard.js`: import `TodayFooter`; render it as the LAST element of the view's fragment: `<${TodayFooter} today=${d.today} timers=${d.timers} onCloseDay=${() => setCloseOut(true)} />` — this task adds `const [closeOut, setCloseOut] = useState(false);` and a `tk:close-day` window-event listener that calls `setCloseOut(true)`; the state is consumed in Task 6 (until then render nothing for it). Give the dashboard's root container bottom padding (`padding-bottom: 54px` on a wrapper or via CSS) so the fixed footer doesn't cover content.
`public/js/app.js`: in the global key handler add `else if (e.key === 'c' && route.path === 'dashboard') { e.preventDefault(); window.dispatchEvent(new CustomEvent('tk:close-day')); }`. Help row: `['c', 'Close the day (dashboard)']`.

- [ ] **Step 3: CSS**

```css
/* ---------- today footer ---------- */
.today-footer {
  position: fixed; left: var(--sidebar-w, 200px); right: 0; bottom: 0; z-index: 90;
  display: flex; align-items: center; gap: 10px; padding: 8px 18px;
  background: var(--surface-1); border-top: 1px solid var(--border);
}
.tf-total { font-size: 16px; font-weight: 600; }
.tf-total.bump { animation: tf-bump 350ms ease-out 1; }
@keyframes tf-bump { 30% { transform: scale(1.06); color: var(--accent); } }
.tf-meter {
  width: 120px; height: 6px; border-radius: 3px; background: var(--surface-2);
  overflow: hidden; border: 1px solid var(--border);
}
.tf-meter-fill { display: block; height: 100%; background: var(--accent); }
.tf-running { display: inline-flex; align-items: center; gap: 6px; }
@media (prefers-reduced-motion: reduce) { .tf-total.bump { animation: none; } }
```

Check whether a `--sidebar-w` variable exists; if the sidebar width is a literal in `.sidebar`, use that same literal for `left:` and note it.

- [ ] **Step 4: e2e** — extend an existing dashboard step (or add a small one after the timer steps): assert `.today-footer` exists, shows a `…h filed` total, and the `Close the day` button is present.

- [ ] **Step 5: Verify + commit**

`npm test` → PASS; `node scripts/e2e-smoke.mjs` → ALL CLEAR.

```bash
git add public/js/components/todayfooter.js public/js/views/dashboard.js public/js/app.js public/css/app.css scripts/e2e-smoke.mjs
git commit -m "feat(ui): persistent today footer — live clock, target meter, close-the-day"
```

---

### Task 6: One-sweep close-out card stack

**Files:**
- Create: `public/js/components/closeout.js`
- Modify: `public/js/views/dashboard.js` (render it from the Task 5 state)
- Modify: `public/css/app.css`
- Modify: `scripts/e2e-smoke.mjs` (new step)

**Interfaces:**
- Consumes: `GET /api/dashboard` (fresh fetch on open — the view's copy may be stale), `PATCH /api/entries/:id { narrative }`, `POST /api/finalize-day { date, ack? }`, `POST /api/export { from, to }`, `downloadText` from ui.js, `GhostInput` + `useMatterSuggestions`, `expandShortcuts` + `useShortcuts` (mirror the entry editor's `expand` wiring), `openEditor` prop.
- Produces: `CloseOut({ onClose(changed), openEditor })` — full-screen overlay. Keys: **Enter** accept card → next · **e** open the full editor on it · **↓** skip · **Esc** quit the sweep (nothing lost — drafts stay drafts).

Behavior:
1. On open, fetch `/api/dashboard`; take `entries` where `status === 'draft'` (today's drafts). Empty → show a single card "Nothing to close — no drafts today" with a Close button.
2. One centered card at a time: matter short name + client, hours (`entry.total`), and the narrative area — `narrative_auto` entries show the AUTO narrative read-only (Enter just accepts); others show a `GhostInput` (multiline, suggestions from `useMatterSuggestions(entry.cm.id)`, shortcuts `expand` wired) pre-filled with `entry.narrative`, or, when blank, the matter's top clean suggestion (first `useMatterSuggestions` phrase with `!containsTimeAmounts(p)` — import from `/js/lib/timeamounts.js`) so Enter-through is confirm-not-compose. A progress dot row (`● ● ○ ○`) shows position.
3. **Enter**: if the narrative text differs from the stored one, `PATCH /api/entries/:id { narrative }`; advance. **↓**: advance without saving. **e**: `openEditor({ id })` and close the sweep (`onClose(true)`). Esc: `onClose(anySaved)`.
4. After the last card, the summary card: `X drafts narrated · Y skipped` + the single **Finalize & export** button. Clicking it: `POST /api/finalize-day { date, ack: false }`; if `blocked` contains warning-only items (`blocks.length === 0`), show the warning list with an `Accept warnings & finalize` button that re-posts with `ack: true`; hard blocks list the entries (button `Edit` per item → `openEditor({ id })`). When everything finalizable is finalized, `POST /api/export { from: date, to: date }` → `downloadText('timekeeper-' + date + '.csv', r.csv)` → the closing card: **"Day closed — {fmtHours(finalTotal)}h · exported"** (finalTotal = the dashboard `today.total` refetched or summed from finalized entries) with a Done button → `onClose(true)`.
5. If export returns `count === 0` (everything was blocked), show "Nothing exported — {n} drafts still need attention" instead of the closed card.

- [ ] **Step 1: Component** — implement `public/js/components/closeout.js` per the behavior above. Structure it as: `useState(cards)` (frozen at open), `idx`, `phase: 'sweep' | 'summary' | 'warn' | 'closed'`, one document-level capture-phase keydown listener (pattern: StopChips) handling Enter/e/ArrowDown/Escape with the input/textarea guard EXCEPT Enter, which must work while the GhostInput textarea has focus (check `e.target.closest('.closeout-card')` for that case; multiline Enter-to-accept is intended here — Shift+Enter inserts a newline instead: `if (e.key === 'Enter' && e.shiftKey) return;`). Reuse the `.qc-backdrop` positioning idea but with its own `.closeout-*` classes. Wire `expand` exactly like `entryeditor.js` does (`useShortcuts()` + `expandShortcuts`).
- [ ] **Step 2: Mount** — in `dashboard.js`, render `${closeOut ? html`<${CloseOut} onClose=${(changed) => { setCloseOut(false); if (changed) bumpRefresh(); }} openEditor=${openEditor} />` : null}` (state + event listener exist from Task 5).
- [ ] **Step 3: CSS** — `.closeout-backdrop` (fixed, rgba scrim, centered), `.closeout-card` (~560px, surface-1, radius 12), `.closeout-dots`, `.closeout-hours` (mono, large), `.closeout-keys` hint row (`Enter accept · e edit · ↓ skip · Esc quit`). Functional only — motion lands in Task 7.
- [ ] **Step 4: e2e step** — after the quick-capture step: create a draft via the API on the seeded matter (or reuse an existing draft the harness already makes — read the neighboring steps first), press `c` on the dashboard, assert `.closeout-card` shows the draft's matter, press Enter through the sweep, land on the summary, click `Finalize & export` (the harness's entries must be clean — if the seeded draft trips validation warnings, assert the warning card appears and click `Accept warnings & finalize` instead), assert the closing card contains `Day closed`, Done. Then, via the API, verify the entry is `finalized` with `exported_at` set — and leave state consistent for any later steps (this is the last data-mutating step; if placed before others, unlock/clean up as needed).
- [ ] **Step 5: Verify + commit**

`npm test` → PASS; `node scripts/e2e-smoke.mjs` → ALL CLEAR.

```bash
git add public/js/components/closeout.js public/js/views/dashboard.js public/css/app.css scripts/e2e-smoke.mjs
git commit -m "feat(ui): one-sweep close-out — card stack to finalize & export in one motion"
```

---

### Task 7: Micro-animation language (subtle, reduced-motion-safe)

**Files:**
- Modify: `public/css/app.css` (one `/* ---------- motion ---------- */` block at the end)
- Modify: `public/js/components/timergrid.js` (start-pulse class hook)
- Modify: `public/js/components/closeout.js` (card transition + closed-moment)
- Modify: `scripts/e2e-smoke.mjs` (only if an assertion breaks; motion is not e2e-asserted)

**Interfaces:** none new. Every animation: transform/opacity only, ≤300ms, ease-out, fires ONCE per event. The binding constraint: **very subtle — when in doubt, less.**

- [ ] **Step 1: The motion block**

```css
/* ---------- motion (spec §7: VERY subtle; confirms, never decorates) ---------- */
@media (prefers-reduced-motion: no-preference) {
  /* timer start: one soft pulse on the card */
  .timer-card.just-started { animation: tk-start 300ms ease-out 1; }
  @keyframes tk-start { 30% { box-shadow: 0 0 0 3px var(--accent-soft); } }

  /* stop chips + quick capture + close-out cards: settle in */
  .stop-chips, .qc-card, .closeout-card { animation: tk-settle 180ms ease-out 1; }
  @keyframes tk-settle { from { opacity: 0; transform: translateY(4px); } }

  /* finalize: soft lock on the status chip */
  .chip-finalized { animation: tk-lock 250ms ease-out 1; }
  @keyframes tk-lock { 40% { transform: scale(1.08); } }

  /* export/close-out closed moment: gentle rise */
  .closeout-closed { animation: tk-settle 300ms ease-out 1; }
}
```

(`.tf-total.bump` from Task 5 already carries its own reduced-motion guard; move it into this block if that reads cleaner.)

- [ ] **Step 2: The start-pulse hook** — in `timergrid.js`'s `start()`, after `await reload()`, add the card class imperatively for one cycle: `const el = document.querySelector(`.timer-card[data-timer-id="${timer.id}"]`); if (el) { el.classList.add('just-started'); setTimeout(() => el.classList.remove('just-started'), 350); }` — a comment noting this is deliberately imperative (one-shot confirmation, not state).
- [ ] **Step 3: Close-out closed moment** — ensure the final card carries `.closeout-closed`.
- [ ] **Step 4: Restraint pass** — load the app with dev tools, trigger each animation once; anything that draws the eye MORE than the action itself gets toned down or deleted. Then set `prefers-reduced-motion: reduce` in dev tools and confirm zero motion.
- [ ] **Step 5: Verify + commit**

`npm test` → PASS; `node scripts/e2e-smoke.mjs` → ALL CLEAR (motion must not break any selector/timing assertions — the settle animations are 180ms; if a step races one, wait on the element's presence, never on animation end).

```bash
git add public/css/app.css public/js/components/timergrid.js public/js/components/closeout.js
git commit -m "feat(ui): micro-animation language — start pulse, settle-ins, soft lock (reduced-motion-safe)"
```

---

## Self-Review

**Spec coverage (Phase 4 = §9.4):** bill-from-a-sentence parser + endpoint + palette (Tasks 2–4, spec §6 magic #1: pure `server/lib/quickcapture.js`, `{matter query → fuzzy matter, duration, verb → task code + narrative stub, counterparty w/ X}`, deterministic-first + LLM fallback, "You approve; it files") ✓; close-out card stack (Task 6, §7: silent drafts → one card at a time, centered, pre-filled from §5 memory, single finalize-AND-export action reusing `/api/finalize-day` + `/api/export`, "Day closed — X.Xh · exported" moment) ✓; today footer (Task 5, §4: live running timer, billable-vs-target mini-meter, one-key close-the-day) ✓; micro-animation language (Task 7, §7: start pulse, filed-total motion, soft lock, sweep-in; `prefers-reduced-motion`; VERY subtle) ✓; Export date presets QW1 (Task 1) ✓. Key deviation documented in Global Constraints (Tab→`e` for close-out edit). Open spec questions resolved: no ghost in the quick-capture bar; chips stay (already shipped).

**Placeholder scan:** every code step carries real code or an exact behavioral contract + named pattern to mirror (Tasks 6 Step 1 and 4 Step 4 reference concrete existing patterns by file — StopChips' capture listener, entryeditor's expand wiring, neighboring e2e steps — which the implementer must read; no TBDs).

**Type consistency:** `parseQuickCapture` shape `{ hours, task_code, person, topic, narrative, matterQuery, matches, missing }` is identical in Task 2's tests, Task 3's route/tests, and Task 4's UI consumption. `TodayFooter({ today, timers, onCloseDay })` matches the dashboard payload names. `CloseOut({ onClose, openEditor })` matches dashboard's `openEditor` prop and Task 5's state wiring. `tk:close-day` event name consistent between app.js and dashboard.js.

**Risks for the executor:** (1) e2e ordering — Tasks 4/6 add data-mutating steps; read the harness's existing step-state assumptions before inserting, clean up after filing. (2) Enter-in-textarea handling in close-out needs the Shift+Enter escape hatch and must not fight GhostInput's Tab. (3) The footer overlaps page content — the padding fix must be verified in both themes.
