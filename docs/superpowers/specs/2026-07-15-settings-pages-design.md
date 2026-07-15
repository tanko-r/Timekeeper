# Settings Pages & Compact Rows — Design

**Source:** two 2026-07-15 UI feedback screenshots (TODO.md):
1. 16:30 — "These should be stacked and more compact. Theme → Dropdown,
   Float Timer Theme → Dropdown, etc." (annotating the General card)
2. 16:31 — "Settings menu button should expand to show settings categories,
   and settings are organized into pages rather than one long scroll."

**Spec'd without David's input** — ⚠️ marks assumptions to ratify.

## Part 1 — Compact setting rows

Today each setting is a `Field`: label above, control below, hint below that,
laid out in a loose 2-column grid. The controls are already dropdowns/inputs —
the feedback is about *layout density*.

New shape: a **stacked list of one-line rows** — label (with the hint in small
text under it) on the left, the control right-aligned in a fixed-width column
(~230px). Rows are separated by hairline borders inside the card. A new
`SettingRow` component (local to `settings.js`) + `.setting-rows` /
`.setting-row` CSS replaces `Field` for simple label+control settings.

Applies to: **General** (all 6 settings), **AI assist** (Model, Ollama URL —
the enable checkbox and the system-prompt textarea keep their current shapes),
**.TIM export** (3 text fields), **Validation** (3 numeric fields; the
banned-phrases chips stay as-is), **Backups** (Keep N). Task codes, Shortcuts,
and Remote access keep their existing list/form layouts — they aren't
label+control settings.

⚠️ Assumption: "stacked and more compact" = single-column label-left /
control-right rows, applied to every settings card with simple controls, not
just the General card the screenshot框ed.

On narrow screens (≤700px) rows collapse back to label-above-control.

## Part 2 — Category pages + expandable sidebar menu

### Categories

⚠️ Grouping chosen by me (8 cards → 6 pages):

| key | label | cards |
|---|---|---|
| `general` | General | GeneralCard |
| `ai` | AI assist | AiCard |
| `export` | .TIM export | TimCard |
| `codes` | Codes & shortcuts | TaskCodesCard + ShortcutsCard |
| `validation` | Validation | ValidationCard |
| `server` | Remote & backups | RemoteCard + BackupCard |

### Routing

`#/settings/<key>`; bare `#/settings` (old links, muscle memory, the
feedback-screenshot references) renders `general`. Unknown keys fall back to
`general`. Hash routing already passes `route.args` — `SettingsView` gains a
`page` prop.

### Sidebar

When the Settings route is active, the Settings navlink expands an indented
submenu (one `subnavlink` per category, active one highlighted) directly
beneath it — same pattern as the main navlinks, smaller. Clicking the
Settings navlink itself goes to `#/settings` (= General). Collapses when
navigating elsewhere. ⚠️ No persistence of "last visited category" — Settings
always opens on General.

On mobile (sidebar wraps to a row) the submenu becomes a wrapped row too.

## e2e impact

`scripts/e2e-smoke.mjs` asserts against the one-page settings twice:
- shortcuts step visits `#/settings` expecting the shortcuts list → becomes
  `#/settings/codes`;
- "settings shows AI + .TIM cards" step → becomes a submenu-navigation step
  visiting `ai`, `export`, `codes` pages.

## Touches

`public/js/views/settings.js` · `public/js/app.js` · `public/css/app.css` ·
`scripts/e2e-smoke.mjs` · `public/sw.js` (CACHE bump). No server changes.
