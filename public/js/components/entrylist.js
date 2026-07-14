import { api } from '/js/api.js';
import {
  html, useState, fmtHours, emitToast, BillableBadge, StatusChip, ValidationList, fmtStamp, Icon,
  markJustFinalized,
} from '/js/ui.js';
import { parseNarrativeEdit } from '/js/lib/narrativesync.js';

// Inline narrative editing (2026-07-10 feedback): click a draft entry's
// narrative to edit it in place — no editor round-trip. Same edit-through
// contract as the editor's AUTO box: on a ≥2-line auto entry, text that still
// parses folds back into the task lines (fragments + allocations, staying
// AUTO); a structural break detaches to a durable manual narrative
// (narrative_manual=1). Single/no-line entries just save the text.
function InlineNarrative({ entry, onChanged }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');

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
      const parsed = parseNarrativeEdit(t, substantive.length, { taskBilling });
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

  if (!editing) {
    return html`
      <p class="narrative narrative-editable" title="Click to edit the narrative in place"
        onClick=${() => { setText(entry.narrative); setEditing(true); }}>
        ${entry.narrative || html`<em class="muted">No narrative yet</em>`}
      </p>`;
  }
  return html`
    <textarea class="narrative-inline-input" autoFocus rows=${Math.max(2, Math.ceil(text.length / 90))}
      value=${text}
      onInput=${(e) => setText(e.target.value)}
      onFocus=${(e) => e.target.setSelectionRange(e.target.value.length, e.target.value.length)}
      onBlur=${save}
      onKeyDown=${(e) => {
        e.stopPropagation();
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save(); }
        if (e.key === 'Escape') { e.preventDefault(); setEditing(false); }
      }} />`;
}

// Card list of entries with inline actions. onChanged() after any mutation.
// `timers` (dashboard only) enables the per-entry start/stop-timer button —
// it resumes the timer linked to the entry (or links/creates one server-side).
export function EntryList({ entries, openEditor, onChanged, settings, showDate = false, runningIds = null, timers = null }) {
  if (!entries || entries.length === 0) {
    return html`<div class="card muted">No entries.</div>`;
  }
  const increment = (settings?.rounding?.increment) || 0.1;

  const timerFor = (entry) => (timers || []).find((t) => t.linked_entry_id === entry.id);
  const timersChanged = () => window.dispatchEvent(new CustomEvent('tk:timers-changed'));

  async function startTimer(entry) {
    try {
      await api.post('/api/timers/start-for-entry', { entry_id: entry.id });
      timersChanged();
      onChanged();
    } catch (e) {
      emitToast(e.message, { error: true });
    }
  }

  async function stopTimer(timer) {
    try {
      const r = await api.post(`/api/timers/${timer.id}/stop`);
      timersChanged();
      onChanged();
      if (r.discarded) emitToast('Misclick (under 2s) — nothing recorded.');
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

  return html`
    <div>
      ${entries.map((e) => html`
        <div key=${e.id} class=${'entry-card ' + (e.billable ? 'billable' : 'nonbillable')}>
          <div class="body">
            <div class="entry-meta">
              ${showDate ? html`<strong>${e.date}</strong>` : null}
              ${e.cm ? html`
                <strong>${e.cm.short_name}</strong>
                <span class="muted mono small">${e.cm.cm_number}</span>` : html`
                <strong class="muted">No matter yet</strong>
                <button class="btn btn-sm" title="Assign a client/matter — required before this entry can finalize or export"
                  onClick=${() => openEditor({ id: e.id })}>Assign matter</button>`}
              <${BillableBadge} billable=${e.billable} />
              <${StatusChip} entry=${e} />
              ${e.exported_at ? html`<span class="chip chip-exported" title=${'Exported ' + fmtStamp(e.exported_at)}>
                <${Icon} name="export" size=${12} /> exported</span>` : null}
              ${runningIds && runningIds.has(e.id) ? html`
                <span class="chip chip-running" title="Timer running — the total settles at the next stop">
                  <${Icon} name="timer" size=${12} /> running</span>`
              : e.source === 'timer' ? html`<span class="chip" title="Created by a timer"><${Icon} name="timer" size=${12} /></span>` : null}
            </div>
            <${InlineNarrative} entry=${e} onChanged=${onChanged} />
            ${e.tasks.length > 1 ? html`
              <div class="muted small">
                ${e.tasks.map((t) => `${t.task_code || '—'} ${fmtHours(t.duration, increment)}`).join(' · ')}
              </div>` : e.tasks.length === 1 && e.tasks[0].task_code ? html`
              <div class="muted small">${e.tasks[0].task_code}</div>` : null}
            ${e.status === 'draft' ? html`<${ValidationList} findings=${e.validation} compact=${true} />` : null}
          </div>
          <div style=${{ textAlign: 'right' }}>
            <div class="hours">${fmtHours(e.total, increment)}</div>
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
                <button class="btn btn-ghost btn-sm" title="Finalize" onClick=${() => finalize(e)}><${Icon} name="lock" size=${16} /></button>
                <button class="btn btn-ghost btn-sm" title="Delete" onClick=${() => del(e)}><${Icon} name="trash" size=${16} /></button>` : html`
                <button class="btn btn-ghost btn-sm" title="View" onClick=${() => openEditor({ id: e.id })}><${Icon} name="eye" size=${16} /></button>
                <button class="btn btn-ghost btn-sm" title="Unlock" onClick=${() => unlock(e)}><${Icon} name="unlock" size=${16} /></button>`}
              <button class="btn btn-ghost btn-sm" title="Copy to today"
                onClick=${() => openEditor({ copyFrom: e.id })}><${Icon} name="copy" size=${16} /></button>
            </div>
          </div>
        </div>`)}
    </div>`;
}
