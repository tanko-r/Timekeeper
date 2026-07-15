# "Yesterday" Timer Tab — Design

**Source:** TODO.md manual note — *add "Yesterday" timer grouping* (2026-07-15).
**Spec'd without David's input** — ⚠️ marks assumptions to ratify before or after
implementation.

## What

The dashboard timer board's activity tabs are **Today · Week · Recent**
(`timergrid.js`, `ACTIVITY`). Add a **Yesterday** tab between Today and Week:
timers whose last activity fell on yesterday's calendar day. Use case: morning
close-out — "what was I working on yesterday that I haven't touched today?"

## Behavior

- **Window:** last activity ∈ `[yesterday 00:00, today 00:00)` local time.
  Activity = most recent start or stop (`last_started_at` / `last_stopped_at`);
  a running timer counts as active *now* (same rule as the existing tabs).
- ⚠️ **A timer used yesterday AND today shows under Today, not Yesterday.**
  Timers don't store per-day run history — only the latest start/stop stamps —
  so "ran yesterday at all" is unknowable for a timer that ran again today.
  The chosen semantics also match the use case: a timer already touched today
  doesn't need resurfacing.
- Sort: alphabetical by timer name, same as the other activity tabs
  (2026-07-11 feedback — no shuffling while timers run).
- Tab order: **All · Today · Yesterday · Week · Recent · <groups/clients>**.
  The activity-cluster visual bracket (`activity-start`/`activity-end` classes)
  still spans Today→Recent.
- Available in both by-group and by-client modes (all activity tabs are).
  Flat mode has no tabs — unchanged.

## Structure

Extract the activity-window math out of `timergrid.js` into a pure module
`public/js/lib/activity.js` (`lastActivityMs`, `activityWindows`, `inWindow`)
so it gets real unit tests under node:test — matching the house rule that
business rules live in pure functions with tests (lib/tick.js, lib/notify.js
precedent). The existing `since`-only filter grows an optional `until` bound
(exclusive); Today/Week/Recent keep `until: null` and behave identically.

## Non-goals

- No per-day activity history table; no server change at all.
- No "Yesterday" grouping of the *entries* panel (day view / `[` already
  covers yesterday's entries).

## Touches

`public/js/lib/activity.js` (new) · `test/activity.test.js` (new) ·
`public/js/components/timergrid.js` · `scripts/e2e-smoke.mjs` ·
`public/sw.js` (CACHE bump).
