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

export function pipSupported() {
  return typeof window !== 'undefined' && 'documentPictureInPicture' in window;
}

// Which timers earn a row: running, any clock time today (includes held time
// carried from earlier days), or pinned (timers.pinned — the whole point of
// pinning is surviving the midnight reset). Running first; otherwise the
// server's dashboard order is preserved — never time-sorted, rows must not
// jump while the user watches. Pure — unit-tested in test/pip.test.js.
export function buildPipRows(timers) {
  const list = (timers || []).filter((t) => t.running || t.elapsed_seconds > 0 || t.pinned);
  return [...list.filter((t) => t.running), ...list.filter((t) => !t.running)];
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

export function fmtDayTotal(totalSeconds) {
  return `${(Math.max(0, totalSeconds) / 3600).toFixed(1)}h today`;
}

// mirrors ui.js fmtClock (which pulls in the React vendor bundle — not
// importable here for the same reason lib/titlebar.js copies it)
export function fmtClock(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const hh = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return hh > 0 ? `${hh}:${mm}:${ss}` : `${mm}:${ss}`;
}

// Mirrors app.css's design tokens (copied by hand — stylesheets are NOT
// inherited into the PiP document): light by default, dark via the OS
// preference, and the app's explicit Settings theme wins through the
// data-theme attribute mirrored from the main document in toggleTimerPip.
const PIP_CSS = `
  :root {
    --surface-1: #fcfcfb; --surface-2: #efefec; --border: #dddcd6;
    --text-primary: #0b0b0b; --text-secondary: #52514e; --text-muted: #8b8a84;
    --accent: #2a78d6; --danger: #d03b3b; --good: #0ca30c;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --surface-1: #1a1a19; --surface-2: #242422; --border: #3a3a37;
      --text-primary: #ffffff; --text-secondary: #c3c2b7;
      --accent: #3987e5;
    }
  }
  :root[data-theme="dark"] {
    --surface-1: #1a1a19; --surface-2: #242422; --border: #3a3a37;
    --text-primary: #ffffff; --text-secondary: #c3c2b7;
    --accent: #3987e5;
  }
  * { margin: 0; box-sizing: border-box; }
  [hidden] { display: none !important; }
  body {
    font: 12px/1.35 system-ui, sans-serif;
    background: var(--surface-1); color: var(--text-primary);
    height: 100vh; display: flex; flex-direction: column;
    border-left: 4px solid var(--border); user-select: none;
  }
  body.running { border-left-color: var(--accent); }
  .rows { flex: 1; overflow-y: auto; }
  .row { border-bottom: 1px solid var(--border); }
  .rowbar { display: flex; align-items: center; gap: 7px; padding: 6px 8px; cursor: pointer; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--border); flex: none; }
  .row.running .dot { background: var(--accent); animation: pulse 1.6s ease-in-out infinite; }
  @keyframes pulse { 50% { opacity: 0.35; } }
  .clock { font-family: ui-monospace, monospace; font-weight: 700; font-size: 14px; flex: none; min-width: 54px; }
  .row.running .clock { color: var(--accent); }
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
    font: 600 11px system-ui, sans-serif; color: var(--text-primary);
    background: var(--surface-2); border: 1px solid var(--border); border-radius: 5px;
    padding: 3px 9px; cursor: pointer; flex: none;
  }
  .act:hover { border-color: var(--text-muted); }
  .row.running .act { background: var(--accent); border-color: var(--accent); color: #fff; }
  .detail { padding: 0 8px 8px 23px; }
  .cap { color: var(--text-muted); font-size: 11px; margin-bottom: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  textarea {
    width: 100%; font: 12px/1.35 system-ui, sans-serif; color: var(--text-primary);
    background: var(--surface-2); border: 1px solid var(--border); border-radius: 5px;
    padding: 4px 6px; resize: none;
  }
  textarea:focus { outline: none; border-color: var(--accent); }
  .ro { color: var(--text-secondary); }
  .hint { color: var(--text-muted); font-size: 10px; margin-top: 2px; }
  .saved { color: var(--good); font-size: 11px; opacity: 0; transition: opacity 0.2s; }
  .saved.show { opacity: 1; }
  .rowerr { color: var(--danger); font-size: 11px; margin-top: 3px; }
  .empty { flex: 1; display: flex; align-items: center; justify-content: center; color: var(--text-muted); padding: 12px; text-align: center; }
  .err { color: var(--danger); font-size: 11px; padding: 4px 8px; }
  .foot { flex: none; display: flex; align-items: center; justify-content: space-between; padding: 5px 8px; border-top: 1px solid var(--border); }
  .total { color: var(--text-secondary); font-family: ui-monospace, monospace; font-size: 11px; }
  .quick {
    font: 700 14px/1 system-ui, sans-serif; color: var(--text-primary);
    background: var(--surface-2); border: 1px solid var(--border); border-radius: 5px;
    width: 24px; height: 22px; cursor: pointer;
  }
  .quick:hover { border-color: var(--text-muted); }
`;

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
  const doc = pipWin.document;
  doc.head.appendChild(doc.createElement('style')).textContent = PIP_CSS;

  // Follow the app's theme: the OS preference flows in via the media query
  // in PIP_CSS; an explicit Settings choice lives as data-theme on the MAIN
  // document's root (app.js applyTheme) — copy it over and mirror changes.
  const mainRoot = document.documentElement;
  const syncTheme = () => {
    const t = mainRoot.getAttribute('data-theme');
    if (t) doc.documentElement.setAttribute('data-theme', t);
    else doc.documentElement.removeAttribute('data-theme');
  };
  syncTheme();
  const themeObs = new MutationObserver(syncTheme);
  themeObs.observe(mainRoot, { attributes: true, attributeFilter: ['data-theme'] });
  doc.body.innerHTML = `
    <div class="rows" data-rows></div>
    <div class="empty" data-empty hidden>No time today — pin a timer or hit +.</div>
    <div class="err" data-err hidden></div>
    <div class="foot">
      <span class="total" data-total>…</span>
      <button class="quick" data-quick title="Quick timer — starts now; assign a matter later">+</button>
    </div>`;

  const rowsEl = doc.querySelector('[data-rows]');
  const emptyEl = doc.querySelector('[data-empty]');
  const errEl = doc.querySelector('[data-err]');
  const totalEl = doc.querySelector('[data-total]');

  let timers = [];
  let fetchedAt = 0;
  let expandedId = null; // one expanded row at a time
  const drafts = new Map(); // timer id → unsaved narrative text
  const debounces = new Map(); // timer id → save debounce handle
  let pendingRender = false; // a render was skipped to protect a focused textarea

  const secsOf = (t) => t.elapsed_seconds + (t.running ? Math.max(0, (Date.now() - fetchedAt) / 1000) : 0);
  const narrFocused = () => doc.activeElement && doc.activeElement.tagName === 'TEXTAREA';

  const showErr = (e) => { errEl.textContent = e.message; errEl.hidden = false; };

  const poll = () => api.get('/api/timers')
    .then((t) => { timers = t; fetchedAt = Date.now(); errEl.hidden = true; render(); })
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
    const rowErr = rowsEl.querySelector(`.row[data-id="${id}"] [data-rowerr]`);
    try {
      if (narrativeMode(t) === 'stash') {
        await api.patch(`/api/timers/${id}`, { draft_narrative: text });
      } else {
        await api.patch(`/api/entries/${t.linked_entry_id}`, { narrative: text });
      }
      if (drafts.get(id) === text) drafts.delete(id);
      if (rowErr) rowErr.textContent = '';
      const flash = rowsEl.querySelector(`.row[data-id="${id}"] [data-saved]`);
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
    const ta = rowsEl.querySelector(`.row[data-id="${id}"] textarea`);
    if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
  }

  function buildDetail(t) {
    const detail = doc.createElement('div');
    detail.className = 'detail';
    const cap = doc.createElement('div');
    cap.className = 'cap';
    cap.textContent = t.cm_id
      ? `${t.cm_short_name} · ${t.cm_number}`
      : (t.held_since
        ? `no matter yet — holding time since ${t.held_since}`
        : 'no matter yet — narrative is stashed until one is assigned');
    detail.appendChild(cap);

    if (narrativeMode(t) === 'readonly') {
      const ro = doc.createElement('div');
      ro.className = 'ro';
      ro.textContent = narrativeValue(t);
      const hint = doc.createElement('div');
      hint.className = 'hint';
      hint.textContent = 'split entry — edit in app';
      detail.append(ro, hint);
      return detail;
    }

    const ta = doc.createElement('textarea');
    ta.rows = 2;
    ta.value = drafts.has(t.id) ? drafts.get(t.id) : narrativeValue(t);
    ta.addEventListener('input', () => {
      drafts.set(t.id, ta.value);
      clearTimeout(debounces.get(t.id));
      debounces.set(t.id, pipWin.setTimeout(() => saveNarrative(t.id), 600));
    });
    ta.addEventListener('blur', () => {
      saveNarrative(t.id);
      if (pendingRender) { pendingRender = false; render(); }
    });
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        // collapse: blur triggers the save AND the deferred re-render
        expandedId = null;
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
    detail.append(ta, saved, rowErr);
    return detail;
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
    bar.querySelector('[data-clock]').textContent = fmtClock(secsOf(t));
    bar.querySelector('.name').textContent = t.name;
    const pinBtn = bar.querySelector('[data-pin]');
    pinBtn.textContent = '📌';
    pinBtn.title = t.pinned
      ? 'Unpin — drops off this window once its day is over'
      : 'Pin — keeps this timer here across days';
    const actBtn = bar.querySelector('[data-act]');
    actBtn.textContent = t.running ? 'Stop' : 'Start';
    actBtn.title = t.running ? 'Stop & file time' : 'Start';

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
      try {
        await api.post(`/api/timers/${t.id}/${t.running ? 'stop' : 'start'}`);
        localStorage.setItem('tk:lastTimer', String(t.id));
        await poll();
      } catch (e) { showErr(e); } finally { actBtn.disabled = false; }
    });

    row.appendChild(bar);
    if (t.id === expandedId) row.appendChild(buildDetail(t));
    return row;
  }

  function render() {
    // never rebuild under a focused textarea — the blur handler re-renders
    if (narrFocused()) { pendingRender = true; return; }
    const rows = buildPipRows(timers);
    localStorage.setItem('tk:pipRows', String(rows.length || 1));
    if (expandedId !== null && !rows.some((t) => t.id === expandedId)) expandedId = null;
    rowsEl.replaceChildren(...rows.map(buildRow));
    emptyEl.hidden = rows.length > 0;
    totalEl.textContent = fmtDayTotal(rows.reduce((s, t) => s + secsOf(t), 0));
    doc.body.classList.toggle('running', rows.some((t) => t.running));
  }

  // 1s tick: clocks + total only — no DOM rebuild, so typing is undisturbed
  const tick = () => {
    const rows = buildPipRows(timers);
    for (const t of rows) {
      const el = rowsEl.querySelector(`.row[data-id="${t.id}"] [data-clock]`);
      if (el) el.textContent = fmtClock(secsOf(t));
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
      expandedId = t.id;
      await poll();
      focusNarrative(t.id);
    } catch (err) { showErr(err); } finally { btn.disabled = false; }
  });

  await poll();
  const p = pipWin.setInterval(poll, 5000);
  const k = pipWin.setInterval(tick, 1000);
  pipWin.addEventListener('pagehide', () => {
    pipWin.clearInterval(p);
    pipWin.clearInterval(k);
    themeObs.disconnect();
    pipWin = null;
  });
  return true;
}
