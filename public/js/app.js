import { api, accessSignInUrl } from '/js/api.js';
import { html, React, useState, useEffect, useCallback, Spinner, Icon } from '/js/ui.js';
import { runningTitle, IDLE_ICON, RUNNING_ICON } from '/js/lib/titlebar.js';
import { LoginView } from '/js/views/login.js';
import { DashboardView } from '/js/views/dashboard.js';
import { DayView } from '/js/views/day.js';
import { CalendarView } from '/js/views/calendar.js';
import { SearchView } from '/js/views/search.js';
import { StatsView } from '/js/views/stats.js';
import { SettingsView, SETTINGS_CATEGORIES } from '/js/views/settings.js';
import { CmsView } from '/js/views/cms.js';
import { ExportView } from '/js/views/exportview.js';
import { EntryEditor } from '/js/components/entryeditor.js';
import { QuickCapture } from '/js/components/quickcapture.js';
import { FeedbackCapture } from '/js/components/feedback.js';
import { RunTodo } from '/js/components/runtodo.js';
import { pipSupported, toggleTimerPip } from '/js/lib/pip.js';

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

function applyTheme(settings) {
  const root = document.documentElement;
  const theme = settings.theme;
  if (theme === 'dark' || theme === 'light') root.setAttribute('data-theme', theme);
  else root.removeAttribute('data-theme');
  // The float's own theme override (Settings → Float timer theme) rides along
  // as data-pip-theme — pip.js watches both attributes and prefers this one.
  const pipTheme = settings.pip?.theme;
  if (pipTheme === 'dark' || pipTheme === 'light') root.setAttribute('data-pip-theme', pipTheme);
  else root.removeAttribute('data-pip-theme');
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
  // Raw backdrop div (not the shared Modal — kbd-help styling is custom), so
  // Escape handling has to be added by hand here.
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const rows = [
    ['n', 'New time entry'],
    ['t', 'Start / stop the last-used timer'],
    ['c', 'Close the day (dashboard)'],
    ['s', 'Summary of the day in view as plain text'],
    ['/', 'Search — timers on the dashboard, everything elsewhere'],
    ['g then d / c / s / e', 'Go to Dashboard / Calendar / Stats / Export'],
    ['[ and ]', 'Previous / next day (day view)'],
    ['Ctrl+Enter', 'Save and close the entry editor'],
    ['Esc', 'Close dialogs'],
    ['q', 'Quick capture — bill from a sentence'],
    ['?', 'This help'],
    ['Tab / click', 'Focus the timer grid'],
    ['← → ↑ ↓', 'Move between timer cards'],
    ['Enter or Space', 'Start–stop the focused timer'],
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
  const [quickCapture, setQuickCapture] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [accessExpired, setAccessExpired] = useState(false);

  const reloadAuth = useCallback(async () => {
    try {
      const status = await api.get('/api/auth/status');
      setAuthState(status);
      if (!status.authRequired || status.loggedIn) {
        const s = await api.get('/api/settings');
        setSettings(s);
        applyTheme(s);
      }
    } catch (e) {
      if (e.status !== 401) setAuthState({ error: String(e.message) });
    }
  }, []);

  useEffect(() => { reloadAuth(); }, [reloadAuth]);

  useEffect(() => {
    const onHash = () => setRoute(parseHash());
    const onAuthRequired = () => reloadAuth();
    const onAccessExpired = () => setAccessExpired(true);
    window.addEventListener('hashchange', onHash);
    window.addEventListener('tk:auth-required', onAuthRequired);
    window.addEventListener('tk:access-expired', onAccessExpired);
    return () => {
      window.removeEventListener('hashchange', onHash);
      window.removeEventListener('tk:auth-required', onAuthRequired);
      window.removeEventListener('tk:access-expired', onAccessExpired);
    };
  }, [reloadAuth]);

  // Refresh views when the editor closes with changes or timers write entries.
  const bumpRefresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  // api.js announces every successful entry write (tk:entries-changed) —
  // including ones made from the PiP float, which the dashboard otherwise
  // never hears about (its entry panel has no poll, only refreshKey).
  useEffect(() => {
    window.addEventListener('tk:entries-changed', bumpRefresh);
    return () => window.removeEventListener('tk:entries-changed', bumpRefresh);
  }, [bumpRefresh]);

  // The float's "Open entry" button (2026-07-15 feedback): pip.js dispatches
  // this on the main window — the editor modal is app-level state, so it has
  // to open from here.
  useEffect(() => {
    const onOpenEntry = (e) => setEditor({ id: e.detail.id });
    window.addEventListener('tk:open-entry', onOpenEntry);
    return () => window.removeEventListener('tk:open-entry', onOpenEntry);
  }, []);

  // Running-timer presence in the OS chrome: the tab title (which is also the
  // installed PWA's taskbar hover preview) carries the live clock + timer
  // name, and the favicon gains a red recording dot. App-level (not
  // TimerGrid) so it stays live on every view; a light 5s poll plus a 1s
  // title tick, re-kicked by refreshKey so timer actions show up promptly.
  useEffect(() => {
    if (!settings) return undefined; // not logged in — leave the chrome alone
    let timers = null;
    let fetchedAt = 0;
    let alive = true;
    const poll = () => api.get('/api/timers')
      .then((t) => { if (alive) { timers = t; fetchedAt = Date.now(); } })
      .catch(() => {});
    poll();
    const p = setInterval(poll, 5000);
    window.addEventListener('tk:timers-changed', poll);
    let badged = null;
    const apply = () => {
      const { title, running } = runningTitle(timers, Date.now(), fetchedAt);
      if (document.title !== title) document.title = title;
      const link = document.querySelector('link[rel="icon"]');
      const want = running ? RUNNING_ICON : IDLE_ICON;
      if (link && link.getAttribute('href') !== want) {
        // replace the node, not just href — some browsers ignore in-place swaps
        const fresh = link.cloneNode();
        fresh.setAttribute('href', want);
        link.replaceWith(fresh);
      }
      // The installed PWA's taskbar icon is fixed by the manifest — the
      // OS-supported running signal there is an app badge on the icon.
      if (navigator.setAppBadge && badged !== running) {
        badged = running;
        (running ? navigator.setAppBadge() : navigator.clearAppBadge()).catch(() => {});
      }
    };
    const t = setInterval(apply, 1000);
    return () => {
      alive = false;
      clearInterval(p);
      clearInterval(t);
      window.removeEventListener('tk:timers-changed', poll);
      document.title = 'Timekeeper';
    };
  }, [settings, refreshKey]);

  const openEditor = useCallback((spec) => setEditor(spec), []);
  const closeEditor = useCallback((changed) => {
    setEditor(null);
    if (changed) bumpRefresh();
  }, [bumpRefresh]);

  const reloadSettings = useCallback(async () => {
    const s = await api.get('/api/settings');
    setSettings(s);
    applyTheme(s);
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
      // The editor and the quick-capture palette own their keys. While the
      // palette is open, ALL global shortcuts must stay dead: a chip click
      // moves focus off its input, and e.g. `n` would then open an editor
      // invisibly UNDER the qc backdrop (z-index 100 vs 300).
      if (editor || quickCapture) return;
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
        if (route.path === 'dashboard') {
          window.dispatchEvent(new CustomEvent('tk:timer-search'));
        } else {
          nav('#/search');
          setTimeout(() => document.querySelector('[data-search-q]')?.focus(), 80);
        }
      } else if (e.key === 't') {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent('tk:toggle-last-timer'));
        if (route.path !== 'dashboard') nav('#/');
      } else if (e.key === 'q') {
        if (showHelp) return; // don't open the palette under the help overlay
        e.preventDefault();
        setQuickCapture(true);
      } else if (e.key === 'c' && route.path === 'dashboard') {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent('tk:close-day'));
      } else if (e.key === 's' && (route.path === 'dashboard' || route.path === 'day')) {
        // whichever of the two views is mounted answers this
        e.preventDefault();
        window.dispatchEvent(new CustomEvent('tk:day-summary'));
      } else if (e.key === '?') {
        setShowHelp(true);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [editor, openEditor, route.path, showHelp, quickCapture]);

  // Cloudflare Access expired (remote only). Checked before the spinner: on a
  // cold load every call 401s, so authState never arrives and the app would
  // otherwise spin forever. Reloading is a top-level navigation, which Access
  // IS allowed to redirect — that's the hop to the login page. Deliberately a
  // button, not an automatic reload: a half-typed narrative shouldn't vanish
  // because a token aged out.
  if (accessExpired) {
    return html`<div class="login-wrap"><div class="card login-card">
      <h2>Remote session expired</h2>
      <p class="muted">Cloudflare needs you to sign in again before Timekeeper
        can reach its server. Your unsaved work stays until you continue.</p>
      <button class="btn btn-primary btn-lg"
        onClick=${() => location.replace(accessSignInUrl(Date.now(), location.hash))}>
        Sign in again
      </button>
    </div></div>`;
  }
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
    settings: () => html`<${SettingsView} page=${route.args[0]} ...${ctx} authState=${authState} reloadAuth=${reloadAuth} />`,
    cms: () => html`<${CmsView} ...${ctx} />`,
    // #/export/<filter>/<from> — the dashboard's attention pills deep-link here
    export: () => html`<${ExportView} focus=${route.args[0]} focusFrom=${route.args[1]} ...${ctx} />`,
  }[route.path] || (() => html`<div class="card">Not found. <a href="#/">Go home</a></div>`);

  const active = route.path === 'day' ? 'calendar' : route.path;

  return html`
    <div class="shell">
      <nav class="sidebar">
        <div class="brand"><${Icon} name="timer" size=${21} /> Time<span>keeper</span></div>
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
        <button class="navlink" title="Jot a quick change onto TODO.md (no screenshot)"
          onClick=${() => window.dispatchEvent(new CustomEvent('tk:add-todo'))}>
          <${Icon} name="plus" size=${18} /> Add todo
        </button>
        <${RunTodo} />
        ${pipSupported() ? html`
          <button class="navlink" title="Float a tiny always-on-top timer window (SPIKE — Chrome only)"
            onClick=${() => toggleTimerPip().catch((e) =>
              window.dispatchEvent(new CustomEvent('tk:toast', { detail: { message: String(e.message || e), error: true } })))}>
            <${Icon} name="copy" size=${18} /> Float timer
          </button>` : null}
        <div class="foot">Press <kbd>?</kbd> for shortcuts</div>
      </nav>
      <main class="main">${view()}</main>
    </div>
    <${ToastHost} />
    <${FeedbackCapture} />
    ${editor ? html`<${EntryEditor} spec=${editor} settings=${settings} onClose=${closeEditor} />` : null}
    ${showHelp ? html`<${KeyboardHelp} onClose=${() => setShowHelp(false)} />` : null}
    ${quickCapture ? html`<${QuickCapture} onClose=${() => setQuickCapture(false)} onFiled=${bumpRefresh} />` : null}
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
