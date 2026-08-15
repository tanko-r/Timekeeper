# Reference analysis — Timekeeper UI/UX overhaul

Source material: `shots/refs/*.png` (three bars: Harvest, Mercury, Attio) against
`shots/baseline/*.png` (current Timekeeper, pre-overhaul). All pixel figures
below are CSS px. Desktop shots are 1440×900 at 1:1 device-scale, so image
pixels = CSS px directly. Mobile shots are 780×1688 at 2x device-scale (390×844
CSS px), so mobile pixel estimates below have already been halved. Figures are
read off the screenshots by eye against these known frame sizes — they are
estimates, not extracted metrics, but they're anchored to a real ruler.

One caveat that matters for how to read this document: Harvest and Attio's
shots are mostly **marketing pages**, not the logged-in product — only the
embedded product mockups inside them (the timesheet panel on
`harvest-home.desktop.0`/`.1`, the invoicing rows on `harvest-invoicing.desktop.0`,
the table on `attio-home.desktop.2`, the AI panel on `attio-home.desktop.1`)
show real UI density and row structure. Mercury's `mercury-home.desktop.1`
laptop mockup and `mercury-bill-pay.desktop.0` browser-frame mockup are the
richest actual-product evidence of the three and get cited most.

---

## 1. Type

### What each reference does

**Harvest** — two registers, marketing vs. product, and they don't share a scale:
- Marketing hero: a mixed serif/sans display, ~64px, tight leading (~0.95),
  one emphasis word set in an italic serif ("**reports**", "**insights**")
  against an otherwise geometric-sans headline. Subhead ~18px regular, muted
  brown-gray, line-height ~1.6.
- Product UI (timesheet/invoicing rows, `harvest-invoicing.desktop.0.png`):
  row title ~13–14px semibold black, a lighter-weight client name inline on
  the same line, subtitle (task name) ~12px gray on the line below, time
  figure ~13–14px tabular right-aligned, pill-button labels ("Start"/"Edit")
  ~11–12px. Day header ("Today: Thursday, 10 Mar") ~20–22px bold. Total row
  ("Total: 5:08") ~14px bold.
- **Distinct type steps visible on one product screen: ~4** (day header,
  row title, row subtitle, pill/meta text).

**Mercury** — the most disciplined of the three, and the one real "financial
UI" in the set (`mercury-home.desktop.1.png`, `mercury-bill-pay.desktop.0.png`):
- Marketing hero ~56px, regular weight (not bold), generous tracking, white
  on photography.
- Product dashboard mock: eyebrow/caption labels ("Mercury balance",
  "Last 30 Days") ~11px, sidebar nav items ~13px, section header
  ("Welcome, Jane") ~24px semibold, hero balance figure
  **~34–36px bold**, list rows (Accounts panel) ~13–14px, button labels ~13px.
- **The one distinctive numeral treatment worth stealing outright**: every
  dollar figure splits the integer and decimal into two sizes — "$5,216,471"
  large, ".18" set smaller and slightly raised, repeated on every account row
  ("$12,505.87", "$2,023,267.12"). Big-money-small-cents, every time, no
  exceptions. All figures are tabular.
- Bill Pay stat cards (`mercury-bill-pay.desktop.0.png`): a three-tier stack —
  count **~28–30px bold** ("11"), a plain-weight caption ~13px below it
  ("Total outstanding"), a secondary dollar figure ~13px below that
  ("$18,149.18"). Same pattern three times in a row (Total/Overdue/Due soon),
  never more than one hero number per card.
- **Distinct type steps on one dashboard screen: ~5–6** (caption 11px, list
  13px, button 13px, section header 24px, hero number 34px+decimal-step).

**Attio** — the densest, and the only one of the three with essentially no
"hero number" moment at all; it's a data-first CRM register throughout:
- Marketing hero ~56–64px bold black, tight tracking, on white.
- Body copy ~18px gray.
- Product table (`attio-home.desktop.2.png`): toolbar/section title ~15px
  semibold, column headers ("Company", "ICP Score", "Owner") ~12px medium
  gray sentence-case (not caps), row primary text ~13–14px, score badge text
  ~11px bold inside a small colored pill.
- AI command panel (`attio-home.desktop.1.png`): monospace log lines ~12px,
  chat placeholder ~14px, footer meta ("Auto · Opus 4.8 · 1M context") ~11px
  monospace-flavored gray.
- **Distinct type steps on one table screen: ~4** (title, column header, row
  text, badge text) — deliberately flat, because the product's job on this
  screen is scanning many rows, not reading one number.

### What current Timekeeper does (`shots/baseline/*`, `public/css/app.css`)

The scale is *defined* generously enough (`app.css:110-111,163,179,205,233`:
h1 22px / h2 18px / h3 15px / `.small` 12.5px / `.btn-sm` 12.5px / badge
11.5px / table header 12px) — seven sizes exist in code. But on the actual
dashboard screenshot, the biggest text anywhere is the 22px date header; the
"Today" card's own h2 ("Today") is 18px, barely bigger than its own badge
text. **No number on the dashboard is ever the largest thing in its card** —
"Billable 5.1h" renders at body size, same weight class as the label next to
it. The entry hour figures (0.4, 0.8, 2.6) are the closest thing to a hero
number in the app and they sit inline with badges and icon buttons at ~15px,
not set apart.

Net: the type *steps* aren't the gap — the *ceiling* is. Nothing on a data
screen is allowed to be dramatically larger than its neighbors, so hierarchy
reads flat even where the CSS technically has seven sizes to work with.

---

## 2. Space

### Base unit and rhythm, per reference

- **Harvest product UI**: tight, ~8px-based. Row padding ~12–16px, icon-to-text
  gap ~8px, pill-button padding ~4px/10px. Marketing page section padding is
  much looser (~96–120px between hero sections) — the two registers don't
  share a unit, which is normal for a marketing site vs. its own product.
- **Mercury**: the strictest 4px-multiple discipline of the three. Card
  padding ~20–24px, gap between sibling cards ~16px (Accounts/Mercury-balance
  side by side; Invoicing/Credit-Card/Bill-Pay trio below them), section gap
  ~32–40px (`Welcome, Jane` to the action-pill row to the card grid). List-row
  padding inside the Accounts card ~12px vertical.
- **Attio**: tightest overall. Table cell padding ~8–10px vertical, ~12–16px
  horizontal. Toolbar row ~44px tall. Almost no card padding in the
  data-table parts of the product — it's bare hairline rows, not boxed cards.

### Whitespace around a primary number

This is where Mercury and the other two diverge sharply, and it's a real
design decision, not an oversight:

- **Mercury** gives its hero balance figure roughly 2× its own cap-height in
  clear space above (an 11px caption + ~12px gap) and a chart below that acts
  as breathing room with nothing else competing beside it. This is the
  **only** one of the three that stages a genuine "hero number moment."
- **Harvest**'s total ("5:08") gets a modest ~16px gap above a hairline rule
  — treated as data, not a moment.
- **Attio** gives its numbers (ICP Score) ~4px of padding inside a small
  pill — essentially no whitespace; it's a dense scan field, not a metric.

Takeaway: only borrow the "hero number" treatment (item 4 in the type
section) where Timekeeper actually has a hero number — today's total hours,
a matter's running total. Everywhere else (row-level hour figures in a list)
should stay data-dense like Harvest/Attio, not inflated like Mercury's
balance card. Doing the hero treatment everywhere would fight the density
goal.

### Current Timekeeper

`app.css` spacing values, as actually written, are **not on a scale**:
`padding: 7px 13px` (`.btn`), `gap: 9px` (`.row`), `margin: 8px 0 6px`
(`.group-head`), `padding: 4px 6px` (`.timer-card`), `18px` (`.page-head`
gap), `14px` (card-to-card margin, `.grid` gap), `22px 26px 80px` (`.main`
padding), `10px` (`.sidebar` padding), `16px` (`.card` padding). Nine
different values across a dozen rules, several off any 4px grid (7, 9, 13,
18, 22, 26). None of the three references show this kind of drift —
whatever their exact unit, every gap and pad you can measure lands on a
multiple of 4.

---

## 3. Colour

### How many hues are live on one screen, and what carries accent

- **Harvest product mockup**: essentially **2 colours in play** — orange
  (brand accent: active nav tab, the "Stop" button's tinted row) plus
  near-black text on white/cream. Nothing else.
- **Mercury dashboard** (`mercury-home.desktop.1.png`,
  `mercury-home.desktop.2.png`): **2 colours** — one periwinkle/violet accent
  (the "Send" pill, the hover-state "View >" link caught mid-hover in the
  screenshot) plus a strict black/white/gray scale for everything else. Red
  appears exactly once, for a single negative delta ("−$421K"), never as a
  badge or a repeated status color.
- **Attio table**: **2–3 colours** — one blue accent (links, the AI-suggestion
  chip) plus grayscale, plus one green semantic badge (ICP score pill). That's
  the ceiling on any one screen across all three references.

### Current Timekeeper

The dashboard screenshot (`shots/baseline/dashboard.desktop.light.png`) has,
simultaneously, live on one screen: blue "billable" badges, orange/yellow
"non-billable" badges, green "finalized" chips, a pulsing green "running"
chip, red left-border warning bars, orange/yellow left-border warning bars, a
blue+orange split progress bar, blue primary buttons, and an orange "Needs
attention" banner. **That's 6+ hues rationed across the same view**, roughly
triple what any reference allows itself. `app.css:16-23` defines the palette
that produces this: `--billable` (blue), `--nonbillable` (yellow/orange),
`--status-good` (green), `--status-warning`, `--status-serious`,
`--status-critical` (three more), `--danger` (red) — seven named colour
roles, several of which end up on screen at once in normal use, not just in
edge cases.

### Surface stack, borders vs. shadows

- **Mercury/Attio**: surface changes do the separating work, not borders.
  Mercury's dashboard mock is monochrome-on-near-black with subtle luminance
  steps between page and card; Attio's table has *no* card shadow at all —
  hairline dividers only. Cards (Mercury's Accounts panel) get one soft
  shadow at the panel boundary and nothing internal.
- **Harvest**: a visible 1px border does the work on its marketing feature
  cards (`harvest-home.desktop.1.png`: "Time tracking / Reports & analysis /
  Invoicing & payments" cards each have a 1px orange-tinted border, no
  shadow), but the product UI itself (timesheet rows) uses hairline dividers
  only, same as Attio.
- **Current Timekeeper**: every entry gets `border` + `box-shadow` + `radius`
  (`.card` in `app.css:153-156`) even in a dense list context where the
  references switch to hairline-only rows. This is part of why entries read
  heavier than they need to (see Density, below).

---

## 4. Density

| Reference | Row height (est.) | Divider vs. card |
|---|---|---|
| Harvest product rows (`harvest-invoicing.desktop.0.png`) | ~52–56px (2-line stack) | hairline only |
| Mercury Bill Pay table rows (`mercury-bill-pay.desktop.0.png`) | ~40–44px | hairline only |
| Mercury Bill Pay stat cards (same shot) | n/a — 3 cards, ~130px tall total | card (1 shadow, no per-item border) |
| Attio table rows (`attio-home.desktop.2.png`) | ~36–40px | hairline only |
| **Current Timekeeper entry row** (`dashboard.desktop.light.png`) | **~120–130px** | full card: border + shadow + radius, on every entry |

Every reference reaches for a **hairline divider**, not a bordered/shadowed
card, the moment it's showing more than a handful of same-kind items in a
list. The only place any reference uses a boxed card at list density is
Mercury's stat-card trio, and those are three items, not a scrolling list of
arbitrary length.

Consequence, directly visible in the screenshots: at the same 900px viewport
height, Harvest's timesheet panel fits ~8–10 entry rows, Attio's table fits
~14+, and current Timekeeper's dashboard fits **3–4** before the fixed
footer bar. The current entry card renders full chrome — name+badge row,
italic narrative-placeholder line, task-line subtitle, a full warning
bracket bar, and an icon-button row — **for every entry regardless of
state**, including entries with nothing wrong. Harvest and Attio only add
extra chrome (a red state, a warning affordance) when something is actually
incomplete; a normal, valid row is just text.

---

## 5. Motion

Static marketing screenshots mostly can't show real animation, but two shots
give direct, not-inferred evidence:

- `mercury-home.desktop.2.png` catches the cursor mid-hover over "View >"
  under the Accounts card — the interaction cue is a **text emphasis on the
  link itself** (not a full-row highlight), consistent with Mercury's
  restrained approach: hover state changes the specific target, not its
  surroundings.
- Every reference's cookie-consent banner (`harvest-*`, `attio-*`) renders as
  a **bottom-sheet-style panel** on mobile and a **corner/edge card** on
  desktop — a real, repeatedly-observed component pattern (slide-in
  toast/sheet, not a centered modal) worth matching for Timekeeper's own
  toasts.

Beyond that, treat the following as informed convention rather than
screenshot-measured fact: buttons across all three brands read as filled
pills/rounded-rects that darken slightly on hover; nothing in any shot
suggests movement beyond a 1–2px lift or a brightness shift — no card
tilts, no large translations. Given the brief's "fast, contemporary,
immediate" bar for Attio specifically, target **120–180ms ease-out** for
hover/press, background/shadow changes preferred over transform so the
`prefers-reduced-motion` fallback is just "skip the transition," not "skip
the whole effect."

Current Timekeeper's only defined animations (`app.css:143,225,335-338`) are
a 2s status-pulse (nav "agent-live" icon, `.chip-running`) and a 110ms
drop-slot open — both already gated behind `prefers-reduced-motion`,
correctly. There's no hover/press motion vocabulary defined at all for
`.btn`, `.card`, or table rows — that's a gap to fill, not a regression to
fix.

---

## 6. Mobile

- **Harvest mobile** (`harvest-home.mobile.0.png`): a ~64px dark header bar,
  logo left, a pill-shaped "☰ Menu" button top-right. All nav collapses
  behind it; content (the hero headline) starts immediately below the
  header. Cookie consent is a bottom sheet covering ~40% of the screen.
- **Mercury mobile** (`mercury-home.mobile.0.png`): hamburger icon top-right
  over a photo header; CTA buttons stack as a **row of two**, not full-width
  stacked (Open account ~55% width + Launch demo ~45% width, both ~48–52px
  tall — clearly touch-sized). Worth flagging: Mercury's mobile "dashboard"
  shot is just the desktop screenshot scaled into a static image inside the
  laptop mockup, not a responsive product view — there's no real mobile
  product layout to learn from in this set, only the marketing chrome
  pattern (hamburger + stacked hero + paired CTAs).
- **Attio mobile** (`attio-home.mobile.0.png`, `.1.png`): same hamburger
  pattern. Below the fold, the customer-logo grid reflows from Harvest's
  multi-column desktop grid to **2 columns**, not 1 — small discrete items
  (logo tiles) stay paired rather than stacking one-per-row. Lesson: not
  everything needs to collapse to a single column on a phone; it depends on
  whether the item is a scannable badge or a line of prose.

### Current Timekeeper mobile

`shots/baseline/dashboard.mobile.light.png` is a **6634px-tall** full-page
capture (vs. an 844px viewport — nearly 8 screens of scroll). The read-off
of the top of that file is the headline finding: the sidebar's ten links
(Dashboard, Calendar, Search, Stats, Clients/Matters, Export, Settings, Add
todo, Run /todo, Float timer) render as a **plain stacked list at the top of
the page**, in normal document flow, before any page content. That block
alone runs roughly **480–500px** — on an 844px-tall viewport, over half the
first screen is spent on nav before "Fri, Aug 14, 2026" or the Today card
ever appears. None of the three references do this; all three collapse nav
behind a ~48–64px header with a hamburger icon, every single time, on every
mobile shot in this set.

---

## 7. Ten gaps, ranked, with the fix stated as an instruction

1. **Mobile nav is a stacked list in document flow, eating ~500px of the
   first 844px screen on every mobile page.** *(`shots/baseline/dashboard.mobile.light.png`
   top; cf. every `*.mobile.0.png` in `shots/refs/`, which all use a
   ~56–64px sticky header + hamburger.)* **Fix**: build a mobile header bar
   (sticky, ~56px, safe-area aware) with the brand mark and a hamburger
   button that opens a full-height drawer/overlay containing the current
   sidebar links; remove the inline stacked nav from the mobile document
   flow entirely. Pair it with a persistent bottom bar carrying the 2–3
   highest-frequency actions (start/stop the active timer, add an entry) so
   they're reachable without opening the drawer, matching the brief's
   thumb-first / no-keyboard-required requirement directly.

2. **Entry rows are ~2.5–3× taller than every reference's equivalent row,
   capping the dashboard at 3–4 visible entries where Harvest fits 8–10 and
   Attio fits 14+.** *(current ~120–130px/entry, `app.css:153-156` `.card`
   applied to every entry; Harvest ~52–56px, Attio ~36–40px.)* **Fix**:
   give a "clean" entry (has a narrative, non-zero total) a compact single
   row — name, matter code, hours, one status chip, ~48–56px, hairline
   divider, no border/shadow. Reserve the full bordered card treatment
   (narrative preview, task-line subtitle, warning bar) for entries that
   actually need attention: empty narrative, zero total, or unfinalized on a
   past day. Row height should be conditional on entry state, not fixed.

3. **Up to 6+ colours are simultaneously live on one dashboard screen, where
   no reference exceeds 2–3.** *(billable-blue, non-billable-orange,
   finalized-green, running-green-pulse, red warning bars, orange warning
   bars, split blue/orange progress bar, orange attention banner, all at
   once on `dashboard.desktop.light.png`; `app.css:13-23` defines seven
   colour roles that can co-occur.)* **Fix**: cap the palette in play on any
   one screen to accent + at most 2 semantic colours. Concretely: make
   "non-billable" a neutral/outline badge instead of a competing accent
   colour (billable is the state that should own colour, since it's the one
   with billing consequence); and stop showing the same incompleteness twice
   in two different colours (the top-of-page "Needs attention" banner
   already flags it — don't also redden every affected entry's border).

4. **No screen has a hero number; the biggest text in the app is an 18px
   card header, barely larger than its own badge text.** *(dashboard "Today"
   h2 at 18px, `app.css:111`; contrast Mercury's 34–36px balance figure with
   an 11px caption above it, `mercury-home.desktop.1.png`.)* **Fix**: on the
   dashboard's Today card, render total billable hours as one dominant
   figure — 28–32px bold tabular — with "Billable" as an 11–12px caption,
   Mercury's big-number/small-label pattern. Apply Mercury's
   decimal-demotion trick to it too (whole hours full-size bold, the tenths
   digit smaller/lighter) so magnitude reads before precision does. Keep
   this treatment rare — one hero number per screen, not on every entry row
   (see gap 2's density fix, which pulls the opposite direction on purpose).

5. **Table headers use spreadsheet styling (uppercase + letter-spacing) where
   every reference uses calm sentence case.** *(`app.css:232-235`,
   `text-transform: uppercase; letter-spacing: .04em`, on `table.tk th`; cf.
   Harvest's "Mon 13", Mercury's "Payments", Attio's "Company"/"ICP Score" —
   none capitalized.)* **Fix**: drop `text-transform: uppercase` and the
   letter-spacing on table headers; set them sentence-case, ~12.5px,
   ~600 weight, matching the register the references use everywhere numbers
   are meant to be read as data rather than as a form field.

6. **Spacing values aren't on a scale — nine-plus distinct pixel values
   (4, 5, 6, 7, 8, 9, 10, 13, 14, 16, 18, 22, 26) scattered through
   `app.css`, several off any 4px grid.** *(`.btn` `7px 13px`, `.row` `gap:
   9px`, `.group-head` `margin: 10px 0 6px`, `.timer-card` `padding: 4px
   6px`, `.main` `padding: 22px 26px 80px` — all in the same file.)* **Fix**:
   when `tokens.css` is created per the brief, define `--space-1` through
   `--space-8` on a strict 4px base (4/8/12/16/24/32/48/64) and require
   every spacing declaration in every module to reference one of those
   tokens — no bare pixel values outside `tokens.css`, which the brief
   already mandates for colour and should extend to spacing.

7. **Empty-state narratives are pre-flagged as errors (red bracket bar) even
   on a same-day draft nobody has tried to finalize yet.** *(dashboard's
   "Narrative is empty." red-bracket rows appear on drafts still being
   worked, `dashboard.desktop.light.png`; no reference pre-flags an
   in-progress row as an error — Harvest's empty timer just shows "0:00" and
   a Start button, neutral.)* **Fix**: show the red/blocking treatment only
   once the user actually attempts to finalize the day, or on a
   carried-over entry from an already-finalized prior day. For a same-day
   draft with no narrative yet, use a neutral affordance ("Add a
   narrative," gray, no red bracket) — reserve red for things genuinely
   blocking an action right now.

8. **Timer cards are cramped, not just dense — 4–6px internal padding packs
   name, clock, tenths and a play/stop control into a 32px row with no air.**
   *(`app.css:304-307`, `.timer-card { padding: 4px 6px; min-height: 32px }`;
   contrast Attio's comparably tight ~36–40px rows, which still keep ~8–10px
   cell padding.)* **Fix**: keep the row height — it's in the right density
   band — but move internal padding from 4–6px to 8–10px, letting the timer
   name truncate one character earlier if it must, rather than starving
   every element's padding equally to make everything fit.

9. **No hover/press motion vocabulary exists for primary controls.** *(only
   defined animations in `app.css` are a 2s status pulse and a 110ms
   drop-slot open, `app.css:143,225,335-338`; every reference shows a clear,
   consistent hover state on buttons/links — e.g. Mercury's "View >" caught
   mid-hover, `mercury-home.desktop.2.png`.)* **Fix**: define
   `--motion-fast` (120ms) and `--motion-base` (180ms) ease-out tokens in
   `tokens.css`, and apply a consistent hover treatment (background darken +
   a 1px lift with a shadow increase) to `.btn`, clickable `.card`s, and
   table rows — background/shadow-only under `prefers-reduced-motion`, per
   the brief's existing requirement.

10. **Type steps exist in code (seven sizes defined) but the ceiling is
    capped at 22px, so hierarchy reads flat despite having room to work
    with.** *(`app.css:110-111`, h1 22px is the largest text anywhere in the
    app; Attio's own dense table screen still reserves a ~24–28px section
    title even in a scanning-heavy view, `attio-home.desktop.2.png`.)*
    **Fix**: extend the scale upward with a true display size (28–32px)
    reserved for at most one figure-of-the-moment per screen (ties directly
    to gap 4) — don't let an 18px section header (`.card h2`) remain the
    tallest text on a data-heavy page; every reference keeps at least one
    size step meaningfully above its own section headers.
