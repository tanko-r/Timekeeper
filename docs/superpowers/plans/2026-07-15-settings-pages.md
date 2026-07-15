# Settings Pages & Compact Rows Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Compact one-line setting rows (label left, control right) and Settings split into category pages behind an expandable sidebar submenu.

**Architecture:** A `SettingRow` component + `.setting-row` CSS replaces the airy `Field` grid inside the existing cards; `SettingsView` gains a `page` prop keyed off `#/settings/<key>` hash args; the sidebar renders a submenu under the Settings navlink while that route is active. All 8 existing cards are kept intact and dealt onto 6 pages. No server changes.

**Tech Stack:** No-build React 18 UMD + htm, plain CSS, puppeteer e2e.

**Spec:** `docs/superpowers/specs/2026-07-15-settings-pages-design.md`

## Global Constraints

- Frontend is no-build: plain ES modules under `public/js/`; never add a bundler.
- After changing any `public/js/**` or `public/css/*.css` file, bump `CACHE` in `public/sw.js` by one (once, in the final task).
- Bare `#/settings` must keep working (old links) → renders General.
- UI behavior is verified by `node scripts/e2e-smoke.mjs`; `npm test` must stay green (it doesn't cover these files but guards against accidental server edits).
- Commit each task atomically; push when the plan is done.

---

### Task 1: Compact setting rows

**Files:**
- Modify: `public/js/views/settings.js` (add `SettingRow`; convert GeneralCard, AiCard, TimCard, ValidationCard, BackupCard)
- Modify: `public/css/app.css` (append row styles)

**Interfaces:**
- Produces: `SettingRow({ label, hint, children })` — module-private component in `settings.js`; Task 2 leaves it untouched.
- Consumes: existing `save(patch, reloadSettings)` helper and `Field` (still used by RemoteCard and the AI prompt).

- [ ] **Step 1: Append the CSS**

At the end of `public/css/app.css` (before any trailing media queries is fine — append at EOF):

```css
/* Settings: compact stacked rows (2026-07-15 feedback) — label left, control
   right, hint under the label. Replaces the airy two-column Field grid. */
.setting-rows { display: flex; flex-direction: column; }
.setting-row {
  display: grid; grid-template-columns: minmax(0, 1fr) 230px;
  gap: 14px; align-items: center; padding: 8px 0;
  border-bottom: 1px solid var(--surface-2);
}
.setting-row:first-child { padding-top: 0; }
.setting-row:last-child { border-bottom: 0; padding-bottom: 0; }
.setting-label {
  display: flex; flex-direction: column; gap: 2px;
  font-size: 13px; font-weight: 600; color: var(--text-secondary);
}
.setting-label .field-hint { font-weight: 400; }
.setting-row > select, .setting-row > input:not([type="checkbox"]) { width: 100%; }
@media (max-width: 700px) {
  .setting-row { grid-template-columns: 1fr; gap: 4px; }
}
```

- [ ] **Step 2: Add SettingRow to settings.js**

In `public/js/views/settings.js`, below the existing `save()` helper add:

```js
// One compact setting: label (+hint under it) left, control right
// (2026-07-15 feedback — "stacked and more compact").
function SettingRow({ label, hint, children }) {
  return html`
    <label class="setting-row">
      <span class="setting-label">${label}
        ${hint ? html`<span class="field-hint">${hint}</span>` : null}
      </span>
      ${children}
    </label>`;
}
```

- [ ] **Step 3: Convert GeneralCard**

Replace GeneralCard's `<div class="grid" style=${{ gridTemplateColumns: '1fr 1fr', gap: '12px' }}>` wrapper with `<div class="setting-rows">` and every `<${Field} label=… hint=…>` with `<${SettingRow} label=… hint=…>` (closing tags `<//>` unchanged, controls unchanged). Six rows: Theme, Float timer theme, Daily target, Idle timer nudge, Rounding, Increment.

- [ ] **Step 4: Convert TimCard, ValidationCard, BackupCard, AiCard**

- **TimCard:** replace the `field()` helper's `Field` with `SettingRow` and the `<div class="grid" style=${{ gridTemplateColumns: '1fr 1fr 1fr', gap: '12px' }}>` wrapper with `<div class="setting-rows">`.
- **ValidationCard:** same swap for the three numeric fields (`grid-template-columns: 1fr 1fr 1fr` grid → `.setting-rows`; `Field` → `SettingRow`). The banned-phrases `Field` and add-form stay exactly as they are.
- **BackupCard:** move the "Keep N nightly backups" `Field` out of the buttons `.row` into its own `<div class="setting-rows">` beneath it, as a `SettingRow` (drop the inline `width: 90px` style — the row column sizes it).
- **AiCard:** wrap Model and Ollama URL in a `<div class="setting-rows">` of two `SettingRow`s (drop their inline `minWidth` styles); keep the "Enable AI assist" checkbox-row above them and the system-prompt `Field`/textarea + reset button unchanged.

- [ ] **Step 5: Eyeball + e2e**

Run: `node scripts/e2e-smoke.mjs`
Expected: PASS unchanged (settings is still one page; asserted strings — "Theme", "AI narrative assist", ".TIM export", "Task codes", "Text-expansion shortcuts" — all still render).

Manually: `systemctl --user restart timekeeper` is not needed (no server change); load `http://127.0.0.1:4747/#/settings` with devtools cache disabled and confirm the General card reads as a tight label-left/control-right list.

- [ ] **Step 6: Commit**

```bash
git add public/js/views/settings.js public/css/app.css
git commit -m "feat(settings): compact one-line setting rows (2026-07-15 feedback)"
```

---

### Task 2: Category pages + sidebar submenu

**Files:**
- Modify: `public/js/views/settings.js` (categories + paged SettingsView)
- Modify: `public/js/app.js` (route arg, submenu)
- Modify: `public/css/app.css` (subnav styles)
- Modify: `scripts/e2e-smoke.mjs` (two steps)
- Modify: `public/sw.js` (CACHE bump)
- Modify: `TODO.md` + delete `feedback/2026-07-15T16-30-39.png`, `feedback/2026-07-15T16-31-23.png`

**Interfaces:**
- Produces: `export const SETTINGS_CATEGORIES = [[key, label], …]` from `views/settings.js` (consumed by app.js's sidebar).
- Produces: `SettingsView({ page, settings, reloadSettings, authState, reloadAuth })` — `page` is `route.args[0]`, may be undefined.
- Consumes: `SettingRow` and all 8 card components from Task 1 (unchanged).

- [ ] **Step 1: Update the e2e expectations first (the failing test)**

In `scripts/e2e-smoke.mjs`:

(a) In the shortcuts step, change

```js
  await page.goto(`${base}/#/settings`, { waitUntil: 'networkidle0' });
```
(the one directly under the `// settings shows the minimal list` comment) to
```js
  await page.goto(`${base}/#/settings/codes`, { waitUntil: 'networkidle0' });
```

(b) Replace the whole `'settings shows AI + .TIM cards'` step with:

```js
await step('settings pages: bare route = General; submenu reaches AI / .TIM / codes', async () => {
  await page.goto(`${base}/#/settings`, { waitUntil: 'networkidle0' });
  await waitFor('.subnav'); // Settings navlink expanded into category links
  await page.waitForFunction(() => document.body.textContent.includes('Theme')); // default page = General
  await page.click('.subnavlink:nth-child(2)'); // AI assist
  await page.waitForFunction(() => document.body.textContent.includes('AI narrative assist'));
  await page.goto(`${base}/#/settings/export`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => document.body.textContent.includes('.TIM export'));
  await page.goto(`${base}/#/settings/codes`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => document.body.textContent.includes('Task codes'));
  await shot('settings');
});
```

- [ ] **Step 2: Run e2e to verify it fails**

Run: `node scripts/e2e-smoke.mjs`
Expected: FAIL at the rewritten settings step (`.subnav` never appears).

- [ ] **Step 3: Rework SettingsView into pages**

In `public/js/views/settings.js`, replace the current `SettingsView` with:

```js
// Category pages (2026-07-15 feedback): the sidebar's Settings entry expands
// into these; each page renders one or two of the existing cards. Exported
// for app.js's submenu. Bare #/settings (old links) falls back to general.
export const SETTINGS_CATEGORIES = [
  ['general', 'General'],
  ['ai', 'AI assist'],
  ['export', '.TIM export'],
  ['codes', 'Codes & shortcuts'],
  ['validation', 'Validation'],
  ['server', 'Remote & backups'],
];

export function SettingsView({ page, settings, reloadSettings, authState, reloadAuth }) {
  const key = SETTINGS_CATEGORIES.some(([k]) => k === page) ? page : 'general';
  const pages = {
    general: [html`<${GeneralCard} key="general" settings=${settings} reloadSettings=${reloadSettings} />`],
    ai: [html`<${AiCard} key="ai" settings=${settings} reloadSettings=${reloadSettings} />`],
    export: [html`<${TimCard} key="tim" settings=${settings} reloadSettings=${reloadSettings} />`],
    codes: [html`<${TaskCodesCard} key="codes" />`, html`<${ShortcutsCard} key="shortcuts" />`],
    validation: [html`<${ValidationCard} key="validation" settings=${settings} reloadSettings=${reloadSettings} />`],
    server: [
      html`<${RemoteCard} key="remote" authState=${authState} reloadAuth=${reloadAuth} />`,
      html`<${BackupCard} key="backup" settings=${settings} reloadSettings=${reloadSettings} />`,
    ],
  };
  const label = SETTINGS_CATEGORIES.find(([k]) => k === key)[1];
  return html`
    <div class="page-head"><h1>Settings</h1><span class="muted" style=${{ fontSize: '15px' }}>· ${label}</span></div>
    <div class="grid" style=${{ maxWidth: '760px' }}>${pages[key]}</div>`;
}
```

- [ ] **Step 4: Route the page arg and expand the sidebar**

In `public/js/app.js`:

(a) Extend the settings imports line:

```js
import { SettingsView, SETTINGS_CATEGORIES } from '/js/views/settings.js';
```

(b) In the `view` map, pass the hash arg through:

```js
    settings: () => html`<${SettingsView} page=${route.args[0]} ...${ctx} authState=${authState} reloadAuth=${reloadAuth} />`,
```

(c) Replace the sidebar `NAV.map` block:

```js
        ${NAV.map(([path, label, icon]) => html`
          <button key=${path}
            class=${'navlink' + (active === path ? ' active' : '')}
            onClick=${() => nav(path === 'dashboard' ? '#/' : `#/${path}`)}>
            <${Icon} name=${icon} size=${18} /> ${label}
          </button>`)}
```

with:

```js
        ${NAV.map(([path, label, icon]) => html`
          <${React.Fragment} key=${path}>
            <button
              class=${'navlink' + (active === path ? ' active' : '')}
              onClick=${() => nav(path === 'dashboard' ? '#/' : `#/${path}`)}>
              <${Icon} name=${icon} size=${18} /> ${label}
            </button>
            ${path === 'settings' && active === 'settings' ? html`
              <div class="subnav">
                ${SETTINGS_CATEGORIES.map(([key, sub]) => html`
                  <button key=${key}
                    class=${'subnavlink' + ((route.args[0] || 'general') === key ? ' active' : '')}
                    onClick=${() => nav(`#/settings/${key}`)}>${sub}</button>`)}
              </div>` : null}
          <//>`)}
```

(`React` is already imported from `/js/ui.js` at the top of app.js.)

- [ ] **Step 5: Subnav CSS**

Append to `public/css/app.css`:

```css
/* Settings sub-navigation: the Settings navlink expands into category pages
   while the route is active (2026-07-15 feedback). */
.subnav {
  display: flex; flex-direction: column;
  margin: 0 0 4px 22px; padding-left: 6px;
  border-left: 2px solid var(--surface-2);
}
.subnavlink {
  display: block; text-align: left; padding: 5px 10px;
  border: 0; background: none; border-radius: 7px;
  color: var(--text-secondary); font-size: 13px; cursor: pointer;
}
.subnavlink:hover { background: var(--surface-2); }
.subnavlink.active { background: var(--accent-soft); color: var(--text-primary); }
```

and inside the existing narrow-screen media query (the one containing
`.sidebar { width: 100%; … }`) add:

```css
  .subnav { flex-direction: row; flex-wrap: wrap; border-left: 0; margin-left: 0; }
```

- [ ] **Step 6: Bump the service-worker cache**

In `public/sw.js` line 9, bump `CACHE` by one.

- [ ] **Step 7: Verify**

Run: `npm test` → PASS (no server change).
Run: `node scripts/e2e-smoke.mjs` → PASS including the rewritten settings step and the untouched shortcuts step (now visiting `#/settings/codes`).

- [ ] **Step 8: Update TODO.md, delete the screenshots, commit**

Remove both 2026-07-15 checkbox items from `## UI feedback (screenshots)` in
`TODO.md`, then:

```bash
rm feedback/2026-07-15T16-30-39.png feedback/2026-07-15T16-31-23.png
git add public/js/views/settings.js public/js/app.js public/css/app.css scripts/e2e-smoke.mjs public/sw.js TODO.md
git commit -m "feat(settings): category pages behind an expandable sidebar submenu"
```

---

## Deploy

```bash
systemctl --user restart timekeeper
```
