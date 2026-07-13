// SPIKE — always-on-top floating mini timer (TODO.md "AOT Timer" idea).
//
// A PWA window can't set itself always-on-top, but Chrome 116+'s Document
// Picture-in-Picture API can open a small utility window that the OS keeps
// above everything, the same surface video sites use for floating players.
// It shares this page's JS context and origin, so the same api.js client and
// session cookie work inside it. Caveats found while spiking:
//   - Chrome/Edge desktop only (no Firefox/Safari/mobile); needs a secure
//     context (localhost or the cloudflared https host) and a user gesture.
//   - One PiP window per tab; closing the tab closes it. The main tab keeps
//     running its own polls, and the dashboard re-polls every 5s, so timer
//     actions taken here show up there within a poll.
//   - The window is chromeless: no tab title, favicon badge, or nav — it
//     needs its own inline styles (stylesheets are NOT inherited).
//
// The floating card mirrors the timer-card idiom: big mono clock, caption,
// one Start/Stop button driving the same /api/timers endpoints. Ticks locally
// off elapsed_seconds + wall-clock delta (same trick as lib/titlebar.js).

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

const PIP_CSS = `
  * { margin: 0; box-sizing: border-box; }
  body {
    font: 13px/1.35 system-ui, sans-serif;
    background: #14161b; color: #e8eaf0;
    height: 100vh; display: flex; flex-direction: column;
    justify-content: center; gap: 2px; padding: 10px 14px;
    border-left: 4px solid #3a3f4b; user-select: none;
  }
  body.running { border-left-color: #e11d48; }
  .clock {
    font-family: ui-monospace, monospace; font-size: 30px; font-weight: 700;
    letter-spacing: 1px; display: flex; align-items: center; gap: 10px;
  }
  .dot { width: 10px; height: 10px; border-radius: 50%; background: #3a3f4b; flex: none; }
  body.running .dot { background: #e11d48; animation: pulse 1.6s ease-in-out infinite; }
  @keyframes pulse { 50% { opacity: 0.35; } }
  .caption {
    color: #aab0bf; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  body.running .caption { color: #e8eaf0; }
  button {
    position: absolute; right: 10px; top: 10px;
    font: 600 12px system-ui, sans-serif; color: #e8eaf0;
    background: #262a33; border: 1px solid #3a3f4b; border-radius: 6px;
    padding: 4px 10px; cursor: pointer;
  }
  button:hover { background: #313644; }
  .err { color: #f0a5b8; font-size: 12px; }
`;

let pipWin = null; // one floating window per tab (mirrors the API's own limit)

export async function toggleTimerPip() {
  if (pipWin && !pipWin.closed) { pipWin.close(); pipWin = null; return false; }

  // requestWindow first — it consumes the click's transient activation, and
  // an awaited import in front of it could outlive that window.
  pipWin = await window.documentPictureInPicture.requestWindow({ width: 300, height: 92 });
  const { api } = await import('/js/api.js');
  const doc = pipWin.document;
  doc.head.appendChild(doc.createElement('style')).textContent = PIP_CSS;
  doc.body.innerHTML = `
    <div class="clock"><span class="dot"></span><span data-clock>--:--</span></div>
    <div class="caption" data-caption>Loading…</div>
    <button data-toggle hidden>Start</button>`;

  const el = {
    clock: doc.querySelector('[data-clock]'),
    caption: doc.querySelector('[data-caption]'),
    toggle: doc.querySelector('[data-toggle]'),
  };

  let timers = null;
  let fetchedAt = 0;
  const poll = () => api.get('/api/timers')
    .then((t) => { timers = t; fetchedAt = Date.now(); render(); })
    .catch((e) => { el.caption.textContent = `Can’t reach server — ${e.message}`; el.caption.className = 'err'; });

  const render = () => {
    const t = buildPipRows(timers)[0] || null;
    if (!t) {
      el.clock.textContent = '--:--';
      el.caption.textContent = timers ? 'No timers yet — add one on the dashboard.' : 'Loading…';
      el.toggle.hidden = true;
      doc.body.classList.remove('running');
      return;
    }
    const secs = t.elapsed_seconds + (t.running ? Math.max(0, (Date.now() - fetchedAt) / 1000) : 0);
    el.clock.textContent = fmtClock(secs);
    el.caption.textContent = t.name;
    el.caption.className = 'caption';
    el.caption.title = t.cm_short_name ? `${t.cm_short_name} · ${t.cm_number}` : 'no matter yet';
    el.toggle.textContent = t.running ? 'Stop' : 'Start';
    el.toggle.hidden = false;
    doc.body.classList.toggle('running', !!t.running);
  };

  el.toggle.addEventListener('click', async () => {
    const t = buildPipRows(timers)[0] || null;
    if (!t) return;
    el.toggle.disabled = true;
    try {
      await api.post(`/api/timers/${t.id}/${t.running ? 'stop' : 'start'}`);
      localStorage.setItem('tk:lastTimer', String(t.id));
      await poll();
    } catch (e) {
      el.caption.textContent = e.message;
      el.caption.className = 'err';
    } finally {
      el.toggle.disabled = false;
    }
  });

  await poll();
  const p = pipWin.setInterval(poll, 5000);
  const tick = pipWin.setInterval(render, 1000);
  pipWin.addEventListener('pagehide', () => {
    pipWin.clearInterval(p);
    pipWin.clearInterval(tick);
    pipWin = null;
  });
  return true;
}
