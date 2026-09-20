import { api, streamNdjson } from '/js/api.js';
import {
  html, useState, useEffect, useRef, fmtHours, fmtTenths, fmtClock, emitToast, BillableBadge, StatusChip,
  ValidationList, fmtStamp, Icon, markJustFinalized, fmtDateFull, Confirm, clientLabel, ContextMenu,
} from '/js/ui.js';
import { startAlignedTick, liveTimerSeconds } from '/js/lib/tick.js';
import { parseNarrativeEdit } from '/js/lib/narrativesync.js';
import { GhostInput, useMatterSuggestions, useMatterEntities } from '/js/components/ghosttext.js';
import { useShortcuts } from '/js/components/shortcuts.js';
import { expandShortcuts } from '/js/lib/expand.js';

const AI_TASK_LABEL = { expand: 'Expand', shorten: 'Shorten', rewrite: 'Rewrite' };

// Inline AI narrative assist (2026-09-15 feedback: "There should be an AI
// narrative assist button on this screen too" — the dashboard's Today's
// entries cards had click-to-edit narratives but no way to reach the
// editor's AI rewrite). Expand/Shorten/Rewrite run right here, streamed the
// same way the entry editor does. The one AI mode this card can't offer is
// "expand → split into tasks" — that rewrites the task lines, and this card
// has no task-line editor to show the result in — so that menu item opens
// the full entry editor instead, where the rest of the AI menu also lives.
function useAiAssist(entry, onChanged) {
  const [busy, setBusy] = useState(false);
  const [streamText, setStreamText] = useState(null); // live tokens while busy
  const abortRef = useRef(null);
  useEffect(() => () => abortRef.current?.abort(), []);

  const [lastTask, setLastTaskState] = useState(() => {
    const v = localStorage.getItem('tk:lastAiTask');
    return AI_TASK_LABEL[v] ? v : 'expand';
  });
  // Shared key with the entry editor (spec 2026-08-03): whichever surface
  // ran an AI task last, the other one's default button picks it up too.
  const setLastTask = (v) => { localStorage.setItem('tk:lastAiTask', v); setLastTaskState(v); };

  const seed = (entry.narrative || '').trim();

  async function finish(finalText, before) {
    const substantive = entry.tasks.filter(
      (x) => (x.fragment || '').trim() || (x.task_code || '').trim() || Number(x.duration) > 0);
    try {
      await api.patch(`/api/entries/${entry.id}`, {
        narrative: finalText,
        narrative_manual: substantive.length >= 2 ? 1 : 0,
        narrative_ai: 1,
        ai_brief: seed.slice(0, 500),
        ai_draft: finalText,
      });
      onChanged();
      emitToast('AI rewrite applied', {
        actionLabel: 'Undo',
        action: async () => {
          await api.patch(`/api/entries/${entry.id}`, {
            narrative: before.narrative, narrative_manual: before.narrative_manual, narrative_ai: 0,
          });
          onChanged();
        },
      });
    } catch (e) {
      emitToast(e.message, { error: true });
    }
  }

  async function narrate(mode) {
    if (!seed || busy) return;
    setLastTask(mode === 'longer' ? 'expand' : mode === 'shorter' ? 'shorten' : 'rewrite');
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setBusy(true);
    setStreamText('');
    const before = { narrative: entry.narrative, narrative_manual: entry.narrative_manual };
    try {
      let acc = '';
      await streamNdjson('/api/ai/narrate', {
        mode, brief: seed, narrative: seed,
        cm_id: entry.cm?.id,
        totalHours: entry.total > 0 ? entry.total : undefined,
      }, (m) => {
        if (abortRef.current !== ctrl) return; // superseded — drop late lines
        if (m.error) throw new Error(m.message || m.error);
        if (m.token) { acc += m.token; setStreamText(acc); }
        if (m.done) finish(m.narrative, before);
      }, ctrl.signal);
    } catch (e) {
      if (e.name !== 'AbortError') emitToast(e.body?.message || e.message, { error: true });
    } finally {
      if (abortRef.current === ctrl) { setBusy(false); setStreamText(null); }
    }
  }

  function run(kind) {
    if (kind === 'expand') narrate('longer');
    else if (kind === 'shorten') narrate('shorter');
    else narrate('regenerate');
  }

  return { busy, streamText, seed, lastTask, run };
}

// AI assist button + caret menu, mirroring the entry editor's (spec 3.3):
// main button re-runs the last task picked (shared with the editor), the
// caret opens the full choice. "Expand → split into tasks" hands off to the
// full editor rather than reimplementing task-line splitting here.
function InlineAiAssist({ ai, assist, entry, openEditor }) {
  const [menu, setMenu] = useState(null);
  if (!ai || !ai.enabled || !ai.reachable) return null;
  const disabled = !assist.seed || assist.busy;
  const items = [
    { label: 'Expand', icon: 'sparkles', disabled, onClick: () => assist.run('expand') },
    { label: 'Shorten', disabled, onClick: () => assist.run('shorten') },
    { label: 'Rewrite', disabled, onClick: () => assist.run('rewrite') },
    { hr: true },
    {
      label: 'Expand → split into tasks', icon: 'layout', disabled,
      onClick: () => openEditor({ id: entry.id }),
    },
  ];
  return html`
    <div class="inline-ai-assist">
      <div class="btn-split">
        <button type="button" class="btn btn-ghost btn-sm" title=${`AI: ${AI_TASK_LABEL[assist.lastTask]}`}
          disabled=${disabled} onClick=${() => assist.run(assist.lastTask)}>
          <${Icon} name="sparkles" size=${12} /> ${assist.busy ? 'Working…' : AI_TASK_LABEL[assist.lastTask]}
        </button>
        <button type="button" class="btn btn-ghost btn-sm" title="Choose a different AI task"
          disabled=${disabled}
          onClick=${(e) => { const r = e.currentTarget.getBoundingClientRect(); setMenu({ x: r.left, y: r.bottom + 4 }); }}>
          <${Icon} name="chevronDown" size=${11} />
        </button>
      </div>
      ${menu ? html`<${ContextMenu} x=${menu.x} y=${menu.y} items=${items} onClose=${() => setMenu(null)} />` : null}
    </div>`;
}

// Inline narrative editing (2026-07-10 feedback): click a draft entry's
// narrative to edit it in place — no editor round-trip. Same edit-through
// contract as the editor's AUTO box: on a ≥2-line auto entry, text that still
// parses folds back into the task lines (fragments + allocations, staying
// AUTO); a structural break detaches to a durable manual narrative
// (narrative_manual=1). Single/no-line entries just save the text.
function InlineNarrative({ entry, onChanged, ai, openEditor }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  // Same deterministic assists as the main editor (2026-07-14 feedback —
  // text expansion "not working in card view"): shortcut expansion plus the
  // matter's ghost completions. Suggestions fetch only while editing.
  const shortcuts = useShortcuts();
  const phrases = useMatterSuggestions(editing ? entry.cm?.id : null);
  const ents = useMatterEntities(editing ? entry.cm?.id : null);
  const expand = (t, caret) => expandShortcuts(t, caret, shortcuts);
  const assist = useAiAssist(entry, onChanged);

  if (entry.status !== 'draft') {
    return html`<p class="narrative">${entry.narrative || html`<em class="muted">No narrative yet</em>`}</p>`;
  }

  async function save() {
    setEditing(false);
    const t = text.trim();
    if (t === entry.narrative.trim()) return;
    const substantive = entry.tasks.filter(
      (x) => (x.fragment || '').trim() || (x.task_code || '').trim() || Number(x.duration) > 0);
    const body = { narrative: t };
    if (entry.narrative_auto && substantive.length >= 2) {
      const taskBilling = entry.cm?.client_task_billing !== 0;
      const parsed = parseNarrativeEdit(t, substantive.length,
        { taskBilling, prefix: entry.cm?.narrative_prefix || '' });
      if (parsed) {
        body.tasks = substantive.map((x, k) => ({
          task_code: x.task_code,
          duration: parsed.segments[k].duration ?? (Number(x.duration) || 0),
          fragment: parsed.segments[k].fragment,
        }));
        body.narrative_manual = 0;
      } else {
        body.narrative_manual = 1;
      }
    }
    try {
      await api.patch(`/api/entries/${entry.id}`, body);
      onChanged();
    } catch (e) {
      emitToast(e.message, { error: true });
    }
  }

  // While streaming, the live tokens replace the paragraph outright — same
  // spot, no separate progress area — and the AI button stays put (disabled,
  // reading "Working…") so the row's shape doesn't jump mid-stream.
  if (assist.busy) {
    return html`
      <div class="narrative-row">
        <p class="narrative">${assist.streamText || html`<em class="muted">Working…</em>`}</p>
        <${InlineAiAssist} ai=${ai} assist=${assist} entry=${entry} openEditor=${openEditor} />
      </div>`;
  }

  if (!editing) {
    return html`
      <div class="narrative-row">
        <p class="narrative narrative-editable" title="Click to edit the narrative in place"
          onClick=${() => { setText(entry.narrative); setEditing(true); }}>
          ${entry.narrative || html`<em class="muted">No narrative yet</em>`}
        </p>
        <${InlineAiAssist} ai=${ai} assist=${assist} entry=${entry} openEditor=${openEditor} />
      </div>`;
  }
  return html`
    <${GhostInput} multiline class="narrative-inline-input" autoFocus
      rows=${Math.max(2, Math.ceil(text.length / 90))}
      value=${text} suggestions=${phrases} entities=${ents} expand=${expand}
      onChange=${setText}
      onFocus=${(e) => e.target.setSelectionRange(e.target.value.length, e.target.value.length)}
      onBlur=${save}
      onKeyDown=${(e) => {
        e.stopPropagation();
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save(); }
        if (e.key === 'Escape') { e.preventDefault(); setEditing(false); }
      }} />`;
}

const tenth = (x) => Math.round((Number(x) || 0) * 10) / 10;

// Inline hours editing on the entry card (2026-08-19 feedback): up/down carets
// step the total by one increment, and clicking the number turns it into a box
// you type into — no editor round-trip. Mirrors the editor's Total-hours field:
// the value is written as total_override, and on a single-task entry the lone
// task line follows it so the allocations stay matched (a multi-task entry
// keeps its lines and shows the usual unallocated/mismatch warning, exactly as
// the editor does). Read-only for finalized entries and while a timer runs
// (the number is ticking live then).
function InlineHours({ entry, increment, onChanged, editable, label, running }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const cls = 'hours' + (running ? ' active' : '');

  if (!editable) {
    return html`<div class=${cls}
      title=${running ? `Running — ${fmtHours(entry.total, increment)}h filed so far` : null}>${label}</div>`;
  }

  const snap = (x) => Math.max(0, Math.round(x / increment) * increment);
  async function commit(raw) {
    setEditing(false);
    const t = tenth(snap(Number(raw) || 0));
    if (Math.abs(t - (Number(entry.total) || 0)) < 1e-9) return; // no change
    const body = { total_override: t > 0 ? t : null };
    // Keep a lone task line in step with the total (same as the editor). A
    // multi-line entry is left for the editor to reallocate.
    if (entry.tasks.length === 1) {
      const only = entry.tasks[0];
      body.tasks = [{ task_code: only.task_code, duration: t > 0 ? t : 0, fragment: only.fragment }];
    }
    try {
      await api.patch(`/api/entries/${entry.id}`, body);
      onChanged();
    } catch (e) {
      emitToast(e.message, { error: true });
    }
  }
  const stepBy = (dir) => commit((Number(entry.total) || 0) + dir * increment);

  if (editing) {
    return html`
      <input type="number" min="0" step=${increment} class="hours-input mono" autoFocus
        value=${text}
        onInput=${(e) => setText(e.target.value)}
        onBlur=${(e) => commit(e.target.value)}
        onKeyDown=${(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') { e.preventDefault(); commit(e.target.value); }
          if (e.key === 'Escape') { e.preventDefault(); setEditing(false); }
        }} />`;
  }
  return html`
    <div class="hours-stepper">
      <span class=${cls} role="button" tabindex="0" title="Click to edit the hours"
        onClick=${() => { setText(fmtHours(entry.total, increment)); setEditing(true); }}
        onKeyDown=${(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setText(fmtHours(entry.total, increment)); setEditing(true); } }}>${label}</span>
      <span class="hours-carets">
        <button class="hours-caret" title=${`+${increment}h`} tabindex="-1"
          onClick=${() => stepBy(1)}><${Icon} name="chevronUp" size=${11} /></button>
        <button class="hours-caret" title=${`-${increment}h`} tabindex="-1"
          onClick=${() => stepBy(-1)}><${Icon} name="chevronDown" size=${11} /></button>
      </span>
    </div>`;
}

// Card list of entries with inline actions. onChanged() after any mutation.
// `timers` (dashboard only) enables the per-entry start/stop-timer button —
// it resumes the timer linked to the entry (or links/creates one server-side).
export function EntryList({
  entries, openEditor, onChanged, settings, showDate = false,
  runningIds = null, timers = null, fetchedAt = null,
}) {
  const increment = (settings?.rounding?.increment) || 0.1;
  const [deleting, setDeleting] = useState(null);
  // One status check for the whole list (2026-09-15 feedback: inline AI
  // assist on the dashboard cards) rather than one per card.
  const [ai, setAi] = useState(null);
  useEffect(() => { api.get('/api/ai/status').then(setAi).catch(() => setAi({ enabled: false })); }, []);

  const timerFor = (entry) => (timers || []).find((t) => t.linked_entry_id === entry.id);

  // A running timer's time reaches its entry only when the timer stops, so the
  // filed total sat still while the clock climbed (2026-08-14 feedback: "These
  // numbers don't update live when the timer is running"). Tick once a second
  // while any linked timer runs and show what the entry is worth right now,
  // rounded exactly like the timer card.
  const roundMode = settings?.rounding?.enabled === false ? 'nearest' : (settings?.rounding?.mode || 'up');
  const anyRunning = (timers || []).some((t) => t.running && t.linked_entry_id);
  const [, forceTick] = useState(0);
  useEffect(() => {
    if (!anyRunning || !fetchedAt) return undefined;
    return startAlignedTick(fetchedAt, () => forceTick((x) => x + 1));
  }, [anyRunning, fetchedAt]);

  const hoursLabel = (entry) => {
    const t = timerFor(entry);
    const secs = t && t.running ? liveTimerSeconds(t, fetchedAt) : null;
    return secs == null ? fmtHours(entry.total, increment) : fmtTenths(secs, roundMode);
  };

  if (!entries || entries.length === 0) {
    return html`<div class="card muted">No entries.</div>`;
  }
  // (no manual tk:timers-changed dispatch here — api.js announces every
  // successful /api/timers write itself now)

  async function startTimer(entry) {
    try {
      await api.post('/api/timers/start-for-entry', { entry_id: entry.id });
      onChanged();
    } catch (e) {
      emitToast(e.message, { error: true });
    }
  }

  // A stop here files exactly what a stop on the timer card files, so it has
  // to offer the same one-tap narratives (2026-08-27 feedback). The chips are
  // TimerGrid's to render — it owns the popup state and the deduct action —
  // so hand it the stop result the way the app already hands around timer
  // news, and let it pop the same StopChips. The button only exists on the
  // dashboard (the `timers` prop), where TimerGrid is always mounted.
  async function stopTimer(timer) {
    try {
      const r = await api.post(`/api/timers/${timer.id}/stop`);
      onChanged();
      if (r.entry) {
        window.dispatchEvent(new CustomEvent('tk:timer-stopped', {
          detail: { timer: r.timer || timer, result: r },
        }));
      } else if (r.discarded) {
        emitToast('Misclick (under 2s) — nothing recorded.');
      } else {
        emitToast(`Nothing to file yet — clock keeps counting (${fmtClock(r.seconds)}).`);
      }
    } catch (e) {
      emitToast(e.message, { error: true });
    }
  }

  async function del(entry) {
    await api.del(`/api/entries/${entry.id}`);
    onChanged();
    emitToast(`Deleted ${fmtHours(entry.total, increment)}h ${entry.cm ? `entry for ${entry.cm.short_name}` : 'unassociated entry'}`, {
      actionLabel: 'Undo',
      action: async () => { await api.post(`/api/entries/${entry.id}/restore`); onChanged(); },
    });
  }

  async function finalize(entry) {
    try {
      await api.post(`/api/entries/${entry.id}/finalize`);
      markJustFinalized(entry.id); // one lock pulse on the refreshed chip
      onChanged();
      emitToast('Finalized', {
        actionLabel: 'Unlock',
        action: async () => { await api.post(`/api/entries/${entry.id}/unlock`); onChanged(); },
      });
    } catch (e) {
      if (e.status === 422) openEditor({ id: entry.id }); // show the findings in the editor
      else emitToast(e.message, { error: true });
    }
  }

  async function unlock(entry) {
    await api.post(`/api/entries/${entry.id}/unlock`);
    onChanged();
    emitToast('Unlocked — edits will be tracked in the audit log.');
  }

  // Multi-day lists (Week/Month/Range — 2026-07-13 feedback): the date is a
  // GROUP HEADER ("Thursday, June 18, 2026"), not a field repeated on every
  // card, with a subtle divider where a new ISO week begins. Entries arrive
  // date-ordered from the API, so consecutive runs are whole days.
  const mondayOf = (dateStr) => {
    const [y, m, d] = dateStr.split('-').map(Number);
    const dt = new Date(y, m - 1, d, 12);
    dt.setDate(dt.getDate() - ((dt.getDay() + 6) % 7));
    return dt.toDateString();
  };
  const dayGroups = [];
  if (showDate) {
    for (const e of entries) {
      const last = dayGroups[dayGroups.length - 1];
      if (last && last.date === e.date) last.entries.push(e);
      else dayGroups.push({ date: e.date, entries: [e] });
    }
  }

  const card = (e) => html`
        <div key=${e.id} class=${'entry-card ' + (e.billable ? 'billable' : 'nonbillable')}>
          <div class="body">
            <div class="entry-meta">
              ${e.cm ? html`
                <strong>${clientLabel(e.cm) ? `${clientLabel(e.cm)} - ${e.cm.short_name}` : e.cm.short_name}</strong>
                <span class="muted mono small">${e.cm.cm_number}</span>` : html`
                <strong class="muted">No matter yet</strong>
                <button class="btn btn-sm" title="Assign a client/matter — required before this entry can finalize or export"
                  onClick=${() => openEditor({ id: e.id })}>Assign matter</button>`}
              <${BillableBadge} billable=${e.billable} />
              <${StatusChip} entry=${e} />
              ${e.exported_at ? html`<span class="chip chip-exported" title=${'Exported ' + fmtStamp(e.exported_at)}>
                <${Icon} name="export" size=${12} /> exported</span>` : null}
              ${runningIds && runningIds.has(e.id) ? html`
                <span class="chip chip-running" title="Timer running — the hours tick live and file at the next stop">
                  <${Icon} name="timer" size=${12} /> running</span>`
              : e.source === 'timer' ? html`<span class="chip" title="Created by a timer"><${Icon} name="timer" size=${12} /></span>` : null}
            </div>
            <${InlineNarrative} entry=${e} onChanged=${onChanged} ai=${ai} openEditor=${openEditor} />
            ${e.tasks.length > 1 ? html`
              <div class="muted small">
                ${e.tasks.map((t) => `${t.task_code || '—'} ${fmtHours(t.duration, increment)}`).join(' · ')}
              </div>` : e.tasks.length === 1 && e.tasks[0].task_code ? html`
              <div class="muted small">${e.tasks[0].task_code}</div>` : null}
            ${e.status === 'draft' ? html`<${ValidationList} findings=${e.validation} compact=${true} />` : null}
          </div>
          <div style=${{ textAlign: 'right' }}>
            <${InlineHours} entry=${e} increment=${increment} onChanged=${onChanged}
              editable=${e.status === 'draft' && !(runningIds && runningIds.has(e.id))}
              running=${!!(runningIds && runningIds.has(e.id))} label=${hoursLabel(e)} />
            <div class="entry-actions">
              ${timers && e.status === 'draft' ? (() => {
                const t = timerFor(e);
                return t && t.running ? html`
                  <button class="btn btn-ghost btn-sm entry-timer-btn running" title=${`Stop "${t.name}" & file time`}
                    onClick=${() => stopTimer(t)}><${Icon} name="stop" size=${16} /></button>` : html`
                  <button class="btn btn-ghost btn-sm entry-timer-btn"
                    title=${t ? `Resume "${t.name}" on this entry` : 'Start a timer on this entry (links back to its timer)'}
                    onClick=${() => startTimer(e)}><${Icon} name="play" size=${16} /></button>`;
              })() : null}
              ${e.status === 'draft' ? html`
                <button class="btn btn-ghost btn-sm" title="Edit" onClick=${() => openEditor({ id: e.id })}><${Icon} name="edit" size=${16} /></button>
                <button class="btn btn-ghost btn-sm entry-lock-btn" title="Finalize" onClick=${() => finalize(e)}><${Icon} name="lock" size=${16} /></button>
                <button class="btn btn-ghost btn-sm" title="Delete" onClick=${() => setDeleting(e)}><${Icon} name="trash" size=${16} /></button>` : html`
                <button class="btn btn-ghost btn-sm" title="View" onClick=${() => openEditor({ id: e.id })}><${Icon} name="eye" size=${16} /></button>
                <button class="btn btn-ghost btn-sm entry-lock-btn finalized" title="Unlock" onClick=${() => unlock(e)}><${Icon} name="lock" size=${16} /></button>`}
              <button class="btn btn-ghost btn-sm" title="Copy to today"
                onClick=${() => openEditor({ copyFrom: e.id })}><${Icon} name="copy" size=${16} /></button>
            </div>
          </div>
        </div>`;

  const confirmDelete = deleting ? html`
    <${Confirm} title="Delete entry" danger confirmLabel="Delete"
      message=${`Delete this ${fmtHours(deleting.total, increment)}h entry${deleting.cm ? ` for ${deleting.cm.short_name}` : ''}? You'll have a few seconds to undo from the toast.`}
      onConfirm=${() => del(deleting)}
      onClose=${() => setDeleting(null)} />` : null;

  if (!showDate) return html`<div>${entries.map(card)}${confirmDelete}</div>`;

  return html`
    <div>
      ${dayGroups.map((g, gi) => {
        const total = g.entries.reduce((a, e) => a + e.total, 0);
        const newWeek = gi > 0 && mondayOf(dayGroups[gi - 1].date) !== mondayOf(g.date);
        return html`
          <div key=${g.date}>
            ${newWeek ? html`<div class="entry-week-divider" role="separator"></div>` : null}
            <div class="entry-day-head">
              <span>${fmtDateFull(g.date)}</span>
              <span class="muted small">${g.entries.length} ${g.entries.length === 1 ? 'entry' : 'entries'} · ${fmtHours(total, increment)}h</span>
            </div>
            ${g.entries.map(card)}
          </div>`;
      })}
      ${confirmDelete}
    </div>`;
}
