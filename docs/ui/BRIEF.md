# Timekeeper UI/UX overhaul — shared brief

Every builder and every critic in this run works from this file. Read it
first. It is the contract.

## What the app is

A self-hosted, single-user time-tracking app for one attorney. The user keys
time between phone calls. The chain is: start a timer → stop it → an entry
appears → a billing narrative gets written or auto-built from task lines →
the day is validated and finalized → entries export as CSV for keying into
the firm's billing system.

The user is a working lawyer, not a developer. He uses this on a desktop
browser during the day and as an installed Android PWA on a phone.

## The goal

It should feel like magic to a lawyer keying time between calls: fast, calm,
and keyboard-first, with zero friction between "did the work" and "logged the
work."

This is a **desktop-first** app. The owner works from the desktop browser and
the desktop PWA; the phone is a secondary surface that must handle the core
loop well and need not match desktop feature for feature. See the
platform-priority constraint below.

## The three bars

Judge every piece against all three.

1. **Harvest** (domain bar) — the closest analog: timers, entries,
   narrative-style descriptions, invoicing. Our timer → entry → narrative →
   export chain must be at least as clear and at least as fast as theirs —
   on desktop above all, and workable on a phone.
2. **Mercury and Attio** (craft bar) — Mercury for calm, precise,
   financial-grade polish: restrained type, generous but disciplined spacing,
   quiet color, numbers that read as numbers. Attio for fast, contemporary
   interaction: keyboard-driven, immediate, dense without feeling cramped.
   Reference shots: `shots/refs/mercury-*.png`, `shots/refs/attio-*.png`.
3. **component.gallery** (correctness bar) — before building any piece of UI
   that maps to a known component type (tabs, popover, accordion, empty
   state, toast, modal, bottom sheet, list row, segmented control, command
   palette, keyboard shortcut overlay), look up how mature design systems
   solve that exact problem, including their responsive and mobile behavior,
   and hold the version here to that bar: states, transitions, keyboard and
   focus handling, touch target size, and how it composes with its
   neighbours. A component that looks right but fights the components around
   it, or that only works in one theme or one viewport, fails.

## Hard constraints

- **Stack is fixed.** Node 24 ESM, Express 5, better-sqlite3. Frontend is
  no-build React 18 UMD + htm, vendored in `public/vendor/`. Never add a
  bundler, never add a runtime dependency, never swap the framework. Browser
  code is plain ES modules under `public/js/`.
- **This is a UI/UX pass.** Do not rewrite the backend or the data model. API
  changes are allowed only where the UI genuinely cannot work without one,
  and must be additive.
- **Preserve every existing capability.** Nothing that works today may stop
  working. That includes all keyboard shortcuts: `n`, `t`, `q`, `c`, `s`,
  `/`, `g` then `d`/`c`/`s`/`e`, `[` and `]`, `Ctrl+Enter`, `Esc`, `?`, and
  the timer grid's arrow-key navigation, `Enter`/`Space`, `Alt+↑`/`Alt+↓`,
  `Shift+Enter`, `Ctrl+Enter`. Extend the interaction model; never remove.
- **Both themes are first-class.** Light and dark are two designs, not one
  design with a filter over it. The theme setting lives in Settings and
  defaults to the OS preference (`theme: auto | light | dark`, applied by
  `applyTheme` in `public/js/app.js` as `data-theme` on `<html>`). Every
  color must be a token defined for both themes. Never define a color only
  inside a `@media (prefers-color-scheme: dark)` block or only under
  `[data-theme="dark"]` — the pattern is: define the light value on bare
  `:root`, then redefine under both `@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) }` and `:root[data-theme="dark"]`.
- **Desktop first; see the platform-priority section below.** This is a
  keyboard-driven desktop app that also works on a phone. Design the desktop
  browser and desktop PWA experience first and do not cap desktop density or
  speed for the phone's benefit.
- **Mobile is a real layout for the core loop, not a squeeze.** Phone width is
  390–412 CSS px. Starting and stopping a timer, adding or editing an entry,
  writing a narrative, finalizing and exporting must be fully usable by touch
  with no keyboard, at 44×44 minimum, with safe-area insets respected.
  Everything else on a phone must be reachable and unbroken, not equal to
  desktop.
- **After changing any `public/js/**` or `public/css/*.css` file, bump
  `CACHE` in `public/sw.js`**, and keep the `SHELL` precache list in sync
  with the real file tree. There is no build step, so nothing else tells an
  installed PWA client that the shell changed.
- **No real client, matter, firm, or personal data** may enter the repo, a
  screenshot, or a commit message. The demo dataset in
  `scripts/lib/demoseed.mjs` is entirely fictional (Acme, Northgate, Verity).
  Keep it that way.
- **Respect `prefers-reduced-motion`.** Every animation needs a reduced
  fallback.

## How to see your work

Screenshots are the only accepted evidence. Never judge from source.

```bash
# Full matrix: every screen, desktop + mobile, light + dark
node scripts/uishots.mjs --out shots/<name>

# One or two screens only (much faster)
node scripts/uishots.mjs --out shots/<name> --only dashboard,day

# Narrow further
node scripts/uishots.mjs --out shots/<name> --only dashboard --viewport mobile --theme dark
```

Screens available to `--only`: `dashboard`, `day`, `calendar`, `search`,
`stats`, `cms`, `export`, `settings`, `settings-ai`, `settings-remote`,
`entry-editor`, `entry-editor-existing`, `shortcuts`, `quick-capture`,
`closeout`.

Output files are `<screen>.<viewport>.<theme>.png`. A `manifest.json` in the
same directory lists every shot and any console errors seen while taking it.
**Console errors are failures.** Check the manifest.

The pre-overhaul baseline is in `shots/baseline/` — same file names. Use it
for before/after comparison.

Reference screenshots of the three bars are in `shots/refs/` and, better, in
`shots/refs-v2/`.

**Prefer `shots/refs-v2/`.** The first set was captured from marketing home
pages, and a critic found that only three of its 42 files contain usable
product interface — the rest are hero copy, feature grids, and cookie
banners. `shots/refs-v2/` is 40 curated files of real, signed-in product
interface pulled from help centres, changelogs, and app-store listings, each
one read and judged before it was kept. `shots/refs-v2/INDEX.md` says what
every file shows and what to look at it for. Read that index before you pick
a comparison image. The flagship references are
`harvest-timesheet-day.desktop.webp` (the closest existing analog to this
app's core screen), `attio-record-detail-page.desktop.png`, and
`mercury-dashboard-dark.desktop.jpg`.

For a blind comparison:

```bash
node scripts/abpair.mjs --ours shots/wave1/dashboard.desktop.light.png \
                        --ref shots/refs/mercury-home.desktop.0.png \
                        --out shots/ab/<pair-name>
```

That writes `A.png` and `B.png` in a hash-determined order. Judge A against B
without reading `.key.json`.

## Tests

Both must stay green. Run them before you report done:

```bash
npm test
node scripts/e2e-smoke.mjs
```

`e2e-smoke.mjs` drives the real UI in headless Chromium and asserts on real
selectors. If your markup change breaks a selector it uses, fix the test to
match the new markup only when the capability it covers still exists and is
still reachable — never by deleting the assertion.

## CSS architecture

Styles live in `public/css/`, split into modules, each loaded by its own
`<link>` in `public/index.html` and precached in `public/sw.js`:

- `tokens.css` — the design system: color for both themes, type scale,
  spacing scale, radii, elevation, motion, z-index layers. **Only this file
  defines raw values.** Everything else consumes `var(--…)`.
- `base.css` — reset, document typography, form controls, buttons, focus.
- `shell.css` — app shell, sidebar, mobile navigation, page header.
- the remaining feature modules — timers, entries, editor, views, overlays.

If you find a hardcoded color, font size, or spacing value outside
`tokens.css`, that is a defect.

## Owner constraint: desktop first, mobile second

Stated by the person who uses this app every working day, and it revises the
original instruction that every screen must be fully featured on a phone:

> "I don't care that much about mobile. I mostly need to use this from desktop
> web/PWA. This should be a desktop-first app, with mobile features, but not
> full-featured mobile."

What that means in practice:

- **Design for the desktop browser and the desktop PWA first.** When a
  decision trades desktop quality against phone quality, desktop wins. Do not
  cap desktop density, hide desktop controls, or slow a desktop interaction
  down to keep a phone layout simple.
- **Keyboard is a first-class input, not an enhancement.** Earlier drafts of
  this brief called shortcuts "a desktop enhancement layered on top". That is
  now backwards: this is a keyboard-driven desktop app that also works on a
  phone. Every frequent action deserves a key, the keys deserve to be
  discoverable, and the shortcut overlay must describe what the keys actually
  do.
- **Desktop density is a feature.** A lawyer scanning twenty timers on a
  1440px screen should see twenty timers. Do not carry phone-sized rows,
  phone-sized spacing, or phone-sized type onto the desktop.
- **Mobile scope is the core loop, done well** — start and stop a timer, add
  or edit an entry, write a narrative, finalize the day, export. Those must
  work by touch with no keyboard, and they must be genuinely good. Everything
  else on a phone needs to be *reachable and not broken*, not equal to
  desktop. Bulk operations, matter maintenance, import, settings depth and
  reporting may all be thinner on a phone.
- **The mobile fences stay, with a changed status.** The screenshot harness
  still measures horizontal overflow and the 44x44 touch floor at phone width.
  Horizontal overflow and anything that breaks the core loop on a phone remain
  blockers. A sub-44px control on a secondary phone surface is now a *minor*
  finding, not a blocker — note it, do not stop the wave for it.
- **Nothing already built for mobile gets torn out.** The phone layouts,
  bottom sheets and touch paths already shipped are good work and they stay.
  This changes where the REMAINING effort goes, not what exists.

If a task, a critic, or an earlier section of this brief conflicts with this
one, this one wins.

## Owner constraint: this is fundamentally a timers app

Stated by the person who uses this app every working day, and it outranks the
teardown, every critic, and every task prompt in this run:

- **He uses the timer list extensively.** Timers are the spine of the app, not
  a feature of the dashboard. The merged Today list is a list of timers that
  also carries the day's recorded hours and narratives — never an entry list
  that happens to show timers.
- **`/` on Today filters the timer list, and he uses it constantly. It stays.**
  Any instruction anywhere in this run to fold, repurpose, or remove the `/`
  timer filter — including the wave-1 review's suggestion to fold it into the
  quick-capture surface — is **void**. `/` searching timers on Today and `/`
  searching entries elsewhere is a deliberate, correct fork, and the shortcut
  overlay documenting that fork is correct too. Do not "fix" it.
- Timer search must be excellent, not merely present: fast, forgiving, and
  reachable by touch as well as by keyboard.
- **Compact is the right default, and denser than today is better — provided
  it expands.** The owner's words: making the timer list more compact is
  "totally fine, better even. just so long as I can expand it. and search it
  with keyboard." So push the resting density hard: a dense list of many
  timers scanned at a glance beats a comfortable list of a few. Then give
  expansion two forms, and build both:
  1. **Per row.** A row expands in place to show what the compact form hides —
     the narrative, the task lines, the secondary controls. Reachable by
     keyboard from the focused row, by click, and by touch.
  2. **The whole list.** A density control — compact and comfortable — that
     persists across sessions, so his choice survives a reload and a restart.
  Density is a default, never a cage. Nothing may be readable only when
  expanded and unreachable when compact: the compact row still shows the
  matter, the state, the hours, and the start/stop control.
- Timer capabilities — groups, filters, sorting, renaming, reordering,
  duplicating, importing, batch actions — are demoted in the surface, never in
  reach. Every one keeps a touch path.

If a task you are given conflicts with this section, this section wins. Say so
in your report and build to this.

## The standing teardown critic

One principal critic tore the whole app down screen by screen, judging every
element by the job it does for a lawyer keying time, with authority to say
DELETE, MERGE, MOVE, RETHINK or NEW about any element or any whole page. Its
verdict lives in `docs/ui/teardown.md`.

That same critic reviews the whole app again at the end of every wave, holding
the work against its own original teardown. It re-shoots the app itself and
answers two questions: did this wave move toward the architecture the teardown
called for, and did it break anything elsewhere. Its findings rewrite the next
wave's plan before any more building happens.

So `docs/ui/teardown.md` is not background reading. It is the standard every
wave is measured against. Read it before you design anything, and if your task
conflicts with it, say so rather than quietly building the old shape.

## Working rules for agents in this run

- **Do not edit `public/sw.js`.** Several agents work in this tree at the same
  time and would collide on it. The orchestrator bumps `CACHE` and syncs the
  `SHELL` list at each wave boundary. The only exception is a task that
  explicitly says you own `sw.js`.
- Every dialog goes through the shared overlay primitive. Do not hand-roll a
  backdrop, a focus trap, or a scroll lock — a dialog that invents its own is
  a defect, however good it looks.
- The screenshot harness measures two mobile fences on every run and records
  them in `manifest.json`: horizontal overflow (`document.documentElement.
  scrollWidth` must equal the viewport width) and the 44×44 touch floor for
  every visible interactive element. Pass `--strict` to make either one exit
  non-zero. A `<kbd>` hint is not an interactive element and does not satisfy
  the touch floor — a dialog whose only phone affordance is a keyboard hint
  passes the fence and still fails the brief.
- Stay inside the file scope your task names. Another agent owns the rest.
- Do not revert or rewrite another agent's work to suit your own taste. If
  something adjacent is wrong, say so in your report.
- Commit nothing. The orchestrator commits at wave boundaries.
- Report concisely: what you changed, which files, what the screenshots show,
  what you could not do and why.
