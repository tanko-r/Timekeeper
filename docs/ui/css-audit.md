# CSS audit — pre-overhaul inventory

Source: `public/css/app.css` (995 lines, single file today) and every file
under `public/js/`. Line numbers below are **current line numbers in
`public/css/app.css` before any split** — re-verify after the mechanical
move, since they will shift.

One exemption up front: **`public/js/lib/pip.js`** (the Document
Picture-in-Picture always-on-top window) ships its own hand-copied inline
`<style>` block (`PIP_CSS`, ~line 120–270 of that file) because a PiP window
does not inherit the document's stylesheets. Its class names (`.rows`,
`.closeout`, `.find-panel`, `.empty`, `.err`, `.foot`, `.total`,
`.foot-btns`, `.quick`, `.find-btn`, `.dot`, `.clock`, `.name`, `.pin`,
`.act`, `.on`, `.show`, `.running`, `.start`, `.stop`) are **not** in
`app.css` and are out of scope for this split — do not go looking for them
in any of the eight modules.

---

## 1. Selector inventory → target module

Read top‑to‑bottom against `app.css`. Every rule in the file appears exactly
once below. Where a rule's home is genuinely arguable (used by more than one
feature area) it's marked **[shared]** with the other consumers named — pick
the listed owner unless you have a reason to prefer another, and if you move
it, update this doc.

### tokens.css

| Lines | Content |
|---|---|
| 5–27 | `:root { … }` — all 20 custom properties (`--surface-0/1/2`, `--border`, `--text-primary/secondary/muted`, `--accent`, `--accent-strong`, `--accent-soft`, `--billable`, `--nonbillable`, `--nonbillable-soft`, `--status-good/warning/serious/critical`, `--danger`, `--shadow`, `--radius`, `--sidebar-w`) |
| 29–46 | `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { … } }` — dark redefinitions |
| 47–62 | `:root[data-theme="dark"] { … }` — dark redefinitions (explicit toggle) |
| 67–98 | 4× `@font-face` (InterVariable normal/italic, ClockFace regular/bold) |

Judgment call: `@font-face` isn't literally a color/spacing token, but it's
a raw design-system resource with nothing else to consume it as a `var()`,
so it belongs beside the tokens rather than in `base.css`. Note there is
**no `--font-sans` / `--font-mono` / type-scale token** yet — `body` (line
103) and `.summary-text` (line 691) hardcode the font stacks directly. See
§3.

### base.css

Reset, generic typography, and every reusable primitive that isn't owned by
one feature area (buttons, inputs, cards, chips, tables, form fields, the
icon wrapper, validation list). This is the catch‑all the brief's module
list implies (there's no separate "components.css").

| Lines | Selectors |
|---|---|
| 100–101 | `*`, `html, body` |
| 102–109 | `body` |
| 110–111 | `h1, h2, h3, h4`, `h1`, `h2`, `h3` |
| 112–113 | `a`, `a:hover` |
| 153–164 | `.card`, `.card + .card`, `.card h2`, `.grid`, `.row`, `.row-end`, `.muted`, `.small`, `.mono` |
| 167–184 | `.btn`, `.btn:hover`, `.btn:disabled`, `.btn-primary`, `.btn-primary:hover`, `.btn-danger`, `.btn-ghost`, `.btn-ghost:hover`, `.btn-sm`, `.btn-lg`, `.btn-split`, `.btn-split .btn:first-child`, `.btn-split .btn:last-child` |
| 186–200 | `input[type=…], select, textarea` (shared rule), `input:focus, select:focus, textarea:focus, .btn:focus-visible`, `textarea`, `textarea[readonly]`, `.field`, `.field-label`, `.field-hint`, `input.input-narrow` |
| 203–227 | `.badge`, `.badge-billable`, `.badge-nonbillable`, `.chip`, `.chip-finalized`, `.chip-exported`, `.chip-reverted`, `.chip-running`, `@keyframes tk-running-pulse` — **note: `.chip-draft` is used in JS but has no rule anywhere; add it here (see §7).** |
| 230–238 | `.table-wrap`, `table.tk`, `table.tk th`, `table.tk td`, `table.tk tr:hover td`, `table.tk tr.clickable` |
| 251 | `.icon` — set by every `Icon()` call in `icons.js`; universal, not timer-specific despite living in the file's "timers" comment block |
| 652–667 | `.cmpicker`, `.cmpicker-menu`, `.cmpicker-item`, `.cmpicker-item.hover/:hover`, `.cmpicker-item .num`, `.cmpicker-item .client`, `.cmpicker-item .name`, `.cmpicker-section` — **[shared]** consumed by `entryeditor.js`, `cms.js`, `search.js`, `timergrid.js`. It's a reusable client/matter combobox, not editor-only; treating it as a base form control avoids `entries.css`/`editor.css`/`timers.css` all needing to reach into each other |
| 739–740, 744 | `.spinner`, `@keyframes spin` |
| 745–748 | `.error-box` |
| 749–757 | `.kbd-help table`, `.kbd-help td` → **actually overlays.css**, see that section; bare `kbd` element selector (751–757) stays here — it's used inline in prose/buttons app-wide (`todayfooter.js`, `stopchips.js`, the shortcuts modal) |
| 766–767 | `.section-title`, `.section-title h2` — **[shared]** used by `timergrid.js`, `dashboard.js`, `calendar.js`, `settings.js` |
| 778–779 | `.checkbox-row`, `.checkbox-row input` |
| 780–781 | `.banned-chip`, `.banned-chip button` — only `settings.js` uses it today, but it's the same "removable chip" shape as the rest of the chip family; keep with them |
| 559–566 | `.validation-list`, `.validation-item`, `.validation-item.level-block`, `.validation-item.level-warn`, `.validation-list.compact .validation-item` — **[shared]** shared `ValidationList` component in `ui.js`, consumed by `entrylist.js`, `closeout.js`, `entryeditor.js` — **note: `.validation-icon` (the span wrapping ⛔/⚠️ in `ui.js`) has no rule; low severity, currently inherits fine, list in §7** |

### shell.css

App shell, sidebar, mobile nav, page header — matches the brief's own
description verbatim.

| Lines | Selectors |
|---|---|
| 116–150 | `.shell`, `.sidebar`, `.sidebar .brand`, `.sidebar .brand span`, `.navlink`, `.navlink:hover`, `.navlink.active`, `.navlink.armed`, `.navlink.armed:hover`, `.navlink.agent-live`, `.navlink.agent-live svg`, `@keyframes agent-pulse`, `@media (prefers-reduced-motion: reduce) { .navlink.agent-live svg }`, `.navlink:disabled`, `.sidebar .foot`, `.main`, `.page-head`, `.page-head h1`, `.page-head .spacer` |
| 783–794 | `@media (max-width: 760px)` shell block: `.shell`, `.sidebar`, `.sidebar .brand`, `.sidebar .foot`, `.main`, `.task-line` (⚠ cross-owns into editor.css, see §6), `.subnav`, `.timer-search-wrap`, `.timer-search` (⚠ cross-owns into timers.css) |
| 975–988 | `.subnav`, `.subnavlink`, `.subnavlink:hover`, `.subnavlink.active` — the Settings sub-nav that expands under the sidebar's Settings link; it's sidebar/nav chrome, not a settings-page concern |

### timers.css

Everything under the file's own "timers (compact, grouped)" comment (lines
250–425), plus the timer-tab and context-menu-adjacent pieces that only
`timergrid.js` uses, plus the CSV import feature (launched from the timer
grid).

| Lines | Selectors |
|---|---|
| 252–259 | `.timer-grid`, `.timer-grid > *`, `.timer-section` |
| 260–263 | `.group-head`, `.group-name` |
| 270–296 | `.timer-tabs`, `.timer-tab-wrap`, `.timer-tab-wrap:hover`, `.timer-tab-wrap.on`, `.timer-tab`, `.timer-tab:hover`, `.timer-tab.on`, `.timer-tab-count`, `.timer-tab-wrap.activity-start`, `.timer-tab-wrap.activity-end`, `.tab-tools` — **note: `.timer-tab-label` (the `<span>` around a tab's text) is used in `timergrid.js` with no dedicated rule; low severity, see §7** |
| 297–303 | `.seg`, `.seg button`, `.seg button + button`, `.seg button.on` — **[shared]** also used verbatim by `calendar.js` and `day.js` mode switches |
| 304–423 | `.timer-card` through `.timer-new:hover` — the entire timer-card anatomy: `.timer-card`, `.timer-card:active`, `.timer-card.editing`, `.timer-card.dragging`, `.timer-card.selected`, `.timer-selbar`, `.timer-selbar > .btn`, `.timer-drop-slot`, `@keyframes drop-slot-open`, reduced-motion override, `.timer-card.running`, `.timer-name`, `.timer-name:hover`, `.name-input`, `.timer-card.unassigned`, `.timer-card.unassigned .timer-name`, `.timer-flag`, `.idle-nudge`, `.timer-flag.pinned`, `.entry-timer-btn`, `.entry-timer-btn.running` (used by `entrylist.js`, not `timergrid.js` — **[shared]**, kept here because it's part of the transport-button vocabulary), `.timer-clock-pair`, `.timer-clock-raw`, `.timer-clock`, `.timer-clock:hover`, `.timer-card.running .timer-clock`, `.timer-card.running .timer-clock-raw`, `.timer-card:focus-visible`, `.timer-board:focus`, `.timer-card.worked`, `.timer-start-btn`, `.timer-stop-btn`, `.timer-stop-btn:hover`, `.timer-search-wrap`, `.timer-search`, `.clock-input`, `.timer-more`, `.timer-card:hover .timer-more`, `.timer-new`, `.timer-new:hover` |
| 857–873 | `.import-map`, `.import-summary`, `.import-summary strong` (⚠ hardcoded `var(--text)` bug, see §3), `tr.import-skip td`, `.import-new`, `@media (max-width: 640px) { .import-map }` — rendered inside a shared `<Modal>` from `ui.js`, but the content is CSV-timer-import-specific; keep with timers rather than overlays |

### entries.css

The entry list/day view cards (`entrylist.js`), the day/week grouping
chrome, the target meter's consumers in the day view, and the alerts
banner.

| Lines | Selectors |
|---|---|
| 533–556 | `.entry-day-head`, `div:first-child > .entry-day-head`, `.entry-week-divider`, `.entry-card`, `.entry-card + .entry-card`, `.entry-card .body`, `.entry-card .narrative`, `.entry-card .narrative-editable`, `.entry-card .narrative-editable:hover`, `.entry-card .narrative-inline-input`, `.entry-card .hours`, `.entry-card .hours.active`, `.entry-card.nonbillable .hours`, `.entry-card.billable .hours`, `.entry-meta`, `.entry-actions` |
| 568–579 | `.alert-banner`, `.alert-banner .row`, `.alert-pill`, `.alert-pill:hover` — only `dashboard.js` |
| 219 | `.row-blocked td` — actually export-view only, see views.css (kept out of this group deliberately) |

### editor.css

Everything the entry editor (`entryeditor.js`) alone renders, plus
task-line/task-code, plus the AI/auto-narrative chrome that `closeout.js`
also reuses.

| Lines | Selectors |
|---|---|
| 446–453 | `.alloc-chip`, `.alloc-chip.over`, `input.total-input` |
| 455–469 | `.task-code-cell`, `.task-code-chip`, `.task-code-chip button`, `.task-code-chip button:hover`, `.task-code-add`, `.task-code-add:hover:not(:disabled)`, `.task-code-cell select` |
| 471–486 | `.auto-toggle-chip`, `.auto-toggle-chip.on`, `.auto-toggle-chip:disabled`, `.editor-suggest-chips`, `.editor-suggest-chips button`, `.editor-suggest-chips button:hover`, `.cm-client-label` |
| 488–510 | `.entry-head-grid`, `.entry-head-grid .checkbox-row`, `@media (max-width: 760px)` reflow block for the same |
| 645–650 | `.task-lines`, `.task-line`, `.task-line .reorder`, `.task-line .reorder button`, `.task-line .reorder button:hover` — **note:** this selector is scoped to `.task-line .reorder`; the visually-identical `▲`/`▼` reorder stacks in `customfields.js` and `settings.js` use a bare `class="reorder"` that this rule does **not** match — those two currently work only because they duplicate the layout via an inline `style={{display:'flex',flexDirection:'column'}}`. See §7 — decide whether to generalize this rule or leave the duplication. |
| 759–763 | `.narrative-preview`, `.auto-badge` — **[shared]** also used by `closeout.js`'s narrative-preview step |
| 758 | `.saving-dot` |
| 990–995 | `.custom-fields-row` — grid for custom client/matter fields inside the editor header |

### views.css

Page-specific styling for dashboard, calendar, CMS, search, stats,
settings, export, and login — anything rendered by exactly one (or two
closely related) `views/*.js` files and not already claimed above.

| Lines | Selectors |
|---|---|
| 219 | `.row-blocked td` — export-view table only |
| 239–248 | `table.tk tr.client-row td`, `.client-name-cell`, `.client-name-add`, `.client-name-add:hover` — `cms.js` only |
| 226–227 | `.star`, `.star.on` — `cms.js` favorite toggle only |
| 512–528 | `.meter`, `.meter-bar`, `.meter-fill`, `.meter-fill.billable`, `.meter-fill.nonbillable`, `.meter-target`, `.meter-legend`, `.dot`, `.dot-billable`, `.dot-nonbillable` — **[shared]**: owned by `components/targetmeter.js` (used from `dashboard.js`) *and* hand-duplicated directly in `calendar.js`'s legend (same class names, no shared component). Flag for a future dedupe; for the split, one copy of the CSS serves both. |
| 581–627 | Everything calendar: `.cal-grid`, `.cal-dow`, `.cal-total-head`, `.cal-week-total`, `.cal-wt-b`, `.cal-wt-nb`, `.cal-period-total`, `.cal-day`, `.cal-day:hover`, `.cal-day.other-month`, `.cal-day.weekend`, `.cal-day.today`, `.cal-day.selected`, `.cal-num`, `.cal-hours`, `.cal-split`, `.cal-split .b`, `.cal-split .nb`, `.cal-status`, `.cal-status.good/.warning/.serious`, `.week-strip`, `.week-col`, `.week-col .col-head`, `.week-entry`, `.week-entry:hover`, `.week-col.selected`, `.week-day-btn`, `.week-day-btn:hover`, `.cal-selected-panel` |
| 629–643 | Everything stats: `.bar-row`, `.bar-label`, `.bar-track`, `.bar-fill`, `.bar-value`, `.stat-tiles`, `.stat-tile`, `.stat-tile .v`, `.stat-tile .k`, `.spark`, `.spark .col`, `.spark .col .fill`, `.spark-labels`, `.spark-labels span` |
| 733–736 | `.login-wrap`, `.login-card`, `.login-card .brand`, `.login-card .brand span` — used by both `login.js` and the pre-auth branch inlined in `app.js`. Debatable vs. shell.css (it *replaces* the shell); going with views.css since it's a page, not chrome — flag if the shell owner disagrees. |
| 771–777 | `.panel`, `.panel > .section-title:first-child`, `.panel .timer-card, .panel .entry-card` — only `dashboard.js` and `calendar.js` |
| 955–973 | `.setting-rows`, `.setting-row`, `.setting-row:first-child`, `.setting-row:last-child`, `.setting-label`, `.setting-label .field-hint`, `.setting-row > select, .setting-row > input:not([type="checkbox"])`, `@media (max-width: 700px) { .setting-row }` |
| 876–903 | Today footer: `.today-footer`, `.tf-total`, `.tf-meter`, `.tf-meter-fill`, `.tf-running`, plus the `@media (max-width: 760px)` block that hides `.tf-meter`/`.tf-btn-label`/`.muted` and truncates the running-timer name. **Debatable**: only `dashboard.js` uses `TodayFooter`, but it is a persistent, viewport-pinned bar with its own mobile behavior — a reasonable future home is `shell.css` if it grows into a global bottom bar. Filing under views.css for now because the component itself is dashboard-scoped. |

### overlays.css

Anything that floats above the page: modal, toast, context menu, closeout
flow, quick capture, stop chips, narrative-history picker, the keyboard
shortcuts help modal, and the Alt+drag feedback-capture UI.

| Lines | Selectors |
|---|---|
| 428–444 | `.ctx-menu`, `.ctx-item`, `.ctx-item:hover:not(:disabled)`, `.ctx-item:disabled`, `.ctx-item.danger`, `.ctx-hr`, `.ctx-inline`, `.ctx-inline select`, `.ctx-spacer` — **note: `.ctx-custom` (wraps a caller-supplied menu row) has no rule; see §7** |
| 360–369 | `.feedback-select`, `.feedback-shot` — **note: `.feedback-note` (the textarea) is used only as a JS `querySelector` hook; it inherits generic `textarea` styling from base.css and needs no rule of its own** |
| 670–695 | `.modal-backdrop`, `.modal`, `.modal-wide`, `.modal-head`, `.modal-body`, `.confirm-message`, `.summary-text`, `.summary-text:focus-visible` |
| 697–721 | `.narrative-history`, `.narrative-history-row`, `.narrative-history-row:hover`, `.narrative-history-row.picked`, `.narrative-history-row input[type="checkbox"]`, `.narrative-history-body`, `.narrative-history-meta`, `.narrative-history-body .narrative`, `.narrative-history-preview`, `.narrative-history-preview .narrative` |
| 723–730 | `.toast-host`, `.toast`, `.toast button`, `.toast.error` |
| 749–750 | `.kbd-help table`, `.kbd-help td` (the shortcuts-help modal only; bare `kbd` itself lives in base.css, see above) |
| 806–809 | `.ghost-wrap`, `.ghost-mirror`, `.ghost-wrap.multiline .ghost-mirror`, `.ghost-typed`, `.ghost-hint` — **debatable**: this is the ghost-text autocomplete overlay layered on top of an `<input>`/`<textarea>`, used by `ghosttext.js` from `entrylist.js`, `closeout.js`, `entryeditor.js`. It's positioned like an overlay (`position:absolute; inset:0`) but conceptually is a form-control enhancement. Filing under overlays.css because of the positioning model; base.css is the alternate home if the split prefers "it's a form control." |
| 806, 809 | `.shortcut-save`, `.shortcut-save input` |
| 811–831 | `.stop-chips`, `.stop-chips-head`, `.stop-chips-list`, `.chip-btn`, `.chip-btn:hover`, `.chip-btn kbd`, `.stop-chips-warn`, `.stop-chips-foot` |
| 833–855 | `.qc-backdrop`, `.qc-card`, `.qc-row`, `.qc-row input`, `.qc-preview`, `.qc-chips`, `.qc-chip`, `button.qc-chip`, `button.qc-chip.on`, `.qc-chip.miss`, `.qc-narrative`, `.qc-foot` |
| 905–929 | `.closeout-backdrop`, `.closeout-card`, `.closeout-dots`, `.closeout-dot`, `.closeout-dot.on`, `.closeout-head`, `.closeout-head strong`, `.closeout-hours`, `.closeout-card textarea`, `.closeout-keys`, `.closeout-warn-title`, `.closeout-warnlist`, `.closeout-warnitem`, `.closeout-warnitem .validation-list`, `.closeout-warnitem .btn` |
| 931–953 | The whole `@media (prefers-reduced-motion: no-preference)` motion block: `.timer-card.just-started`, `@keyframes tk-start`, `.stop-chips, .qc-card, .closeout-card` (settle-in), `@keyframes tk-settle`, `.chip-finalized.just-finalized`, `@keyframes tk-lock`, `.closeout-card.closeout-closed`, `.tf-total.bump` (⚠ this last one is a `views.css`/today-footer selector living inside an otherwise-overlays block — split it out with the animation or leave the block whole and accept one cross-module rule; recommend leaving whole, it's one keyframe reused in three places) |

**Recommendation on the motion block (931–953):** don't split this by
selector. It's a single deliberately-curated "confirms, never decorates"
motion language (see comment at line 931) spanning timers, overlays, and
the today-footer. Splitting the keyframes from their triggers across three
files risks losing that a single motion vocabulary exists. Either keep the
whole block in overlays.css (its biggest constituency) with a comment
pointing at the other two consumers, or promote it to tokens.css as
`--duration-*`/`@keyframes` shared primitives. Flagging for a decision
rather than assigning unilaterally.

---

## 2. JS file → CSS module map

| JS file | CSS module(s) it depends on |
|---|---|
| `app.js` | shell.css (shell, sidebar, navlink, subnav, page-head), overlays.css (kbd-help modal), base.css (btn, card), views.css (login fallback branch) |
| `ui.js` (shared components: `Modal`, `ContextMenu`, `ConfirmDialog`, `Field`, `ValidationList`, `Spinner`, `ErrorBox`, `BillableBadge`, `Icon` re-export) | base.css (spinner, error-box, badge, chip-draft helper, field, validation-list), overlays.css (modal, ctx-menu) |
| `icons.js` | base.css (`.icon`) |
| `components/closeout.js` | overlays.css (closeout-*), editor.css (narrative-preview, auto-badge — shared), base.css (validation-list, btn) |
| `components/cmpicker.js` | base.css (cmpicker-*, checkbox-row, error-box) |
| `components/customfields.js` | base.css (row, checkbox-row, btn) — note the bare `.reorder` gap, §7 |
| `components/entryeditor.js` | editor.css (entry-head-grid, task-lines, task-code, auto-toggle-chip, editor-suggest-chips, custom-fields-row, saving-dot, narrative-preview), base.css (cmpicker via CMPicker, validation-list, table, btn) |
| `components/entrylist.js` | entries.css (entry-card family), timers.css (entry-timer-btn, chip-running), base.css (chip, badge, validation-list) |
| `components/feedback.js` | overlays.css (feedback-select, feedback-shot) |
| `components/ghosttext.js` | overlays.css (ghost-wrap/mirror — see debatable note above) |
| `components/narrativehistory.js` | overlays.css (narrative-history-*), base.css (chip, chip-draft, error-box) |
| `components/quickcapture.js` | overlays.css (qc-*) |
| `components/runtodo.js` | shell.css (navlink.armed/agent-live) |
| `components/shortcuts.js` | overlays.css (shortcut-save) |
| `components/stopchips.js` | overlays.css (stop-chips-*, chip-btn) |
| `components/summary.js` | overlays.css (summary-text, modal row-end) |
| `components/targetmeter.js` | views.css (meter-*, dot-*) |
| `components/timergrid.js` | timers.css (all timer-card/tab/grid/import selectors), overlays.css (ctx-menu, via `ui.js`'s ContextMenu), base.css (section-title, seg, btn) |
| `components/timerimport.js` | timers.css (import-*), overlays.css (Modal wrapper) |
| `components/todayfooter.js` | views.css (today-footer, tf-*) — see debatable shell.css note |
| `lib/pip.js` | **none — self-contained, see exemption above** |
| `lib/*` (activity, daterange, daysummary, expand, ghost, narrativejoin, narrativesync, notify, tick, timeamounts, timersort, titlebar) | none — pure logic, no DOM class usage |
| `spike-ollama-status.js` | not audited — appears to be an experimental/dev-only file; grep shows no `class=` usage but confirm before assuming zero CSS dependency |
| `views/calendar.js` | views.css (cal-*, week-*, panel, meter-legend duplication), timers.css (seg), base.css (btn, page-head via shell — actually page-head is shell.css) |
| `views/cms.js` | views.css (client-name-*, star, table client-row), base.css (cmpicker via CMPicker, table, checkbox-row) |
| `views/dashboard.js` | views.css (panel, alert-banner via entries.css — see below, today-footer via component), entries.css (alert-banner), base.css (card, section-title) |
| `views/day.js` | shell.css (page-head), timers.css (seg), base.css (btn) |
| `views/exportview.js` | views.css (row-blocked), base.css (chip, chip-draft, table, checkbox-row) |
| `views/login.js` | views.css (login-*) |
| `views/search.js` | base.css (table, cmpicker via CMPicker), views.css (none unique — mostly base) |
| `views/settings.js` | views.css (setting-rows/row/label), base.css (banned-chip, checkbox-row, chip) — plus the bare `.reorder` gap, §7 |
| `views/stats.js` | views.css (bar-*, stat-tile, spark) |

---

## 3. Hardcoded values outside the token block (lines 1–98)

Per the brief: *"If you find a hardcoded color, font size, or spacing value
outside `tokens.css`, that is a defect."* By that standard nearly the whole
file is currently a defect — colors are the only category that's mostly
tokenized today; font size, spacing, radius, shadow, and duration have **no
tokens at all** yet (`--radius` is the sole exception, and even it's used on
only 4 of the file's ~55 `border-radius` declarations).

### 3a. Colors used raw (not `var(--…)`)

| Line | Value | Context |
|---|---|---|
| 137 | `#fff` | `.navlink.armed { color: #fff; }` |
| 137 | `rgba(0,0,0,.15)` (line 138) | `.navlink.armed` inset shadow |
| 174 | `#fff` | `.btn-primary { color: #fff; }` |
| 176 | `#fff` | `.btn-danger { color: #fff; }` |
| 282 | `rgba(0, 0, 0, 0.07)` | `.timer-tab-wrap.on` box-shadow (mixed with `var(--accent)`) |
| 363 | `#e11d48`, `rgba(225, 29, 72, 0.08)` | `.feedback-select` — a **third, untokenized red**, distinct from both `--danger`/`--status-critical` (`#d03b3b`). Same "attention" concept, three different reds in the codebase (`--danger`, `--status-critical` happen to share one value; this is a separate one). Candidate to either reuse `--danger` or add a dedicated `--feedback-accent` token. |
| 671 | `rgba(0,0,0,.45)` | `.modal-backdrop` scrim |
| 730 | `#fff` | `.toast.error { color: #fff; }` |
| 835 | `rgba(0,0,0,.25)` | `.qc-backdrop` scrim |
| 907 | `rgba(0,0,0,.3)` | `.closeout-backdrop` scrim |

The four `#fff`/`color:#fff` cases are white text on a saturated
background (accent/danger buttons, error toast) — plausibly fine to stay
white in both themes, but should still become a token (e.g.
`--text-on-accent`) rather than a bare literal, per the brief's "only
tokens.css defines raw values" rule.

The three backdrop scrims use **three different opacities** (`.45`, `.25`,
`.3`) for what is conceptually one pattern ("dim what's behind the
overlay"). Worth a single `--scrim` token rather than three independent
numbers with no documented reasoning for the difference.

### 3b. A genuinely broken color reference

**Line 865: `.import-summary strong { color: var(--text); }`** — `--text`
is **not defined anywhere**. The only related token is `--text-primary`.
This isn't a hardcoded-value defect, it's an invalid custom property
reference; today it silently falls back to the inherited color (so it's not
visibly broken, just wrong/undefined). Fix while tokenizing: change to
`var(--text-primary)`.

### 3c. Font sizes (no type-scale token exists)

**83** `font-size` declarations outside the token block, across **16**
distinct pixel values with no scale relationship between them:

| Value | Count | Lines |
|---|---|---|
| 10px | 3 | 611, 642, 649 |
| 10.5px | 2 | 667, 761 |
| 11px | 1 | 474 |
| 11.5px | 4 | 205, 211, 583, 618 |
| 12px | 14 | 146, 199, 233, 299, 448, 460, 466, 469, 566, 617, 638, 663, 753, 758 |
| 12.5px | 20 | 163, 179, 198, 240, 246, 286, 384, 388, 413, 482, 525, 555, 576, 593, 606, 661, 715, 809, 829, 849 |
| 13px | 11 | 263, 342, 350, 443, 535, 562, 692, 780, 823, 967, 985 |
| 13.5px | 3 | 435, 630, 854 |
| 14px | 9 | 130, 170, 231, 416, 423, 726, 729, 747, 778 |
| 15px | 5 | 111 (h3), 180, 592, 844, 923 |
| 16px | 4 | 226, 607, 897, 919 |
| 17px | 1 | 124 |
| 18px | 2 | 111 (h2), 551 |
| 20px | 1 | 920 |
| 22px | 2 | 111 (h1), 735 |
| 24px | 1 | 637 |

This is the single biggest tokenization job in the file — recommend
defining a `--text-xs/sm/md/base/lg/xl/…` scale in tokens.css and mapping
every one of these to the nearest step (the 12px/12.5px/13px/13.5px cluster
alone is 48 of the 83 declarations — four near-identical sizes that read as
one intended size drifting via copy-paste). Flag any value that doesn't fit
a clean scale for a design decision rather than silently rounding it.

Also note: `body` (line 103) and `h1–h3` (111) hardcode the base type scale
directly rather than referencing scale tokens — these should become the
*first* consumers of the new scale, not exceptions to it.

### 3d. Spacing (padding/margin/gap) — no scale token exists

193 separate `padding`/`margin`/`gap`/`padding-*`/`margin-*` declarations
outside the token block (full list: `grep -n -E '\bpadding:|\bmargin:|\bgap:|\bpadding-[a-z]+:|\bmargin-[a-z]+:' public/css/app.css` from line 100 on).
Representative spread of values in use, with no discernible 4/8px grid
discipline: `0, 1px, 2px, 3px, 4px, 5px, 6px, 7px, 8px, 9px, 10px, 11px,
12px, 13px, 14px, 16px, 18px, 20px, 22px, 24px, 26px, 30px`, plus
viewport-relative paddings (`7vh`, `18vh`) on lines 672 and 836. Recommend a
`--space-1…8` (or similar) scale in tokens.css; this is a larger lift than
colors because almost every rule in the file sets at least one of these
properties.

### 3e. Border-radius — no consistent token

`--radius: 8px` exists and is used at lines 155, 421, 571, 636, 773 (5
uses). Everything else hardcodes its own radius — **60** non-token
`border-radius` shorthand declarations across **12** distinct values (plus
two multi-corner shorthands and the explicit `0`-outs on `.btn-split` at
183–184, which don't need a token):

| Value | Count | Lines |
|---|---|---|
| 2px | 1 | 526 |
| 3px | 3 | 364, 608, 899 |
| 4px | 6 | 346, 548, 624, 632, 753, 762 |
| 5px | 3 | 211, 390, 618 |
| 6px | 9 | 128, 169, 189, 245, 368, 435, 561, 659, 801 |
| 7px | 9 | 297, 305, 332, 516, 596, 616, 823, 828, 984 |
| 8px | 10 | 276, 287, 327, 656, 690, 705, 718, 726, 747, 926 |
| 9px | 1 | 430 |
| 10px | 2 | 815, 840 |
| 12px | 2 | 676, 912 |
| 50% | 2 | 740, 916 |
| 999px (pill) | 9 | 204, 448, 459, 466, 474, 482, 576, 780, 849 |
| `2px 2px 0 0` (multi-corner) | 2 | 640, 641 |
| `0 4px 4px 0` (multi-corner) | 1 | 633 |

Note `6px`, `7px`, and `8px` (and the token's own `8px`) are all in heavy,
overlapping use for what reads as the same intent ("small rounded
rectangle") — that's the strongest single case for consolidating onto a
`--radius-sm/md/lg` scale, with `999px` becoming `--radius-pill` and `50%`
staying as-is (it means "circle," not a radius step).

### 3f. Box-shadow — mostly disciplined, a few escapes

`var(--shadow)` is used correctly at lines 155, 431, 657, 677, 727, 774,
816, 841, 913 (9 uses — good adoption). Escapes from the token, all with
hardcoded numeric offsets (colors inside them mostly use tokens/color-mix
already, it's the geometry that's raw): 138 (`inset 0 0 0 1px …`), 282
(`inset 0 2px 0 var(--accent), 0 1px 3px rgba(...)`), 340 (`0 0 0 1px
var(--status-good) inset`), 549 (`inset 2px 0 0 var(--accent)`), 603
(`0 0 0 2px var(--accent) inset`), 706 (`0 1px 0 var(--border)`), 710
(`inset 3px 0 0 var(--accent)`), 935 (`0 0 0 3px color-mix(...)`). These
read as intentional focus-ring/inset-accent treatments rather than
one-offs, so a `--ring` token (width + optional inset) is the likely fix
rather than folding them into `--shadow` itself.

### 3g. Durations — no motion tokens

Every animation duration is a literal: `2s` (142, 223), `110ms` (333),
`.8s` (742), `300ms` (934, 948), `180ms` (938), `250ms` (944, 951). No
`--duration-*` or `--ease-*` tokens exist despite tokens.css being
specified to own "motion." Recommend `--duration-fast/base/slow` +
`--ease-standard`, consumed by all of the above.

### 3h. z-index — no layer scale

Nine hardcoded z-index values with no shared scale: `2` (799, ghost
overlay), `60` (655, cmpicker menu), `90` (881, today-footer), `100` (672,
modal-backdrop), `200` (723, toast-host), `250` (813, stop-chips), `300`
(429 ctx-menu, 835 qc-backdrop, 907 closeout-backdrop — three different
components coincidentally sharing one number), `400` (362,
feedback-select). The relative order is coherent (ghost < cmpicker <
footer < modal < toast < stop-chips < menus/dialogs < feedback-capture) —
worth turning into a named `--z-*` scale in tokens.css before the split so
that ownership of "300" isn't accidentally left in one module while two
other modules also depend on that exact number.

---

## 4. Touch targets < 44×44 CSS px, and icon-only controls without an accessible name

### 4a. Touch target sizing — systemic, not isolated

**There is no `@media (pointer: coarse)` rule and no explicit `44px` /
`min-height`/`min-width` sizing anywhere in the file** (`grep -n
"pointer:|44px" public/css/app.css` returns nothing but the unrelated
`prefers-reduced-motion`/`max-width` media queries). Every interactive
control is sized once, for mouse, and served unchanged to touch. The
highest-impact instances, computed from `font-size`/`line-height:1.45`/
padding/border:

| Class | Padding / font | Effective height | Where it's the *only* touch path |
|---|---|---|---|
| `.btn` (base, line 167–171) | 7px 13px / 14px | ≈36px | Every primary button app-wide |
| `.btn-sm` (179) | 3px 9px / 12.5px | ≈26px | Edit/Finalize/Delete/View/Unlock/Copy icon buttons in `entrylist.js`, `exportview.js`; **the Today-footer's Summary and Close-the-day buttons** (`todayfooter.js`) — the brief's own named core actions ("finalize", "export") |
| `.timer-start-btn` / `.timer-stop-btn` (`.btn.btn-sm.timer-*`, timergrid.js) | same as btn-sm | ≈26px | **Start/stop a timer** — the single most-repeated action in the app, explicitly named in the brief's "core actions" list |
| `.timer-more`, `.timer-clock`, `.timer-name` (418, 386, 341) | 1px 4px / 12.5–13px | ≈18–20px | Timer-card inline affordances (rename, edit clock, open menu) |
| `.navlink` (127–131) | 7px 10px / 14px | ≈34px | All primary navigation |
| `.timer-tab` (284–288) | 6px 11px / 12.5px | ≈30px | Client/matter tab switching |
| `input[type=checkbox]` via `.checkbox-row input` (779: `width: auto`, no explicit size) | browser default ≈13px | ≈13px | **Billable checkbox, block-billed checkbox, narrative-history row selection** — no touch affordance at all beyond the OS default box |
| `.alert-pill` (575–577) | 3px 10px / 12.5px | ≈24px | Dashboard "needs attention" quick actions |
| `.week-entry` (618) | 4px 6px / 11.5px | ≈20px | Calendar week-strip entry rows (tap to open) |

The brief requires *"Core actions — start and stop a timer, add an entry,
edit a narrative, finalize, export — must be fully usable by touch"* and a
44×44 minimum for primary controls. As shipped, **none of those five core
actions clears 44px on any breakpoint** — the mobile media queries (§6)
reflow layout but never grow a touch target. This is the largest, most
consistent finding in the audit and should probably be treated as a
cross-cutting fix (a `--tap-min: 44px` token + a coarse-pointer rule
bumping `.btn`/`.timer-start-btn`/`.timer-stop-btn`/checkbox hit areas)
rather than something any single feature module can fix in isolation.

### 4b. Icon-only controls with no accessible name

Verified by reading every `<${Icon} …>` call site (94 in the app JS,
excluding `pip.js`) and its enclosing `<button>` for `title=`/`aria-label=`/
visible text. The overwhelming majority correctly carry a `title`. Two
confirmed misses:

- **`public/js/views/calendar.js:182`** — `<button class="btn"
  onClick=${() => shift(-1)}><${Icon} name="chevronLeft" .../></button>`
  (previous month/week). No `title`, no `aria-label`, no visible text.
- **`public/js/views/calendar.js:184`** — same pattern, `chevronRight`
  (next month/week). No accessible name.

  Compare to the equivalent controls in `dashboard.js:129–133` (previous
  /next day), which *do* carry `title="Previous day (…)"` /
  `title="Next day (…)"` — the calendar view is the outlier, not the
  pattern.

### 4c. Borderline: glyph-only, not icon-only

Not a strict violation of "no aria-label / no title / no visible text"
(these do have visible text — a Unicode glyph), but worth the split team's
attention because the glyph carries no reliable semantic name for a screen
reader:

- `▲` / `▼` reorder buttons: `customfields.js:54–55`, `settings.js:234–235`
  — no `title`/`aria-label` either, compounding the problem.
- `✕` dismiss/remove buttons with no `title`: `settings.js:297`,
  `settings.js:431`, `app.js:120` (keyboard-shortcuts modal close). Contrast
  with `calendar.js:109`, which uses the same `✕` glyph *with*
  `title="Close"` — again, an inconsistency rather than a uniform gap.
  The shared `Modal` component's own close button (`ui.js:168`) does this
  correctly (`aria-label="Close"` + `<${Icon} name="x">`) — the app.js
  keyboard-shortcuts dialog is hand-rolled instead of using `Modal` and
  loses that treatment as a result.

---

## 5. Theme asymmetry and non-adapting raw colors

**Good news first:** the token *definitions* themselves are symmetric — the
`@media (prefers-color-scheme: dark)` block (29–46) and the
`:root[data-theme="dark"]` block (47–62) define exactly the same 13
properties with exactly the same values, and every property either block
touches also has a bare `:root` fallback (5–27). There is no custom
property that resolves to `unset`/inherited-nothing in either theme — no
hard breakage.

**What *is* asymmetric:** five color tokens are declared once, on bare
`:root`, and **never redefined for dark**: `--status-good` (`#0ca30c`),
`--status-warning` (`#fab219`), `--status-serious` (`#ec835a`),
`--status-critical` (`#d03b3b`), `--danger` (`#d03b3b`, identical to
`--status-critical`). Every *other* semantic color in the same `:root`
block (`--accent`, `--billable`, `--nonbillable`, and the three surface/
border/text triads) gets an explicit, different dark value. The five
status colors are the only ones that stay bit-for-bit identical across
themes. That's either (a) deliberate — status/semantic reds and greens
often *should* read the same regardless of theme — or (b) an oversight
where dark-mode contrast against `--surface-0: #121211` was never checked.
Recommend the color/token pass render swatches of each against both
surface-0 values before deciding; don't silently "fix" by inventing dark
variants without checking whether `#0ca30c`-on-`#121211` and
`#fab219`-on-`#121211` etc. already meet contrast.

**Raw colors that cannot adapt to theme by construction** (they bypass the
token system entirely, so no theme switch will ever change them): the full
list is in §3a. Restated here for this lens: the four `color: #fff`
instances (137, 174, 176, 730) are white-on-saturated-background and
probably fine to stay constant, but should still be tokenized so that's a
documented decision rather than an accident. The `.feedback-select` red
(363) and the three scrim opacities (671, 835, 907) are raw and
theme-naive; none of these are inherently wrong (a black scrim is
reasonably theme-agnostic by design) but all bypass "only tokens.css
defines raw values."

No `@media (prefers-color-scheme: dark)` blocks exist anywhere in the file
*outside* the token declarations (verified: the only two matches for
`@media (prefers-color-scheme` in the whole file are lines 29 and 144, and
144 is a `prefers-reduced-motion` query, not a color one — grep was
double-checked). So there's no case of a component defining a color that
*only* shows up in dark mode with nothing for light, or vice versa, outside
of tokens.css. The risk here is entirely "raw color, so it never adapts,"
not "asymmetric per-component override."

---

## 6. `@media` query inventory

| Line | Query | What it does | Real mobile layout, or a squeeze? |
|---|---|---|---|
| 29 | `(prefers-color-scheme: dark)` | Theme tokens | N/A — not a layout breakpoint |
| 144 | `(prefers-reduced-motion: reduce)` | Kills `.navlink.agent-live` pulse | N/A — motion, not layout |
| 339 | `(prefers-reduced-motion: reduce)` | Kills `.timer-drop-slot` open animation | N/A — motion |
| 500 | `(max-width: 760px)` | Reflows `.entry-head-grid` from a 4-col row (`140px minmax(0,1fr) 110px auto`) into a 2-col grid with explicit `grid-area` placement (Date+Total on row 1, Client/Matter row 2, Billable row 3) | **Real.** Genuine restructuring, not just narrowing columns — the fields visibly regroup. |
| 783 | `(max-width: 760px)` | `.shell` → `flex-direction: column`; `.sidebar` → `position: static`, horizontal, wrapping; `.main` padding 22/26/80 → 14px flat; `.task-line` grid columns collapse to `1fr 80px`; `.subnav` goes horizontal; `.timer-search-wrap`/`.timer-search` go full-width | **Real, but a weak pattern.** DOM genuinely reflows (this is not a squeeze), but the resulting "sidebar becomes a wrapping row of text nav-links pinned at the top" is not a considered mobile nav pattern (no bottom tab bar, no drawer) — it just stacks the same `.navlink` (≈34px tall, §4a) horizontally and lets it wrap. Functions, but is the weakest of the six real breakpoints against the component.gallery bar. |
| 871 | `(max-width: 640px)` | `.import-map` grid `repeat(3,1fr)` → `1fr` | **Real**, narrow scope — only affects the CSV-timer-import modal's column mapping step. |
| 885 | `(max-width: 760px)` | `.today-footer` goes `left: 0`, padding tightens; hides `.muted`/`.tf-meter`; hides `.tf-btn-label` (Summary button becomes icon-only, but keeps its `title` — not an accessibility regression, see §4); truncates the running-timer name to `38vw`; `.dashboard-view` gains `padding-bottom: 54px` for clearance | **Real** content triage for a fixed bar, but it never resizes the buttons inside it — `.btn-sm` stays ≈26px tall on the exact bar the brief calls out for "close the day," "add an entry" (§4a). Layout adapts; touch sizing does not. |
| 971 | `(max-width: 700px)` | `.setting-row` 2-col (`minmax(0,1fr) 230px`) → 1-col stack | **Real**, straightforward and correct for a settings form. |

Six genuine layout breakpoints, zero squeezes-only breakpoints, zero touch-
target accommodations at any of them. `760px` is reused three times (500,
783, 885) and `700px`/`640px` once each — worth consolidating to one or two
shared breakpoint tokens (e.g. `--bp-mobile: 760px`) if CSS custom
properties in media queries are viable in the target browser set, or at
minimum documenting the three `760px` breakpoints as intentionally aligned
so a future edit to one doesn't silently desync it from the other two.

---

## 7. Additional defects found during the cross-reference (bonus, not one of the six asks)

Cross-referencing every `class="…"`/`class=${…}` token used in the JS tree
against every selector defined in `app.css` turned up a few class names
used in markup with **no matching CSS rule at all**. Most are harmless
(inherited styling already looks fine); two are visible gaps:

- **`.chip-draft`** (`ui.js:143`, `narrativehistory.js:62`,
  `exportview.js:164`) — always paired with `.chip`, so it gets the base
  chip shape, but has no color of its own unlike `.chip-finalized` /
  `.chip-exported` / `.chip-reverted` / `.chip-running`, which all do. Draft
  status currently reads as visually identical to no status. Add a
  `.chip-draft` rule alongside its siblings in base.css.
- **`.ctx-custom`** (`ui.js:207`, wraps a caller-supplied context-menu row)
  — no rule; likely fine since callers style their own content, but worth
  a deliberate look rather than an accident.
- **`.timer-tab-label`** (`timergrid.js:784`) — no rule; inherits from
  `.timer-tab`, looks fine today, low severity.
- **`.validation-icon`** (`ui.js:251`, wraps the ⛔/⚠️ glyph) — no rule,
  low severity.
- **`.custom-field-row`** (`customfields.js:52`, always paired with `.row`)
  — no rule; `.row` alone provides the layout, so this looks like a
  reserved/leftover hook rather than a bug.
- **`.feedback-note`** (`feedback.js:160`) — no rule needed; it's used only
  as a JS `document.querySelector('.feedback-note')` hook, and the
  `<textarea>` it's on already inherits base.css's generic `textarea`
  rule.

And the reverse direction — a bare `.reorder` div in `customfields.js:53`
and `settings.js:233` that *looks* like it should match
`.task-line .reorder button` (editor.css) but doesn't, because that
selector is scoped to descendants of `.task-line` and these two usages sit
outside any `.task-line`. Both currently work only because they duplicate
the exact same layout via an inline `style={{display:'flex',
flexDirection:'column'}}`. When editor.css is written, either (a) leave it
scoped and leave the two inline-style duplicates alone, or (b) generalize
to a bare `.reorder` rule in base.css and delete the inline-style
duplication in both call sites — a small but real cleanup opportunity
surfaced by the split.
