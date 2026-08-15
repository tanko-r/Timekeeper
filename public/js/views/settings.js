import { api } from '/js/api.js';
import { html, useState, useEffect, useRef, emitToast, Icon, React } from '/js/ui.js';
import { useShortcuts, refreshShortcuts } from '/js/components/shortcuts.js';
import { CmsSection } from '/js/views/cms.js';
import { RunTodo } from '/js/components/runtodo.js';
import { pipSupported, toggleTimerPip } from '/js/lib/pip.js';

// SETTINGS — the configuration surface, and now the home of reference data.
//
// Three things the teardown (§15, §14, E5) asked of this file:
//
//   1. ABSORB CLIENTS & MATTERS. "Matters are configured once and used
//      constantly through the CM picker. This is reference data maintenance,
//      opened maybe weekly. It does not deserve a top-level slot when starting
//      a timer does not have one." It is a category here now; `#/cms` is
//      canonicalised onto `#/settings/cms` by app.js's route table, so every
//      old link still lands on it.
//
//   2. ONE ROW SHAPE. "Three different row layouts inside one card… every
//      mature settings pattern (Apple HIG grouped lists, Polaris
//      SettingToggle, Fluent) picks ONE row shape and holds it. Pick
//      label-left/control-right, and give full-width controls their own
//      labelled block below a rule." That is `SettingRow` below — one
//      component, two shapes (`block` for anything that needs the full
//      measure), used by every card on every sub-page. Nothing in this file
//      lays out a label and a control by hand any more.
//
//   3. A REAL PHONE NAVIGATION. The categories were a horizontally scrolling
//      pill strip, hard-cut mid-word at the viewport edge — "Codes & shor" —
//      with four whole sections off-screen behind a fade. Below the desktop
//      breakpoint they are a SECTION SWITCHER instead: one full-width control
//      naming where you are, which discloses the whole list, each row carrying
//      its own one-line description. That is the pattern Primer's
//      SegmentedControl reaches for at narrow widths (`variant={{narrow:
//      'dropdown'}}`), Material 3 uses for tab overflow, and iOS uses as a
//      navigation-bar pull-down menu. settings.css suppresses the shell's
//      generic chip strip on these pages so there is exactly one navigation.
//
//      …AND TOOLS TOO (this wave). Seven of the eight sections rendered the
//      switcher and the eighth did not: Tools was app.js's own panel, so it
//      fell through to the shell's generic chip strip — eight chips on a 390px
//      phone with five of them off the left edge and "Codes & shortcuts" cut
//      mid-word to "…rtcuts" behind a fade. app.js was already built to hand
//      the section over the day this file grew it ("appended only if
//      settings.js has not already grown them itself"), so it is grown here
//      now: `tools` is a category like any other, and there is exactly ONE
//      sub-navigation on every settings route.
//
// The sidebar's `.subnav` is still the desktop navigation (≥1024px), where the
// eight vertical links fit comfortably and the switcher is hidden.

export const SETTINGS_CATEGORIES = [
  ['general', 'General'],
  ['ai', 'AI assist'],
  ['cms', 'Clients & matters'],
  ['export', '.TIM export'],
  ['codes', 'Codes & shortcuts'],
  ['validation', 'Validation'],
  ['server', 'Remote & backups'],
  ['tools', 'Tools'],
];

// Icon + one line per category. The line is what makes the switcher a
// navigation rather than a list of nouns: "Validation" means nothing on its
// own, "what counts as a finished narrative" does.
const CATEGORY_META = {
  general: { icon: 'settings', desc: 'Theme, daily target, rounding' },
  ai: { icon: 'sparkles', desc: 'The local model that drafts narratives' },
  cms: { icon: 'briefcase', desc: 'Clients, matters and their custom fields' },
  export: { icon: 'export', desc: 'Firm constants for every .TIM line' },
  codes: { icon: 'keyboard', desc: 'Task codes and text expansion' },
  validation: { icon: 'alert', desc: 'What counts as a finished narrative' },
  server: { icon: 'lock', desc: 'Password, sessions and backups' },
  tools: { icon: 'wand', desc: 'Float window, todos, keyboard sheet' },
};

export function SettingsView({ page, settings, reloadSettings, authState, reloadAuth, refreshKey, bumpRefresh }) {
  const key = SETTINGS_CATEGORIES.some(([k]) => k === page) ? page : 'general';
  const pages = {
    general: html`<${GeneralCard} settings=${settings} reloadSettings=${reloadSettings} />`,
    ai: html`<${AiCard} settings=${settings} reloadSettings=${reloadSettings} />`,
    cms: html`<${CmsSection} refreshKey=${refreshKey} bumpRefresh=${bumpRefresh} />`,
    export: html`<${TimCard} settings=${settings} reloadSettings=${reloadSettings} />`,
    codes: html`
      <${React.Fragment}>
        <${TaskCodesCard} />
        <${ShortcutsCard} />
      <//>`,
    validation: html`<${ValidationCard} settings=${settings} reloadSettings=${reloadSettings} />`,
    server: html`
      <${React.Fragment}>
        <${RemoteCard} authState=${authState} reloadAuth=${reloadAuth} />
        <${BackupCard} settings=${settings} reloadSettings=${reloadSettings} />
      <//>`,
    tools: html`<${ToolsCard} />`,
  };
  const label = SETTINGS_CATEGORIES.find(([k]) => k === key)[1];
  return html`
    <${React.Fragment}>
      <div class="page-head set-head">
        <h1>Settings</h1>
        <span class="set-head-cat">${label}</span>
      </div>
      ${/* `set-page` is the hook settings.css uses to stand the shell's chip
            strip down on these routes, and the honest centred measure the
            teardown asked for in place of a 760px column pinned to the left of
            a 1425px viewport. */''}
      <div class="set-page">
        <${SectionNav} current=${key} />
        <div class="set-stack">${pages[key]}</div>
      </div>
    <//>`;
}

// ---------------------------------------------------------------------------
// The section switcher (below 1024px only — see settings.css)
// ---------------------------------------------------------------------------

function SectionNav({ current }) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef(null);
  const triggerRef = useRef(null);
  const items = SETTINGS_CATEGORIES;
  const at = items.findIndex(([k]) => k === current);
  const [, label] = items[at] || items[0];
  const meta = CATEGORY_META[current] || CATEGORY_META.general;

  // A route change closes it — the disclosure is navigation, and navigation
  // that stays open after you have arrived is a menu you have to dismiss.
  useEffect(() => { setOpen(false); }, [current]);

  useEffect(() => {
    if (!open) return undefined;
    const away = (e) => { if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false); };
    const key = (e) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', key, true);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', key, true);
    };
  }, [open]);

  return html`
    <div class="set-nav" ref=${boxRef}>
      <button type="button" class="set-nav-trigger" ref=${triggerRef}
        aria-expanded=${open ? 'true' : 'false'} aria-controls="set-nav-list"
        onClick=${() => setOpen((v) => !v)}>
        <span class="set-nav-tile"><${Icon} name=${meta.icon} size=${18} /></span>
        <span class="set-nav-text">
          <span class="set-nav-eyebrow">Section ${at + 1} of ${items.length}</span>
          <span class="set-nav-current">${label}</span>
        </span>
        <span class="set-nav-caret"><${Icon} name=${open ? 'chevronUp' : 'chevronDown'} size=${18} /></span>
      </button>
      ${open ? html`
        <ul class="set-nav-list" id="set-nav-list">
          ${items.map(([k, name]) => {
            const m = CATEGORY_META[k] || {};
            const active = k === current;
            return html`
              <li key=${k}>
                <button type="button" class=${'set-nav-item' + (active ? ' active' : '')}
                  aria-current=${active ? 'page' : undefined}
                  onClick=${() => { setOpen(false); location.hash = `#/settings/${k}`; }}>
                  <span class="set-nav-tile"><${Icon} name=${m.icon || 'settings'} size=${18} /></span>
                  <span class="set-nav-text">
                    <span class="set-nav-name">${name}</span>
                    <span class="set-nav-desc">${m.desc || ''}</span>
                  </span>
                  <span class="set-nav-tick">
                    ${active ? html`<${Icon} name="check" size=${18} />` : null}
                  </span>
                </button>
              </li>`;
          })}
        </ul>` : null}
    </div>`;
}

// ---------------------------------------------------------------------------
// The row primitive — ONE component, two shapes
// ---------------------------------------------------------------------------
//
// Default: label (and its hint) on the left, the control on the right, a
// hairline between rows — Apple's grouped list, Polaris's SettingToggle,
// Fluent's settings row, all the same shape.
//
// `block`: the label sits above a control that needs the whole measure (a
// textarea, a chip field, a form). Same padding, same divider, same label
// type — the teardown's "give full-width controls their own labelled block
// below a rule", not a third improvised layout.
//
// `plain` swaps the <label> element for a <div>, for the handful of rows whose
// "control" is several controls (a form, a list of chips) and which therefore
// must not claim a single labelled control.
function SettingRow({ label, hint, children, block, plain, off }) {
  const Tag = plain ? 'div' : 'label';
  const cls = ['set-row', block ? 'set-row-block' : '', off ? 'set-row-off' : ''].filter(Boolean).join(' ');
  return html`
    <${Tag} class=${cls}>
      <span class="set-row-text">
        <span class="set-row-label">${label}</span>
        ${hint ? html`<span class="set-row-hint">${hint}</span>` : null}
      </span>
      <span class="set-row-control">${children}</span>
    <//>`;
}

// A settings card: heading, optional standfirst, then rows. Every sub-page is
// built from these and nothing else.
function SettingsCard({ title, intro, children }) {
  return html`
    <section class="card set-card">
      <div class="set-card-head">
        <div class="set-card-title">
          <h2>${title}</h2>
          ${intro ? html`<p class="set-card-sub">${intro}</p>` : null}
        </div>
      </div>
      ${children}
    </section>`;
}

// A switch. `role="switch"` on a real checkbox, so it keeps the native
// keyboard model; the painted track is decoration and the input covers it, so
// the touch target is the whole 52×44 box on any pointer.
function Toggle({ checked, onChange, label }) {
  return html`
    <span class=${'set-toggle' + (checked ? ' on' : '')}>
      <input type="checkbox" role="switch" checked=${!!checked}
        aria-label=${label} onChange=${onChange} />
      <span class="set-toggle-track" aria-hidden="true"><span class="set-toggle-thumb"></span></span>
    </span>`;
}

// An inline note attached to a card or a group — Primer's InlineMessage shape.
// Four tones, and each one owns a DIFFERENT glyph: colour is never the only
// channel, and a triangle that means both "careful" and "by the way" means
// neither (component-notes §8).
//   good  ✓  it is working
//   warn  ⚠  something needs a look
//   off   ✕  this feature is switched off — a state, not a severity
//   info  ⚠  reserved for anything else worth reading
const NOTE_ICON = { good: 'check', warn: 'alert', off: 'x', info: 'alert' };
function Note({ tone = 'info', children }) {
  return html`
    <p class=${'set-note set-note-' + tone}>
      <${Icon} name=${NOTE_ICON[tone] || 'alert'} size=${15} />
      <span>${children}</span>
    </p>`;
}

// ---------------------------------------------------------------------------
// General — appearance first
// ---------------------------------------------------------------------------

// app.js owns applyTheme, and importing it back here would close an import
// cycle (app.js → settings.js). This is the same two-line contract, applied
// OPTIMISTICALLY so the whole app repaints on the click rather than after the
// PATCH round-trip: the brief's "switching must not require a reload" read
// strictly — it must not require a wait either. reloadSettings() then applies
// the persisted value over the top, which is a no-op when they agree.
function previewTheme(value) {
  const root = document.documentElement;
  if (value === 'dark' || value === 'light') root.setAttribute('data-theme', value);
  else root.removeAttribute('data-theme');
}

function useSystemDark() {
  const [dark, setDark] = useState(
    () => !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches));
  useEffect(() => {
    if (!window.matchMedia) return undefined;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const on = () => setDark(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return dark;
}

// The face inside a swatch. Its colours come from the CSS system palette
// (`Canvas` / `CanvasText`) under an explicit `color-scheme`, so a light
// preview is genuinely light while the app is dark, and vice versa, without a
// single literal colour outside tokens.css.
const ThemeFace = ({ tone }) => html`
  <span class=${'theme-face theme-face-' + tone} aria-hidden="true">
    <i class="theme-bar"></i>
    <i class="theme-line"></i>
    <i class="theme-line theme-line-short"></i>
  </span>`;

function ThemeChooser({ value, onPick }) {
  const systemDark = useSystemDark();
  const options = [
    ['auto', 'Auto', `Follows this device — ${systemDark ? 'dark' : 'light'} right now`],
    ['light', 'Light', 'Always light, whatever the device does'],
    ['dark', 'Dark', 'Always dark, whatever the device does'],
  ];
  return html`
    <div class="theme-opts" role="radiogroup" aria-label="Theme">
      ${options.map(([key, name, desc]) => html`
        <label key=${key} class=${'theme-opt' + (value === key ? ' on' : '')}>
          <input type="radio" name="tk-theme" value=${key} checked=${value === key}
            onChange=${() => onPick(key)} />
          <span class=${'theme-swatch' + (key === 'auto' ? ' theme-swatch-split' : '')}>
            ${key === 'dark' ? null : html`<${ThemeFace} tone="light" />`}
            ${key === 'light' ? null : html`<${ThemeFace} tone="dark" />`}
          </span>
          <span class="theme-opt-name">
            <${Icon} name=${key === 'light' ? 'sun' : key === 'dark' ? 'moon' : 'settings'} size=${14} />
            ${name}
            <span class="theme-opt-tick"><${Icon} name="check" size=${15} /></span>
          </span>
          <span class="theme-opt-desc">${desc}</span>
        </label>`)}
    </div>`;
}

function GeneralCard({ settings, reloadSettings }) {
  const s = settings;
  const theme = s.theme || 'auto';

  // No toast: the app repainting IS the confirmation, and a toast on every
  // click of a three-way control is noise.
  async function pickTheme(value) {
    previewTheme(value);
    try {
      await api.patch('/api/settings', { theme: value });
      await reloadSettings();
    } catch (e) {
      previewTheme(theme); // the optimistic paint has to be taken back too
      emitToast(e.message, { error: true });
    }
  }

  return html`
    <${React.Fragment}>
      <${SettingsCard} title="Appearance"
        intro="Light and dark are two designs here, not one design dimmed. Pick one, or let the device decide.">
        <div class="set-rows">
          <${SettingRow} block plain label="Theme"
            hint="Applies immediately, on every screen — no reload.">
            <${ThemeChooser} value=${theme} onPick=${pickTheme} />
          <//>
          <${SettingRow} label="Float window theme"
            hint="The always-on-top timer window can differ from the app">
            <select value=${s.pip?.theme || 'app'}
              onChange=${(e) => save({ pip: { theme: e.target.value } }, reloadSettings)}>
              <option value="app">Follow the app</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          <//>
        </div>
      <//>

      <${SettingsCard} title="Your day"
        intro="What a full day looks like, and how the clock is rounded when a timer stops.">
        <div class="set-rows">
          <${SettingRow} label="Daily target (hours)" hint="Colours the calendar and the day meter">
            <input type="number" min="0" step="0.5" defaultValue=${s.targets?.dailyHours ?? 8}
              onBlur=${(e) => save({ targets: { dailyHours: Number(e.target.value) || 0 } }, reloadSettings)} />
          <//>
          <${SettingRow} label="Week starts on" hint="First column of the calendar month grid">
            <select value=${s.calendar?.weekStartsOn === 1 ? '1' : '0'}
              onChange=${(e) => save({ calendar: { weekStartsOn: Number(e.target.value) } }, reloadSettings)}>
              <option value="0">Sunday</option>
              <option value="1">Monday</option>
            </select>
          <//>
          <${SettingRow} label="Idle timer nudge (hours)" hint="Flag a running timer after this long">
            <input type="number" min="0.5" step="0.5" defaultValue=${s.idleNudgeHours ?? 3}
              onBlur=${(e) => save({ idleNudgeHours: Number(e.target.value) || 3 }, reloadSettings)} />
          <//>
          <${SettingRow} label="Rounding" hint="Applied when a timer files its hours">
            <select value=${s.rounding?.enabled ? s.rounding.mode : 'off'}
              onChange=${(e) => {
                const v = e.target.value;
                save({ rounding: v === 'off' ? { enabled: false } : { enabled: true, mode: v } }, reloadSettings);
              }}>
              <option value="nearest">Round to the nearest increment</option>
              <option value="up">Always round up</option>
              <option value="off">No rounding (raw hours)</option>
            </select>
          <//>
          <${SettingRow} label="Increment (hours)" hint="0.1 = 6-minute units">
            <input type="number" min="0.01" step="0.01" defaultValue=${s.rounding?.increment ?? 0.1}
              onBlur=${(e) => save({ rounding: { increment: Number(e.target.value) || 0.1 } }, reloadSettings)} />
          <//>
        </div>
      <//>
    <//>`;
}

// ---------------------------------------------------------------------------
// AI assist
// ---------------------------------------------------------------------------

function AiCard({ settings, reloadSettings }) {
  const [status, setStatus] = useState(null);
  const [prompt, setPrompt] = useState(null); // null = not touched yet
  const cfg = settings.ai || {};
  const reload = () => api.get('/api/ai/status').then(setStatus).catch(() => {});
  useEffect(() => { reload(); }, []);

  const effectivePrompt = prompt ?? (cfg.systemPrompt || status?.defaultPrompt || '');
  const isCustom = status && effectivePrompt.trim() !== (status.defaultPrompt || '').trim();
  const on = !!cfg.enabled;

  async function savePrompt(value) {
    // storing '' keeps the built-in default (and future improvements to it)
    const store = status && value.trim() === status.defaultPrompt.trim() ? '' : value;
    await save({ ai: { systemPrompt: store } }, reloadSettings);
  }

  // David's picks float to the top of the model list.
  const preferred = ['gemma4:12b', 'llama3.1:8b'];
  const models = status
    ? [...new Set([...preferred.filter((m) => status.models.includes(m)), ...status.models])]
    : preferred;

  return html`
    <${SettingsCard} title="AI narrative assist"
      intro=${'Uses a local model through Ollama on this machine — nothing leaves the box. '
        + 'Type a brief description in an entry and it drafts the narrative; optionally it '
        + 'splits the time into task lines.'}>
      <div class="set-rows">
        ${/* not `plain`: a real <label> makes the whole row the switch's target,
              which is what iOS's grouped settings and Polaris's SettingToggle
              both do — a 44px switch on a 358px row is a small thing to aim at
              with a thumb. */''}
        <${SettingRow} label="Enable AI assist"
          hint="Off means no model is ever called; every other field here is remembered.">
          <${Toggle} checked=${on} label="Enable AI assist"
            onChange=${async (e) => {
              await save({ ai: { enabled: e.target.checked } }, reloadSettings);
              reload();
            }} />
        <//>
      </div>

      ${/* ONE message at a time (Carbon, Material: never stack notifications
            that say the same thing twice). Off is the fact that matters when
            it is off; reachability is the fact that matters when it is on. */''}
      ${!on ? null : status ? (status.reachable
        ? html`<${Note} tone="good">Ollama is answering — ${status.models.length} model${status.models.length === 1 ? '' : 's'} installed.<//>`
        : html`<${Note} tone="warn">Ollama is not reachable at ${cfg.url}. Nothing here will run until it is.<//>`) : null}

      ${/* Teardown §15 fault 3: "Enable AI assist gates the whole card but
            nothing below it is visually disabled." The group says so now — and
            stays editable, so the model and URL can be set up before the
            feature is switched on. */''}
      <div class=${'set-group' + (on ? '' : ' set-group-off')}>
        ${on ? null : html`<${Note} tone="off">
          AI assist is off, so nothing below runs. The settings are still saved,
          and take effect the moment you turn it on.
        <//>`}
        <div class="set-rows">
          <${SettingRow} label="Model" off=${!on}>
            <select value=${cfg.model}
              onChange=${(e) => save({ ai: { model: e.target.value } }, reloadSettings)}>
              ${models.map((m) => html`<option key=${m} value=${m}>${m}</option>`)}
            </select>
          <//>
          <${SettingRow} label="Ollama URL" off=${!on}>
            <input type="text" defaultValue=${cfg.url}
              onBlur=${(e) => save({ ai: { url: e.target.value.trim() } }, reloadSettings).then(reload)} />
          <//>
          <${SettingRow} block off=${!on}
            label=${`System prompt${isCustom ? ' (custom)' : ' (default)'}`}
            hint=${'How the model is instructed. Your task-code list and the JSON output format '
              + 'are always appended automatically, so editing this cannot break the feature.'}>
            <textarea rows="7" value=${effectivePrompt} spellcheck="false"
              onInput=${(e) => setPrompt(e.target.value)}
              onBlur=${(e) => savePrompt(e.target.value)}></textarea>
          <//>
        </div>
        ${isCustom ? html`
          <div class="set-actions">
            <button class="btn btn-sm" onClick=${async () => {
              setPrompt(status.defaultPrompt);
              await savePrompt(status.defaultPrompt);
            }}>Reset to the default prompt</button>
          </div>` : null}
      </div>
    <//>`;
}

// ---------------------------------------------------------------------------
// .TIM export constants
// ---------------------------------------------------------------------------

function TimCard({ settings, reloadSettings }) {
  const cfg = settings.tim || {};
  const field = (key, label, hint) => html`
    <${SettingRow} key=${key} label=${label} hint=${hint}>
      <input type="text" defaultValue=${cfg[key] || ''}
        onBlur=${(e) => save({ tim: { [key]: e.target.value.trim() } }, reloadSettings)} />
    <//>`;
  return html`
    <${SettingsCard} title=".TIM export (DTE Axiom / TimeSaver)"
      intro="The export screen can generate a .TIM import file alongside the CSV, using these firm constants on every line.">
      <div class="set-rows">
        ${field('email', 'Timekeeper email', 'Written to the lmb / op fields')}
        ${field('timekeeperId', 'Timekeeper ID', 'Written to the tk field')}
        ${field('u2', 'U2 code', 'Written to the u2 field')}
      </div>
    <//>`;
}

// Small helper: PATCH one settings key (merged server-side) and confirm.
async function save(patch, reloadSettings) {
  await api.patch('/api/settings', patch);
  await reloadSettings();
  emitToast('Saved');
}

// ---------------------------------------------------------------------------
// Codes & shortcuts
// ---------------------------------------------------------------------------

function TaskCodesCard() {
  const [codes, setCodes] = useState(null);
  const [newName, setNewName] = useState('');

  const reload = () => api.get('/api/task-codes?includeInactive=1').then(setCodes);
  useEffect(() => { reload(); }, []);

  async function add(e) {
    e.preventDefault();
    if (!newName.trim()) return;
    try {
      await api.post('/api/task-codes', { name: newName.trim() });
      setNewName('');
      await reload();
    } catch (err) { emitToast(err.message, { error: true }); }
  }

  async function move(i, dir) {
    const ids = codes.map((c) => c.id);
    const j = i + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    await api.put('/api/task-codes/order', { ids });
    await reload();
  }

  if (!codes) {
    return html`<${SettingsCard} title="Task codes"><div class="set-rows"></div><//>`;
  }
  return html`
    <${SettingsCard} title="Task codes"
      intro="Used in task lines and on timers, in this order. Renaming or removing a code never rewrites past entries.">
      <ul class="set-list">
        ${codes.map((c, i) => html`
          <li key=${c.id} class=${'set-list-row' + (c.active ? '' : ' set-list-row-off')}>
            <span class="set-reorder">
              <button class="btn btn-icon btn-ghost btn-sm" title="Move up"
                aria-label=${`Move ${c.name} up`} disabled=${i === 0}
                onClick=${() => move(i, -1)}><${Icon} name="chevronUp" size=${16} /></button>
              <button class="btn btn-icon btn-ghost btn-sm" title="Move down"
                aria-label=${`Move ${c.name} down`} disabled=${i === codes.length - 1}
                onClick=${() => move(i, 1)}><${Icon} name="chevronDown" size=${16} /></button>
            </span>
            <input type="text" defaultValue=${c.name} aria-label=${`Task code ${c.name}`}
              onBlur=${async (e) => {
                if (e.target.value.trim() && e.target.value !== c.name) {
                  try { await api.patch(`/api/task-codes/${c.id}`, { name: e.target.value.trim() }); await reload(); }
                  catch (err) { emitToast(err.message, { error: true }); e.target.value = c.name; }
                }
              }} />
            <button class="btn btn-sm set-chip" aria-pressed=${c.active ? 'true' : 'false'}
              title=${c.active ? 'Hide from pickers' : 'Show in pickers again'}
              onClick=${async () => { await api.patch(`/api/task-codes/${c.id}`, { active: c.active ? 0 : 1 }); await reload(); }}>
              ${c.active ? 'Active' : 'Hidden'}
            </button>
            <button class="btn btn-icon btn-ghost btn-sm" title="Delete task code"
              aria-label=${`Delete task code ${c.name}`}
              onClick=${async () => {
                try { await api.del(`/api/task-codes/${c.id}`); await reload(); }
                catch (err) { emitToast(err.message, { error: true }); }
              }}><${Icon} name="trash" size=${16} /></button>
          </li>`)}
      </ul>
      <form class="set-add" onSubmit=${add}>
        <input type="text" placeholder="New task code…" aria-label="New task code"
          value=${newName} onInput=${(e) => setNewName(e.target.value)} />
        <button class="btn">Add</button>
      </form>
    <//>`;
}

// Minimal by design (spec §6): the dictionary is BUILT in-flow (select text
// in a narrative field → "save as shortcut"); Settings only lists & deletes.
function ShortcutsCard() {
  const list = useShortcuts();
  return html`
    <${SettingsCard} title="Text-expansion shortcuts"
      intro=${'Type an abbreviation in any narrative or fragment field and it expands when you hit '
        + 'space or punctuation. Add new ones in-flow: select text in a narrative field and click "＋ shortcut".'}>
      ${list.length === 0 ? html`
        <p class="set-empty">No shortcuts yet — the next one you save from a narrative will appear here.</p>` : html`
        <ul class="set-list">
          ${list.map((s) => html`
            <li key=${s.id} class="set-list-row set-list-row-pair">
              <span class="mono set-abbrev">${s.abbrev}</span>
              <span class="set-phrase">${s.phrase}</span>
              <button class="btn btn-icon btn-ghost btn-sm" title="Delete shortcut"
                aria-label=${`Delete shortcut ${s.abbrev}`}
                onClick=${async () => { await api.del(`/api/shortcuts/${s.id}`); await refreshShortcuts(); }}>
                <${Icon} name="trash" size=${16} />
              </button>
            </li>`)}
        </ul>`}
    <//>`;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function ValidationCard({ settings, reloadSettings }) {
  const v = settings.validation;
  const [phrase, setPhrase] = useState('');

  async function addPhrase(e) {
    e.preventDefault();
    const p = phrase.trim().toLowerCase();
    if (!p) return;
    await save({ validation: { bannedPhrases: [...v.bannedPhrases, p] } }, reloadSettings);
    setPhrase('');
  }

  return html`
    <${SettingsCard} title="Narrative validation"
      intro="The rules the day-close sweep checks a narrative against before it will finalize it.">
      <div class="set-rows">
        <${SettingRow} label="Minimum narrative length" hint="Warn under this many characters">
          <input type="number" min="0" defaultValue=${v.minNarrativeChars}
            onBlur=${(e) => save({ validation: { minNarrativeChars: Number(e.target.value) || 0 } }, reloadSettings)} />
        <//>
        <${SettingRow} label="Block-billing threshold" hint="Warn on a single line over this many hours">
          <input type="number" min="0.5" step="0.5" defaultValue=${v.blockBillingHours}
            onBlur=${(e) => save({ validation: { blockBillingHours: Number(e.target.value) || 3 } }, reloadSettings)} />
        <//>
        <${SettingRow} label="Minimum increment" hint="Warn on durations under this">
          <input type="number" min="0.01" step="0.01" defaultValue=${v.minIncrement}
            onBlur=${(e) => save({ validation: { minIncrement: Number(e.target.value) || 0.1 } }, reloadSettings)} />
        <//>
        <${SettingRow} block plain label="Banned vague phrases"
          hint="A narrative containing one of these is warned about before it can be finalized">
          <div class="set-chips">
            ${v.bannedPhrases.length === 0
              ? html`<span class="set-empty">None yet.</span>`
              : v.bannedPhrases.map((p) => html`
                <span key=${p} class="banned-chip">${p}
                  <button title=${`Remove "${p}"`} aria-label=${`Remove ${p}`} onClick=${() => save({
                    validation: { bannedPhrases: v.bannedPhrases.filter((x) => x !== p) },
                  }, reloadSettings)}>✕</button>
                </span>`)}
          </div>
          <form class="set-add" onSubmit=${addPhrase}>
            <input type="text" aria-label="Add a banned phrase"
              placeholder="Add phrase, e.g. “misc work”…" value=${phrase}
              onInput=${(e) => setPhrase(e.target.value)} />
            <button class="btn">Add</button>
          </form>
        <//>
      </div>
    <//>`;
}

// ---------------------------------------------------------------------------
// Remote & backups
// ---------------------------------------------------------------------------

function RemoteCard({ authState, reloadAuth }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [mode, setMode] = useState(null);
  const [status, setStatus] = useState(null);

  const reload = () => api.get('/api/auth/status').then(setStatus);
  useEffect(() => { reload(); }, []);

  const st = status || authState;

  async function setPassword(e) {
    e.preventDefault();
    try {
      await api.post('/api/auth/password', { current: current || undefined, next });
      setCurrent(''); setNext('');
      emitToast(st.passwordSet ? 'Password changed — other sessions signed out.' : 'Password set — remote access enabled.');
      await reload();
      await reloadAuth();
    } catch (err) {
      emitToast(err.status === 401 ? 'Current password is wrong.' : err.message, { error: true });
    }
  }

  async function saveMode(m) {
    setMode(m);
    await api.post('/api/auth/mode', { mode: m });
    emitToast('Saved');
    await reload();
  }

  const sessions = st.sessionCount ?? 0;

  return html`
    <${SettingsCard} title="Remote access"
      intro=${html`Reachable at ${' '}
        <a href="https://time.example.com" target="_blank">time.example.com</a>${' '}
        through the Cloudflare tunnel. Remote requests require the app password; home-network
        (LAN) use never asks by default.`}>
      ${st.passwordSet
        ? html`<${Note} tone="good">A password is set, so remote access is enabled.<//>`
        : html`<${Note} tone="warn">No password yet — remote access is disabled until you set one.<//>`}

      <div class="set-rows">
        <${SettingRow} plain label="Signed-in sessions"
          hint=${`${sessions} device${sessions === 1 ? '' : 's'} currently hold a session cookie`}>
          <button class="btn" disabled=${sessions === 0} onClick=${async () => {
            await api.post('/api/auth/sessions/revoke');
            emitToast('All sessions revoked');
            await reload();
          }}>Sign out everywhere</button>
        <//>

        <${SettingRow} block plain
          label=${st.passwordSet ? 'Change the app password' : 'Set an app password'}
          hint="Eight characters or more. Changing it signs every other device out.">
          <form class="set-form" onSubmit=${setPassword}>
            ${st.passwordSet ? html`
              <label class="set-field">
                <span class="set-field-label">Current password</span>
                <input type="password" value=${current} onInput=${(e) => setCurrent(e.target.value)} />
              </label>` : null}
            <label class="set-field">
              <span class="set-field-label">${st.passwordSet ? 'New password' : 'New password'}</span>
              <input type="password" value=${next} onInput=${(e) => setNext(e.target.value)} />
            </label>
            <button class="btn btn-primary" disabled=${next.length < 8}>
              ${st.passwordSet ? 'Change password' : 'Enable remote access'}
            </button>
          </form>
        <//>

        ${/* The labels are short enough to survive a 280px control and a 390px
              phone; the recommendation is in the hint, where it does not get
              truncated by the select. */''}
        <${SettingRow} label="Require login"
          hint=${st.passwordSet
            ? 'Remote-only is recommended: the home network stays trusted.'
            : '“Always” unlocks once a password is set.'}>
          <select value=${mode ?? st.mode} onChange=${(e) => saveMode(e.target.value)}>
            <option value="remote-only">Remote connections only</option>
            <option value="always" disabled=${!st.passwordSet}>Always, including LAN</option>
            <option value="off">Never — LAN only</option>
          </select>
        <//>
      </div>
    <//>`;
}

// ---------------------------------------------------------------------------
// Tools — the three actions that left the primary navigation, plus the
// keyboard sheet
// ---------------------------------------------------------------------------
//
// This was app.js's own `ToolsPanel`, which is why it was the one settings
// section rendering the shell's chip strip instead of the section switcher.
// Nothing about the four controls changed: Add todo still fires the same
// `tk:add-todo` event the Alt+drag feedback gesture uses, Run /todo is the same
// component with the same two-click arming, Float timer is the same
// document-picture-in-picture toggle (and is also on the running-timer bar),
// and Keyboard shortcuts still opens the same sheet.
//
// THE ONE BRIDGE IN THIS FILE, and it is deliberate: the keyboard sheet lives
// in app.js as view-local state with exactly one public entry point — the `?`
// key on the document. app.js imports this file, so importing it back to reach
// the component would close a cycle. Replaying the key it already listens for
// uses the documented entry point rather than inventing a private one, and it
// is the only route a phone has had to that sheet since the More sheet went
// away. If app.js ever grows a `tk:help` event, this becomes one line shorter.
function openKeyboardHelp() {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: '?', bubbles: true }));
}

function ToolsCard() {
  const floatable = pipSupported();
  return html`
    <${SettingsCard} title="Tools"
      intro=${'Utilities that are not part of keying time. The float window is a Chrome/Edge '
        + 'desktop feature and appears on the running-timer bar too; the two todo actions write '
        + "to this repo's own backlog."}>
      ${/* A labelled action list, not settings rows: every one of these is a
            verb with no value to set, and a row shape built for
            label-left/control-right would put the same word on both sides. Each
            is a full-width 44px target — the sidebar these came from never had
            to meet the touch floor, and here they do. */''}
      <div class="set-tools">
        <button type="button" class="set-tool"
          title="Jot a quick change onto TODO.md (no screenshot)"
          onClick=${() => window.dispatchEvent(new CustomEvent('tk:add-todo'))}>
          <${Icon} name="plus" size=${18} />
          <span>Add todo</span>
        </button>
        <${RunTodo} />
        ${floatable ? html`
          <button type="button" class="set-tool"
            title="Float a tiny always-on-top timer window (SPIKE — Chrome only)"
            onClick=${() => toggleTimerPip().catch((e) => emitToast(String(e.message || e), { error: true }))}>
            <${Icon} name="copy" size=${18} />
            <span>Float timer</span>
          </button>` : null}
        <button type="button" class="set-tool" onClick=${openKeyboardHelp}>
          <${Icon} name="keyboard" size=${18} />
          <span>Keyboard shortcuts</span>
        </button>
      </div>
      ${floatable ? null : html`<${Note} tone="off">
        The float window needs Chrome or Edge on a desktop — this browser does
        not offer it.
      <//>`}
    <//>`;
}

function BackupCard({ settings, reloadSettings }) {
  const [backups, setBackups] = useState([]);
  useEffect(() => { api.get('/api/backup/list').then(setBackups).catch(() => {}); }, []);

  return html`
    <${SettingsCard} title="Backups"
      intro=${`A snapshot of the database is written nightly to data/backups/ and pruned to the most recent ${settings.backup?.keep ?? 14}.`}>
      <div class="set-rows">
        <${SettingRow} plain label="Download a copy now"
          hint="The .db file is the whole database; the JSON dump is readable without SQLite.">
          <span class="set-actions">
            <a class="btn" href="/api/backup/db"><${Icon} name="download" size=${16} /> Database</a>
            <a class="btn" href="/api/backup/json"><${Icon} name="download" size=${16} /> JSON</a>
          </span>
        <//>
        <${SettingRow} label="Keep this many nightly backups" hint="Older snapshots are pruned">
          <input type="number" min="1" defaultValue=${settings.backup?.keep ?? 14}
            onBlur=${(e) => save({ backup: { keep: Number(e.target.value) || 14 } }, reloadSettings)} />
        <//>
      </div>
      ${backups.length > 0 ? html`
        <p class="set-empty">
          On disk: ${backups.slice(0, 3).map((b) => b.name).join(', ')}${backups.length > 3 ? ` … +${backups.length - 3} more` : ''}
        </p>` : null}
    <//>`;
}
