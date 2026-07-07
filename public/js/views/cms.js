import { api } from '/js/api.js';
import {
  html, useState, useAsync, Spinner, ErrorBox, emitToast, BillableBadge, fmtStamp,
} from '/js/ui.js';
import { NewCmModal } from '/js/components/cmpicker.js';

export function CmsView({ refreshKey, bumpRefresh }) {
  const [q, setQ] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [editing, setEditing] = useState(null); // 'new' | cm

  const { loading, data, error, reload } = useAsync(
    () => api.get(`/api/cms?includeArchived=${showArchived ? 1 : 0}`),
    [showArchived, refreshKey]);

  const rows = (data || []).filter((c) =>
    !q || c.cm_number.includes(q) || (c.short_name || '').toLowerCase().includes(q.toLowerCase()));

  async function toggleFavorite(cm) {
    await api.patch(`/api/cms/${cm.id}`, { favorite: cm.favorite ? 0 : 1 });
    reload();
  }

  async function toggleArchive(cm) {
    await api.patch(`/api/cms/${cm.id}`, { status: cm.status === 'archived' ? 'active' : 'archived' });
    emitToast(cm.status === 'archived' ? 'Restored to active' : 'Archived — hidden from pickers, entries kept');
    reload();
  }

  async function del(cm) {
    try {
      await api.del(`/api/cms/${cm.id}`);
      emitToast('CM deleted');
      reload();
    } catch (e) {
      emitToast(e.message, { error: true });
    }
  }

  return html`
    <div class="page-head"><h1>Clients & Matters</h1>
      <div class="spacer"></div>
      <label class="checkbox-row">
        <input type="checkbox" checked=${showArchived} onChange=${(e) => setShowArchived(e.target.checked)} />
        Show archived
      </label>
      <button class="btn btn-primary" onClick=${() => setEditing('new')}>＋ New CM</button>
    </div>

    <div class="card" style=${{ marginBottom: '12px' }}>
      <input type="search" placeholder="Filter by number or name…" value=${q} onInput=${(e) => setQ(e.target.value)} />
    </div>

    ${error ? html`<${ErrorBox} error=${error} />` : loading && !data ? html`<${Spinner} />` : html`
      <div class="card table-wrap" style=${{ padding: 0 }}>
        <table class="tk">
          <thead><tr>
            <th style=${{ width: '30px' }}></th><th>CM number</th><th>Short name</th>
            <th>Default</th><th>Entries</th><th>Last used</th><th></th>
          </tr></thead>
          <tbody>
            ${rows.map((cm) => html`
              <tr key=${cm.id} style=${{ opacity: cm.status === 'archived' ? 0.55 : 1 }}>
                <td><button class=${'star' + (cm.favorite ? ' on' : '')} title="Favorite"
                  onClick=${() => toggleFavorite(cm)}>★</button></td>
                <td class="mono">${cm.cm_number}</td>
                <td>${cm.short_name} ${cm.status === 'archived' ? html`<span class="chip">archived</span>` : ''}</td>
                <td><${BillableBadge} billable=${cm.billable} /></td>
                <td class="mono">${cm.entry_count ?? 0}</td>
                <td class="small muted">${cm.last_used_at ? fmtStamp(cm.last_used_at) : '—'}</td>
                <td>
                  <div class="row" style=${{ gap: '2px', flexWrap: 'nowrap', justifyContent: 'flex-end' }}>
                    <button class="btn btn-ghost btn-sm" title="Edit" onClick=${() => setEditing(cm)}>✎</button>
                    <button class="btn btn-ghost btn-sm" title=${cm.status === 'archived' ? 'Unarchive' : 'Archive'}
                      onClick=${() => toggleArchive(cm)}>${cm.status === 'archived' ? '📂' : '🗄'}</button>
                    <button class="btn btn-ghost btn-sm" title=${cm.entry_count > 0 ? 'Has entries — archive instead' : 'Delete'}
                      disabled=${cm.entry_count > 0} onClick=${() => del(cm)}>🗑</button>
                  </div>
                </td>
              </tr>`)}
            ${rows.length === 0 ? html`
              <tr><td colSpan="7" class="muted" style=${{ textAlign: 'center', padding: '30px' }}>
                No client/matters yet — create your first.
              </td></tr>` : null}
          </tbody>
        </table>
      </div>`}

    ${editing ? html`
      <${NewCmModal} existing=${editing === 'new' ? null : editing}
        onCreated=${() => { setEditing(null); reload(); bumpRefresh(); }}
        onClose=${() => setEditing(null)} />` : null}
  `;
}
