import { api, streamNdjson } from '/js/api.js';
import {
  html, useState, useEffect, useRef, useCallback, useDebounced,
  Modal, Field, fmtHours, todayStr, emitToast, previewNarrative,
  ValidationList, fmtStamp, Spinner, Icon, splitTenthsEvenly, markJustFinalized,
} from '/js/ui.js';
import { CmPicker } from '/js/components/cmpicker.js';
import { GhostInput, useMatterSuggestions } from '/js/components/ghosttext.js';
import { useShortcuts, SaveShortcutBar } from '/js/components/shortcuts.js';
import { expandShortcuts } from '/js/lib/expand.js';

const blankLine = (duration = 0) => ({ task_code: '', duration, fragment: '' });
const tenth = (x) => Math.round((Number(x) || 0) * 10) / 10;

// Entry editor. The entry TOTAL is primary (typed or from a timer); task lines
// divide it. spec: {id} | {template:{date?,cm?}} | {copyFrom:id}
export function EntryEditor({ spec, settings, onClose }) {
  const [entry, setEntry] = useState(null);
  const [local, setLocal] = useState(null);
  const [saveState, setSaveState] = useState('idle');
  const [gate, setGate] = useState(null);
  const [audit, setAudit] = useState(null);
  const [taskCodes, setTaskCodes] = useState([]);
  const [ai, setAi] = useState(null);
  const [brief, setBrief] = useState('');
  const [aiSplit, setAiSplit] = useState(true);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiDone, setAiDone] = useState(false); // a narrate run finished → show rewrite controls
  const aiAbortRef = useRef(null); // in-flight narrate stream; aborted on new run/unmount
  const changedRef = useRef(false);
  const localRef = useRef(null);
  localRef.current = local;
  const entryRef = useRef(null);
  entryRef.current = entry;

  const increment = settings?.rounding?.increment || 0.1;

  // Ghost-text autocomplete (spec §6): deterministic phrasebook completions
  // for the picked matter; Tab accepts. No LLM anywhere in this path.
  const phrases = useMatterSuggestions(local?.cm?.id);

  // Text-expansion shortcuts (spec §6): deterministic inline expansion in
  // fragment/narrative fields + in-flow capture from a text selection.
  const shortcuts = useShortcuts();
  const [selText, setSelText] = useState('');
  const expand = useCallback((text, caret) => expandShortcuts(text, caret, shortcuts), [shortcuts]);
  const onFieldSelect = useCallback((el) => setSelText(el.value.slice(el.selectionStart, el.selectionEnd)), []);

  useEffect(() => {
    api.get('/api/task-codes').then(setTaskCodes).catch(() => {});
    api.get('/api/ai/status').then(setAi).catch(() => {});
    return () => aiAbortRef.current?.abort(); // closing the editor cancels a live stream
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
            total: 0,
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
      total: e.total_override != null ? e.total_override : e.total,
      tasks: e.tasks.length ? e.tasks.map((t) => ({ ...t })) : [blankLine()],
      status: e.status,
      ack_validation: e.ack_validation,
    };
  }

  const substantive = (local?.tasks || []).filter(
    (t) => (t.fragment || '').trim() || (t.task_code || '').trim() || Number(t.duration) > 0);
  const isAuto = substantive.length >= 2;
  const autoNarrative = isAuto ? previewNarrative(local.tasks, increment) : null;
  const sum = tenth((local?.tasks || []).reduce((a, t) => a + (Number(t.duration) || 0), 0));
  const total = tenth(local?.total || 0);
  const remaining = tenth(total - sum);
  const finalized = local?.status === 'finalized';

  // ---------- persistence (single-flight chain) ----------

  const saveChain = useRef(Promise.resolve(null));

  const doPersist = useCallback(async () => {
    const l = localRef.current;
    const e = entryRef.current;
    if (!l || l.status === 'finalized') return e;
    if (!l.cm || !l.date) return e;
    const body = {
      date: l.date,
      cm_id: l.cm.id,
      billable: l.billable ? 1 : 0,
      narrative: l.narrative,
      total_override: l.total > 0 ? tenth(l.total) : null,
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
      entryRef.current = saved;
      setEntry(saved);
      setSaveState('saved');
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

  // Total is primary. With a single line, the line mirrors it.
  const updateTotal = useCallback((value) => {
    setLocal((cur) => {
      const t = Math.max(0, Number(value) || 0);
      const next = { ...cur, total: t };
      if (cur.tasks.length === 1) {
        next.tasks = [{ ...cur.tasks[0], duration: tenth(t) }];
      }
      return next;
    });
    setGate(null);
    queueSave();
  }, [queueSave]);

  const updateLine = useCallback((i, patch) => {
    setLocal((cur) => {
      const tasks = cur.tasks.map((t, j) => (j === i ? { ...t, ...patch } : t));
      const next = { ...cur, tasks };
      if (tasks.length === 1 && patch.duration !== undefined) {
        next.total = tenth(tasks[0].duration); // single line writes through
      }
      return next;
    });
    setGate(null);
    queueSave();
  }, [queueSave]);

  const addLine = useCallback(() => {
    setLocal((cur) => {
      const s = cur.tasks.reduce((a, t) => a + (Number(t.duration) || 0), 0);
      const rem = Math.max(0, tenth((cur.total || 0) - s));
      return { ...cur, tasks: [...cur.tasks, blankLine(rem)] };
    });
    queueSave();
  }, [queueSave]);

  const splitEvenly = useCallback(() => {
    setLocal((cur) => {
      const parts = splitTenthsEvenly(cur.total || 0, cur.tasks.length);
      return { ...cur, tasks: cur.tasks.map((t, i) => ({ ...t, duration: parts[i] })) };
    });
    queueSave();
  }, [queueSave]);

  async function flushAndClose() {
    cancelSave();
    await persist();
    onClose(changedRef.current);
  }

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
      markJustFinalized(e.id); // one lock pulse on the list chip after close
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

  async function aiExpand() {
    setAiBusy(true);
    try {
      const r = await api.post('/api/ai/expand', {
        brief, totalHours: total > 0 ? total : (sum > 0 ? sum : undefined),
      });
      if (aiSplit && r.tasks.length > 0) {
        const even = splitTenthsEvenly(total || sum, r.tasks.length);
        update({
          tasks: r.tasks.map((t, i) => ({
            task_code: t.task_code, fragment: t.fragment,
            duration: t.hours != null ? t.hours : even[i] || 0,
          })),
        });
      } else {
        update({ narrative: r.narrative });
      }
      setBrief('');
    } catch (e) {
      emitToast(e.body?.message || e.message, { error: true });
    } finally {
      setAiBusy(false);
    }
  }

  // Streamed narration (spec §6): tokens land in the narrative field live,
  // replacing the blocking spinner. The "split into tasks" path keeps the
  // JSON /ai/expand endpoint — a structured split can't stream. Each chunk
  // goes through update(), so the normal debounced autosave applies.
  // Starting a new run aborts any in-flight one (regenerate mid-stream), and
  // unmount aborts too — otherwise the server never sees a disconnect and
  // Ollama keeps generating for up to 180s. A superseded run's callbacks and
  // state writes are ignored so it can't fight the run that replaced it.
  async function aiNarrate(mode) {
    aiAbortRef.current?.abort();
    const ctrl = new AbortController();
    aiAbortRef.current = ctrl;
    setAiBusy(true);
    try {
      let acc = '';
      await streamNdjson('/api/ai/narrate', {
        mode, brief, narrative: localRef.current?.narrative || '',
      }, (m) => {
        if (aiAbortRef.current !== ctrl) return; // superseded — drop late lines
        if (m.error) throw new Error(m.message || m.error);
        if (m.token) { acc += m.token; update({ narrative: acc }); }
        if (m.done) update({ narrative: m.narrative });
      }, ctrl.signal);
      setAiDone(true);
    } catch (e) {
      if (e.name !== 'AbortError') emitToast(e.body?.message || e.message, { error: true });
    } finally {
      if (aiAbortRef.current === ctrl) setAiBusy(false);
    }
  }

  // ---------- render ----------

  if (!local) {
    return html`<${Modal} title="Time entry" onClose=${() => onClose(changedRef.current)} wide=${true}><${Spinner} /><//>`;
  }

  const validation = entry ? entry.validation : [];

  return html`
    <${Modal} wide=${true} onClose=${flushAndClose}
      title=${finalized ? 'Time entry (finalized)' : entry ? 'Edit time entry' : 'New time entry'}>
      <div class="grid" style=${{ gridTemplateColumns: '140px 1fr 110px auto', alignItems: 'end', gap: '10px' }}>
        <${Field} label="Date">
          <input type="date" value=${local.date} disabled=${finalized}
            onChange=${(e) => update({ date: e.target.value })} />
        <//>
        <${Field} label="Client/Matter">
          <${CmPicker} value=${local.cm} autoFocus=${!local.cm}
            onChange=${(cm) => update({ cm, billable: !!cm.billable })} />
        <//>
        <${Field} label="Total hours">
          <input type="number" min="0" step=${increment} class="mono total-input"
            value=${local.total || ''} placeholder="0.0" disabled=${finalized}
            onInput=${(e) => updateTotal(e.target.value)} />
        <//>
        <label class="checkbox-row" style=${{ paddingBottom: '8px' }}>
          <input type="checkbox" checked=${local.billable} disabled=${finalized}
            onChange=${(e) => update({ billable: e.target.checked })} />
          Billable
        </label>
      </div>

      <div class="section-title">
        <h3 style=${{ margin: 0 }}>Task lines</h3>
        <span class="muted small">divide the total among tasks</span>
        <div class="spacer" style=${{ flex: 1 }}></div>
        ${!finalized && local.tasks.length > 1 && total > 0 ? html`
          <button class="btn btn-sm" onClick=${splitEvenly}>Split evenly</button>` : null}
        ${remaining !== 0 && total > 0 && local.tasks.length > 0 ? html`
          <span class=${'alloc-chip' + (remaining < 0 ? ' over' : '')}>
            ${remaining > 0
              ? `${fmtHours(remaining, increment)}h unallocated`
              : `${fmtHours(-remaining, increment)}h over-allocated`}
          </span>` : null}
      </div>
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
            <${GhostInput} value=${t.fragment} suggestions=${phrases} disabled=${finalized}
              expand=${expand} onSelectionChange=${onFieldSelect}
              placeholder=${isAuto ? 'narrative fragment for this task' : 'optional fragment (used if you add more lines)'}
              onChange=${(v) => updateLine(i, { fragment: v })} />
            <div class="row" style=${{ flexWrap: 'nowrap', gap: '2px' }}>
              <div class="reorder">
                <button type="button" title="Move up" disabled=${finalized || i === 0}
                  onClick=${() => update({ tasks: swap(local.tasks, i, i - 1) })}><${Icon} name="chevronUp" size=${11} /></button>
                <button type="button" title="Move down" disabled=${finalized || i === local.tasks.length - 1}
                  onClick=${() => update({ tasks: swap(local.tasks, i, i + 1) })}><${Icon} name="chevronDown" size=${11} /></button>
              </div>
              <button type="button" class="btn btn-ghost btn-sm" title="Remove line" disabled=${finalized}
                onClick=${() => update({ tasks: local.tasks.filter((_, j) => j !== i) })}><${Icon} name="x" size=${14} /></button>
            </div>
          </div>`)}
        <div class="row">
          <button class="btn btn-sm" disabled=${finalized} onClick=${addLine}>
            <${Icon} name="plus" size=${14} /> Add task line
          </button>
          <div class="spacer" style=${{ flex: 1 }}></div>
          <span class="muted small">Allocated <strong class="mono">${fmtHours(sum, increment)}h</strong>
            of <strong class="mono">${fmtHours(total, increment)}h</strong></span>
        </div>
      </div>

      <div class="section-title"><h3 style=${{ margin: 0 }}>Narrative</h3>
        ${isAuto ? html`<span class="muted small">generated from task lines — edit the fragments above (ghost suggestions appear in the fragment fields)</span>` : null}
        <div class="spacer" style=${{ flex: 1 }}></div>
        <${SaveShortcutBar} selection=${selText} />
      </div>
      <div class="narrative-preview">
        ${isAuto ? html`
          <span class="auto-badge">AUTO</span>
          <textarea readOnly value=${autoNarrative || ''}></textarea>` : html`
          <${GhostInput} multiline rows=${3} value=${local.narrative} disabled=${finalized}
            suggestions=${phrases} expand=${expand} onSelectionChange=${onFieldSelect}
            placeholder="What did you do? (specific verbs — banned vague phrases are flagged)"
            onChange=${(v) => update({ narrative: v })} />`}
      </div>

      ${ai && ai.enabled && ai.reachable && !finalized ? html`
        <div class="ai-row">
          <input type="text" value=${brief}
            placeholder=${`Brief description — ${ai.model} ${aiSplit ? 'expands it…' : 'writes it live…'}`}
            onInput=${(e) => setBrief(e.target.value)}
            onKeyDown=${(e) => { if (e.key === 'Enter' && brief && !aiBusy) (aiSplit ? aiExpand() : aiNarrate('draft')); }} />
          <label class="checkbox-row small">
            <input type="checkbox" checked=${aiSplit} onChange=${(e) => setAiSplit(e.target.checked)} />
            split into tasks
          </label>
          <button class="btn" disabled=${!brief || aiBusy} onClick=${() => (aiSplit ? aiExpand() : aiNarrate('draft'))}>
            <${Icon} name="sparkles" size=${16} />
            ${aiBusy ? (aiSplit ? 'Thinking…' : 'Streaming…') : (aiSplit ? 'Expand' : 'Write')}
          </button>
          ${aiDone && !aiBusy && !isAuto ? html`
            <span class="row" style=${{ gap: '4px', flexWrap: 'nowrap' }}>
              <button class="btn btn-sm" title="Try a different phrasing" disabled=${!brief}
                onClick=${() => aiNarrate('regenerate')}>↻ Regenerate</button>
              <button class="btn btn-sm" onClick=${() => aiNarrate('shorter')}>Shorter</button>
              <button class="btn btn-sm" onClick=${() => aiNarrate('longer')}>Longer</button>
            </span>` : null}
        </div>` : null}

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
        ${entry && !finalized ? html`
          <button class="btn btn-ghost" onClick=${del}><${Icon} name="trash" size=${16} /> Delete</button>` : null}
        ${finalized
          ? html`<button class="btn" onClick=${unlock}><${Icon} name="unlock" size=${16} /> Unlock to edit</button>`
          : html`
            <button class="btn" onClick=${flushAndClose}>Save & close</button>
            <button class="btn btn-primary" onClick=${() => finalize(false)}>
              <${Icon} name="lock" size=${16} /> Finalize</button>`}
      </div>
    <//>`;
}

function swap(arr, i, j) {
  const next = arr.slice();
  [next[i], next[j]] = [next[j], next[i]];
  return next;
}
