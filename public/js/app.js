import { api, accessSignInUrl } from '/js/api.js';
import { html, React, useState, useEffect, useRef, useCallback, Spinner, Icon } from '/js/ui.js';
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
import { Overlay, overlayOpen } from '/js/components/overlay.js';
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

// ---------- overlay dismissal ----------
//
// Hardware Back is the primary dismiss gesture in the installed Android PWA,
// and before this the app could be wedged with it: open the entry editor on
// #/, press Back, and the route became #/calendar while the editor stayed
// mounted on top of it, swallowing every other shortcut. Two rules together
// close that off — see also the route effect in App(), which unmounts every
// overlay whenever the route changes, whatever caused it.
//
// This hook is rule one: opening an overlay pushes a marker history entry at
// the SAME url, so the route does not move. Back pops the marker, the hook
// hears popstate and closes the overlay instead of navigating. Closing the
// overlay any other way (Escape, ✕, save) consumes the marker with
// history.back(), but only while the marker is still the current entry —
// otherwise something else has navigated and going back would undo it.
//
// Nested overlays are LIFO: after a pop, whichever hook still sees its own
// token as the current entry stays open, so Back dismisses one layer at a
// time rather than collapsing the stack.
function useBackDismiss(open, close) {
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!open) return undefined;
    const token = `tk-overlay-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    history.pushState({ tkOverlay: token }, '');
    let marked = true;
    const onPop = () => {
      // Our marker is still the current entry: a layer above us was popped,
      // not us.
      if (history.state && history.state.tkOverlay === token) return;
      marked = false;
      closeRef.current();
    };
    window.addEventListener('popstate', onPop);
    return () => {
      window.removeEventListener('popstate', onPop);
      if (marked && history.state && history.state.tkOverlay === token) history.back();
    };
  }, [open]);
}

// Destinations. The fourth field is the one-word label used where there is no
// room for the full one: the tablet rail (76px) and the phone bottom bar.
const NAV = [
  ['dashboard', 'Dashboard', 'layout', 'Today'],
  ['calendar', 'Calendar', 'calendar', 'Calendar'],
  ['search', 'Search', 'search', 'Search'],
  ['stats', 'Stats', 'stats', 'Stats'],
  ['cms', 'Clients/Matters', 'briefcase', 'Clients'],
  ['export', 'Export', 'export', 'Export'],
  ['settings', 'Settings', 'settings', 'Settings'],
];

// Phone bottom bar: four destinations plus More. Material 3 caps a navigation
// bar at five items and Apple HIG at five before a "More" tab, so the three
// lowest-frequency destinations move into the More sheet rather than being
// crushed into the bar. These four are the daily chain: today's work, the day
// you are looking for, finding an old narrative, sending the CSV.
const BOTTOM_NAV = ['dashboard', 'calendar', 'search', 'export'];
const SHEET_NAV = NAV.filter(([p]) => !BOTTOM_NAV.includes(p)).map(([p]) => p);

const routeOf = (path) => (path === 'dashboard' ? '#/' : `#/${path}`);

// One nav row, used by the sidebar, the rail and the More sheet. Both labels
// are always in the DOM; CSS shows whichever one fits the width.
function NavLink({ path, label, icon, short, active, onNav }) {
  return html`
    <button
      class=${'navlink' + (active ? ' active' : '')}
      aria-current=${active ? 'page' : undefined}
      onClick=${() => { nav(routeOf(path)); if (onNav) onNav(); }}>
      <span class="navlink-ind"><${Icon} name=${icon} size=${18} /></span>
      <span class="navlink-label">${label}</span>
      <span class="navlink-short">${short}</span>
    </button>`;
}

// The action group — things that DO something rather than places to go. Same
// three items on every width; only where they live changes (sidebar group on
// desktop, icon column in the rail, More sheet on a phone).
function NavActions({ onDone }) {
  const after = () => { if (onDone) onDone(); };
  return html`
    <${React.Fragment}>
      <button class="navlink" title="Jot a quick change onto TODO.md (no screenshot)"
        onClick=${() => { window.dispatchEvent(new CustomEvent('tk:add-todo')); after(); }}>
        <span class="navlink-ind"><${Icon} name="plus" size=${18} /></span>
        <span class="navlink-label">Add todo</span>
        <span class="navlink-short">Todo</span>
      </button>
      <${RunTodo} />
      ${pipSupported() ? html`
        <button class="navlink" title="Float a tiny always-on-top timer window (SPIKE — Chrome only)"
          onClick=${() => { toggleTimerPip().catch((e) => window.dispatchEvent(
            new CustomEvent('tk:toast', { detail: { message: String(e.message || e), error: true } }))); after(); }}>
          <span class="navlink-ind"><${Icon} name="copy" size=${18} /></span>
          <span class="navlink-label">Float timer</span>
          <span class="navlink-short">Float</span>
        </button>` : null}
    <//>`;
}

// Phone overflow: a modal bottom sheet. It rides the shared Overlay primitive
// like every other dialog, so the scrim, the focus trap, Escape-restores-focus,
// the scroll lock and the inert background all come from one place — including
// the bottom bar it was opened from, which used to stay live underneath it.
// Everything the bottom bar could not hold lives here, one thumb-reach from it.
function NavSheet({ active, onClose, onHelp }) {
  useEffect(() => {
    // The sheet only exists below the bottom-bar breakpoint. If the viewport
    // grows past it (a phone turned landscape), CSS would hide the sheet while
    // the trap kept holding focus — so close it instead.
    const wide = window.matchMedia('(min-width: 768px)');
    const onWide = (e) => { if (e.matches) onClose(); };
    wide.addEventListener('change', onWide);
    return () => wide.removeEventListener('change', onWide);
  }, [onClose]);

  return html`
    <${Overlay} title=${null} label="More" className="navsheet" onClose=${() => onClose()}>
      <div class="nav-group">
        <div class="nav-label">Go to</div>
        ${NAV.filter(([p]) => SHEET_NAV.includes(p)).map(([path, label, icon, short]) => html`
          <${NavLink} key=${path} path=${path} label=${label} icon=${icon} short=${short}
            active=${active === path} onNav=${onClose} />`)}
      </div>
      <div class="nav-group nav-actions">
        <div class="nav-label">Actions</div>
        <${NavActions} onDone=${onClose} />
        <button class="navlink" onClick=${() => { onClose(); onHelp(); }}>
          <span class="navlink-ind"><${Icon} name="keyboard" size=${18} /></span>
          <span class="navlink-label">Keyboard shortcuts</span>
          <span class="navlink-short">Keys</span>
        </button>
      </div>
    <//>`;
}

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
    <${Overlay} title="Keyboard shortcuts" className="kbd-help" onClose=${() => onClose()}>
      <table>${rows.map(([k, d]) => html`
        <tr key=${k}><td><kbd>${k}</kbd></td><td>${d}</td></tr>`)}
      </table>
    <//>`;
}

// ---------- app root ----------

function App() {
  const [authState, setAuthState] = useState(null); // null=loading
  const [settings, setSettings] = useState(null);
  const [route, setRoute] = useState(parseHash());
  const [editor, setEditor] = useState(null); // {id} | {template:{...}} | null
  const [showHelp, setShowHelp] = useState(false);
  const [quickCapture, setQuickCapture] = useState(false);
  const [navSheet, setNavSheet] = useState(false); // phone "More" bottom sheet
  const [refreshKey, setRefreshKey] = useState(0);
  const [accessExpired, setAccessExpired] = useState(false);
  const pagenavRef = useRef(null);

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

  // Rule two of overlay dismissal (see useBackDismiss above): a route change
  // unmounts EVERY overlay, however the navigation was made — a nav link, a
  // `g d`, a deep link, a Back that moved the hash. An overlay left mounted
  // over a screen it was not opened from wedges the app: it keeps the modal
  // backdrop and its focus trap while the page underneath has changed, and
  // every global shortcut stays dead behind it.
  useEffect(() => {
    setNavSheet(false);
    setEditor(null);
    setShowHelp(false);
    setQuickCapture(false);
  }, [route]);

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

  // Below 1024px the Settings categories are a single horizontally scrollable
  // chip strip (see .pagenav in shell.css). Six chips do not fit a phone, so
  // the one you are actually on has to be brought into view — otherwise
  // landing on "Remote & backups" shows a strip that starts at "General" and
  // looks like nothing is selected. Scrolling the STRIP (not scrollIntoView)
  // is deliberate: it can only ever move sideways, so the page itself never
  // jumps under the reader.
  //
  // The wave-0 critic then found the other half of the problem: a strip that
  // scrolls but never SAYS so — "hard-cut at the right viewport edge mid-word
  // ('Codes & shor'), with no fade, no peeking partial pill and no scroll
  // affordance; Validation and Remote & backups are entirely off-screen with
  // nothing to suggest they exist." Mature scrollable-tab implementations
  // always signal the overflow, so the strip publishes which edges have more
  // beyond them (`data-overflow`) and shell.css fades exactly those.
  useEffect(() => {
    const box = pagenavRef.current;
    if (!box) return undefined;
    const el = box.querySelector('.pagenav-item.active');
    if (el && box.scrollWidth > box.clientWidth) {
      box.scrollLeft = Math.max(0, el.offsetLeft - (box.clientWidth - el.offsetWidth) / 2);
    }
    const mark = () => {
      const max = box.scrollWidth - box.clientWidth;
      box.dataset.overflow = max <= 1 ? 'none'
        : box.scrollLeft <= 1 ? 'end'
          : box.scrollLeft >= max - 1 ? 'start' : 'both';
    };
    mark();
    box.addEventListener('scroll', mark, { passive: true });
    const ro = new ResizeObserver(mark);
    ro.observe(box);
    return () => { box.removeEventListener('scroll', mark); ro.disconnect(); };
    // `settings` is in here because it is what gates the whole shell: on a cold
    // load this effect runs once against the loading spinner, when there is no
    // strip in the DOM yet, and the route never changes afterwards — so with
    // [route] alone neither the fade nor the scroll-into-view ever ran on the
    // screen you actually landed on.
  }, [route, settings]);

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
  const closeHelp = useCallback(() => setShowHelp(false), []);
  const closeQuickCapture = useCallback(() => setQuickCapture(false), []);
  const closeNavSheet = useCallback(() => setNavSheet(false), []);

  // Back / the Android gesture dismisses the top overlay instead of leaving
  // the screen under it. Order is irrelevant — each hook owns its own marker.
  useBackDismiss(!!editor, closeEditor);
  useBackDismiss(showHelp, closeHelp);
  useBackDismiss(quickCapture, closeQuickCapture);
  useBackDismiss(navSheet, closeNavSheet);

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
      // A dialog owns the keyboard while it is up. ALL global shortcuts stay
      // dead: a chip click moves focus off its input, and e.g. `n` would then
      // open an editor invisibly UNDER the scrim. `overlayOpen()` is the
      // primitive's own answer, so this now covers every dialog in the app —
      // the close-out sweep and the summary included, which this handler could
      // not see before (they are view-local state) and which each had to fence
      // the keyboard themselves. Escape belongs to the topmost overlay.
      if (editor || quickCapture || navSheet || overlayOpen()) return;
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
  }, [editor, openEditor, route.path, showHelp, quickCapture, navSheet]);

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
  // Same fallback SettingsView applies to its own content: an unknown category
  // (a stale bookmark, a typo'd deep link) renders General, so the strip has to
  // say General too. Without this the shell showed six chips with none of them
  // active above a General page — the one state where the nav lies about where
  // you are.
  const rawSettingsPage = route.args[0] || 'general';
  const settingsPage = SETTINGS_CATEGORIES.some(([k]) => k === rawSettingsPage)
    ? rawSettingsPage : 'general';
  const moreActive = SHEET_NAV.includes(active);

  return html`
    <div class="shell">
      <nav class="sidebar" aria-label="Main">
        <div class="brand">
          <${Icon} name="timer" size=${21} />
          <span class="brand-word">Time<span>keeper</span></span>
        </div>
        <div class="nav-group">
          <div class="nav-label">Go to</div>
          ${NAV.map(([path, label, icon, short]) => html`
            <${React.Fragment} key=${path}>
              <${NavLink} path=${path} label=${label} icon=${icon} short=${short}
                active=${active === path} />
              ${path === 'settings' && active === 'settings' ? html`
                <div class="subnav">
                  ${SETTINGS_CATEGORIES.map(([key, sub]) => html`
                    <button key=${key}
                      class=${'subnavlink' + (settingsPage === key ? ' active' : '')}
                      aria-current=${settingsPage === key ? 'page' : undefined}
                      onClick=${() => nav(`#/settings/${key}`)}>${sub}</button>`)}
                </div>` : null}
            <//>`)}
        </div>
        <div class="nav-group nav-actions">
          <div class="nav-label">Actions</div>
          <${NavActions} />
        </div>
        <div class="foot">Press <kbd>?</kbd> for shortcuts</div>
      </nav>
      <main class=${'main' + (active === 'settings' ? ' main-pagenav' : '')}>
        ${active === 'settings' ? html`
          <div class="pagenav" role="group" aria-label="Settings sections" ref=${pagenavRef}>
            ${SETTINGS_CATEGORIES.map(([key, sub]) => html`
              <button key=${key}
                class=${'pagenav-item' + (settingsPage === key ? ' active' : '')}
                aria-current=${settingsPage === key ? 'page' : undefined}
                onClick=${() => nav(`#/settings/${key}`)}>${sub}</button>`)}
          </div>` : null}
        ${view()}
      </main>
    </div>
    <nav class="botnav" aria-label="Main">
      ${NAV.filter(([path]) => BOTTOM_NAV.includes(path)).map(([path, label, icon, short]) => html`
        <button key=${path}
          class=${'botnav-item' + (active === path ? ' active' : '')}
          aria-current=${active === path ? 'page' : undefined}
          title=${label}
          onClick=${() => nav(routeOf(path))}>
          <span class="botnav-ind"><${Icon} name=${icon} size=${20} /></span>
          <span class="botnav-label">${short}</span>
        </button>`)}
      <button class=${'botnav-item' + (moreActive ? ' active' : '')}
        aria-haspopup="dialog" aria-expanded=${navSheet ? 'true' : 'false'}
        onClick=${() => setNavSheet(true)}>
        <span class="botnav-ind"><${Icon} name="more" size=${20} /></span>
        <span class="botnav-label">More</span>
      </button>
    </nav>
    ${navSheet ? html`
      <${NavSheet} active=${active} onClose=${closeNavSheet}
        onHelp=${() => setShowHelp(true)} />` : null}
    <${ToastHost} />
    <${FeedbackCapture} />
    ${editor ? html`<${EntryEditor} spec=${editor} settings=${settings} onClose=${closeEditor} />` : null}
    ${showHelp ? html`<${KeyboardHelp} onClose=${closeHelp} />` : null}
    ${quickCapture ? html`<${QuickCapture} onClose=${closeQuickCapture} onFiled=${bumpRefresh} />` : null}
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
