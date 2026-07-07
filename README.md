# Timekeeper

Self-hosted, single-user time entry for attorneys — a home-server replacement for
Intapp Time. Track time against client/matters with timers or manual entries, get
Intapp-style task-billed narratives generated automatically, validate narratives
before finalizing, and export a daily CSV for your assistant to key into the
firm's billing system.

Everything runs locally: Node + Express + SQLite, a no-build React frontend, no
external services at runtime.

## Quick start

```bash
npm install       # once — installs express + better-sqlite3 (frontend is vendored)
npm start         # serves http://0.0.0.0:4747
```

Open `http://<server-ip>:4747` from any browser on your LAN.

### Run as a service (systemd, starts at boot)

```bash
./scripts/install-service.sh
```

That installs a **user** service (`systemctl --user`). Useful commands:

```bash
systemctl --user status timekeeper     # health
systemctl --user restart timekeeper    # restart
journalctl --user -u timekeeper -f     # logs
```

### Remote access (cloudflared)

The box's Cloudflare tunnel routes **https://time.example.com** →
`127.0.0.1:4747` (ingress rule in `/etc/cloudflared/config.yml`).

Remote requests must log in with the **app password**; LAN use never asks.
Until a password is set, remote access is refused outright. Set/change the
password in **Settings → Remote access** (from the LAN). Ten failed logins from
one address = 15-minute lockout. Changing the password signs out all sessions.

## Where things live

| Thing | Location |
|---|---|
| Database (source of truth) | `data/timekeeper.db` (SQLite, WAL) |
| Nightly backups | `data/backups/timekeeper-YYYY-MM-DD.db` (kept: 14, configurable) |
| Config knobs | Settings screen (stored in the DB) |
| Env overrides | `TK_PORT`, `TK_HOST`, `TK_DATA_DIR`, `TK_PUBLIC_HOSTNAME` |

`data/` is gitignored — the repo holds code only.

## Daily workflow

1. **Track**: start a timer button (create one per matter you're active on) or
   press <kbd>n</kbd> for a manual entry. Stopping a timer files its rounded time
   into today's draft for that CM (new entry or appended task line — it asks, or
   set a default in Settings).
2. **Narrate**: single-task entries get a free-text narrative. Add a second task
   line and the narrative flips to the auto-generated parenthetical form —
   `Review lease (1.2); draft email to landlord (0.3).` — built live from the
   per-line fragments; you edit words, it handles durations and punctuation.
3. **Finalize**: the dashboard flags drafts with validation problems (empty/short
   narrative, banned vague phrases, block-billing, sum mismatches). Fix or
   acknowledge warnings, then *Finalize today* locks the day.
4. **Export**: *Export today* downloads the CSV (finalized entries only; drafts
   only if explicitly included). Entries are stamped `exported` so you can see
   what's already gone to your assistant; re-export any time. A plain-text
   summary is one click away for pasting into email.

Timers zero their clocks at local midnight. Any time still on a clock at
midnight is **banked as a draft entry dated the day it accrued** (flagged for a
narrative), so nothing is silently lost; the timer buttons themselves persist
until you delete them.

## Customizing without touching code

All in **Settings**:

- **Task codes** — add/rename/hide/reorder the codes offered on task lines.
- **Validation** — minimum narrative length, banned-phrase list, block-billing
  threshold, minimum duration increment.
- **Rounding** — nearest/up/off and the increment (0.1h default) applied when
  timers convert to entries.
- **Targets** — daily hours target (drives the dashboard meter and calendar
  colors).
- **Timers** — stop behavior (ask / new entry / append) and the idle nudge.
- **Backups** — nightly retention count; download the SQLite file or a JSON dump
  any time.

## Keyboard shortcuts

<kbd>n</kbd> new entry · <kbd>t</kbd> start/stop last timer · <kbd>/</kbd> search ·
<kbd>g</kbd> then <kbd>d</kbd>/<kbd>c</kbd>/<kbd>s</kbd>/<kbd>e</kbd> navigate ·
<kbd>[</kbd> <kbd>]</kbd> prev/next day · <kbd>Ctrl+Enter</kbd> save entry ·
<kbd>?</kbd> full list

## CSV format

One row per task line:

```
date,cm_number,cm_short_name,billable,task,duration,narrative,entry_total,entry_id
```

`narrative` is the full (generated) entry narrative, repeated on each of the
entry's rows; `entry_total`/`entry_id` make regrouping unambiguous. Values that
could be interpreted as spreadsheet formulas are defanged with a leading `'`.

## Development

```bash
npm test                    # 84 unit + API integration tests (node:test)
node scripts/e2e-smoke.mjs  # headless-Chromium end-to-end pass
```

Stack: Express 5, better-sqlite3 (WAL), React 18 UMD + htm (vendored in
`public/vendor/` — **no build step**). Business logic lives in `server/lib/`
as pure functions; routes are thin. Schema migrations run automatically at
startup (`PRAGMA user_version`).

## Restore from backup

Stop the service, replace `data/timekeeper.db` with a backup file, start the
service. (WAL sidecar files are recreated automatically.)
