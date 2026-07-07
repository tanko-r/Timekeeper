import { api } from '/js/api.js';
import {
  html, useState, useEffect, useRef, useCallback,
  fmtClock, fmtHours, emitToast, Modal, Confirm, Field,
} from '/js/ui.js';
import { CmPicker } from '/js/components/cmpicker.js';

// Live timer grid. Server state is authoritative; we tick locally between polls.
export function TimerGrid({ settings, onEntryChanged, openEditor }) {
  const [timers, setTimers] = useState(null);
  const [fetchedAt, setFetchedAt] = useState(Date.now());
  const [, forceTick] = useState(0);
  const [editing, setEditing] = useState(null);   // timer | 'new'
  const [stopping, setStopping] = useState(null); // {timer, ctx}
  const [deleting, setDeleting] = useState(null);
  const [taskCodes, setTaskCodes] = useState([]);

  const reload = useCallback(async () => {
    const rows = await api.get('/api/timers');
    setTimers(rows);
    setFetchedAt(Date.now());
  }, []);

  useEffect(() => { reload().catch(() => {}); }, [reload]);
  useEffect(() => {
    api.get('/api/task-codes').then(setTaskCodes).catch(() => {});
  }, []);

  // poll every 5s; tick every 1s for running timers
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

  const start = useCallback(async (timer) => {
    const r = await api.post(`/api/timers/${timer.id}/start`);
    localStorage.setItem('tk:lastTimer', String(timer.id));
    if (r.warning) emitToast(`⚠️ ${r.warning}`);
    await reload();
  }, [reload]);

  const pause = useCallback(async (timer) => {
    await api.post(`/api/timers/${timer.id}/pause`);
    localStorage.setItem('tk:lastTimer', String(timer.id));
    await reload();
  }, [reload]);

  const beginStop = useCallback(async (timer) => {
    localStorage.setItem('tk:lastTimer', String(timer.id));
    const ctx = await api.get(`/api/timers/${timer.id}/stop-context`);
    if (ctx.hours_preview <= 0) {
      await api.post(`/api/timers/${timer.id}/stop`, { action: 'new' });
      emitToast('Under the minimum increment — time discarded, clock reset.');
      await reload();
      return;
    }
    const pref = settings.timerStopAction || 'ask';
    if (pref === 'new' || (pref === 'append' && ctx.todayDrafts.length === 0)) {
      await doStop(timer, 'new', null);
    } else if (pref === 'append' && ctx.todayDrafts.length > 0) {
      await doStop(timer, 'append', ctx.todayDrafts[0].id);
    } else {
      setStopping({ timer, ctx });
    }
  }, [settings, reload]); // eslint-disable-line

  async function doStop(timer, action, entryId, remember) {
    const r = await api.post(`/api/timers/${timer.id}/stop`, { action, entry_id: entryId || undefined });
    setStopping(null);
    if (remember) await api.patch('/api/settings', { timerStopAction: action });
    await reload();
    if (r.entry) {
      emitToast(`${fmtHours(r.hours)}h ${r.appended ? 'added to' : 'entered for'} ${r.entry.cm.short_name}`, {
        actionLabel: 'Edit', action: () => openEditor({ id: r.entry.id }),
      });
      onEntryChanged();
    }
  }

  // 't' shortcut: toggle last-used timer
  useEffect(() => {
    const onToggle = () => {
      if (!timers || timers.length === 0) return;
      const lastId = Number(localStorage.getItem('tk:lastTimer'));
      const timer = timers.find((t) => t.id === lastId) || timers[0];
      if (timer.running) beginStop(timer).catch((e) => emitToast(e.message, { error: true }));
      else start(timer).catch((e) => emitToast(e.message, { error: true }));
    };
    window.addEventListener('tk:toggle-last-timer', onToggle);
    return () => window.removeEventListener('tk:toggle-last-timer', onToggle);
  }, [timers, start, beginStop]);

  async function move(timer, dir) {
    const ids = timers.map((t) => t.id);
    const i = ids.indexOf(timer.id);
    const j = i + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    await api.put('/api/timers/order', { ids });
    await reload();
  }

  if (!timers) return null;
  const idleAfter = (settings.idleNudgeHours ?? 3) * 3600;

  return html`
    <div class="timer-grid">
      ${timers.map((t) => {
        const secs = liveElapsed(t);
        const idle = t.running && secs > idleAfter;
        return html`
          <div key=${t.id} class=${'timer-card' + (t.running ? ' running' : '')}>
            <div class="timer-tools">
              <button class="btn btn-ghost btn-sm" title="Move left" onClick=${() => move(t, -1)}>‹</button>
              <button class="btn btn-ghost btn-sm" title="Move right" onClick=${() => move(t, 1)}>›</button>
              <button class="btn btn-ghost btn-sm" title="Edit timer" onClick=${() => setEditing(t)}>✎</button>
              <button class="btn btn-ghost btn-sm" title="Delete timer" onClick=${() => setDeleting(t)}>🗑</button>
            </div>
            <div class="timer-name">${t.name}</div>
            <div class="timer-cm">${t.cm_short_name} · ${t.cm_number}${t.task_code ? ` · ${t.task_code}` : ''}</div>
            <div class="timer-clock">${fmtClock(secs)}</div>
            ${idle ? html`<div class="idle-nudge">⏰ running ${Math.floor(secs / 3600)}h — still working?</div>` : null}
            <div class="timer-actions">
              ${t.running
                ? html`
                  <button class="btn" onClick=${() => pause(t).catch((e) => emitToast(e.message, { error: true }))}>⏸ Pause</button>
                  <button class="btn btn-primary" onClick=${() => beginStop(t).catch((e) => emitToast(e.message, { error: true }))}>⏹ Stop</button>`
                : html`
                  <button class="btn btn-primary" onClick=${() => start(t).catch((e) => emitToast(e.message, { error: true }))}>▶ Start</button>
                  ${secs > 0 ? html`
                    <button class="btn" onClick=${() => beginStop(t).catch((e) => emitToast(e.message, { error: true }))}>⏹ Stop</button>` : null}`}
            </div>
          </div>`;
      })}
      <button class="timer-new" onClick=${() => setEditing('new')}>＋ New timer</button>
    </div>

    ${editing ? html`
      <${TimerModal} timer=${editing === 'new' ? null : editing} taskCodes=${taskCodes}
        onDone=${async () => { setEditing(null); await reload(); }}
        onClose=${() => setEditing(null)} />` : null}

    ${deleting ? html`
      <${Confirm} title="Delete timer" danger confirmLabel="Delete"
        message=${`Delete the "${deleting.name}" button? Entries it already created are kept.`}
        onConfirm=${async () => { await api.del(`/api/timers/${deleting.id}`); await reload(); }}
        onClose=${() => setDeleting(null)} />` : null}

    ${stopping ? html`
      <${StopModal} stopping=${stopping} onStop=${doStop} onClose=${() => setStopping(null)} />` : null}
  `;
}

function TimerModal({ timer, taskCodes, onDone, onClose }) {
  const [name, setName] = useState(timer ? timer.name : '');
  const [cm, setCm] = useState(timer ? { id: timer.cm_id, cm_number: timer.cm_number, short_name: timer.cm_short_name } : null);
  const [taskCode, setTaskCode] = useState(timer ? (timer.task_code || '') : '');
  const [error, setError] = useState(null);

  async function save(e) {
    e.preventDefault();
    try {
      const body = { name, cm_id: cm.id, task_code: taskCode || null };
      if (timer) await api.patch(`/api/timers/${timer.id}`, body);
      else await api.post('/api/timers', body);
      onDone();
    } catch (err) { setError(err.message); }
  }

  return html`
    <${Modal} title=${timer ? 'Edit timer' : 'New timer'} onClose=${onClose}>
      <form class="grid" onSubmit=${save}>
        <${Field} label="Button name">
          <input type="text" value=${name} autoFocus placeholder="e.g. Acme — research"
            onInput=${(e) => setName(e.target.value)} />
        <//>
        <${Field} label="Client/Matter">
          <${CmPicker} value=${cm} onChange=${setCm} />
        <//>
        <${Field} label="Default task code" hint="Applied to entries this timer creates">
          <select value=${taskCode} onChange=${(e) => setTaskCode(e.target.value)}>
            <option value="">(none)</option>
            ${taskCodes.map((c) => html`<option key=${c.id} value=${c.name}>${c.name}</option>`)}
          </select>
        <//>
        ${error ? html`<div class="error-box">${error}</div>` : null}
        <div class="row-end">
          <button type="button" class="btn" onClick=${onClose}>Cancel</button>
          <button class="btn btn-primary" disabled=${!name.trim() || !cm}>${timer ? 'Save' : 'Create'}</button>
        </div>
      </form>
    <//>`;
}

function StopModal({ stopping, onStop, onClose }) {
  const { timer, ctx } = stopping;
  const [remember, setRemember] = useState(false);
  const drafts = ctx.todayDrafts;

  return html`
    <${Modal} title=${`Stop "${timer.name}" — ${fmtHours(ctx.hours_preview)}h`} onClose=${onClose}>
      <p class="muted small">Where should this time go?</p>
      <div class="grid">
        <button class="btn btn-lg" onClick=${() => onStop(timer, 'new', null, remember)}>
          ➕ New entry for today
        </button>
        ${drafts.map((d) => html`
          <button key=${d.id} class="btn btn-lg" style=${{ justifyContent: 'flex-start', textAlign: 'left' }}
            onClick=${() => onStop(timer, 'append', d.id, remember)}>
            <div>
              <div>↳ Add as a task line to today’s draft (${fmtHours(d.total)}h so far)</div>
              <div class="muted small" style=${{ fontWeight: 400 }}>
                ${(d.narrative || '(no narrative yet)').slice(0, 90)}
              </div>
            </div>
          </button>`)}
      </div>
      <label class="checkbox-row" style=${{ marginTop: '12px' }}>
        <input type="checkbox" checked=${remember} onChange=${(e) => setRemember(e.target.checked)} />
        Always do this without asking
      </label>
    <//>`;
}
