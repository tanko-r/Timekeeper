import { api } from '/js/api.js';
import { html, React, useState, useEffect, useCallback, Spinner, Icon } from '/js/ui.js';
import { LoginView } from '/js/views/login.js';
import { DashboardView } from '/js/views/dashboard.js';
import { DayView } from '/js/views/day.js';
import { CalendarView } from '/js/views/calendar.js';
import { SearchView } from '/js/views/search.js';
import { StatsView } from '/js/views/stats.js';
import { SettingsView } from '/js/views/settings.js';
import { CmsView } from '/js/views/cms.js';
import { ExportView } from '/js/views/exportview.js';
import { EntryEditor } from '/js/components/entryeditor.js';

const { createRoot } = window.ReactDOM;

// ---------- routing ----------

function parseHash() {
  const h = (location.hash || '#/').replace(/^#/, '');
  const [path, ...rest] = h.split('/').filter(Boolean);
  return { path: path || 'dashboard', args: rest };
}

export function nav(to) {
  location.hash = to;
}

const NAV = [
  ['dashboard', 'Dashboard', 'layout'],
  ['calendar', 'Calendar', 'calendar'],
  ['search', 'Search', 'search'],
  ['stats', 'Stats', 'stats'],
  ['cms', 'Clients/Matters', 'briefcase'],
  ['export', 'Export', 'export'],
  ['settings', 'Settings', 'settings'],
];

// ---------- theme ----------

function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === 'dark' || theme === 'light') root.setAttribute('data-theme', theme);
  else root.removeAttribute('data-theme');
}

// ---------- toasts ----------

function ToastHost() {
  const [toasts, setToasts] = useState([]);
  useEffect(() => {
    let n = 0;
    const onToast = (e) => {
      const id = ++n;
      const t = { id, ...e.detail };
      setToasts((list) => [...list.slice(-2), t]);
      const ttl = t.actionLabel ? 8000 : 4000;
      setTimeout(() => setToasts((list) => list.filter((x) => x.id !== id)), ttl);
    };
    window.addEventListener('tk:toast', onToast);
    return () => window.removeEventListener('tk:toast', onToast);
  }, []);
  return html`
    <div class="toast-host">
      ${toasts.map((t) => html`
        <div key=${t.id} class=${'toast' + (t.error ? ' error' : '')}>
          <span>${t.message}</span>
          ${t.actionLabel ? html`
            <button onClick=${() => { t.action(); setToasts((l) => l.filter((x) => x.id !== t.id)); }}>
              ${t.actionLabel}
            </button>` : null}
        </div>`)}
    </div>`;
}

// ---------- keyboard help ----------

function KeyboardHelp({ onClose }) {
  const rows = [
    ['n', 'New time entry'],
    ['t', 'Start / stop the last-used timer'],
    ['/', 'Jump to search'],
    ['g then d / c / s / e', 'Go to Dashboard / Calendar / Stats / Export'],
    ['[ and ]', 'Previous / next day (day view)'],
    ['Ctrl+Enter', 'Save and close the entry editor'],
    ['Esc', 'Close dialogs'],
    ['?', 'This help'],
    ['Tab / click', 'Focus the timer grid'],
    ['← → ↑ ↓', 'Move between timer cards'],
    ['Enter or Space', 'Start–stop the focused timer'],
    ['a–z, 0–9', 'Filter the grid in place (Esc clears)'],
    ['Alt+↑ / Alt+↓', 'Nudge the focused timer ±0.1h (+Shift: ±0.2h)'],
    ['Shift+Enter', 'Edit the focused timer'],
    ['Ctrl+Enter (grid)', 'Open the focused timer’s entry'],
  ];
  return html`
    <div class="modal-backdrop" onClick=${(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div class="modal kbd-help">
        <div class="modal-head"><h3>Keyboard shortcuts</h3>
          <button class="btn btn-ghost" onClick=${onClose}>✕</button></div>
        <div class="modal-body">
          <table>${rows.map(([k, d]) => html`
            <tr key=${k}><td><kbd>${k}</kbd></td><td>${d}</td></tr>`)}
          </table>
        </div>
      </div>
    </div>`;
}

// ---------- app root ----------

function App() {
  const [authState, setAuthState] = useState(null); // null=loading
  const [settings, setSettings] = useState(null);
  const [route, setRoute] = useState(parseHash());
  const [editor, setEditor] = useState(null); // {id} | {template:{...}} | null
  const [showHelp, setShowHelp] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  const reloadAuth = useCallback(async () => {
    try {
      const status = await api.get('/api/auth/status');
      setAuthState(status);
      if (!status.authRequired || status.loggedIn) {
        const s = await api.get('/api/settings');
        setSettings(s);
        applyTheme(s.theme);
      }
    } catch (e) {
      if (e.status !== 401) setAuthState({ error: String(e.message) });
    }
  }, []);

  useEffect(() => { reloadAuth(); }, [reloadAuth]);

  useEffect(() => {
    const onHash = () => setRoute(parseHash());
    const onAuthRequired = () => reloadAuth();
    window.addEventListener('hashchange', onHash);
    window.addEventListener('tk:auth-required', onAuthRequired);
    return () => {
      window.removeEventListener('hashchange', onHash);
      window.removeEventListener('tk:auth-required', onAuthRequired);
    };
  }, [reloadAuth]);

  // Refresh views when the editor closes with changes or timers write entries.
  const bumpRefresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  const openEditor = useCallback((spec) => setEditor(spec), []);
  const closeEditor = useCallback((changed) => {
    setEditor(null);
    if (changed) bumpRefresh();
  }, [bumpRefresh]);

  const reloadSettings = useCallback(async () => {
    const s = await api.get('/api/settings');
    setSettings(s);
    applyTheme(s.theme);
    return s;
  }, []);

  // global shortcuts
  useEffect(() => {
    let pendingG = false;
    let gTimer = null;
    const onKey = (e) => {
      const tag = (e.target.tagName || '').toLowerCase();
      const typing = ['input', 'textarea', 'select'].includes(tag) || e.target.isContentEditable;
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (editor) return; // editor handles its own keys
      if (pendingG) {
        pendingG = false;
        clearTimeout(gTimer);
        const map = { d: '#/', c: '#/calendar', s: '#/stats', e: '#/export' };
        if (map[e.key]) { nav(map[e.key]); e.preventDefault(); }
        return;
      }
      if (e.key === 'g') {
        pendingG = true;
        gTimer = setTimeout(() => { pendingG = false; }, 900);
      } else if (e.key === 'n') {
        e.preventDefault();
        openEditor({ template: {} });
      } else if (e.key === '/') {
        e.preventDefault();
        nav('#/search');
        setTimeout(() => document.querySelector('[data-search-q]')?.focus(), 80);
      } else if (e.key === 't') {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent('tk:toggle-last-timer'));
        if (route.path !== 'dashboard') nav('#/');
      } else if (e.key === '?') {
        setShowHelp(true);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [editor, openEditor, route.path]);

  if (!authState) return html`<${Spinner} />`;
  if (authState.error) return html`<div class="login-wrap"><div class="card login-card">
    <h2>Timekeeper can’t reach its server</h2><p class="muted">${authState.error}</p></div></div>`;
  if (authState.authRequired && !authState.loggedIn) {
    return html`<${LoginView} passwordSet=${authState.passwordSet} onLogin=${reloadAuth} />`;
  }
  if (!settings) return html`<${Spinner} />`;

  const ctx = { settings, reloadSettings, openEditor, refreshKey, bumpRefresh };

  const view = {
    dashboard: () => html`<${DashboardView} ...${ctx} />`,
    day: () => html`<${DayView} date=${route.args[0]} ...${ctx} />`,
    calendar: () => html`<${CalendarView} ...${ctx} />`,
    search: () => html`<${SearchView} ...${ctx} />`,
    stats: () => html`<${StatsView} ...${ctx} />`,
    settings: () => html`<${SettingsView} ...${ctx} authState=${authState} reloadAuth=${reloadAuth} />`,
    cms: () => html`<${CmsView} ...${ctx} />`,
    export: () => html`<${ExportView} ...${ctx} />`,
  }[route.path] || (() => html`<div class="card">Not found. <a href="#/">Go home</a></div>`);

  const active = route.path === 'day' ? 'calendar' : route.path;

  return html`
    <div class="shell">
      <nav class="sidebar">
        <div class="brand"><${Icon} name="timer" size=${21} /> Time<span>keeper</span></div>
        ${NAV.map(([path, label, icon]) => html`
          <button key=${path}
            class=${'navlink' + (active === path ? ' active' : '')}
            onClick=${() => nav(path === 'dashboard' ? '#/' : `#/${path}`)}>
            <${Icon} name=${icon} size=${18} /> ${label}
          </button>`)}
        <div class="foot">Press <kbd>?</kbd> for shortcuts</div>
      </nav>
      <main class="main">${view()}</main>
    </div>
    <${ToastHost} />
    ${editor ? html`<${EntryEditor} spec=${editor} settings=${settings} onClose=${closeEditor} />` : null}
    ${showHelp ? html`<${KeyboardHelp} onClose=${() => setShowHelp(false)} />` : null}
  `;
}

// Backstop: any un-caught API failure still tells the user what happened
// (401s are handled by the login flow, so skip those).
window.addEventListener('unhandledrejection', (e) => {
  const reason = e.reason || {};
  if (reason.status === 401) return;
  window.dispatchEvent(new CustomEvent('tk:toast', {
    detail: { message: String(reason.message || reason), error: true },
  }));
});

createRoot(document.getElementById('root')).render(html`<${App} />`);
