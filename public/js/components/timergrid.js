import { api } from '/js/api.js';
import {
  html, useState, useEffect, useRef, useCallback,
  fmtClock, fmtTenths, fmtHours, emitToast, Modal, Confirm, ContextMenu, Field, Icon, clientLabel,
} from '/js/ui.js';
import { CmPicker } from '/js/components/cmpicker.js';
import { TimerImport } from '/js/components/timerimport.js';
import { StopChips } from '/js/components/stopchips.js';
import { longRunNotifications } from '/js/lib/notify.js';
import { startAlignedTick } from '/js/lib/tick.js';
import { activityWindows, lastActivityMs, inWindow } from '/js/lib/activity.js';

// Round-2 timer dashboard: collapsible groups, dense cards, right-click menu,
// drag-and-drop, day-accumulator clocks that are directly editable.

export function TimerGrid({ settings, onEntryChanged, openEditor }) {
  const [timers, setTimers] = useState(null);
  const [groups, setGroups] = useState([]);
  const [fetchedAt, setFetchedAt] = useState(Date.now());
  const [, forceTick] = useState(0);
  const [editing, setEditing] = useState(null);       // timer | 'new'
  const [groupModal, setGroupModal] = useState(null); // 'new' | group
  const [menu, setMenu] = useState(null);             // {x, y, timer}
  const [tabMenu, setTabMenu] = useState(null);       // {x, y, group} — active tab's kebab
  const [stopPopup, setStopPopup] = useState(null);   // {timer, result}
  const [deleting, setDeleting] = useState(null);
  const [importing, setImporting] = useState(false);
  const [taskCodes, setTaskCodes] = useState([]);
  const dragId = useRef(null);

  // Grouping view (spec §3.4/§4): 'group' = user-defined timer_groups,
  // 'client' = the matter's client, 'flat' = one list. Persisted per-browser.
  const [grouping, setGroupingState] = useState(() => {
    const v = localStorage.getItem('tk:timerGrouping');
    return ['group', 'client', 'flat'].includes(v) ? v : 'group';
  });
  const setGrouping = (v) => { localStorage.setItem('tk:timerGrouping', v); setGroupingState(v); };

  // Active timer tab within by-group/by-client modes (Intapp-style client
  // tabs, replacing the old stacked collapsible sections). Persisted per
  // grouping mode; re-read from localStorage whenever the mode changes.
  // Render-time validation against the current tab list (see `effectiveTab`
  // below) is what actually implements the "fall back to All" rule — this
  // effect just keeps `activeTab` itself in sync with the right mode's key.
  const [activeTab, setActiveTabState] = useState(() => localStorage.getItem('tk:timerTab:group') || 'all');
  useEffect(() => {
    setActiveTabState(localStorage.getItem(`tk:timerTab:${grouping}`) || 'all');
  }, [grouping]);
  const setActiveTab = (key) => {
    localStorage.setItem(`tk:timerTab:${grouping}`, key);
    setActiveTabState(key);
  };

  // Keyboard focus model (spec §4): ONE focused timer via roving tabindex.
  const [focusId, setFocusId] = useState(null);

  // A just-created timer jumps into view (2026-07-13 feedback): switch to
  // the All tab, clear any filter, then — once the render that includes the
  // new card commits — scroll to it and hand it the keyboard focus. An
  // effect (not a bare rAF at creation time) because the card may not be in
  // the DOM until the post-reload render.
  const [revealId, setRevealId] = useState(null);
  const reveal = (id) => {
    setGridFilter('');
    setActiveTab('all');
    setRevealId(id);
  };
  useEffect(() => {
    if (revealId == null) return;
    const el = document.querySelector(`.timer-board .timer-card[data-timer-id="${revealId}"]`);
    if (!el) return; // not rendered yet — retry on the next timers/tab render
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setFocusId(revealId);
    el.focus({ preventScroll: true });
    setRevealId(null);
  });

  // Grid search bar: `/` on the dashboard (or the toolbar button) opens an
  // explicit search input; typing narrows the grid in place (still just a
  // plain string — `gridFilter` — shared with the filtering internals).
  const [gridFilter, setGridFilter] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const searchInputRef = useRef(null);

  const reload = useCallback(async () => {
    const [t, g] = await Promise.all([api.get('/api/timers'), api.get('/api/timer-groups')]);
    setTimers(t);
    setGroups(g);
    setFetchedAt(Date.now());
  }, []);

  useEffect(() => { reload().catch(() => {}); }, [reload]);
  useEffect(() => { api.get('/api/task-codes').then(setTaskCodes).catch(() => {}); }, []);
  useEffect(() => {
    const poll = setInterval(() => reload().catch(() => {}), 5000);
    return () => clearInterval(poll);
  }, [reload]);
  // Refresh the moment the tab/PWA returns to the foreground. Backgrounding on
  // mobile pauses both the poll and the display tick, so without this the
  // running clock shows a stale value for up to 5s on resume — which reads as
  // "time isn't being recorded". The recorded time is server-authoritative
  // (computed from last_started_at); this just re-syncs the display promptly.
  useEffect(() => {
    const onWake = () => { if (document.visibilityState === 'visible') reload().catch(() => {}); };
    document.addEventListener('visibilitychange', onWake);
    window.addEventListener('focus', onWake);
    return () => {
      document.removeEventListener('visibilitychange', onWake);
      window.removeEventListener('focus', onWake);
    };
  }, [reload]);
  // The rendered second flips when (now - fetchedAt) crosses a whole second —
  // tick aligned to that boundary, not a drifting 1s interval (which made the
  // clock hang and then jump two counts at once).
  useEffect(() => startAlignedTick(fetchedAt, () => forceTick((x) => x + 1)), [fetchedAt]);

  const liveElapsed = useCallback((t) => {
    let s = t.elapsed_seconds;
    if (t.running) s += (Date.now() - fetchedAt) / 1000;
    return Math.floor(s);
  }, [fetchedAt]);

  // OS/browser notification when a timer's CURRENT running stretch passes 2h,
  // then hourly (TODO #3) — keyed off last_started_at, not the day
  // accumulator, so a timer restarted after filing doesn't instantly
  // re-alert. Runs after every render (the 1s forceTick keeps those coming);
  // the marks ref is what makes each hour fire exactly once. Only fires
  // while a tab is open — no service-worker push, by design.
  const longRunMarks = useRef({});
  useEffect(() => {
    if (!timers || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    const { due, marks } = longRunNotifications(
      timers.map((t) => ({
        id: t.id, name: t.name, running: !!t.running,
        seconds: t.running && t.last_started_at
          ? Math.max(0, (Date.now() - Date.parse(t.last_started_at)) / 1000) : 0,
      })),
      longRunMarks.current);
    longRunMarks.current = marks;
    for (const d of due) {
      try {
        new Notification('Timer still running', {
          body: `"${d.name}" has been running ${d.mark} hours — stop & file, or keep going.`,
          tag: `tk-longrun-${d.id}`, // replaces the previous hour's, never stacks
        });
      } catch { /* constructor unsupported (e.g. mobile) — visual idle-nudge still covers it */ }
    }
  });

  // "Assign matter" on the dashboard's ghost row opens this grid's edit modal.
  useEffect(() => {
    const onEditTimer = (e) => {
      const t = (timers || []).find((x) => x.id === e.detail.id);
      if (t) setEditing(t);
    };
    window.addEventListener('tk:edit-timer', onEditTimer);
    return () => window.removeEventListener('tk:edit-timer', onEditTimer);
  }, [timers]);

  // Someone outside the grid changed a timer (e.g. an entry card's
  // start/stop button) — refresh now instead of waiting for the 5s poll.
  useEffect(() => {
    const onChanged = () => reload().catch(() => {});
    window.addEventListener('tk:timers-changed', onChanged);
    return () => window.removeEventListener('tk:timers-changed', onChanged);
  }, [reload]);

  // ---------- actions ----------

  const guard = (p) => p.catch((e) => emitToast(e.message, { error: true }));

  const start = useCallback(async (timer, opts = {}) => {
    // First-ever start is the natural user gesture to ask for notification
    // permission (for the 2h+ long-running alerts). Fire-and-forget — the
    // prompt must never delay the timer actually starting.
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      Notification.requestPermission().catch(() => {});
    }
    const r = await api.post(`/api/timers/${timer.id}/start`, opts);
    localStorage.setItem('tk:lastTimer', String(timer.id));
    // Exclusive timers: the server stop-and-filed whatever was running. Filed
    // an entry → offer the narrative chips for it (same affordance as a
    // manual stop, non-blocking — the new timer is already running). A sub-2s
    // misclick stretch discards silently; an under-increment stop just pauses.
    for (const s of r.stopped || []) {
      if (s.entry) {
        setStopPopup({ timer: s.timer, result: s });
        onEntryChanged();
      } else if (!s.discarded) {
        emitToast(`⏸ ${s.timer.name} paused — nothing to file yet (${fmtClock(s.seconds)}).`);
      }
    }
    // start creates the entry now — refresh Today's entries right away
    if (r.entry) onEntryChanged();
    // the old linked entry was finalized/deleted meanwhile; the new entry
    // carries the whole day clock — offer the double-count deduction here
    if (r.relinked) {
      emitToast('Previous entry is locked — started a new one carrying the full day clock.',
        r.previousTotal ? {
          actionLabel: `Deduct ${fmtHours(r.previousTotal)}h`,
          action: () => guard(api.put(`/api/timers/${timer.id}/clock`, { deltaHours: -r.previousTotal })
            .then(() => { onEntryChanged(); return reload(); })),
        } : undefined);
    }
    await reload();
    // Deliberately imperative one-shot DOM class, not React state: a single
    // confirmation pulse on the card that just started, self-removing after
    // one animation cycle (spec §7 motion — fires once, never persists).
    const el = document.querySelector(`.timer-card[data-timer-id="${timer.id}"]`);
    if (el) {
      el.classList.add('just-started');
      setTimeout(() => el.classList.remove('just-started'), 350);
    }
  }, [reload, onEntryChanged]);

  const stop = useCallback(async (timer) => {
    localStorage.setItem('tk:lastTimer', String(timer.id));
    const result = await api.post(`/api/timers/${timer.id}/stop`);
    await reload();
    if (result.entry) {
      // matterless timers file a real (unassociated) entry too now — the
      // stop popup, entry list, and alerts carry the assign-a-matter nudge
      setStopPopup({ timer, result });
      onEntryChanged();
    } else if (result.discarded) {
      emitToast('Misclick (under 2s) — nothing recorded.');
    } else {
      emitToast(`Nothing to file yet — clock keeps counting (${fmtClock(result.seconds)}).`);
    }
  }, [reload, onEntryChanged]);

  const clockDelta = useCallback(async (timer, deltaHours) => {
    const r = await api.put(`/api/timers/${timer.id}/clock`, { deltaHours });
    if (r.entry) onEntryChanged();
    await reload();
  }, [reload, onEntryChanged]);

  const clockSet = useCallback(async (timer, hours) => {
    const r = await api.put(`/api/timers/${timer.id}/clock`, { hours });
    if (r.entry) onEntryChanged();
    await reload();
  }, [reload, onEntryChanged]);

  const fresh = useCallback(async (timer) => {
    await api.post(`/api/timers/${timer.id}/fresh`);
    emitToast('Clock zeroed — next stop files a new entry. Today’s entry kept.');
    await reload();
  }, [reload]);

  // not memoized: reveal() closes over the current grouping mode
  const duplicate = async (timer) => {
    const copy = await api.post(`/api/timers/${timer.id}/duplicate`);
    await reload();
    if (copy && copy.id) reveal(copy.id);
  };

  // 't' shortcut: toggle last-used timer
  useEffect(() => {
    const onToggle = () => {
      if (!timers || timers.length === 0) return;
      const lastId = Number(localStorage.getItem('tk:lastTimer'));
      const timer = timers.find((t) => t.id === lastId) || timers[0];
      guard(timer.running ? stop(timer) : start(timer));
    };
    window.addEventListener('tk:toggle-last-timer', onToggle);
    return () => window.removeEventListener('tk:toggle-last-timer', onToggle);
  }, [timers, start, stop]);

  // `/` (dashboard route) opens the search bar — or, when it's already open
  // and focus has wandered off (e.g. the user clicked a card without pressing
  // Escape), refocuses the input directly. The direct focus matters:
  // setSearchOpen(true) on an already-open bar is a state-unchanged no-op —
  // no re-render, so the focus effect below never reruns.
  useEffect(() => {
    const onSearch = () => {
      const el = searchInputRef.current;
      // Select any existing text so the next keystroke replaces it
      // (2026-07-17 feedback: re-pressing `/` should start a fresh filter).
      if (el) { el.focus(); el.select(); }
      else setSearchOpen(true);
    };
    window.addEventListener('tk:timer-search', onSearch);
    return () => window.removeEventListener('tk:timer-search', onSearch);
  }, []);

  // Focus the search input whenever it opens. This has to be an effect keyed
  // on `searchOpen` rather than a same-tick requestAnimationFrame after
  // setSearchOpen(true): a bare rAF scheduled inside the event handler can
  // fire one frame *before* React commits the re-render (confirmed —
  // searchInputRef.current is still null on that first frame), so focus
  // silently no-ops. An effect is guaranteed to run only after the DOM for
  // its triggering render has committed, so the ref is always live here.
  useEffect(() => {
    if (searchOpen) { searchInputRef.current?.focus(); searchInputRef.current?.select(); }
  }, [searchOpen]);

  // ---------- ordering ----------

  function visualOrder(list, groupsList) {
    const sections = [...groupsList.map((g) => g.id), null];
    return sections.flatMap((gid) => list.filter((t) => (t.group_id ?? null) === gid));
  }

  async function persistOrder(list) {
    await api.put('/api/timers/order', { ids: visualOrder(list, groups).map((t) => t.id) });
    await reload();
  }

  async function sortAZ() {
    const sorted = [...timers].sort((a, b) =>
      (a.cm_short_name || '').localeCompare(b.cm_short_name || '') || a.name.localeCompare(b.name));
    await persistOrder(sorted);
    emitToast('Sorted A–Z within groups');
  }

  async function dropOn(target) {
    const id = dragId.current;
    dragId.current = null;
    if (!id) return;
    const dragged = timers.find((t) => t.id === id);
    if (!dragged) return;
    const targetGroup = target.kind === 'group' ? target.groupId : (target.timer.group_id ?? null);
    if ((dragged.group_id ?? null) !== targetGroup) {
      await api.patch(`/api/timers/${id}`, { group_id: targetGroup });
      dragged.group_id = targetGroup;
    }
    let list = timers.filter((t) => t.id !== id);
    if (target.kind === 'group') {
      list.push(dragged); // visualOrder puts it at its group's end
    } else {
      const idx = list.findIndex((t) => t.id === target.timer.id);
      list.splice(idx, 0, dragged);
    }
    await persistOrder(list);
  }

  // ---------- context menu ----------

  function menuItems(timer) {
    const running = !!timer.running;
    return [
      running
        ? { label: 'Stop & file time', icon: 'stop', onClick: () => guard(stop(timer)) }
        : { label: 'Start', icon: 'play', onClick: () => guard(start(timer)) },
      {
        custom: () => html`
          <div class="ctx-inline">
            <span class="muted small">Start</span>
            ${[1, 5, 10, 30, 60].map((m) => html`
              <button key=${m} class="btn btn-sm" disabled=${running}
                onClick=${() => { setMenu(null); guard(start(timer, { minutesAgo: m })); }}>${m}m</button>`)}
            <span class="muted small">ago</span>
          </div>`,
      },
      {
        label: 'Start at last stop',
        icon: 'history',
        disabled: running || !timer.last_stopped_at,
        onClick: () => guard(start(timer, { atLastStop: true })),
      },
      { hr: true },
      { label: '+0.1 h (6 min)', icon: 'plus', onClick: () => guard(clockDelta(timer, 0.1)) },
      { label: '−0.1 h (6 min)', icon: 'minus', onClick: () => guard(clockDelta(timer, -0.1)) },
      { label: '+0.2 h (12 min)', icon: 'plus', onClick: () => guard(clockDelta(timer, 0.2)) },
      { label: '−0.2 h (12 min)', icon: 'minus', onClick: () => guard(clockDelta(timer, -0.2)) },
      { hr: true },
      { label: 'New entry (zero clock)', icon: 'refresh', onClick: () => guard(fresh(timer)) },
      {
        label: 'Open today’s entry',
        icon: 'eye',
        disabled: !timer.linked_entry_id,
        onClick: () => openEditor({ id: timer.linked_entry_id }),
      },
      { label: 'Duplicate timer', icon: 'copy', onClick: () => guard(duplicate(timer)) },
      {
        label: timer.pinned ? 'Unpin from float window' : 'Pin to float window',
        icon: 'pin',
        onClick: () => guard(api.patch(`/api/timers/${timer.id}`, {
          pinned: timer.pinned ? 0 : 1,
        }).then(reload)),
      },
      {
        custom: () => html`
          <div class="ctx-inline">
            <span class="muted small">Group</span>
            <select value=${timer.group_id ?? ''} onChange=${async (e) => {
              setMenu(null);
              await guard(api.patch(`/api/timers/${timer.id}`, {
                group_id: e.target.value ? Number(e.target.value) : null,
              }).then(reload));
            }}>
              <option value="">Ungrouped</option>
              ${groups.map((g) => html`<option key=${g.id} value=${g.id}>${g.name}</option>`)}
            </select>
          </div>`,
      },
      { hr: true },
      { label: 'Edit timer…', icon: 'edit', onClick: () => setEditing(timer) },
      { label: 'Delete timer', icon: 'trash', danger: true, onClick: () => setDeleting(timer) },
    ];
  }

  // ---------- render ----------

  // hook-safe: runs before the early return, touches only the DOM
  useEffect(() => {
    if (!gridFilter) return;
    const active = document.activeElement;
    // the search input owns focus while the user is typing into it — don't
    // yank focus away from it on every keystroke.
    if (active && active.classList && active.classList.contains('timer-search')) return;
    const cards = [...document.querySelectorAll('.timer-card')];
    if (active && cards.includes(active)) return;
    if (cards[0]) { setFocusId(Number(cards[0].dataset.timerId)); cards[0].focus(); }
    else document.querySelector('.timer-board')?.focus();
  }, [gridFilter]);

  // hook-safe (see above): if the focused card vanishes from the board —
  // filtered out, its group collapsed, or deleted — and focus dropped along
  // with it (fell to <body>, or a now-gone timer card), reclaim it onto
  // whatever card is now tabbable. DOM-driven (not the `visible` list, which
  // isn't computed yet at this point in the render) so it stays safe to
  // declare above the early `if (!timers) return null;`.
  useEffect(() => {
    if (focusId == null) return;
    const stillThere = document.querySelector(`.timer-board .timer-card[data-timer-id="${focusId}"]`);
    if (stillThere) return;
    const active = document.activeElement;
    const wasCard = !!(active && active.classList && active.classList.contains('timer-card'));
    const fellToBody = !active || active === document.body;
    if (!wasCard && !fellToBody) return;
    const cards = [...document.querySelectorAll('.timer-board .timer-card')];
    const next = cards.find((c) => c.tabIndex === 0) || cards[0];
    if (next) { setFocusId(Number(next.dataset.timerId)); next.focus(); }
  });

  if (!timers) return null;
  const idleAfter = (settings.idleNudgeHours ?? 3) * 3600;
  const hasGroups = groups.length > 0;
  const byGroupMode = grouping === 'group';

  const norm = gridFilter.trim().toLowerCase();
  const matchesFilter = (t) => !norm
    || [t.name, t.cm_short_name, t.client_name, t.client_number, t.cm_number]
      .some((v) => String(v || '').toLowerCase().includes(norm));
  const shown = norm ? timers.filter(matchesFilter) : timers;

  let sections; // [{ key, group, label, list }] — group is non-null only in by-group mode
  if (grouping === 'client') {
    const byClient = new Map();
    for (const t of shown) {
      const key = t.client_id ?? 'none';
      if (!byClient.has(key)) {
        // A section labeled by the bare number (client_name blank, but a
        // number exists) means nobody has named this client yet.
        byClient.set(key, {
          key: `client-${key}`, group: null, label: clientLabel(t) || 'No client',
          unnamedClient: !t.client_name && !!t.client_number, list: [],
        });
      }
      byClient.get(key).list.push(t);
    }
    sections = [...byClient.values()].sort((a, b) =>
      a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }));
  } else if (grouping === 'flat') {
    sections = [{ key: 'flat', group: null, label: null, list: shown }];
  } else {
    sections = [
      ...groups.map((g) => ({ key: `group-${g.id}`, group: g, label: g.name, list: shown.filter((t) => t.group_id === g.id) })),
      { key: 'ungrouped', group: null, label: null, list: shown.filter((t) => t.group_id == null) },
    ];
  }

  // ---------- activity tabs (2026-07-10 feedback; +Yesterday 2026-07-15) ----------
  // "Today" / "Yesterday" / "Week" show timers that actually RAN in the
  // period; "Recent" is the rolling two-week working set. Window math lives
  // in lib/activity.js (pure, unit-tested); views sort alphabetically
  // (2026-07-11 feedback — most-recent-first made cards shuffle while
  // timers ran).
  const nowMs = Date.now();
  const ACTIVITY = activityWindows(nowMs);
  const activityList = (key) => shown
    .filter((t) => inWindow(lastActivityMs(t, nowMs), ACTIVITY[key]))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

  // ---------- tabs (by-group / by-client modes only; flat keeps one grid) ----------
  // Note: timer_groups.collapsed (still returned by /api/timer-groups, still
  // patchable) is deliberately NOT consulted anywhere below — the old
  // collapse-to-hide sections UI is gone, replaced by tabs. Left alone in the
  // API/schema in case anything else still relies on it.
  const tabsEnabled = byGroupMode || grouping === 'client';
  const tabList = !tabsEnabled ? [] : [
    { key: 'all', label: 'All', count: shown.length, group: null },
    ...Object.entries(ACTIVITY).map(([key, a]) => ({
      key, label: a.label, count: activityList(key).length, group: null, activity: true,
    })),
    ...sections
      .filter((sec) => !(norm && sec.list.length === 0)) // filtering hides empty tabs, same as the old empty-section hiding
      .filter((sec) => !(byGroupMode && !sec.group && sec.list.length === 0 && hasGroups)) // hide empty "Ungrouped" tab
      .map((sec) => ({
        key: sec.key, group: sec.group, count: sec.list.length,
        label: sec.label ?? 'Ungrouped', unnamedClient: sec.unnamedClient,
      })),
  ];
  // Falls back to "All" whenever the persisted/stale tab key isn't in the
  // current tab list — covers a deleted group, a client filtered to zero
  // matches, or simply never having a stored tab for this mode.
  let effectiveTab = tabList.some((t) => t.key === activeTab) ? activeTab : 'all';
  // A live filter that empties the current tab (an activity tab keeps its slot
  // even at count 0) but still matches timers elsewhere jumps to "All" so the
  // hits are visible; when nothing matches anywhere it stays put (2026-07-17
  // feedback). Transient — clearing the filter restores the persisted tab.
  if (norm && effectiveTab !== 'all' && shown.length > 0) {
    const curList = ACTIVITY[effectiveTab]
      ? activityList(effectiveTab)
      : (sections.find((sec) => sec.key === effectiveTab)?.list ?? []);
    if (curList.length === 0) effectiveTab = 'all';
  }
  const activeSection = tabsEnabled && effectiveTab !== 'all'
    ? sections.find((sec) => sec.key === effectiveTab) : null;
  const renderedSections = ACTIVITY[effectiveTab] && tabsEnabled
    ? [{ key: effectiveTab, group: null, label: null, list: activityList(effectiveTab) }]
    : activeSection ? [activeSection] : sections;

  // ordered list of cards actually on screen: the active tab's cards only,
  // or every section's cards under "All" (or in flat mode, which has no
  // tabs). The roving tabindex + arrow keys walk this list.
  const visible = renderedSections.flatMap((sec) => sec.list);
  const tabbableId = visible.some((t) => t.id === focusId) ? focusId : (visible[0] && visible[0].id);

  const focusCard = (id) => {
    setFocusId(id);
    requestAnimationFrame(() => {
      document.querySelector(`.timer-card[data-timer-id="${id}"]`)?.focus();
    });
  };

  function onSearchKeyDown(e) {
    e.stopPropagation(); // keep app-level shortcuts / StopChips out of the search box
    if (e.key === 'Escape') {
      e.preventDefault();
      setGridFilter('');
      setSearchOpen(false);
      if (tabbableId != null) focusCard(tabbableId);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (tabbableId != null) focusCard(tabbableId);
    } else if (e.key === 'Tab' && !e.shiftKey && norm && visible.length > 0) {
      // 2026-07-10 feedback: Tab out of the filter box lands on the FIRST
      // matching card (Enter keeps the last-focused card; Tab is "take me to
      // the results").
      e.preventDefault();
      focusCard(visible[0].id);
    }
  }

  // Keys for the focused card. Every command is a NON-PRINTABLE chord —
  // filtering now lives in the explicit `/` search bar, not the grid itself.
  // stopPropagation keeps these away from the app-level shortcuts (n/t/g/…).
  function onBoardKey(e) {
    const tag = (e.target.tagName || '').toLowerCase();
    // in-card clock editing etc. always bail out; a <button> only bails for
    // its own native Enter/Space activation — arrows and Alt-nudge must
    // still drive the grid even when DOM focus sits on an inner button (e.g.
    // after a mouse click), otherwise the keyboard goes dead until Tab.
    if (['input', 'textarea', 'select'].includes(tag)) return;
    if (tag === 'button' && (e.key === 'Enter' || e.key === ' ')) return;
    const done = () => { e.preventDefault(); e.stopPropagation(); };

    const list = visible;
    if (list.length === 0) return;
    const idx = Math.max(0, list.findIndex((t) => t.id === focusId));
    const cur = list[idx];

    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      const step = (e.shiftKey ? 0.2 : 0.1) * (e.key === 'ArrowUp' ? 1 : -1);
      guard(clockDelta(cur, step));
      return done();
    }

    if (['ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
      // Column-major multicol layout: DOM order runs DOWN a column, so
      // Up/Down walk DOM order (can't desync from what's on screen);
      // Left/Right need geometry — the column break isn't in the DOM.
      const cards = [...document.querySelectorAll('.timer-board .timer-card')];
      const curEl = document.querySelector(`.timer-board .timer-card[data-timer-id="${cur.id}"]`);
      if (cards.length === 0 || !curEl) return done();
      const curIdx = cards.indexOf(curEl);

      if (e.key === 'ArrowDown') { focusCard(Number(cards[Math.min(curIdx + 1, cards.length - 1)].dataset.timerId)); return done(); }
      if (e.key === 'ArrowUp') { focusCard(Number(cards[Math.max(curIdx - 1, 0)].dataset.timerId)); return done(); }

      const rect = curEl.getBoundingClientRect();
      const cy = rect.top + rect.height / 2;
      const candidates = cards
        .filter((el) => el !== curEl)
        .map((el) => ({ el, r: el.getBoundingClientRect() }))
        .filter(({ r }) => (e.key === 'ArrowRight' ? r.left > rect.left + 4 : r.left < rect.left - 4));
      if (candidates.length === 0) return done(); // no column in that direction — keep focus
      candidates.sort((a, b) => {
        const colDeltaDiff = Math.abs(a.r.left - rect.left) - Math.abs(b.r.left - rect.left);
        if (colDeltaDiff !== 0) return colDeltaDiff;
        const dyA = Math.abs((a.r.top + a.r.height / 2) - cy);
        const dyB = Math.abs((b.r.top + b.r.height / 2) - cy);
        return dyA - dyB;
      });
      focusCard(Number(candidates[0].el.dataset.timerId));
      return done();
    }

    if (e.key === 'Tab' && norm) {
      // While the filter is active, Tab walks the matching cards in reading
      // order (down each column, then the next = DOM order); Shift+Tab walks back.
      // Past either end, fall through to the browser so focus leaves the
      // grid naturally. Unfiltered Tab keeps its default behavior.
      const cards = [...document.querySelectorAll('.timer-board .timer-card')];
      const curEl = document.querySelector(`.timer-board .timer-card[data-timer-id="${cur.id}"]`);
      const curIdx = cards.indexOf(curEl);
      const next = curIdx + (e.shiftKey ? -1 : 1);
      if (curIdx >= 0 && next >= 0 && next < cards.length) {
        focusCard(Number(cards[next].dataset.timerId));
        return done();
      }
      return undefined;
    }

    if (e.key === 'Enter' && e.shiftKey) { setEditing(cur); return done(); }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      // quick-note: today's entry if linked, else a fresh entry on this matter
      if (cur.linked_entry_id) openEditor({ id: cur.linked_entry_id });
      else openEditor({ template: { cm: { id: cur.cm_id, cm_number: cur.cm_number, short_name: cur.cm_short_name, billable: cur.cm_billable ?? 1 } } });
      return done();
    }
    if (e.key === 'Enter' || e.key === ' ') {
      guard(cur.running ? stop(cur) : start(cur));
      return done();
    }
  }

  return html`
    <div class="section-title">
      <h2>Timers</h2>
      <div class="seg" role="group" aria-label="Timer grouping">
        ${[['group', 'By group'], ['client', 'By client'], ['flat', 'Flat']].map(([v, label]) => html`
          <button key=${v} class=${grouping === v ? 'on' : ''} title=${`Show timers: ${label.toLowerCase()}`}
            onClick=${() => setGrouping(v)}>${label}</button>`)}
      </div>
      <div class="spacer" style=${{ flex: 1 }}></div>
      <button class="btn btn-sm" title="Search timers ( / )"
        onClick=${() => setSearchOpen((v) => !v)}>
        <${Icon} name="search" size=${16} />
      </button>
      ${(searchOpen || gridFilter) ? html`
        <span class="timer-search-wrap">
          <input ref=${searchInputRef} type="search" class="timer-search" placeholder="Filter timers…"
            value=${gridFilter}
            onInput=${(e) => setGridFilter(e.target.value)}
            onKeyDown=${onSearchKeyDown} />
          ${gridFilter ? html`<span class="muted small">${shown.length}/${timers.length}</span>` : null}
        </span>` : null}
      <button class="btn btn-sm" title="Sort by CM name within groups" onClick=${() => guard(sortAZ())}>
        <${Icon} name="sortAZ" size=${16} /> A–Z
      </button>
      <button class="btn btn-sm" onClick=${() => setGroupModal('new')}>
        <${Icon} name="folder" size=${16} /> New group
      </button>
      <button class="btn btn-sm" title="Batch-create timers from a CSV" onClick=${() => setImporting(true)}>
        <${Icon} name="download" size=${16} /> Import
      </button>
      <button class="btn btn-sm" title="Quick timer — starts now with no matter; assign one later"
        onClick=${() => guard((async () => {
          const t = await api.post('/api/timers', {});
          await start(t);
          reveal(t.id);
        })())}>
        <${Icon} name="timer" size=${16} /> Quick
      </button>
      <button class="btn btn-sm btn-primary" onClick=${() => setEditing('new')}>
        <${Icon} name="plus" size=${16} /> New timer
      </button>
    </div>
    ${tabsEnabled ? html`
      <div class="timer-tabs" role="tablist" aria-label=${byGroupMode ? 'Timer groups' : 'Clients'}>
        ${tabList.map((tab) => html`
          <span key=${tab.key} class=${'timer-tab-wrap' + (effectiveTab === tab.key ? ' on' : '') + (tab.key === 'act-today' ? ' activity-start' : '') + (tab.key === 'act-recent' ? ' activity-end' : '')}>
            <button class=${'timer-tab' + (effectiveTab === tab.key ? ' on' : '')}
              role="tab" aria-selected=${effectiveTab === tab.key}
              title=${tab.activity ? { 'act-today': 'Timers that ran today', 'act-yesterday': 'Timers last used yesterday (not yet today)', 'act-week': 'Timers that ran this week (Mon–)', 'act-recent': 'Timers used in the last two weeks' }[tab.key] : undefined}
              onClick=${() => setActiveTab(tab.key)}
              onDragOver=${byGroupMode && tab.key !== 'all' && !tab.activity ? (e) => e.preventDefault() : undefined}
              onDrop=${byGroupMode && tab.key !== 'all' && !tab.activity ? (e) => { e.preventDefault(); guard(dropOn({ kind: 'group', groupId: tab.group ? tab.group.id : null })); } : undefined}>
              <span class="timer-tab-label">${tab.label}</span>
              ${tab.unnamedClient ? html`<span class="muted small" title="Name this client in Clients & Matters (or the matter's edit dialog)">· unnamed</span>` : null}
              <span class="muted small timer-tab-count">${tab.count}</span>
            </button>
            ${byGroupMode && tab.group && effectiveTab === tab.key ? html`
              <span class="tab-tools">
                <button class="btn btn-ghost btn-sm" title="Group menu"
                  onClick=${(e) => {
                    const r = e.currentTarget.getBoundingClientRect();
                    setTabMenu({ x: r.left, y: r.bottom + 2, group: tab.group });
                  }}>
                  <${Icon} name="moreV" size=${14} /></button>
              </span>` : null}
          </span>`)}
      </div>` : null}
    <div class="timer-board" tabIndex=${-1} onKeyDown=${onBoardKey}
      onFocus=${(e) => { if (e.target === e.currentTarget && tabbableId != null) focusCard(tabbableId); }}>

    ${renderedSections.map((sec) => {
      const { group, list } = sec;
      if (norm && list.length === 0) return null; // filtering hides empty sections
      if (byGroupMode && !group && list.length === 0 && hasGroups) return null;
      // Only the "All" view shows a plain heading (name + count, no
      // rename/delete tools — those live on the active tab above, not per
      // section). A single active-tab section renders just its grid.
      const showHead = tabsEnabled ? effectiveTab === 'all' : grouping === 'client';
      return html`
        <div key=${sec.key} class="timer-section"
          onDragOver=${byGroupMode ? (e) => e.preventDefault() : undefined}
          onDrop=${byGroupMode ? (e) => { e.preventDefault(); guard(dropOn({ kind: 'group', groupId: group ? group.id : null })); } : undefined}>
          ${showHead ? html`
            <div class="group-head">
              ${group ? html`
                <span class="group-name">${group.name}</span>
                <span class="muted small">${list.length}</span>` : sec.label != null ? html`
                <span class="group-name">${sec.label}</span>
                ${sec.unnamedClient ? html`
                  <span class="muted small" title="Name this client in Clients & Matters (or the matter's edit dialog)">· unnamed</span>` : null}
                <span class="muted small">${list.length}</span>` : html`
                <span class="group-name muted">Ungrouped</span>
                <span class="muted small">${list.length}</span>`}
            </div>` : null}
          <div class="timer-grid">
            ${list.map((t) => html`
              <${TimerCard} key=${t.id} timer=${t} secs=${liveElapsed(t)} idleAfter=${idleAfter}
                canDrag=${byGroupMode}
                tabbable=${tabbableId === t.id} onFocusCard=${() => setFocusId(t.id)}
                roundMode=${settings.rounding?.enabled === false ? 'nearest' : (settings.rounding?.mode || 'up')}
                onStart=${() => guard(start(t))} onStop=${() => guard(stop(t))}
                onDelta=${(d) => guard(clockDelta(t, d))} onSet=${(h) => guard(clockSet(t, h))}
                onRename=${(name) => guard(api.patch(`/api/timers/${t.id}`, { name }).then(reload))}
                onMenu=${(x, y) => setMenu({ x, y, timer: t })}
                onDragStart=${() => { dragId.current = t.id; }}
                onDropOn=${() => guard(dropOn({ kind: 'timer', timer: t }))} />`)}
            ${byGroupMode && list.length === 0 ? html`<div class="muted small" style=${{ padding: '8px' }}>Drop timers here</div>` : null}
          </div>
        </div>`;
    })}
    ${timers.length === 0 ? html`
      <button class="timer-new" onClick=${() => setEditing('new')}>
        <${Icon} name="plus" /> Create your first timer
      </button>` : null}
    </div>

    ${menu ? html`
      <${ContextMenu} x=${menu.x} y=${menu.y} items=${menuItems(menu.timer)} onClose=${() => setMenu(null)} />` : null}

    ${tabMenu ? html`
      <${ContextMenu} x=${tabMenu.x} y=${tabMenu.y} onClose=${() => setTabMenu(null)}
        items=${[
          { label: 'Rename group…', icon: 'edit', onClick: () => setGroupModal(tabMenu.group) },
          {
            label: 'Delete group (timers kept)', icon: 'trash', danger: true,
            onClick: () => guard(api.del(`/api/timer-groups/${tabMenu.group.id}`).then(reload)),
          },
        ]} />` : null}

    ${editing ? html`
      <${TimerModal} timer=${editing === 'new' ? null : editing} taskCodes=${taskCodes} groups=${groups}
        onDone=${async (saved) => {
          const wasNew = editing === 'new';
          setEditing(null);
          await reload();
          if (wasNew && saved && saved.id) reveal(saved.id);
          if (saved && saved.entry) {
            onEntryChanged();
            // paused assign associated/settled its entry — flow straight into
            // the narrative editor; a RUNNING assign just linked the entry
            // (total settles at stop), so let it ride
            if (!saved.running) openEditor({ id: saved.entry.id });
          }
        }}
        onClose=${() => setEditing(null)} />` : null}

    ${groupModal ? html`
      <${GroupModal} group=${groupModal === 'new' ? null : groupModal}
        onDone=${async () => { setGroupModal(null); await reload(); }}
        onClose=${() => setGroupModal(null)} />` : null}

    ${importing ? html`
      <${TimerImport}
        onDone=${async () => { setImporting(false); await reload(); }}
        onClose=${() => setImporting(false)} />` : null}

    ${deleting ? html`
      <${Confirm} title="Delete timer" danger confirmLabel="Delete"
        message=${`Delete the "${deleting.name}" button? Entries it already created are kept.`}
        onConfirm=${async () => { await api.del(`/api/timers/${deleting.id}`); await reload(); }}
        onClose=${() => setDeleting(null)} />` : null}

    ${stopPopup ? html`
      <${StopChips} popup=${stopPopup} openEditor=${openEditor}
        onClockDeduct=${(h) => guard(clockDelta(stopPopup.timer, -h))}
        onFiled=${() => { setStopPopup(null); onEntryChanged(); reload(); }}
        onClose=${(changed) => { setStopPopup(null); if (changed) onEntryChanged(); reload(); }} />` : null}
  `;
}

// ---------- compact card ----------

function TimerCard({ timer, secs, idleAfter, roundMode, canDrag = true, tabbable = false, onFocusCard, onStart, onStop, onDelta, onSet, onRename, onMenu, onDragStart, onDropOn }) {
  const [editingClock, setEditingClock] = useState(false);
  const [clockText, setClockText] = useState('');
  const [editingName, setEditingName] = useState(false);
  const [nameText, setNameText] = useState('');
  const idle = timer.running && secs > idleAfter;

  // Worked-today highlight (spec §4): accumulated time today (elapsed > 0 or
  // a linked entry) vs. still-at-zero — independent of .running / .idle-nudge.
  const worked = !!timer.linked_entry_id || secs > 0;

  function commitClock() {
    setEditingClock(false);
    const h = Number(clockText);
    if (Number.isFinite(h) && h >= 0) onSet(Math.round(h * 10) / 10);
  }

  function commitName() {
    setEditingName(false);
    const v = nameText.trim();
    if (v && v !== timer.name) onRename(v);
  }

  // 2026-07-10 10:18 feedback: the card shows only the caption — the matter
  // (and task code) live in the tooltip; unassigned = hatched, not labeled
  const cardTitle = timer.cm_id
    ? `${timer.name} — ${timer.cm_short_name} · ${timer.cm_number}${timer.task_code ? ` · ${timer.task_code}` : ''} — ${fmtClock(secs)} elapsed`
    : `${timer.name} — no matter yet (time files to an unassociated entry; Edit timer to assign one) — ${fmtClock(secs)} elapsed`;

  return html`
    <div class=${'timer-card' + (timer.running ? ' running' : '') + (worked ? ' worked' : '') + (timer.cm_id ? '' : ' unassigned')}
      tabIndex=${tabbable ? 0 : -1}
      data-timer-id=${timer.id}
      onFocus=${() => onFocusCard && onFocusCard()}
      draggable=${canDrag ? 'true' : 'false'}
      title=${cardTitle}
      onDragStart=${(e) => { if (!canDrag) { e.preventDefault(); return; } e.dataTransfer.effectAllowed = 'move'; onDragStart(); }}
      onDragOver=${(e) => { if (!canDrag) return; e.preventDefault(); e.stopPropagation(); }}
      onDrop=${(e) => { if (!canDrag) return; e.preventDefault(); e.stopPropagation(); onDropOn(); }}
      onContextMenu=${(e) => { e.preventDefault(); onMenu(e.clientX, e.clientY); }}>
      ${editingName ? html`
        <input class="name-input" autoFocus value=${nameText}
          onInput=${(e) => setNameText(e.target.value)}
          onBlur=${commitName}
          onKeyDown=${(e) => { e.stopPropagation(); if (e.key === 'Enter') commitName(); if (e.key === 'Escape') setEditingName(false); }} />` : html`
        <button class="timer-name" tabIndex=${-1} title=${`${timer.name} — click to rename`}
          onClick=${() => { setNameText(timer.name); setEditingName(true); }}>${timer.name}</button>`}
      ${idle ? html`<span class="timer-flag idle-nudge" title="Running a long time — still working?"><${Icon} name="alert" size=${12} /></span>` : null}
      ${timer.pinned ? html`
        <span class="timer-flag pinned"
          title="Pinned to the always-on-top float window — it stays there across days">
          <${Icon} name="pin" size=${12} /></span>` : null}
      ${editingClock ? html`
        <input class="clock-input mono" autoFocus value=${clockText} inputMode="decimal"
          onInput=${(e) => setClockText(e.target.value)}
          onBlur=${commitClock}
          onKeyDown=${(e) => { if (e.key === 'Enter') commitClock(); if (e.key === 'Escape') setEditingClock(false); }} />` : html`
        <span class="timer-clock-pair">
          <span class="timer-clock-raw mono">${fmtClock(secs)}</span>
          <button class="timer-clock mono" tabIndex=${-1} title=${`${fmtClock(secs)} elapsed — click to edit (decimal hours)`}
            onClick=${() => { setClockText(fmtTenths(secs, roundMode)); setEditingClock(true); }}>
            ${fmtTenths(secs, roundMode)}
          </button>
        </span>`}
      ${timer.running
        ? html`<button class="btn btn-sm timer-stop-btn" tabIndex=${-1} title="Stop & file time" onClick=${onStop}>
            <${Icon} name="stop" size=${15} /></button>`
        : html`<button class="btn btn-sm timer-start-btn" tabIndex=${-1} title="Start" onClick=${onStart}>
            <${Icon} name="play" size=${15} /></button>`}
      <button class="btn btn-ghost btn-sm timer-more" tabIndex=${-1} title="Timer menu"
        onClick=${(e) => { const r = e.currentTarget.getBoundingClientRect(); onMenu(r.left, r.bottom + 2); }}>
        <${Icon} name="more" size=${15} />
      </button>
    </div>`;
}

// ---------- modals ----------

function TimerModal({ timer, taskCodes, groups, onDone, onClose }) {
  const [name, setName] = useState(timer ? timer.name : '');
  const [cm, setCm] = useState(timer && timer.cm_id
    ? { id: timer.cm_id, cm_number: timer.cm_number, short_name: timer.cm_short_name } : null);
  const [taskCode, setTaskCode] = useState(timer ? (timer.task_code || '') : '');
  const [groupId, setGroupId] = useState(timer ? (timer.group_id ?? '') : '');
  const [template, setTemplate] = useState(timer ? (timer.narrative_template || '') : '');
  const [error, setError] = useState(null);

  async function save() {
    try {
      const body = {
        name, cm_id: cm ? cm.id : null, task_code: taskCode || null,
        group_id: groupId === '' ? null : Number(groupId),
        narrative_template: template.trim() || null,
      };
      const saved = timer
        ? await api.patch(`/api/timers/${timer.id}`, body)
        : await api.post('/api/timers', body);
      onDone(saved);
    } catch (err) { setError(err.message); }
  }

  return html`
    <${Modal} title=${timer ? 'Edit timer' : 'New timer'} onClose=${onClose}>
      <div class="grid">
        <${Field} label="Button name">
          <input type="text" value=${name} autoFocus placeholder="e.g. Acme — research"
            onInput=${(e) => setName(e.target.value)}
            onKeyDown=${(e) => { if (e.key === 'Enter' && name.trim()) save(); }} />
        <//>
        <${Field} label="Client/Matter (optional — stops hold the time until assigned)">
          <${CmPicker} value=${cm} onChange=${(v) => { setCm(v); if (!name) setName(v.short_name); }} />
        <//>
        <div class="grid" style=${{ gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
          <${Field} label="Default task code">
            <select value=${taskCode} onChange=${(e) => setTaskCode(e.target.value)}>
              <option value="">(none)</option>
              ${taskCodes.map((c) => html`<option key=${c.id} value=${c.name}>${c.name}</option>`)}
            </select>
          <//>
          <${Field} label="Group">
            <select value=${groupId} onChange=${(e) => setGroupId(e.target.value)}>
              <option value="">Ungrouped</option>
              ${groups.map((g) => html`<option key=${g.id} value=${g.id}>${g.name}</option>`)}
            </select>
          <//>
        </div>
        <${Field} label="Template narrative (optional)"
          hint="Every entry this timer creates starts with this text — finish or extend it at close-out.">
          <textarea rows="2" value=${template} spellCheck=${true}
            placeholder="e.g. Attend weekly all-hands call with Meridian and Calloway teams regarding"
            onInput=${(e) => setTemplate(e.target.value)}></textarea>
        <//>
        ${error ? html`<div class="error-box">${error}</div>` : null}
        <div class="row-end">
          <button type="button" class="btn" onClick=${onClose}>Cancel</button>
          <button class="btn btn-primary" disabled=${!name.trim()} onClick=${save}>
            ${timer ? 'Save' : 'Create'}</button>
        </div>
      </div>
    <//>`;
}

function GroupModal({ group, onDone, onClose }) {
  const [name, setName] = useState(group ? group.name : '');
  async function save() {
    if (group) await api.patch(`/api/timer-groups/${group.id}`, { name });
    else await api.post('/api/timer-groups', { name });
    onDone();
  }
  return html`
    <${Modal} title=${group ? 'Rename group' : 'New timer group'} onClose=${onClose}>
      <${Field} label="Group name">
        <input type="text" value=${name} autoFocus placeholder="e.g. Litigation"
          onInput=${(e) => setName(e.target.value)}
          onKeyDown=${(e) => { if (e.key === 'Enter' && name.trim()) save(); }} />
      <//>
      <div class="row-end">
        <button class="btn" onClick=${onClose}>Cancel</button>
        <button class="btn btn-primary" disabled=${!name.trim()} onClick=${save}>${group ? 'Save' : 'Create'}</button>
      </div>
    <//>`;
}
