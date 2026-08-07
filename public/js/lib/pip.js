// Always-on-top floating multi-timer panel (Document Picture-in-Picture).
//
// A PWA window can't set itself always-on-top, but Chrome 116+'s Document
// Picture-in-Picture API can open a small utility window the OS keeps above
// everything. It shares this page's JS context and origin, so the same
// api.js client and session cookie work inside it. Caveats:
//   - Chrome/Edge desktop only; needs a secure context and a user gesture.
//   - One PiP window per tab; closing the tab closes it. The dashboard
//     re-polls every 5s, so actions taken here show up there within a poll.
//   - Chromeless: stylesheets are NOT inherited — inline CSS only.
//
// The panel lists every timer that is running, has clock time today, or is
// pinned (spec docs/superpowers/specs/2026-07-13-aot-multi-timer-design.md).
// Clicking a row expands a narrative field that edits the linked entry's
// narrative — or stashes to timers.draft_narrative when no entry exists yet.
// Footer: ticking day total + a `+` quick-timer button.

// api.js is imported lazily inside toggleTimerPip: node:test can't resolve
// the browser-absolute '/js/api.js' specifier, and the pure helpers below
// (buildPipRows, fmtClock, …) are unit-tested (test/pip.test.js) — same reason
// lib/titlebar.js and lib/narrativesync.js keep their imports at zero.
// tick.js is zero-dep and sits beside this file, so a RELATIVE specifier
// resolves under both the browser and node:test.
import { startAlignedTick } from './tick.js';
import { compareTimersAZ } from './timersort.js';

export function pipSupported() {
  return typeof window !== 'undefined' && 'documentPictureInPicture' in window;
}

// Which timers earn a row: running, any clock time today, pinned
// (timers.pinned — the whole point of pinning is surviving the midnight
// reset), or hand-added for the day via the find box (extraIds).
// Alphabetical, regardless of running state (2026-07-14 feedback): a row must
// keep its position when its timer starts or stops — never jump to the top
// while the user watches. Pure — unit-tested in test/pip.test.js.
export function buildPipRows(timers, extraIds = null) {
  return (timers || [])
    .filter((t) => t.running || t.elapsed_seconds > 0 || t.pinned
      || (extraIds && extraIds.has(t.id)))
    .sort((a, b) => (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' }));
}

// The find box's candidates (2026-07-29 feedback, replacing the old "Recent"
// picker): ANY timer not already on the float list, narrowed by the same
// fields the dashboard's filter box matches — caption, matter name/number,
// client name/number. Blank query lists everything. Alphabetical. Pure.
export function findPickList(timers, extraIds, query = '') {
  const shown = new Set(buildPipRows(timers, extraIds).map((t) => t.id));
  const q = String(query || '').trim().toLowerCase();
  return (timers || [])
    .filter((t) => !shown.has(t.id))
    .filter((t) => !q || [t.name, t.cm_short_name, t.cm_number, t.client_name, t.client_number]
      .some((v) => String(v || '').toLowerCase().includes(q)))
    .sort(compareTimersAZ);
}

// What picking a timer out of the find box should do (2026-08-06 feedback).
// You only go looking for a timer because you are about to work on it, so the
// pick starts it — the same act as the row's ▶. `start` is false only when the
// pick is already running (nothing to do). `stoppingId` names the timer the
// server's start-exclusivity will stop, so the caller can hand it the
// close-out pane, exactly as the ▶ button does. Pure — unit-tested.
export function pickPlan(timers, picked) {
  if (!picked) return { start: false, stoppingId: null };
  if (picked.running) return { start: false, stoppingId: null };
  const running = (timers || []).find((t) => t.running && t.id !== picked.id);
  return { start: true, stoppingId: running ? running.id : null };
}

// How the expanded row's narrative surface behaves:
//   'stash'    — no linked entry: text goes to timers.draft_narrative and is
//                consumed by the next entry the timer creates (syncToEntry)
//   'readonly' — split entry (2+ substantive lines, auto-generated
//                narrative): view only; edit-through stays in the main editor
//   'entry'    — edits the linked entry's narrative directly
export function narrativeMode(t) {
  if (!t.linked_entry_id) return 'stash';
  if (t.entry_substantive_lines >= 2 && !t.entry_narrative_manual) return 'readonly';
  return 'entry';
}

export function narrativeValue(t) {
  return (narrativeMode(t) === 'stash' ? t.draft_narrative : t.entry_narrative) || '';
}

// After a stop lands (Stop button, or exclusivity-stop when another timer
// starts), which timer gets the full-window close-out pane? The one that
// stopped — unless the misclick grace undid the start (no time, no entry),
// the timer vanished, or it is somehow running again. Pure — unit-tested.
export function closeoutTimer(timers, id) {
  const t = (timers || []).find((x) => x.id === id);
  if (!t || t.running) return null;
  return t.elapsed_seconds > 0 || t.linked_entry_id ? t : null;
}

export function fmtDayTotal(totalSeconds) {
  return `${(Math.max(0, totalSeconds) / 3600).toFixed(1)}h today`;
}

// The float's own clock shape (2026-07-15 feedback): the hour stays a single
// digit until 10h is actually on the clock, and the leading zero run —
// "0:" / "0:0" — is returned separately so it can render dimmed. A local
// sibling of ui.js's fmtClock, which is not importable here (it pulls in the
// React vendor bundle — same reason lib/titlebar.js keeps a copy). Pure —
// unit-tested in test/pip.test.js.
export function fmtClockParts(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  const str = `${h}:${mm}:${ss}`;
  // Gray every position up to the first non-zero digit: 0:00:00 is wholly
  // gray, and hr/min/sec each light up only once real time reaches them.
  const first = str.search(/[1-9]/);
  const dim = first === -1 ? str.length : first;
  return { dim: str.slice(0, dim), rest: str.slice(dim) };
}

// Mirrors app.css's design tokens (copied by hand — stylesheets are NOT
// inherited into the PiP document): light by default, dark via the OS
// preference, and the app's explicit Settings theme wins through the
// data-theme attribute mirrored from the main document in toggleTimerPip.
const PIP_CSS = `
  @font-face {
    font-family: 'InterVariable';
    src: url('/vendor/inter/InterVariable.woff2') format('woff2');
    font-weight: 100 900;
    font-style: normal;
    font-display: swap;
  }
  /* ClockFace: clean plain-zero numerals for the float clocks — matches the
     main app timer view (see app.css). */
  @font-face {
    font-family: 'ClockFace';
    src: url('/vendor/clockface/NotoSansNum-Regular.woff2') format('woff2');
    font-weight: 400; font-style: normal; font-display: swap;
  }
  @font-face {
    font-family: 'ClockFace';
    src: url('/vendor/clockface/NotoSansNum-Bold.woff2') format('woff2');
    font-weight: 700; font-style: normal; font-display: swap;
  }
  :root {
    --surface-1: #fcfcfb; --surface-2: #efefec; --border: #dddcd6;
    --text-primary: #0b0b0b; --text-secondary: #52514e; --text-muted: #8b8a84;
    --accent: #2a78d6; --danger: #d03b3b; --good: #0ca30c;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --surface-1: #1a1a19; --surface-2: #242422; --border: #3a3a37;
      --text-primary: #ffffff; --text-secondary: #c3c2b7;
      --accent: #3987e5; --good: #23b523;
    }
  }
  :root[data-theme="dark"] {
    --surface-1: #1a1a19; --surface-2: #242422; --border: #3a3a37;
    --text-primary: #ffffff; --text-secondary: #c3c2b7;
    --accent: #3987e5; --good: #23b523;
  }
  * { margin: 0; box-sizing: border-box; }
  [hidden] { display: none !important; }
  body {
    font: 12px/1.35 'InterVariable', system-ui, sans-serif;
    background: var(--surface-1); color: var(--text-primary);
    height: 100vh; display: flex; flex-direction: column;
    border-left: 4px solid var(--border); user-select: none;
  }
  body.running { border-left-color: var(--good); }
  .rows { flex: 1; overflow-y: auto; }
  .row { border-bottom: 1px solid var(--border); }
  .rowbar { display: flex; align-items: center; gap: 7px; padding: 6px 8px; cursor: pointer; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--border); flex: none; }
  .row.running .dot { background: var(--good); animation: pulse 1.6s ease-in-out infinite; }
  @keyframes pulse { 50% { opacity: 0.35; } }
  .clock { font-family: 'ClockFace', ui-monospace, monospace; font-variant-numeric: tabular-nums; font-weight: 700; font-size: 14px; flex: none; min-width: 66px; }
  /* positions with no recorded digit yet are flat gray, not a faded ghost
     (2026-07-22 feedback: the dimmed leading zeros read as distracting) */
  .clock .dim, .co-time .dim { color: var(--text-muted); }
  /* active counter is GREEN, matching the app (2026-07-14 design vocabulary) */
  .row.running .clock { color: var(--good); }
  /* …but a running clock's not-yet-reached positions stay gray, not green */
  .row.running .clock .dim { color: var(--text-muted); }
  .name { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--text-secondary); }
  .row.running .name { color: var(--text-primary); }
  .pin {
    background: none; border: none; cursor: pointer; padding: 2px; flex: none;
    display: inline-flex; color: var(--text-muted); opacity: 0.35;
  }
  .pin:hover { opacity: 0.8; }
  .pin.on { color: var(--accent); opacity: 1; }
  .pin svg { width: 13px; height: 13px; }
  .act {
    display: inline-flex; align-items: center; justify-content: center;
    background: var(--surface-2); border: 1px solid var(--border); border-radius: 5px;
    width: 26px; height: 22px; padding: 0; cursor: pointer; flex: none;
  }
  .act:hover { border-color: var(--text-muted); }
  .act svg { width: 11px; height: 11px; }
  .act.start { color: var(--good); }
  .act.stop { color: var(--danger); }
  .detail { padding: 0 8px 8px 23px; }
  .cap { color: var(--text-muted); font-size: 11px; margin-bottom: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  textarea {
    width: 100%; font: 12px/1.35 'InterVariable', system-ui, sans-serif; color: var(--text-primary);
    background: var(--surface-2); border: 1px solid var(--border); border-radius: 5px;
    padding: 4px 6px; resize: none;
  }
  textarea:focus { outline: none; border-color: var(--accent); }
  .ro { color: var(--text-secondary); }
  .hint { color: var(--text-muted); font-size: 10px; margin-top: 2px; }
  .detail-foot { display: flex; align-items: center; justify-content: space-between; margin-top: 3px; }
  .openapp {
    display: inline-flex; align-items: center; gap: 4px; flex: none;
    font: 600 11px 'InterVariable', system-ui, sans-serif; color: var(--text-secondary);
    background: var(--surface-2); border: 1px solid var(--border); border-radius: 5px;
    padding: 3px 8px; cursor: pointer;
  }
  .openapp:hover { border-color: var(--text-muted); color: var(--text-primary); }
  .openapp svg { width: 11px; height: 11px; }
  .saved { color: var(--good); font-size: 11px; opacity: 0; transition: opacity 0.2s; }
  .saved.show { opacity: 1; }
  .rowerr { color: var(--danger); font-size: 11px; margin-top: 3px; }
  .empty { flex: 1; display: flex; align-items: center; justify-content: center; color: var(--text-muted); padding: 12px; text-align: center; }
  .err { color: var(--danger); font-size: 11px; padding: 4px 8px; }
  .foot { flex: none; display: flex; align-items: center; justify-content: space-between; padding: 5px 8px; border-top: 1px solid var(--border); }
  .total { color: var(--text-secondary); font-family: 'ClockFace', ui-monospace, monospace; font-variant-numeric: tabular-nums; font-size: 11px; }
  .quick {
    font: 700 14px/1 'InterVariable', system-ui, sans-serif; color: var(--text-primary);
    background: var(--surface-2); border: 1px solid var(--border); border-radius: 5px;
    width: 24px; height: 22px; cursor: pointer;
  }
  .quick:hover { border-color: var(--text-muted); }
  .closeout {
    flex: 1; display: flex; flex-direction: column; gap: 5px;
    padding: 8px; min-height: 0; overflow-y: auto;
  }
  .co-title { font-weight: 700; font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .co-time { color: var(--text-secondary); font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .co-time b { font-family: 'ClockFace', ui-monospace, monospace; font-variant-numeric: tabular-nums; color: var(--text-primary); }
  .closeout textarea { flex: 1; min-height: 48px; }
  .co-foot { display: flex; align-items: center; justify-content: space-between; }
  .foot-btns { display: flex; gap: 5px; }
  .find-btn { width: auto; padding: 0 8px; font: 600 11px 'InterVariable', system-ui, sans-serif; }
  .find-panel {
    flex: 1; display: flex; flex-direction: column; gap: 6px;
    padding: 8px; min-height: 0;
  }
  .find-filter {
    font: 12px 'InterVariable', system-ui, sans-serif; width: 100%;
    padding: 4px 6px; border: 1px solid var(--border); border-radius: 5px;
    background: var(--surface-2); color: var(--text-primary);
  }
  .find-filter:focus { outline: none; border-color: var(--accent); }
  .find-count { color: var(--text-muted); font-size: 10px; flex: none; }
  .find-list { flex: 1; overflow-y: auto; display: flex; flex-direction: column; }
  .find-item {
    display: flex; gap: 6px; align-items: baseline; width: 100%;
    padding: 5px 6px; border: 0; border-bottom: 1px solid var(--border);
    background: none; text-align: left; cursor: pointer;
    color: var(--text-primary); font: 12px 'InterVariable', system-ui, sans-serif;
  }
  .find-item:hover, .find-item.on { background: var(--surface-2); }
  .find-item .sub { color: var(--text-muted); font-size: 10px; margin-left: auto; flex: none; }
  .find-none { color: var(--text-muted); font-size: 11px; padding: 6px; }
  .done {
    font: 600 11px 'InterVariable', system-ui, sans-serif; color: #fff;
    background: var(--accent); border: 1px solid var(--accent); border-radius: 5px;
    padding: 3px 14px; cursor: pointer;
  }
`;

// lucide "pin" — same path as icons.js, which is NOT importable here: it
// dereferences window.React at module scope and this file loads under
// node:test (same reason fmtClock is a copy).
const PIN_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"'
  + ' stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
  + '<path d="M12 17v5" /><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5'
  + ' 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0'
  + ' 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" /></svg>';

// lucide "edit" (same path as icons.js) for the open-in-app button
const EDIT_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"'
  + ' stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
  + '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321'
  + ' 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" /><path d="m15 5 4 4" /></svg>';

// lucide "play" (same path as icons.js) and "square", filled solid so they
// read as the classic green-go / red-stop transport glyphs at 11px.
const PLAY_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">'
  + '<path d="M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z" /></svg>';
const STOP_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">'
  + '<rect x="3" y="3" width="18" height="18" rx="2" /></svg>';

let pipWin = null; // one floating window per tab (mirrors the API's own limit)

export async function toggleTimerPip() {
  if (pipWin && !pipWin.closed) { pipWin.close(); pipWin = null; return false; }

  // requestWindow first — it consumes the click's transient activation, and
  // an awaited import in front of it could outlive that window. Height comes
  // from the row count cached at the last render (PiP windows can't be
  // resized programmatically); the list scrolls if the guess is off.
  const cachedRows = Math.max(1, Number(localStorage.getItem('tk:pipRows')) || 3);
  pipWin = await window.documentPictureInPicture.requestWindow({
    width: 320,
    height: Math.min(64 + 34 * cachedRows, 320),
  });
  const { api } = await import('/js/api.js');
  // Same lazy-import rationale as api.js (node:test can't resolve the
  // browser-absolute specifier at module scope, and pip.test.js imports
  // this file). expand.js itself is zero-dep.
  const { expandShortcuts } = await import('/js/lib/expand.js');
  const doc = pipWin.document;

  // Text-expansion dictionary (2026-07-14 feedback: expansions must work in
  // the AOT narrative field too). Fetched once per window open — the set
  // changes rarely, and a stale miss just means no expansion.
  let shortcuts = [];
  api.get('/api/shortcuts').then((s) => { shortcuts = s; }).catch(() => {});
  doc.head.appendChild(doc.createElement('style')).textContent = PIP_CSS;

  // Follow the app's theme: the OS preference flows in via the media query
  // in PIP_CSS; an explicit Settings choice lives as data-theme on the MAIN
  // document's root (app.js applyTheme) — copy it over and mirror changes.
  // Settings → Float timer theme (data-pip-theme, 2026-07-15 feedback) pins
  // the float regardless of the app and wins when set.
  const mainRoot = document.documentElement;
  const syncTheme = () => {
    const t = mainRoot.getAttribute('data-pip-theme') || mainRoot.getAttribute('data-theme');
    if (t) doc.documentElement.setAttribute('data-theme', t);
    else doc.documentElement.removeAttribute('data-theme');
  };
  syncTheme();
  const themeObs = new MutationObserver(syncTheme);
  themeObs.observe(mainRoot, { attributes: true, attributeFilter: ['data-theme', 'data-pip-theme'] });
  doc.body.innerHTML = `
    <div class="rows" data-rows></div>
    <div class="closeout" data-closeout hidden></div>
    <div class="find-panel" data-find-panel hidden></div>
    <div class="empty" data-empty hidden>No time today — pin a timer or hit +.</div>
    <div class="err" data-err hidden></div>
    <div class="foot">
      <span class="total" data-total>…</span>
      <span class="foot-btns">
        <button class="quick find-btn" data-find-btn
          title="Find any timer — picking it starts it and adds it to today’s list">Find ▾</button>
        <button class="quick" data-quick title="Quick timer — starts now; assign a matter later">+</button>
      </span>
    </div>`;

  const rowsEl = doc.querySelector('[data-rows]');
  const closeoutEl = doc.querySelector('[data-closeout]');
  const findEl = doc.querySelector('[data-find-panel]');
  const emptyEl = doc.querySelector('[data-empty]');
  const errEl = doc.querySelector('[data-err]');
  const totalEl = doc.querySelector('[data-total]');

  let timers = [];
  let fetchedAt = 0;
  let expandedId = null; // one expanded row at a time
  let closeoutId = null; // just-stopped timer whose close-out pane owns the window
  let findOpen = false; // the find pane owns the window while open

  // Timers hand-added to today's list via the find box: day-scoped, browser
  // -local ("add to the list for TODAY" — not a durable pin).
  const localToday = () => {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  };
  const extras = (() => {
    try {
      const o = JSON.parse(localStorage.getItem('tk:pipExtras') || 'null');
      if (o && o.date === localToday()) return new Set(o.ids);
    } catch { /* corrupt/absent — start empty */ }
    return new Set();
  })();
  const saveExtras = () => localStorage.setItem(
    'tk:pipExtras', JSON.stringify({ date: localToday(), ids: [...extras] }));
  const drafts = new Map(); // timer id → unsaved narrative text
  const debounces = new Map(); // timer id → save debounce handle
  let pendingRender = false; // a render was skipped to protect a focused textarea
  let pointerHeld = false; // mouse/touch is down — a rebuild now would swallow the click

  const secsOf = (t) => t.elapsed_seconds + (t.running ? Math.max(0, (Date.now() - fetchedAt) / 1000) : 0);
  // every float clock renders through this: dim leading-zero run + the rest
  const setClock = (el, secs) => {
    const { dim, rest } = fmtClockParts(secs);
    el.replaceChildren();
    if (dim) {
      const d = doc.createElement('span');
      d.className = 'dim';
      d.textContent = dim;
      el.appendChild(d);
    }
    el.appendChild(doc.createTextNode(rest));
  };
  const narrFocused = () => doc.activeElement && doc.activeElement.tagName === 'TEXTAREA';

  // Clicking a button while the narrative textarea is focused fires blur
  // BETWEEN mousedown and mouseup; if the blur flush (or the autosave's poll)
  // rebuilt the DOM right then, the pressed button would be replaced and the
  // click would never fire — buttons appeared to need two clicks (2026-07-15
  // feedback). So renders also defer while the pointer is down, and flush
  // after the click lands (the doc-level bubble listener runs last).
  doc.addEventListener('pointerdown', () => { pointerHeld = true; }, true);
  doc.addEventListener('pointerup', () => { pointerHeld = false; }, true);
  doc.addEventListener('pointercancel', () => { pointerHeld = false; }, true);
  doc.addEventListener('click', () => { if (pendingRender) render(); });

  const showErr = (e) => { errEl.textContent = e.message; errEl.hidden = false; };

  // Each poll re-anchors the second boundary (secsOf counts from fetchedAt),
  // so the aligned ticker is rebuilt per poll — same no-stutter scheme as the
  // dashboard grid (lib/tick.js), but on the PiP window's own timers: the
  // opener tab's get throttled once it's hidden, which is exactly when the
  // float is in use.
  let stopTick = () => {};
  const poll = () => api.get('/api/timers')
    .then((t) => {
      timers = t; fetchedAt = Date.now(); errEl.hidden = true; render();
      stopTick();
      stopTick = startAlignedTick(fetchedAt, tick, pipWin);
    })
    .catch((e) => showErr(new Error(`Can’t reach server — ${e.message}`)));

  // Save the draft for timer id. Looks the timer up fresh: by save time a
  // poll may have created/relinked its entry, which changes WHERE the text
  // belongs (narrativeMode). Only clears the draft if the text didn't change
  // while the request was in flight.
  async function saveNarrative(id) {
    clearTimeout(debounces.get(id));
    if (!drafts.has(id)) return;
    const t = timers.find((x) => x.id === id);
    if (!t) return;
    const text = drafts.get(id);
    // doc-wide: the narrative surface lives in a .row normally, but in the
    // close-out pane (which also carries data-id) after a stop
    const rowErr = doc.querySelector(`[data-id="${id}"] [data-rowerr]`);
    try {
      if (narrativeMode(t) === 'stash') {
        await api.patch(`/api/timers/${id}`, { draft_narrative: text });
      } else {
        await api.patch(`/api/entries/${t.linked_entry_id}`, { narrative: text });
      }
      if (drafts.get(id) === text) drafts.delete(id);
      if (rowErr) rowErr.textContent = '';
      const flash = doc.querySelector(`[data-id="${id}"] [data-saved]`);
      if (flash) {
        flash.classList.add('show');
        pipWin.setTimeout(() => flash.classList.remove('show'), 1200);
      }
      poll();
    } catch (e) {
      if (rowErr) rowErr.textContent = e.message; else showErr(e);
    }
  }

  function focusNarrative(id) {
    const ta = doc.querySelector(`[data-id="${id}"] textarea`);
    if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
  }

  // textarea + ✓-saved / error strip, shared by the expanded row and the
  // close-out pane. Esc calls onEscape (collapse whichever surface owns it),
  // then blurs — blur saves and flushes any render deferred while typing.
  function buildNarrativeField(t, onEscape) {
    const ta = doc.createElement('textarea');
    ta.rows = 2;
    ta.spellcheck = true; // 2026-07-18 feedback: spell-check the float narrative
    ta.value = drafts.has(t.id) ? drafts.get(t.id) : narrativeValue(t);
    ta.addEventListener('input', () => {
      const hit = expandShortcuts(ta.value, ta.selectionStart, shortcuts);
      if (hit) {
        ta.value = hit.text;
        ta.setSelectionRange(hit.caret, hit.caret);
      }
      drafts.set(t.id, ta.value);
      clearTimeout(debounces.get(t.id));
      debounces.set(t.id, pipWin.setTimeout(() => saveNarrative(t.id), 600));
    });
    ta.addEventListener('blur', () => {
      saveNarrative(t.id);
      // render() re-defers if this blur is part of an in-flight click
      if (pendingRender) render();
    });
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        onEscape();
        pendingRender = true;
        ta.blur();
      }
    });
    const saved = doc.createElement('span');
    saved.className = 'saved';
    saved.dataset.saved = '';
    saved.textContent = '✓ saved';
    const rowErr = doc.createElement('div');
    rowErr.className = 'rowerr';
    rowErr.dataset.rowerr = '';
    return { ta, saved, rowErr };
  }

  // "Open entry" jumps to the full editor in the main app window (2026-07-15
  // feedback): the float shares the opener tab's JS context, so this is just
  // an event on the MAIN window plus a focus() to bring it forward. Any
  // pending narrative draft is flushed first — the editor loads the entry
  // fresh and must not read a stale narrative.
  const buildOpenBtn = (t) => {
    const b = doc.createElement('button');
    b.className = 'openapp';
    b.innerHTML = EDIT_SVG;
    b.append(' Open entry');
    b.title = 'Open this entry in the main app window';
    b.addEventListener('click', async () => {
      await saveNarrative(t.id);
      window.dispatchEvent(new CustomEvent('tk:open-entry', { detail: { id: t.linked_entry_id } }));
      window.focus();
    });
    return b;
  };

  function buildDetail(t) {
    const detail = doc.createElement('div');
    detail.className = 'detail';
    const cap = doc.createElement('div');
    cap.className = 'cap';
    cap.textContent = t.cm_id
      ? `${t.cm_short_name} · ${t.cm_number}`
      : 'no matter yet — time files to an entry that needs one before it can finalize';
    detail.appendChild(cap);

    if (narrativeMode(t) === 'readonly') {
      const ro = doc.createElement('div');
      ro.className = 'ro';
      ro.textContent = narrativeValue(t);
      const hint = doc.createElement('div');
      hint.className = 'hint';
      hint.textContent = 'split entry — edit in app';
      const foot = doc.createElement('div');
      foot.className = 'detail-foot';
      foot.append(hint, buildOpenBtn(t));
      detail.append(ro, foot);
      return detail;
    }

    const f = buildNarrativeField(t, () => { expandedId = null; });
    detail.append(f.ta);
    if (t.linked_entry_id) {
      const foot = doc.createElement('div');
      foot.className = 'detail-foot';
      foot.append(f.saved, buildOpenBtn(t));
      detail.append(foot);
    } else {
      detail.append(f.saved);
    }
    detail.append(f.rowErr);
    return detail;
  }

  // Full-window close-out pane: after a stop, the narrative field takes over
  // the window so writing the entry isn't skipped. Done / Esc returns to the
  // list (autosave means both are just "dismiss").
  function buildCloseout(t) {
    closeoutEl.dataset.id = t.id;
    const title = doc.createElement('div');
    title.className = 'co-title';
    title.textContent = t.name;
    const time = doc.createElement('div');
    time.className = 'co-time';
    const clock = doc.createElement('b');
    setClock(clock, secsOf(t));
    time.append('Stopped at ', clock);
    time.append(t.cm_id
      ? ` · ${t.cm_short_name} · ${t.cm_number}`
      : ' · no matter yet — assign one in the app to finalize');

    const done = doc.createElement('button');
    done.className = 'done';
    done.textContent = 'Done';
    // clicking Done blurs the textarea first, which already saves
    done.addEventListener('click', () => { closeoutId = null; render(); });
    const foot = doc.createElement('div');
    foot.className = 'co-foot';

    const btns = doc.createElement('span');
    btns.className = 'foot-btns';
    if (t.linked_entry_id) btns.append(buildOpenBtn(t));
    btns.append(done);

    const kids = [title, time];
    if (narrativeMode(t) === 'readonly') {
      const ro = doc.createElement('div');
      ro.className = 'ro';
      ro.textContent = narrativeValue(t);
      const hint = doc.createElement('div');
      hint.className = 'hint';
      hint.textContent = 'split entry — edit in app';
      kids.push(ro, hint);
      foot.append(doc.createElement('span'), btns);
    } else {
      const f = buildNarrativeField(t, () => { closeoutId = null; });
      f.ta.placeholder = 'What did you do? Saved automatically.';
      kids.push(f.ta, f.rowErr);
      foot.append(f.saved, btns);
    }
    kids.push(foot);
    closeoutEl.replaceChildren(...kids);
  }

  function buildRow(t) {
    const row = doc.createElement('div');
    row.className = `row${t.running ? ' running' : ''}`;
    row.dataset.id = t.id;

    const bar = doc.createElement('div');
    bar.className = 'rowbar';
    bar.innerHTML = `
      <span class="dot"></span>
      <span class="clock" data-clock></span>
      <span class="name"></span>
      <button class="pin${t.pinned ? ' on' : ''}" data-pin></button>
      <button class="act" data-act></button>`;
    setClock(bar.querySelector('[data-clock]'), secsOf(t));
    bar.querySelector('.name').textContent = t.name;
    const pinBtn = bar.querySelector('[data-pin]');
    pinBtn.innerHTML = PIN_SVG;
    pinBtn.title = t.pinned
      ? 'Unpin — drops off this window once its day is over'
      : 'Pin — keeps this timer here across days';
    const actBtn = bar.querySelector('[data-act]');
    actBtn.classList.add(t.running ? 'stop' : 'start');
    actBtn.innerHTML = t.running ? STOP_SVG : PLAY_SVG;
    actBtn.title = t.running ? 'Stop & file time' : 'Start';
    actBtn.setAttribute('aria-label', actBtn.title);

    bar.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      expandedId = expandedId === t.id ? null : t.id;
      render();
      if (expandedId === t.id) focusNarrative(t.id);
    });
    pinBtn.addEventListener('click', async () => {
      try {
        await api.patch(`/api/timers/${t.id}`, { pinned: t.pinned ? 0 : 1 });
        await poll();
      } catch (e) { showErr(e); }
    });
    actBtn.addEventListener('click', async () => {
      actBtn.disabled = true;
      // Whichever timer this click stops — this one (Stop) or the one the
      // server's start-exclusivity stops (Start) — gets the close-out pane,
      // once the poll confirms the stop banked something to narrate.
      const stopping = t.running ? t : timers.find((x) => x.running);
      try {
        await api.post(`/api/timers/${t.id}/${t.running ? 'stop' : 'start'}`);
        localStorage.setItem('tk:lastTimer', String(t.id));
        await poll();
        if (stopping && closeoutTimer(timers, stopping.id)) {
          closeoutId = stopping.id;
          expandedId = null;
          render();
          focusNarrative(stopping.id);
        }
      } catch (e) { showErr(e); } finally { actBtn.disabled = false; }
    });

    row.appendChild(bar);
    if (t.id === expandedId) row.appendChild(buildDetail(t));
    return row;
  }

  function render() {
    // never rebuild under a focused textarea (blur flushes) or while a
    // pointer is pressed (the doc-level click listener flushes)
    if (narrFocused() || pointerHeld) { pendingRender = true; return; }
    pendingRender = false;
    const rows = buildPipRows(timers, extras);
    localStorage.setItem('tk:pipRows', String(rows.length || 1));
    if (expandedId !== null && !rows.some((t) => t.id === expandedId)) expandedId = null;
    const co = closeoutId === null ? null : closeoutTimer(timers, closeoutId);
    if (!co) closeoutId = null;
    if (co) {
      // close-out owns the window; the list comes back on Done / Esc
      findOpen = false;
      findEl.hidden = true;
      findEl.replaceChildren();
      rowsEl.replaceChildren();
      rowsEl.hidden = true;
      emptyEl.hidden = true;
      buildCloseout(co);
      closeoutEl.hidden = false;
    } else if (findOpen) {
      // the find pane owns the window; deliberately NOT rebuilt here — a poll
      // mid-typing must not clobber the filter input
      rowsEl.replaceChildren();
      rowsEl.hidden = true;
      emptyEl.hidden = true;
      closeoutEl.hidden = true;
    } else {
      closeoutEl.hidden = true;
      closeoutEl.replaceChildren();
      closeoutEl.removeAttribute('data-id');
      findEl.hidden = true;
      rowsEl.hidden = false;
      rowsEl.replaceChildren(...rows.map(buildRow));
      emptyEl.hidden = rows.length > 0;
    }
    totalEl.textContent = fmtDayTotal(rows.reduce((s, t) => s + secsOf(t), 0));
    doc.body.classList.toggle('running', rows.some((t) => t.running));
  }

  // The find pane (2026-07-29 feedback, replacing the past-week-only "Recent"
  // picker): the dashboard's filter box, shrunk to fit the float. Type to
  // narrow EVERY timer not already on the list; ↑/↓ walk the hits, Enter takes
  // the highlighted one, Esc closes. Picking adds the timer to today's list,
  // STARTS it, and opens its narrative. Built once per open — poll renders
  // leave it alone.
  function closeFind() {
    findOpen = false;
    findEl.replaceChildren();
    render();
  }
  function openFind() {
    findOpen = true;
    const input = doc.createElement('input');
    input.className = 'find-filter';
    input.placeholder = 'Find a timer — Esc closes';
    const count = doc.createElement('div');
    count.className = 'find-count';
    const list = doc.createElement('div');
    list.className = 'find-list';
    let hits = [];
    let cursor = 0;
    const pick = async (t) => {
      extras.add(t.id);
      saveExtras();
      findOpen = false;
      findEl.replaceChildren();
      expandedId = t.id;
      // You went looking for this timer because you're starting on it, so
      // start it (2026-08-06 feedback) — the same path as the row's ▶,
      // close-out pane included for whatever the server stops.
      const { start, stoppingId } = pickPlan(timers, t);
      if (start) {
        try {
          await api.post(`/api/timers/${t.id}/start`);
          localStorage.setItem('tk:lastTimer', String(t.id));
          await poll();
        } catch (e) { showErr(e); }
      }
      if (stoppingId !== null && closeoutTimer(timers, stoppingId)) {
        closeoutId = stoppingId;
        expandedId = null;
        render();
        focusNarrative(stoppingId);
        return;
      }
      render();
      focusNarrative(t.id);
    };
    const highlight = () => {
      [...list.children].forEach((el, i) => el.classList.toggle('on', i === cursor));
      const on = list.children[cursor];
      if (on && on.scrollIntoView) on.scrollIntoView({ block: 'nearest' });
    };
    const rebuild = () => {
      hits = findPickList(timers, extras, input.value);
      cursor = 0;
      count.textContent = hits.length ? `${hits.length} timer${hits.length === 1 ? '' : 's'}` : '';
      list.replaceChildren(...hits.map((t) => {
        const b = doc.createElement('button');
        b.type = 'button';
        b.className = 'find-item';
        const name = doc.createElement('span');
        name.textContent = t.name;
        b.appendChild(name);
        // the caption often hides the matter — show the number, as the
        // dashboard card's tooltip does
        if (t.cm_number) {
          const sub = doc.createElement('span');
          sub.className = 'sub';
          sub.textContent = t.cm_number;
          b.appendChild(sub);
        }
        b.title = t.cm_id ? `${t.cm_short_name} · ${t.cm_number}` : 'no matter yet';
        b.addEventListener('click', () => pick(t));
        return b;
      }));
      if (hits.length === 0) {
        const none = doc.createElement('div');
        none.className = 'find-none';
        none.textContent = input.value.trim()
          ? 'No timer matches.' : 'Every timer is already on the list.';
        list.replaceChildren(none);
      }
      highlight();
      return hits;
    };
    input.addEventListener('input', rebuild);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { closeFind(); return; }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (hits.length === 0) return;
        e.preventDefault();
        cursor = (cursor + (e.key === 'ArrowDown' ? 1 : -1) + hits.length) % hits.length;
        highlight();
        return;
      }
      if (e.key === 'Enter' && hits[cursor]) pick(hits[cursor]);
    });
    rebuild();
    findEl.replaceChildren(input, count, list);
    findEl.hidden = false;
    render();
    input.focus();
  }
  doc.querySelector('[data-find-btn]').addEventListener('click', () => {
    if (findOpen) closeFind(); else openFind();
  });

  // Alt+↑/↓ nudges the clock ±0.1h (Shift: ±0.2h) — the grid's chord, live
  // in the float too (2026-07-15 feedback). Alt chords never type into the
  // narrative textarea, so this stays active while writing. Targets the
  // surface the user is on: the close-out pane's timer, else the expanded
  // row, else the running timer.
  doc.addEventListener('keydown', async (e) => {
    if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    e.preventDefault();
    const id = closeoutId ?? expandedId ?? timers.find((t) => t.running)?.id;
    if (id == null) return;
    const deltaHours = (e.shiftKey ? 0.2 : 0.1) * (e.key === 'ArrowUp' ? 1 : -1);
    try {
      const r = await api.put(`/api/timers/${id}/clock`, { deltaHours });
      // a nudge that lands on a linked entry changes entry data too — announce
      // it like the grid's clockDelta does, so the main window's lists refresh
      if (r.entry) window.dispatchEvent(new CustomEvent('tk:entries-changed'));
      await poll();
      // a focused narrative defers render() — repaint the close-out clock by
      // hand (row clocks repaint on the next 1s tick regardless)
      const t = timers.find((x) => x.id === id);
      const co = doc.querySelector('.closeout .co-time b');
      if (co && closeoutId === id && t) setClock(co, secsOf(t));
    } catch (err) { showErr(err); }
  });

  // 1s tick: clocks + total only — no DOM rebuild, so typing is undisturbed
  const tick = () => {
    const rows = buildPipRows(timers, extras);
    for (const t of rows) {
      const el = rowsEl.querySelector(`.row[data-id="${t.id}"] [data-clock]`);
      if (el) setClock(el, secsOf(t));
    }
    totalEl.textContent = fmtDayTotal(rows.reduce((s, t) => s + secsOf(t), 0));
  };

  doc.querySelector('[data-quick]').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      const t = await api.post('/api/timers', {});
      await api.post(`/api/timers/${t.id}/start`);
      localStorage.setItem('tk:lastTimer', String(t.id));
      // no close-out here even though + exclusivity-stops the running timer:
      // the + flow's whole point (spec §4) is capturing the interruption in
      // the NEW timer's narrative right now
      closeoutId = null;
      expandedId = t.id;
      await poll();
      focusNarrative(t.id);
    } catch (err) { showErr(err); } finally { btn.disabled = false; }
  });

  await poll();
  const p = pipWin.setInterval(poll, 5000);
  // Instant sync with the rest of the app: api.js announces every timer
  // mutation (grid buttons, entry-card start/stop, this float's own actions)
  // on the MAIN window — re-poll right away instead of waiting out the 5s.
  const onTimersChanged = () => poll();
  window.addEventListener('tk:timers-changed', onTimersChanged);
  pipWin.addEventListener('pagehide', () => {
    pipWin.clearInterval(p);
    stopTick();
    window.removeEventListener('tk:timers-changed', onTimersChanged);
    themeObs.disconnect();
    pipWin = null;
  });
  return true;
}
