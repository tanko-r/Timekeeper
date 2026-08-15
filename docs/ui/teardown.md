# Timekeeper — whole-app design teardown

Fresh-context principal design critic. Branch `ui-overhaul-2026-08`, wave 0
complete. No sacred cows.

## Method and scope

Evidence: `shots/w0-final/*.png` (60 shots), `shots/baseline/*.png`,
`shots/refs/*.png`, plus my own live driving of the real app through
puppeteer-core (fresh shots in `shots/teardown/`) and instrumented DOM
measurement. Source was read only to learn what a screen *can* do, never to
judge how it looks.

**Deliberately not judged**, because two builders own them right now: the
visual polish of any dialog/overlay, and accent colour. I *do* judge whether a
dialog should exist at all, what is inside it, and in what order — those are
structure, not polish.

A note on the reference set: `shots/refs/*` are marketing pages, not app
screens. The only genuinely usable product references in them are the embedded
timesheet screenshot in `harvest-timetracking.desktop.0.png` /
`harvest-timetracking.desktop.1.png` and the embedded dashboard in
`mercury-home.desktop.1.png`. Every Harvest/Mercury comparison below cites one
of those three. Someone should capture real signed-in product screens; the
craft bar is currently being set by cookie banners and footers.

### Measurements this teardown rests on

| | dashboard desktop | dashboard mobile |
|---|---|---|
| visible interactive controls in `<main>` | **64** | **69** |
| page height / viewport | 1308 / 900 | **2639 / 844 (3.1 screens)** |
| y of first timer card | 454 | **978 — below the fold** |
| y of first entry card | 627 | **1365 — 1.6 screens down** |
| fixed bottom chrome | 49px | **121px (61 footer + 60 nav) = 14% of the screen** |

Other screens, visible controls in `<main>`: calendar 47, cms 37, search 31,
export 16, stats 4.

Mobile table widths inside a 356px scroll box: **cms 741px, search 839px.**

---

# Part 1 — Screen by screen

## 1. The shell: sidebar, bottom bar, More sheet

`public/js/app.js` (NAV, BOTTOM_NAV, NavActions, NavSheet), `public/css/shell.css`

**Function.** Get the lawyer to one of seven destinations and fire one of three
actions.

**Necessity — the seven destinations.** Four of the seven answer the same
question, "show me the entries in a date range," with four different filter
UIs, four different renderers, and four different Export buttons:

| screen | how you pick the range | how entries render | export |
|---|---|---|---|
| Dashboard | implicit (today) | `EntryList` cards | header button → CSV today |
| Day (`#/day/…`) | Day/Week/Month/Range segmented | `EntryList` cards | header button → CSV range |
| Calendar → SelectedPanel | Day/Week/Month/Range segmented | `EntryList` cards | panel button → CSV range |
| Search | two `<input type=date>` + 5 more filters | `<table class="tk">` | none |
| Export | 5 presets + two date inputs + status seg | `<table class="tk">` | Copy / CSV / **.TIM** |

`day.js` (166 lines) and the `SelectedPanel` inside `calendar.js` (lines 48–115)
are near-identical components. `search.js` and `exportview.js` are two tables of
the same rows with different columns. This is the single largest structural
defect in the app and it is why the nav has seven items.

**Necessity — the three "actions".** `Add todo`, `Run /todo`, `Float timer` sit
in the primary navigation, on desktop and in the phone More sheet, in a group
labelled ACTIONS. `Run /todo` (`components/runtodo.js`) launches a Claude Code
agent in tmux that *commits and pushes to this repo*. That is a developer tool
in a lawyer's production navigation, one thumb-reach from Settings. `Add todo`
writes to `TODO.md`. Neither has anything to do with keying time.
**DELETE both from the nav.** They belong behind the same Alt+drag feedback
gesture that already exists, or a `dev` route, or nothing.

**Placement — the phone bottom bar.** `BOTTOM_NAV = ['dashboard','calendar','search','export']`.
Export earns a permanent thumb slot for a job done **once a day**. Meanwhile
the two things done twenty times a day — start a timer, capture a line of time
— have no slot at all. Material 3 and Apple HIG both say a bottom bar is for
the *most frequent* destinations; frequency here has been mistaken for
importance.

**Form.** The desktop sidebar is correct as a component (grouped nav, active
indicator, `aria-current`, roving labels). The `.subnav` ↔ `.pagenav` swap at
1024px is handled properly — one line of praise, moving on. The bottom bar is a
correct Material 3 five-item bar with a More sheet. The *contents* are wrong,
not the components.

**Speed.** Reaching Export is 1 tap. Reaching quick capture is impossible
without a hardware keyboard (see §11).

**Mobile.** Two stacked fixed bars, 121px, 14% of a 390×844 phone, permanently.
`.today-footer` is pinned at `bottom: var(--shell-nav-total)` (shell.css:714)
directly above `.botnav`. Nothing else in the app is allowed that much
permanent chrome. The footer's content (filed total, %, running clock) is a
*status* readout; Material 3 and HIG both put persistent status in the bar you
already have, not in a second one.

**Verdict: RETHINK.** Four destinations, one action. See section A.

---

## 2. Dashboard — page header

`views/dashboard.js` lines 128–143

**Function.** Move between days; finalize; export; add an entry.

Four controls: `< date >`, `Finalize day`, `Export`, `New entry`.

**Necessity.** `Finalize day` and `Export` are *both* strict subsets of `Close
the day` (the footer button, 6 feet away, doing "review, finalize and export"
in one guided pass — `components/closeout.js`). Three affordances for one job,
two of them worse, and the two worse ones get the visually prominent slot at
the top-right while the good one is a small button in the footer.

Worse: they produce *different outcomes*. The header's `exportToday()`
downloads **CSV**; the Export page's primary button downloads **.TIM**. Same
word, same icon, two file formats. A lawyer who "exports" from the dashboard
and then wonders why DTE Axiom won't take the file has been misled by our
labelling.

`New entry` as the page's one filled primary is right in principle — but on a
day driven by timers it is the *rare* action. On mobile it renders as a
full-width blue slab at y≈260 while nothing that starts a timer is on screen
at all.

**Form.** The header is correct as a component (secondary actions then exactly
one primary). Its contents are wrong.

**Verdict: DELETE `Finalize day` and `Export` from the dashboard header.**
Their job is absorbed by Close the day. Promote Close the day into the header
as the one end-of-day action, and put a timer/capture control where `New entry`
is on mobile.

---

## 3. Dashboard — "Needs attention" banner

`views/dashboard.js` lines 145–173, four pill types

**Function.** Surface entries that will block billing, and stale days.

**Necessity: keep the job, rebuild the component.** This is genuinely valuable
and is the one thing here Harvest does not have. Keep it.

**Form — this is the worst component in the app.** The pills are `<button>`s
styled as flat neutral-grey chips (`shots/w0-final/dashboard.desktop.light.png`).
They read as passive status tags. Nothing says "Northgate diligence — no
narrative" is clickable, or that clicking opens the editor for that entry, or
that "17 finalized entries not yet exported" deep-links to a pre-filtered
Export page. The only affordance is a `title` tooltip — pointer-only, so on the
phone there is *no* affordance at all, and there the four pills stack into a
120px-tall grey wall (`dashboard.mobile.light.png`).

Two different kinds of thing are also mixed into one undifferentiated row:
per-entry defects (open this entry) and day-level backlogs (go to a filtered
list). Polaris `Banner`, Carbon `InlineNotification` and Primer `Flash` all
separate the message from its actions and render the actions as actions.

Compare `mercury-home.desktop.1.png`: the Bill Pay tile carries a count and a
single explicit "View →" — the count is text, the action is a control, and you
can tell them apart at a glance.

**Speed.** Fixing "no narrative" from here: click pill → 25-control modal opens
→ scroll to Narrative → type → Ctrl+Enter. Should be: tap the item, type, done.

**Verdict: RETHINK.** Make it a list of rows, not a bag of chips. Each row: the
matter, what's wrong, and one explicit action. Group day-level backlogs
separately, below, in one line.

---

## 4. Dashboard — "Today" meter card

`components/targetmeter.js` in a `.card` with an `<h2>Today</h2>`

**Function.** Show billable vs non-billable against the daily target.

**Necessity: DELETE the card.** Its numbers already exist in the sticky footer
(`5.5h filed · 64%`, `components/todayfooter.js` lines 36–46). Two meters, ten
inches apart, from the same data, disagreeing in framing (the card says "2.9h to
go", the footer says "64%"). A whole `<h2>` and a card frame are spent on one
progress bar.

**Form.** A card is the wrong container for a single stat. This is a stat
strip. `mercury-home.desktop.1.png` shows the pattern: one big number with its
context inline, no card chrome around a lone bar.

**Verdict: DELETE.** Absorb into the day header as one line —
`5.1h billable · 0.4h non-billable · 2.9h to 8.0h` with a thin rule — and let
the footer keep the live clock only.

---

## 5. Dashboard — the timer grid

`components/timergrid.js`, 1122 lines — the largest file in the app

**Function.** Start and stop the clock against a matter.

**Necessity of the *board*: this is the app's central design error.** For a
single user with five timers, the grid ships:

- 3 grouping modes (By group / By client / Flat), persisted to localStorage
- a `role="tablist"` of up to 10 tabs (All, Today, Yesterday, Week, Recent, plus
  one per group/client), persisted per mode
- a search toggle + input, an A–Z sort button, New group, Import (CSV batch
  create), Quick, New timer — **14 controls in the section header alone**
- HTML5 drag-and-drop with a drop-slot animation
- Ctrl/Shift multi-select with an anchor, a selection bar, and a batch menu
- a per-card right-click / "…" context menu with **17 items**, four of which
  are ±0.1h / ±0.2h nudges
- a per-card inline rename and an inline clock editor
- a tab kebab menu with rename/delete group

That is a Trello board. Its user has five timers.

The 17-item menu is the tell (`shots/teardown/timer-menu.mobile.png`): four
separate clock-nudge rows, a "Start N minutes ago" chip row, "Start at last
stop", "New entry (zero clock)", "Open today's entry", "Duplicate timer",
"Pin to float window", a Group `<select>`, Edit, Delete. On a phone it is
280×480 — 57% of the screen — and it is the only route to most of a timer's
capability.

Compare `harvest-timetracking.desktop.1.png`. Harvest has no timer board. Each
**row is simultaneously the timer and the entry**: `Mobile App (Spitalfields
Communications) / Design — 2:21 — [Start] [Edit]`. Start it and the row shades
and the button becomes Stop. One list, one row type, two buttons.

That is the fix. Our `timers` table and our `entries` table are already linked
(`timer.linked_entry_id`, `/api/timers/start-for-entry`); `EntryList` already
renders a play/stop button per entry (`entrylist.js` lines 219–227). **The two
lists on the dashboard are already 80% the same list.**

**Necessity, item by item:**

- **By group / By client / Flat** — DELETE. A view-density preference in the
  primary header. With five timers, grouping is noise.
- **Tabs (All/Today/Yesterday/Week/Recent/…)** — DELETE, and note they are the
  wrong component regardless: `role="tab"` with the same panel filtered
  underneath is not a tab set, it is a filter chip set (Material 3 filter
  chips). Sorting by "used today, then recent" and showing the top eight
  removes the need entirely.
- **A–Z sort** — DELETE. Recency is the only order that matters.
- **New group** — DELETE with grouping.
- **Import (CSV batch create timers)** — MOVE to Settings. It is a one-time
  migration tool sitting next to a button pressed forty times a day.
- **Search / `/`** — KEEP but fold into one command surface (see §11).
- **Quick** (start a matterless timer now) — KEEP. Genuinely the fastest "the
  phone just rang" action. Promote it.
- **New timer** — KEEP, demoted to the bottom of the list as an "+ Add" row,
  the way `harvest-timetracking.desktop.1.png` does it.
- **Drag and drop** — DELETE. Pointer-only, no touch path, and the group
  `<select>` in the context menu already does the job.
- **Multi-select + batch menu** — DELETE. Ctrl/Shift-click with a right-click
  menu is desktop-pointer-only; there is no touch path to it at all, and the
  only batch actions are "move to group" (dying with groups), "pin all", and
  "delete N".
- **±0.1/±0.2 menu rows** — DELETE from the menu. `Alt+↑/↓` already does this
  on the focused card, and the clock is directly editable by clicking it. Four
  menu rows for a third route to the same edit.

**Form.** The card itself is well built: the card is the tab stop, inner
buttons are `tabIndex=-1`, Enter/Space toggles, arrow keys walk a geometric
grid. That keyboard model is genuinely good and must survive. The card is also
the right component — a list row with a leading label, a numeric column and a
trailing action. But it is laid out in a **multi-column masonry grid** whose
column breaks are not in the DOM, which is why `onBoardKey` has to do
`getBoundingClientRect` geometry to implement Left/Right (lines ~672–700). A
single column removes 30 lines of geometry code and matches Harvest.

**Speed.** Start an existing timer: 1 click, or `t`. Correct. Start work on a
matter with no timer: New timer → type name → open CM picker → type → Enter →
Create → ▶ = 7 interactions. Harvest: pick project, pick task, Start = 3.

**Mobile.** First timer card is at y=978 in an 844px viewport — **you cannot
start a timer without scrolling.** Above it sit the header (3 rows), the
attention wall, the Today card, the grouping segmented control and six filter
chips. On the device the lawyer uses between calls, the app's primary verb is
below the fold behind eleven controls he does not need.

**Verdict: RETHINK — merge the timer grid and the entry list into one list of
rows.** This is the single highest-value change in the document.

---

## 6. Dashboard — "Today's entries"

`components/entrylist.js`

**Function.** Show what has been recorded today and let it be corrected.

**Necessity.** Keep — but merge with the timer grid per §5. A row that has a
running timer and a row that has recorded time are the same object at two
moments.

**Form — the action cluster fails the correctness bar.** Every draft row
carries five unlabelled ghost icon buttons (play, pencil, lock, trash, copy);
finalized rows carry three (eye, unlock, copy). All are 16px glyphs in
`btn-ghost btn-sm`, all identified only by `title` — pointer-only. Five of the
six are rare: finalize-one-entry, delete, copy-to-today, unlock. One is common:
start/stop.

Primer `ActionList`, Polaris `ResourceItem`, Carbon `DataTable` and Fluent
`DetailsList` converge on the same answer: **one primary inline action plus an
overflow.** Harvest's row (`harvest-timetracking.desktop.1.png`) shows exactly
two: `[Start] [Edit]`, both *labelled*.

**Necessity, per icon:** play/stop → keep, promote, label it. pencil (Edit) →
delete; the narrative is already editable inline and the rest of the fields
belong in an expanded row. lock (Finalize one) → move to overflow; finalizing
one entry mid-day is not a thing a lawyer does. trash → move to overflow.
copy-to-today → move to overflow. eye (View) → delete; tapping the row should
open it. unlock → move to overflow.

**The best thing in this component is invisible.** `InlineNarrative`
(entrylist.js lines 18–80) lets you click the narrative text and edit it in
place with ghost-text completion and shortcut expansion — 2 interactions, no
modal. Its entire affordance is `cursor: text` plus a `:hover` background
(`entries.css:21–22`). Both are pointer-only. **On the phone, the app's
fastest narrative path has zero discoverable affordance.**

**Speed.** Fix a narrative: 2 interactions inline (if you know it exists), or
3 + a modal + a scroll via the pencil.

**Mobile.** First entry at y=1365 — 1.6 screens down. The row's five icons
render at the bottom of the card in a row; they meet the 44px floor but they
are still five unlabelled glyphs on a phone.

**Verdict: RETHINK.** One row type shared with timers. Trailing controls: the
timer button (labelled) and one "⋯" overflow. Make the narrative visibly
editable — a dotted underline or a "write narrative" placeholder button, not a
hover state.

---

## 7. Dashboard — the sticky "Today" footer

`components/todayfooter.js`

**Function.** Ambient awareness: filed total, progress, live running clock, one
key to close the day.

**Necessity.** The *clock* half is essential and under-delivered; the *meter*
half is a duplicate of §4. `Summary` (read the day back as prose) does not
belong in the app's most valuable pixel real-estate — it is a once-in-a-while
export-adjacent action.

**The real defect is scope: the footer is dashboard-only.** Navigate to
Calendar, Search, Stats, CMS, Export or Settings and the running clock
disappears entirely (measured: `footerH: 0` on calendar). The only remaining
signal is the browser tab title — which in an installed Android PWA is not
visible at all. A timekeeping app must never hide a running clock. This is a
correctness failure, not a taste one.

**Verdict: RETHINK and PROMOTE.** One persistent running-timer bar, on every
screen, at every width, carrying: live clock, timer name, one Stop button,
filed total. Move `Summary` into an overflow. Keep `Close the day` here or in
the header, but only in one place.

---

## 8. Day view (`#/day/YYYY-MM-DD`)

`views/day.js` — note the sidebar highlights **Calendar** while you are on it

**Function.** Look at another day's entries.

**Necessity: MERGE into Calendar.** Put `shots/w0-final/day.desktop.light.png`
next to `dashboard.desktop.light.png`: the entry list is byte-identical. Day is
Dashboard minus timers, minus meter, minus banner, minus footer — plus a
Day/Week/Month/Range segmented control that `calendar.js`'s SelectedPanel
already reimplements.

It is also *already* Calendar as far as the nav is concerned
(`app.js:530: const active = route.path === 'day' ? 'calendar' : route.path`).
The app has already conceded the point; the code has not caught up.

**Form.** The header carries `Summary`, `Export`, `Finalize day`, `New entry` —
four actions, one of which (Summary) the dashboard puts in the footer instead,
and two of which duplicate Close the day. The same four words in two different
places with two different arrangements across two screens that show the same
list is exactly the inconsistency the craft bar exists to prevent.

**Verdict: MERGE into Calendar.** `#/day/…` becomes a deep link that opens
Calendar with that day selected. `day.js` is deleted; `SelectedPanel` absorbs
its Day/Week/Month/Range control (which it already has).

---

## 9. Calendar

`views/calendar.js`, `shots/w0-final/calendar.{desktop,mobile}.light.png`

**Function.** See where the hours went across a month and jump to a day.

**Necessity: KEEP.** This is the one screen that answers a question no other
screen answers — "which days are thin?" — and it does it well. The
billable/non-billable split bar per cell and the week totals column are good
domain thinking.

**Form — three specific faults.**

1. **The status legend is a cipher.** `✓ ≥8.0h · ◐ ≥50% · ! under 50%` is set
   in muted small text in a legend row, and the markers themselves are 8px
   glyphs in the corner of a cell. Nobody will learn this. Either encode
   status in the cell's own bar (which already exists) and delete the glyphs,
   or label them properly.
2. **Empty weeks eat half the screen.** August has 16 tracked days and 6 grid
   rows; three of those rows are entirely blank future days, at full height,
   on both viewports. On mobile that is ~700px of nothing above the fold-line.
   Collapse trailing all-empty weeks, or shrink rows with no data.
3. **`onDoubleClick` opens the day** — a pointer-only accelerator. The CSS
   swaps in a touch hint (`.cal-hint-touch`) and the SelectedPanel has an
   "Open day" button, so it is not a dead end, but a control whose two
   behaviours differ by click count fails the correctness bar. Single tap
   should select; "Open day" is a button.

**Speed.** Fine. Select a day, entries appear below without a navigation.
That inline-panel decision is right and should be the *only* pattern (see §8).

**Mobile.** Header wraps into 3 rows of chrome before the grid. Month/Week is a
full-width 2-item segmented control taking 90px for a rarely-flipped switch.

**Verdict: KEEP, absorb Day, tighten.**

---

## 10. Search

`views/search.js`, `shots/w0-final/search.{desktop,mobile}.light.png`

**Function.** Find an old entry — and, though the name hides it, the app's
**only bulk-edit surface** (finalize / unlock / reassign CM / delete N).

**Necessity: KEEP the screen, rename it, and merge Export into it.** With empty
filters this page is "all 23 entries · 44.8h" — it is the ledger. Calling it
Search hides that. And Export (§12) is this same list with a date range, an
"Exported" column, and three download buttons. There is no reason for two.

**Form.**

- **Six filter controls, always expanded, above the fold, on every visit.**
  Keyword, CM picker, from, to, task, billable, status. Attio's answer (and
  Linear's, and Notion's) is: search box always, filters as chips you add.
- **A bulk-select checkbox column with no persistent action bar.** The bar
  appears only after a selection and is `position: sticky; top: 8px` — it will
  collide with the page head. Polaris `IndexTable` and Carbon `DataTable`
  both keep a batch-action zone in the header region that swaps in place.
- **Narrative truncated to `white-space: nowrap` with a `title` tooltip.** The
  narrative is what you are searching *for*; the hit context is hover-only,
  therefore unavailable on touch. Show two lines and highlight the match.

**Mobile — this fails outright.** The desktop `<table>` is 839px wide inside a
356px scroller (measured). The checkbox column — the least useful thing on a
phone — is preserved at full width, while **Hours is entirely off-screen** and
Narrative is cut mid-word. To read the hours of an entry you found, you scroll
a table sideways by 483px. Meanwhile the app already owns a perfectly good
mobile-friendly renderer for exactly these rows: `EntryList`.

**Verdict: MERGE Export into it, RETHINK the filters, and use `EntryList`
below 768px.**

---

## 11. Quick capture (`q`)

`components/quickcapture.js`, `shots/w0-final/quick-capture.desktop.light.png`

**Function.** Type one sentence — "call sam re loading dock lease .3" — and file
a complete entry.

This is the best idea in the product. It is the only path in the app that gets
from "did the work" to "logged the work" in a single motion, and the parse
preview (matter chips, hours chip, task chip, with `? hours` for what's
missing) is well designed.

**Necessity: KEEP and PROMOTE HARD.**

**Placement — this is the single worst finding in the teardown.** I grepped
every trigger: `setQuickCapture(true)` is called from exactly one place,
`app.js:475`, `else if (e.key === 'q')`. There is **no button, anywhere**. Not
in the sidebar, not in the page header, not in the bottom bar, not in the More
sheet, not in the keyboard-shortcut overlay as anything but a line of text.

David uses this app as an installed Android PWA. **On the phone, the app's
fastest and most magical feature does not exist.**

**Form.** Correct as a component — a command-palette-shaped single-line input
with a live preview and an explicit primary. It should also be the app's *one*
search surface: today `/` means "filter timers" on the dashboard and "go to the
Search page" everywhere else (`app.js:460–467`), which is two behaviours behind
one key.

**Verdict: NEW placement.** A permanent, labelled control: the dashboard's
primary action on mobile, and a persistent input at the top of the dashboard on
desktop. Merge the timer-grid `/` filter into it.

---

## 12. Export

`views/exportview.js`, `shots/w0-final/export.{desktop,mobile}.light.png`

**Function.** Get finalized entries out as .TIM (DTE Axiom) or CSV, once a day.

**Necessity: MERGE into the entries ledger (§10) and DEMOTE from top level.**

- It is a top-level destination and a phone bottom-bar slot for a **once-a-day**
  job, ranked above starting a timer.
- `Close the day` already exports at the end of its sweep
  (`closeout.js:196–208`). The Export page exists for the exceptional case —
  re-export a month, chase an old unexported entry.
- Its list is Search's list with two extra columns.

**Form.** Fifteen controls to move one row: a 4-item status segmented control,
5 preset buttons, 2 date inputs, an "Include drafts" checkbox that is
`disabled` and shows a *computed* checked state when the segmented control is
not "All" (a checkbox that changes without you touching it is a lie), and 3
download buttons. Above a table with **one row** in it. The screenshot is the
argument.

**The `.TIM` / CSV split is a labelling bug across the app.** `.TIM` is the
filled primary here; every other Export button in the app (dashboard header,
day header, calendar panel) silently produces CSV. Four buttons, one word, two
formats.

**Mobile.** The entire 844px viewport is filter chrome. You scroll past every
one of the fifteen controls before the first entry.

**Verdict: MERGE into the ledger** as a "Export…" action plus an "Exported"
column and a "not exported" filter chip. Keep the deep-link contract
(`#/export/<filter>/<from>`) pointing at the ledger with that chip applied.

---

## 13. Stats

`views/stats.js`, `shots/w0-final/stats.desktop.light.png`

**Function.** Tell the lawyer whether he is hitting his hours and where they go.

**Necessity: MERGE into Calendar, or delete.** 113 lines, 4 visible controls,
and it answers the same question the calendar already answers with more
context. "Days with time: 10" is not a number anyone acts on. "Billable ratio
99%" is, but it is one number and belongs on the screen where the days live.

**Form — the "By day" chart fails on two counts.**

1. **No values, no axis, two labels.** Ten bars, labelled `08-05` and `08-14`
   and nothing between; the per-day hours exist *only* in a `title` attribute
   (`stats.js:90`). **Hover-only, therefore unavailable on touch.** A bar chart
   whose values cannot be read is decoration.
2. **Full-saturation accent on every bar.** Ten bars all shouting. Compare the
   balance sheet chart in `mercury-home.desktop.1.png` — one restrained fill
   under a single large number, the number carrying the meaning and the chart
   carrying only the shape. I am not judging the accent *hue* (mid-rebuild);
   I am judging how many elements claim emphasis at once. Here: all of them.

"Hours by client/matter" and "Hours by task" are the same `BarList` twice,
and those are fine — labelled, valued, single-hue. One line of praise.

**Verdict: MERGE.** Fold billable ratio and month total into the Calendar
header; move the two `BarList`s to a "This month" panel there; delete the
"By day" chart (the calendar grid *is* the by-day chart, with more information).

---

## 14. Clients & Matters

`views/cms.js`, `shots/w0-final/cms.{desktop,mobile}.light.png`

**Function.** Keep the matter list that everything else picks from.

**Necessity: KEEP, DEMOTE to Settings.** Matters are configured once and used
constantly through the CM picker. This is reference data maintenance, opened
maybe weekly. It does not deserve a top-level slot when starting a timer does
not have one.

**Form.**

- **Four unlabelled trailing icons per row** (gear=custom fields, pencil,
  archive, trash) plus a leading star, plus a pencil and a "Fields" button on
  every client group row. Same finding as §6: one primary + overflow.
- **`Export CSV` in the page header** is a *third* thing called Export,
  producing a matter roster, unrelated to time export. Rename it "Download
  matter list" and move it into an overflow.
- Inline client naming (`ClientNameCell`) is good — a real "+ Name this client"
  prompt rather than an empty cell. One line of praise.

**Mobile — capability is effectively lost.** The table is 741px inside a 356px
scroller. All four action icons and the "Last used" column are off-screen; you
must scroll a nested table sideways by 385px — *more than the visible width* —
to archive a matter. Nothing tells you the columns are there. Below 768px this
must be a list of rows, not a table.

**Verdict: MOVE into Settings; RETHINK the row as a list item with an
overflow.**

---

## 15. Settings and its six sub-pages

`views/settings.js`, `shots/w0-final/settings*.png`

**Function.** Configure the app. Six categories: General, AI assist, .TIM
export, Codes & shortcuts, Validation, Remote & backups.

**Necessity: KEEP, add CMS and timer Import to it.** Six categories is right
for the surface area. The `.subnav` (≥1024px) / `.pagenav` chip strip (<1024px)
swap, with overflow fades and scroll-into-view for the active chip, is properly
built. One line of praise.

**Form — three faults across the sub-pages.**

1. **Three different row layouts inside one card.** On `settings-ai`:
   "Model" is label-left / control-right; "Ollama URL" is the same but with a
   wider control; "System prompt" is a full-width label above a full-width
   textarea. On `settings-remote`: a status chip row, then a floating
   "Set a password" field + button mid-row, then a full-width "Require login"
   select. Every mature settings pattern (Apple HIG grouped lists, Polaris
   `SettingToggle`, Fluent) picks **one** row shape and holds it. Pick
   label-left/control-right, and give full-width controls their own labelled
   block below a rule.
2. **A ~760px content column in a 1425px viewport.** Half the desktop screen is
   empty on every settings page. Either centre it honestly with generous
   margins (Mercury's approach) or use the width for a two-column form.
3. **`Enable AI assist` gates the whole card but nothing below it is
   visually disabled.** Model, URL and system prompt look live while the
   feature is off.

**Verdict: KEEP; normalise the row component; absorb CMS and timer Import.**

---

## 16. Entry editor

`components/entryeditor.js` (862 lines), `shots/teardown/editor-existing.{desktop,mobile}.png`

**Function.** Correct everything about one entry.

Measured: **25 interactive controls**, 860×571 on desktop, 390×776 on mobile.

Contents in order: Date · Client/Matter · Total hours · Billable · custom
fields · Task lines header (Split into tasks / Split evenly / allocation chip)
· N task lines (code chip, hours, fragment, ↑, ↓, ✕) · Add task line ·
Allocated x of y · Narrative header (AUTO toggle, Reuse, Undo AI, AI split
button, save-shortcut bar) · suggestion chips · narrative box · validation ·
finalize gate · audit history · Delete / saving indicator / Save & close /
Finalize.

**Necessity — the dialog should not be a dialog.** It **autosaves** (`queueSave`,
with a "Saving… / ✓ Saved" indicator). There is therefore no unsaved state, no
commit boundary, and no reason for a modal — a modal exists to fence an atomic
transaction. `Save & close` is a misnomer for "close". Attio, Linear and Notion
all made the same move: an autosaving record editor is an **inline expansion or
a side panel**, not a modal, so the surrounding list stays visible while you
work. That matters here specifically: writing entry 3's narrative while being
able to see entries 1, 2, 4 and 5 is how a lawyer avoids double-billing the
same call.

**The ordering is backwards for the job.** The lawyer opens this to write or
fix the **narrative**. The narrative is the *last* section. On mobile
(`shots/teardown/editor-existing.mobile.png`) the narrative is **entirely below
the fold**, under the pinned action bar — you open "Edit time entry" on a phone
and the field you came for is not on screen. Date, Total hours, Billable and
Client/Matter — all already correct because a timer set them — occupy the first
700px.

**Necessity, item by item:** Task lines are real domain value (a task-coded
split is what the billing system wants) — keep, but collapse to a single
"Split into tasks" affordance until there is more than one line; a one-line
entry should show hours and nothing else. `Reuse` (narrative history) is
excellent — promote it next to the narrative field, not into a header button
row that competes with four other controls. The AI split-button + dropdown +
"split into tasks" checkbox is three levels of configuration on a feature that
should be one button. Audit history belongs in an overflow.

**Form.** The `SaveShortcutBar`, `Undo` for AI rewrites, and the allocation
chip are all good, specific, domain-correct touches. One line of praise.

**Speed.** Fix one narrative from the entry list via the pencil: click →
modal → scroll (mobile) → type → Ctrl+Enter = 4 + typing, with a full context
switch. Inline (already built, undiscoverable): 2 + typing, no context switch.

**Verdict: RETHINK — narrative first, everything else collapsed; inline
expansion or side panel on desktop, full-height sheet with the narrative at the
top on mobile.**

---

## 17. Stop chips

`components/stopchips.js`, `shots/teardown/stopchips.desktop.png`

**Function.** The instant after a timer stops, offer 2–3 one-tap narratives
drawn from that matter's own history (plus the model's suggestion), so the
entry finishes itself.

This is the second-best idea in the product and it is **one line away from
being the best**.

**The bug that kills it:** `pick()` sets the narrative and then calls
`openEditor({ id: entry.id })` (stopchips.js:54). Tapping a chip therefore
does not finish the entry — it drops you into the 25-control dialog to confirm
text you just chose. The whole point was one tap. Make it one tap: patch the
narrative, close the popover, emit a toast with **Undo** (the app already has
toast actions — `entrylist.js:141`). If the lawyer wants to edit, the row is
right there.

**Second fault: 15-second auto-dismiss.** A lawyer stops a timer *because the
next call is starting*. Fifteen seconds later the offer is gone and the entry
is a bare draft that has to be chased at close-out. Make it persist as an
inline "needs a narrative" state on the row itself.

**Third fault: it appears at `top: 22%; left: 50%`** (overlays.css:156) — a
fixed slab in the middle of the screen, unanchored to the timer that was
stopped. With several timers on screen there is nothing tying the popover to
its subject beyond the matter name in its heading. If the two lists merge (§5),
this becomes an inline state on the row and the anchoring problem disappears.

**Mobile.** 1/2/3 keys are a keyboard affordance; the chips are real buttons so
touch works. Fine.

**Verdict: RETHINK — make it inline on the row, make one tap finish the entry,
never auto-dismiss.**

---

## 18. Close the day

`components/closeout.js`, `shots/w0-final/closeout.desktop.light.png`

**Function.** Sweep every draft, confirm or write its narrative, then finalize
and export in one pass.

**Necessity: KEEP. This is the app's best-designed flow.** Six phases
(loading / sweep / summary / warn / blocked / closed), a card per draft
pre-filled from the matter's phrasebook so Enter *confirms* rather than
composes, an explicit warning gate, and a guard against drafts that appear
mid-sweep. It is domain-correct in a way Harvest has no equivalent for.

**Form — one structural doubt.** It is a **carousel**: one card at a time with
dot pagination, in a modal, over a list you can no longer see. Two consequences:
you cannot tell at a glance which of the four drafts still need work, and you
cannot skip ahead to the one you know is wrong. For 4 drafts a carousel is
fine; for 12 it is a trap. Mature review flows (Gmail's bulk-edit, Linear's
triage) keep the list visible and move a focus ring down it. The keyboard
contract (Enter accept, `e` edit, `↓` skip) survives that change unchanged —
it is literally *better* suited to a list.

Also missing: an **"Accept all"** for the common case where every suggestion is
right, and a jump-to-first-problem. And `e` (Edit) *closes the sweep* to open
the editor (`editCurrent()` → `onClose(true)`), so correcting one entry costs
you the whole pass and you must press `c` and walk the cards again.

**Placement.** Two names for the same job on one screen: `Finalize day` (header)
and `Close the day` (footer). Delete the former (§2).

**Verdict: RETHINK the carousel into a review list; DELETE the competing
header button; add Accept all; stop `e` from ending the sweep.**

---

## 19. Keyboard shortcut overlay (`?`)

`app.js:218–244`, `shots/w0-final/shortcuts.desktop.light.png`

**Function.** Teach the keyboard model.

Seventeen rows in one flat table, mixing global shortcuts with timer-grid
chords. Correct as a component; would be better in three labelled groups
(Global / Timer grid / Dialogs), which is what Linear, Superhuman and GitHub
all do.

Two content bugs: it lists `q` as "Quick capture" but there is no other route to
it (§11), and `g then d/c/s/e` will need updating when the destinations change.

**Verdict: KEEP, group the rows.**

---

## 20. Float timer (Document Picture-in-Picture)

`lib/pip.js` (891 lines), sidebar action, Chrome/Edge desktop only

**Function.** An always-on-top window listing running/worked/pinned timers,
with an expandable narrative field per row and a `+` quick timer.

**Necessity: KEEP the capability, DELETE the nav slot.** 891 lines and a
top-level navigation item for a feature that (a) is desktop-Chrome-only, (b) is
labelled a SPIKE in its own tooltip, and (c) does not exist on the phone —
which is where the always-on-top problem is *worse*, not better.

Worth noting: it duplicates the whole model again — its own row builder, its own
narrative editor with three modes (`stash` / `readonly` / `entry`), its own find
box, its own theme setting in General settings. That is a fourth entry-editing
surface after the editor, the inline narrative and the close-out sweep.

**Verdict: MOVE.** Out of the nav; onto the running-timer bar (§7) as a small
"pop out" affordance, shown only where `pipSupported()`. Delete the separate
"Float timer theme" setting — inherit the app theme.

---

## 21. Summary modal (`s`)

`components/summary.js`, reached from the footer button and `s`

**Function.** Read the day back as plain text to paste somewhere.

Rare, useful, correctly a dialog. **MOVE** it out of the footer's prime
real-estate into an overflow. One line, moving on.

---

# Part 2 — the bigger questions

## A. Information architecture

### What the app should have

**Four destinations, one persistent bar, one command surface.**

```
  Today          — the only screen he needs during the day
  Calendar       — where the hours went; any past day; the month picture
  Entries        — the ledger: every entry, filterable, bulk-editable, exportable
  Settings       — configuration, matters, task codes, export constants, backups

  ─ persistent ─
  Running-timer bar   — live clock + name + Stop + filed total, EVERY screen
  Quick capture       — one input, always reachable, keyboard and thumb
```

Phone bottom bar: `Today · Calendar · Entries · Settings` with quick capture as
a centre action (or a FAB), which is exactly what Material 3's
`BottomAppBar` + FAB pattern is for.

### Every current page, ruled on

| page | ruling | why | how often per day |
|---|---|---|---|
| **Dashboard** | **KEEP** → rename "Today", becomes the one screen | the whole loop lives here | continuously |
| **Day** (`#/day/…`) | **MERGE → Calendar** | byte-identical entry list to Dashboard; nav already calls it Calendar (`app.js:530`) | 1–2× |
| **Calendar** | **KEEP** | the only screen answering "which days are thin" | 1–2× |
| **Search** | **KEEP, RENAME "Entries"** | it is the ledger and the only bulk-edit surface | 1× |
| **Export** | **MERGE → Entries** | same list + 2 columns + 3 buttons; and Close the day already exports | ~1× |
| **Stats** | **MERGE → Calendar** | duplicates the calendar's question with less context; its one good number (billable ratio) is a header stat | <1× |
| **Clients/Matters** | **MOVE → Settings** | reference data, configured not operated | <1× |
| **Settings** | **KEEP** | correct as-is; absorbs CMS + timer Import | <1× |
| **Add todo** (action) | **DELETE from nav** | developer tool; the Alt+drag feedback gesture covers it | never |
| **Run /todo** (action) | **DELETE from nav** | launches a Claude agent that commits and pushes — not a lawyer's control | never |
| **Float timer** (action) | **MOVE → running-timer bar** | Chrome-desktop-only spike occupying a permanent nav slot | rarely |

Seven destinations + three actions → **four destinations + one action.**

### What that buys

- The phone bottom bar stops spending a slot on a once-a-day download and gets
  one for the thing done twenty times a day.
- `day.js` deleted; one `SelectedPanel`; one range picker; one entry renderer.
- Four "Export" buttons producing two file formats collapse to one Export
  action with an explicit format choice.
- Five ways to finalize (dashboard header, day header, per-entry lock, Search
  bulk, Export row lock) collapse to two: Close the day, and bulk-finalize in
  the ledger for the exceptional case.

---

## B. The core loop, redesigned

### Today

| step | interactions today | notes |
|---|---|---|
| start a timer (exists) | **1** click / `t` | correct — but on mobile it is at y=978, below the fold |
| start a timer (new matter) | **7** | New timer → name → CM picker → type → Enter → Create → ▶ |
| stop | **1** | correct |
| narrative, via stop chip | **3** + modal | tap chip → **editor opens** → Save & close |
| narrative, via inline edit | **2** + typing | best path, hover-only affordance, invisible on touch |
| narrative, via pencil | **4** + typing + scroll on mobile | full context switch |
| finalize + export the day | **1 + N + 1** (`c`, N×Enter, Enter) | good — but competing with 4 worse paths |
| **whole day, 5 entries, best case** | **~22** | |

Harvest, same day (`harvest-timetracking.desktop.1.png`): the description is
typed **when the timer starts**, in the row, so the narrative step costs 0 at
stop time. Their day is ~15 interactions and has no finalize step at all.

### What it should be

```
1. START      one list of rows. Tap ▶ on a row, or type into quick capture and
              press Enter to file directly.                            1 tap
              A matter with no row: type its name into quick capture,
              press Enter.                                      1 + typing

2. RUN        the running row is visibly running, in place, and the running-
              timer bar shows it on every screen.                          0

3. STOP       tap ■ on the same row.                                   1 tap

4. NARRATIVE  the row expands in place with 2–3 chips from this matter's
              history. Tap one → the entry is DONE, toast with Undo.   1 tap
              (today: 1 tap → a 25-control modal opens)
              None fit? The narrative field is right there, focused,
              with ghost-text completion.                          typing

5. FINALIZE   "Close the day" — the only end-of-day control in the app.
              A review LIST, not a carousel: every draft visible, each
              pre-filled, Enter accepts and moves down, "Accept all"
              for the common case.                            1 + N (or 2)

6. EXPORT     the last step of Close the day. Format chosen once in
              Settings; the button says which file it makes.              0
```

**Target: ~12 interactions for a 5-entry day**, down from ~22, with the
narrative step cut from 3 to 1 and the phone able to do all of it.

Three changes carry most of that:
1. Stop chips finish the entry instead of opening a modal (**−2 per entry**).
2. One list of rows instead of a timer board plus an entry list (**−1 context
   switch per entry, −11 controls above the fold on mobile**).
3. Quick capture gets a button (**a whole path that today does not exist on the
   phone**).

---

## C. The one-screen test

**If Timekeeper had exactly one screen, it would be a single list of today's
work, one row per matter, where each row is at once the timer, the recorded
hours and the narrative — with a running-timer bar above it and one input at
the top that files an entry from a sentence.**

```
┌───────────────────────────────────────────────────────────────┐
│  Fri, Aug 14        5.5h filed · 5.1h billable · 2.9h to 8.0h │
│  ▸ 00:23:41  Acme — merger                          [ Stop ]  │   ← every screen
├───────────────────────────────────────────────────────────────┤
│  ┌─────────────────────────────────────────────────────────┐  │
│  │ ⌕  what did you just do?                                │  │   ← quick capture
│  └─────────────────────────────────────────────────────────┘  │      always visible
├───────────────────────────────────────────────────────────────┤
│  2 need a narrative · 17 finalized entries not yet exported   │   ← attention, one line
├───────────────────────────────────────────────────────────────┤
│  ■  Acme — merger          00:23:41   2.6   billable      ⋯  │
│     Drafted the disclosure schedules for the merger…          │
│  ▶  Acme lease dispute        —       1.7   finalized     ⋯  │
│     Reviewed the landlord's termination notice…               │
│  ▶  Northgate diligence       —       0.8   ⚠ no narrative ⋯ │
│     [ Reviewed diligence responses ] [ Conferred with… ] ✎    │   ← chips inline
│  ▶  Firm administration       —       0.4   ⚠ no narrative ⋯ │
│  ▶  Verity — appeal brief     —       0.0                 ⋯  │
│  + start something else                                       │
├───────────────────────────────────────────────────────────────┤
│                                        [ Close the day  c ]   │
└───────────────────────────────────────────────────────────────┘
```

Everything else — the month picture, the ledger, matter maintenance, export
history, settings — is a place you *visit*, not a place you *are*.

**Therefore the dashboard should become that screen.** Concretely, from today's
dashboard: delete the Today meter card (§4), delete the timer-grid header's 12
non-essential controls and its tabs (§5), merge the timer grid and the entry
list into one list (§5, §6), replace the attention chip-wall with one line plus
inline row states (§3), delete Finalize day and Export from the header (§2),
add a permanent quick-capture input (§11), and put the running-timer bar above
everything and on every screen (§7).

On a phone that fits in roughly one and a half screens instead of 3.1, with the
first actionable row above the fold instead of 978px below it.

---

## D. What is missing

Judged against the job, not against a feature list.

1. **A persistent running-timer indicator outside the dashboard.** Measured:
   zero. Navigate to Calendar and the clock vanishes. In an installed PWA even
   the tab title is invisible. A timekeeping app must never be able to run a
   timer the user cannot see. **This is the most serious omission in the app.**
2. **A narrative on the timer, at start.** Harvest's whole speed advantage is
   that the description is captured when the timer starts, not chased at stop.
   The data model already supports it (`timers.narrative_template`,
   `timers.draft_narrative`, `timers.suggested_narrative`) — it is buried in
   the Edit-timer dialog under "Template narrative (optional)". Surface it as a
   one-line field on the row when a timer starts.
3. **A "yesterday isn't closed" nudge on open.** The attention banner reports
   "2 entries on earlier days not finalized · 4.5h" as a grey chip among four.
   Unfinalized time from previous days is the single most expensive failure
   mode in legal billing and deserves its own treatment.
4. **Undo on the chip pick.** `pick()` overwrites the narrative and opens a
   modal; the app already has toast-with-Undo everywhere else
   (`entrylist.js:141`, `:153`). Use it, and stop opening the modal.
5. **Empty and first-run states.** `EntryList` renders `<div class="card muted">No entries.</div>`
   and the timer grid a bare "Create your first timer" button. Every design
   system indexed on component.gallery treats the empty state as a designed
   surface with an illustration-or-icon, a sentence and a primary action.
   The very first thing a new user sees is currently the least designed thing
   in the app.
6. **Week-to-date against target.** The calendar computes week totals in the
   TOTAL column, but the number a lawyer actually manages — "am I on pace this
   week" — appears nowhere on the screen he lives on.
7. **A "recently used matters" affordance outside the CM picker.** The picker
   has Favorites and Recent (`shots/w0-final/entry-editor.desktop.light.png`)
   and it is good. Nothing else in the app uses it.
8. **Offline write queue.** It is an installed PWA with a cache-first service
   worker, used between calls, possibly in a lift. Stopping a timer with no
   network currently just fails with a toast.
9. **Bulk narrative operations in the ledger.** Bulk finalize/unlock/reassign/
   delete exist; "apply this narrative to these 4 entries" — the thing a
   lawyer actually wants when reconstructing a day — does not.

---

## E. The ten things

Ranked by value. Each is a concrete instruction with its screen and files.

---

**1. RETHINK — Merge the timer grid and the entry list into one list of rows.**

*Screen:* Dashboard. *Files:* `public/js/components/timergrid.js`,
`public/js/components/entrylist.js`, `public/js/views/dashboard.js`,
`public/css/timers.css`, `public/css/entries.css`.

One list, one row type, sorted by activity today then recency. A row shows:
matter/timer name · live clock (when running) · decimal hours · status · the
narrative (or the "needs a narrative" state) · one start/stop button · one "⋯"
overflow. Delete from the grid: the 3 grouping modes, the tab strip, A–Z sort,
New group, drag-and-drop, multi-select + batch menu, and the four clock-nudge
rows in the context menu (`Alt+↑/↓` and the editable clock already cover them).
Move Import to Settings. Keep single-column layout — it deletes the
`getBoundingClientRect` column geometry in `onBoardKey`. **Preserve exactly**:
the roving-tabindex card focus model, Enter/Space toggle, arrow navigation,
`Alt+↑/↓` nudge, `Shift+Enter` edit, `Ctrl+Enter` open-entry. Reference:
`shots/refs/harvest-timetracking.desktop.1.png`.

---

**2. RETHINK — Make the stop chip finish the entry, and stop it from vanishing.**

*Screen:* Dashboard. *Files:* `public/js/components/stopchips.js`,
`public/js/components/entrylist.js`, `public/css/overlays.css`.

Delete `openEditor(...)` from `pick()` (stopchips.js:54). On pick: PATCH the
narrative, close the surface, emit a toast with an **Undo** action. Delete the
15s `AUTO_DISMISS_MS`. Render the chips **inline in the stopped row** (after
change 1) instead of as a fixed slab at `top: 22%` — with a focused narrative
field beneath them for when none fits. This turns the app's most common
narrative path from 3 interactions + a modal into 1 tap.

---

**3. NEW — Give quick capture a visible, tappable control on every viewport.**

*Screen:* Dashboard + shell. *Files:* `public/js/app.js`,
`public/js/views/dashboard.js`, `public/js/components/quickcapture.js`,
`public/css/shell.css`.

Today `setQuickCapture(true)` is called from exactly one place — `app.js:475`,
`e.key === 'q'`. On the Android PWA the feature does not exist. Add a permanent
single-line input at the top of the Today screen on desktop (placeholder: *what
did you just do?*), and make it the centre action of the phone bottom bar.
Route the dashboard's `/` timer filter into the same surface so one input does
find-a-timer and file-a-line. Keep `q`.

---

**4. NEW — One running-timer bar, on every screen, at every width.**

*Screen:* shell. *Files:* `public/js/components/todayfooter.js` (becomes
`runbar`), `public/js/app.js`, `public/css/shell.css`,
`public/js/views/dashboard.js`.

Measured today: `footerH: 0` on calendar, search, stats, cms, export, settings.
Promote the footer out of `DashboardView` into the shell. Contents: live clock,
timer name, one **Stop** button, filed total. Remove the duplicate meter (it
duplicates the Today card, which change 5 deletes) and move `Summary` into an
overflow. On mobile, merge it into the bottom navigation region rather than
stacking a second 61px bar above it — today the two bars cost 121px, 14% of the
phone.

---

**5. MERGE — Collapse Day, Stats and Export; rename Search to Entries; move
Clients/Matters into Settings.**

*Screens:* nav + five pages. *Files:* `public/js/app.js` (`NAV`,
`BOTTOM_NAV`, `SHEET_NAV`, route table), `public/js/views/day.js` (**delete**),
`public/js/views/stats.js` (**fold into** `calendar.js`),
`public/js/views/exportview.js` (**fold into** `search.js`),
`public/js/views/search.js` (rename), `public/js/views/cms.js` (mount under
Settings), `public/js/views/settings.js`.

Final nav: **Today · Calendar · Entries · Settings.** `#/day/<date>` becomes a
deep link that opens Calendar with that day selected — the nav already treats
it as Calendar (`app.js:530`). `#/export/<filter>/<from>` deep-links into
Entries with that filter chip applied. Keep `g d/c/s/e` working: remap `s` and
`e` to the surviving destinations and update the `?` overlay
(`app.js:218–244`).

---

**6. RETHINK — Delete `Finalize day` and `Export` from the dashboard and day
headers; make Close the day the single end-of-day control.**

*Screens:* Dashboard, Day. *Files:* `public/js/views/dashboard.js`
(lines 115–143), `public/js/views/day.js`, `public/js/components/closeout.js`,
`public/js/components/todayfooter.js`.

Five paths finalize and four export, and the four Export buttons produce two
different file formats (dashboard/day/calendar → CSV; Export page → .TIM).
Delete `finalizeToday()` and `exportToday()` from the dashboard header. Keep
bulk finalize in the Entries ledger for the exceptional case. Make every
remaining Export control name its format.

---

**7. RETHINK — Narrative first in the entry editor; stop it being a modal on
desktop.**

*Screen:* entry editor. *Files:* `public/js/components/entryeditor.js`,
`public/css/editor.css`.

Measured: 25 controls; on a 390px phone the narrative field is entirely below
the fold (`shots/teardown/editor-existing.mobile.png`). Reorder: **narrative
(with Reuse beside it) → hours → matter → task lines (collapsed to one
"Split into tasks" affordance until there are ≥2) → date/billable/custom
fields → audit in an overflow.** Because the editor autosaves, `Save & close`
is a misnomer — rename it `Done` and make the desktop presentation an inline
row expansion or a right-hand panel so the rest of the day stays visible.
Preserve `Ctrl+Enter`, autosave, the AUTO toggle and the AI undo. *Coordinate
with the overlay builder — this is dialog structure, not dialog polish.*

---

**8. RETHINK — One primary action plus one overflow on every row, everywhere.**

*Screens:* Dashboard entries, Entries ledger, Clients & Matters, Export list.
*Files:* `public/js/components/entrylist.js` (lines 218–236),
`public/js/views/cms.js` (lines 123–136), `public/js/views/exportview.js`
(lines 187–192), `public/css/entries.css`, `public/css/views.css`.

Today: 5 unlabelled ghost icons per draft entry row, 4 per matter row (plus a
star, plus a pencil and a "Fields" button on client group rows). Keep exactly
one inline action — the timer button on an entry row, the favourite star on a
matter row — and move everything else behind a labelled "⋯" menu. Reference:
Primer `ActionList`, Polaris `ResourceItem`, and
`shots/refs/harvest-timetracking.desktop.1.png`, whose row shows two
*labelled* controls.

---

**9. RETHINK — Rebuild the attention banner as rows with explicit actions, and
make inline narrative editing visible.**

*Screen:* Dashboard. *Files:* `public/js/views/dashboard.js` (lines 145–173),
`public/js/components/entrylist.js` (`InlineNarrative`, lines 18–80),
`public/css/entries.css` (lines 21–22), `public/css/views.css`.

The four attention pills are `<button>`s styled as neutral grey chips whose
only affordance is a `title` tooltip — pointer-only, so on the phone there is
none. Split per-entry defects (which should become inline states on their own
rows, once change 1 lands) from day-level backlogs (one line, one link).
Separately: `.narrative-editable`'s entire affordance is `cursor: text` plus a
`:hover` background — give it a persistent low-contrast underline and an
explicit "write narrative" placeholder button on empty narratives, so the
fastest path in the app is discoverable by thumb.

---

**10. RETHINK — Turn Close the day's carousel into a review list, and stop
tables from being tables on a phone.**

*Screens:* Close the day; Entries; Clients & Matters. *Files:*
`public/js/components/closeout.js`, `public/js/views/search.js`,
`public/js/views/cms.js`, `public/css/views.css`, `public/css/overlays.css`.

Close the day: replace the one-card-at-a-time carousel with a list of every
draft, pre-filled, with a focus ring that Enter advances — keeping Enter/`e`/`↓`
exactly as they are. Add **Accept all**. Stop `e` from ending the sweep
(`editCurrent()` currently calls `onClose(true)`), so fixing one entry does not
cost the whole pass.

Tables: measured widths inside a 356px mobile scroll box are **cms 741px** and
**search 839px** — Hours is off-screen in Search and all four action icons are
off-screen in CMS, while the bulk-select checkbox column survives at full
width. Below 768px, render both as list rows (Search can reuse `EntryList`
directly), not as a horizontally scrolled desktop table.

---

## Where the current design is already right

One line each, then done.

- The close-out sweep's pre-fill-and-confirm model, and its guard against
  drafts appearing mid-sweep.
- The timer card's roving-tabindex keyboard model (card is the tab stop, inner
  buttons `tabIndex=-1`).
- The CM picker's Favorites / Recent & All grouping with inline "New
  client/matter".
- Inline client naming in CMS ("+ Name this client" rather than an empty cell).
- Toasts that carry an Undo action for destructive writes.
- The `.subnav` ↔ `.pagenav` settings-navigation swap at 1024px, with overflow
  fades and scroll-into-view for the active chip.
- The overlay back-dismiss model (history marker per overlay, LIFO, route
  change unmounts all).
- `BarList` in Stats: labelled, valued, single-hue, readable.
- The allocation chip, the AUTO toggle and the AI-rewrite Undo in the editor.

---
---

# Wave 1 review — 2026-08-15

Same critic, same standard. Evidence: `shots/teardown-w1/` (60 shots, 0 failed,
**0 console errors**, mobile fences pass), `shots/baseline/`, `shots/refs-v2/`,
and my own puppeteer-core driving of the real app on a real server with
`scripts/lib/demoseed.mjs`. Everything below is measured, not read.

## A. Verdicts on my own ten things

**1. Merge the timer grid and the entry list into one list of rows — BUILT.**
One `.work-row` list keyed by matter. Gone from the DOM: the three grouping
modes, the `role="tablist"` filter strip, A–Z sort, New group, drag-and-drop,
multi-select and the batch menu. The 17-item context menu is now `Timer menu`
(10 items) / `Entry menu` (6). Import moved to Settings → Clients & matters ⋯.
Single column. Keyboard model intact, driven: roving `tabindex` 0/-1, `↓↓↑`
walks rows, `Alt+↑` nudges, `Shift+Enter` opens `ovl-md`, `Ctrl+Enter` opens
`ovl-lg`, `t` toggles the last-used timer. Controls in `<main>` on Today:
**64 → 43 desktop, 69 → 39 mobile.**

**2. Stop chip finishes the entry and stops vanishing — BUILT, all four parts.**
`.stop-chips.stop-chips-inline` renders *inside* the stopped `.work-row`, not at
`top:22%`. Still present after 20s — the 15s auto-dismiss is gone. One tap sets
the narrative with **no dialog** and raises a toast reading `Narrative saved ·
Undo`. Chips are 46–61px tall on the phone. The best-executed item in the wave.

**3. Visible quick capture on every viewport — BUILT; the `/` half NOT built.**
Desktop: a sidebar input `What did you do?  q` opens `.qc-card` 560×156.
Mobile: bottom-bar `Capture` opens a 390×241 sheet. `q` works from Today,
Calendar, Entries and Settings. But `/` still forks — it focuses
`.timer-search` on Today and `.ledger-search` everywhere else. The two surfaces
were not merged; the `?` overlay now *documents* the fork ("Search — timers on
Today, the entry ledger everywhere else") instead of removing it.

**4. One running-timer bar on every screen — BUILT, with two residuals.**
`.runbar` is `position:fixed` on `#/`, `#/calendar`, `#/entries`, `#/settings`,
both viewports, carrying name + live clock + filed total + Stop + a pop-out for
the float window (which also satisfies §20's MOVE). Residuals: (a) **desktop
Today still stacks two fixed bars** — `.runbar` 48px at the top *plus*
`.today-footer` 49px at the bottom = 97px; the footer was absorbed on mobile,
not on desktop; (b) `.runbar.resting` computes to **height 0** on mobile while
still rendering the text `5.6h filed` — a zero-height fixed element painting
nothing.

**5. Collapse Day / Stats / Export, rename Search, move CMS — BUILT.**
Nav is Today · Calendar · Entries · Settings. `#/day/<date>` renders Calendar
with that day selected; `#/export` renders the ledger with the Export dialog;
CMS lives at `#/settings/cms`. `g d/c/s/e` → `#/`, `#/calendar`, `#/settings`,
`#/entries`; `[`/`]` still step days. **Variance:** Stats was *relocated*, not
merged — `#/stats` is a Statistics sub-tab under Calendar and still carries an
"Hours by day" panel whose own caption reads "The calendar draws the same
figures against your target." A panel that documents its own redundancy should
be deleted.

**6. Delete Finalize day and Export from the headers — BUILT with variance,
and it introduced a new defect.** The header is `< date > ⋯` + Quick start;
`Finalize today without exporting` and `Download today as CSV` moved into the
⋯, which is a better answer than deletion. The .TIM/CSV labelling bug is fully
fixed: the Export dialog offers `Copy as text 17` / `Download CSV 17` /
`Download .TIM 17`, each with a sentence saying what it is, and `Include drafts`
is a real button rather than the disabled checkbox that lied. **New defect:**
the mobile bottom bar carries a permanent `Close` slot that fires close-out for
*today* from Calendar, Entries and Settings, while the `c` shortcut fires only
on Today. Touch and keyboard disagree, and on Calendar the button closes a day
other than the one on screen.

**7. Narrative first in the entry editor — NOT BUILT.** Measured at 390×844:
panel 390×776 at y=68; the narrative `<textarea>` sits at **y=725**, the 15th
of 18 controls, beneath the pinned Delete / Save & close / Finalize bar. In
`shots/teardown-w1/entry-editor-existing.mobile.light.png` it is not visible at
all. Order is unchanged: Date → Total hours → Client/Matter → Billable → Task
lines → Add task line → Allocated → Narrative. Desktop is still a centred
`ovl-lg modal modal-wide` at 858×585, and the primary is still called
`Save & close`.

**8. One primary plus one overflow on every row — PARTLY BUILT.** Entry rows
lost the five unlabelled ghost icons and gained a labelled `Start`/`Stop` plus
`⋯`. But the matter name, the hours figure, the clock figure and the narrative
are all separately focusable buttons, so a Today row still carries **six
controls** (36 of the page's 43 belong to six rows). Harvest's row
(`refs-v2/harvest-timesheet-day.desktop.webp`) carries two. CMS matter rows went
4 icons → 3 (star, pencil, ⋯); the pencil belongs in the ⋯. The ledger's
bulk-select checkbox column is still permanent on desktop with no persistent
action bar.

**9. Attention as rows with actions; visible inline narrative — BUILT.** The
chip wall is one amber line of three underlined links, each with a real
destination, driven: "2 entries not finalized · 4.5h" →
`#/entries/export/unfinalized/2026-08-14`; "2 entries need a narrative" → stays
on Today, scrolls 104px and focuses `.narrative-inline-input`; "17 finalized,
not yet exported" → `#/entries/export/unexported/2026-08-06`. The narrative now
carries a persistent dotted underline plus a pencil, and empty ones show a
dashed `Write narrative` button. **Residual:** on the phone only the first item
renders; the other two hide behind `+2 more` — and the two hidden ones are the
two that deep-link.

**10. Close-out list, and tables off the phone — HALF BUILT.** Tables: done.
CMS and the ledger both render as card lists below 768px; ledger narratives wrap
to three lines; the 741px and 839px sideways scrollers are gone. Close-out: not
built. Driven, it is still `Close the day — 1 of 5` with dot pagination and
`Quit / Skip / Edit / Accept`. There is no **Accept all**. And `Edit` still
destroys the sweep — measured: click Edit on card 1 of 4, the sweep unmounts,
the editor opens; press Esc and you are on Today with **no sweep at all** and
must press `c` and walk from card 1 again.

Score: **6 BUILT, 3 PARTLY, 1 NOT.**

## B. The numbers, re-measured at 390×844

| | teardown | now | note |
|---|---|---|---|
| Today page height | 2639px (3.1 screens) | **1292px (1.53)** | −51% |
| y, first control that starts/stops a timer | 978 | **328** (row Stop) / **0–44** (run bar Stop, fixed) | above the fold |
| complete work rows above the fold | 0 | **2** | fold at y=784 (botnav top); rows end 504 / 688 / 799 |
| work-row heights | — | **182, 184, 111, 136, 109, 57** | 3.2× spread |
| total fixed chrome | 121px (14%) | **104px (12.3%)** running, **60px (7.1%)** idle | runbar 44 visible + botnav 60 |
| visible controls in `<main>`, Today | 64 desktop / 69 mobile | **43 / 39** | 36 of 43 belong to six rows |
| desktop fixed chrome, Today | 49px | **97px** (runbar 48 + today-footer 49) | went *up* |
| desktop row heights | — | **117, 113, 91, 91, 55, 55** | Harvest: uniform 93 |

The earlier critic's "173px of fixed chrome" is not reproducible on this build:
the measured mobile total is 104px with a timer running and 60px without.

## C. The core loop, re-counted

Driven on the phone, every interaction counted, five timers started and
stopped, then the day closed:

| | teardown | target | **measured now** |
|---|---|---|---|
| 5-entry day, narratives left to close-out | ~22 | ~12 | **18** |
| 5-entry day, narratives taken from stop chips | — | — | **23** |

A four-matter run measured **17** end to end (4 Start, 4 Stop, 2 chips, Close,
4× Enter, Finalize & export, Done); the arithmetic extrapolates to 18–23 for
five. **The wave did not move the interaction count**, and using the new
one-tap chips makes the day *longer*, because:

**The stop chip and the close-out sweep are not connected.** An entry that
already has a narrative — because you chipped it thirty seconds earlier — still
gets its own card in the sweep and still costs an Enter. Confirmed: cards 3 and
4 of the sweep were the two entries I had already chipped. The chip is a real
win per-entry (3 interactions + a modal → 1 tap) and a net loss per-day.

Second cause: close-out charges 1 + N + 2 where N is *every* draft. The wave's
own new capability — the phrasebook pre-fill and the chip — should be able to
retire cards, not just pre-fill them.

## D. What this wave broke or made worse

1. **Two fixed bars on desktop Today.** 48px run bar + 49px footer = 97px,
   against 49px before. The footer's only contents are `5.6h filed` and
   `Close the day` — and `5.5h filed today` is *also* the first line of the stat
   strip 700px above it. This is §4's two-meters defect, resurrected at smaller
   scale.
2. **The mobile bottom bar is a seven-slot bar.** `5.5h filed | Today |
   Calendar | Capture | Entries | Settings | Close` in 390px. Material 3 caps a
   bottom navigation bar at five destinations; this is six controls plus a
   status label, at ~56px each. It also gives a once-a-day destructive-ish
   action (`Close`) a permanent thumb slot — the exact objection I made about
   Export having one.
3. **The Entries ledger doubled in height on the phone**: 2868 → **5386 CSS px**
   (6.4 screens) for 23 entries, because every entry became a ~190px card with
   no pagination or virtualisation. The capability is genuinely better (hours
   and narrative are readable without a 483px sideways scroll) but the page is
   now the longest in the app.
4. **Calendar grew 38% on the phone**, 1226 → **1695 CSS px**, and §9's second
   fault is untouched: three all-empty week rows (16–22, 23–29, 30–31) render at
   full height, ~164 CSS px of blank grid, and they push the selected-day panel
   to roughly y=1000 — so on the phone, tapping a day produces a result you
   cannot see without scrolling, with nothing signalling it.
5. **Settings grew 2664 → 3120px on the phone** and gained an accordion
   (`SECTION 1 OF 8`), adding a step to reach any setting.
6. **Three overflow-menu components now coexist**, which contradicts wave 0b's
   "every dialog goes through one overlay primitive": `.ovl` full-screen sheets
   with 44px rows (Today row menu on mobile, Day header ⋯ on mobile, CMS list ⋯
   on mobile), `.ctx-menu` anchored popovers with **28px** rows (Today row menu
   on desktop, Entries row ⋯ on both, Day header ⋯ on desktop), and `.act-menu`
   with 36px rows (CMS list ⋯ on desktop). The already-queued "28px rows" item
   is a symptom; the disease is that there are three menus.
7. **Two different overflow menus hang off visually identical rows.**
   `Timer menu` (10 items, includes `Stop & file time`, backdate chips
   `10m ago / 30m ago / at last stop`, `Edit timer…`) versus `Entry menu`
   (6 items, includes `Delete entry` and `Start a timer on this matter`).
   `Delete entry` exists in one and not the other. Nothing on the row tells the
   lawyer which he is about to get.
8. **Today and the ledger disagree about the day.** Today is keyed by matter and
   shows `Acme — merger 2.7`; the ledger shows the same work as two rows, 2.6
   and 0.0. The figure 2.7 appears nowhere in the ledger. Today's list showed 6
   rows where the day panel header said "5 entries".
9. **Quick capture's primary is disabled far too often.** Driven with four
   realistic phrasings, only one filed. `"Acme lease dispute review .6"` and
   `"northgate diligence review documents .4"` both parse matter and hours,
   then show `? action` and a **disabled** `File it`. The hint says "fill the ?
   pieces" — but `.qc-chip.miss` is an inert `<span>` 67×27 with `cursor:
   default`; clicking it does nothing. There is no way to follow the
   instruction the dialog gives. This is a dead end on the wave's headline new
   path.
10. **The stop-chip empty state contradicts itself.** With no history the
    surface reads "Nothing on file for this matter yet — write the narrative on
    the row" while occupying the row and offering no field; you must Dismiss it
    first to reach `Write narrative`. My E2 asked for a focused narrative field
    beneath the chips; there is none.
11. **`Float window theme` survives in General settings.** §20 said delete it
    and inherit the app theme. Still there.
12. **The `Day closed` panel reads "1 draft still need attention."** Grammar,
    and a state question: the sweep accepted 5 of 5 and one draft is still
    outstanding, unexplained.

Nothing regressed in correctness: 60/60 shots clean, zero console errors on any
route or dialog, no horizontal overflow, every statically visible interactive
element ≥44×44, `n t q c s / ? g[dcse] [ ] Ctrl+Enter Shift+Enter Alt+↑ Esc`
and the arrow-key row walk all verified working.

## E. What I got wrong

1. **"Delete `Finalize day` and `Export` from the dashboard header" was too
   blunt.** Moving them into a `⋯` with format-naming labels is better than
   deleting them: the exceptional case (finalize without exporting; re-download
   today's CSV) is real and now costs one extra tap instead of a trip to the
   ledger. Replace E6 with: *demote to overflow and name the format* — which is
   what shipped.
2. **"Merge Export into the ledger" undersold the answer.** The wave made Export
   a dialog with three explicitly described formats and live counts, which is
   better than the filter-chip I proposed. What is left over is the
   `All entries | Export` subnav pair — a navigation destination whose only job
   is to open a dialog. Replace with: one `Export…` button in the ledger header,
   no subnav item.
3. **"Delete the Stats screen's By-day chart" is now the wrong instruction
   because the whole Statistics tab is the redundancy.** The three header stat
   tiles (Total / Billable / Not closed) already carry everything I wanted
   folded into Calendar. Replace with: delete the Statistics tab; keep the two
   `BarList`s as a collapsible "This month" panel under the calendar grid.
4. **"One primary action plus one overflow" is not achievable on the merged
   row, and I should not have written it as an absolute.** A row that is
   simultaneously a timer, an entry, an hours field and a narrative needs the
   name and the hours to be editable in place — that is the whole point of the
   merge. The right rule is *one primary **button** plus one overflow*; text
   and numbers that edit in place are not buttons competing for attention as
   long as they are visually typography, not chrome. The current row passes that
   rule. Withdraw the absolute; keep the count of *buttons* at two.
5. **I called the sticky footer's `Summary` "prime real-estate waste" and asked
   for it to move to an overflow. It moved, and `s` still works — but there is
   now no visible control for it on the phone at all** (it lives in the desktop
   Day-header ⋯). I under-specified. Summary needs one visible entry point on
   both viewports or it should be deleted.
6. **My "~22 interactions" baseline was an estimate, not a measurement, and it
   was too generous to the old build.** The honest comparison is: the *marginal*
   cost per entry fell (narrative 3 + modal → 1 tap) while the *fixed* cost of
   close-out did not, so the day total is flat. Future waves should be judged on
   the measured 18/23, not on my original 22.

## F. Wave 2, ranked

**1. RETHINK — the entry editor. (the centrepiece)**
`public/js/components/entryeditor.js`, `public/css/editor.css`.
Judge against `shots/refs-v2/harvest-new-time-entry.mobile.jpg`, which does the
same job in **7 controls** to our 18, using label-left / value-right rows that
open pickers rather than inline widgets. Ours must invert Harvest's order —
their note is optional and last, our narrative is the reason the dialog exists.
Target order: **Narrative (focused, with Reuse beside it) → Hours (stepper with
+0.1/+0.2/+0.5/+1.0 quick-add pills, copying Harvest's floating pill row) →
Matter ▸ → Task lines, collapsed behind one "Split into tasks" affordance until
there are ≥2 → Date ▸ / Billable → audit in the ⋯.** Rename `Save & close` to
`Done` (it autosaves). Desktop presentation becomes a right-hand panel or an
inline row expansion so the rest of the day stays visible. Preserve
`Ctrl+Enter`, autosave, AUTO, AI undo, the allocation chip.
*Acceptance: the narrative field is above y=200 at 390×844; ≤10 controls
visible before "more"; the editor opens on the narrative with the caret in it.*

**2. RETHINK — connect the stop chip, the phrasebook and close-out.**
`public/js/components/closeout.js`, `public/js/components/stopchips.js`.
The single biggest number in this document is that the day still costs 18–23.
Fix it here: (a) a draft that already has a narrative is **not** a card in the
sweep — show it in a "ready" list at the top with a count and one confirm;
(b) add **Accept all** for the remainder; (c) stop `Edit` unmounting the sweep —
open the editor over it and return to the same card (measured today: the sweep
is destroyed and Esc leaves you on Today); (d) replace the carousel with a list
so you can see which of N still need work and jump to one.
*Acceptance: a 5-entry day where every stop was chipped closes in ≤4
interactions after `c`; total day ≤12.*

**3. RETHINK — one overflow-menu component, one row menu.**
`public/css/overlays.css`, `public/js/components/` (the `ctx-menu`, `act-menu`
and `ovl`-sheet call sites), `public/js/views/search.js`,
`public/js/views/cms.js`. Collapse three menu implementations into one:
anchored popover ≥1024px, bottom sheet below, 44px rows in both. Then collapse
`Timer menu` and `Entry menu` into a **single row menu** whose items are enabled
or disabled by row state — `Delete entry` must exist on every row that has an
entry. This subsumes the queued 28px-row item; do not fix that separately.

**4. RETHINK — the Today row's rhythm.**
`public/js/components/timergrid.js`/`entrylist.js` (whichever renders
`.work-row`), `public/css/timers.css`, `public/css/entries.css`.
Against `refs-v2/harvest-timesheet-day.desktop.webp`: uniform ~93px rows, two
lines, one right-aligned duration, one control. Ours: 109–184px on the phone
(3.2× spread), so only 2 complete rows clear the fold. Fix by (a) collapsing
`2.7 / clock 0.1` to one number with the clock only on the running row —
`1.7 clock 0.0` is two numbers where one is always zero; (b) putting the status
chip (`finalized`, `non-billable`) inline with the matter number rather than on
its own line; (c) capping the resting narrative at one line with the full text
on expand. *Acceptance: 4 complete rows above the fold at 390×844; height spread
under 1.4×.* This subsumes the queued 111–184px item.

**5. RETHINK — quick capture must never dead-end.**
`public/js/components/quickcapture.js`.
Three of four realistic sentences produce a disabled `File it` and an inert
`? action` chip. Make every `qc-chip.miss` a real control that opens the matching
picker (task-code list / matter picker / hours stepper) inline in the sheet, and
let `Enter` on a parse with a missing task code file it as a draft rather than
refusing. Also fold the Today `/` timer filter into this surface, closing out
E3's second half and giving `/` one meaning.

**6. MERGE — the desktop day footer into the run bar; fix the resting bar.**
`public/js/components/todayfooter.js`, `public/js/app.js`, `public/css/shell.css`.
Desktop Today carries 97px of fixed chrome across two bars showing the same
`5.6h filed` that the stat strip already shows. Put `Close the day` in the run
bar and delete `.today-footer`. Separately, `.runbar.resting` computes to
height 0 on mobile while still rendering text — either give it a height or
render nothing.

**7. DELETE — the Statistics tab; MOVE its two BarLists under the calendar.**
`public/js/views/stats.js`, `public/js/views/calendar.js`, `public/js/app.js`.
The header tiles already answer the question and the "Hours by day" panel says
so itself. Keep `#/stats` as a redirect to `#/calendar`.

**8. RETHINK — Calendar on the phone.**
`public/js/views/calendar.js`, `public/css/views.css`.
Collapse or shrink all-empty trailing week rows (~164 CSS px of blank grid
today); on tap, scroll the selected-day panel into view or render it directly
under the tapped week. Add a roving `tabindex` to the 42-cell grid (queued item)
in the same pass — a grid whose rows collapse and whose cells are one tab stop
is one component change, not two.

**9. MOVE — `Close the day` off the phone's bottom bar; fix its date.**
`public/js/app.js`, `public/css/shell.css`,
`public/js/components/closeout.js`.
Seven slots in 390px is two too many, and a `Close` button on Calendar that
closes a different day than the one on screen is a correctness failure. Put
`Close the day` in Today's page header (where `c` already lives) and give the
bar back to five slots: Today · Calendar · **Capture** · Entries · Settings.

**10. DELETE — the `All entries | Export` subnav pair, and the
`Float window theme` setting.**
`public/js/views/search.js`, `public/js/app.js`, `public/js/views/settings.js`.
A navigation destination whose only job is opening a dialog is not a
destination; the header `Export…` button is enough. The float window should
inherit the app theme (§20).

**11. NEW — pagination or virtualisation in the ledger; a Summary entry point.**
`public/js/views/search.js`, `public/js/components/summary.js`.
5386 CSS px for 23 entries does not survive a year of data. And `s` currently
has no visible control on the phone.

---

# Owner constraint — 2026-08-15, overrides this document

The person who uses this app every working day has ruled on one point, and it
overrides anything in this teardown or its wave-1 review:

**This is fundamentally a timers app.** He uses the timer list extensively,
and he uses `/` to search that timer list frequently.

Therefore:

1. **`/` on Today filters the timer list. It stays exactly as it is.** Wave-2
   item 5 of the wave-1 review proposed folding Today's `/` timer filter into
   the quick-capture surface "so search stops forking by route". That proposal
   is **withdrawn**. The fork is deliberate and correct: `/` searches timers on
   Today and entries elsewhere, because those are the two things a lawyer looks
   for in those two places. The shortcut overlay documenting the fork is right
   to document it.
2. **The merged Today list is a list of timers** that also carries the day's
   recorded hours and narratives — not an entry list that happens to show
   timers. When a judgement call about the row's reading order or its primary
   action could go either way, it goes the timer's way.
3. **Timer capabilities are demoted in the surface, never in reach.** Groups,
   filters, sorting, rename, reorder, duplicate, import and batch actions all
   keep working, and each keeps a touch path.
4. Timer search must be excellent rather than merely present.
5. **Compact is the right default, and denser than today is better — provided
   it expands.** His words: making the timer list more compact is "totally
   fine, better even. just so long as I can expand it. and search it with
   keyboard." So the resting list should be dense enough to scan many timers
   at a glance, with expansion in two forms, both built: a row that expands in
   place to reveal the narrative, task lines and secondary controls — by
   keyboard, click and touch — and a compact-versus-comfortable density
   control for the whole list that persists across sessions. Density is a
   default, never a cage: the compact row still carries the matter, the state,
   the hours and the start/stop control.

Everything else in this document stands.
