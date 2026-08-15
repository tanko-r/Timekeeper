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
keyboard-first on desktop, thumb-first on mobile, with zero friction between
"did the work" and "logged the work."

## The three bars

Judge every piece against all three.

1. **Harvest** (domain bar) — the closest analog: timers, entries,
   narrative-style descriptions, invoicing. Our timer → entry → narrative →
   export chain must be at least as clear and at least as fast as theirs, on
   desktop and on a phone. Reference shots: `shots/refs/harvest-*.png`.
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
- **Mobile is a real layout, not a squeeze.** Phone width is 390–412 CSS px.
  Every screen needs a genuine touch layout. Minimum touch target 44×44 CSS
  px for any primary control. Respect safe-area insets. Core actions — start
  and stop a timer, add an entry, edit a narrative, finalize, export — must
  be fully usable by touch with no keyboard at all. Keyboard shortcuts are a
  desktop enhancement layered on top, never the only path.
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
