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

## Design docs

- Spec: `docs/superpowers/specs/2026-07-06-timekeeper-design.md` (includes the
  ⚠️ assumptions made while David was away — check before "fixing" behavior
  like midnight banking or export shape; they're deliberate).
- Plan: `docs/superpowers/plans/2026-07-06-timekeeper.md`.
