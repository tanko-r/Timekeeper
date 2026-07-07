# Timekeeper — Design

**Date:** 2026-07-06 · **Status:** Approved for implementation (David away; built per "make reasonable assumptions" authorization. Assumptions flagged ⚠️ for later review.)

## Goal

Self-hosted, single-user web app replacing Intapp Time for daily attorney time entry. Runs on the server box, reachable on LAN **and remotely via the existing cloudflared tunnel**. Once a day David exports finalized entries as CSV for his assistant to key into the firm's billing system. No cloud services at runtime; SQLite is the source of truth. Optimized for boring reliability — it runs unattended every day.

## Stack & key choices

| Decision | Choice | Alternatives considered |
|---|---|---|
| Backend | Node 24 + Express 5 + better-sqlite3 12 | `node:sqlite` (zero native dep, but still experimental-flagged API; better-sqlite3 is battle-tested and installs clean prebuilds on Node 24 — verified) |
| Frontend | React 18 UMD + `htm` (tagged templates), vendored locally, **zero build step** | esbuild+JSX (adds a build step & toolchain); Preact (not "plain React" per spec). No-build wins for long-term unattended reliability: view-source debuggable, no toolchain rot. React 19 dropped UMD, so React is pinned to 18.3.x. |
| Serving | Single Express server: static SPA + `/api/*`, bind `0.0.0.0:4747` | Port 4747 verified free on this box |
| Auth | Built-in password + session cookie, **enforced for remote (tunnel) requests only** by default; LAN/localhost trusted | Cloudflare Access (not configured on this box; still listed as a follow-up); no auth (unacceptable — client billing data on a public hostname) |
| Deployment | systemd **user** service (`systemctl --user`) — matches box convention (kasmvnc, another user service); linger is enabled so it starts at boot | System unit (works too; user unit keeps everything under david) |
| Remote | New cloudflared ingress: `time.example.com → 127.0.0.1:4747` | — |
| Time zone | Server-local (America/Los_Angeles) for all date boundaries and the midnight timer reset | — |

Runtime npm deps: **express, better-sqlite3** — nothing else. Password hashing via Node's built-in `crypto.scrypt`. Tests via built-in `node:test` + global `fetch`.

## ⚠️ Assumptions made in David's absence

1. **Remote auth**: The original spec said "no auth provider" — read as "no *cloud* auth." Exposing billing data via tunnel without auth is not acceptable, so: single app password (set from LAN in Settings, scrypt-hashed in DB), session cookie (30-day rolling), login rate-limited. Until a password is set, tunnel requests get a "set a password from LAN first" screen. LAN requests never see a login (config can require auth always).
2. **Midnight banking**: Spec says timers reset display to zero at local midnight and existing entries are untouched. Literal reading silently *loses* accrued-but-unstopped time (e.g. a timer paused at 1.5h and forgotten). Instead: at midnight, any timer with nonzero elapsed **banks it as a draft entry dated the day it accrued** (empty narrative → surfaces in missing-narrative alerts), then zeroes. Nothing is silently lost; drafts are easy to delete.
3. **Export shape**: one CSV row per task line, columns exactly `date, cm_number, cm_short_name, billable, task, duration, narrative` (narrative = full formatted entry narrative, repeated per line), plus trailing `entry_total, entry_id` helper columns. A print-friendly plain-text summary grouped by entry is generated alongside.
4. **Rounding default**: enabled, nearest 0.1, applied when converting timer seconds → hours (configurable: increment + nearest/up, or off). Manually typed durations are taken as typed (warned if below minimum increment).
5. **Narrative for single-task entries** is plain free text (no parenthetical); the parenthetical breakdown format kicks in at ≥2 task lines, at which point the combined narrative is generated from per-line fragments and the combined field becomes read-only.
6. **Hostname** `time.example.com`; **port** 4747; app name **Timekeeper**.
7. Empty task-line fragment falls back to the task code name in the generated narrative (e.g. `Research (0.8)`).

## Architecture

```
server/
  index.js        bootstrap: config, db, middleware, routes, static, jobs, listen
  config.js       env + defaults (PORT=4747, HOST=0.0.0.0, DATA_DIR=./data)
  db.js           better-sqlite3 open, WAL, migrations via PRAGMA user_version
  auth.js         session middleware, login/logout/set-password, remote detection, rate limit
  jobs.js         minute tick: midnight timer reset+banking, nightly backup, purge soft-deleted
  lib/
    dates.js      local-date helpers (YYYY-MM-DD in server TZ), injectable clock
    narrative.js  buildNarrative(lines) → "Frag (1.2); frag (0.3)."  (pure)
    validation.js validateEntry(entry, settings) → [{level, code, message}]  (pure)
    rounding.js   roundHours(h, {increment, mode})  (pure)
    csv.js        toCsv(rows)  (pure, RFC-4180 quoting)
  routes/         cms, taskcodes, entries, timers, settings, export, backup, stats, dashboard
public/
  index.html, css/app.css, vendor/ (react, react-dom UMD, htm — committed)
  js/ (ES modules, no build)
    app.js (hash router, shortcuts, toasts/undo), api.js, ui.js (shared widgets)
    views/ dashboard, day, calendar, search, stats, settings, cms, export, login
    components/ CmPicker, EntryEditor, TimerGrid, TargetMeter, …
test/             node:test — unit (lib/*) + API integration on a temp DB
timekeeper.service, README.md, docs/
```

Pure business logic lives in `server/lib/` with no I/O — independently testable; routes are thin.

## Data model (SQLite, WAL)

```sql
settings(key TEXT PK, value TEXT/*json*/)
cms(id PK, cm_number TEXT UNIQUE GLOB-checked '######-######', short_name TEXT,
    billable INT, status TEXT active|archived, favorite INT,
    last_used_at, created_at, updated_at)
task_codes(id PK, name TEXT UNIQUE, sort_order INT, active INT)
entries(id PK, date TEXT/*YYYY-MM-DD*/, cm_id FK, narrative TEXT, billable INT,
    status TEXT draft|finalized, total_override REAL NULL, source TEXT manual|timer,
    ack_validation INT, ever_finalized INT, exported_at TEXT NULL,
    finalized_at TEXT NULL, deleted_at TEXT NULL, created_at, updated_at)
entry_tasks(id PK, entry_id FK CASCADE, task_code TEXT/*name snapshot*/,
    duration REAL, fragment TEXT, sort_order INT)
timers(id PK, name TEXT, cm_id FK, task_code TEXT NULL, sort_order INT,
    running INT, accumulated_seconds INT, last_started_at TEXT NULL,
    last_reset_date TEXT, created_at)
sessions(token_hash TEXT PK, created_at, last_seen_at, expires_at, user_agent)
audit_log(id PK, entry_id, action TEXT, detail TEXT/*json diff*/, created_at)
```

- Task codes are stored on entries as **text snapshots** — editing/removing a code in Settings never rewrites history.
- Entry total = SUM(task durations); `total_override` only exists to power the "sum ≠ total" warning when set.
- Deletes are soft (`deleted_at`) to power Undo; purged after 7 days.

## Behaviors

**Narrative auto-format** (≥2 task lines): fragments (or task-code fallback) → trailing punctuation stripped → first fragment's first letter capitalized → `frag (d.d)` joined by `; ` → terminal `.`. Durations formatted to the rounding increment's precision. Regenerated server-side on every entry write (authoritative) and live in the editor as lines change.

**Validation** (server-computed, returned with each entry): CM format; narrative empty/under N chars (default 20); banned vague phrases (default list: "work on", "attention to", "review file", editable); sum-vs-override mismatch; block-billing (single line > 3.0h default); duration under minimum increment (0.1). All are warnings — finalize requires only the hard rules (≥1 task line, non-empty narrative, valid CM) plus one-click "finalize anyway" acknowledgment when warnings exist.

**Timers**: server-authoritative state (`accumulated_seconds` + `last_started_at`); UI ticks locally, re-syncs every 5s. Starting a second timer warns, never blocks. Stop → prompt: append task line to today's existing draft for that CM, or create a new entry (remembered preference: ask/append/new). Pause accumulates. **Midnight (per-minute tick + lazy check on read, idempotent):** bank elapsed-to-midnight as a draft entry dated the accrual day when rounded ≥ 0.1h, zero the clock, keep the button; running timers keep running from the boundary.

**Finalize**: per-day or date-range; locks entries (no edit without explicit unlock). Unlock + subsequent edits of ever-finalized entries are written to `audit_log` with field diffs, viewable in the editor.

**Export**: today / date range; finalized-only by default, drafts opt-in; produces CSV + plain-text summary; stamps `exported_at` (re-export allowed; pending-vs-exported visible in UI).

**Dashboard**: target meter (daily target, default 8.0h, billable-focused), timer grid (drag-reorder, live elapsed, idle nudge when a timer runs past a threshold, default 3h), today's entries, alert banner (missing/invalid narratives today + backlog, unexported finalized days).

**Calendar**: month + week views; per-day total split billable/non-billable; color vs daily target; click-through to day view.

**Also**: copy entry to date; search/filter (CM, range, task, billable, status, narrative keyword); bulk finalize/delete/reassign-CM; undo toasts (soft delete / unlock); autosave drafts (debounced); nightly `VACUUM INTO` backup (keep 14) + one-click .db / .json download; stats view (hours by CM / task, billable ratio, by-day); dark mode (auto + toggle); keyboard shortcuts (n new entry, t toggle last timer, / CM search, Ctrl+Enter save, ? help).

## Security model

- Remote = request bearing Cloudflare headers (`cf-ray`/`cf-connecting-ip`) or a non-RFC1918 peer address. Only path in from outside is the tunnel (no port forwarding on the router).
- Remote requests require a session; LAN/localhost bypass by default (`auth.mode: remote-only | always | off`).
- Password: scrypt (N=2^15), stored in `settings`; sessions: 32-byte random token, SHA-256 stored, httpOnly SameSite=Lax cookie, 30-day rolling expiry; login rate limit 10 fails/15 min/IP; Origin checked on mutating requests when present.
- Static SPA shell is served unauthenticated (contains no data); every `/api/*` call is guarded → SPA shows login screen on 401.

## Testing

`node:test`: unit tests for narrative/validation/rounding/csv/dates (pure functions, injectable clock for midnight cases), API integration tests against a temp DB via `fetch` (entry lifecycle, finalize/export stamping, timer stop→entry, midnight banking, auth guard + rate limit). `npm test` runs all.

## Out of scope

Multi-user, direct Intapp/billing-system API integration, mobile app (responsive web only), Cloudflare Access wiring, HTTPS-on-LAN.
