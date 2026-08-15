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
// When it was written the phone was already spending 14% of its screen on two
// stacked bottom bars (the navigation bar and the dashboard's day footer) and a
// third would have been indefensible; the top edge is the one piece of
// permanent chrome no other module claims. It clears the sidebar/rail on wider
// screens rather than painting over the brand, and it sits below --z-overlay so
// every dialog still covers it (and is marked inert with the rest of .shell
// while one is open).
//
// ---------------------------------------------------------------------------
// WAVE 2 — THIS BAR IS NOW THE APP'S ONLY PERSISTENT BAR, and it absorbed the
// two things that used to need their own.
//
// The wave-1 review measured what the first version cost: desktop Today
// carried .runbar (48px) at the top AND .today-footer (49px) at the bottom —
// 97px of permanent chrome, both saying "5.5h filed", which the day's stat
// strip 700px above them also said. Against 49px before the overhaul began.
// And the phone's bottom bar had grown to seven slots (a filed total, four
// destinations, capture, close) in 390px, where Material 3 caps a navigation
// bar at five destinations.
//
// So the day footer is gone (components/todayfooter.js renders nothing now)
// and the phone's bar is back to five, and both of their contents live here:
//
//   the FILED TOTAL — but only on the screens that do not already state it.
//     Today's own stat strip says "5.5h filed today" with the billable split,
//     the target and the week beside it, which is strictly more than this bar
//     could. Repeating it 20px higher is precisely the defect the review
//     raised, so app.js passes showTotal only away from Today. Everywhere else
//     this bar is the ONLY place the number exists.
//   CLOSE THE DAY — only on Today, because `c` only fires on Today and because
//     a "Close" control on Calendar closed a day other than the one on screen
//     (the review's own D6). Touch and keyboard now agree about where and when
//     the day can be closed.
//
// The bar's height therefore follows what it is carrying rather than being a
// constant slab: a figures-only STRIP where it has nothing to be pressed, and a
// full BAR wherever it does — which is Today (Close the day) and any screen
// with a timer running (Stop). Those two are the same height on purpose; see
// runbar.css.
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
// API change), refreshed on every entry write and on wake. Exactly one surface
// consumes it now — this bar — so the figure cannot be stated twice at any
// width, which is what the day footer and the phone's bottom-bar label were
// doing to it a wave ago.
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

export function RunBar({
  enabled = true, dayTotal = null, showTotal = false,
  showClose = false, onCloseDay = null,
}) {
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
  //
  // THREE CLASSES, because the bar's height follows its contents:
  //   tk-runbar      a bar is on the top edge at all — the figures-only strip.
  //   tk-runbar-act  …and it carries a control (Close the day, on Today).
  //   tk-running     …and a timer is live, so it carries Stop as well.
  // The last two are the same height on purpose (runbar.css says why): Today is
  // the screen that has a control at rest AND the screen made of timers being
  // started and stopped, so the list under the bar must not move on every click.
  // Set together — act and running are refinements of runbar — and read in that
  // order by runbar.css so the last one that applies wins.
  //
  // The bar is ALWAYS mounted now. It used to appear only when a timer ran or
  // when the day's total had nowhere else to go, which is how `.runbar.resting`
  // ended up computing to height 0 on a phone while still rendering the text
  // "5.6h filed" — a fixed element painting nothing. A bar that comes and goes
  // also shoved the page down 53px every time a timer started.
  const hasAction = showClose;
  useEffect(() => {
    const cl = document.documentElement.classList;
    cl.toggle('tk-runbar', enabled);
    cl.toggle('tk-runbar-act', enabled && hasAction && !live);
    cl.toggle('tk-running', enabled && live);
    return () => { cl.remove('tk-runbar', 'tk-runbar-act', 'tk-running'); };
  }, [enabled, live, hasAction]);

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

  if (!enabled) return null;

  // The day's number. It is the ONLY place it exists on Calendar, Entries and
  // Settings — measured before this bar: nowhere at all — and it is deliberately
  // absent on Today, where the day's own stat strip already carries it with the
  // billable split, the target and the week beside it. app.js decides that with
  // `showTotal`; see the ownership note at the end of runbar.css.
  const total = showTotal && dayTotal != null ? html`
    <span class="runbar-total" title="Filed today (all entries)">
      <strong class="mono">${fmtHours(dayTotal)}h</strong>
      <span class="runbar-total-cap muted small">filed</span>
    </span>` : null;

  // The day's one commit, in the one place it exists now. It was a footer
  // button on the desktop and a seventh bottom-bar slot on the phone; it is a
  // trailing action here, on Today only, so it and `c` mean the same thing on
  // the same screen. The label collapses to its icon while a timer is running
  // on a phone — that is the one state where this bar has a name, a clock and
  // a Stop to fit in 390px as well.
  const close = showClose && onCloseDay ? html`
    <button type="button" class="btn btn-sm runbar-close" onClick=${onCloseDay}
      aria-label="Close the day"
      title="Review, finalize and export today (c)">
      <${Icon} name="lock" size=${14} />
      <span class="runbar-close-label">Close the day</span>
      <kbd class="btn-kbd">c</kbd>
    </button>` : null;

  if (!live) {
    return html`
      <div class=${'runbar resting' + (close ? ' has-action' : '')}
        role="region" aria-label="Today">
        ${total}
        <span class="runbar-gap"></span>
        ${close}
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
      ${close}
      <button type="button" class="btn runbar-stop" disabled=${busy} onClick=${stopAll}>
        <${Icon} name="stop" size=${14} /> Stop
      </button>
    </div>`;
}
