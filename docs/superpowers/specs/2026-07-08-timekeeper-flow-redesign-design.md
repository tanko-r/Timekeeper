# Timekeeper — Flow Redesign Design

**Date:** 2026-07-08
**Status:** Draft for review
**Supersedes/extends:** `2026-07-06-timekeeper-design.md` (the core app), and the
stale `PLAN_COMPACT_TIMERS.md` / `SURGICAL_CHANGES.md` in the repo root (the
compact grid shipped as the plain default in commit `13814c5`, not as a toggle).

## One-line summary

Make daily time entry **frictionless and flow-y** by compressing the whole
`timer → narrative → export` chain and making the app do the thinking — every
step becomes *confirm-and-tweak*, never *compose-from-blank* — on top of a proper
**client → matter** data model.

---

## 1. Context & problem

Timekeeper works, but the daily loop still costs too many discrete steps:
**start → work → stop (a modal every time) → narrate → finalize → export.** The
felt pain is total step-count across the chain, not any one feature.

David bills for real in **Intapp Time** (a real-estate / lease / infrastructure
/ transactional practice — clients like Meridian, Ironwood, Brightwater; matters like
Cedar Lease, Loading Dock Lease, Summit Development Agreement). Intapp's
timer screen is the *least* bad part of it — dense, grouped, one-click start — its
only faults are that it's ugly and a little feature-poor. **The misery is
everywhere downstream**: narrative entry and the billing workflow. That is exactly
where this app must radically outclass Intapp.

Note: the terse timer labels (`MTR09`, `MTR12 – Cedar Lease`) are David's *own
meaningful shorthand* — an asset, not a problem. Nothing here "fixes" them.

## 2. Design principles (the north star)

> **Minimize clicking, typing, and thinking.** Pre-fill the likely answer from
> context so entry is *confirm-and-tweak*, never *compose-from-blank*. You are
> never staring at an empty box.

Corollaries that shape every decision below:

- **Deterministic-first, LLM-fallback.** The box runs a slow local Ollama
  (`llama3.1:8b`, ~180s on CPU). Anything that must feel instant (autocomplete,
  suggestions, parsing common shapes) is built from the user's **own history**
  with plain code — fast and fully private. The LLM is a fallback for novel work,
  and it streams when used.
- **The grid stays lean; the craft goes downstream.** Keep the compact timer grid
  clean and quick; pour intelligence, motion, and flow into everything after
  *stop*.
- **Motion confirms.** A small, tasteful micro-animation language makes actions
  feel alive and the running total feel real.
- **Business logic is pure + tested.** New logic lands in `server/lib/*` as pure
  functions with `node:test` unit tests; routes stay thin; frontend stays no-build
  (React UMD + htm); runtime deps stay `express` + `better-sqlite3`.

---

## 3. Foundational change — Client → Matter data model

Everything else sits on this, so it lands first.

### 3.1 Today

There is **no client entity**. A single flat `cms` table stores `cm_number` as a
13-char string constrained to `xxxxxx-xxxxxx` (`db.js:17`); client and matter
numbers are smashed together. `entries` and `timers` FK to `cm_id`. Validation
uses `CM_RE = /^\d{6}-\d{6}$/`.

### 3.2 Target model

- **`clients`** — `id`, `client_number` (6-digit, unique), `name`
  (e.g. "Meridian"), timestamps.
- **`matters`** (reshaped `cms`) — `id`, `client_id` FK, `matter_number`
  (6-digit), `short_name`/`name` (e.g. "Harbor Leases"), `billable`, `status`,
  `favorite`, `last_used_at`, timestamps. **Unique(`client_id`, `matter_number`)**.
- **CM# is derived**, never stored: `client_number || '-' || matter_number` →
  `xxxxxx-xxxxxx`. So `.TIM`/CSV export and `CM_RE`/GLOB validation still see the
  same 13-char string — **the split is internal; export shape does not change.**
- `entries.cm_id` and `timers.cm_id` repoint to `matters.id` (kept as a rebuild
  migration since SQLite ALTER is limited; DB is test data, so low-stakes).

### 3.3 Migration

Append a migration (v4) to `MIGRATIONS` in `server/db.js` (PRAGMA `user_version`):
create `clients` + `matters`; for each existing `cms` row split `cm_number` on
`-`, upsert the client with a **blank name** (rendered as just the 6-digit number
until filled in via the Clients/Matters view — a visible prompt to name it), move
the matter across with `client_id`, and repoint FKs. Never mutate old migrations.

### 3.4 Ripple / interfaces

- **CM picker (`cmpicker.js`)** becomes client-aware: one unified fuzzy search over
  client name/number + matter name/number (typing "meri harbor" matches), showing
  the hierarchy; a client→matter path when creating a new matter.
- **Both grouping axes coexist** (decided): timers can be organized **by client**
  (auto, like Intapp's client tabs) *and* by the existing user-defined
  `timer_groups` (e.g. "Litigation", cutting across clients). The timer dashboard
  gains a grouping selector (e.g. *By client · By group · Flat*).
- A `cmNumber(matter)` helper in `server/lib/*` centralizes the derived string;
  validation validates the derived value.

---

## 4. The compact timer grid (ratify + extend)

The shipped single-line card (`.timer-card`, `timergrid.js:312`) is the **baseline
and stays** — this is the "grid stays lean" principle. The redesign extends it:

- **Grouping views:** the by-client / by-group / flat selector from §3.4 (the good
  part of the Intapp screenshot, done cleanly).
- **Type-to-filter** (TODO #1): typing while the grid is focused live-filters cards
  by client/matter name, short name, and timer label — in place, no navigation
  (distinct from the `/` full-text search that leaves the page).
- **Worked-today highlight** (TODO #2): a distinct, theme-aware treatment for
  timers with accumulated time today (elapsed > 0 or `linked_entry_id` set) vs.
  still-at-zero, separate from `.running` and from `.idle-nudge`.
- **Keyboard focus model** (TODO #3 / lever C): a real "focused timer" concept
  (roving `tabindex`) so start/stop, nudge (±0.1/±0.2), edit, and quick-note are
  reachable by key without the mouse.
- **Persistent, animated "today" footer:** running timer (live) + billable-vs-target
  mini-meter + a one-key "close the day" — ambient awareness without navigating.

---

## 5. The memory layer (the intelligence)

Both are **derived from the user's own `entries` / `entry_tasks` history** —
deterministic, private, instant, and smarter the more the app is used. They start
cold (test DB) and warm up naturally. New logic is pure functions in
`server/lib/*` with unit tests; thin endpoints expose them.

- **Per-matter phrasebook** (`server/lib/phrasebook.js`): aggregate past task-line
  `fragment`s and narratives for a matter, ranked by frequency × recency → the
  matter's recurring "moves." The client entity lets a **brand-new matter borrow
  its client siblings' phrasebook** so it starts warm. Endpoint:
  `GET /api/matters/:id/suggestions`.
- **Self-building people roster** (`server/lib/people.js`): extract counterparty
  names from narratives via deterministic patterns ("telephone conference with
  **X**", "email to **X**", "correspondence with **X**") as entries are saved,
  cached in a small `matter_people(matter_id, name, count, last_seen_at)` table,
  ranked by recency. Powers one-tap call/email.

---

## 6. Capture & narration (the flow)

Each of these consumes §5 and applies the confirm-don't-compose principle.

- **Ghost-text narrative autocomplete** (magic #2): as you type a fragment, a grey
  completion appears from the matter's phrasebook (prefix + rank); **Tab** accepts.
  **Deterministic — no LLM** — so it's Copilot-fast and private. Because the good
  phrasing is offered *before* you commit, the banned vague phrases (`work on`)
  your validator flags simply never get typed.
- **Tap-able narrative chips on stop** (magic #3 support): the stop step offers 2–3
  ready narratives for *this* matter (frequency over history) — tap = filed. The
  per-stop modal (`StopPopup`, `timergrid.js:303`) is replaced by this lightweight,
  non-blocking affordance (or deferred entirely to close-out, §7).
- **Suggested narrative on timer start** (David's idea): starting a timer
  pre-computes a likely narrative (phrasebook first; optional async `llama3.1`
  pass) so it's ready before you stop.
- **Bill from a sentence** (magic #1): a global quick-capture (one hotkey, always
  available) parses one raw line — `call sam re loading dock lease .3` — into a
  finished, ready-to-approve entry. A pure parser (`server/lib/quickcapture.js`,
  unit-tested) extracts {matter query → fuzzy-matched matter, duration (`.3`,
  `18m`, `1h`), action verb → task code + narrative stub, counterparty via
  `w/ X` / `re: X`}. Deterministic for common shapes; **LLM fallback** for messy
  lines. You approve; it files.
- **Text-expansion shortcuts** (David's idea): a user-defined abbreviation →
  phrase dictionary, expanded inline in fragment/narrative fields (`IA` →
  `Interconnect Agreement`, `tc/oc` → `telephone conference with opposing
  counsel`). Deterministic, distinct from the semantic phrasebook. **The
  dictionary is managed as a separate store — the Settings chip-UI approach is
  paused.** The design emphasis is *building the dictionary in-flow*: offer a way
  to add a frequently-used phrase, term, or name to the dictionary directly from
  the narrative UI (e.g. select text → "save as shortcut"), so it grows from real
  use rather than upfront configuration. (Exact in-flow affordance is an open
  question for phase planning.)
- **Faster AI narration:** where the LLM *is* used (bill-from-a-sentence fallback,
  novel narratives), stream tokens to the UI and add regenerate + shorter/longer,
  replacing the single blocking spinner (`ai.js:97`).

---

## 7. Close-out & motion

- **One-sweep close-out** (lever B): stops file silently as drafts; all narration
  happens in one end-of-day **card stack** — one draft at a time, centered,
  narrative pre-filled from §5, driven by keys: **Enter** accept · **Tab** edit ·
  **↓** skip. It ends in a single action that **finalizes the clean entries AND
  exports** (reusing `POST /api/finalize-day` + `POST /api/export`), so the two
  tail steps merge into one motion. Closes on a "Day closed — 8.2h · exported"
  moment.
- **Micro-animation language:** a small, tasteful motion system — timer-start
  pulse and clock "spin-up"; stop-and-file sends the time *flying* into the
  animated today-total in the footer; a soft "lock" on finalize; entries sweep on
  export. Motion confirms actions and keeps the total feeling alive. Respects
  `prefers-reduced-motion`. **Keep every animation _very_ subtle — restraint over
  flourish; when in doubt, less. This is a constraint, not a suggestion.**

---

## 8. Architecture & conventions

- **Backend:** new logic as pure functions in `server/lib/*` (`phrasebook`,
  `people`, `quickcapture`, `cmNumber`, `shortcuts`) with `node:test` unit tests;
  thin routes; all writes via prepared statements. Schema changes = appended
  migrations (`clients`, `matters`, `matter_people`) guarded by `user_version`.
- **Frontend:** no-build React 18 UMD + htm; new browser code as plain ES modules
  under `public/js/`. Ghost-text, chips, quick-capture, close-out, and the footer
  are new components/hooks; the CM picker and timer grid are extended.
- **AI:** local Ollama only; deterministic-first, streamed LLM fallback. No new
  runtime dependency without agreement (`express` + `better-sqlite3` only).
- **Dates/durations:** unchanged — local `YYYY-MM-DD`, decimal hours, round-up-to-
  tenth house rule.

## 9. Build sequence (phased; each phase shippable and testable)

1. **Foundation — Client/Matter** (§3) + the compact-grid grouping views (§4
   grouping selector). Unblocks everything. Mostly backend + CM picker + grid.
2. **Memory layer** (§5) — phrasebook + people roster. Backend-heavy, pure
   functions + tests; the intelligence everything else consumes.
3. **Narration UX** (§6) — ghost-text, chips, suggested-on-start, shortcuts,
   streamed AI — consuming Phase 2. Plus the remaining grid extensions (§4:
   type-to-filter, worked-today highlight, keyboard focus).
4. **Capture & close-out** (§6 bill-from-a-sentence, §7) — quick-capture, the
   close-out card stack, the motion language, and the animated today footer /
   keyboard "close the day."

Each phase gets its own implementation plan (via writing-plans) and atomic commits.

## 10. Testing

- **Unit (`npm test`, node:test):** every `server/lib/*` addition — phrasebook
  ranking, name extraction, shortcut expansion, quick-capture parsing, derived
  CM# / migration invariants.
- **E2E (`node scripts/e2e-smoke.mjs`):** extend the headless-Chromium pass for the
  new critical flows — create client+matter, timer → stop → chip-narrate, ghost-
  text accept, bill-from-a-sentence, and the close-out sweep to export. Keep
  existing assertions green (or update them deliberately, as the compact-grid
  commit did).

## 11. Deliberate decisions & open questions

**Decided**
- Both timer grouping axes coexist (client + user groups).
- Magic set: bill-from-a-sentence, ghost-text autocomplete, self-building people
  roster are IN.
- Compact single-line timer grid is the ratified baseline (already shipped).
- Migration leaves migrated client names **blank** (rendered as the 6-digit number
  until filled in).

**Out of scope**
- Leakage / unaccounted-time catcher (#6) — David passed.
- Note-as-you-go per-session timer note (lever A) — folded into per-matter memory.
- Non-pipeline polish (Stats/Calendar/CM analytics drill-through, etc.) — parked in
  `TODO.md`.

**Open questions (to settle during phase planning)**
- Does the stop step keep a lightweight chip affordance, or defer *all* narration
  to close-out? (Leaning: keep instant chips for one-tap cases, defer the rest.)
- People-roster extraction scope: per-matter only, or cross-matter (same person on
  multiple matters)?
- Ghost-text trigger surface: entry editor + close-out only, or also the quick-
  capture bar?
