# Component-level correctness notes

Research pass for the Timekeeper UI overhaul, bar 3 of `BRIEF.md`
(component.gallery + the mature design systems it indexes). For each of the
ten component types this gives: which systems actually yielded documented
guidance, the concrete numbers they publish, what a correct build must do,
and the single most common mistake. A short "Applied to Timekeeper" line
closes each section, tying the pattern to this app's actual screens.

**Methodology note.** component.gallery itself is an *aggregator* — its
per-component pages (`/components/<name>/`) mostly list which of the 95
design systems implement a component and which facets each one documents
(code examples, usage guidelines, accessibility, tone of voice), plus a
handful of curated external essays (Tess Gadd/Balsamiq guideline articles,
Open UI explainers). Only a few categories (Tabs) carry a full generic
write-up on the aggregator page itself. So component.gallery was used here
as the index — confirming which systems treat a pattern as a first-class
component and what each system *calls* it — and the concrete numbers below
were then pulled from the named systems' own documentation. Two of the
brief's nine reference systems, Base Web and Fluent 2, render their docs
entirely client-side and could not be scraped as text; where they matter
they're covered via secondary sources and flagged as such.

---

## 1. App shell navigation (sidebar → phone layout)

**Systems checked:** component.gallery (Navigation, Drawer, Header — index
only, no generic write-up); Material 3 (Navigation bar, Navigation rail,
Navigation drawer); Apple HIG (Tab bars, Sidebars); Carbon (2x Grid /
breakpoints); Fluent 2 (Nav, Layout — via search, page is client-rendered).

**Concrete numbers:**

- **Material 3** — Navigation bar (bottom bar): 3–5 destinations. At 4
  destinations, inactive items may drop their label; at 5, labels are used
  "with caution" because there often isn't room. Breakpoint mapping:
  **compact** width → modal navigation drawer (or bottom nav bar);
  **medium/expanded/large/extra-large** → navigation rail, which itself
  collapses to a modal drawer via a menu button when the rail runs out of
  room. As of Material 3 Expressive (2025), the standalone navigation
  drawer is deprecated in favor of an navigation rail with a collapsed and
  an expanded configuration — one component across the whole range instead
  of three.
- **Apple HIG** — Tab bar: 3–5 items is the target range on iPhone; current
  guidance caps at **6 or fewer** before a "More" tab (itself a poor use of
  space — an extra tap to reach anything past the cutoff) becomes necessary.
  On iPad, prefer a **sidebar** over a tab bar once destination count grows,
  because a sidebar scales to many items and can be user-customized and
  hidden; `NavigationSplitView`'s tab-bar-and-sidebar combination is the
  documented large-screen pattern.
- **Carbon** — grid/breakpoints: `sm` 320px, `md` 672px, `lg` 1056px, `xlg`
  1312px, `max` 1584px. These are the thresholds Carbon's UI Shell uses to
  decide when a side nav is hidden-behind-hamburger vs. persistent.
- **Fluent 2** — hamburger toggle is the persistent, predictable
  expand/collapse control across Microsoft's own apps; the side nav becomes
  an **overlay drawer at 640px**, and the system is designed down to a
  **320px** floor. Navs support up to two levels of hierarchy before items
  need grouping.
- **Touch target / safe area (cross-cutting):** WCAG 2.5.8 (AA, WCAG 2.2)
  sets a **24×24 CSS px** floor with a spacing escape hatch; WCAG 2.5.5
  (AAA) and Apple HIG both use **44×44pt**; Material uses **48×48dp**.
  Timekeeper's own floor (44×44 CSS px) sits at the AAA/Apple number —
  correct, and safely above the AA minimum. A bottom nav bar must add the
  device's bottom safe-area inset as padding, not margin, so the last row
  of icons doesn't sit under a home indicator or gesture bar.

**Buildable guidance:** there is no single "responsive nav" component —
every system converges on the same *shape* of decision tree: below a
compact-width threshold, use a bottom bar (thumb reach) if the destination
count fits its item limit; above it, use a persistent rail or sidebar;
reserve a drawer (temporary/modal) for anything that doesn't fit either,
triggered by a hamburger. The number of primary destinations should be
decided **before** picking the pattern — if it's over ~5, no bottom bar
variant will hold it cleanly and something has to move into an overflow
surface (a "More" tab/sheet, in Apple's own vocabulary).

**Most common mistake:** copying every sidebar item straight into the
bottom bar. All four systems here cap the *ideal* item count at 5 and treat
6+ as needing an escape hatch (Apple's "More" tab, Material's rail-to-drawer
collapse) — a bottom bar with 7 shrunken, labelless icons fails every one of
these systems' own guidance simultaneously.

**Applied to Timekeeper:** the desktop sidebar has 8 destinations
(Dashboard, Day, Calendar, Search, Stats, CMS, Export, Settings) — a direct
port to a bottom bar would blow past even the generous 6-item ceiling. The
correct pattern is hybrid: bottom bar with the 4 highest-frequency
destinations (Day, Dashboard, Calendar, Search) each with icon+label per
Material's ≤5-item rule, plus a 5th "More" item opening a sheet with the
rest (Stats, CMS, Export, Settings) — Apple's own documented escape hatch,
not a bespoke one.

---

## 2. List row / data table row with 4–6 actions

**Systems checked:** Carbon (Data table — full usage doc); Primer
(ActionList — full guidelines doc); Material 3 (Lists, via training —
one-line item height 56dp / two-line 72dp, 24dp leading icon); Polaris
(IndexTable/ResourceList, via search — docs are client-rendered).

**Concrete numbers / rules:**

- **Carbon** — hard rule for the icons-vs-overflow decision: *"When the
  overflow menu contains fewer than three options, keep the actions inline
  as icon buttons instead."* Below 3 actions → inline icons; 3+ → overflow
  menu. The table toolbar (global, not per-row) caps at **5 actions**
  before it too needs an overflow/combo button. Row hover state is *always*
  enabled, even on non-interactive rows, purely to help users track their
  place while scanning. Per-row overflow menus are **persistent by
  default**; a `overflowMenuOnHover` variant hides them until hover/focus to
  cut visual clutter — but Carbon explicitly overrides this on touch: *"For
  mobile and touch devices the data table will detect if the user agent
  supports hover-over and persist the overflow menus"* rather than hiding
  actions somewhere a touch user can never reveal them. Selection mode
  (checkbox) replaces the toolbar with a **batch action bar** the moment
  ≥1 row is selected; single-row icons/overflow are disabled while batch
  mode is active, and batch mode exits via an explicit Cancel or by
  deselecting everything.
- **Primer ActionList** — trailing actions (secondary, e.g. "open a menu")
  appear on hover and are individually keyboard-focusable, distinct from
  non-interactive trailing visuals/text (status, counts, keyboard-shortcut
  hints) which have no dedicated hit target. ActionList explicitly ships a
  "mobile-friendly inset style" — sizes adapt for touch devices while
  keeping the single-column layout consistent at any width, rather than
  swapping to a different row shape on mobile. Danger (destructive) items
  go at the **end** of the list and pair with a confirmation dialog; if the
  action is reversible, offer undo instead of a confirmation ("never use a
  warning when you mean undo").

**Buildable guidance:** decide the action count *before* choosing icons vs.
menu. 1–2 actions: inline icon buttons (with tooltips/labels, never bare).
3+: a single trailing overflow (kebab) button that opens the rest — Carbon's
own numeric threshold is worth adopting verbatim. On touch, never rely on
hover to reveal the overflow trigger; detect touch/no-hover and keep it
visible, exactly as Carbon does.

**Most common mistake:** rendering all 4–6 actions as bare icon buttons in
a row with no labels, tooltips, or overflow — "a wall of unlabelled icons"
is precisely the failure mode Carbon's ≥3-actions-to-overflow rule and
Primer's hover-revealed trailing actions both exist to prevent.

**Applied to Timekeeper:** an entry row (matter title, client/date
metadata, hours, and actions like resume-timer, edit narrative, duplicate,
mark billable, delete) is squarely in the 5–6-action zone. Correct shape:
one always-visible primary icon (resume/start timer — the single most
frequent action) plus a trailing overflow button for the rest, with the
overflow button touch-visible by default rather than hover-revealed, since
this app runs as a touch PWA as much as a desktop app.

---

## 3. Modal → bottom sheet / full-screen sheet

**Systems checked:** Radix Primitives (Dialog — full API); Primer (Dialog —
full API, including a documented responsive position pattern); Material 3
(Dialogs + Bottom sheets specs, via search); Apple HIG (Sheets, via search).

**Concrete numbers / rules:**

- **Radix Dialog** (the primitive most component libraries, including
  shadcn/ui, build on): modal mode traps focus automatically inside
  `Dialog.Content`; **Esc** closes and returns focus to the trigger;
  **Tab/Shift+Tab** cycle within the trapped region; content portals to
  `document.body` by default (or a custom container); the overlay is a
  fixed, full-viewport layer with its own `overflow-y: auto`, which is what
  keeps page-behind-the-modal scroll locked while long dialog content still
  scrolls internally.
- **Primer Dialog — the "one component, two shapes" pattern.** This is the
  cleanest documented answer to the brief's exact question. A single
  `<Dialog>` takes a `position` prop that can be a plain value **or** a
  responsive object: `position={{narrow: 'bottom', regular: 'center'}}`.
  At narrow viewport widths the identical component renders as a bottom
  sheet; at regular width, a centered modal — no second component, no
  fork. Other documented values: `left`/`right` (side sheet) and
  `fullscreen`. Width tokens: small 296px / medium 320px / large 480px /
  xlarge 640px. Height tokens: small 296×480 / large 480×640 / auto
  (grows with content, then the **body** scrolls once max height is hit —
  header and footer stay fixed). `align` (`top`/`center`/`bottom`) offsets
  a centered dialog — `top` sits ~4rem down. `onClose(gesture)` reports
  *which* dismiss affordance fired — `'close-button'` or `'escape'` — so
  apps can special-case one (e.g. always confirm on Esc, never on the X).
  `footerButtons[].autoFocus` wires a specific footer button into the
  focus-trap's initial focus target.
- **Material 3 bottom sheets** — drag handle: **4×32dp pill**, centered,
  **22dp** from the top edge (its own hit target padded to the 48dp
  minimum). Top corner radius **28dp** (vs. **12dp** for a standard M3
  dialog), bottom corners flush with the screen edge. **Modal** bottom
  sheets carry a scrim (~32–40% opacity depending on token source), tapping
  it dismisses, and they trap focus like any modal. **Standard** (non-modal)
  bottom sheets have *no* scrim, do not trap focus, and Tab moves naturally
  between the sheet and the page behind it — a deliberately different
  contract from modal sheets, not a visual variant of the same thing.
- **Apple HIG Sheets** — swiping down to dismiss is the *expected default*
  gesture, not a nice-to-have; if the sheet holds unsaved changes, intercept
  that swipe with a confirming action sheet rather than silently discarding
  input. A **grabber** (small horizontal indicator, top edge) signals
  resizability, doubles as a tap-to-cycle control, and is exposed to
  VoiceOver so non-sighted users can resize without seeing the screen.
  Two system detents: **large** (fully expanded) and **medium** (~half
  height).

**Buildable guidance:** build one Dialog component with a
responsive-position prop (Primer's model), not a Modal component and a
separate BottomSheet component that inevitably drift apart. Wire Esc and a
close button both through a single `onClose(gesture)` callback so
unsaved-changes handling can be gesture-aware. Lock body scroll via the
overlay's own `overflow-y:auto`, not by hiding `<body>` overflow globally.
Give the sheet variant a grabber/drag handle sized to the touch-target
minimum, and treat swipe-to-dismiss as the mobile-native expectation,
intercepted only when there's something to lose.

**Most common mistake:** shipping two divergent implementations for
"desktop modal" and "mobile sheet" that duplicate focus-trap, Esc-handling,
and scroll-lock logic — every fix has to land twice, and one or the other
inevitably regresses first. Primer's own docs frame the responsive-`position`
prop specifically as the fix for this.

**Applied to Timekeeper:** the entry editor (currently likely a plain
desktop modal) is the direct candidate — centered dialog at desktop widths,
bottom sheet at ≤412px, one component, `onClose('escape')` vs.
`onClose('close-button')` both routed through the same "narrative has
unsaved text — confirm before closing" guard the app already needs.

---

## 4. Segmented control vs. tabs vs. filter chips

**Systems checked:** component.gallery (Tabs — full generic write-up, incl.
the W3C ARIA tablist markup); Primer (SegmentedControl — full API, incl. a
documented responsive-overflow prop); Apple HIG (Segmented controls, via
search); Material 3 (Chips, via search).

**Concrete numbers / rules:**

- **Tabs (W3C ARIA tablist pattern, as documented on component.gallery):**
  `role="tablist"` wraps `role="tab"` buttons, each `aria-controls` its
  `role="tabpanel"`; the active tab has `aria-selected="true"`. Keyboard
  model: **Tab** moves focus *into* the tablist and lands on the active
  tab (not the first); **←/→** (horizontal) or **↑/↓** (vertical) cycle
  *and activate* the neighboring tab automatically; only one panel is ever
  visible. component.gallery's own caveat: this automatic-activation model
  is a real accessibility pattern but not one every user expects — for a
  simpler interaction, consider an accordion instead. Responsive guidance:
  decide up front whether horizontal tabs will stack, scroll, or get
  replaced by an accordion at narrow widths — don't leave it undecided.
- **Segmented control (Primer):** ships an explicit `variant` prop that is
  independently configurable per width bucket —
  `{narrow: 'hideLabels'|'dropdown'|'default', regular: …, wide: …}` — so a
  control can show icon+label at desktop width, icon-only once space is
  tight, and collapse into a dropdown-style control once it's tighter
  still, all from one component. `fullWidth` is similarly responsive
  per-bucket.
- **Apple HIG segmented control:** **≤5 segments on iPhone** is the target;
  up to ~5–7 in a wide (iPad/Mac) layout. All segments render at **equal
  width**, so content length should stay consistent across segments — one
  long label breaks the whole row's legibility, not just its own segment.
- **Filter chips (Material 3):** **32dp** standard height / **24dp** small
  variant; corner radius 8dp (filter/input) or 16dp (assist/suggestion).
  Four chip types exist — assist, filter, input, suggestion — filter chips
  specifically are multi-select and toggle on/off, a genuinely different
  interaction model from both tabs and segmented controls. Even at a 32dp
  visual height, the touch target padding still needs to hit the 48dp
  (Material) / 44px (this app's floor) minimum — the hit area is bigger
  than the chip looks.

**Buildable guidance — the decision, not just the visuals:** these three
map to three different *semantics*, and picking the wrong one is a
correctness bug, not a style choice.
- **Tabs** = navigation between different content/views; only one is ever
  visible; each tab genuinely owns separate content.
- **Segmented control** = a control that changes how the *same* data is
  displayed (e.g., a view toggle) — Apple explicitly classifies this under
  "Controls," not navigation, and limits it to ~5 equal-width options.
- **Filter chips** = non-exclusive, additive refinement of a list (multiple
  can be active at once); the standard overflow answer is a horizontally
  scrollable single-line row, not wrapping, so the bar's height stays fixed.

**Most common mistake:** reaching for tabs when the real interaction is a
segmented control (an in-place view toggle over one dataset) — this breaks
every tab user's expectation that each tab is separately-owned content, and
it also breaks tab keyboard semantics (arrow-to-activate) being applied to
something that isn't really navigation.

**Applied to Timekeeper:** the top-level shell items (Day/Calendar/Stats/…)
are correctly tabs — separate pages, separate content. A "This Week / This
Month" toggle inside Stats, or a "Billable / All" toggle on an entry list,
is a segmented control, not a tab row, per Apple's own classification.
Matter/status filters on the CMS or Day list are filter chips: multi-select,
horizontally scrollable at 390–412px rather than wrapped.

---

## 5. Empty states

**Systems checked:** Primer (Blankslate — full anatomy + props); Polaris
(Empty state guidelines, via search — content-focused prose); Atlassian
(Empty state — listed component, content not scrapeable);
component.gallery (aliases across systems: "Non-ideal state" (Blueprint),
"Blankslate" (Primer/GitHub), "Empty prompt" (Elastic)).

**Structure (Primer Blankslate anatomy, the most completely documented):**
`Blankslate.Visual` (icon or illustration) → `Blankslate.Heading` → optional
`Blankslate.Description` → `Blankslate.PrimaryAction` (renders as a link if
given an `href`, else a button) → optional `Blankslate.SecondaryAction`.
Size variants `small`/`medium`/`large`; width variants `narrow`/`spacious`;
optional `border`. This is effectively the cross-system consensus shape —
visual, heading, one to two sentences, one strong verb-led action, optional
secondary "learn more"-class action.

**Tone (Polaris guidelines):** the heading states plainly what's missing;
the description is conversational body copy, not an error message, and
explains *what* is missing and *why* — Polaris's own phrasing: "describe or
explain what's in the empty state title," written with normal articles
("the," "a," "an") rather than clipped label-speak. The action button
always leads with a strong verb and is framed as the productive next step,
not a dead end.

**Buildable guidance:** every empty state needs a *route forward*, not just
an explanation. If there is truly no possible action (e.g., a permissions
wall), the heading and description should say so plainly rather than
showing a generic "nothing here" with a button that does nothing useful.

**Most common mistake:** an empty state with no action at all, or one whose
heading reads as an error ("No results found") instead of an invitation
("Try a different search" / "Create your first entry"). Both Primer and
Polaris structurally *require* a primary action slot precisely to prevent
builders from shipping a dead end.

**Applied to Timekeeper:** three concrete empty states exist today — Day
view with zero entries ("Nothing logged yet — start a timer" + Start-timer
action), Search with zero results ("No matches for '…' — try different
terms" + Clear-filters action), CMS with zero matters ("No matters yet" +
Add-matter action) — each needs its own heading/description pair, not a
single shared "No data" component.

---

## 6. Toast / snackbar

**Systems checked:** Material 3 (Snackbar, via search); Polaris (Toast, via
search); Atlassian (Flag — their name for toast, via search); Radix
Primitives (Toast — full API, the most rigorous of the group); Carbon
(Notification pattern — toast vs. inline, via search).

**Concrete numbers / rules:**

- **Material 3 Snackbar:** auto-dismisses after **4–10 seconds**
  (system-recommended range, not a fixed number). **Never stack** — only
  one snackbar is ever on screen; if a second is triggered while the first
  is showing, the first plays its exit motion before the second enters.
  One action maximum; if the action's label is long, it moves to its own
  line below the message (a "stacked" layout modifier) rather than
  squeezing onto the message's line.
- **Polaris Toast:** minimum **10,000ms** duration specifically when an
  action is present, called out as an accessibility requirement (enough
  time to read and act, not just read). Message content capped at roughly
  **3 words** as a style guideline; reserved for success/non-critical
  confirmations, "rarely" for errors. No separate cancel/dismiss action
  beside the message — the built-in **×** is the only dismiss control.
  Requires a single app-wide Frame-level host (one render slot, not one
  per screen).
- **Atlassian Flag:** auto-dismisses at **8 seconds**; anchored
  **bottom-left**, visually emerging from the nav sidebar edge rather than
  floating free — an anchored placement, not a centered toast.
- **Radix Toast (the primitive with the most complete accessibility
  contract):** default duration **5000ms**, but the auto-dismiss timer
  **pauses on hover, on focus, and on window blur** — three independent
  pause triggers, not just hover. A configurable hotkey (**F8** by
  default) moves keyboard focus into the toast viewport region; Radix's
  own docs put the burden on the implementer to make that hotkey
  discoverable. Swipe-to-dismiss ships with a **50px** swipe threshold and
  a default swipe direction of `right`. Toasts are typed `foreground`
  (user-just-did-something; announced to assistive tech *immediately*,
  and the docs explicitly warn against stacking more than one distinct
  foreground toast at a time) vs. `background` (system/passive; announced
  at the screen reader's next natural pause, queues safely without
  interrupting).
- **Carbon:** toast auto-dismisses at **~5s** by default with an optional
  close button; the sibling **inline notification** is Carbon's answer for
  anything the user must not miss if they look away — it never
  auto-times-out and stays until manually dismissed. The deciding question
  Carbon poses is exactly that: *if the user misses this, does it matter?*
  If yes → inline/persistent (§8, not this component). If no → toast.

**Buildable guidance:** cap visible toasts at one, queue the rest; pause
the auto-dismiss timer on hover *and* keyboard focus *and* window blur, not
just hover (Radix's three-trigger pause is the accessibility-complete
version, and its absence is what makes a toast-with-an-action effectively
unusable for anyone who isn't fast). On mobile, anchor above the bottom
nav bar / thumb zone / safe-area inset, never covering primary controls;
Atlassian's bottom-left anchor and Radix's swipe-to-dismiss are both
reasonable mobile answers to "how does this behave without covering
controls."

**Most common mistake:** letting toasts stack unbounded, and/or never
pausing the dismiss timer on hover or focus — both defeat the entire point
of an action-bearing toast the moment the user is slower than the timeout,
which describes most real usage, not just assistive-tech usage.

**Applied to Timekeeper:** "Entry saved" / "Timer started" confirmations
are `foreground`-type, single-line, capped at one visible with a small
internal queue, anchored bottom-and-above-the-mobile-nav-bar, paused on
hover/focus, ~5s default duration extended to Polaris's 10s floor whenever
the toast carries an action (e.g. an "Undo delete").

---

## 7. Keyboard shortcut overlay / help sheet

**Systems checked:** Primer (**KeybindingHint** — a dedicated, documented
component for exactly this); Slack (shortcuts modal, via search — grouped
categories); GitHub (`?` dialog, via search — page-scoped grouping). No
named enterprise design system (Material 3, Apple HIG, Carbon, Atlassian,
Polaris, Fluent, Base Web) documents a formal "shortcut overlay" component —
this pattern lives almost entirely in developer-tool design systems.

**Concrete rules (Primer KeybindingHint, the most rigorous source found):**

- Renders **platform-correct glyphs automatically** — the fake key name
  `Mod` resolves to **⌘** on macOS and **Ctrl** on Windows/Linux, so one
  binding definition produces the right glyph per OS instead of
  hardcoding "Ctrl" and being wrong on a Mac.
- **Chords** (keys pressed together) join with `+` (`Mod+S`); **sequences**
  (keys pressed one after another — exactly Timekeeper's own `g` then
  `d`/`c`/`s`/`e` pattern) separate with a space (`g i`).
- Two density **formats**: `condensed` (default — each key its own glyph
  chip, for menus/tooltips/dense rows) vs. `full` (keys joined with a
  literal `+`, for prose/longer copy).
- Two **sizes** (`small`/`normal`) and three **contrast variants**
  (`normal` for neutral surfaces, `onEmphasis` for banners/strong fills,
  `onPrimary` for use inside a primary button) so the same hint stays
  legible wherever it's placed — inline in a button's trailing visual, next
  to a notification line, or in a dedicated shortcuts list.
- The component ships without a defined mobile/touch fallback — because
  there isn't one to define; see below.
- **Slack's** shortcuts modal (triggered by `/shortcuts`) groups entries
  into named categories — Navigation, Unreads & threads, Messaging, Calls,
  Preferences & help — rather than one flat list. **GitHub's** `?` dialog
  is scoped to the *current page/context*, showing only shortcuts relevant
  there. Both converge on the same principle: group by task area, don't
  alphabetize a flat wall of bindings.

**Buildable guidance:** build the shortcut-hint chip as its own small
component (glyph-per-key, `Mod` abstraction, chord vs. sequence rendering)
so it can be reused both inline (trailing visual on a menu item or button)
and inside the dedicated `?` overlay, rather than writing shortcut strings
by hand in two places that inevitably disagree. Group the overlay by task
area, matching Slack/GitHub, not by inventing a new taxonomy.

**How systems handle "doesn't exist on touch":** the convergent answer
across every source checked is *omission*, not translation — there is no
touch-equivalent of a keyboard shortcut, so the `?` trigger, the shortcut
rows, and any inline `KeybindingHint` chips are simply not rendered on a
touch-only viewport. Nobody attempts a "tap sequence" analog.

**Most common mistake:** one long undifferentiated alphabetical list
instead of task-grouped sections, and/or hardcoding "Ctrl+" glyphs that are
wrong on macOS (or "⌘" that's wrong on Windows) instead of a platform-aware
abstraction like `Mod`.

**Applied to Timekeeper:** the existing `?` overlay should render its
groups exactly along the app's own boundaries — **Global** (`/` search,
`n` new entry, `?` help), **Navigation** (`g` then `d`/`c`/`s`/`e`),
**Timer grid** (arrow keys, `Enter`/`Space`, `Alt+↑`/`Alt+↓`), **Entry
editor** (`Ctrl+Enter` save, `Shift+Enter`, `Esc`) — each row using a
condensed-format glyph-chip component, and the whole overlay (trigger
included) omitted rather than reflowed on the mobile PWA layout.

---

## 8. Inline validation and warning messaging

**Systems checked:** Primer (**InlineMessage** — full API — and **Banner**,
its page-level sibling for contrast); Material 3 (text field error state,
via search); Carbon (Notification pattern — inline vs. toast distinction,
via search); Atlassian (Inline message — listed component, matches
Primer's naming and placement model).

**Concrete rules:**

- **Primer InlineMessage** — four tone variants, each with its own default
  leading icon so color is never the only signal: **critical** (errors,
  failed validation), **warning** (risky changes, connectivity concerns),
  **success** (confirmed completed actions), **unavailable** (content that
  failed to load, e.g. a missing table cell). Two sizes, `small`/`default`
  ("use default; drop to small only if default doesn't fit"). Explicitly
  positioned **close to the point of action** — "below an input field, next
  to a button, or within a table" — as opposed to Banner, which sits at
  page level, farther from the triggering control. A custom `leadingVisual`
  can replace the default variant icon, but the slot is never empty.
- **Material 3 text fields** — the error message **replaces** the
  helper/supporting-text slot while active (not appended below it), and the
  original helper text returns once the error clears — one slot, two
  states, not two slots stacked. Icons should pair with error text as a
  redundant channel specifically for colorblind users; any custom icon
  needs an accessible name (a content-description-equivalent) exposed to
  screen readers, since the icon itself carries meaning, not just
  decoration.
- **Carbon** — the same auto-dismiss-vs-persistent split as §6 governs
  which pattern to use: if the user must not miss this even after looking
  away, it's an **inline notification** (persistent until manually
  dismissed, optional close button); if it's a fleeting confirmation, it's
  a toast. Validation and warnings attached to a record are — by this
  test — almost always inline/persistent, not toasts.

**Buildable guidance:** one component, four severity variants, each
carrying its own icon + color pairing (never color alone), placed directly
adjacent to the field or row it describes rather than aggregated into a
page-level banner. Screen-reader behavior follows from the icon-plus-text
pairing already existing in the DOM — no extra `aria-label` needed on the
icon itself as long as the adjacent text carries the same meaning; if the
icon is the *only* carrier of meaning (e.g., icon-only compact rows), it
needs an explicit accessible name.

**Most common mistake:** signaling severity with color alone (a red
border, a red dot) — invisible to colorblind users and meaningless to a
screen reader. Every system here fixes this the same way: pair color with
a distinct icon per severity level, and make sure that icon's meaning is
exposed as text somewhere in the DOM, not left as CSS-only decoration.

**Applied to Timekeeper:** narrative/task-line validation ("missing
narrative," "hours exceed 24 in a day," "overlapping timer entries") should
render as InlineMessage-style rows directly under the offending field —
critical severity for hard blockers (can't finalize the day), warning for
soft flags (unusually long entry) — never a bare red outline.

---

## 9. Command palette / quick-entry palette

**Systems checked:** none of the brief's nine reference systems (Material
3, Apple HIG, Polaris, Atlassian, Carbon, Primer's written guidelines,
Radix's written guidelines, Base Web, Fluent 2) formally document a command
palette as a named component with usage guidance — this is the one pattern
in this brief that sits outside the "mature enterprise design system" world
entirely. What was checked instead: **cmdk** (the library that is the de
facto standard here — it's what powers shadcn/ui's `Command` component and
is used natively by Linear, Vercel, Raycast, and Sourcegraph), the
underlying **ARIA combobox** pattern it implements, and shadcn's own
`Command`/`CommandDialog` docs for concrete anatomy.

**Worth stating plainly:** this is a convention that migrated from
developer tools (Sublime Text → VS Code → Slack → Linear → Raycast → GitHub)
into a shared open-source primitive, not a pattern any of the enterprise
systems in this brief have written guidelines for. Treat the numbers below
as *practice*, not *spec* — there is real variance across implementations
in a way there isn't for, say, a Material dialog.

**Sizing/anatomy conventions actually in use:**

- Wrapped in a modal dialog shell — same overlay + focus-trap conventions
  as §3's Dialog, not a separate primitive. It can adopt the same
  responsive-position trick from Primer's Dialog (§3) if a mobile version
  is wanted, though most implementations simply don't offer one (see
  below).
- Fixed, capped width (shadcn's own default utility class is a small
  max-width, on the order of a few hundred px, scaling with content) and a
  capped, internally-scrolling height — never edge-to-edge, even on a wide
  desktop viewport.
- Anatomy, top to bottom: a persistent search **Input** pinned at the top
  → a scrollable, **grouped** result list (`CommandGroup` sections,
  separated by `CommandSeparator`) → an explicit **empty-state** row
  (`CommandEmpty`) when nothing matches → each result row optionally
  carries a trailing keyboard-shortcut hint (the same glyph-chip pattern as
  §7's KeybindingHint).

**Keyboard model:** this is the **ARIA combobox** pattern, not a plain
list. A single text input keeps real DOM focus at all times; arrow keys
move a **virtual pointer** (`aria-activedescendant`) over the listbox
rather than moving actual focus off the input; Enter activates whatever the
pointer is currently on; Esc closes and returns focus to the trigger — the
same Esc/return-focus contract as §3's Dialog.

**Mobile behavior:** there is no established touch-first equivalent.
Common resolutions are either (a) omit the ⌘K entry point on touch
entirely and rely on ordinary in-page search/navigation for the same
underlying actions, or (b) render the same component as a full-screen
sheet, keyboard shown for typing, with no keyboard-only affordances (arrow
navigation still works via on-screen taps on rows) exposed or required.

**Most common mistake:** implementing "arrow key navigation" by moving
real DOM focus between result `<li>` elements instead of using the
`aria-activedescendant` virtual-pointer pattern — this breaks the input's
ability to keep receiving keystrokes while the user is still typing to
filter, which is the entire point of the component. This is the single
most common command-palette accessibility bug in the wild.

**Applied to Timekeeper:** the existing `/` shortcut is the natural
trigger. Results should group by type (Matters, Recent entries, Actions),
each carrying a trailing KeybindingHint-style chip for direct-action rows.
Per the brief's own framing that keyboard shortcuts are "a desktop
enhancement layered on top, never the only path," the palette itself can
reasonably stay desktop-only, provided every action it exposes is also
reachable through ordinary touch navigation elsewhere in the app.

---

## 10. Progress / target meter (hours vs. daily target, two categories)

**Systems checked:** Primer (**ProgressBar** — full API including a
documented multi-segment pattern, the most directly applicable source
found); Material 3 (Progress indicators — specs + motion tokens, via
search); Apple HIG (Progress indicators, via search).

**Concrete rules:**

- **Primer ProgressBar — multi-segment API, built for exactly this shape
  of problem.** A single bar takes one overall `aria-label` (e.g. "4 of 12
  tasks completed"). Default guidance: pair the bar with an **explicitly
  visible text value** ("4 of 12") — only omit visible text when the
  progress is intentionally vague. For a value that's styled separately
  from its unit label, keep them in **one** visually-hidden span for
  screen readers (e.g. "4 of 12 tasks completed" as one string) rather than
  splitting the number and the label into two separate hidden nodes, which
  a screen reader would read out of order or without context. The
  **multi-segment** variant is composed of `ProgressBar.Item` children,
  each with its own `progress` percentage, its own `aria-label` (e.g.
  "30%"), and its own color. Explicit guidance: use easily-distinguishable
  colors *and* include a **visible legend** — color alone is not
  sufficient — and avoid too many segments, especially on a narrow bar;
  past a handful, switch to a different chart type entirely.
- **Material 3 progress indicators:** rounded track and rounded indicator
  ends (a corner-radius token, not square-cut), with a small visual **gap**
  between the filled (active) segment and the remaining (inactive) track,
  plus a **stop indicator** dot marking 100% in the current spec revision.
  Motion uses the "emphasized" easing token (`cubic-bezier(0.2, 0, 0, 1)`
  family) for indicator fill changes, kept to a short duration (a few
  hundred ms) so the bar reads as live rather than laggy — and, per the
  brief's reduced-motion requirement, this fill transition is exactly the
  kind of easing/duration pair that needs a static (instant, no easing)
  fallback under `prefers-reduced-motion`.
- **Apple HIG:** always prefer **determinate** over indeterminate when the
  total is knowable (it is here — a daily hour target is a known number).
  Be numerically accurate rather than optimistic, and even out the pace of
  advancement so the fill doesn't jump in ways that undermine the user's
  confidence in the number.

**Buildable guidance:** this maps almost exactly onto Primer's
`ProgressBar` + `ProgressBar.Item` shape — one container with an overall
aria-label summarizing progress-vs-target, two child segments each with
their own color, percentage, and aria-label, plus a **visible legend**
(not just color) distinguishing the two categories. Keep the fill
transition short and eased, with an instant/no-animation fallback under
reduced motion.

**Most common mistake:** two segment colors that read the same to
colorblind users (or are too close in lightness to separate at a glance)
with no text legend to disambiguate — Primer's own guidance calls this out
directly as the segmented-bar failure mode. The second most common bug is
a single combined aria-label covering both segments, so a screen reader
user gets one number and can't tell which category it belongs to.

**Applied to Timekeeper:** billable vs. non-billable hours against a daily
target is precisely Primer's two-segment case — segment 1 (billable) and
segment 2 (non-billable/other) in distinct, colorblind-safe colors, a small
inline legend ("6.2h billable · 1.0h other"), a per-segment aria-label, and
a container-level aria-label summarizing the whole ("7.2 of 8 hours
logged"). Fill-in animation uses the app's existing motion tokens, with a
static fallback under `prefers-reduced-motion` per the brief's own
requirement.
