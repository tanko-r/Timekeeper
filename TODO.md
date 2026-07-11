# Backlog

Ideas captured but not yet designed or planned. Pull one into a proper
spec/plan (see `docs/superpowers/`) before implementing.

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

## UI feedback (screenshots)

Captured in-app with Alt+drag. Address the item, then DELETE the
referenced screenshot (see CLAUDE.md).

## Ideas:

Various thoughts from David in using the app:
- **AOT Timer** A separate window in the PWA that just shows the active timer with caption while running so it can be always on top in very small format somehow.
  **SPIKED 2026-07-10 — feasible, working.** Chrome's Document Picture-in-Picture
  API does exactly this: sidebar → "Float timer" opens a tiny always-on-top
  window (clock + caption + Start/Stop, red edge while running). Chrome/Edge
  desktop only; button hides itself elsewhere. To graduate from spike:
  auto-open on timer start (needs a user gesture — probably a setting on the
  start button), match the app theme, remember size, click-through to the
  entry. Code: `public/js/lib/pip.js`.
- [ ] 2026-07-10 16:36 — AI expand/rewrite/shorten should look for names of people, documents, etc. in the narrative history and guess who I'm talking about when I say something like "jeff". (feedback/2026-07-10T16-36-38.png · #/)
