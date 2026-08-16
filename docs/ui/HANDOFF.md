# UI overhaul — session handoff

Written 2026-08-15, ~17:00 PDT, when the session ran low on usage. Read this
plus `docs/ui/BRIEF.md` (the contract) and `docs/ui/teardown.md` (the design
standard, with two appended owner constraints) to pick the work back up.

Branch: `ui-overhaul-2026-08`, pushed. Last commit at handoff: the stop-chip
contamination fix.

## State right now

Both suites green: 633 unit tests pass, `node scripts/e2e-smoke.mjs` all
clear. Working tree clean. Nothing half-built is uncommitted.

## The owner's rules, in priority order

These outrank the teardown, every critic, and any task prompt. All three are
written into `docs/ui/BRIEF.md`.

1. **Data integrity.** A *narrative* — the client-facing sentence that lands
   on a bill — may never cross a matter boundary, including between two
   matters of the same client. The phrasebook, ghost text and text expansions
   are reusable phrasing and ARE shared by design; do not scope them per
   matter and do not report them as defects. AI prompt example pairs come
   from the same matter or are fully synthetic. No time or narrative may be
   lost, dropped, double-counted, or marked exported without reaching the
   file. Every rule enforced by a test.
2. **Desktop first.** He works from the desktop browser and desktop PWA.
   Desktop wins any trade against phone quality; desktop density is a
   feature; keyboard is a first-class input, not an enhancement. The phone
   gets the core loop done well — start and stop a timer, add or edit an
   entry, write a narrative, finalize, export — and everything else there
   only has to be reachable and unbroken.
3. **It is fundamentally a timers app.** He uses the timer list all day and
   searches it with `/` constantly. `/` on Today filters timers, `/`
   elsewhere searches entries, and that fork is deliberate. Compact is the
   right default and denser is better, provided a row expands (by chevron,
   click and keyboard) and a compact/comfortable density control persists.

## What was interrupted, and must restart

Two workflows were stopped mid-run to conserve usage. Neither left partial
edits — both were stopped after their builders had finished and committed.

### 1. Integrity audit — RESTART FROM SCRATCH

Script: `.../workflows/scripts/tk-integrity-audit-wf_a9b1d9d4-d6e.js`
(already patched with the corrected narrative-versus-phrasing standard).
Six read-only auditors, then an adversarial verifier per claimed leak, then
one report written for the owner at `docs/ui/INTEGRITY.md`.

Audit areas: suggestion sources; AI prompt construction; entry mutation paths
including copy, duplicate and bulk operations; export completeness across
date and daylight-saving boundaries; the close-out and timer-to-entry
lifecycle; and stale client-side state generally.

It had 6 auditors running and produced nothing before it was stopped. Relaunch
with `Workflow({scriptPath, resumeFromRunId: 'wf_a9b1d9d4-d6e'})` — nothing is
cached, so it starts clean.

**This is the highest-priority work.** The one contamination bug that was
found and fixed was a *shape* — a component holding one record's data while
displaying another's — and the audit exists to find the others.

### 2. Contamination-fix verification — the critic never ran

Script: `.../workflows/scripts/tk-ui-w2b3-fix-wf_7a17ba46-6bb.js`. Its two
builders finished and their work is committed. The third agent — a critic
whose one job is to try to reproduce the cross-matter write again, harder
(three timers, stopping during a dialog, a timer whose matter changed while
running, midnight rollover, a quick timer with no matter) and to read the
database directly after each attempt — never ran. Resume with
`resumeFromRunId: 'wf_7a17ba46-6bb'`; the two builders replay from cache.

## Queued work, in order

1. **Stop-chip content, to the new spec.** The chips must offer the last
   couple of narratives from that matter, plus one AI-generated narrative
   extrapolating the likely next step from that matter's own prior
   narratives; generic phrasing or nothing when the matter has no history.
   Files: `public/js/components/stopchips.js`, the suggestion endpoint in
   `server/routes/matters.js`, `server/lib/exemplars.js`.
   Open assumption to confirm with the owner: the extrapolation draws only on
   that matter's prior narratives.
2. **Wave 2b-3**, the screens not yet rebuilt: the ledger (pagination — it is
   5386 CSS px for 23 entries; export as a dialog; delete the
   `All entries | Export` subnav), the calendar (42 tab stops become one
   roving grid, day-tap scrolls the panel into view, empty trailing weeks
   collapse, the Statistics tab folds under the month grid), and settings
   (the section name prints three times, one settings-row component, theme
   switching made first-class).
3. **Re-rank the outstanding findings under desktop-first.** Several recent
   critic verdicts were driven by mobile measurements that are now minor.
   Do this before spending effort on phone parity.
4. **Wave 3 polish:** editor control trim (12 controls on an existing entry
   against a target of 10), motion, empty states, PWA details.
5. **A final whole-app review** by the standing critic against
   `docs/ui/teardown.md`, then refresh the progress page and write the list of
   what to push further.

## The preview (POC) — infrastructure ready, app not started

The owner wants to review on his Cloudflare tunnel with Alt+drag feedback
working. Everything is prepared except starting it:

- DNS: `poc-time.rigid-dreamy-sweep.us` routed to the `nanoclaw` tunnel.
- Ingress: added to `/etc/cloudflared/config.yml` pointing at port 4748;
  cloudflared reloaded. Production on 4747 untouched.
- Service: `~/.config/systemd/user/timekeeper-poc.service`, its own database
  under `~/Projects/timekeeper-poc/data`, and Alt+drag feedback deliberately
  written into the MAIN repo's `feedback/` and `TODO.md`.
- `scripts/poc-sync.sh [ref] [--seed]` creates the worktree, points it at a
  commit and restarts the service.

To launch: `scripts/poc-sync.sh --seed`, seed the demo day via
`scripts/lib/demoseed.mjs` against `http://127.0.0.1:4748`, set an app
password (Settings → Remote access, from the LAN), then send the owner the URL
and password. Remote requests require that password by design; do not weaken
it.

## Measurements to judge future work against

All on a 390x844 phone unless noted, all measured on the rendered app.

| | Before the overhaul | Now |
|---|---|---|
| Today page height | 2639px | 1292px |
| First control that starts a timer | y=978 | y=328 |
| Complete work rows above the fold | 0 | 2 (4 in compact density) |
| Visible controls on Today | 64 desktop / 69 mobile | 43 / 39 |
| A five-entry day, end to end | ~22 (estimated), 18 (measured) | 12 |
| The same day using the stop suggestions | 23 | 17 — still worse, being fixed |

Desktop fixed chrome regressed to 97px from 49px before the overhaul and
should come back down; the phone bottom bar had seven slots against a
five-slot convention. Both were assigned to the shell agent.

## How to work here

- `node scripts/uishots.mjs --out shots/<name> [--only screen,screen] [--strict]`
  photographs every screen across desktop/mobile and light/dark, and measures
  horizontal overflow and the 44x44 touch floor.
- `node scripts/abpair.mjs --ours <png> --ref <png> --out <dir>` stages a
  blind A/B pair; judge without reading `.key.json`.
- `shots/refs-v2/INDEX.md` indexes 40 real product screenshots; prefer it over
  `shots/refs/`, which is mostly marketing pages.
- `node scripts/progress.mjs` rebuilds the before/after progress page.
- Run `npm test` and the e2e suite one at a time — four cores, and the e2e
  timeouts flake under load.
- Agents must not edit `public/sw.js` or `public/index.html`; the orchestrator
  owns those and bumps the cache version at wave boundaries.
