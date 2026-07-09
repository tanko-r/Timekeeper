# Backlog

Ideas captured but not yet designed or planned. Pull one into a proper
spec/plan (see `docs/superpowers/`) before implementing.

## 1. Type-to-filter timers on the dashboard

Typing while the timer grid is focused/visible should live-filter which
timer cards are shown, matching against client (matter) name, matter/CM
short name, and the timer's own caption/name. Distinct from the existing
`/` full-text search (`public/js/views/search.js`, `app.js:177-180`),
which navigates away to a separate search page over past entries — this
is an in-place filter over the *live timer grid* on the dashboard, no
navigation.

Relevant: `public/js/components/timergrid.js` (`TimerGrid`, `TimerCard`).

Open questions:
- Trigger: dedicated filter input, or type-anywhere-to-filter like a
  quick-open palette?
- Does it filter within groups (hiding empty groups) or flatten to a
  single matched list while typing?
- Clear behavior — Escape, or clearing the input?

## 2. Color-highlight timers with active accumulated time

Currently only `.running` gets a visual treatment (accent border,
`app.css:191`). Add a distinct highlight for timers that have logged time
today (elapsed > 0, e.g. paused mid-day) vs. timers still at zero — so a
glance at the grid shows what's been worked on today even when nothing is
actively running.

Relevant: `public/css/app.css` (`.timer-card`, `.timer-card.running`),
`public/js/components/timergrid.js` (`TimerCard`).

Open questions:
- Exact condition: `elapsed_seconds > 0`, or `linked_entry_id` set
  (already filed something today)? These aren't the same thing.
- Color choice — needs to stay visually distinct from `.running` and
  from the `.idle-nudge` warning color, and work in both themes.

## 3. Keyboard shortcuts for timer cards

New shortcuts, additive to the existing set in the README
(`## Keyboard shortcuts`) and `public/js/app.js`'s global keydown handler
(~line 177):
- Edit the focused/selected timer (open `TimerModal`).
- Tab to move focus to the next timer card.
- Nudge the focused timer's clock up/down (the `±0.1h`/`±0.2h` actions
  currently only reachable via the context menu — see
  `menuItems()` in `timergrid.js:149-204`).
- Open the full time-entry editor for the timer's linked entry
  (`timer.linked_entry_id`, already used by `openEditor()` elsewhere).

Open questions:
- None of this works today because timer cards aren't a focusable/
  selectable unit — tab order currently just walks each button inside
  each card in DOM order. Needs a real "focused timer" concept
  (roving tabindex or a selection state) before any of the above can be
  wired up. Worth a brainstorming pass, not a quick surgical edit.

## 4. Exclusive timers: starting one stops the running one

When a timer is running, starting another timer should first **stop the
current timer** (filing its time) and pop up the narrative modal for the
one just stopped, then start the new one. I.e. one running timer at a
time (matches how Intapp shows a single "Running" total).

Relevant: `start`/`stop` in `public/js/components/timergrid.js:51-70`
(the stop path already fires `setStopPopup` → `StopPopup`); server
`POST /api/timers/:id/start` and `/stop` in `server/routes/timers.js`.

Open questions:
- Enforce single-running on the **server** (start auto-stops any other
  running timer atomically) or on the **client** (stop-then-start)?
  Server is safer against races and multi-tab.
- Interaction with the flow-redesign spec (§6/§7), which wants stops to
  file **silently** and defer narration to the close-out sweep. If that
  lands, the auto-stop should follow the same silent-file + chip/close-out
  path rather than the current per-stop modal. Reconcile before building.
- Should the auto-stopped timer's narrative modal block starting the new
  timer, or start immediately and let the narrative be filled after?

## 5. Browser notification for long-running timers

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

## 6. Compact card: show clock time AND tenths, stacked

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
