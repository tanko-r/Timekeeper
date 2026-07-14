# AOT multi-timer window — design

Date: 2026-07-13
Status: approved by David (approach A: extend the vanilla-DOM PiP window)

## Goal

Expand the always-on-top floating timer (Document Picture-in-Picture window,
`public/js/lib/pip.js`) from a single-timer card into a compact multi-timer
panel: every timer with time today, expand-on-click narrative entry, pinning
so chosen timers never fall off the list at midnight, and a one-click quick
timer. The window stays chromeless, vanilla-DOM, and dependency-free; all
non-trivial logic lives in unit-tested pure helpers.

## 1. Window layout

Compact list, ~320px wide. Row (collapsed): status dot, ticking clock, name
(ellipsized), pin glyph, Start/Stop button. Clicking the row body expands it
(one row expanded at a time), revealing the matter caption
(`short_name · cm_number`, or the quick-timer / held-time hint) and the
narrative field. Footer: day total on the left (`1.0h today`), a small `+`
button on the right (quick timer). Initial window height is computed from row
count (~34px/row + footer), capped near 7 rows; beyond that the list scrolls.
The user can resize the PiP window; content scrolls within it.

```
┌──────────────────────────────────┐
│ ● 0:42:10 Acme v. Bolt   📌 [Stop]│  ← expanded (running)
│   Acme · 11111-003               │
│ ┌──────────────────────────────┐ │
│ │ Reviewed opposition brief re │ │
│ │ summary judgment motion    ✓ │ │
│ └──────────────────────────────┘ │
│──────────────────────────────────│
│   0:18:00 Jones estate    [Start]│
│   0:00:00 Firm admin     📌[Start]│  ← pinned, no time yet
│──────────────────────────────────│
│ 1.0h today                    [+]│
└──────────────────────────────────┘
```

## 2. Which timers show; sort; pinning

A timer appears in the window if any of:

- it is **running**;
- its clock has **any time** (`elapsed_seconds > 0`) — this includes held
  time carried from earlier days (`held_since` set), which keeps its existing
  "held since …" hint in the expanded caption;
- it is **pinned**.

Sort: running timer first, then dashboard order (`sort_order, id`). Never
time-sorted — rows must not jump while the user watches. Empty state text:
"No time today — pin a timer or hit +."

**Pinning** is a new `pinned` flag on the `timers` table (server-side so it
survives restarts and devices). Toggled two places: the pin glyph on an AOT
row, and a pin toggle on the dashboard timer card. On the dashboard a pinned
timer shows a small pin badge only — placement/drag order is unchanged
(manual `sort_order` is sacred). Pinning has no effect on timer behavior
(rollover, filing); it only guarantees presence in the AOT list.

## 3. Narrative quick-entry

Expanded row shows one narrative surface. Three cases, decided per row by a
pure helper:

1. **Linked entry, editable** (fewer than 2 substantive task lines, or
   narrative already detached via `narrative_manual`): a textarea editing the
   entry's narrative through the existing `PATCH /api/entries/:id`.
   Debounced autosave (~600ms) plus save-on-blur; subtle ✓ on success; Esc
   collapses the row. Re-renders never clobber a focused textarea.
2. **Split entry** (2+ substantive lines, auto-generated narrative): the
   narrative renders read-only with the hint "split entry — edit in app."
   Edit-through parsing (`parseNarrativeEdit`) stays in the main entry
   editor; the float window must not risk silently detaching task lines.
3. **No linked entry** (matterless quick timer; pinned matter timer at 0:00):
   the textarea writes to a new `draft_narrative` column on the timer
   (stash), via `PATCH /api/timers/:id`. When the timer's time next files
   into a **newly created** entry — at stop, start, or matter assignment —
   `syncToEntry` uses the stash as the entry's initial narrative and clears
   it. Text typed in the moment is never lost. If the timer instead links to
   an existing entry, the entry's own narrative wins and the field switches
   to case 1/2 (stash stays until a new entry consumes it).

## 4. Quick timer button

The footer `+` creates a quick timer (server default name "Quick timer", no
matter) and **starts it immediately** — server-side exclusivity stops any
other running timer, identical to a manual start. The new row appears
expanded with the narrative field focused, so an interrupting call is:
click `+`, type what's happening, done. Assigning a matter later files the
held time and carries the stashed narrative, per the existing quick-timer
completion flow.

## 5. Server changes

- **Migration** (append to `MIGRATIONS` in `server/db.js`):
  `ALTER TABLE timers ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;`
  `ALTER TABLE timers ADD COLUMN draft_narrative TEXT;`
  Both join `TIMER_COLS` in `server/routes/timers.js`.
- **`PATCH /api/timers/:id`** accepts `pinned` (0/1) and `draft_narrative`
  (string or null). `draft_narrative` **survives matter assignment** — unlike
  `suggested_narrative` it is user text, and the assignment's immediate
  `syncToEntry` is exactly where it gets applied.
- **`syncToEntry`** — when it INSERTs a new entry, the entry's narrative is
  the timer's `draft_narrative` (if non-empty) instead of `''`, and the
  stash is cleared in the same transaction. The update path (existing linked
  entry) is unchanged.
- **`GET /api/timers`** gains subselects on the linked entry so the window
  needs no extra fetches: `entry_narrative`, `entry_narrative_manual`, and
  `entry_substantive_lines` (count of task lines with a fragment or
  duration > 0, mirroring `substantiveCount`). Client-side editability rule:
  editable ⇔ `entry_substantive_lines < 2 || entry_narrative_manual`.

## 6. Client changes

- `public/js/lib/pip.js` grows: pure helpers `buildPipRows(timers)`
  (filter + sort per §2), `narrativeMode(timer)` (per §3), and `fmtDayTotal`;
  imperative render keeps the current inline-CSS document approach. Poll
  every 5s, tick every 1s, preserve expanded row + focused input across
  renders.
- Dashboard timer card (`components/timergrid.js`): pin toggle + badge.
- `public/sw.js`: bump `CACHE`.

## 7. Error handling

Unchanged skeleton: poll failures show the existing error line. A failed
narrative save shows an inline error on the row, keeps the text, and retries
on the next change/blur. Start/Stop failures surface on the row caption as
today.

## 8. Testing

- `test/pip.test.js`: `buildPipRows` (running-first, pinned-at-zero
  included, held timers included, stable order), `narrativeMode` (three
  cases), day-total formatting.
- Route tests (`test/timers.*.test.js` conventions): pin PATCH round-trip;
  stash PATCH; stash applied + cleared on new-entry creation at stop / start
  / assignment; stash NOT applied to an existing linked entry; new
  subselects present and correct; migration runs on an existing DB.
- PiP cannot open headless, so the window DOM itself stays a thin layer over
  the tested helpers; `scripts/e2e-smoke.mjs` is not extended.

## Out of scope

Edit-through narrative parsing for split entries in the PiP window; changing
dashboard sort for pinned timers; any timer-behavior change tied to pinning;
Firefox/Safari support (Document PiP is Chromium-only).

## Addendum (2026-07-13): stop close-out pane + transport icons

Requested by David after first use:

- **Close-out pane.** When a stop lands from inside the window — the row's
  Stop button, or the server's start-exclusivity stop when another row is
  started — the window is taken over by a full-pane narrative field for the
  just-stopped timer (name, `Stopped at <clock> · matter` caption, textarea,
  Done button). The point is that writing the narrative can't be skipped in
  the popout flow. Done / Esc dismisses back to the list; autosave (same
  debounce/blur machinery as the expanded row) means dismissal never loses
  text. Split entries render read-only with the usual "edit in app" hint.
  The pane is skipped when there is nothing to narrate: misclick grace undid
  the start, or the timer is already running again / gone by poll time
  (pure helper `closeoutTimer`, unit-tested).
- The footer `+` quick timer still does NOT trigger a close-out for the
  timer it exclusivity-stops: §4's flow (capture the interruption in the NEW
  timer's focused narrative immediately) takes priority.
- **Transport icons.** The Start/Stop text buttons are now bordered icon
  buttons: solid green play triangle (start) / solid red square (stop),
  lucide shapes inlined like the pin glyph.

## Addendum (2026-07-13, later): entry-backed matterless timers replace held time

Directed by David; supersedes §3's "no linked entry" case and the held-time
carry described in §2/§5:

- **Every started timer files into an entry**, matter or not. A matterless
  start creates an entry with `cm_id NULL` (consuming `draft_narrative` as its
  initial narrative); stops and the midnight rollover bank into it exactly
  like a matter timer's. The timer clock resets at midnight; the ENTRY now
  carries the time (dated the day it was worked), so `held_since` and the
  carry-the-clock rollover branch are retired (migration clears the column).
- **Unassociated entries cannot leave**: `validateEntry` blocks with
  `no_matter` (so they surface in the dashboard invalid/backlog alerts and
  the close-out blocked list), and exports exclude `cm_id IS NULL` rows,
  returning an `unassociated` count the Export view surfaces.
- **Association is in-place**: assigning a matter to the timer updates its
  linked matterless draft entry (keeping time + narrative, inheriting the
  matter's billable flag); assigning a matter to the ENTRY (editor or bulk
  set_cm) glues the linked matterless timer's `cm_id` in return, so the pair
  never splits and nothing double-files.
- The PiP window's stash (`draft_narrative`) is now only a pre-first-start
  vehicle — after a start the narrative field edits the (matterless) entry
  directly via the ordinary `entry` mode.
