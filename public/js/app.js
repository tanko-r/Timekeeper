import { api, accessSignInUrl } from '/js/api.js';
import { html, React, useState, useEffect, useRef, useCallback, Spinner, Icon } from '/js/ui.js';
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
import { RunBar } from '/js/components/runbar.js';
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

// THE ROUTE TABLE, and the promise it keeps: four destinations, and every URL
// that ever worked still works.
//
// The teardown (§A) cut seven destinations to four — Today, Calendar, Entries,
// Settings — by folding Day and Stats into Calendar, Export into Entries, and
// Clients/Matters into Settings. A lawyer's bookmark knows nothing about that,
// and `#/export/unfinalized/2026-07-01` is a link the dashboard's own attention
// banner still generates. So a retired route is not deleted: it is CANONICALISED
// to where its screen now lives, carrying its arguments, and the URL is then
// rewritten in place (location.replace — a redirect that pushed history would
// trap Back in a loop).
//
// Canonicalising is a pure function of the hash, used by the renderer as well
// as by the rewrite, so a deep link paints its destination on the FIRST frame
// and never flashes a "Not found" on the way.
//
//   #/search[/…]                → #/entries[/…]              the ledger
//   #/export                    → #/entries/export           export, inside it
//   #/export/<filter>           → #/entries/export/<filter>
//   #/export/<filter>/<from>    → #/entries/export/<filter>/<from>
//   #/stats                     → #/calendar/stats           stats, inside it
//   #/cms                       → #/settings/cms             reference data
//   #/day/<date>                → unchanged; Calendar owns it in the nav
//
// Export and Stats are MODES of their new owners rather than rows in the
// navigation: they keep every control they had, one tap from the destination
// that absorbed them (see PAGENAV below), until the screens that absorbed them
// finish swallowing their contents outright.
const ROUTE_ALIASES = {
  search: (args) => ['entries', args],
  export: (args) => ['entries', ['export', ...args]],
  stats: () => ['calendar', ['stats']],
  cms: () => ['settings', ['cms']],
};

function canonicalRoute(route) {
  const alias = ROUTE_ALIASES[route.path];
  if (!alias) return route;
  const [path, args] = alias(route.args);
  return { path, args };
}

const hashFor = (path, args) =>
  (path === 'dashboard' && args.length === 0 ? '#/' : `#/${[path, ...args].join('/')}`);

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

// THE FOUR DESTINATIONS. The fourth field is the one-word label used where
// there is no room for the full one: the tablet rail (76px) and the phone
// bottom bar.
//
// Was seven destinations and three actions. Four of the seven answered the same
// question ("show me the entries in a date range") with four filter UIs and
// four Export buttons, and the three "actions" — Add todo, Run /todo, Float
// timer — were a developer's tools sitting one thumb-reach from Settings in a
// lawyer's production navigation. Four destinations plus ONE action (quick
// capture) is the whole surface now; everything else is a mode of one of these
// four, or lives in Settings → Tools.
const NAV = [
  ['dashboard', 'Today', 'layout', 'Today'],
  ['calendar', 'Calendar', 'calendar', 'Calendar'],
  ['entries', 'Entries', 'clipboard', 'Entries'],
  ['settings', 'Settings', 'settings', 'Settings'],
];

// The phone bottom bar carries all four — Material 3 allows 3–5 destinations
// and Apple HIG caps a tab bar at 5 — plus quick capture as the centre action
// (Material's BottomAppBar + FAB pattern). There is no More sheet any more:
// with four destinations nothing overflows, and the two things that used to
// live in the sheet have real homes (Export inside Entries, the tools in
// Settings → Tools).
const CAPTURE_SLOT = 2; // the centre of five slots

const routeOf = (path) => (path === 'dashboard' ? '#/' : `#/${path}`);

// Sub-navigation inside a destination: the strip of chips the shell renders
// between a page's title and its content (.pagenav below 1024px, .subnav in
// the sidebar above it). Settings has had one since wave 0; Calendar and
// Entries have one now because they absorbed a screen each, and a mode you can
// only reach by typing a URL is a mode a thumb cannot reach.
//
// [arg, label] — arg '' is the destination's own default surface.
const PAGENAV = {
  calendar: { label: 'Calendar sections', items: [['', 'Calendar'], ['stats', 'Statistics']] },
  entries: { label: 'Entries sections', items: [['', 'All entries'], ['export', 'Export']] },
};

// One nav row, used by the sidebar and the rail. Both labels are always in the
// DOM; CSS shows whichever one fits the width.
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

// QUICK CAPTURE'S VISIBLE CONTROL — the one action in the whole shell.
//
// The teardown's single worst placement finding: `setQuickCapture(true)` was
// called from exactly one place in the app, `e.key === 'q'`. There was no
// button anywhere — not in the sidebar, not in a header, not in the bottom bar.
// David uses this as an installed Android PWA, so the app's fastest feature did
// not exist on the device he uses it on.
//
// On desktop it is the first thing under the brand, shaped like the input it
// opens (Attio/Linear/Slack all trigger their palette from a field-shaped
// button that carries its own shortcut) — the palette itself is the real input,
// so this is a button, and it says which key does the same thing. On the rail
// it collapses to its icon; on a phone it is the centre of the bottom bar.
function CaptureTrigger({ onOpen }) {
  return html`
    <button type="button" class="qc-trigger" onClick=${onOpen} aria-haspopup="dialog"
      title="Quick capture — file an entry from one sentence (q)">
      <${Icon} name="sparkles" size=${16} />
      <span class="qc-trigger-label">What did you do?</span>
      <kbd class="qc-trigger-kbd">q</kbd>
    </button>`;
}

// The action group — things that DO something rather than places to go. These
// left the primary navigation in this wave (a control that launches a
// full-permission coding agent is not a lawyer's navigation item); they live in
// Settings → Tools now, unchanged, arming and all.
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

// Settings → Tools. Where the three ex-navigation actions live now, plus the
// keyboard sheet — which used to be reachable on a phone only from the More
// sheet that this wave removed.
//
// Nothing about them changed: Add todo still writes to TODO.md through the same
// event the Alt+drag feedback gesture uses, Run /todo still arms on the first
// click and launches on the second, Float timer still opens the
// document-picture-in-picture window (and is also on the running-timer bar,
// which is where you want it while a timer is actually running).
function ToolsPanel({ onHelp }) {
  return html`
    <${React.Fragment}>
      <div class="page-head">
        <h1>Settings</h1><span class="muted">· Tools</span>
      </div>
      <div class="grid" style=${{ maxWidth: '760px' }}>
        <div class="card">
          <h2>Tools</h2>
          <p class="muted small">
            Utilities that are not part of keying time. The float window is a
            Chrome/Edge desktop feature and appears on the running-timer bar too;
            the two todo actions write to this repo's own backlog.
          </p>
          <div class="tools-list">
            <${NavActions} />
            <button class="navlink" onClick=${onHelp}>
              <span class="navlink-ind"><${Icon} name="keyboard" size=${18} /></span>
              <span class="navlink-label">Keyboard shortcuts</span>
              <span class="navlink-short">Keys</span>
            </button>
          </div>
          ${pipSupported() ? null : html`
            <p class="muted small">
              The float window needs Chrome or Edge on a desktop — this browser
              does not offer it.
            </p>`}
        </div>
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

// Seventeen rows in one flat table before this — global shortcuts and
// timer-grid chords mixed together. Slack, GitHub and Linear all group a
// shortcut sheet by task area, and component.gallery §7 says the same, so it is
// four groups now. The Navigation group is also the one place the new route
// table has to be told the truth about: `g` then `d`/`c`/`e`/`s` goes to the
// four destinations that now exist.
const HELP_GROUPS = [
  ['Recording time', [
    ['q', 'Quick capture — file an entry from one sentence'],
    ['n', 'New time entry'],
    ['t', 'Start / stop the last-used timer'],
    ['c', 'Close the day — review, finalize and export (Today)'],
    ['s', 'Summary of the day in view as plain text'],
  ]],
  ['Getting around', [
    ['g then d/c/e/s', 'Go to Today / Calendar / Entries / Settings'],
    ['/', 'Search — timers on Today, the entry ledger everywhere else'],
    ['[ and ]', 'Previous / next day'],
    ['?', 'This help'],
  ]],
  ['The timer list', [
    ['Tab / click', 'Focus the timer grid'],
    ['← → ↑ ↓', 'Move between timer cards'],
    ['Enter or Space', 'Start–stop the focused timer'],
    ['Alt+↑ / Alt+↓', 'Nudge the focused timer ±0.1h (+Shift: ±0.2h)'],
    ['Shift+Enter', 'Edit the focused timer'],
    ['Ctrl+Enter', 'Open the focused timer’s entry'],
  ]],
  ['Dialogs', [
    ['Ctrl+Enter', 'Save and close the entry editor'],
    ['Esc', 'Close the dialog on top'],
  ]],
];

function KeyboardHelp({ onClose }) {
  return html`
    <${Overlay} title="Keyboard shortcuts" className="kbd-help" onClose=${() => onClose()}>
      <table>
        ${HELP_GROUPS.map(([group, rows]) => html`
          <tbody key=${group}>
            <tr class="kbd-group"><th colspan="2" scope="colgroup">${group}</th></tr>
            ${rows.map(([k, d]) => html`
              <tr key=${k}><td><kbd>${k}</kbd></td><td>${d}</td></tr>`)}
          </tbody>`)}
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
  const [refreshKey, setRefreshKey] = useState(0);
  const [accessExpired, setAccessExpired] = useState(false);
  const pagenavRef = useRef(null);

  // Where we actually are, after a retired route has been folded into its new
  // home. Everything downstream — the view, the navigation's active item, the
  // shortcuts that are screen-specific — reads this, never the raw hash, so a
  // deep link behaves identically to the canonical URL from its first frame.
  const at = canonicalRoute(route);
  const here = at.path;

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
    setEditor(null);
    setShowHelp(false);
    setQuickCapture(false);
  }, [route]);

  // A retired route paints its new home immediately (canonicalRoute is applied
  // during render) and the URL catches up here, in place — `location.replace`,
  // never a push, or Back would bounce between the old hash and the new one
  // forever. Guarded so it only fires for a hash that actually moved.
  useEffect(() => {
    const c = canonicalRoute(route);
    if (c === route) return;
    location.replace(hashFor(c.path, c.args));
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

  // Quick capture is app-level state, and it now has three doors: the `q` key,
  // the shell's own control (sidebar on desktop, the centre of the bottom bar
  // on a phone), and this event — so any view can open the palette without
  // this file having to know it exists.
  useEffect(() => {
    const onCapture = () => setQuickCapture(true);
    window.addEventListener('tk:quick-capture', onCapture);
    return () => window.removeEventListener('tk:quick-capture', onCapture);
  }, []);

  // (The running-timer poll, the tab title, the favicon and the app badge all
  // moved into components/runbar.js: one poll and one tick now feed the bar,
  // the title and the badge, instead of the bar being a screen the clock only
  // existed on and the title being a second poll that duplicated it.)

  const openEditor = useCallback((spec) => setEditor(spec), []);
  const closeEditor = useCallback((changed) => {
    setEditor(null);
    if (changed) bumpRefresh();
  }, [bumpRefresh]);
  const closeHelp = useCallback(() => setShowHelp(false), []);
  const closeQuickCapture = useCallback(() => setQuickCapture(false), []);
  const openQuickCapture = useCallback(() => setQuickCapture(true), []);

  // Back / the Android gesture dismisses the top overlay instead of leaving
  // the screen under it. Order is irrelevant — each hook owns its own marker.
  useBackDismiss(!!editor, closeEditor);
  useBackDismiss(showHelp, closeHelp);
  useBackDismiss(quickCapture, closeQuickCapture);

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
      if (editor || quickCapture || overlayOpen()) return;
      if (pendingG) {
        pendingG = false;
        clearTimeout(gTimer);
        // The same four letters, remapped onto the four destinations that
        // exist now: d stays Today (it was Dashboard), c stays Calendar, e
        // moves from Export to the Entries ledger that swallowed it, and s
        // moves from Stats — which Calendar swallowed — to Settings. The `?`
        // overlay lists exactly this.
        const map = { d: '#/', c: '#/calendar', e: '#/entries', s: '#/settings' };
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
        if (here === 'dashboard') {
          window.dispatchEvent(new CustomEvent('tk:timer-search'));
        } else {
          nav('#/entries');
          setTimeout(() => document.querySelector('[data-search-q]')?.focus(), 80);
        }
      } else if (e.key === 't') {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent('tk:toggle-last-timer'));
        if (here !== 'dashboard') nav('#/');
      } else if (e.key === 'q') {
        if (showHelp) return; // don't open the palette under the help overlay
        e.preventDefault();
        setQuickCapture(true);
      } else if (e.key === 'c' && here === 'dashboard') {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent('tk:close-day'));
      } else if (e.key === 's' && (here === 'dashboard' || here === 'day')) {
        // whichever of the two views is mounted answers this
        e.preventDefault();
        window.dispatchEvent(new CustomEvent('tk:day-summary'));
      } else if (e.key === '?') {
        setShowHelp(true);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [editor, openEditor, here, showHelp, quickCapture]);

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
  const args = at.args;

  // SETTINGS CATEGORIES, plus the two the shell adds. Clients & Matters is
  // reference data — configured once, used constantly through the CM picker —
  // so it belongs beside the other configuration rather than in the daily
  // navigation; Tools is where the three ex-navigation actions went. Both are
  // appended only if settings.js has not already grown them itself, so the day
  // that view absorbs them this file stops adding a duplicate chip.
  const categories = [...SETTINGS_CATEGORIES];
  const addCategory = (key, label) => {
    if (!categories.some(([k]) => k === key)) categories.push([key, label]);
  };
  addCategory('cms', 'Clients & matters');
  addCategory('tools', 'Tools');
  const nativeSettings = (key) => SETTINGS_CATEGORIES.some(([k]) => k === key);

  // Same fallback SettingsView applies to its own content: an unknown category
  // (a stale bookmark, a typo'd deep link) renders General, so the strip has to
  // say General too. Without this the shell showed six chips with none of them
  // active above a General page — the one state where the nav lies about where
  // you are.
  const rawSettingsPage = args[0] || 'general';
  const settingsPage = categories.some(([k]) => k === rawSettingsPage) ? rawSettingsPage : 'general';

  const settingsView = () => {
    if (settingsPage === 'cms' && !nativeSettings('cms')) return html`<${CmsView} ...${ctx} />`;
    if (settingsPage === 'tools' && !nativeSettings('tools')) {
      return html`<${ToolsPanel} onHelp=${() => setShowHelp(true)} />`;
    }
    return html`<${SettingsView} page=${settingsPage} ...${ctx}
      authState=${authState} reloadAuth=${reloadAuth} />`;
  };

  const view = {
    dashboard: () => html`<${DashboardView} ...${ctx} />`,
    // #/day/<date> keeps its route and its bookmarks; the navigation has
    // always called it Calendar (and now Calendar owns it outright).
    day: () => html`<${DayView} date=${args[0]} ...${ctx} />`,
    calendar: () => (args[0] === 'stats'
      ? html`<${StatsView} ...${ctx} />`
      : html`<${CalendarView} ...${ctx} />`),
    // #/entries is the ledger; #/entries/export[/<filter>[/<from>]] is the
    // export surface that used to be a top-level destination — same controls,
    // same deep-link contract, one tap from the ledger instead of a permanent
    // slot in the phone's bottom bar for a once-a-day job.
    entries: () => (args[0] === 'export'
      ? html`<${ExportView} focus=${args[1]} focusFrom=${args[2]} ...${ctx} />`
      : html`<${SearchView} ...${ctx} />`),
    settings: settingsView,
  }[here] || (() => html`<div class="card">Not found. <a href="#/">Go home</a></div>`);

  const active = here === 'day' ? 'calendar' : here;
  // The sub-navigation for the destination we are on: Settings' six categories
  // plus the shell's two, or the two-mode strip Calendar and Entries grew when
  // they absorbed Stats and Export. Day has none — it is a deep link into
  // Calendar, not a mode of it.
  const pagenav = active === 'settings'
    ? { label: 'Settings sections', base: '#/settings/', current: settingsPage,
      items: categories }
    : (here === 'calendar' || here === 'entries') && PAGENAV[here]
      ? { label: PAGENAV[here].label, base: `#/${here}/`, current: args[0] || '',
        items: PAGENAV[here].items }
      : null;

  // One sub-navigation model, two renderings: .subnav under the destination in
  // the sidebar at ≥1024px, .pagenav as a scrollable chip strip below it.
  // (Settings has worked this way since wave 0; Calendar and Entries join it
  // now, and the desktop half is not optional — without it "Statistics" and
  // "Export" would be reachable only by typing a URL.)
  const chipTo = (key) => (key ? pagenav.base + key : pagenav.base.replace(/\/$/, ''));
  const chip = (cls) => (key, label) => html`
    <button key=${key || 'default'}
      class=${cls + (pagenav.current === key ? ' active' : '')}
      aria-current=${pagenav.current === key ? 'page' : undefined}
      onClick=${() => nav(chipTo(key))}>${label}</button>`;

  return html`
    <div class="shell">
      <${RunBar} />
      <nav class="sidebar" aria-label="Main">
        <div class="brand">
          <${Icon} name="timer" size=${21} />
          <span class="brand-word">Time<span>keeper</span></span>
        </div>
        <${CaptureTrigger} onOpen=${openQuickCapture} />
        <div class="nav-group">
          <div class="nav-label">Go to</div>
          ${NAV.map(([path, label, icon, short]) => html`
            <${React.Fragment} key=${path}>
              <${NavLink} path=${path} label=${label} icon=${icon} short=${short}
                active=${active === path} />
              ${active === path && pagenav ? html`
                <div class="subnav">
                  ${pagenav.items.map(([key, sub]) => chip('subnavlink')(key, sub))}
                </div>` : null}
            <//>`)}
        </div>
        <div class="foot">Press <kbd>?</kbd> for shortcuts</div>
      </nav>
      <main class=${'main' + (pagenav ? ' main-pagenav' : '')}>
        ${pagenav ? html`
          <div class="pagenav" role="group" aria-label=${pagenav.label} ref=${pagenavRef}>
            ${pagenav.items.map(([key, label]) => chip('pagenav-item')(key, label))}
          </div>` : null}
        ${view()}
      </main>
    </div>
    ${/* The phone bar: four destinations, and quick capture in the middle —
          Material 3's BottomAppBar-with-a-FAB, and the first time the app's
          fastest feature has had a control a thumb can reach. */''}
    <nav class="botnav" aria-label="Main">
      ${NAV.slice(0, CAPTURE_SLOT).map(([path, label, icon, short]) => html`
        <button key=${path}
          class=${'botnav-item' + (active === path ? ' active' : '')}
          aria-current=${active === path ? 'page' : undefined}
          title=${label}
          onClick=${() => nav(routeOf(path))}>
          <span class="botnav-ind"><${Icon} name=${icon} size=${20} /></span>
          <span class="botnav-label">${short}</span>
        </button>`)}
      <button class="botnav-item botnav-capture" onClick=${openQuickCapture}
        aria-haspopup="dialog" title="Quick capture — file an entry from one sentence">
        <span class="botnav-ind"><${Icon} name="sparkles" size=${20} /></span>
        <span class="botnav-label">Capture</span>
      </button>
      ${NAV.slice(CAPTURE_SLOT).map(([path, label, icon, short]) => html`
        <button key=${path}
          class=${'botnav-item' + (active === path ? ' active' : '')}
          aria-current=${active === path ? 'page' : undefined}
          title=${label}
          onClick=${() => nav(routeOf(path))}>
          <span class="botnav-ind"><${Icon} name=${icon} size=${20} /></span>
          <span class="botnav-label">${short}</span>
        </button>`)}
    </nav>
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
