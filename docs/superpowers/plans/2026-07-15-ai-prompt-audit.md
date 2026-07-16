# AI Prompt Audit Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone, gitignored dev tool that shows exactly what each
of Timekeeper's 4 AI-assist scenarios sends to the local Ollama model
(including real historical narrative text injected as context) and lets
David tweak prompt wording and re-run live against real data.

**Architecture:** A tiny Express server (`scripts/ai-audit/server.mjs`) opens
the app's real `data/timekeeper.db` via the app's own `openDb`/`loadConfig`,
imports the real prompt-building functions from `server/routes/ai.js` and
`server/routes/quickcapture.js` (two of which need a small additive export
first), and exposes read endpoints for seed data + POST endpoints that build
a prompt and call Ollama live. A single static `index.html` (vanilla JS, no
build) drives it with one tab per scenario.

**Tech Stack:** Node 24 ESM, Express (already a project dependency),
better-sqlite3 (via the app's existing `openDb`), vanilla JS/HTML/CSS for
the frontend — no new npm packages, no build step.

## Global Constraints

- Runtime deps stay exactly `express` + `better-sqlite3` — this tool adds
  zero new npm packages (per `CLAUDE.md`).
- No build step; frontend is plain JS/HTML (per `CLAUDE.md`; this tool is
  even simpler than the app's own UMD+htm frontend since it's not part of
  the deployed PWA).
- `scripts/ai-audit/` is gitignored in full — it displays real client/matter
  narrative text pulled live from the DB at runtime (per the design spec's
  confidentiality requirement).
- The tool is read-only against `data/timekeeper.db` except for one explicit
  action: the "save to app Settings" button, which writes
  `settings.ai.systemPrompt` — the exact field Settings → AI assist edits.
- Local-only: binds to `127.0.0.1`, own port (`4748` by default, distinct
  from the app's `4747`), never touches the cloudflared tunnel config.
- Dates are local-time `YYYY-MM-DD` strings — reuse `todayLocal` from
  `server/lib/dates.js`, don't reimplement.
- Spec: `docs/superpowers/specs/2026-07-15-ai-prompt-audit-design.md`.

---

### Task 1: Export `systemPrompt`/`formatContract`/`NAME_RESOLUTION_RULE` from ai.js

**Files:**
- Modify: `server/routes/ai.js:30` (`formatContract`), `server/routes/ai.js:41`
  (`systemPrompt`), `server/routes/ai.js:61` (`NAME_RESOLUTION_RULE`)
- Test: `test/ai.builders.test.js` (new file)

**Interfaces:**
- Produces: `export function formatContract(codes: string[]): string`,
  `export function systemPrompt(codes: string[], custom: string|undefined): string`,
  `export const NAME_RESOLUTION_RULE: string` — all three importable from
  `../server/routes/ai.js` by later tasks.

- [ ] **Step 1: Write the failing test**

Create `test/ai.builders.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { systemPrompt, formatContract, NAME_RESOLUTION_RULE, DEFAULT_AI_INSTRUCTIONS } from '../server/routes/ai.js';

test('formatContract lists the given task codes and the JSON contract', () => {
  const out = formatContract(['Review', 'Draft']);
  assert.match(out, /task_code MUST be one of: Review, Draft/);
  assert.match(out, /"narrative": "\.\.\."/);
});

test('systemPrompt falls back to DEFAULT_AI_INSTRUCTIONS when custom is empty', () => {
  const out = systemPrompt(['Review'], '');
  assert.match(out, new RegExp(DEFAULT_AI_INSTRUCTIONS.split('\n')[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(out, /task_code MUST be one of: Review/);
});

test('systemPrompt uses custom instructions when provided', () => {
  const out = systemPrompt(['Review'], 'Be extremely terse.');
  assert.match(out, /Be extremely terse\./);
});

test('NAME_RESOLUTION_RULE mentions informal name resolution', () => {
  assert.match(NAME_RESOLUTION_RULE, /informal/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/ai.builders.test.js`
Expected: FAIL — `systemPrompt`/`formatContract`/`NAME_RESOLUTION_RULE` are
not exported (import gives `undefined`, calling them throws
`TypeError: systemPrompt is not a function`).

- [ ] **Step 3: Add the exports**

In `server/routes/ai.js`, change:
```js
function formatContract(codes) {
```
to:
```js
export function formatContract(codes) {
```

Change:
```js
function systemPrompt(codes, custom) {
```
to:
```js
export function systemPrompt(codes, custom) {
```

Change:
```js
const NAME_RESOLUTION_RULE = `\n\nThe context may list people and phrases from this matter's history. When the description refers to someone informally (first name, initials, or nickname), use the matching name from that history — e.g. "jeff" becomes "J. Larson" if that is the only plausible match. Keep names with no clear match exactly as written; never invent people who appear in neither the description nor the history.`;
```
to:
```js
export const NAME_RESOLUTION_RULE = `\n\nThe context may list people and phrases from this matter's history. When the description refers to someone informally (first name, initials, or nickname), use the matching name from that history — e.g. "jeff" becomes "J. Larson" if that is the only plausible match. Keep names with no clear match exactly as written; never invent people who appear in neither the description nor the history.`;
```

No other lines change — these are purely additive `export` keywords.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/ai.builders.test.js`
Expected: PASS (4 tests)

- [ ] **Step 5: Run the full existing suite to confirm no regression**

Run: `npm test`
Expected: PASS — same pass count as before this change, since no runtime
behavior changed (only `export` keywords were added).

- [ ] **Step 6: Commit**

```bash
git add server/routes/ai.js test/ai.builders.test.js
git commit -m "refactor(ai): export systemPrompt/formatContract/NAME_RESOLUTION_RULE

Additive exports only, no behavior change — lets the AI audit tool
(scripts/ai-audit/, next commits) reuse the real prompt-building code
instead of duplicating it."
```

---

### Task 2: Export `buildLlmFillMessages` from quickcapture.js

**Files:**
- Modify: `server/routes/quickcapture.js:79-99` (the `llmFill` function)
- Test: `test/quickcapture.builders.test.js` (new file)

**Interfaces:**
- Consumes: nothing new from Task 1.
- Produces: `export function buildLlmFillMessages(line: string, parsed: {hours, task_code, ...}, taskCodes: string[]): Array<{role, content}>` — importable from `../server/routes/quickcapture.js` by Task 4.

- [ ] **Step 1: Write the failing test**

Create `test/quickcapture.builders.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLlmFillMessages } from '../server/routes/quickcapture.js';

test('buildLlmFillMessages builds a system+user message pair', () => {
  const parsed = { hours: 0.5, task_code: 'Review', person: null, topic: null, narrative: null };
  const messages = buildLlmFillMessages('call w jeff re lease .5', parsed, ['Review', 'Draft']);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, 'system');
  assert.match(messages[0].content, /task_code MUST be one of: Review, Draft/);
  assert.equal(messages[1].role, 'user');
  assert.match(messages[1].content, /Line: call w jeff re lease \.5/);
  assert.match(messages[1].content, /"hours":0\.5/);
  assert.match(messages[1].content, /"task_code":"Review"/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/quickcapture.builders.test.js`
Expected: FAIL — `buildLlmFillMessages` is `undefined` (not exported yet).

- [ ] **Step 3: Refactor `llmFill` to use a new exported builder**

In `server/routes/quickcapture.js`, replace the existing `llmFill` function
(the last function in the file) with:

```js
export function buildLlmFillMessages(line, parsed, taskCodes) {
  const system = `You extract structured billing data from an attorney's shorthand line.
Respond with ONLY JSON: {"hours": number|null, "task_code": string|null, "person": string|null, "topic": string|null, "narrative": string|null}.
task_code MUST be one of: ${taskCodes.join(', ')} (or null).
Never include time amounts or parentheticals like "(0.5)" inside the narrative.`;
  return [
    { role: 'system', content: system },
    { role: 'user', content: `Line: ${line}\nAlready determined (do not change): ${JSON.stringify({ hours: parsed.hours, task_code: parsed.task_code })}` },
  ];
}

async function llmFill(cfg, line, parsed, taskCodes) {
  const messages = buildLlmFillMessages(line, parsed, taskCodes);
  const resp = await fetch(`${cfg.url}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: cfg.model, stream: false, format: 'json', options: { temperature: 0.2 },
      messages,
    }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!resp.ok) throw new Error(`ollama ${resp.status}`);
  const data = await resp.json();
  try { return JSON.parse(data.message.content); } catch { return {}; }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/quickcapture.builders.test.js`
Expected: PASS

- [ ] **Step 5: Run the full existing suite to confirm no regression**

Run: `npm test`
Expected: PASS — `test/api.quickcapture.test.js`'s existing behavioral tests
(fill missing fields, rematch, etc.) still pass unchanged since `llmFill`'s
observable behavior is identical.

- [ ] **Step 6: Commit**

```bash
git add server/routes/quickcapture.js test/quickcapture.builders.test.js
git commit -m "refactor(quickcapture): extract buildLlmFillMessages, export it

Additive refactor only, no behavior change — llmFill now delegates
to the exported builder so the AI audit tool can reuse the real
prompt construction instead of duplicating it."
```

---

### Task 3: Scaffold the audit server — config/DB wiring, static serving, read-only seed endpoints

**Files:**
- Create: `scripts/ai-audit/server.mjs`
- Create: `scripts/ai-audit/index.html` (placeholder shell for now — full UI
  is Task 6)

**Interfaces:**
- Consumes: `loadConfig` from `server/config.js`, `openDb`/`getSetting` from
  `server/db.js`, `todayLocal` from `server/lib/dates.js`,
  `DEFAULT_AI_INSTRUCTIONS`/`matterAiContext` from `server/routes/ai.js`
  (all already exported before this task).
- Produces: a running HTTP server on `127.0.0.1:4748` with `GET /`,
  `GET /api/seed/entries`, `GET /api/seed/matters`,
  `GET /api/context/:matterId`, `GET /api/settings/ai` — all consumed by
  Task 6's frontend and extended by Task 4/5.

- [ ] **Step 1: Create the placeholder HTML shell**

Create `scripts/ai-audit/index.html`:

```html
<!doctype html>
<html>
<head><meta charset="utf-8"><title>AI Prompt Audit</title></head>
<body>
  <h1>AI Prompt Audit</h1>
  <p>Scaffolding — full UI lands in a later task.</p>
</body>
</html>
```

- [ ] **Step 2: Create the server**

Create `scripts/ai-audit/server.mjs`:

```js
import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadConfig } from '../../server/config.js';
import { openDb, getSetting } from '../../server/db.js';
import { todayLocal } from '../../server/lib/dates.js';
import { DEFAULT_AI_INSTRUCTIONS, matterAiContext } from '../../server/routes/ai.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const config = loadConfig();
const db = openDb(config.DB_PATH);

const app = express();
app.use(express.json());
app.use(express.static(__dirname));

app.get('/api/seed/entries', (req, res) => {
  const rows = db.prepare(`
    SELECT e.id, e.date, e.narrative, e.total_override, e.cm_id, m.short_name
    FROM entries e
    JOIN matters m ON m.id = e.cm_id
    WHERE e.deleted_at IS NULL AND e.narrative != ''
    ORDER BY e.date DESC, e.id DESC
    LIMIT 200
  `).all();
  res.json(rows);
});

app.get('/api/seed/matters', (req, res) => {
  const rows = db.prepare(`
    SELECT m.id, m.cm_number, m.short_name, c.name AS client_name
    FROM matters m
    LEFT JOIN clients c ON c.id = m.client_id
    WHERE m.status != 'archived'
    ORDER BY m.short_name
  `).all();
  res.json(rows);
});

app.get('/api/context/:matterId', (req, res) => {
  const cmId = Number(req.params.matterId);
  const context = matterAiContext(db, cmId, todayLocal(new Date()));
  res.json({ context });
});

app.get('/api/settings/ai', async (req, res) => {
  const cfg = getSetting(db, 'ai') || {};
  let reachable = false;
  let models = [];
  try {
    const resp = await fetch(`${cfg.url}/api/tags`, { signal: AbortSignal.timeout(2500) });
    if (resp.ok) {
      const data = await resp.json();
      models = (data.models || []).map((m) => m.name);
      reachable = true;
    }
  } catch { /* ollama down — reported below */ }
  res.json({
    enabled: !!cfg.enabled, model: cfg.model, url: cfg.url, reachable, models,
    systemPrompt: cfg.systemPrompt || '',
    defaultPrompt: DEFAULT_AI_INSTRUCTIONS,
  });
});

const PORT = Number(process.env.AI_AUDIT_PORT || 4748);
app.listen(PORT, '127.0.0.1', () => {
  console.log(`AI prompt audit tool listening on http://127.0.0.1:${PORT}`);
});
```

- [ ] **Step 3: Start the server and verify manually**

Run: `node scripts/ai-audit/server.mjs`
Expected console output: `AI prompt audit tool listening on http://127.0.0.1:4748`

In a second terminal, with the server still running:

Run: `curl -s http://127.0.0.1:4748/ | head -5`
Expected: the placeholder HTML (`<h1>AI Prompt Audit</h1>` visible in output).

Run: `curl -s http://127.0.0.1:4748/api/seed/matters | head -c 300`
Expected: a JSON array; each element has `id`, `cm_number`, `short_name`,
`client_name` keys. Note one real `id` value from this response — you'll
reuse it in the next check and in Task 4's checks.

Run: `curl -s http://127.0.0.1:4748/api/context/<id-you-noted>`
Expected: `{"context": ...}` — either a string containing "People from this
matter's history" / "attorney's recent work on this matter", or
`{"context":null}` if that matter has no history yet.

Run: `curl -s http://127.0.0.1:4748/api/settings/ai`
Expected: JSON with `enabled`, `model`, `url`, `reachable`, `models`,
`systemPrompt`, `defaultPrompt` keys — `reachable` should be `true` if the
box's local Ollama is running.

Stop the server (Ctrl+C) once verified.

- [ ] **Step 4: Commit**

```bash
git add -f scripts/ai-audit/server.mjs scripts/ai-audit/index.html
git commit -m "feat(ai-audit): scaffold audit server with read-only seed endpoints

Opens the real app DB via the app's own openDb/loadConfig, serves
seed data (entries/matters/task codes) and the real matterAiContext
output for the audit tool's context-preview panel."
```

Note: `-f` is required here because Task 7 adds `scripts/ai-audit/` to
`.gitignore` — committing the initial scaffold before the ignore rule lands
means the ignore takes effect from Task 7 onward. If you're doing Task 7's
gitignore edit first for any reason, drop `-f` on later commits in this
directory.

---

### Task 4: Add the 4 live-run endpoints

**Files:**
- Modify: `scripts/ai-audit/server.mjs` (append endpoints before the
  `app.listen(...)` call)

**Interfaces:**
- Consumes: `systemPrompt` and `NAME_RESOLUTION_RULE` from `server/routes/ai.js`
  (added in Task 1 — note `systemPrompt` already calls `formatContract`
  internally, so this file never needs to import `formatContract` directly),
  plus `timeGroundingRule`/`buildNarrateMessages` (already exported before
  Task 1); `buildLlmFillMessages` from `server/routes/quickcapture.js` (Task 2);
  `allocateTenths` from `server/lib/allocate.js`; `containsTimeAmounts` from
  `server/lib/timeAmounts.js`; `parseQuickCapture` from
  `server/lib/quickcapture.js` (note: this is the deterministic parser in
  `server/lib/`, a different file from `server/routes/quickcapture.js`).
- Produces: `POST /api/run/expand`, `POST /api/run/narrate`,
  `POST /api/run/timer-suggest`, `POST /api/run/quickcapture` — all consumed
  by Task 6's frontend. Each returns `{ request, raw, ...parsed-fields }` on
  success or `{ error, message, request }` with HTTP 502 if Ollama is
  unreachable.

- [ ] **Step 1: Add the new imports**

At the top of `scripts/ai-audit/server.mjs`, change:

```js
import { openDb, getSetting } from '../../server/db.js';
import { todayLocal } from '../../server/lib/dates.js';
import { DEFAULT_AI_INSTRUCTIONS, matterAiContext } from '../../server/routes/ai.js';
```

to:

```js
import { openDb, getSetting, setSetting } from '../../server/db.js';
import { todayLocal } from '../../server/lib/dates.js';
import { allocateTenths } from '../../server/lib/allocate.js';
import { containsTimeAmounts } from '../../server/lib/timeAmounts.js';
import { parseQuickCapture } from '../../server/lib/quickcapture.js';
import {
  DEFAULT_AI_INSTRUCTIONS, matterAiContext, systemPrompt,
  NAME_RESOLUTION_RULE, timeGroundingRule, buildNarrateMessages,
} from '../../server/routes/ai.js';
import { buildLlmFillMessages } from '../../server/routes/quickcapture.js';
```

(`setSetting` is unused until Task 5 but importing it now avoids a second
edit to this line.)

- [ ] **Step 2: Add the 4 run endpoints**

In `scripts/ai-audit/server.mjs`, insert the following immediately before
the `const PORT = ...` line:

```js
app.post('/api/run/expand', async (req, res) => {
  const cfg = getSetting(db, 'ai') || {};
  const b = req.body || {};
  const brief = String(b.brief || '').trim();
  if (!brief) return res.status(400).json({ error: 'brief is required' });
  const totalHours = b.totalHours != null ? Number(b.totalHours) : null;
  const codes = db.prepare(
    'SELECT name FROM task_codes WHERE active=1 ORDER BY sort_order, id').all().map((x) => x.name);
  const matterCtx = b.cmId ? matterAiContext(db, Number(b.cmId), todayLocal(new Date())) : null;
  const system = systemPrompt(codes, b.instructions) + timeGroundingRule(totalHours)
    + (matterCtx ? NAME_RESOLUTION_RULE : '');
  const user = [
    matterCtx,
    totalHours ? `Total time: ${totalHours} hours.\nWork done: ${brief}` : `Work done: ${brief}`,
  ].filter(Boolean).join('\n\n');
  const messages = [{ role: 'system', content: system }, { role: 'user', content: user }];

  let raw;
  try {
    const resp = await fetch(`${cfg.url}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: cfg.model, stream: false, format: 'json', options: { temperature: 0.3 }, messages }),
      signal: AbortSignal.timeout(180_000),
    });
    if (!resp.ok) throw new Error(`ollama returned ${resp.status}`);
    raw = await resp.json();
  } catch (e) {
    return res.status(502).json({ error: 'ollama_unreachable', message: e.message, request: { messages } });
  }

  let parsed = null;
  try { parsed = JSON.parse(raw.message?.content); } catch { /* leave null */ }
  let tasks = [];
  if (parsed && Array.isArray(parsed.tasks)) {
    tasks = parsed.tasks.slice(0, 8).map((t) => ({
      task_code: codes.includes(t.task_code) ? t.task_code : (codes[0] || ''),
      fragment: String(t.fragment || '').trim().slice(0, 400),
      share: Number(t.share) > 0 ? Number(t.share) : 0,
    }));
  }
  const hours = totalHours && tasks.length ? allocateTenths(totalHours, tasks.map((t) => t.share)) : null;

  res.json({
    request: { messages, model: cfg.model, options: { temperature: 0.3 }, format: 'json' },
    raw,
    parsed: {
      narrative: parsed?.narrative ?? null,
      tasks: tasks.map((t, i) => ({ task_code: t.task_code, fragment: t.fragment, hours: hours ? hours[i] : null })),
    },
  });
});

app.post('/api/run/narrate', async (req, res) => {
  const cfg = getSetting(db, 'ai') || {};
  const b = req.body || {};
  const mode = ['draft', 'regenerate', 'shorter', 'longer'].includes(b.mode) ? b.mode : 'draft';
  const brief = String(b.brief || '').trim();
  const narrative = String(b.narrative || '').trim();
  const matterCtx = b.cmId ? matterAiContext(db, Number(b.cmId), todayLocal(new Date())) : null;
  const messages = buildNarrateMessages({
    instructions: b.instructions, brief, narrative, mode,
    totalHours: b.totalHours, context: matterCtx,
  });
  const temperature = mode === 'regenerate' ? 0.8 : 0.3;

  let raw;
  try {
    const resp = await fetch(`${cfg.url}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: cfg.model, stream: false, options: { temperature }, messages }),
      signal: AbortSignal.timeout(180_000),
    });
    if (!resp.ok) throw new Error(`ollama returned ${resp.status}`);
    raw = await resp.json();
  } catch (e) {
    return res.status(502).json({ error: 'ollama_unreachable', message: e.message, request: { messages } });
  }

  res.json({
    request: { messages, model: cfg.model, options: { temperature } },
    raw,
    narrative: (raw.message?.content || '').trim(),
  });
});

app.post('/api/run/timer-suggest', async (req, res) => {
  const cfg = getSetting(db, 'ai') || {};
  const b = req.body || {};
  const cmId = Number(b.cmId);
  const matter = db.prepare('SELECT short_name FROM matters WHERE id=?').get(cmId);
  if (!matter) return res.status(400).json({ error: 'unknown matter id' });
  const timerName = String(b.timerName || matter.short_name);
  const matterCtx = matterAiContext(db, cmId, todayLocal(new Date()));
  const brief = `Matter: ${matter.short_name}. Timer label: ${timerName}. Draft the single most likely billing narrative for today's work session on this matter.`;
  const messages = buildNarrateMessages({ instructions: b.instructions, brief, context: matterCtx });

  let raw;
  try {
    const resp = await fetch(`${cfg.url}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: cfg.model, stream: false, options: { temperature: 0.3 }, messages }),
      signal: AbortSignal.timeout(180_000),
    });
    if (!resp.ok) throw new Error(`ollama returned ${resp.status}`);
    raw = await resp.json();
  } catch (e) {
    return res.status(502).json({ error: 'ollama_unreachable', message: e.message, request: { messages } });
  }

  const text = String(raw.message?.content || '').trim().replace(/^["']|["']$/g, '').slice(0, 300);
  const accepted = !!text && !text.includes('{') && !containsTimeAmounts(text);
  const rejectReason = accepted ? null
    : (!text ? 'empty response' : text.includes('{') ? 'JSON-ish output' : 'contains invented time amounts');

  res.json({
    request: { messages, model: cfg.model, options: { temperature: 0.3 } },
    raw, narrative: text, accepted, rejectReason,
  });
});

app.post('/api/run/quickcapture', async (req, res) => {
  const cfg = getSetting(db, 'ai') || {};
  const b = req.body || {};
  const line = String(b.line || '').trim();
  if (!line) return res.status(400).json({ error: 'line is required' });
  const matters = db.prepare(`SELECT m.id, m.cm_number, m.matter_number, m.short_name,
      m.favorite, m.last_used_at, c.name AS client_name, c.client_number
    FROM matters m LEFT JOIN clients c ON c.id = m.client_id WHERE m.status != 'archived'`).all();
  const taskCodes = db.prepare(
    'SELECT name FROM task_codes WHERE active=1 ORDER BY sort_order, id').all().map((x) => x.name);
  const parsed = parseQuickCapture(line, { matters, taskCodes });
  const messages = buildLlmFillMessages(line, parsed, taskCodes);

  let raw;
  try {
    const resp = await fetch(`${cfg.url}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: cfg.model, stream: false, format: 'json', options: { temperature: 0.2 }, messages }),
      signal: AbortSignal.timeout(180_000),
    });
    if (!resp.ok) throw new Error(`ollama returned ${resp.status}`);
    raw = await resp.json();
  } catch (e) {
    return res.status(502).json({ error: 'ollama_unreachable', message: e.message, request: { messages } });
  }

  let filled = {};
  try { filled = JSON.parse(raw.message?.content); } catch { /* leave {} */ }

  res.json({
    request: { messages, model: cfg.model, options: { temperature: 0.2 }, format: 'json' },
    raw, deterministic: parsed, filled,
  });
});
```

- [ ] **Step 3: Verify manually**

Run: `node scripts/ai-audit/server.mjs` (leave running)

In a second terminal:

Run:
```bash
curl -s -X POST http://127.0.0.1:4748/api/run/narrate \
  -H 'content-type: application/json' \
  -d '{"mode":"draft","brief":"call with client re lease renewal, .3 hours"}'
```
Expected: JSON with `request.messages` (array of 2, `role: system`/`user`),
`raw` (the full Ollama response object), and a non-empty `narrative` string
— assuming the box's local Ollama is enabled and reachable (confirmed
earlier via `/api/settings/ai`).

Run:
```bash
curl -s -X POST http://127.0.0.1:4748/api/run/quickcapture \
  -H 'content-type: application/json' \
  -d '{"line":"call w jeff re lease renewal .3"}'
```
Expected: JSON with `request.messages`, `raw`, `deterministic` (the
parser's output shape: `hours`/`task_code`/`person`/`topic`/`narrative`/
`matches`/`missing`), and `filled` (the model's JSON fill).

Run:
```bash
curl -s -X POST http://127.0.0.1:4748/api/run/expand \
  -H 'content-type: application/json' \
  -d '{"brief":"drafted amendment, reviewed lease, called client","totalHours":1.2}'
```
Expected: JSON with `request`, `raw`, and `parsed.tasks` — an array where
each item has `task_code`/`fragment`/`hours`, and the `hours` values sum to
approximately `1.2`.

For `/api/run/timer-suggest`, first get a real matter id (`curl -s
http://127.0.0.1:4748/api/seed/matters | head -c 300`), then:
```bash
curl -s -X POST http://127.0.0.1:4748/api/run/timer-suggest \
  -H 'content-type: application/json' \
  -d '{"cmId": <id-you-noted>}'
```
Expected: JSON with `request`, `raw`, `narrative`, `accepted` (boolean), and
`rejectReason` (`null` when `accepted` is `true`).

Stop the server once all four are verified.

- [ ] **Step 4: Commit**

```bash
git add -f scripts/ai-audit/server.mjs
git commit -m "feat(ai-audit): add live-run endpoints for all 4 AI scenarios

Each endpoint builds the exact real prompt (via the imported builder
functions) with an optional instructions override, calls Ollama live,
and returns the full request + raw + parsed response for audit."
```

---

### Task 5: Add save-to-settings endpoint

**Files:**
- Modify: `scripts/ai-audit/server.mjs` (append endpoint before
  `app.listen(...)`)

**Interfaces:**
- Consumes: `setSetting` from `server/db.js` (already imported in Task 4).
- Produces: `POST /api/settings/ai/system-prompt`, consumed by Task 6's
  "save to app Settings" buttons.

- [ ] **Step 1: Add the endpoint**

In `scripts/ai-audit/server.mjs`, insert immediately before the
`const PORT = ...` line:

```js
app.post('/api/settings/ai/system-prompt', (req, res) => {
  const cfg = getSetting(db, 'ai') || {};
  const value = String((req.body || {}).systemPrompt ?? '').trim();
  setSetting(db, 'ai', { ...cfg, systemPrompt: value });
  res.json({ ok: true });
});
```

- [ ] **Step 2: Verify manually**

Run: `node scripts/ai-audit/server.mjs` (leave running)

In a second terminal:
```bash
curl -s http://127.0.0.1:4748/api/settings/ai | grep -o '"systemPrompt":"[^"]*"'
```
Note the current value (this is your real app's live custom prompt — do not
discard it).

```bash
curl -s -X POST http://127.0.0.1:4748/api/settings/ai/system-prompt \
  -H 'content-type: application/json' \
  -d '{"systemPrompt":"AI AUDIT TEST — TEMP VALUE"}'
```
Expected: `{"ok":true}`

```bash
curl -s http://127.0.0.1:4748/api/settings/ai | grep -o '"systemPrompt":"[^"]*"'
```
Expected: now shows `"systemPrompt":"AI AUDIT TEST — TEMP VALUE"`.

**Restore the real value immediately** (use the value you noted above):
```bash
curl -s -X POST http://127.0.0.1:4748/api/settings/ai/system-prompt \
  -H 'content-type: application/json' \
  -d '{"systemPrompt":"<the real value you noted>"}'
```
Confirm restored via `curl -s http://127.0.0.1:4748/api/settings/ai`.

Stop the server once restored and verified.

- [ ] **Step 3: Commit**

```bash
git add -f scripts/ai-audit/server.mjs
git commit -m "feat(ai-audit): add save-to-settings endpoint

Writes settings.ai.systemPrompt directly — the same field Settings ->
AI assist edits in the real app. Shared across the expand/narrate/
timer-suggest scenarios, matching how the real app reads it."
```

---

### Task 6: Build the audit UI (index.html)

**Files:**
- Modify: `scripts/ai-audit/index.html` (replace the Task 3 placeholder with
  the full UI)

**Interfaces:**
- Consumes: every endpoint from Tasks 3–5 (`GET /api/seed/entries`,
  `GET /api/seed/matters`, `GET /api/context/:matterId`,
  `GET /api/settings/ai`,
  `POST /api/run/expand`, `POST /api/run/narrate`,
  `POST /api/run/timer-suggest`, `POST /api/run/quickcapture`,
  `POST /api/settings/ai/system-prompt`).
- Produces: nothing consumed by later tasks — this is the last functional
  piece.

- [ ] **Step 1: Replace index.html with the full UI**

Replace the full contents of `scripts/ai-audit/index.html` with:

```html
<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>AI Prompt Audit</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, sans-serif; margin: 0; padding: 1.5rem; max-width: 900px; }
  h1 { font-size: 1.2rem; }
  .tabs { display: flex; gap: 0.5rem; margin-bottom: 1rem; border-bottom: 1px solid #8884; }
  .tabs button { padding: 0.5rem 1rem; border: none; background: none; cursor: pointer; font-size: 0.95rem; opacity: 0.6; }
  .tabs button.active { opacity: 1; border-bottom: 2px solid currentColor; }
  .panel { display: none; }
  .panel.active { display: block; }
  label { display: block; margin-top: 0.75rem; font-size: 0.85rem; opacity: 0.8; }
  textarea, input[type=text], input[type=number], select { width: 100%; box-sizing: border-box; font-family: inherit; font-size: 0.9rem; padding: 0.4rem; margin-top: 0.2rem; }
  textarea { font-family: ui-monospace, monospace; }
  .context-box { background: #8881; border: 1px solid #8884; padding: 0.5rem; margin-top: 0.5rem; font-size: 0.85rem; white-space: pre-wrap; }
  .row { display: flex; gap: 0.5rem; align-items: center; margin-top: 0.75rem; }
  button.run { padding: 0.5rem 1rem; font-weight: 600; cursor: pointer; }
  button.save { padding: 0.3rem 0.6rem; font-size: 0.8rem; cursor: pointer; }
  pre { background: #8881; border: 1px solid #8884; padding: 0.6rem; overflow-x: auto; font-size: 0.8rem; }
  .run-result { border: 1px solid #8884; padding: 0.75rem; margin-top: 1rem; }
  .run-result h4 { margin: 0.5rem 0 0.2rem; font-size: 0.85rem; }
  .rejected { color: #c33; font-weight: 600; }
  .accepted { color: #2a2; font-weight: 600; }
</style>
</head>
<body>
<h1>AI Prompt Audit</h1>
<div class="tabs">
  <button data-tab="expand" class="active">Expand → split</button>
  <button data-tab="narrate">Narrate</button>
  <button data-tab="timer">Timer-start suggest</button>
  <button data-tab="quickcapture">Quick-capture fill</button>
</div>

<div id="panel-expand" class="panel active">
  <label>Seed from a real past entry
    <select id="expand-seed"><option value="">— pick an entry —</option></select>
  </label>
  <label>Brief (editable) <textarea id="expand-brief" rows="3"></textarea></label>
  <label>Total hours <input type="number" step="0.1" id="expand-hours"></label>
  <label>Historical context that will be injected
    <div class="context-box" id="expand-context">(pick a seed entry above)</div>
  </label>
  <label>System instructions (scratch — not saved unless you click Save)
    <textarea id="expand-instructions" rows="6"></textarea>
  </label>
  <div class="row">
    <button class="run" data-run="expand">Run</button>
    <button class="save" data-save="expand-instructions">Save to app Settings</button>
  </div>
  <div id="expand-results"></div>
</div>

<div id="panel-narrate" class="panel">
  <label>Seed from a real past entry
    <select id="narrate-seed"><option value="">— pick an entry —</option></select>
  </label>
  <label>Text (used as brief for draft, as narrative for shorter/longer/regenerate)
    <textarea id="narrate-text" rows="3"></textarea>
  </label>
  <label>Mode
    <select id="narrate-mode">
      <option value="draft">draft (Expand)</option>
      <option value="shorter">shorter (Shorten)</option>
      <option value="regenerate">regenerate (Rewrite)</option>
      <option value="longer">longer (not wired to any button in the app today)</option>
    </select>
  </label>
  <label>Total hours <input type="number" step="0.1" id="narrate-hours"></label>
  <label>Historical context that will be injected
    <div class="context-box" id="narrate-context">(pick a seed entry above)</div>
  </label>
  <label>System instructions (scratch — not saved unless you click Save)
    <textarea id="narrate-instructions" rows="6"></textarea>
  </label>
  <div class="row">
    <button class="run" data-run="narrate">Run</button>
    <button class="save" data-save="narrate-instructions">Save to app Settings</button>
  </div>
  <div id="narrate-results"></div>
</div>

<div id="panel-timer" class="panel">
  <label>Matter
    <select id="timer-matter"><option value="">— pick a matter —</option></select>
  </label>
  <label>Timer label (defaults to matter name) <input type="text" id="timer-label"></label>
  <label>Historical context that will be injected
    <div class="context-box" id="timer-context">(pick a matter above)</div>
  </label>
  <label>System instructions (scratch — not saved unless you click Save)
    <textarea id="timer-instructions" rows="6"></textarea>
  </label>
  <div class="row">
    <button class="run" data-run="timer">Run</button>
    <button class="save" data-save="timer-instructions">Save to app Settings</button>
  </div>
  <div id="timer-results"></div>
</div>

<div id="panel-quickcapture" class="panel">
  <label>Seed from a real past entry (fills the line below — edit it down to a shorthand line)
    <select id="qc-seed"><option value="">— pick an entry —</option></select>
  </label>
  <label>Shorthand line <input type="text" id="qc-line" placeholder="call w jeff re lease renewal .3"></label>
  <p style="font-size:0.8rem;opacity:0.7">This scenario has no customizable system prompt in the real app today, so there's no instructions box or Save button here.</p>
  <div class="row"><button class="run" data-run="quickcapture">Run</button></div>
  <div id="quickcapture-results"></div>
</div>

<script>
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

$$('.tabs button').forEach((btn) => {
  btn.addEventListener('click', () => {
    $$('.tabs button').forEach((b) => b.classList.remove('active'));
    $$('.panel').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    $('#panel-' + btn.dataset.tab).classList.add('active');
  });
});

async function loadJson(url, opts) {
  const r = await fetch(url, opts);
  return r.json();
}

let entries = [];
let matters = [];

async function init() {
  entries = await loadJson('/api/seed/entries');
  matters = await loadJson('/api/seed/matters');
  const settings = await loadJson('/api/settings/ai');
  const defaultInstructions = settings.systemPrompt || settings.defaultPrompt || '';

  for (const id of ['expand-instructions', 'narrate-instructions', 'timer-instructions']) {
    $('#' + id).value = defaultInstructions;
  }

  const entryLabel = (e) => `${e.date} — ${e.short_name}: ${e.narrative.slice(0, 60)}`;
  for (const selId of ['expand-seed', 'narrate-seed', 'qc-seed']) {
    const sel = $('#' + selId);
    for (const e of entries) {
      const opt = document.createElement('option');
      opt.value = e.id;
      opt.textContent = entryLabel(e);
      sel.appendChild(opt);
    }
  }

  const matterLabel = (m) => `${m.short_name}${m.client_name ? ' (' + m.client_name + ')' : ''}`;
  const matterSel = $('#timer-matter');
  for (const m of matters) {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = matterLabel(m);
    matterSel.appendChild(opt);
  }
}

async function showContext(cmId, targetId) {
  const box = $('#' + targetId);
  if (!cmId) { box.textContent = '(pick a seed above)'; return; }
  box.textContent = 'loading…';
  const { context } = await loadJson('/api/context/' + cmId);
  box.textContent = context || '(no historical context for this matter yet)';
}

$('#expand-seed').addEventListener('change', (e) => {
  const entry = entries.find((x) => String(x.id) === e.target.value);
  if (!entry) return;
  $('#expand-brief').value = entry.narrative;
  $('#expand-hours').value = entry.total_override || '';
  showContext(entry.cm_id, 'expand-context');
  $('#expand-seed').dataset.cmId = entry.cm_id;
});

$('#narrate-seed').addEventListener('change', (e) => {
  const entry = entries.find((x) => String(x.id) === e.target.value);
  if (!entry) return;
  $('#narrate-text').value = entry.narrative;
  $('#narrate-hours').value = entry.total_override || '';
  showContext(entry.cm_id, 'narrate-context');
  $('#narrate-seed').dataset.cmId = entry.cm_id;
});

$('#qc-seed').addEventListener('change', (e) => {
  const entry = entries.find((x) => String(x.id) === e.target.value);
  if (!entry) return;
  $('#qc-line').value = entry.narrative.slice(0, 60);
});

$('#timer-matter').addEventListener('change', (e) => {
  showContext(e.target.value, 'timer-context');
});

function renderResult(container, title, data) {
  const div = document.createElement('div');
  div.className = 'run-result';
  const heading = document.createElement('strong');
  heading.textContent = title;
  div.appendChild(heading);

  const reqPre = document.createElement('pre');
  reqPre.textContent = JSON.stringify(data.request, null, 2);
  const reqH = document.createElement('h4'); reqH.textContent = 'Request sent to Ollama';
  div.appendChild(reqH); div.appendChild(reqPre);

  if (data.error) {
    const errP = document.createElement('p');
    errP.className = 'rejected';
    errP.textContent = data.error + ': ' + data.message;
    div.appendChild(errP);
    container.prepend(div);
    return;
  }

  const rawH = document.createElement('h4'); rawH.textContent = 'Raw model response';
  const rawPre = document.createElement('pre'); rawPre.textContent = JSON.stringify(data.raw, null, 2);
  div.appendChild(rawH); div.appendChild(rawPre);

  const parsedH = document.createElement('h4'); parsedH.textContent = 'Parsed result';
  const parsedPre = document.createElement('pre');
  const { request, raw, ...rest } = data;
  parsedPre.textContent = JSON.stringify(rest, null, 2);
  div.appendChild(parsedH); div.appendChild(parsedPre);

  container.prepend(div);
}

$$('button[data-run]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const kind = btn.dataset.run;
    btn.disabled = true;
    try {
      let body, url, container;
      if (kind === 'expand') {
        url = '/api/run/expand'; container = $('#expand-results');
        body = {
          brief: $('#expand-brief').value,
          totalHours: Number($('#expand-hours').value) || undefined,
          cmId: $('#expand-seed').dataset.cmId || undefined,
          instructions: $('#expand-instructions').value,
        };
      } else if (kind === 'narrate') {
        url = '/api/run/narrate'; container = $('#narrate-results');
        const text = $('#narrate-text').value;
        body = {
          mode: $('#narrate-mode').value, brief: text, narrative: text,
          totalHours: Number($('#narrate-hours').value) || undefined,
          cmId: $('#narrate-seed').dataset.cmId || undefined,
          instructions: $('#narrate-instructions').value,
        };
      } else if (kind === 'timer') {
        url = '/api/run/timer-suggest'; container = $('#timer-results');
        body = {
          cmId: $('#timer-matter').value,
          timerName: $('#timer-label').value || undefined,
          instructions: $('#timer-instructions').value,
        };
      } else {
        url = '/api/run/quickcapture'; container = $('#quickcapture-results');
        body = { line: $('#qc-line').value };
      }
      const data = await loadJson(url, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      renderResult(container, new Date().toLocaleTimeString() + ' — ' + kind, data);
    } finally {
      btn.disabled = false;
    }
  });
});

$$('button[data-save]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const value = $('#' + btn.dataset.save).value;
    const r = await loadJson('/api/settings/ai/system-prompt', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ systemPrompt: value }),
    });
    btn.textContent = r.ok ? 'Saved ✓' : 'Save failed';
    setTimeout(() => { btn.textContent = 'Save to app Settings'; }, 1500);
  });
});

init();
</script>
</body>
</html>
```

- [ ] **Step 2: Verify manually in a browser**

Run: `node scripts/ai-audit/server.mjs`

Open `http://127.0.0.1:4748/` in a browser. Confirm:
- All 4 tabs switch panels.
- Expand tab: the seed dropdown lists real entries; picking one fills the
  brief textarea, hours field, and shows the historical-context box
  updating (either real phrasebook text or the "no historical context"
  message). Clicking Run shows a result card with request/raw/parsed
  sections; the request's system message visibly contains whatever is in
  the instructions textarea.
- Narrate tab: same seed behavior; switching the mode dropdown and running
  again produces a new result card stacked above the previous one (both
  stay visible for comparison).
- Timer-start tab: picking a matter updates the context box; Run produces a
  result showing `accepted`/`rejectReason`.
- Quick-capture tab: typing a line and running shows `deterministic` vs
  `filled` fields distinctly; there is no instructions box on this tab.
- Edit an instructions textarea, click "Save to app Settings", confirm the
  button briefly shows "Saved ✓". Reload the page — the instructions
  textarea should reload with your edited text (proving it round-tripped
  through the real `settings` table). **Restore your real prompt afterward**
  if you used throwaway test text.

- [ ] **Step 3: Commit**

```bash
git add -f scripts/ai-audit/index.html
git commit -m "feat(ai-audit): build the 4-tab audit UI

Vanilla JS, no build step. Each tab: real-data seed picker, editable
inputs, a distinct historical-context preview panel, editable system
instructions, Run (live Ollama call), and a stacked run history for
side-by-side comparison of prompt tweaks."
```

---

### Task 7: Gitignore, README, final verification

**Files:**
- Modify: `.gitignore`
- Create: `scripts/ai-audit/README.md`

**Interfaces:** none — this is the closing task.

- [ ] **Step 1: Add the gitignore rule**

Modify `.gitignore` — append:

```
scripts/ai-audit/
```

- [ ] **Step 2: Untrack the files committed with `-f` in earlier tasks**

```bash
git rm -r --cached scripts/ai-audit
```

Expected output: lists `scripts/ai-audit/server.mjs` and
`scripts/ai-audit/index.html` as removed from the index (they remain on
disk — `--cached` only removes them from git tracking).

- [ ] **Step 3: Write the README**

Create `scripts/ai-audit/README.md`:

```markdown
# AI prompt audit tool

Dev-only tool to see exactly what Timekeeper's 4 AI-assist scenarios send to
the local Ollama model, using real historical entries/matters as seed data,
and to test prompt tweaks live. Not part of the deployed app; gitignored
because it displays real client/matter data pulled from `data/timekeeper.db`
at runtime.

## Run

```bash
node scripts/ai-audit/server.mjs
```

Then open http://127.0.0.1:4748/. Uses the same `data/timekeeper.db` and
local Ollama settings as the real app (`server/config.js`'s `DB_PATH`
resolution) — run it on the same box as the running Timekeeper instance.

Optional: `AI_AUDIT_PORT=<port>` to use a port other than the default 4748.

## What each tab does

- **Expand → split**: the "Expand, with split into tasks checked" scenario
  (`POST /api/ai/expand` in the real app).
- **Narrate**: draft/shorten/rewrite (and the unused `longer` mode) —
  `POST /api/ai/narrate` in the real app.
- **Timer-start suggest**: the background suggestion made when a timer
  starts (`refineSuggestedNarrative` in the real app) — this tool never
  writes to the real `timers` table.
- **Quick-capture fill**: the LLM fallback that fills fields the
  deterministic parser couldn't (`llmFill` in the real app). No editable
  system prompt — the real app has none for this scenario either.

Every tab's "Save to app Settings" button (where present) writes directly to
`settings.ai.systemPrompt` — the same field Settings → AI assist edits in
the real app, and shared across all three narrative scenarios.
```

- [ ] **Step 4: Final full-suite check**

Run: `npm test`
Expected: PASS — confirms Tasks 1–2's refactors introduced no regressions
anywhere in the app's own test suite.

- [ ] **Step 5: Commit**

```bash
git add .gitignore
git commit -m "chore(ai-audit): gitignore the tool and add its README

scripts/ai-audit/ pulls real client/matter data from data/timekeeper.db
at runtime for display, so it — and anything it might later save —
must never enter git history."
```

Note: the README you wrote in Step 3 is intentionally *not* `git add`ed —
it lives inside the now-gitignored `scripts/ai-audit/` directory and is
meant to stay local, exactly like the tool it documents.
