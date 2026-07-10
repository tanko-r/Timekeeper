# Backlog

Ideas captured but not yet designed or planned. Pull one into a proper
spec/plan (see `docs/superpowers/`) before implementing.

## 3. Browser notification for long-running timers

Fire a **browser notification** (Notifications API) when a timer has been
running more than **2 hours**, then **hourly** after that, so a timer left
running doesn't silently over-accrue.

Distinct from the existing visual idle-nudge (`idleNudgeHours`, default 3h,
a card icon only — `timergrid.js:315`, `settings.idleNudgeHours`); this is
an actual OS/browser notification, on a 2h-then-hourly cadence.

Relevant: `TimerGrid` poll/tick loop (`timergrid.js:35-39`), `liveElapsed`
(`timergrid.js:41-45`); `idleNudgeHours` seed (`server/db.js:128`).

Open questions:
- Permission flow: request `Notification.permission` when? (First timer
  start, or a Settings opt-in toggle.)
- Per-timer notifications, or one aggregate "a timer has run 2h+"?
- Make the 2h threshold + cadence configurable in Settings, and reconcile
  with / possibly replace the `idleNudgeHours` knob so there aren't two
  overlapping "long-running" settings.
- Notifications only fire while a tab is open (no service worker / no
  runtime deps added) — acceptable given the always-open-tab usage?

## 4. Compact card: show clock time AND tenths, stacked

In the compact timer card, show **both** the running clock (`HH:MM:SS` /
`MM:SS`) and the decimal tenths, **stacked vertically — clock on top,
tenths below**. Enlarge the card slightly to fit the two-line stack.

Today the card shows only the tenths (`fmtTenths`) as the clickable
`.timer-clock` button; the raw clock (`fmtClock`) lives only in the
`title` tooltip (`public/js/components/timergrid.js:342-345`).

Relevant: `TimerCard` (`timergrid.js:312-356`); CSS `.timer-clock`
(`app.css:202-208`) and `.timer-card` `min-height: 32px` (`app.css:188`).

Open questions:
- Keep the **tenths** as the editable/clickable control (click → edit
  decimal hours); the clock stays display-only above it. Confirm.
- Emphasis/size: tenths is the value that gets filed — keep it the larger/
  bolder of the two, with the clock smaller above? Or equal weight?
- Bump `.timer-card` min-height (~32px → ~40px) and retune the row so the
  name/CM still align against the taller clock stack without wrapping.

## Quick wins (non-pipeline polish, from the 2026-07-08 audit)

Parked per the flow-redesign spec (§11) — these mostly touch views David
deprioritized (Stats / Calendar / Clients&Matters). Marked ★ where they
actually sit on the timer→narrative→**export** pipeline and could be
promoted into the redesign instead of parked.

- ~~**★ QW1 — Billing-cadence date presets.**~~ **[Export half PROMOTED into
  the flow-redesign spec, Phase 4.]** The *Stats* half (Quarter / YTD on
  `stats.js:21-25`) stays parked; the Export presets (This month / Last
  month, `exportview.js:42-48`) are now in the spec.
- **QW2 — Clickable dead-end numbers.** Stats bars, CM "42 entries", and
  Export rows show numbers that should drill into a filtered Search/editor
  but are inert (`stats.js:88-110`, `cms.js:69`, `exportview.js:79-88`).
- **QW3 — Surface `import.nonBillableGroups`.** The CSV importer reads it
  (`server/lib/timerimport.js:68`) but there's no UI — only hand-editable
  in the DB. Add a chip-list mirroring banned-phrases (`settings.js:245`).
- **QW4 — Consistent destructive-action safety.** CM delete
  (`cms.js:30-38`) and Search "Reassign CM" (`search.js:163-166`) fire
  instantly with no confirm/undo, unlike Search delete. Add confirms.
- **★ QW5 — TargetMeter upgrades.** Show overage ("+2.0h over"), label
  whether target is billable-vs-total, and make the meter click → new
  entry (`targetmeter.js`). Overlaps the redesign's animated "today footer"
  (spec §4/§7) — reconcile rather than build twice.
- **★ QW6 — Export clarity.** Distinguish the *mutating* export buttons
  (stamp `exported`) from the safe copy, and show "N entries, M already
  exported" for the range (`exportview.js`). Pipeline-relevant.
- **QW7 — Column sorting.** Sort the Search / Export / Clients&Matters
  tables by date, hours, last-used (none sortable today).
