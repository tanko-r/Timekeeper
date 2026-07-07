import { api } from '/js/api.js';
import {
  html, useState, useEffect, useRef, useCallback, useDebounced,
  Modal, Field, fmtHours, todayStr, emitToast, previewNarrative,
  BillableBadge, ValidationList, fmtStamp, Spinner,
} from '/js/ui.js';
import { CmPicker } from '/js/components/cmpicker.js';

const blankLine = () => ({ task_code: '', duration: 0, fragment: '' });

// Entry editor drawer. spec: {id} | {template:{date?,cm?}} | {copyFrom:id}
export function EntryEditor({ spec, settings, onClose }) {
  const [entry, setEntry] = useState(null);       // server copy (has id) or null for unsaved
  const [local, setLocal] = useState(null);       // editable state
  const [saveState, setSaveState] = useState('idle');
  const [gate, setGate] = useState(null);         // finalize 422 result
  const [audit, setAudit] = useState(null);
  const [taskCodes, setTaskCodes] = useState([]);
  const changedRef = useRef(false);
  const localRef = useRef(null);
  localRef.current = local;
  const entryRef = useRef(null);
  entryRef.current = entry;

  const increment = settings?.rounding?.increment || 0.1;

  useEffect(() => {
    api.get('/api/task-codes').then(setTaskCodes).catch(() => {});
  }, []);

  // load / create
  useEffect(() => {
    (async () => {
      try {
        if (spec.id) {
          const e = await api.get(`/api/entries/${spec.id}`);
          setEntry(e);
          setLocal(toLocal(e));
        } else if (spec.copyFrom) {
          const e = await api.post(`/api/entries/${spec.copyFrom}/copy`, { date: todayStr() });
          changedRef.current = true;
          emitToast('Entry copied — adjust the date if needed.');
          setEntry(e);
          setLocal(toLocal(e));
        } else {
          setLocal({
            date: spec.template.date || todayStr(),
            cm: spec.template.cm || null,
            billable: spec.template.cm ? !!spec.template.cm.billable : true,
            narrative: '',
            tasks: [blankLine()],
            status: 'draft',
            ack_validation: 0,
          });
        }
      } catch (e) {
        emitToast(e.message, { error: true });
        onClose(false);
      }
    })();
  }, []); // eslint-disable-line

  function toLocal(e) {
    return {
      date: e.date,
      cm: e.cm,
      billable: !!e.billable,
      narrative: e.narrative,
      tasks: e.tasks.length ? e.tasks.map((t) => ({ ...t })) : [blankLine()],
      status: e.status,
      ack_validation: e.ack_validation,
    };
  }

  const substantive = (local?.tasks || []).filter(
    (t) => (t.fragment || '').trim() || (t.task_code || '').trim() || Number(t.duration) > 0);
  const isAuto = substantive.length >= 2;
  const autoNarrative = isAuto ? previewNarrative(local.tasks, increment) : null;
  const sum = (local?.tasks || []).reduce((a, t) => a + (Number(t.duration) || 0), 0);
  const finalized = local?.status === 'finalized';

  // ---------- persistence ----------
  // Saves are chained through one promise so a debounced autosave and a
  // Save/Finalize click can never issue two concurrent creates (duplicate
  // entries) — and persist() resolves to the saved entry so callers don't
  // depend on a not-yet-re-rendered entryRef.

  const saveChain = useRef(Promise.resolve(null));

  const doPersist = useCallback(async () => {
    const l = localRef.current;
    const e = entryRef.current;
    if (!l || l.status === 'finalized') return e;
    if (!l.cm || !l.date) return e; // not enough to save yet
    const body = {
      date: l.date,
      cm_id: l.cm.id,
      billable: l.billable ? 1 : 0,
      narrative: l.narrative,
      tasks: l.tasks
        .filter((t) => (t.fragment || '').trim() || (t.task_code || '').trim() || Number(t.duration) > 0)
        .map((t) => ({ task_code: t.task_code, duration: Number(t.duration) || 0, fragment: t.fragment })),
    };
    setSaveState('saving');
    try {
      const saved = e
        ? await api.patch(`/api/entries/${e.id}`, body)
        : await api.post('/api/entries', body);
      changedRef.current = true;
      entryRef.current = saved; // immediately — callers use it before re-render
      setEntry(saved);
      setSaveState('saved');
      // adopt server-generated narrative + validation without clobbering typing
      setLocal((cur) => {
        if (!cur) return cur;
        const next = { ...cur };
        if (saved.narrative_auto) next.narrative = saved.narrative;
        return next;
      });
      return saved;
    } catch (err) {
      setSaveState('error');
      emitToast(err.message, { error: true });
      return entryRef.current;
    }
  }, []);

  const persist = useCallback(() => {
    saveChain.current = saveChain.current.then(doPersist, doPersist);
    return saveChain.current;
  }, [doPersist]);

  const [queueSave, cancelSave] = useDebounced(persist, 600);

  const update = useCallback((patch) => {
    setLocal((cur) => ({ ...cur, ...patch }));
    setGate(null);
    queueSave();
  }, [queueSave]);

  const updateLine = useCallback((i, patch) => {
    setLocal((cur) => {
      const tasks = cur.tasks.map((t, j) => (j === i ? { ...t, ...patch } : t));
      return { ...cur, tasks };
    });
    setGate(null);
    queueSave();
  }, [queueSave]);

  async function flushAndClose() {
    cancelSave();
    await persist();
    onClose(changedRef.current);
  }

  // Ctrl+Enter saves & closes; Esc closes (autosaved anyway)
  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        flushAndClose();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []); // eslint-disable-line

  // ---------- actions ----------

  async function finalize(ack) {
    cancelSave();
    const e = await persist();
    if (!e) { emitToast('Pick a CM and add time first.', { error: true }); return; }
    try {
      await api.post(`/api/entries/${e.id}/finalize`, ack ? { ack: true } : {});
      changedRef.current = true;
      emitToast('Finalized', {
        actionLabel: 'Unlock',
        action: async () => { await api.post(`/api/entries/${e.id}/unlock`); },
      });
      onClose(true);
    } catch (err) {
      if (err.status === 422) setGate(err.body);
      else emitToast(err.message, { error: true });
    }
  }

  async function unlock() {
    const e = entryRef.current;
    await api.post(`/api/entries/${e.id}/unlock`);
    changedRef.current = true;
    const fresh = await api.get(`/api/entries/${e.id}`);
    setEntry(fresh);
    setLocal(toLocal(fresh));
    emitToast('Unlocked — edits are audit-logged.');
  }

  async function del() {
    const e = entryRef.current;
    cancelSave();
    if (e) {
      await api.del(`/api/entries/${e.id}`);
      emitToast('Entry deleted', {
        actionLabel: 'Undo',
        action: async () => { await api.post(`/api/entries/${e.id}/restore`); },
      });
    }
    onClose(true);
  }

  async function loadAudit() {
    const e = entryRef.current;
    if (!e) return;
    setAudit(await api.get(`/api/entries/${e.id}/audit`));
  }

  // ---------- render ----------

  if (!local) {
    return html`<${Modal} title="Time entry" onClose=${() => onClose(changedRef.current)} wide=${true}><${Spinner} /><//>`;
  }

  const validation = entry ? entry.validation : [];

  return html`
    <${Modal} wide=${true} onClose=${flushAndClose}
      title=${finalized ? 'Time entry (finalized)' : entry ? 'Edit time entry' : 'New time entry'}>
      <div class="grid" style=${{ gridTemplateColumns: '150px 1fr auto', alignItems: 'end' }}>
        <${Field} label="Date">
          <input type="date" value=${local.date} disabled=${finalized}
            onChange=${(e) => update({ date: e.target.value })} />
        <//>
        <${Field} label="Client/Matter">
          <${CmPicker} value=${local.cm} autoFocus=${!local.cm}
            onChange=${(cm) => update({ cm, billable: !!cm.billable })} />
        <//>
        <label class="checkbox-row" style=${{ paddingBottom: '8px' }}>
          <input type="checkbox" checked=${local.billable} disabled=${finalized}
            onChange=${(e) => update({ billable: e.target.checked })} />
          Billable
        </label>
      </div>

      <div class="section-title"><h3 style=${{ margin: 0 }}>Task lines</h3>
        <span class="muted small">code · hours · what you did</span></div>
      <div class="task-lines">
        ${local.tasks.map((t, i) => html`
          <div key=${i} class="task-line">
            <select value=${t.task_code} disabled=${finalized}
              onChange=${(e) => updateLine(i, { task_code: e.target.value })}>
              <option value="">(task)</option>
              ${taskCodes.map((c) => html`<option key=${c.id} value=${c.name}>${c.name}</option>`)}
              ${t.task_code && !taskCodes.some((c) => c.name === t.task_code)
                ? html`<option value=${t.task_code}>${t.task_code}</option>` : null}
            </select>
            <input type="number" min="0" step=${increment} value=${t.duration || ''}
              placeholder="0.0" disabled=${finalized} class="mono"
              onInput=${(e) => updateLine(i, { duration: e.target.value })} />
            <input type="text" value=${t.fragment} placeholder=${isAuto ? 'narrative fragment for this task' : 'optional fragment (used if you add more lines)'}
              disabled=${finalized}
              onInput=${(e) => updateLine(i, { fragment: e.target.value })} />
            <div class="row" style=${{ flexWrap: 'nowrap', gap: '2px' }}>
              <div class="reorder">
                <button type="button" title="Move up" disabled=${finalized || i === 0}
                  onClick=${() => update({ tasks: swap(local.tasks, i, i - 1) })}>▲</button>
                <button type="button" title="Move down" disabled=${finalized || i === local.tasks.length - 1}
                  onClick=${() => update({ tasks: swap(local.tasks, i, i + 1) })}>▼</button>
              </div>
              <button type="button" class="btn btn-ghost btn-sm" title="Remove line" disabled=${finalized}
                onClick=${() => update({ tasks: local.tasks.filter((_, j) => j !== i) })}>✕</button>
            </div>
          </div>`)}
        <div class="row">
          <button class="btn btn-sm" disabled=${finalized}
            onClick=${() => update({ tasks: [...local.tasks, blankLine()] })}>＋ Add task line</button>
          <div class="spacer" style=${{ flex: 1 }}></div>
          <span class="muted small">Total</span>
          ${local.tasks.length === 1 && !finalized ? html`
            <input type="number" min="0" step=${increment} class="input-narrow mono"
              value=${local.tasks[0].duration || ''}
              onInput=${(e) => updateLine(0, { duration: e.target.value })} />` : html`
            <strong class="mono">${fmtHours(sum, increment)}h</strong>`}
        </div>
      </div>

      <div class="section-title"><h3 style=${{ margin: 0 }}>Narrative</h3>
        ${isAuto ? html`<span class="muted small">generated from task lines — edit the fragments above</span>` : null}
      </div>
      <div class="narrative-preview">
        ${isAuto ? html`
          <span class="auto-badge">AUTO</span>
          <textarea readOnly value=${autoNarrative || ''}></textarea>` : html`
          <textarea value=${local.narrative} disabled=${finalized}
            placeholder="What did you do? (specific verbs — banned vague phrases are flagged)"
            onInput=${(e) => update({ narrative: e.target.value })}></textarea>`}
      </div>

      <${ValidationList} findings=${validation} />

      ${gate ? html`
        <div class="card" style=${{ borderColor: 'var(--status-warning)' }}>
          <strong>${gate.blocks.length ? 'Cannot finalize yet:' : 'Finalize with warnings?'}</strong>
          <${ValidationList} findings=${[...gate.blocks, ...gate.warns]} />
          ${gate.blocks.length === 0 ? html`
            <div class="row-end">
              <button class="btn btn-primary" onClick=${() => finalize(true)}>Finalize anyway</button>
            </div>` : null}
        </div>` : null}

      ${entry && entry.ever_finalized ? html`
        <details style=${{ marginTop: '10px' }} onToggle=${(e) => { if (e.target.open && !audit) loadAudit(); }}>
          <summary class="muted small" style=${{ cursor: 'pointer' }}>Audit history</summary>
          ${audit === null ? html`<${Spinner} />` : audit.length === 0
            ? html`<p class="muted small">No changes recorded.</p>`
            : html`<div class="table-wrap"><table class="tk">
                <thead><tr><th>When</th><th>Action</th><th>Detail</th></tr></thead>
                <tbody>${audit.map((a) => html`
                  <tr key=${a.id}>
                    <td class="small">${fmtStamp(a.created_at)}</td>
                    <td class="small">${a.action}</td>
                    <td class="small mono">${JSON.stringify(a.detail)}</td>
                  </tr>`)}</tbody>
              </table></div>`}
        </details>` : null}

      <div class="row" style=${{ marginTop: '16px' }}>
        <span class="saving-dot">
          ${saveState === 'saving' ? 'Saving…' : saveState === 'saved' ? '✓ Saved' : saveState === 'error' ? '⚠ Save failed' : ''}
        </span>
        <div class="spacer" style=${{ flex: 1 }}></div>
        ${entry && !finalized ? html`<button class="btn btn-ghost" onClick=${del}>🗑 Delete</button>` : null}
        ${finalized
          ? html`<button class="btn" onClick=${unlock}>🔓 Unlock to edit</button>`
          : html`
            <button class="btn" onClick=${flushAndClose}>Save & close</button>
            <button class="btn btn-primary" onClick=${() => finalize(false)}>🔒 Finalize</button>`}
      </div>
    <//>`;
}

function swap(arr, i, j) {
  const next = arr.slice();
  [next[i], next[j]] = [next[j], next[i]];
  return next;
}
