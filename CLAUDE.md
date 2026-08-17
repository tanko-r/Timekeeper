# Timekeeper (Intapp-clone)

Self-hosted single-user attorney timekeeping app. Replaces Intapp Time for
daily entry; exports CSV for manual keying into the firm's billing system.

## Conventions

- **Stack**: Node 24 ESM, Express 5, better-sqlite3 (WAL). Frontend is
  **no-build** React 18 UMD + htm, vendored in `public/vendor/` — never add a
  bundler; write browser code as plain ES modules under `public/js/`.
- **Runtime deps are exactly** `express` + `better-sqlite3`. Get agreement
  before adding any other runtime dependency.
- Business rules live in `server/lib/*` as pure functions with unit tests.
  Routes stay thin. All server writes go through prepared statements.
- Dates are local-time `YYYY-MM-DD` strings (box TZ: America/Los_Angeles);
  durations are decimal hours.
- TDD: failing test first (`npm test`, node:test). E2E:
  `node scripts/e2e-smoke.mjs` (headless system Chromium, real server + temp DB).
- Schema changes = append a migration to `MIGRATIONS` in `server/db.js`
  (PRAGMA user_version); never mutate old migrations.

## Deployment on this box

- systemd **user** service `timekeeper` (`systemctl --user …`), port **4747**,
  data in `data/` (gitignored), nightly backups in `data/backups/`.
- Remote via cloudflared: `time.example.com` → 127.0.0.1:4747
  (ingress in `/etc/cloudflared/config.yml`). Remote requests require the app
  password (Settings → Remote access); LAN is trusted by default
  (`auth.mode = remote-only`). Do not weaken this without asking David.
- After changing server code: `systemctl --user restart timekeeper`.
- After changing any `public/js/**` or `public/css/*.css` file, **bump `CACHE`
  in `public/sw.js`** — otherwise installed/PWA clients keep serving the old
  cached shell indefinitely (cache-first service worker; no build step means
  nothing else signals an update).

## UI feedback screenshots (Alt+drag)

Holding **Alt and dragging** in the running app captures an annotated
screenshot into `feedback/` (gitignored) and appends a checkbox item under
`## UI feedback (screenshots)` in TODO.md referencing it. When addressing one
of these items: make the fix, check off / remove the TODO line, and **delete
the referenced screenshot file** — `feedback/` should only ever hold
not-yet-addressed items.

## Context handoff — do this, it is not optional

Sessions here run long and go cold, and re-deriving state costs David real
usage every time. So:

- **`docs/ui/HANDOFF.md` is the entry point.** It opens with the question
  waiting for David, then what is true right now, then what is in flight.
  Read it first; read nothing else until you need it.
- **`node scripts/handoff.mjs`** prints the objective half — branch, working
  tree, recent commits, the last measured test result *with the commit it was
  measured at*, and the live-data tripwire. Run it instead of rediscovering
  those with a dozen tool calls. `--test` re-measures (~50s) and records it.
- **Before asking David a question, update `docs/ui/HANDOFF.md` first**, with
  the question at the top and the options and a recommendation under it. A
  question that arrives without a handoff costs him a whole context to answer.
- **Update it again before you stop**, whatever state the work is in.
- Big reference docs — `TIMERBOARD-SPEC.md`, `TIMERBOARD-CRITIQUES.md`,
  `teardown.md` — are for **grepping**, never for reading start to finish.
- Test counts are **measurements, not arithmetic**. Never quote one without
  the commit it was measured at; this project has shipped two invented counts
  in its own docs already.

## Design docs

- Spec: `docs/superpowers/specs/2026-07-06-timekeeper-design.md` (includes the
  ⚠️ assumptions made while David was away — check before "fixing" behavior
  like midnight banking or export shape; they're deliberate).
- Plan: `docs/superpowers/plans/2026-07-06-timekeeper.md`.
