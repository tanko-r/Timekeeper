// ============================================================================
// RunBar — the persistent running-timer bar.
//
// The teardown's most serious finding (§7, §D1): "Navigate to Calendar and the
// clock vanishes. In an installed PWA even the tab title is invisible. A
// timekeeping app must never be able to run a timer the user cannot see."
// Measured before this file existed: `footerH: 0` on calendar, search, stats,
// cms, export and settings — the live clock was rendered by the DASHBOARD, so
// it only existed on one of seven screens.
//
// So this component owns the whole "a timer is running" presence, in all three
// places it can be shown, from ONE poll and ONE aligned tick:
//
//   1. the bar itself — matter name, live clock, Stop, and (where the browser
//      supports it) the float/pop-out control, pinned above the content on
//      EVERY route;
//   2. the tab title and favicon (the installed PWA's taskbar preview), which
//      app.js used to poll for separately;
//   3. the OS app badge.
//
// It renders null when nothing is running, and keeps polling — a bar that
// appeared only after a re-render would miss a timer started in the float
// window or on the phone.
//
// WHERE IT SITS is a stacking decision, made in runbar.css and repeated here
// because it is the part a future hand will get wrong: the bar is at the TOP.
// The phone already spends 14% of its screen on two stacked bottom bars (the
// navigation bar and the dashboard's day footer); a third would be
// indefensible, and the top edge is the one piece of permanent chrome no other
// module claims. It clears the sidebar/rail on wider screens rather than
// painting over the brand, and it sits below --z-overlay so every dialog still
// covers it (and is marked inert with the rest of .shell while one is open).
// ============================================================================
import { api } from '/js/api.js';
import { html, useState, useEffect, useRef, useCallback, fmtClock, fmtHours, emitToast, todayStr, Icon } from '/js/ui.js';
import { startAlignedTick } from '/js/lib/tick.js';
import { runningTitle, IDLE_ICON, RUNNING_ICON } from '/js/lib/titlebar.js';
import { pipSupported, toggleTimerPip } from '/js/lib/pip.js';

const POLL_MS = 5000;

// THE DAY'S FILED TOTAL, FOR THE WHOLE SHELL.
//
// It used to be rendered by the dashboard's day footer, which is a dashboard
// component — so on Calendar, Entries and Settings the number a lawyer manages
// his day by simply did not exist. One read of the stats range endpoint (no
// API change), refreshed on every entry write and on wake, shared by the run
// bar and the phone's bottom bar so the figure is stated once per viewport.
export function useDayTotal(enabled = true) {
  const [total, setTotal] = useState(null);
  useEffect(() => {
    if (!enabled) return undefined;
    let alive = true;
    const poll = () => {
      const d = todayStr();
      api.get(`/api/stats?from=${d}&to=${d}`)
        .then((s) => { if (alive && s && typeof s.totalHours === 'number') setTotal(s.totalHours); })
        .catch(() => {});
    };
    poll();
    const id = setInterval(poll, POLL_MS * 6);
    const onWake = () => { if (document.visibilityState === 'visible') poll(); };
    window.addEventListener('tk:entries-changed', poll);
    window.addEventListener('tk:timers-changed', poll);
    document.addEventListener('visibilitychange', onWake);
    window.addEventListener('focus', onWake);
    return () => {
      alive = false;
      clearInterval(id);
      window.removeEventListener('tk:entries-changed', poll);
      window.removeEventListener('tk:timers-changed', poll);
      document.removeEventListener('visibilitychange', onWake);
      window.removeEventListener('focus', onWake);
    };
  }, [enabled]);
  return total;
}

// One poll for every running-timer surface. `tk:timers-changed` (dispatched by
// api.js after any successful /api/timers write, wherever it was made — this
// bar, the grid, an entry card, the float) refreshes it immediately, so the
// 5s poll is only a backstop for writes made in another window.
function useTimers(enabled) {
  const [state, setState] = useState({ timers: null, fetchedAt: 0 });
  useEffect(() => {
    if (!enabled) return undefined;
    let alive = true;
    const poll = () => api.get('/api/timers')
      .then((t) => { if (alive) setState({ timers: t, fetchedAt: Date.now() }); })
      .catch(() => {});
    poll();
    const id = setInterval(poll, POLL_MS);
    // Mobile suspends timers in a backgrounded PWA, so the clock is stale the
    // instant the app comes back — same wake pattern the dashboard uses.
    const onWake = () => { if (document.visibilityState === 'visible') poll(); };
    window.addEventListener('tk:timers-changed', poll);
    window.addEventListener('tk:entries-changed', poll);
    document.addEventListener('visibilitychange', onWake);
    window.addEventListener('focus', onWake);
    return () => {
      alive = false;
      clearInterval(id);
      window.removeEventListener('tk:timers-changed', poll);
      window.removeEventListener('tk:entries-changed', poll);
      document.removeEventListener('visibilitychange', onWake);
      window.removeEventListener('focus', onWake);
    };
  }, [enabled]);
  return state;
}

// Tab title + favicon + app badge: the same running-timer fact, in the OS
// chrome. Kept here rather than in app.js so there is exactly one poll and one
// place that decides what "running" means.
function useBrowserChrome(timers, fetchedAt, enabled) {
  // Held in a ref so the 1s tick is created once and not torn down and rebuilt
  // on every 5s poll.
  const latest = useRef({ timers, fetchedAt });
  latest.current = { timers, fetchedAt };
  useEffect(() => {
    if (!enabled) return undefined;
    let badged = null;
    const apply = () => {
      const { timers: ts, fetchedAt: at } = latest.current;
      const { title, running } = runningTitle(ts, Date.now(), at);
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
    apply();
    const t = setInterval(apply, 1000);
    return () => { clearInterval(t); document.title = 'Timekeeper'; };
  }, [enabled]);
}

export function RunBar({ enabled = true, dayTotal = null, showTotal = false }) {
  const { timers, fetchedAt } = useTimers(enabled);
  const [busy, setBusy] = useState(false);
  const [, tick] = useState(0);
  const running = (timers || []).filter((t) => t.running);
  const live = running.length > 0;

  useBrowserChrome(timers, fetchedAt, enabled);

  // Aligned to the fetch so the seconds never hang and then jump two counts.
  useEffect(() => {
    if (!live) return undefined;
    return startAlignedTick(fetchedAt || 0, () => tick((x) => x + 1));
  }, [live, fetchedAt]);

  // The content offset lives on <html>, next to .tk-overlay-open, for the same
  // reason: "a bar is pinned over the page" is a document-level fact, and the
  // shell's padding has to answer it at three different breakpoints. Written
  // imperatively so a bar that appears mid-session does not depend on the app
  // root re-rendering to make room for itself.
  // TWO STATES, TWO OFFSETS. `tk-runbar` says a bar is on the top edge at all;
  // `tk-running` says it is the taller, live one. The resting bar carries only
  // the day's filed total, so it is a slim strip — and on a phone it stands
  // down altogether, because there the bottom bar states that number (see the
  // ownership note at the end of runbar.css).
  const mounted = live || showTotal;
  useEffect(() => {
    document.documentElement.classList.toggle('tk-runbar', mounted);
    document.documentElement.classList.toggle('tk-running', live);
    return () => {
      document.documentElement.classList.remove('tk-runbar');
      document.documentElement.classList.remove('tk-running');
    };
  }, [live, mounted]);

  const stopAll = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      for (const t of running) {
        // Same contract as the timer grid's own Stop: a stop under the
        // rounding increment keeps counting, a sub-2s misclick is discarded,
        // and a real one files an entry that still needs its narrative.
        const r = await api.post(`/api/timers/${t.id}/stop`);
        if (r.entry) {
          // api.js announces the timer write; the ENTRY write is a side effect
          // of it, so the dashboard's entry list has to be told separately.
          window.dispatchEvent(new CustomEvent('tk:entries-changed'));
          emitToast(`Filed ${fmtHours(r.hours)}h — ${t.name}`, {
            actionLabel: 'Write narrative',
            action: () => window.dispatchEvent(
              new CustomEvent('tk:open-entry', { detail: { id: r.entry.id } })),
          });
        } else if (r.discarded) {
          emitToast('Misclick (under 2s) — nothing recorded.');
        } else {
          emitToast(`Nothing to file yet — clock keeps counting (${fmtClock(r.seconds)}).`);
        }
      }
    } catch (e) {
      emitToast(String(e.message || e), { error: true });
    } finally {
      setBusy(false);
    }
  }, [busy, running]);

  const popOut = useCallback(() => {
    toggleTimerPip().catch((e) => emitToast(String(e.message || e), { error: true }));
  }, []);

  if (!mounted) return null;

  // The day's number, wherever the bar is. It is the only place it exists on
  // Calendar, Entries and Settings — measured before this: nowhere at all.
  const total = showTotal && dayTotal != null ? html`
    <span class="runbar-total" title="Filed today (all entries)">
      <strong class="mono">${fmtHours(dayTotal)}h</strong>
      <span class="muted small">filed</span>
    </span>` : null;

  if (!live) {
    return html`
      <div class="runbar resting" role="region" aria-label="Today">
        ${total}
        <span class="runbar-gap"></span>
      </div>`;
  }

  const first = running[0];
  const secs = running.reduce(
    (s, t) => s + t.elapsed_seconds, 0)
    + running.length * (fetchedAt ? Math.max(0, Math.floor((Date.now() - fetchedAt) / 1000)) : 0);
  const clock = fmtClock(secs);
  const name = running.length === 1 ? first.name : `${running.length} timers running`;

  return html`
    <div class="runbar" role="region" aria-label="Running timer">
      <span class="runbar-live" aria-hidden="true"></span>
      <span class="runbar-name" title=${running.map((t) => t.name).join(', ')}>${name}</span>
      <span class="runbar-clock t-clock t-clock-lg" aria-label=${`Running ${clock}`}>${clock}</span>
      <span class="runbar-gap"></span>
      ${total}
      ${pipSupported() ? html`
        <button type="button" class="btn btn-ghost btn-icon runbar-pop"
          title="Float this timer in a small always-on-top window"
          aria-label="Float timer window" onClick=${popOut}>
          <${Icon} name="copy" size=${16} />
        </button>` : null}
      <button type="button" class="btn runbar-stop" disabled=${busy} onClick=${stopAll}>
        <${Icon} name="stop" size=${14} /> Stop
      </button>
    </div>`;
}
