# AI prompt audit tool — design

## Purpose

Timekeeper has four places where a local Ollama model assists with time
entries (task-split expand, narrate/shorten/rewrite, timer-start suggested
narrative, quick-capture fill). There is no existing log of what gets sent to
the model or what comes back — briefs are ephemeral and only the final,
unflagged `entries.narrative`/`entry_tasks.fragment` persist. David wants a
standalone tool to audit exactly what each scenario sends to the model
(including which historical narrative text gets pulled in as context),
review example output, and iterate on prompt wording — using **live replay**
against real historical data in `data/timekeeper.db`, not a new log table.

## Non-goals

- No new `ai_log`/request-response table. (Considered and rejected — see
  "data source" below.)
- Not part of the deployed app; not reachable over the cloudflared tunnel.
- No change to production runtime dependencies (still exactly `express` +
  `better-sqlite3`; the audit tool adds zero npm packages).
- Not a general prompt-testing playground for arbitrary models — it targets
  the same local Ollama the app uses, via the app's real settings row.

## Data source: live replay, not logging

Confirmed by direct inspection of `data/timekeeper.db`: the only tables are
`entries`, `entry_tasks`, `timers`, `matters`, `clients`, `matter_people`,
`custom_fields`/`entry_custom_values`, `task_codes`, `timer_groups`,
`shortcuts`, `sessions`, `settings`, `audit_log`. `audit_log` records
before/after diffs for entry `edit`/`unlock`/`import`/`delete` actions only —
nothing AI-specific, no prompt or response ever written anywhere.

So the tool reconstructs realistic inputs from what *is* real and
persisted: past entries' narratives, matters' phrasebook phrases
(`matter_people` + narrative history via the existing `matterSuggestions`
memory layer), and task codes. It calls Ollama live, using the exact prompt-
building code the app itself uses (imported, not copied), so what you see is
never a stale reconstruction.

## Reused code (no duplication)

The audit server imports directly from the real route files rather than
re-implementing prompt text, following the pattern the codebase already
flags as an anti-pattern to avoid (`public/spike-webllm.html`'s "copied
verbatim... re-sync by hand" comment).

Already exported and reusable as-is:
- `server/routes/ai.js`: `DEFAULT_AI_INSTRUCTIONS`, `matterAiContext`,
  `timeGroundingRule`, `buildNarrateMessages`.

Small additive exports needed (no behavior change, existing tests re-run
after to confirm):
- `server/routes/ai.js`: export `systemPrompt` and `formatContract` (used by
  `/ai/expand`) and `NAME_RESOLUTION_RULE`.
- `server/routes/quickcapture.js`: factor `llmFill`'s inline system-prompt
  string into an exported builder (e.g. `buildLlmFillMessages(line, parsed,
  taskCodes)`) so the audit tool calls the real prompt construction instead
  of a copy.

The timer-start scenario needs no refactor: `refineSuggestedNarrative` itself
mutates `timers` and can't be reused directly, but it's a thin wrapper around
`buildNarrateMessages` + `matterAiContext`, both already exported — the audit
tool replicates that composition against a real, live-read `cm_id`, never
touching the real `timers` table.

## The four audit cards

Each card has: a real-data seed picker, editable inputs, a distinctly
labeled "historical narrative context that will be injected" panel, an
editable system-instructions textarea, a Run button, and a result panel
showing the exact request and response.

| Card | Real seed data | Editable inputs | Prompt builder used |
|---|---|---|---|
| Expand → split into tasks | Dropdown of real past entries; selecting one pre-fills the brief textarea with that entry's real narrative | brief, totalHours, matter, system instructions | `systemPrompt` + `formatContract` (real `/ai/expand` logic) |
| Narrate (draft/shorten/rewrite) | Same entry picker | brief/narrative text, mode, totalHours, matter, system instructions | `buildNarrateMessages` (real `/ai/narrate` logic) |
| Timer-start suggestion | Dropdown of real matters (pulls real `short_name` + live phrasebook phrases) | matter, timer label, system instructions | `buildNarrateMessages` composed the same way `refineSuggestedNarrative` does |
| Quick-capture fill | Free-text line (optionally seeded from a real narrative fragment) | the line, already-determined hours/task_code | `buildLlmFillMessages` (real `llmFill` logic) — no system-instructions override; this scenario has no customizable prompt in the real app today |

**"Historical narrative context" panel:** for the three scenarios that call
`matterAiContext`, this panel renders the exact "People from this matter's
history" and "attorney's recent work on this matter" lines that function
returns for the selected matter — i.e., the real historical narrative
fragments about to be embedded in the prompt — shown before Run is even
clicked, and again inside the full raw request afterward.

**Result panel:** raw system+user messages sent (monospace, collapsible),
raw model response, and the parsed result (narrative / tasks / filled
fields, matching what the real endpoint would return to the app). Runs stack
up in a session history list so a baseline run and a tweaked-prompt run stay
visible side by side for comparison.

## Save-to-settings (secondary, implement if straightforward)

For the three scenarios sharing `settings.ai.systemPrompt` (expand, narrate,
timer-suggestion — not quick-capture, which has no such field), a "Save this
instructions text to app Settings" button writes directly to the real
`settings` table, identical to what Settings → AI assist's textarea does.
This is the one deliberate, user-initiated write the tool makes to the real
DB; every other operation (seed picking, context preview, running against
Ollama) is read-only. Skip this if it turns out to add meaningful complexity
— the read-only tool is already useful without it.

## File layout

```
scripts/ai-audit/
  server.mjs   # http server: opens data/timekeeper.db, imports real prompt
               # builders from server/routes/{ai,quickcapture}.js, exposes
               # endpoints for seed data + live Ollama calls, serves index.html
  index.html   # the audit page — vanilla JS/CSS, no build, no framework
  README.md    # how to run it: node scripts/ai-audit/server.mjs, then open
               # http://localhost:4748
```

`scripts/ai-audit/` is added to `.gitignore` in full — the tool pulls real
client/matter/narrative text out of the DB at runtime for display, and (per
the confidentiality rule already established for this repo) none of that
may end up in git history, even indirectly via a committed tool that's
obviously meant to display it.

## Verification plan

- Run `npm test` after the `ai.js`/`quickcapture.js` export changes to
  confirm no behavior change.
- Manual run: start the audit server, exercise all four cards against the
  real local Ollama (already confirmed reachable, `enabled: true` in the
  live settings row), confirm the context panel matches what
  `matterAiContext` actually returns for a couple of real matters, confirm
  raw request/response shown match what the corresponding real endpoint
  would send/receive for the same inputs.
- No automated tests for the audit tool itself — it's a read-mostly dev
  script outside the app's test surface, consistent with its non-goal of
  being production code.
