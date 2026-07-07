# Timekeeper Implementation Plan

> **For agentic workers:** Executed inline (superpowers:executing-plans) by the spec author in-session — task granularity and interfaces are binding; code bodies live in the implementation, not this doc. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the Timekeeper app per `docs/superpowers/specs/2026-07-06-timekeeper-design.md`, deployed as a systemd user service on this box, reachable on LAN and via cloudflared.

**Architecture:** Single Express 5 server: `/api/*` JSON + static no-build React 18 UMD/htm SPA. better-sqlite3 (WAL) as source of truth. Pure business logic in `server/lib/*` (unit-tested), thin routes (integration-tested via `fetch` against a temp-DB server instance).

**Tech Stack:** Node 24, Express 5, better-sqlite3 12, React 18.3 UMD + htm 3 (vendored), `node:test`.

## Global Constraints

- Runtime npm deps: `express`, `better-sqlite3` ONLY. Frontend vendored, zero build step.
- No external network calls at runtime. React pinned 18.3.x (19 has no UMD).
- All dates: local server TZ, `YYYY-MM-DD` strings. Timestamps: ISO 8601 with offset.
- Durations: decimal hours (REAL). Money never appears anywhere.
- CM format: `^\d{6}-\d{6}$`, enforced app-level + SQLite `GLOB` CHECK.
- Port 4747, bind 0.0.0.0. DATA_DIR default `<repo>/data` (gitignored).
- Soft-delete entries (`deleted_at`), 7-day undo window, nightly purge.
- Every API error: JSON `{error: "message"}` with proper status; never HTML errors from `/api/*`.
- Commits: atomic per task, conventional-commit style messages.

---

### Task 1: Scaffold + vendored frontend runtime ✅when: server boots, `/api/health` 200, `/` serves shell, vendor files load
**Files:** `package.json`, `.gitignore`, `server/index.js`, `server/config.js`, `public/index.html`, `public/vendor/{react.production.min.js,react-dom.production.min.js,htm.module.js}` (copied from npm react@18.3.1/react-dom@18.3.1/htm@3.1.1)
**Produces:** `config = {PORT, HOST, DATA_DIR, DB_PATH}` (env-overridable); Express `app` exported as `createApp(deps)` factory + `index.js` listener split (so tests can boot on port 0).
- [ ] npm init, install deps, vendor UMD files, .gitignore (`node_modules/`, `data/`)
- [ ] `createApp()` + health route + static; boot smoke test; commit

### Task 2: DB layer + migrations + seeds
**Files:** `server/db.js`, `test/db.test.js`
**Produces:** `openDb(dbPath)` → better-sqlite3 instance, WAL, FK on, migration to schema v1 (exact SQL in spec §Data model), seeded `task_codes` (Review; Draft; Revise; Research; Correspondence; Call/Conference; Negotiate; Travel; Court Appearance; Due Diligence; Closing), settings defaults JSON:
`validation={minNarrativeChars:20, bannedPhrases:["work on","attention to","review file"], blockBillingHours:3.0, minIncrement:0.1}`, `rounding={enabled:true,increment:0.1,mode:"nearest"}`, `targets={dailyHours:8.0}`, `timerStopAction:"ask"`, `idleNudgeHours:3`, `backup={keep:14}`, `auth={mode:"remote-only"}`.
- [ ] Failing tests: tables exist, seeds present, idempotent reopen, CM CHECK rejects bad format
- [ ] Implement, pass, commit

### Task 3: lib/dates + lib/rounding (pure)
**Files:** `server/lib/dates.js`, `server/lib/rounding.js`, `test/dates.test.js`, `test/rounding.test.js`
**Produces:** `todayLocal(now?)`, `toLocalDate(dateObj)`, `localMidnightISO(dateStr)`, `addDays(dateStr,n)`, `isValidDate(str)`, `weekBounds(dateStr)`, `monthGrid(yyyyMm)`; `roundHours(h,{increment,mode})` (nearest|up, increment>0), `secondsToHours(sec, rounding)`.
- [ ] Tests incl. DST boundaries (America/Los_Angeles 2026-03-08, 2026-11-01), rounding edges (0.049→0/0.1 by mode; banker's-free `Math.round`)
- [ ] Implement, pass, commit

### Task 4: lib/narrative (pure)
**Files:** `server/lib/narrative.js`, `test/narrative.test.js`
**Produces:** `buildNarrative(lines, {increment})` where `lines=[{fragment, taskCode, duration}]` → per spec §Behaviors: single line → `null` (caller keeps free text); ≥2 → `"Cap(frag1) (1.2); frag2 (0.3)."`; fragment fallback = taskCode; strips trailing `.`/`;`/whitespace from fragments; duration decimals match increment precision (0.1→1dp, 0.25/0.05→2dp); `durationLabel(h, increment)` exported too.
- [ ] Tests: 2+ lines format exactly like spec example; fallback; punctuation stripping; capitalization only of first; decimals; empty-everything line skipped
- [ ] Implement, pass, commit

### Task 5: lib/validation (pure)
**Files:** `server/lib/validation.js`, `test/validation.test.js`
**Produces:** `CM_RE`; `validateCmNumber(s)`; `validateEntry(entry, settings)` → `[{level:'warn'|'block', code, message}]` with codes: `narrative_empty`(block at finalize)/`narrative_short`/`banned_phrase`/`sum_mismatch`(vs total_override)/`block_billing`/`min_increment`/`no_task_lines`(block)/`zero_duration`; `canFinalize(entry, settings)` → `{ok, blocks:[], warns:[]}` (warns pass with `ack_validation`).
- [ ] Tests per rule + finalize gate matrix
- [ ] Implement, pass, commit

### Task 6: lib/csv (pure)
**Files:** `server/lib/csv.js`, `test/csv.test.js`
**Produces:** `toCsv(headerArr, rowsArrOfArr)` RFC-4180 (quote when needed, CRLF, embedded quotes doubled, leading `=+-@` prefixed with `'` to defang spreadsheet formulas).
- [ ] Tests, implement, commit

### Task 7: CM / task-code / settings routes
**Files:** `server/routes/cms.js`, `server/routes/taskcodes.js`, `server/routes/settings.js`, wire in `server/index.js`, `test/api.cms.test.js`
**Produces (REST, all `/api`):** `GET/POST /cms`, `PATCH/DELETE /cms/:id` (archive not hard-delete when referenced; `?includeArchived=1`), `GET /cms/picker?q=` → favorites→recent→alpha, active only. `GET/POST/PATCH/DELETE /task-codes` + `PUT /task-codes/order {ids}`. `GET /settings`, `PATCH /settings {key:value,...}` (deep-merged per key, validated).
- [ ] Integration tests (temp DB, port 0): CRUD, format rejection 400, picker ordering, settings merge
- [ ] Implement, pass, commit

### Task 8: Entries CRUD + narrative regen + soft delete/copy
**Files:** `server/routes/entries.js`, `test/api.entries.test.js`
**Produces:** `GET /entries?date=|from=&to=&cm_id=&task=&billable=&status=&q=&includeDeleted=` → `[{...entry, cm:{...}, tasks:[...], total, validation:[...]}]`; `POST /entries {date, cm_id, billable?, narrative?, tasks:[{task_code,duration,fragment}]}` (billable defaults from CM); `PATCH /entries/:id` (rejects finalized 409 unless unlocked; regenerates narrative when tasks.length≥2; bumps cm.last_used_at); `DELETE` soft; `POST /entries/:id/restore`; `POST /entries/:id/copy {date}` → new draft, exported_at/finalized fields cleared.
- [ ] Tests: lifecycle, narrative regen on line edit, single-line free text preserved, finalized edit 409, soft-delete filtered + restorable, copy resets state, filters/search
- [ ] Implement, pass, commit

### Task 9: Finalize / unlock / audit / bulk
**Files:** `server/routes/entries.js` (extend), `test/api.finalize.test.js`
**Produces:** `POST /entries/:id/finalize {ack?}` → 422 `{blocks,warns}` when gated; `POST /entries/:id/unlock` (audit `unlock`); PATCH on ever_finalized logs audit `edit` with `{field:[old,new]}` diff; `GET /entries/:id/audit`; `POST /finalize-day {date|from,to, ack?}` → `{finalized:[ids], blocked:[{id,blocks}]}`; `POST /entries/bulk {ids, action:finalize|delete|restore|unlock|set_cm, cm_id?}`.
- [ ] Tests: gate matrix, ack flow, audit diffs recorded, day-finalize partial success, bulk ops
- [ ] Implement, pass, commit

### Task 10: Timers API
**Files:** `server/routes/timers.js`, `server/lib/timerlogic.js` (pure elapsed/rollover calc), `test/api.timers.test.js`
**Produces:** `GET /timers` → `[{..., elapsed_seconds, running}]` (lazy midnight rollover applied first); `POST /timers {name, cm_id, task_code?}`; `PATCH /timers/:id`; `DELETE`; `PUT /timers/order {ids}`; `POST /timers/:id/start` → `{timer, warning?}` warning listing other running timers (never blocks); `POST /timers/:id/pause`; `POST /timers/:id/stop {action:'new'|'append', entry_id?}` → converts elapsed via rounding settings into: new draft entry (source `timer`, task line = default task or first task code, fragment "") or appended task line to given/today's draft for that CM; zeroes clock, returns `{entry, hours}`; `GET /timers/stop-context/:id` → today's draft entries for that CM (for the UI prompt). `timerlogic.elapsedSeconds(timer, nowMs)`, `timerlogic.rollover(timer, todayStr, midnightMs)` → `{bankSeconds, bankDate}`.
- [ ] Tests (injected clock): start/pause/stop accumulate; stop→new entry hours rounded; stop→append adds line + narrative regen; concurrent-start warning; sub-0.05h stop discards (below rounding) with `hours:0`, no entry
- [ ] Implement, pass, commit

### Task 11: Jobs — midnight banking, backups, purge
**Files:** `server/jobs.js`, `test/jobs.test.js`
**Produces:** `runJobs(db, now)` idempotent minute-tick body + `startJobs(db)` setInterval(30s) wrapper. Midnight: for each timer with `last_reset_date < today`: `bankSeconds` = elapsed at that day's end; if `secondsToHours(bank, rounding) ≥ minIncrement` → draft entry dated `last_reset_date` (empty narrative/fragment, source `timer`); zero accumulated; running timers restart from midnight; set `last_reset_date=today`. Nightly (once per date): `VACUUM INTO data/backups/timekeeper-YYYY-MM-DD.db`, prune to `backup.keep`; purge soft-deleted entries older than 7 days; prune expired sessions. Job bookkeeping in `settings('jobs_state')`.
- [ ] Tests (temp dirs, fake now): running-timer crosses midnight → banked draft yesterday + still running today from 0; paused timer banked; tiny remainder dropped; multi-day gap banks to last_reset_date; backup file created and pruned; purge works; double-run same tick = no-op
- [ ] Implement, pass, commit

### Task 12: Export + stats + dashboard endpoints
**Files:** `server/routes/export.js`, `server/routes/stats.js`, `server/routes/dashboard.js`, `test/api.export.test.js`
**Produces:** `POST /export {from,to,includeDrafts=false,markExported=true}` → `{csv, text, count, entry_ids}`; CSV header exactly `date,cm_number,cm_short_name,billable,task,duration,narrative,entry_total,entry_id`; one row per task line; billable → `billable|non-billable`; text = per-entry grouped summary. Stamps `exported_at` on included finalized entries when markExported. `GET /export/preview?from&to&includeDrafts`. `GET /stats?from&to` → `{byCm:[{cm_id,cm_number,short_name,hours,billableHours}], byTask:[{task,hours}], byDay:[{date,hours,billableHours}], billableRatio}`. `GET /dashboard` → `{date, today:{total,billable,nonbillable,target,entries}, timers:[...], alerts:{invalidDrafts:[{id,date,cm,codes}], backlogCount, unexportedFinalized}, lastExport}`.
- [ ] Tests: only finalized by default; drafts flag; exported_at stamped once-but-reexportable; CSV quoting via lib; stats math; dashboard aggregates
- [ ] Implement, pass, commit

### Task 13: Auth
**Files:** `server/auth.js`, wire into `createApp` before `/api`, `test/api.auth.test.js`
**Produces:** `isRemote(req)` (CF headers `cf-ray`/`cf-connecting-ip` OR peer/XFF outside RFC1918+loopback); guard: `auth.mode` `remote-only`(default)/`always`/`off`; unauth remote → 401 `{error:"auth_required"}`, or 403 `{error:"no_password_set"}` when no password configured. `POST /api/auth/login {password}` (scrypt verify, N=2^15; 10 fails/15min/IP → 429), sets `tk_session` cookie (httpOnly, SameSite=Lax, Secure when `x-forwarded-proto=https`, 30d rolling, sha256(token) in `sessions`); `POST /api/auth/logout`; `GET /api/auth/status` → `{authRequired, loggedIn, passwordSet, remote}`; `POST /api/auth/password {current?, next}` — only from LAN or logged-in session. Origin check on mutating requests when Origin present (must match Host or configured hostname `time.example.com`).
- [ ] Tests: LAN passes without session; CF-header request 401→login→cookie→200; wrong password + rate limit 429; password change requires current; mode=always enforces on LAN; mode=off never guards
- [ ] Implement, pass, commit

### Task 14: Frontend foundation (shell, router, api, styles, login)
**Files:** `public/index.html`, `public/css/app.css`, `public/js/{app.js,api.js,ui.js}`, `public/js/views/login.js`
**Produces:** htm bound as `html`; hash router `#/`,`#/day/:date`,`#/calendar`,`#/search`,`#/stats`,`#/settings`,`#/cms`,`#/export`; global contexts (settings, toast/undo bus); `api.get/post/patch/del` (JSON, 401 → login view, error toasts); dark/light via `prefers-color-scheme` + persisted toggle; keyboard: `n` new entry, `t` toggle last timer, `/` CM search, `g d|c|s|e` nav, `?` help overlay, `Ctrl+Enter` save, `Esc` close. `ui.js`: Modal, Toast/UndoBar, ConfirmDialog, Icon set (inline SVG), Billable badge, date helpers mirroring server rules.
- [ ] `node --check` every module; served-files smoke test; commit

### Task 15: Dashboard view (timers, target meter, alerts) — read dataviz skill first (meter)
**Files:** `public/js/views/dashboard.js`, `public/js/components/{timergrid.js,targetmeter.js}`
**Produces:** timer grid (create/edit/delete, drag reorder → PUT order, start/pause/stop with live 1s tick synced to server every 5s, concurrent-start warning toast, idle nudge badge past `idleNudgeHours`); stop flow modal per `timerStopAction` setting (ask/append/new + "remember"); target meter (billable vs daily target + total); alerts banner (invalid drafts w/ jump links, backlog count, unexported finalized); today's entries with quick edit/finalize/export-today buttons.
- [ ] Manual DOM smoke via headless chromium if available; commit

### Task 16: Entry editor + CM picker + day view
**Files:** `public/js/components/{entryeditor.js,cmpicker.js}`, `public/js/views/day.js`
**Produces:** CmPicker (type-ahead `/cms/picker`, favorites★/recent sections, keyboard nav, inline "new CM" affordance); EntryEditor drawer: date, CM, billable override chip, task lines (code select, duration input, fragment text, add/remove/reorder), live generated-narrative preview (read-only when ≥2 lines, editable free text when ≤1), total (editable when 1 line → writes through; override warning surfaced), validation banners w/ finalize-anyway ack, autosave (600ms debounce, dirty indicator, never loses text), copy-to-date, audit history section for ever-finalized, delete w/ undo toast. Day view: `#/day/:date` entry list, day totals, finalize-day button showing blocked list, prev/next day keys `[`/`]`.
- [ ] Smoke + commit

### Task 17: Calendar view
**Files:** `public/js/views/calendar.js`
**Produces:** month grid + week strip toggle; per-day: total, billable/non-billable split bar, color vs `targets.dailyHours` (≥100% ok / 50–99% warn / <50% low / 0 muted; weekends muted); click → day view; month nav + "today".
- [ ] Smoke + commit

### Task 18: Search, stats, export views
**Files:** `public/js/views/{search.js,stats.js,exportview.js}`
**Produces:** Search: filter bar (CM picker, range, task, billable, status, keyword) → results table, bulk select → finalize/delete/reassign-CM (modal w/ CM picker), CSV-of-results download. Stats: range presets (this week/month/last month/custom), hours by CM + by task (CSS bar lists per dataviz guidance), billable ratio, by-day mini chart. Export: today/range, include-drafts toggle, preview table, download `.csv` + copy plain-text, exported/pending badges, export history (last export per day).
- [ ] Smoke + commit

### Task 19: Settings + CM management views
**Files:** `public/js/views/{settings.js,cms.js}`
**Produces:** Settings tabs: General (targets, rounding, timer stop action, idle nudge, theme), Task codes (add/rename/deactivate/drag reorder), Validation (min chars, banned phrases chips, block-billing threshold, min increment), Remote access (password set/change, auth mode, session count + revoke all), Backup (nightly status, keep-N, download .db/.json). CMs view: table w/ search, add/edit modal (CM number mask `______-______`), billable default, favorite ★ toggle, archive/unarchive, entry counts.
- [ ] Smoke + commit

### Task 20: Backup/restore endpoints + systemd + README + CLAUDE.md
**Files:** `server/routes/backup.js`, `timekeeper.service`, `README.md`, `CLAUDE.md`, `scripts/install-service.sh`
**Produces:** `GET /api/backup/db` (VACUUM INTO tmp → download), `GET /api/backup/json` (full dump incl. settings). Unit: `~/.config/systemd/user/timekeeper.service` (Restart=on-failure, WorkingDirectory=repo, `ExecStart=node server/index.js`). README: setup, service install, data/backup locations, export workflow, auth/remote, task-code & validation config via Settings UI, keyboard shortcuts, troubleshooting. CLAUDE.md: project conventions for future sessions.
- [ ] Tests for backup endpoints; commit

### Task 21: Deploy + cloudflared
- [ ] `npm ci --omit=dev`; run full test suite; install+enable user service; verify `curl http://localhost:4747/api/health` + LAN IP
- [ ] Backup `/etc/cloudflared/config.yml`; add `time.example.com → http://127.0.0.1:4747` above catch-all; DNS route via `cloudflared tunnel route dns` (or CF API/wildcard fallback — probe first); restart cloudflared; verify new hostname AND all pre-existing hostnames still respond; commit service/docs deltas

### Task 22: Verification + review + handoff
- [ ] superpowers:verification-before-completion — full `npm test`, service status, LAN+tunnel checks, auth checks from "remote" (CF-header simulation)
- [ ] Headless-browser end-to-end pass of core flows (`verify` skill) if chromium available
- [ ] Dispatch code-reviewer subagent (superpowers:requesting-code-review); fix findings; commit
- [ ] Save project memory; write David a summary: what shipped, URLs, password-setup step, assumptions to review

## Self-review

Spec coverage checked against design doc §§ Goal/Stack/Assumptions/Architecture/Data model/Behaviors/Security/Testing — every feature maps to a task (narrative→4,8; validation→5,8,9; timers+midnight→10,11; export→12; auth→13; calendar→17; bulk/undo→9,16,18; backup→11,20; stats→18; targets→15; shortcuts→14; audit→9,16; dark mode→14; idle nudge→15; rounding→3,10; systemd/README→20; cloudflared→21). Interface names consistent (checked: `secondsToHours`, `buildNarrative`, `canFinalize`, `elapsedSeconds`, route paths). No TBDs.
