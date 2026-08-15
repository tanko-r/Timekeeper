import { api } from '/js/api.js';
import {
  html, useState, useEffect, useRef, useCallback,
  fmtClock, fmtTenths, fmtHours, emitToast, Modal, Confirm, Field, Icon, clientLabel,
  BillableBadge, StatusChip, ValidationList, fmtStamp, markJustFinalized,
} from '/js/ui.js';
import { CmPicker } from '/js/components/cmpicker.js';
import { TimerImport } from '/js/components/timerimport.js';
import { StopChips } from '/js/components/stopchips.js';
import {
  InlineNarrative, EmptyState, useDensity, writeDensity,
} from '/js/components/entrylist.js';
import { Menu, rowMenuItems as buildRowMenu, rowMenuTitle, menuTriggerProps } from '/js/components/menu.js';
import { longRunNotifications } from '/js/lib/notify.js';
import { startAlignedTick } from '/js/lib/tick.js';
import { activityWindows, lastActivityMs, inWindow } from '/js/lib/activity.js';
import { compareTimersAZ } from '/js/lib/timersort.js';

// ---------------------------------------------------------------------------
// ONE LIST OF TODAY'S WORK  (teardown §5/§6, E1 — "the single highest-value
// change in the document")
//
// Before this file there were two lists on the dashboard: a timer BOARD (three
// grouping modes, a ten-tab strip, search, A–Z, New group, Import, Quick, New
// timer — fourteen controls before a single timer was visible) and, below it,
// a separate "Today's entries" list showing the same matters again in a
// different shape with five more unlabelled icon buttons each. On a 390px
// phone the first control that could start a timer sat 978px down.
//
// A timer and the entry it fills are the same piece of work at two moments, so
// they are now ONE ROW: the matter, its state, the live clock, the hours, the
// narrative, one labelled primary action, and one overflow. Harvest's timesheet
// row (shots/refs/harvest-timetracking.desktop.1.png) is the reference: one
// list, one row type, labelled controls.
//
// NOTHING WAS DELETED, only demoted. Grouping (by group / by client), the
// activity filters that used to be a tablist, A–Z, New group, CSV import,
// multi-select and its batch actions all live in the list's own "⋯" menu, and
// every one of them now has a touch path it did not have before — including
// "Move to group…" on the row menu, which is the thumb equivalent of a drag.
// Drag-and-drop reorder still works on desktop, in the manual order it writes.
// ---------------------------------------------------------------------------

const ACT_LABELS = { 'act-today': 'Ran today', 'act-yesterday': 'Yesterday', 'act-week': 'This week', 'act-recent': 'Recent' };

export function TodayList({ settings, entries = [], openEditor, onEntryChanged }) {
  const [timers, setTimers] = useState(null);
  const [groups, setGroups] = useState([]);
  const [fetchedAt, setFetchedAt] = useState(Date.now());
  const [, forceTick] = useState(0);
  const [editing, setEditing] = useState(null);       // timer | 'new'
  const [groupModal, setGroupModal] = useState(null); // 'new' | group
  const [menu, setMenu] = useState(null);             // { anchor|x,y, row } | { anchor|x,y, ids }
  const [listMenu, setListMenu] = useState(null);     // { anchor } — the list's own options
  const [stopPopup, setStopPopup] = useState(null);   // {timer, result}
  const [deleting, setDeleting] = useState(null);
  const [deletingEntry, setDeletingEntry] = useState(null);
  const [importing, setImporting] = useState(false);
  const [taskCodes, setTaskCodes] = useState([]);
  // A row whose narrative editor was opened from somewhere else (the "needs a
  // narrative" attention line, or the row menu) — it opens focused and typing.
  const [writingKey, setWritingKey] = useState(null);
  // …and WHICH of that row's entries it is about. A matter row can carry more
  // than one entry today, so "write the narrative for entry 42" has to name 42.
  const [writeEntryId, setWriteEntryId] = useState(null);
  const dragId = useRef(null);
  // Trello-style relocation feedback (2026-08-05 feedback): the row being
  // dragged fades, and an empty slot opens in front of the row the drop will
  // land before — so the list visibly makes room instead of the timer silently
  // reappearing somewhere else. Rendering-only; `dragId` is what dropOn reads.
  const [draggingId, setDraggingId] = useState(null);
  const [dropBeforeId, setDropBeforeId] = useState(null);
  const endDrag = () => { setDraggingId(null); setDropBeforeId(null); };

  // Multi-select (2026-08-06 feedback): Ctrl/⌘-click toggles a row, Shift-click
  // extends from the last one clicked, a plain click on a row's body or Esc
  // clears. Deliberately NOT persisted. WAVE-1: there is now an explicit
  // SELECT MODE as well (list menu → "Select several"), which puts a real
  // checkbox on every row and a batch action bar above the list — Carbon's
  // data-table pattern — because Ctrl/Shift-click and right-click are
  // pointer-only and a phone had no route to batch actions at all.
  const [selected, setSelected] = useState(() => new Set());
  const [selectMode, setSelectMode] = useState(false);
  const anchorId = useRef(null);
  const clearSelection = () => setSelected((s) => (s.size ? new Set() : s));
  const exitSelectMode = () => { setSelectMode(false); clearSelection(); };

  function selectCard(e, timer, list) {
    const ids = list.filter((r) => r.timer).map((r) => r.timer.id);
    if (e.shiftKey && anchorId.current != null && ids.includes(anchorId.current)) {
      const a = ids.indexOf(anchorId.current);
      const b = ids.indexOf(timer.id);
      const range = ids.slice(Math.min(a, b), Math.max(a, b) + 1);
      setSelected((s) => new Set([...s, ...range]));
      return;
    }
    if (e.ctrlKey || e.metaKey) {
      anchorId.current = timer.id;
      setSelected((s) => {
        const next = new Set(s);
        if (next.has(timer.id)) next.delete(timer.id); else next.add(timer.id);
        return next;
      });
      return;
    }
    anchorId.current = timer.id;
    clearSelection();
  }

  const toggleSelected = (id) => setSelected((s) => {
    const next = new Set(s);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  // ---------- view preferences (all persisted per browser, all in the ⋯ menu) ----------

  // Grouping. Default is 'flat' now: with five timers, sections are noise. The
  // two grouped modes survive for anyone who has fifty.
  const [grouping, setGroupingState] = useState(() => {
    const v = localStorage.getItem('tk:timerGrouping');
    return ['group', 'client', 'flat'].includes(v) ? v : 'flat';
  });
  const setGrouping = (v) => { localStorage.setItem('tk:timerGrouping', v); setGroupingState(v); };

  // "Only this group/client" — the capability the old tab strip carried,
  // without the strip. Persisted per grouping mode, same as the tabs were.
  const [onlyKey, setOnlyKeyState] = useState(() => localStorage.getItem('tk:timerOnly:flat') || '');
  useEffect(() => { setOnlyKeyState(localStorage.getItem(`tk:timerOnly:${grouping}`) || ''); }, [grouping]);
  const setOnlyKey = (k) => { localStorage.setItem(`tk:timerOnly:${grouping}`, k); setOnlyKeyState(k); };

  // The old Today / Yesterday / Week / Recent tabs, as a filter.
  const [activityKey, setActivityKeyState] = useState(() => localStorage.getItem('tk:timerActivity') || '');
  const setActivityKey = (k) => { localStorage.setItem('tk:timerActivity', k); setActivityKeyState(k); };

  // Order. 'activity' is the default the teardown asked for — what ran today,
  // then what ran most recently. 'manual' is the drag-and-drop order held in
  // timers.sort_order, and is what A–Z writes into.
  const [order, setOrderState] = useState(() => (localStorage.getItem('tk:timerOrder') === 'manual' ? 'manual' : 'activity'));
  const setOrder = (v) => { localStorage.setItem('tk:timerOrder', v); setOrderState(v); };

  // DENSITY — the whole-list half of the owner's expansion constraint. Lives in
  // localStorage under `tk:listDensity` (components/entrylist.js), so the
  // choice survives a reload, a restart and a route change, and the calendar's
  // day panel reads the same key.
  const density = useDensity();

  // EXPANSION — the per-row half. A compact row is the matter, its state, its
  // hours and its transport control; everything the compact form leaves out —
  // the narrative, the task split, the findings, the clock when it is not the
  // row's own figure — is one disclosure away, reachable three ways: the 44×44
  // chevron in the control strip, a click anywhere on the row that is not a
  // control, and `x` on the focused row.
  const [expanded, setExpanded] = useState(() => new Set());
  const toggleExpanded = useCallback((key) => setExpanded((s) => {
    const next = new Set(s);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  }), []);
  const openExpanded = useCallback((key) => setExpanded((s) => (s.has(key) ? s : new Set([...s, key]))), []);

  // Keyboard focus model (spec §4): ONE focused row via roving tabindex.
  const [focusKey, setFocusKey] = useState(null);

  // A just-created timer jumps into view (2026-07-13 feedback): drop every
  // filter, then — once the render that includes the new row commits — scroll
  // to it and hand it the keyboard focus.
  const [revealId, setRevealId] = useState(null);
  const reveal = (id) => {
    setGridFilter('');
    setOnlyKey('');
    setActivityKey('');
    setRevealId(id);
  };
  useEffect(() => {
    if (revealId == null) return;
    const el = document.querySelector(`.today-list .work-row[data-timer-id="${revealId}"]`);
    if (!el) return; // not rendered yet — retry on the next timers render
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setFocusKey(`t${revealId}`);
    el.focus({ preventScroll: true });
    setRevealId(null);
  });

  // Search bar: `/` on the dashboard (or the toolbar button) opens an explicit
  // search input; typing narrows the list in place.
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
  // tick aligned to that boundary, not a drifting 1s interval.
  useEffect(() => startAlignedTick(fetchedAt, () => forceTick((x) => x + 1)), [fetchedAt]);

  const liveElapsed = useCallback((t) => {
    let s = t.elapsed_seconds;
    if (t.running) s += (Date.now() - fetchedAt) / 1000;
    return Math.floor(s);
  }, [fetchedAt]);

  // OS/browser notification when a timer's CURRENT running stretch passes 2h,
  // then hourly — keyed off last_started_at, not the day accumulator.
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

  // "Assign matter" elsewhere opens this list's edit modal.
  useEffect(() => {
    const onEditTimer = (e) => {
      const t = (timers || []).find((x) => x.id === e.detail.id);
      if (t) setEditing(t);
    };
    window.addEventListener('tk:edit-timer', onEditTimer);
    return () => window.removeEventListener('tk:edit-timer', onEditTimer);
  }, [timers]);

  // Someone outside the list changed a timer — refresh now, don't wait 5s.
  useEffect(() => {
    const onChanged = () => reload().catch(() => {});
    window.addEventListener('tk:timers-changed', onChanged);
    return () => window.removeEventListener('tk:timers-changed', onChanged);
  }, [reload]);

  // ---------- actions ----------

  const guard = (p) => p.catch((e) => emitToast(e.message, { error: true }));

  const start = useCallback(async (timer, opts = {}) => {
    // First-ever start is the natural user gesture to ask for notification
    // permission (for the 2h+ long-running alerts). Fire-and-forget.
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      Notification.requestPermission().catch(() => {});
    }
    const r = await api.post(`/api/timers/${timer.id}/start`, opts);
    localStorage.setItem('tk:lastTimer', String(timer.id));
    // Exclusive timers: the server stop-and-filed whatever was running.
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
    // Deliberately imperative one-shot DOM class: a single confirmation pulse
    // on the row that just started, self-removing after one animation cycle.
    const el = document.querySelector(`.work-row[data-timer-id="${timer.id}"]`);
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

  // The row with no timer has hours too, and they have to be adjustable by
  // thumb — the same tap-to-edit contract the clock has had all along
  // (teardown E1: Alt+↑/↓ is keyboard-only and fails the brief).
  const entryTotalSet = useCallback(async (entry, hours) => {
    await api.patch(`/api/entries/${entry.id}`, { total_override: hours });
    onEntryChanged();
    await reload();
  }, [reload, onEntryChanged]);

  const fresh = useCallback(async (timer) => {
    await api.post(`/api/timers/${timer.id}/fresh`);
    emitToast('Clock zeroed — next stop files a new entry. Today’s entry kept.');
    await reload();
  }, [reload]);

  // not memoized: reveal() closes over the current filters
  const duplicate = async (timer) => {
    const copy = await api.post(`/api/timers/${timer.id}/duplicate`);
    await reload();
    if (copy && copy.id) reveal(copy.id);
  };

  const quickTimer = useCallback(async () => {
    const t = await api.post('/api/timers', {});
    await start(t);
    reveal(t.id);
  }, [start]); // eslint-disable-line

  // Entry-side actions, so a row that carries an entry can do everything the
  // old separate entry card could.
  const finalizeEntry = async (entry) => {
    try {
      await api.post(`/api/entries/${entry.id}/finalize`);
      markJustFinalized(entry.id);
      onEntryChanged();
      emitToast('Finalized', {
        actionLabel: 'Unlock',
        action: async () => { await api.post(`/api/entries/${entry.id}/unlock`); onEntryChanged(); },
      });
    } catch (e) {
      if (e.status === 422) openEditor({ id: entry.id });
      else emitToast(e.message, { error: true });
    }
  };
  const unlockEntry = async (entry) => {
    await api.post(`/api/entries/${entry.id}/unlock`);
    onEntryChanged();
    emitToast('Unlocked — edits will be tracked in the audit log.');
  };
  const deleteEntry = async (entry) => {
    await api.del(`/api/entries/${entry.id}`);
    onEntryChanged();
    emitToast(`Deleted ${fmtHours(entry.total)}h ${entry.cm ? `entry for ${entry.cm.short_name}` : 'unassociated entry'}`, {
      actionLabel: 'Undo',
      action: async () => { await api.post(`/api/entries/${entry.id}/restore`); onEntryChanged(); },
    });
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

  // A stop routed through THIS component still offers the narrative chips; a
  // bare POST from another surface files a silent draft that has to be chased
  // at close-out. The run bar currently stops directly — dispatching
  // `tk:stop-timer` instead would give it the chips for free. Left in place as
  // that integration point (and used by anything else that needs to stop the
  // timer without owning the chip flow).
  useEffect(() => {
    const onStop = (e) => {
      const t = (timers || []).find((x) => x.id === e.detail?.id) || (timers || []).find((x) => x.running);
      if (t) guard(stop(t));
    };
    const onQuick = () => guard(quickTimer());
    window.addEventListener('tk:stop-timer', onStop);
    window.addEventListener('tk:quick-timer', onQuick);
    return () => {
      window.removeEventListener('tk:stop-timer', onStop);
      window.removeEventListener('tk:quick-timer', onQuick);
    };
  }, [timers, stop, quickTimer]);

  // The attention line's "N need a narrative" hands a specific entry here:
  // scroll its row into view and open its narrative editor, focused.
  useEffect(() => {
    const onFocusEntry = (e) => {
      const id = e.detail?.id;
      if (id == null) return;
      setGridFilter('');
      setOnlyKey('');
      setActivityKey('');
      // Which ROW holds this entry, under the merged model: the timer that
      // filed it, else the sole timer on its matter, else the matter's own
      // row, else the entry's own row.
      const entry = (entries || []).find((x) => x.id === id);
      const owner = (timers || []).find((t) => t.linked_entry_id === id);
      const cmId = entry && entry.cm ? entry.cm.id : null;
      const onMatter = cmId ? (timers || []).filter((t) => t.cm_id === cmId) : [];
      const target = owner ? `t${owner.id}`
        : onMatter.length === 1 ? `t${onMatter[0].id}`
          : cmId ? `m${cmId}` : `e${id}`;
      setFocusKey(target);
      openExpanded(target);
      setWritingKey(target);
      setWriteEntryId(id);
      requestAnimationFrame(() => {
        document.querySelector(`.today-list .work-row[data-row-key="${target}"]`)
          ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      });
    };
    window.addEventListener('tk:focus-entry', onFocusEntry);
    return () => window.removeEventListener('tk:focus-entry', onFocusEntry);
  }, [timers, entries]); // eslint-disable-line

  // `/` opens the search bar — or, when it's already open and focus has
  // wandered off, refocuses the input directly.
  useEffect(() => {
    const onSearch = () => {
      const el = searchInputRef.current;
      if (el) { el.focus(); el.select(); }
      else setSearchOpen(true);
    };
    window.addEventListener('tk:timer-search', onSearch);
    return () => window.removeEventListener('tk:timer-search', onSearch);
  }, []);

  // CLEARING THE FILTER, BY THUMB.
  //
  // Measured by the wave critic: `.timer-search-wrap` contained exactly one
  // node, the input. The ✕ visible in the desktop screenshot was Chrome's
  // `::-webkit-search-cancel-button` — not a DOM node, and not drawn by Chrome
  // for Android, which is the browser the installed PWA runs in. So on the
  // phone there was no clear control at all, and the toolbar's ⌕ no-opped once
  // a query was typed: the only way out was to select the text and backspace.
  //
  // There are three ways out now, and none of them needs a keyboard: the ✕
  // inside the field (below), the ⌕ toggle (which clears AND closes when a
  // query is present), and Escape.
  const clearFilter = useCallback((refocus) => {
    setGridFilter('');
    if (refocus === 'input') requestAnimationFrame(() => searchInputRef.current?.focus());
  }, []);

  // Focus the search input whenever it opens — an effect, not a same-tick rAF:
  // a bare rAF can fire one frame before React commits the re-render, so the
  // ref is still null and focus silently no-ops.
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
    const sorted = [...timers].sort(compareTimersAZ);
    setOrder('manual');
    await persistOrder(sorted);
    emitToast('Sorted A–Z by name — the list is in its manual order now');
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
    // A drop is an explicit statement about order, so it switches the list out
    // of activity order — otherwise the reorder would be written to the server
    // and be invisible on screen, which is worse than not having the feature.
    setOrder('manual');
    await persistOrder(list);
  }

  // Move a timer one place up/down inside its own list — the touch equivalent
  // of the drag, on the row menu.
  async function nudgeOrder(timer, dir) {
    const list = [...timers];
    const i = list.findIndex((t) => t.id === timer.id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    setOrder('manual');
    await persistOrder(list);
  }

  // ---------- row menu ----------

  // ONE ROW MENU, SHARED WITH THE ENTRY LIST AND THE LEDGER.
  //
  // The wave critic measured the seventeen-item popover the teardown named as
  // the app's tell and the previous pass cut it to ten — but into TWO menus:
  // `Timer menu` (10 items) on a row with a timer, `Entry menu` (6) on one
  // without, and `Delete entry` present in one and absent from the other, with
  // nothing on the row to say which you were about to get (wave-1 review, D7).
  //
  // There is one now. It is built by `rowMenuItems` in components/menu.js from
  // what the row IS — timer or not, running or not, entry or not, draft or
  // finalized — and it is grouped: Timer, then Entry, then Manage, then the one
  // destructive item alone under a rule. `Delete entry` is on every row that
  // has an entry; on a finalized one it is present, disabled, and says that it
  // needs unlocking first, because that is what the server says too.
  //
  // The split by subject survives: what a lawyer does to TODAY'S WORK is in the
  // menu, and what he does to the TIMER ITSELF — duplicate, group, reorder,
  // pin, zero, delete — is one row (`Edit timer…`) into the dialog that already
  // owned the timer's name, matter, task code, group and template. Nothing is
  // gone; every one of those is a 44px target there.
  function rowMenuItems(row) {
    return buildRowMenu({
      timer: row.timer,
      entries: row.entries || [],
      focus: row.focus || null,
      fmtHours,
    }, {
      start: (t) => guard(start(t)),
      stop: (t) => guard(stop(t)),
      startBackdated: (t, opts) => { setMenu(null); guard(start(t, opts)); },
      startForEntry: (e) => guard(startForEntry(e)),
      openEntry: (e) => openEditor({ id: e.id }),
      // The narrative editor lives in the row's expandable half, so asking for
      // it opens that half — otherwise the item is a no-op at compact density.
      writeNarrative: (e) => {
        openExpanded(row.key); setFocusKey(row.key); setWritingKey(row.key); setWriteEntryId(e.id);
      },
      finalize: (e) => guard(finalizeEntry(e)),
      unlock: (e) => guard(unlockEntry(e)),
      copyToToday: (e) => openEditor({ copyFrom: e.id }),
      editTimer: (t) => setEditing(t),
      deleteEntry: (e) => setDeletingEntry(e),
    });
  }

  async function startForEntry(entry) {
    await api.post('/api/timers/start-for-entry', { entry_id: entry.id });
    onEntryChanged();
    await reload();
  }

  // The right-click / batch-bar menu for a multi-selection.
  function batchMenuItems(ids) {
    const picked = timers.filter((t) => ids.includes(t.id));
    const allPinned = picked.every((t) => t.pinned);
    const patchAll = async (body) => {
      await Promise.all(ids.map((id) => api.patch(`/api/timers/${id}`, body)));
      await reload();
    };
    return [
      { section: `${ids.length} timers selected` },
      {
        custom: () => html`
          <div class="ctx-inline">
            <span class="muted small">Group</span>
            <select value="" onChange=${(e) => {
              const v = e.target.value;
              if (v === '') return;
              setMenu(null);
              guard(patchAll({ group_id: v === 'none' ? null : Number(v) }));
            }}>
              <option value="">Move to…</option>
              <option value="none">Ungrouped</option>
              ${groups.map((g) => html`<option key=${g.id} value=${g.id}>${g.name}</option>`)}
            </select>
          </div>`,
      },
      {
        label: allPinned ? 'Unpin all from float window' : 'Pin all to float window',
        icon: 'pin',
        onClick: () => guard(patchAll({ pinned: allPinned ? 0 : 1 })),
      },
      { hr: true },
      {
        label: `Delete ${ids.length} timers`,
        icon: 'trash',
        danger: true,
        onClick: () => setDeleting({ ids, names: picked.map((t) => t.name) }),
      },
    ];
  }

  // ---------- render ----------

  // hook-safe: runs before the early return, touches only the DOM
  useEffect(() => {
    if (!gridFilter) return;
    const active = document.activeElement;
    if (active && active.classList && active.classList.contains('timer-search')) return;
    const rows = [...document.querySelectorAll('.today-list .work-row')];
    if (active && rows.includes(active)) return;
    if (rows[0]) { setFocusKey(rows[0].dataset.rowKey); rows[0].focus(); }
    else document.querySelector('.today-list')?.focus();
  }, [gridFilter]);

  // hook-safe: if the focused row vanishes — filtered out, or deleted — and
  // focus dropped with it, reclaim it onto whatever row is now tabbable.
  useEffect(() => {
    if (focusKey == null) return;
    const stillThere = document.querySelector(`.today-list .work-row[data-row-key="${focusKey}"]`);
    if (stillThere) return;
    const active = document.activeElement;
    const wasRow = !!(active && active.classList && active.classList.contains('work-row'));
    const fellToBody = !active || active === document.body;
    if (!wasRow && !fellToBody) return;
    const rows = [...document.querySelectorAll('.today-list .work-row')];
    const next = rows.find((c) => c.tabIndex === 0) || rows[0];
    if (next) { setFocusKey(next.dataset.rowKey); next.focus(); }
  });

  if (!timers) return null;
  const idleAfter = (settings.idleNudgeHours ?? 3) * 3600;
  const roundMode = settings.rounding?.enabled === false ? 'nearest' : (settings.rounding?.mode || 'up');
  const byGroupMode = grouping === 'group';
  const todayEntries = entries || [];

  // ---------- the merged row model: KEYED BY MATTER ----------
  // A timer and the entry it filled are the same work at two moments — and so
  // are an entry keyed by hand and the timer that stands for the same matter.
  // Before this pass the list still showed one matter twice, with two
  // different numbers: "Acme lease dispute · 1.7 · finalized" and
  // "Acme — lease dispute · 0.0". One matter, one row.
  //
  // THE THREE EDGE CASES, decided here so the next hand does not have to guess:
  //
  //   TWO TIMERS ON ONE MATTER — they stay TWO rows. A timer is a named work
  //     stream the lawyer made ("Acme — research", "Acme — drafting"); folding
  //     them together would hide one and leave it with no way to be started.
  //     So an entry joins a matter's timer row only where that matter has
  //     exactly ONE timer. Where it has several, an entry rides the timer that
  //     actually filed it (linked_entry_id) and anything unlinked forms the
  //     matter's own row beside them.
  //
  //   A QUICK TIMER WITH NO MATTER — its own row, keyed by the timer. Two
  //     matterless timers are two different pieces of work and there is no key
  //     that could merge them honestly. The row carries "Assign matter", and
  //     the moment a matter is assigned it merges into that matter's row.
  //
  //   AN ENTRY ON A MATTER WITH NO TIMER — a matter row with no timer: today's
  //     recorded hours, the row's state, the narrative, and a Start button that
  //     creates/links one through /api/timers/start-for-entry. A MATTERLESS
  //     entry keeps its own row, for the same reason a matterless timer does.
  const entriesById = new Map(todayEntries.map((e) => [e.id, e]));
  const timersByCm = new Map();
  for (const t of timers) {
    if (!t.cm_id) continue;
    if (!timersByCm.has(t.cm_id)) timersByCm.set(t.cm_id, []);
    timersByCm.get(t.cm_id).push(t);
  }
  const claimed = new Set();
  const timerRows = timers.map((t) => {
    const own = t.linked_entry_id ? entriesById.get(t.linked_entry_id) || null : null;
    if (own) claimed.add(own.id);
    return { key: `t${t.id}`, timer: t, entries: own ? [own] : [] };
  });
  const rowByTimerId = new Map(timerRows.map((r) => [r.timer.id, r]));
  // pass two: a matter's remaining entries join its SOLE timer's row
  for (const e of todayEntries) {
    if (claimed.has(e.id) || !e.cm) continue;
    const ts = timersByCm.get(e.cm.id);
    if (!ts || ts.length !== 1) continue;
    rowByTimerId.get(ts[0].id).entries.push(e);
    claimed.add(e.id);
  }
  // pass three: what no timer owns becomes a matter row (or its own row when
  // there is no matter to key it by)
  const entryRows = [];
  const rowByCm = new Map();
  for (const e of todayEntries) {
    if (claimed.has(e.id)) continue;
    if (!e.cm) { entryRows.push({ key: `e${e.id}`, timer: null, entries: [e] }); continue; }
    if (!rowByCm.has(e.cm.id)) {
      const row = { key: `m${e.cm.id}`, timer: null, entries: [] };
      rowByCm.set(e.cm.id, row);
      entryRows.push(row);
    }
    rowByCm.get(e.cm.id).entries.push(e);
  }
  const allRows = [...timerRows, ...entryRows];

  // THE ENTRY A ROW SPEAKS FOR. A matter can carry several today — one the
  // timer filled, one keyed by hand, an orphan a deleted timer left behind —
  // and the row shows one narrative, so the choice has to be the one a lawyer
  // would act on:
  //   1. the entry something explicitly asked to write ("N need a narrative")
  //   2. this timer's OWN entry, when it has anything on it — that is the one
  //      the row's clock and its Start/Stop are about
  //   3. otherwise the biggest real draft, because that is where the day's
  //      work actually is — never a 0.0h leftover
  //   4. …then any draft, then whatever is there
  const substantive = (e) => !!(e.narrative || '').trim() || e.total > 0;
  const focusEntryOf = (r) => {
    const es = r.entries;
    if (!es.length) return null;
    const wanted = writeEntryId != null ? es.find((e) => e.id === writeEntryId) : null;
    if (wanted) return wanted;
    const linked = r.timer ? es.find((e) => e.id === r.timer.linked_entry_id) : null;
    if (linked && substantive(linked)) return linked;
    const drafts = es.filter((e) => e.status === 'draft' && substantive(e));
    if (drafts.length) return drafts.slice().sort((a, b) => b.total - a.total)[0];
    return linked || es.find((e) => e.status === 'draft') || es[0];
  };
  for (const r of allRows) r.focus = focusEntryOf(r);

  const rowName = (r) => {
    if (r.timer) return r.timer.name;
    const e = r.entries[0];
    return e && e.cm ? e.cm.short_name : 'No matter yet';
  };
  const rowSecs = (r) => (r.timer ? liveElapsed(r.timer) : 0);

  // A FORGIVING FILTER (owner constraint 4: "timer search must be excellent
  // rather than merely present"). Three things it now forgives that a single
  // `includes` did not:
  //
  //   WORD ORDER   the query is split on whitespace and every term has to
  //                appear SOMEWHERE in the row — so "lease acme" finds
  //                "Acme — lease dispute", and so does "acme dispute".
  //   PUNCTUATION  a copy of the haystack with every non-alphanumeric squeezed
  //                out is searched too, so "100001000012" finds
  //                "100001-000012", "acmelease" finds "Acme — lease", and an
  //                em dash or an apostrophe never costs a match.
  //   ACCENTS      both sides are NFD-folded, so "verite" finds "Verité".
  //
  // It searches the same fields as before plus the timer's task code, and it is
  // matched against the row's whole text rather than field by field, so a query
  // may straddle two of them ("acme merger" spans the name and the matter).
  const fold = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const squash = (s) => s.replace(/[^a-z0-9]+/g, '');
  const norm = gridFilter.trim().toLowerCase();
  const terms = fold(gridFilter).split(/\s+/).filter(Boolean);
  const matchesFilter = (r) => {
    if (terms.length === 0) return true;
    const hay = fold([
      rowName(r), r.timer?.cm_short_name, r.timer?.client_name, r.timer?.client_number,
      r.timer?.cm_number, r.timer?.task_code,
      ...r.entries.flatMap((e) => [e.cm?.short_name, e.cm?.client_name, e.cm?.cm_number, e.narrative]),
    ].filter(Boolean).join(' '));
    const tight = squash(hay);
    return terms.every((t) => hay.includes(t) || (squash(t) && tight.includes(squash(t))));
  };

  const nowMs = Date.now();
  const ACTIVITY = activityWindows(nowMs);
  const dayStartMs = new Date(nowMs).setHours(0, 0, 0, 0);
  // Entry-only rows are today's work by definition, so they rank with the
  // timers that ran today — in the order the entries were created, which is
  // the order the day happened (hence the descending id term: the comparator
  // sorts this value high-to-low).
  const entryActivityMs = (e) => dayStartMs + Math.max(0, 86000 - Math.min(e.id || 0, 86000));
  // A row ranks by the most recent thing that happened on it — the timer's own
  // activity OR the entries it now carries, because a matter with 1.7h
  // recorded and a timer that never ran today is still today's work.
  const rowActivityMs = (r) => Math.max(
    r.timer ? lastActivityMs(r.timer, nowMs) : 0,
    r.entries.length ? Math.max(...r.entries.map(entryActivityMs)) : 0);
  const matchesActivity = (r) => !activityKey || !ACTIVITY[activityKey]
    || inWindow(rowActivityMs(r), ACTIVITY[activityKey]);

  // section key/label for the two grouped modes; entry-only rows join by the
  // client number embedded in their matter number.
  const clientKeyOf = (r) => {
    if (r.timer) return r.timer.client_number || 'none';
    const num = r.entries[0]?.cm?.cm_number || '';
    return num.split('-')[0] || 'none';
  };
  const clientLabelOf = (r) => (r.timer
    ? (clientLabel(r.timer) || 'No client')
    : (r.entries[0]?.cm?.client_name || clientKeyOf(r) || 'No client'));

  const shown = allRows.filter((r) => matchesFilter(r) && matchesActivity(r));

  let sections; // [{ key, group, label, list }]
  if (grouping === 'client') {
    const byClient = new Map();
    for (const r of shown) {
      const key = clientKeyOf(r);
      if (!byClient.has(key)) {
        byClient.set(key, {
          key: `client-${key}`, group: null, label: clientLabelOf(r),
          unnamedClient: !!(r.timer && !r.timer.client_name && r.timer.client_number), list: [],
        });
      }
      byClient.get(key).list.push(r);
    }
    sections = [...byClient.values()].sort((a, b) =>
      a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }));
  } else if (byGroupMode) {
    sections = [
      ...groups.map((g) => ({
        key: `group-${g.id}`, group: g, label: g.name,
        list: shown.filter((r) => r.timer && r.timer.group_id === g.id),
      })),
      {
        key: 'ungrouped', group: null, label: 'Ungrouped',
        list: shown.filter((r) => !r.timer || r.timer.group_id == null),
      },
    ];
  } else {
    sections = [{ key: 'flat', group: null, label: null, list: shown }];
  }

  // "Only this section" — the tab strip's job, as a filter.
  const only = onlyKey && sections.some((s) => s.key === onlyKey) ? onlyKey : '';
  const renderedSections = only ? sections.filter((s) => s.key === only) : sections;

  // Order inside every section.
  const rowTier = (r) => {
    if (r.timer && r.timer.running) return 0;
    if (r.entries.length > 0 || rowSecs(r) > 0) return 1;
    return 2;
  };
  const sortRows = (list) => {
    if (order === 'manual') return list; // timers arrive in sort_order; entries trail
    return [...list].sort((a, b) => rowTier(a) - rowTier(b)
      || rowActivityMs(b) - rowActivityMs(a)
      || rowName(a).localeCompare(rowName(b), undefined, { sensitivity: 'base' }));
  };
  for (const sec of renderedSections) sec.list = sortRows(sec.list);

  // ordered list of rows actually on screen — the roving tabindex walks it
  const visible = renderedSections.flatMap((sec) => sec.list);
  const tabbableKey = visible.some((r) => r.key === focusKey) ? focusKey : (visible[0] && visible[0].key);

  const focusRow = (key) => {
    setFocusKey(key);
    requestAnimationFrame(() => {
      document.querySelector(`.today-list .work-row[data-row-key="${key}"]`)?.focus();
    });
  };

  function onSearchKeyDown(e) {
    e.stopPropagation(); // keep app-level shortcuts / StopChips out of the search box
    if (e.key === 'Escape') {
      e.preventDefault();
      setGridFilter('');
      setSearchOpen(false);
      if (tabbableKey != null) focusRow(tabbableKey);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (tabbableKey != null) focusRow(tabbableKey);
    } else if (e.key === 'Tab' && !e.shiftKey && norm && visible.length > 0) {
      e.preventDefault();
      focusRow(visible[0].key);
    }
  }

  // Keys for the focused row. Every command is a NON-PRINTABLE chord.
  // PRESERVED VERBATIM from the timer board: arrows walk the list, Enter/Space
  // start & stop, Shift+Enter edits, Ctrl+Enter opens the entry, Alt+↑/↓
  // nudges by a tenth (Shift doubles it). The one change is that Left/Right no
  // longer need getBoundingClientRect column geometry — a single column has no
  // columns, so they simply step the list like Up/Down.
  function onBoardKey(e) {
    const tag = (e.target.tagName || '').toLowerCase();
    if (['input', 'textarea', 'select'].includes(tag)) return;
    if (tag === 'button' && (e.key === 'Enter' || e.key === ' ')) return;
    const done = () => { e.preventDefault(); e.stopPropagation(); };

    if (e.key === 'Escape' && (selected.size || selectMode)) { exitSelectMode(); return done(); }

    const list = visible;
    if (list.length === 0) return;
    const idx = Math.max(0, list.findIndex((r) => r.key === focusKey));
    const cur = list[idx];

    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      if (!cur.timer) return done();
      const step = (e.shiftKey ? 0.2 : 0.1) * (e.key === 'ArrowUp' ? 1 : -1);
      guard(clockDelta(cur.timer, step));
      return done();
    }

    if (['ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
      const back = e.key === 'ArrowUp' || e.key === 'ArrowLeft';
      const next = back ? Math.max(idx - 1, 0) : Math.min(idx + 1, list.length - 1);
      focusRow(list[next].key);
      return done();
    }

    // EXPAND FROM THE KEYBOARD. `x`, because every other candidate is taken:
    // Enter and Space start and stop the clock, the arrows walk the list, and a
    // bare `e` would swallow the second half of the app's `g` then `e`
    // navigation chord for as long as a row had focus. It is one keystroke on
    // the row the roving tabindex already owns, and the chevron beside it says
    // so in its tooltip.
    if ((e.key === 'x' || e.key === 'X') && !e.ctrlKey && !e.metaKey && !e.altKey) {
      toggleExpanded(cur.key);
      return done();
    }

    if (e.key === 'Tab' && norm) {
      // While the filter is active, Tab walks the matching rows; past either
      // end it falls through so focus leaves the list naturally.
      const next = idx + (e.shiftKey ? -1 : 1);
      if (next >= 0 && next < list.length) { focusRow(list[next].key); return done(); }
      return undefined;
    }

    const curFocus = focusEntryOf(cur);
    if (e.key === 'Enter' && e.shiftKey) {
      if (cur.timer) setEditing(cur.timer);
      else if (curFocus) openEditor({ id: curFocus.id });
      return done();
    }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      const entryId = curFocus?.id || cur.timer?.linked_entry_id;
      if (entryId) openEditor({ id: entryId });
      else if (cur.timer) {
        openEditor({ template: { cm: { id: cur.timer.cm_id, cm_number: cur.timer.cm_number, short_name: cur.timer.cm_short_name, billable: cur.timer.cm_billable ?? 1 } } });
      }
      return done();
    }
    if (e.key === 'Enter' || e.key === ' ') {
      if (cur.timer) guard(cur.timer.running ? stop(cur.timer) : start(cur.timer));
      else if (curFocus) guard(startForEntry(curFocus));
      return done();
    }
  }

  // ---------- the list's own options menu ----------
  // Everything the fourteen-control header used to carry, one tap deep, with
  // the two view switches rendered as real segmented controls inside it.
  function listMenuItems() {
    const seg = (label, value, setter, options) => ({
      custom: () => html`
        <div class="ctx-inline ctx-seg-row">
          <span class="muted small">${label}</span>
          <span class="seg" role="group" aria-label=${label}>
            ${options.map(([v, l]) => html`
              <button key=${v} class=${value === v ? 'on' : ''} aria-pressed=${value === v}
                onClick=${() => setter(v)}>${l}</button>`)}
          </span>
        </div>`,
    });
    // GROUPED, because a flat list of eleven is not a menu (teardown §5). What
    // shapes the list comes first, what reorganises it second, and the one
    // destructive row last and alone — the same anatomy the row menu uses.
    const items = [
      { section: 'View' },
      seg('Show', activityKey, setActivityKey, [
        ['', 'All'], ['act-today', 'Today'], ['act-yesterday', 'Yesterday'],
        ['act-week', 'Week'], ['act-recent', 'Recent'],
      ]),
      seg('Group', grouping, setGrouping, [['flat', 'Flat'], ['group', 'By group'], ['client', 'By client']]),
      // DENSITY, beside the other two view switches. "Compact is the right
      // default, and denser than today is better — provided it expands"
      // (BRIEF, owner constraint 5). Compact is two lines: the matter with its
      // state, then the control strip. Comfortable adds the narrative at rest.
      // Either way every row still expands, by chevron, by click or by `x`.
      seg('Density', density, writeDensity, [['compact', 'Compact'], ['comfortable', 'Comfortable']]),
    ];
    if (grouping !== 'flat') {
      items.push({
        custom: () => html`
          <div class="ctx-inline">
            <span class="muted small">Only</span>
            <select value=${only} onChange=${(e) => setOnlyKey(e.target.value)}>
              <option value="">Every ${byGroupMode ? 'group' : 'client'}</option>
              ${sections.map((s) => html`
                <option key=${s.key} value=${s.key}>${s.label ?? 'Ungrouped'} (${s.list.length})</option>`)}
            </select>
          </div>`,
      });
    }
    items.push(seg('Order', order, setOrder, [['activity', 'Recent activity'], ['manual', 'Manual']]));
    items.push({ section: 'Organise' });
    items.push({ label: 'Sort A–Z (writes the manual order)', icon: 'sortAZ', onClick: () => guard(sortAZ()) });
    items.push({ label: 'Select several…', icon: 'check', onClick: () => setSelectMode(true) });
    items.push({ label: 'New group…', icon: 'folder', onClick: () => setGroupModal('new') });
    const sec = byGroupMode && only ? sections.find((x) => x.key === only) : null;
    if (sec && sec.group) {
      items.push({ label: `Rename “${sec.group.name}”…`, icon: 'edit', onClick: () => setGroupModal(sec.group) });
    }
    items.push({ label: 'Import timers from CSV…', icon: 'download', onClick: () => setImporting(true) });
    if (sec && sec.group) {
      items.push({ hr: true });
      items.push({
        label: `Delete “${sec.group.name}” (timers kept)`,
        icon: 'trash',
        danger: true,
        onClick: () => guard(api.del(`/api/timer-groups/${sec.group.id}`).then(() => { setOnlyKey(''); return reload(); })),
      });
    }
    return items;
  }

  const activeFilters = [
    activityKey ? { label: ACT_LABELS[activityKey], clear: () => setActivityKey('') } : null,
    only ? { label: sections.find((s) => s.key === only)?.label ?? 'Group', clear: () => setOnlyKey('') } : null,
  ].filter(Boolean);

  const nothingAtAll = timers.length === 0 && todayEntries.length === 0;

  return html`
    <div class="today-head">
      <h2>Today’s work</h2>
      ${activeFilters.map((f, i) => html`
        <button key=${i} class="filter-pill" title="Remove this filter" onClick=${f.clear}>
          ${f.label} <${Icon} name="x" size=${12} />
        </button>`)}
      <div class="spacer" style=${{ flex: 1 }}></div>
      ${/* A TOGGLE THAT NEVER NO-OPS. With a query typed this button did
            nothing at all: the bar could only be closed from an EMPTY field,
            so on a phone — where the native ✕ is not drawn — a filter could be
            entered and never left except by selecting the text. It clears and
            closes now, and it reports its own state with aria-pressed instead
            of only painting it. */''}
      <button class=${'btn btn-sm today-search-btn' + (norm ? ' on' : '')}
        aria-pressed=${(searchOpen || !!gridFilter) ? 'true' : 'false'}
        title=${norm ? `Clear the filter “${gridFilter.trim()}” and close the bar`
          : searchOpen ? 'Close the filter bar ( / )' : 'Filter today’s work ( / )'}
        aria-label=${norm ? 'Clear the filter and close the search bar' : 'Search timers and entries'}
        onClick=${() => {
          if (norm) {
            clearFilter();
            setSearchOpen(false);
            if (tabbableKey != null) focusRow(tabbableKey);
            return;
          }
          setSearchOpen((v) => !v);
        }}>
        ${/* It stays a magnifier: the field carries its own ✕, and two ✕ glyphs
              four inches apart doing two different things is worse than one ✕
              beside a lit-up toggle. */''}
        <${Icon} name="search" size=${16} />
      </button>
      <button class="btn btn-sm today-menu-btn" title="List options — filter, group, order, import"
        aria-label="List options" ...${menuTriggerProps(!!listMenu)}
        onClick=${(e) => setListMenu({ anchor: e.currentTarget })}>
        <${Icon} name="more" size=${16} />
      </button>
    </div>
    ${(searchOpen || gridFilter) ? html`
      <div class="timer-search-wrap">
        <div class="timer-search-field">
          <input ref=${searchInputRef} type="search" class="timer-search" placeholder="Filter today’s work…"
            autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck=${false}
            aria-label="Filter today’s work by matter, client, number or narrative"
            value=${gridFilter}
            onInput=${(e) => setGridFilter(e.target.value)}
            onKeyDown=${onSearchKeyDown} />
          ${/* A REAL BUTTON, not Chrome's ::-webkit-search-cancel-button — that
                pseudo-element is not a DOM node, is not drawn by Chrome for
                Android at all, and is 12px wide where it is drawn. This one is
                44×44 under a thumb, keeps focus in the field so the next query
                can be typed straight away, and is hidden the moment the field
                is empty so it never sits there meaning nothing. */''}
          ${gridFilter ? html`
            <button type="button" class="timer-search-clear" aria-label="Clear the filter"
              title="Clear the filter (Esc)"
              onClick=${() => clearFilter('input')}>
              <${Icon} name="x" size=${16} />
            </button>` : null}
        </div>
        ${gridFilter ? html`<span class="muted small">${shown.length}/${allRows.length}</span>` : null}
      </div>` : null}

    ${selectMode || selected.size > 0 ? html`
      <div class="timer-selbar" role="status">
        <strong>${selected.size} selected</strong>
        <span class="muted small">Tick the rows you want, then choose an action.</span>
        <span class="spacer" style=${{ flex: 1 }}></span>
        <button class="btn btn-sm" disabled=${selected.size === 0}
          ...${menuTriggerProps(!!menu && !!menu.ids)}
          onClick=${(e) => setMenu({ anchor: e.currentTarget, ids: [...selected] })}>Actions…</button>
        <button class="btn btn-sm" onClick=${exitSelectMode}>Done (Esc)</button>
      </div>` : null}

    <div class="today-list" tabIndex=${-1} onKeyDown=${onBoardKey}
      onFocus=${(e) => { if (e.target === e.currentTarget && tabbableKey != null) focusRow(tabbableKey); }}>

      ${nothingAtAll ? html`
        <${EmptyState} icon="timer" heading="Nothing tracked today"
          description="Timekeeper starts with a timer. Make one for a matter you are working on, or start a quick timer now and assign the matter after the call."
          actionLabel="New timer" onAction=${() => setEditing('new')}
          secondaryLabel="Quick start" onSecondary=${() => guard(quickTimer())} />` : null}

      ${!nothingAtAll && visible.length === 0 ? html`
        <${EmptyState} icon="search" heading="Nothing matches"
          description=${norm ? `No timer or entry matches “${gridFilter.trim()}”.` : 'No work matches the filters on this list.'}
          actionLabel="Clear filters"
          onAction=${() => { setGridFilter(''); setActivityKey(''); setOnlyKey(''); }} />` : null}

      ${renderedSections.map((sec) => {
        const { group, list } = sec;
        // An empty section is hidden when a search or an activity filter
        // emptied it — but NOT when the reader explicitly asked for this one
        // group ("Only"), where the empty section is the answer and the drop
        // target.
        if (list.length === 0 && (norm || activityKey)) return null;
        if (!only && byGroupMode && !group && list.length === 0) return null;
        const showHead = grouping !== 'flat' && !only;
        return html`
          <div key=${sec.key} class="timer-section"
            onDragOver=${byGroupMode ? (e) => { e.preventDefault(); setDropBeforeId(null); } : undefined}
            onDrop=${byGroupMode ? (e) => { e.preventDefault(); endDrag(); guard(dropOn({ kind: 'group', groupId: group ? group.id : null })); } : undefined}>
            ${showHead ? html`
              <div class="group-head">
                <span class=${'group-name' + (group || sec.label !== 'Ungrouped' ? '' : ' muted')}>${sec.label ?? 'Ungrouped'}</span>
                ${sec.unnamedClient ? html`
                  <span class="muted small" title="Name this client in Clients & Matters (or the matter's edit dialog)">· unnamed</span>` : null}
                <span class="muted small">${list.length}</span>
              </div>` : null}
            <div class=${`work-rows density-${density}`}>
              ${list.flatMap((r) => {
                const dropHere = () => { endDrag(); guard(dropOn({ kind: 'timer', timer: r.timer })); };
                const row = html`
                  <${WorkRow} key=${r.key} row=${r} secs=${rowSecs(r)} idleAfter=${idleAfter}
                    roundMode=${roundMode}
                    canDrag=${!!r.timer && !selectMode} dragging=${!!r.timer && draggingId === r.timer.id}
                    selectMode=${selectMode}
                    selected=${!!r.timer && selected.has(r.timer.id)}
                    onToggleSelected=${() => r.timer && toggleSelected(r.timer.id)}
                    onSelect=${(e) => r.timer && selectCard(e, r.timer, list)}
                    tabbable=${tabbableKey === r.key} onFocusRow=${() => setFocusKey(r.key)}
                    expanded=${expanded.has(r.key)} onToggleExpand=${() => toggleExpanded(r.key)}
                    writing=${writingKey === r.key}
                    onWritingDone=${() => { setWritingKey(null); setWriteEntryId(null); }}
                    onStart=${() => guard(r.timer ? start(r.timer) : startForEntry(r.focus))}
                    onStop=${() => r.timer && guard(stop(r.timer))}
                    onSet=${(h) => guard(r.timer ? clockSet(r.timer, h) : entryTotalSet(r.focus, h))}
                    onSetHours=${(h) => r.focus && guard(entryTotalSet(r.focus, h))}
                    onRename=${(name) => r.timer && guard(api.patch(`/api/timers/${r.timer.id}`, { name }).then(reload))}
                    onOpenEntry=${() => r.focus && openEditor({ id: r.focus.id })}
                    onAssignMatter=${() => (r.focus ? openEditor({ id: r.focus.id }) : setEditing(r.timer))}
                    onEntryChanged=${onEntryChanged}
                    ${/* BY KEY, NOT BY OBJECT. Row objects are rebuilt from
                          timers+entries on every render, so `menu.row === r`
                          was false the moment the menu opened (opening it is a
                          setState) — the ⋯ reported aria-expanded="false" while
                          its own menu stood open, and the items were built from
                          a stale snapshot of the row. `r.key` is stable
                          (`t<id>` / `e<id>` / `m<id>`). */''}
                    menuOpen=${!!menu && menu.rowKey === r.key}
                    onMenu=${(at) => {
                      if (r.timer && selected.size > 1 && selected.has(r.timer.id)) setMenu({ ...at, ids: [...selected] });
                      else { clearSelection(); setMenu({ ...at, rowKey: r.key }); }
                    }}
                    onDragStart=${() => { dragId.current = r.timer.id; setDraggingId(r.timer.id); }}
                    onDragEnd=${endDrag}
                    onDragOverRow=${() => setDropBeforeId(draggingId === r.timer?.id ? null : r.timer?.id)}
                    onDropOn=${dropHere} />`;
                return r.timer && dropBeforeId === r.timer.id && draggingId !== null ? [html`
                  <div key=${`slot-${r.key}`} class="timer-drop-slot" aria-hidden="true"
                    onDragOver=${(e) => { e.preventDefault(); e.stopPropagation(); }}
                    onDrop=${(e) => { e.preventDefault(); e.stopPropagation(); dropHere(); }}></div>`, row] : [row];
              })}
              ${byGroupMode && list.length === 0 ? html`<div class="muted small drop-hint">Drop timers here</div>` : null}
            </div>
          </div>`;
      })}

      ${!nothingAtAll ? html`
        <button class="timer-new" onClick=${() => setEditing('new')}>
          <${Icon} name="plus" size=${16} /> New timer
        </button>` : null}
    </div>

    ${/* The open menu is re-read from the CURRENT rows every render, so a timer
          that starts, stops or files an entry while its menu is open rewrites
          the menu instead of acting on the row as it was when it opened. If the
          row is gone (filtered out, deleted) the menu goes with it. */''}
    ${menu ? (() => {
      const mrow = menu.ids ? null : allRows.find((x) => x.key === menu.rowKey);
      if (!menu.ids && !mrow) return null;
      return html`
        <${Menu} anchor=${menu.anchor} x=${menu.x} y=${menu.y}
          title=${menu.ids ? `${menu.ids.length} timers` : rowMenuTitle(mrow)}
          items=${menu.ids ? batchMenuItems(menu.ids) : rowMenuItems(mrow)}
          onClose=${() => setMenu(null)} />`;
    })() : null}

    ${listMenu ? html`
      <${Menu} anchor=${listMenu.anchor} title="List options" items=${listMenuItems()}
        onClose=${() => setListMenu(null)} />` : null}

    ${editing ? html`
      <${TimerModal} timer=${editing === 'new' ? null : editing} taskCodes=${taskCodes} groups=${groups}
        lifecycle=${editing === 'new' ? null : {
          index: timers.findIndex((t) => t.id === editing.id),
          count: timers.length,
          clockHours: fmtTenths(liveElapsed(editing), roundMode),
          onSetClock: (h) => guard(clockSet(editing, h)),
          onMove: (dir) => guard(nudgeOrder(editing, dir)),
          onDuplicate: () => { setEditing(null); guard(duplicate(editing)); },
          onTogglePin: () => guard(api.patch(`/api/timers/${editing.id}`, { pinned: editing.pinned ? 0 : 1 }).then(reload)),
          onFresh: () => { setEditing(null); guard(fresh(editing)); },
          onDelete: () => { setEditing(null); setDeleting(editing); },
        }}
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
      <${Confirm} title=${deleting.ids ? `Delete ${deleting.ids.length} timers` : 'Delete timer'}
        danger confirmLabel="Delete"
        message=${deleting.ids
          ? `Delete these ${deleting.ids.length} timer buttons — ${deleting.names.join(', ')}? Entries they already created are kept.`
          : `Delete the "${deleting.name}" button? Entries it already created are kept.`}
        onConfirm=${async () => {
          if (deleting.ids) await api.post('/api/timers/batch-delete', { ids: deleting.ids });
          else await api.del(`/api/timers/${deleting.id}`);
          exitSelectMode();
          await reload();
        }}
        onClose=${() => setDeleting(null)} />` : null}

    ${deletingEntry ? html`
      <${Confirm} title="Delete entry" danger confirmLabel="Delete"
        message=${`Delete this ${fmtHours(deletingEntry.total)}h entry${deletingEntry.cm ? ` for ${deletingEntry.cm.short_name}` : ''}? You'll have a few seconds to undo from the toast.`}
        onConfirm=${() => guard(deleteEntry(deletingEntry))}
        onClose=${() => setDeletingEntry(null)} />` : null}

    ${stopPopup ? html`
      <${StopChips} popup=${stopPopup} openEditor=${openEditor}
        onClockDeduct=${(h) => guard(clockDelta(stopPopup.timer, -h))}
        onFiled=${() => { setStopPopup(null); onEntryChanged(); reload(); }}
        onClose=${(changed) => { setStopPopup(null); if (changed) onEntryChanged(); reload(); }} />` : null}
  `;
}

// ---------- one row of today's work ----------

function WorkRow({
  row, secs, idleAfter, roundMode, canDrag = true, dragging = false,
  selectMode = false, selected = false, tabbable = false, writing = false,
  expanded = false, onToggleExpand,
  onFocusRow, onSelect, onToggleSelected, onStart, onStop, onSet, onSetHours, onRename, onMenu, menuOpen = false,
  onOpenEntry, onAssignMatter, onEntryChanged, onWritingDone,
  onDragStart, onDragEnd, onDragOverRow, onDropOn,
}) {
  const { timer } = row;
  const entries = row.entries || [];
  const entry = row.focus || null;          // the entry this row speaks for
  const [editKind, setEditKind] = useState(null); // null | 'clock' | 'hours'
  const [clockText, setClockText] = useState('');
  const [editingName, setEditingName] = useState(false);
  const [nameText, setNameText] = useState('');
  const running = !!(timer && timer.running);
  const idle = running && secs > idleAfter;

  // The timer's own clock, in decimal hours — what a stop would file.
  const tenths = timer ? Number(fmtTenths(secs, roundMode)) : null;
  // TODAY'S RECORD ON THIS MATTER, and only the record.
  //
  // It used to add the running timer's unfiled clock, which is how Today came
  // to report "Acme — merger 2.7" while the ledger held the same work as 2.6
  // and 0.0 and the figure 2.7 appeared nowhere in the data (wave-1 review,
  // D8). The unfiled time IS the clock, it is beside this figure while it runs,
  // and this figure catches up the instant the timer stops and files.
  const filed = entries.reduce((a, e) => a + e.total, 0);

  // accumulated time today (elapsed > 0 or an entry) vs still-at-zero
  const worked = entries.length > 0 || secs > 0;
  const draft = !!entry && entry.status === 'draft';
  const needsNarrative = draft && !(entry.narrative || '').trim() && !running;
  const noMatter = timer ? !timer.cm_id : !(entry && entry.cm);
  // A finalized entry with no timer has nothing to start — say so rather than
  // firing a request that will 4xx.
  const canStart = !!timer || draft;

  function commitClock() {
    const kind = editKind;
    setEditKind(null);
    const h = Number(clockText);
    if (!Number.isFinite(h) || h < 0) return;
    const v = Math.round(h * 10) / 10;
    if (kind === 'hours') onSetHours(v); else onSet(v);
  }

  // The ± pills edit the FIELD, not the record — one write on commit, so a
  // run of taps is one request and Escape still abandons the whole thing.
  function nudgeText(d) {
    const cur = Number(clockText);
    const next = Math.max(0, Math.round(((Number.isFinite(cur) ? cur : 0) + d) * 10) / 10);
    setClockText(next.toFixed(1));
  }

  function commitName() {
    setEditingName(false);
    const v = nameText.trim();
    if (v && v !== timer.name) onRename(v);
  }

  const name = timer ? timer.name : (entry && entry.cm ? entry.cm.short_name : 'No matter yet');
  const cmNumber = timer ? timer.cm_number : entry?.cm?.cm_number;
  const cmName = timer ? timer.cm_short_name : entry?.cm?.short_name;

  const rowTitle = timer
    ? (timer.cm_id
      ? `${timer.name} — ${timer.cm_short_name} · ${timer.cm_number}${timer.task_code ? ` · ${timer.task_code}` : ''} — ${fmtClock(secs)} elapsed`
      : `${timer.name} — no matter yet (time files to an unassociated entry) — ${fmtClock(secs)} elapsed`)
    : `${name} — recorded without a timer`;

  // An inline edit is open, so the row must NOT be draggable: a draggable
  // ancestor swallows the mousedown-drag that selects text inside an input.
  const editingText = editingName || !!editKind;
  const draggable = canDrag && !editingText;

  // ONE NUMBER PER ROW.
  //
  // The wave critic: «"1.7 clock 0.0" is two numbers where one is always
  // zero.» Both were true, which is why the previous pass kept them — but a
  // resting row does not need to answer a question nobody asked, and a decimal
  // pair with no header is unreadable at a glance whatever the labels say. So:
  //
  //   ONE decimal figure at rest, and it is the day's RECORD on this matter.
  //   Where the row has a timer and no separate record — the ordinary case,
  //   because the timer filed the entry — that figure IS the clock, and it
  //   edits the clock, as it always did.
  //   THE LIVE CLOCK appears only while the clock is actually running, in
  //   HH:MM:SS, which can never be mistaken for a decimal.
  //   THE DECIMAL CLOCK, on the one row shape where it has parted company with
  //   the record, moves into the row's expanded half — labelled, tap-editable,
  //   and also in Edit timer → "Clock now". It is demoted in the surface, not
  //   out of reach.
  const diverged = entries.length > 0 && (!timer || Math.abs(filed - tenths) >= 0.05);
  // The figure is the CLOCK (and edits the clock) when the row is a timer whose
  // record has not parted company with it; otherwise it is the record.
  const figureIsClock = !!timer && !running && !diverged;
  // A record of 0.0 beside a ticking counter is the same defect in another
  // costume: while a timer runs with nothing else filed on the matter, the
  // clock is the row's one number.
  const showRecord = !running || filed > 0;
  // Only a divergent, stopped timer has a second true figure to hide.
  const extraClock = !!timer && !running && diverged;

  const stateClass = running ? ' running' : needsNarrative ? ' needs-narrative' : worked ? ' worked' : '';

  // A running timer's own entry is not "missing" a narrative — it is work in
  // progress, and the server agrees (it is excluded from the attention
  // buckets for exactly this reason).
  const isLive = (e) => running && timer.linked_entry_id === e.id;

  const bodyContent = [];
  if (entries.length > 1) {
    // ONE MATTER, SEVERAL ENTRIES TODAY — one the timer filled, one keyed by
    // hand, an orphan a deleted timer left behind. The row stays one row and
    // shows them all, each behind its own hours, so nothing is hidden by the
    // merge and every narrative is still editable in place.
    for (const e of entries) {
      bodyContent.push(html`
        <div key=${`e${e.id}`} class="work-entry">
          <span class="work-entry-h mono" title=${`${fmtHours(e.total)}h on this entry`}>${fmtHours(e.total)}h</span>
          ${isLive(e) && !(e.narrative || '').trim()
            ? html`<span class="muted small">running — files at the next stop</span>`
            : html`<${InlineNarrative} entry=${e} onChanged=${onEntryChanged}
                autoEdit=${writing && (!row.focus || row.focus.id === e.id)} onDone=${onWritingDone} />`}
        </div>`);
    }
  } else if (entry && !(running && !(entry.narrative || '').trim())) {
    bodyContent.push(html`<${InlineNarrative} key="narr" entry=${entry} onChanged=${onEntryChanged}
      autoEdit=${writing} onDone=${onWritingDone} />`);
  } else if (worked && !entry) {
    bodyContent.push(html`<p key="hint" class="work-hint muted small">Time on the clock, nothing filed yet.</p>`);
  }
  // EVERY ROW OWES THE NARRATIVE SLOT A LINE.
  //
  // At comfortable density the slot is reserved whether or not there is a
  // narrative (timers.css), because a list whose rows grow only when they have
  // text is not a band: measured at 1440px before this, six rows came out 126,
  // 72, 79, 79, 47, 47 — a 2.68× spread, from rows with a narrative growing
  // while rows without stayed short. A reserved slot with nothing in it is a
  // hole, so the two states that used to leave `bodyContent` empty say what
  // they are instead. The running case cannot borrow the "nothing recorded"
  // wording: its time is on the clock and files at the next stop.
  if (bodyContent.length === 0) {
    bodyContent.push(running
      ? html`<p key="none" class="work-hint muted small">Running — files at the next stop.</p>`
      : html`<p key="none" class="work-hint muted small">Nothing recorded on this timer today.</p>`);
  }
  if (draft && !running) {
    const findings = entry.validation.filter((f) => f.code !== 'narrative_empty' && f.code !== 'no_matter');
    if (findings.length) bodyContent.push(html`<${ValidationList} key="valid" compact=${true} findings=${findings} />`);
  }
  // THE EXPANDED HALF: what the compact row leaves out. The task split and the
  // decimal clock on a row where the clock is not already the row's own figure.
  const extraContent = [];
  // (The "nothing recorded" line moved UP into `.work-body` above: a disclosure
  // that opens onto nothing is still a broken control, and the body is where
  // that sentence now lives on every density.)
  if (entry && entries.length === 1 && entry.tasks.length > 1) {
    extraContent.push(html`<div key="tasks" class="muted small work-tasks">
      ${entry.tasks.map((t) => `${t.task_code || '—'} ${fmtHours(t.duration)}`).join(' · ')}</div>`);
  }
  if (extraClock) {
    extraContent.push(html`
      <div key="clock" class="work-extra-clock">
        <span class="figure-tag">clock</span>
        <button class="timer-clock mono" tabIndex=${-1}
          title=${`${fmtClock(secs)} on this timer's clock — click to edit (decimal hours)`}
          onClick=${() => { setClockText(fmtTenths(secs, roundMode)); setEditKind('clock'); }}>
          ${fmtTenths(secs, roundMode)}
        </button>
        <span class="muted small">not filed yet</span>
      </div>`);
  }

  const bodyId = `wb-${row.key}`;

  return html`
    <div class=${'work-row' + (timer ? ' timer-row' : ' entry-row') + stateClass
      + (noMatter ? ' unassigned' : '') + (dragging ? ' dragging' : '') + (editingText ? ' editing' : '')
      + (selected ? ' selected' : '') + (expanded ? ' expanded' : '')}
      tabIndex=${tabbable ? 0 : -1}
      aria-expanded=${expanded ? 'true' : 'false'}
      data-row-key=${row.key}
      data-timer-id=${timer ? timer.id : undefined}
      data-entry-id=${entry ? entry.id : undefined}
      onFocus=${() => onFocusRow && onFocusRow()}
      ${/* A PLAIN CLICK ON THE ROW EXPANDS IT. That gesture used to do nothing
            visible at all (it cleared a multi-selection that was almost never
            set), so it is free — and a row that opens when you tap it is what
            every disclosure list in the reference set does. Ctrl/⌘ and Shift
            keep their multi-select meaning, and a tap that lands on a control
            is that control's. */''}
      onClickCapture=${(e) => {
        if (selectMode) return;
        if (onSelect && (e.ctrlKey || e.metaKey || e.shiftKey)) {
          e.preventDefault(); e.stopPropagation(); onSelect(e); return;
        }
        if (e.target.closest('button, input, select, textarea, a, label')) return;
        if (onSelect) onSelect(e);
        if (onToggleExpand) onToggleExpand();
      }}
      draggable=${draggable ? 'true' : 'false'}
      title=${rowTitle}
      onDragStart=${(e) => { if (!draggable) { e.preventDefault(); return; } e.dataTransfer.effectAllowed = 'move'; onDragStart(); }}
      onDragEnd=${() => onDragEnd && onDragEnd()}
      onDragOver=${(e) => { if (!canDrag) return; e.preventDefault(); e.stopPropagation(); if (onDragOverRow) onDragOverRow(); }}
      onDrop=${(e) => { if (!canDrag) return; e.preventDefault(); e.stopPropagation(); onDropOn(); }}
      ${/* A right-click has no trigger element to hang off, so it is the one
            caller that passes a point instead of an anchor. */''}
      onContextMenu=${(e) => { e.preventDefault(); onMenu({ x: e.clientX, y: e.clientY }); }}>

      ${/* LINE ONE IS IDENTITY — the matter and the exceptions that qualify it,
            and nothing else. It NEVER wraps: an ellipsis is a truncation you
            can see, while a wrap makes one row silently 40px taller than the
            one above it, which is how the phone list came to run 109–184px for
            six rows and clear only two of them above the fold. */''}
      <div class="work-main">
        ${selectMode ? html`
          <label class="work-pick"
            title=${timer ? `Select ${name}` : 'Only timers can be selected — the batch actions (move to group, pin, delete) are timer actions'}>
            <input type="checkbox" checked=${selected} disabled=${!timer}
              aria-label=${timer ? `Select ${name}` : `${name} cannot be selected`}
              onChange=${() => onToggleSelected && onToggleSelected()} />
          </label>` : null}
        ${editingName ? html`
          <input class="name-input" autoFocus value=${nameText}
            onInput=${(e) => setNameText(e.target.value)}
            onBlur=${commitName}
            onKeyDown=${(e) => { e.stopPropagation(); if (e.key === 'Enter') commitName(); if (e.key === 'Escape') setEditingName(false); }} />`
        : timer ? html`
          <button class="timer-name" tabIndex=${-1} title=${`${timer.name} — click to rename`}
            onClick=${() => { setNameText(timer.name); setEditingName(true); }}>${timer.name}</button>`
        : html`
          <button class="timer-name entry-open" tabIndex=${-1} title="Open this entry"
            onClick=${onOpenEntry}>${name}</button>`}
        ${cmNumber ? html`<span class="work-cm muted mono small" title=${cmName}>${cmNumber}</span>` : null}
        ${entry && !entry.billable ? html`<${BillableBadge} billable=${0} />` : null}
        ${entry && entry.status !== 'draft' ? html`<${StatusChip} entry=${entry} />` : null}
        ${entry && entry.exported_at ? html`
          <span class="chip chip-exported" title=${'Exported ' + fmtStamp(entry.exported_at)}>
            <${Icon} name="export" size=${12} /> exported</span>` : null}
        ${needsNarrative ? html`
          <span class="chip chip-todo" title="This entry cannot be finalized until it has a billing narrative">
            no narrative</span>` : null}
        ${/* "ASSIGN MATTER" IS AN IDENTITY DEFECT, SO IT LIVES ON THE IDENTITY
              LINE. It used to sit first in the control strip, and it was the
              one thing on any row that changed the strip's WIDTH: measured at
              1440px, `.work-controls` came out 303px on five rows and 410.8px
              on the quick-timer row, which pushed that row's Start 108px left
              of the column the other five share (left edges 1055, 1052, 1052,
              1052, **944**, 1052). Harvest's day view holds one dead-straight
              Start column — that is what lets an eye run a list without
              re-finding the button on every row — and a trailing cluster whose
              width is row state cannot hold one.
              Here it is beside the matter it is missing, in the same dashed
              attention dress as `Write narrative`: the row's two "this cannot
              be filed yet" blockers now look like one family and neither one
              is in the control column. */''}
        ${noMatter ? html`
          <button class="btn btn-sm work-assign" tabIndex=${-1}
            title="Assign a client/matter — required before this time can finalize or export"
            onClick=${onAssignMatter}>Assign matter</button>` : null}
        ${idle ? html`<span class="timer-flag idle-nudge" title="Running a long time — still working?"><${Icon} name="alert" size=${12} /></span>` : null}
        ${timer && timer.pinned ? html`
          <span class="timer-flag pinned" title="Pinned to the always-on-top float window">
            <${Icon} name="pin" size=${12} /></span>` : null}
      </div>

      ${/* LINE TWO IS THE CONTROL STRIP — transport, the day's one figure, the
            disclosure, the overflow, in that order on every row, so a thumb
            learns one place and finds it there whatever state the row is in. */''}
      <div class="work-controls">
        ${running ? html`
          <button class="btn btn-sm work-toggle timer-stop-btn" tabIndex=${-1} title="Stop & file time"
            onClick=${onStop}><${Icon} name="stop" size=${15} /><span class="work-toggle-label">Stop</span></button>` : html`
          <button class="btn btn-sm work-toggle timer-start-btn" tabIndex=${-1}
            title=${canStart ? 'Start' : 'Finalized — unlock this entry before recording more time against it'}
            disabled=${!canStart} onClick=${onStart}>
            <${Icon} name="play" size=${15} /><span class="work-toggle-label">Start</span></button>`}

        ${/* THE ROW'S ONE NUMBER. Every figure here stays tap-editable, with
              the ±0.1 pills beside the field while it is open — Harvest's
              quick-add duration pills
              (shots/refs-v2/harvest-new-time-entry.mobile.jpg) — which is what
              replaced the four ±0.1/±0.2 rows in the ⋯ menu. */''}
        <div class=${'work-figures' + (editKind ? ' editing-figure' : '')}>
          ${editKind ? html`
            <span class="figure-edit">
              <button class="btn btn-sm figure-step" tabIndex=${-1} title="−0.1 h (6 min)"
                onClick=${() => nudgeText(-0.1)}>−</button>
              <input class="clock-input mono" autoFocus value=${clockText} inputMode="decimal"
                aria-label=${editKind === 'clock' ? 'Clock, decimal hours' : 'Recorded hours'}
                onInput=${(e) => setClockText(e.target.value)}
                onBlur=${commitClock}
                onKeyDown=${(e) => { e.stopPropagation(); if (e.key === 'Enter') commitClock(); if (e.key === 'Escape') setEditKind(null); }} />
              <button class="btn btn-sm figure-step" tabIndex=${-1} title="+0.1 h (6 min)"
                onClick=${() => nudgeText(0.1)}>+</button>
            </span>` : html`
            <span class="timer-clock-pair">
              ${timer && running ? html`
                <button class="timer-clock-raw mono" tabIndex=${-1}
                  title=${`${fmtClock(secs)} on the clock — click to edit (decimal hours)`}
                  onClick=${() => { setClockText(fmtTenths(secs, roundMode)); setEditKind('clock'); }}>
                  ${fmtClock(secs)}
                </button>` : null}
              ${figureIsClock ? html`
                <button class=${'timer-clock mono' + (secs ? '' : ' zero')} tabIndex=${-1}
                  title=${`${fmtClock(secs)} elapsed — click to edit (decimal hours)`}
                  onClick=${() => { setClockText(fmtTenths(secs, roundMode)); setEditKind('clock'); }}>
                  ${fmtTenths(secs, roundMode)}
                </button>`
              : showRecord ? html`
                <button class="work-hours mono" tabIndex=${-1}
                  title=${`${fmtHours(filed)}h recorded on this matter today — click to edit`}
                  onClick=${() => { setClockText(fmtHours(entry ? entry.total : filed)); setEditKind('hours'); }}>
                  ${fmtHours(filed)}
                </button>` : null}
            </span>`}
        </div>

        ${/* THE DISCLOSURE. 44×44 under a thumb, `aria-expanded` +
              `aria-controls` so a screen reader is told what it opens, and the
              same state the row itself reports. `x` does it from the keyboard;
              a plain click on the row does it with a thumb anywhere. */''}
        <button class="btn btn-ghost btn-sm work-expand" tabIndex=${-1}
          aria-expanded=${expanded ? 'true' : 'false'} aria-controls=${bodyId}
          title=${expanded ? 'Hide the narrative and the details (x)' : 'Show the narrative and the details (x)'}
          aria-label=${`${expanded ? 'Collapse' : 'Expand'} — ${name}`}
          onClick=${() => onToggleExpand && onToggleExpand()}>
          <${Icon} name=${expanded ? 'chevronUp' : 'chevronDown'} size=${16} />
        </button>

        ${/* ONE NAME FOR ONE MENU. Two visually identical rows used to say
              "Timer menu" and "Entry menu" and open two different item lists —
              the wave-1 review's D7. The menu is state-driven now, so the
              trigger names the ROW rather than promising a menu shape, and the
              element itself is handed over: it is what the popover hangs off
              and what focus returns to. */''}
        <button class="btn btn-ghost btn-sm timer-more" tabIndex=${-1}
          title="Row menu" aria-label=${`Row menu — ${name}`}
          ...${menuTriggerProps(menuOpen)}
          onClick=${(e) => onMenu({ anchor: e.currentTarget })}>
          <${Icon} name="more" size=${15} />
        </button>
      </div>

      ${/* THE EXPANDABLE HALF. `.work-body` is the narrative and the findings —
            hidden at compact density, shown at comfortable, and shown at either
            once the row is expanded. `.work-extra` is the task split and the
            decimal clock, which only an expanded row shows. Both are collapsed
            with `display: none` rather than a zero height, so a keyboard never
            walks into content that is not on screen. */''}
      <div class="work-body" id=${bodyId}>${bodyContent}</div>
      ${extraContent.length ? html`<div class="work-extra">${extraContent}</div>` : null}
    </div>`;
}

// ---------- modals ----------

// THE EDIT-TIMER DIALOG — and the home of everything the row menu used to
// carry about the timer itself (wave-2, see rowMenuItems above).
//
// Six rows left the row menu for this dialog: Duplicate, Move up, Move down,
// Pin to float window, New entry (zero clock) and Delete. They were 28px-tall
// popover rows; here they are real controls in the dialog that already owned
// the timer's name, matter, task code, group and template, and at phone width
// the shared overlay makes it a bottom sheet where base.css gives every one of
// them a 44×44 box. `Move up/down` reports the timer's position rather than
// asking the reader to watch a list they cannot see behind the scrim.
function TimerModal({ timer, taskCodes, groups, lifecycle = null, onDone, onClose }) {
  const [name, setName] = useState(timer ? timer.name : '');
  const [cm, setCm] = useState(timer && timer.cm_id
    ? { id: timer.cm_id, cm_number: timer.cm_number, short_name: timer.cm_short_name } : null);
  const [taskCode, setTaskCode] = useState(timer ? (timer.task_code || '') : '');
  const [groupId, setGroupId] = useState(timer ? (timer.group_id ?? '') : '');
  const [template, setTemplate] = useState(timer ? (timer.narrative_template || '') : '');
  const [error, setError] = useState(null);
  // The list behind the scrim is inert, so this dialog reports its own state
  // rather than relying on the reader seeing the effect.
  const [pos, setPos] = useState(lifecycle ? lifecycle.index : 0);
  const [pinned, setPinned] = useState(timer ? !!timer.pinned : false);
  // THE CLOCK, AS A FIELD. On a 390px row the decimal clock and the day's
  // record cannot both be touch-sized figures, so where they disagree the row
  // states the record (timers.css) — and this is the clock's touch path, which
  // it did not have at that width before.
  const [clock, setClock] = useState(lifecycle ? String(lifecycle.clockHours) : '');

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
      if (lifecycle && clock.trim() !== '' && Number(clock) !== Number(lifecycle.clockHours)) {
        const h = Number(clock);
        if (Number.isFinite(h) && h >= 0) await lifecycle.onSetClock(Math.round(h * 10) / 10);
      }
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
        ${lifecycle ? html`
          <div class="timer-lifecycle">
            <h4 class="timer-lifecycle-head">This timer</h4>
            <div class="timer-lifecycle-row">
              <label class="timer-lifecycle-clock">
                <span class="muted small">Clock now (decimal hours)</span>
                <input type="number" step="0.1" min="0" inputMode="decimal" value=${clock}
                  onInput=${(e) => setClock(e.target.value)} />
              </label>
            </div>
            <div class="timer-lifecycle-row">
              <span class="muted small">Position in the list</span>
              <span class="timer-lifecycle-pos mono">${pos + 1} of ${lifecycle.count}</span>
              <button type="button" class="btn btn-sm" disabled=${pos <= 0}
                title="Move up in the list"
                onClick=${() => { lifecycle.onMove(-1); setPos((p) => Math.max(0, p - 1)); }}>
                <${Icon} name="chevronUp" size=${15} /> Up</button>
              <button type="button" class="btn btn-sm" disabled=${pos >= lifecycle.count - 1}
                title="Move down in the list"
                onClick=${() => { lifecycle.onMove(1); setPos((p) => Math.min(lifecycle.count - 1, p + 1)); }}>
                <${Icon} name="chevronDown" size=${15} /> Down</button>
            </div>
            <div class="timer-lifecycle-row">
              <button type="button" class="btn btn-sm" title="Make a copy of this timer"
                onClick=${lifecycle.onDuplicate}><${Icon} name="copy" size=${15} /> Duplicate</button>
              <button type="button" class="btn btn-sm"
                title=${pinned ? 'Stop showing this timer in the always-on-top float window'
                  : 'Always show this timer in the always-on-top float window'}
                onClick=${() => { lifecycle.onTogglePin(); setPinned((p) => !p); }}>
                <${Icon} name="pin" size=${15} /> ${pinned ? 'Unpin from float window' : 'Pin to float window'}</button>
              <button type="button" class="btn btn-sm"
                title="Zero the clock and keep today’s entry — the next stop files a new one"
                onClick=${lifecycle.onFresh}><${Icon} name="refresh" size=${15} /> New entry (zero clock)</button>
              <button type="button" class="btn btn-sm timer-lifecycle-delete" title="Delete this timer button (entries it created are kept)"
                onClick=${lifecycle.onDelete}><${Icon} name="trash" size=${15} /> Delete timer</button>
            </div>
          </div>` : null}
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
