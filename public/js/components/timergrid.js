import { api } from '/js/api.js';
import {
  html, useState, useEffect, useRef, useCallback,
  fmtClock, fmtTenths, emitToast, Modal, Confirm, ContextMenu, Field, Icon, clientLabel,
} from '/js/ui.js';
import { CmPicker } from '/js/components/cmpicker.js';
import { TimerImport } from '/js/components/timerimport.js';
import { StopChips } from '/js/components/stopchips.js';

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

  // Keyboard focus model (spec §4): ONE focused timer via roving tabindex.
  const [focusId, setFocusId] = useState(null);

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
    const tick = setInterval(() => forceTick((x) => x + 1), 1000);
    return () => { clearInterval(poll); clearInterval(tick); };
  }, [reload]);

  const liveElapsed = useCallback((t) => {
    let s = t.elapsed_seconds;
    if (t.running) s += (Date.now() - fetchedAt) / 1000;
    return Math.floor(s);
  }, [fetchedAt]);

  // ---------- actions ----------

  const guard = (p) => p.catch((e) => emitToast(e.message, { error: true }));

  const start = useCallback(async (timer, opts = {}) => {
    const r = await api.post(`/api/timers/${timer.id}/start`, opts);
    localStorage.setItem('tk:lastTimer', String(timer.id));
    if (r.warning) emitToast(`⏱ ${r.warning}`);
    await reload();
  }, [reload]);

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

  const fresh = useCallback(async (timer) => {
    await api.post(`/api/timers/${timer.id}/fresh`);
    emitToast('Clock zeroed — next stop files a new entry. Today’s entry kept.');
    await reload();
  }, [reload]);

  const duplicate = useCallback(async (timer) => {
    await api.post(`/api/timers/${timer.id}/duplicate`);
    await reload();
  }, [reload]);

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

  if (!timers) return null;
  const idleAfter = (settings.idleNudgeHours ?? 3) * 3600;
  const hasGroups = groups.length > 0;
  const byGroupMode = grouping === 'group';

  let sections; // [{ key, group, label, list }] — group is non-null only in by-group mode
  if (grouping === 'client') {
    const byClient = new Map();
    for (const t of timers) {
      const key = t.client_id ?? 'none';
      if (!byClient.has(key)) {
        byClient.set(key, { key: `client-${key}`, group: null, label: clientLabel(t) || 'No client', list: [] });
      }
      byClient.get(key).list.push(t);
    }
    sections = [...byClient.values()].sort((a, b) =>
      a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }));
  } else if (grouping === 'flat') {
    sections = [{ key: 'flat', group: null, label: null, list: timers }];
  } else {
    sections = [
      ...groups.map((g) => ({ key: `group-${g.id}`, group: g, label: g.name, list: timers.filter((t) => t.group_id === g.id) })),
      { key: 'ungrouped', group: null, label: null, list: timers.filter((t) => t.group_id == null) },
    ];
  }

  // ordered list of cards actually on screen (collapse-aware); the roving
  // tabindex + arrow keys walk this list. Task 9 filters it further.
  const visible = sections.flatMap((sec) =>
    (byGroupMode && sec.group && sec.group.collapsed) ? [] : sec.list);
  const tabbableId = visible.some((t) => t.id === focusId) ? focusId : (visible[0] && visible[0].id);

  const focusCard = (id) => {
    setFocusId(id);
    requestAnimationFrame(() => {
      document.querySelector(`.timer-card[data-timer-id="${id}"]`)?.focus();
    });
  };

  // Keys for the focused card. Every command is a NON-PRINTABLE chord —
  // printable characters are reserved for type-to-filter (spec §4).
  // stopPropagation keeps these away from the app-level shortcuts (n/t/g/…).
  function onBoardKey(e) {
    const tag = (e.target.tagName || '').toLowerCase();
    if (['input', 'textarea', 'select'].includes(tag)) return; // in-card clock editing etc.
    const list = visible;
    if (list.length === 0) return;
    const idx = Math.max(0, list.findIndex((t) => t.id === focusId));
    const cur = list[idx];
    const done = () => { e.preventDefault(); e.stopPropagation(); };

    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      const step = (e.shiftKey ? 0.2 : 0.1) * (e.key === 'ArrowUp' ? 1 : -1);
      guard(clockDelta(cur, step));
      return done();
    }
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { focusCard(list[Math.min(idx + 1, list.length - 1)].id); return done(); }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { focusCard(list[Math.max(idx - 1, 0)].id); return done(); }
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
      <button class="btn btn-sm" title="Sort by CM name within groups" onClick=${() => guard(sortAZ())}>
        <${Icon} name="sortAZ" size=${16} /> A–Z
      </button>
      <button class="btn btn-sm" onClick=${() => setGroupModal('new')}>
        <${Icon} name="folder" size=${16} /> New group
      </button>
      <button class="btn btn-sm" title="Batch-create timers from a CSV" onClick=${() => setImporting(true)}>
        <${Icon} name="download" size=${16} /> Import
      </button>
      <button class="btn btn-sm btn-primary" onClick=${() => setEditing('new')}>
        <${Icon} name="plus" size=${16} /> New timer
      </button>
    </div>
    <div class="timer-board" tabIndex=${-1} onKeyDown=${onBoardKey}>

    ${sections.map((sec) => {
      const { group, list } = sec;
      if (byGroupMode && !group && list.length === 0 && hasGroups) return null;
      const collapsed = byGroupMode && group && group.collapsed;
      const showHead = byGroupMode ? (group || hasGroups) : grouping === 'client';
      return html`
        <div key=${sec.key} class="timer-section"
          onDragOver=${byGroupMode ? (e) => e.preventDefault() : undefined}
          onDrop=${byGroupMode ? (e) => { e.preventDefault(); guard(dropOn({ kind: 'group', groupId: group ? group.id : null })); } : undefined}>
          ${showHead ? html`
            <div class="group-head">
              ${group ? html`
                <button class="btn btn-ghost btn-sm" title=${collapsed ? 'Expand' : 'Collapse'}
                  onClick=${() => guard(api.patch(`/api/timer-groups/${group.id}`, { collapsed: collapsed ? 0 : 1 }).then(reload))}>
                  <${Icon} name=${collapsed ? 'chevronRight' : 'chevronDown'} size=${16} />
                </button>
                <span class="group-name">${group.name}</span>
                <span class="muted small">${list.length}</span>
                <span class="group-tools">
                  <button class="btn btn-ghost btn-sm" title="Rename group" onClick=${() => setGroupModal(group)}>
                    <${Icon} name="edit" size=${14} /></button>
                  <button class="btn btn-ghost btn-sm" title="Delete group (timers kept)"
                    onClick=${() => guard(api.del(`/api/timer-groups/${group.id}`).then(reload))}>
                    <${Icon} name="trash" size=${14} /></button>
                </span>` : sec.label != null ? html`
                <span class="group-name">${sec.label}</span>
                <span class="muted small">${list.length}</span>` : html`
                <span class="group-name muted">Ungrouped</span>
                <span class="muted small">${list.length}</span>`}
            </div>` : null}
          ${collapsed ? null : html`
            <div class="timer-grid">
              ${list.map((t) => html`
                <${TimerCard} key=${t.id} timer=${t} secs=${liveElapsed(t)} idleAfter=${idleAfter}
                  canDrag=${byGroupMode}
                  tabbable=${tabbableId === t.id} onFocusCard=${() => setFocusId(t.id)}
                  roundMode=${settings.rounding?.enabled === false ? 'nearest' : (settings.rounding?.mode || 'up')}
                  onStart=${() => guard(start(t))} onStop=${() => guard(stop(t))}
                  onDelta=${(d) => guard(clockDelta(t, d))} onSet=${(h) => guard(clockSet(t, h))}
                  onMenu=${(x, y) => setMenu({ x, y, timer: t })}
                  onDragStart=${() => { dragId.current = t.id; }}
                  onDropOn=${() => guard(dropOn({ kind: 'timer', timer: t }))} />`)}
              ${byGroupMode && list.length === 0 ? html`<div class="muted small" style=${{ padding: '8px' }}>Drop timers here</div>` : null}
            </div>`}
        </div>`;
    })}
    ${timers.length === 0 ? html`
      <button class="timer-new" onClick=${() => setEditing('new')}>
        <${Icon} name="plus" /> Create your first timer
      </button>` : null}
    </div>

    ${menu ? html`
      <${ContextMenu} x=${menu.x} y=${menu.y} items=${menuItems(menu.timer)} onClose=${() => setMenu(null)} />` : null}

    ${editing ? html`
      <${TimerModal} timer=${editing === 'new' ? null : editing} taskCodes=${taskCodes} groups=${groups}
        onDone=${async () => { setEditing(null); await reload(); }}
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

function TimerCard({ timer, secs, idleAfter, roundMode, canDrag = true, tabbable = false, onFocusCard, onStart, onStop, onDelta, onSet, onMenu, onDragStart, onDropOn }) {
  const [editingClock, setEditingClock] = useState(false);
  const [clockText, setClockText] = useState('');
  const idle = timer.running && secs > idleAfter;

  // Worked-today highlight (spec §4): accumulated time today (elapsed > 0 or
  // a linked entry) vs. still-at-zero — independent of .running / .idle-nudge.
  const worked = !!timer.linked_entry_id || secs > 0;

  function commitClock() {
    setEditingClock(false);
    const h = Number(clockText);
    if (Number.isFinite(h) && h >= 0) onSet(Math.round(h * 10) / 10);
  }

  return html`
    <div class=${'timer-card' + (timer.running ? ' running' : '') + (worked ? ' worked' : '')}
      tabIndex=${tabbable ? 0 : -1}
      data-timer-id=${timer.id}
      onFocus=${() => onFocusCard && onFocusCard()}
      draggable=${canDrag ? 'true' : 'false'}
      title=${`${timer.name} — ${fmtClock(secs)} elapsed`}
      onDragStart=${(e) => { if (!canDrag) { e.preventDefault(); return; } e.dataTransfer.effectAllowed = 'move'; onDragStart(); }}
      onDragOver=${(e) => { if (!canDrag) return; e.preventDefault(); e.stopPropagation(); }}
      onDrop=${(e) => { if (!canDrag) return; e.preventDefault(); e.stopPropagation(); onDropOn(); }}
      onContextMenu=${(e) => { e.preventDefault(); onMenu(e.clientX, e.clientY); }}>
      <span class="timer-name" title=${timer.name}>${timer.name}</span>
      <span class="timer-cm" title=${`${timer.cm_short_name} · ${timer.cm_number}${timer.task_code ? ` · ${timer.task_code}` : ''}`}>
        ${timer.cm_short_name}${timer.task_code ? ` · ${timer.task_code}` : ''}
      </span>
      ${timer.linked_entry_id ? html`<span class="timer-flag" title="Linked to today’s entry"><${Icon} name="check" size=${12} /></span>` : null}
      ${idle ? html`<span class="timer-flag idle-nudge" title="Running a long time — still working?"><${Icon} name="alert" size=${12} /></span>` : null}
      ${editingClock ? html`
        <input class="clock-input mono" autoFocus value=${clockText} inputMode="decimal"
          onInput=${(e) => setClockText(e.target.value)}
          onBlur=${commitClock}
          onKeyDown=${(e) => { if (e.key === 'Enter') commitClock(); if (e.key === 'Escape') setEditingClock(false); }} />` : html`
        <button class="timer-clock mono" title=${`${fmtClock(secs)} elapsed — click to edit (decimal hours)`}
          onClick=${() => { setClockText(fmtTenths(secs, roundMode)); setEditingClock(true); }}>
          ${fmtTenths(secs, roundMode)}
        </button>`}
      ${timer.running
        ? html`<button class="btn btn-primary btn-sm" title="Stop & file time" onClick=${onStop}>
            <${Icon} name="stop" size=${15} /></button>`
        : html`<button class="btn btn-sm" title="Start" onClick=${onStart}>
            <${Icon} name="play" size=${15} /></button>`}
      <button class="btn btn-ghost btn-sm timer-more" title="Timer menu"
        onClick=${(e) => { const r = e.currentTarget.getBoundingClientRect(); onMenu(r.left, r.bottom + 2); }}>
        <${Icon} name="more" size=${15} />
      </button>
    </div>`;
}

// ---------- modals ----------

function TimerModal({ timer, taskCodes, groups, onDone, onClose }) {
  const [name, setName] = useState(timer ? timer.name : '');
  const [cm, setCm] = useState(timer ? { id: timer.cm_id, cm_number: timer.cm_number, short_name: timer.cm_short_name } : null);
  const [taskCode, setTaskCode] = useState(timer ? (timer.task_code || '') : '');
  const [groupId, setGroupId] = useState(timer ? (timer.group_id ?? '') : '');
  const [error, setError] = useState(null);

  async function save() {
    try {
      const body = {
        name, cm_id: cm.id, task_code: taskCode || null,
        group_id: groupId === '' ? null : Number(groupId),
      };
      if (timer) await api.patch(`/api/timers/${timer.id}`, body);
      else await api.post('/api/timers', body);
      onDone();
    } catch (err) { setError(err.message); }
  }

  return html`
    <${Modal} title=${timer ? 'Edit timer' : 'New timer'} onClose=${onClose}>
      <div class="grid">
        <${Field} label="Button name">
          <input type="text" value=${name} autoFocus placeholder="e.g. Acme — research"
            onInput=${(e) => setName(e.target.value)}
            onKeyDown=${(e) => { if (e.key === 'Enter' && name.trim() && cm) save(); }} />
        <//>
        <${Field} label="Client/Matter">
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
        ${error ? html`<div class="error-box">${error}</div>` : null}
        <div class="row-end">
          <button type="button" class="btn" onClick=${onClose}>Cancel</button>
          <button class="btn btn-primary" disabled=${!name.trim() || !cm} onClick=${save}>
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
