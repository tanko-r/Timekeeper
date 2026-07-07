import { api } from '/js/api.js';
import {
  html, fmtHours, emitToast, BillableBadge, StatusChip, ValidationList, fmtStamp,
} from '/js/ui.js';

// Card list of entries with inline actions. onChanged() after any mutation.
export function EntryList({ entries, openEditor, onChanged, settings, showDate = false }) {
  if (!entries || entries.length === 0) {
    return html`<div class="card muted">No entries.</div>`;
  }
  const increment = (settings?.rounding?.increment) || 0.1;

  async function del(entry) {
    await api.del(`/api/entries/${entry.id}`);
    onChanged();
    emitToast(`Deleted ${fmtHours(entry.total, increment)}h entry for ${entry.cm.short_name}`, {
      actionLabel: 'Undo',
      action: async () => { await api.post(`/api/entries/${entry.id}/restore`); onChanged(); },
    });
  }

  async function finalize(entry) {
    try {
      await api.post(`/api/entries/${entry.id}/finalize`);
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
              <strong>${e.cm.short_name}</strong>
              <span class="muted mono small">${e.cm.cm_number}</span>
              <${BillableBadge} billable=${e.billable} />
              <${StatusChip} entry=${e} />
              ${e.exported_at ? html`<span class="chip chip-exported" title=${'Exported ' + fmtStamp(e.exported_at)}>📤 exported</span>` : null}
              ${e.source === 'timer' ? html`<span class="chip" title="Created by a timer">⏱</span>` : null}
            </div>
            <p class="narrative">${e.narrative || html`<em class="muted">No narrative yet</em>`}</p>
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
              ${e.status === 'draft' ? html`
                <button class="btn btn-ghost btn-sm" title="Edit" onClick=${() => openEditor({ id: e.id })}>✎</button>
                <button class="btn btn-ghost btn-sm" title="Finalize" onClick=${() => finalize(e)}>🔒</button>
                <button class="btn btn-ghost btn-sm" title="Delete" onClick=${() => del(e)}>🗑</button>` : html`
                <button class="btn btn-ghost btn-sm" title="View" onClick=${() => openEditor({ id: e.id })}>👁</button>
                <button class="btn btn-ghost btn-sm" title="Unlock" onClick=${() => unlock(e)}>🔓</button>`}
              <button class="btn btn-ghost btn-sm" title="Copy to date…"
                onClick=${() => openEditor({ copyFrom: e.id })}>⧉</button>
            </div>
          </div>
        </div>`)}
    </div>`;
}
