import { api } from '/js/api.js';
import {
  html, useState, useAsync, Spinner, ErrorBox, emitToast, BillableBadge, fmtStamp, Icon, clientLabel, React,
} from '/js/ui.js';
import { NewCmModal } from '/js/components/cmpicker.js';
import { CustomFieldsModal } from '/js/components/customfields.js';

export function CmsView({ refreshKey, bumpRefresh }) {
  const [q, setQ] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [editing, setEditing] = useState(null); // 'new' | cm
  const [fieldsFor, setFieldsFor] = useState(null); // { owner: {client_id}|{matter_id}, title }

  const { loading, data, error, reload } = useAsync(
    () => api.get(`/api/cms?includeArchived=${showArchived ? 1 : 0}`),
    [showArchived, refreshKey]);

  const ql = q.toLowerCase();
  const rows = (data || []).filter((c) =>
    !q
    || c.cm_number.includes(q)
    || (c.short_name || '').toLowerCase().includes(ql)
    || (c.client_name || '').toLowerCase().includes(ql)
    || (c.client_number || '').includes(q));

  // Group matters under their client (blank names render as the number —
  // the visible prompt to name them).
  const byClient = new Map();
  for (const cm of rows) {
    const key = cm.client_id ?? `none-${cm.id}`;
    if (!byClient.has(key)) {
      byClient.set(key, {
        client_id: cm.client_id, client_number: cm.client_number,
        client_name: cm.client_name, matters: [],
      });
    }
    byClient.get(key).matters.push(cm);
  }
  const clientGroups = [...byClient.values()].sort((a, b) =>
    (clientLabel(a) || '').localeCompare(clientLabel(b) || '', undefined, { sensitivity: 'base' }));

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
      <button class="btn btn-primary" onClick=${() => setEditing('new')}><${Icon} name="plus" size=${16} /> New CM</button>
    </div>

    <div class="card" style=${{ marginBottom: '12px' }}>
      <input type="search" placeholder="Filter by client, number, or name…" value=${q} onInput=${(e) => setQ(e.target.value)} />
    </div>

    ${error ? html`<${ErrorBox} error=${error} />` : loading && !data ? html`<${Spinner} />` : html`
      <div class="card table-wrap" style=${{ padding: 0 }}>
        <table class="tk">
          <thead><tr>
            <th style=${{ width: '30px' }}></th><th>CM number</th><th>Short name</th>
            <th>Default</th><th>Entries</th><th>Last used</th><th></th>
          </tr></thead>
          <tbody>
            ${clientGroups.map((g) => html`
              <${React.Fragment} key=${g.client_id ?? g.matters[0].id}>
                <tr class="client-row">
                  <td></td>
                  <td class="mono"><span class="muted small">Client</span> ${g.client_number || '—'}</td>
                  <td colSpan="5"><${ClientNameCell} group=${g} onSaved=${() => { reload(); bumpRefresh(); }} />
                    ${g.client_id != null ? html`
                      <button class="btn btn-ghost btn-sm" title="Custom fields for every matter under this client"
                        onClick=${() => setFieldsFor({
                          owner: { client_id: g.client_id },
                          title: `Custom fields — client ${clientLabel(g) || g.client_number}`,
                        })}><${Icon} name="settings" size=${14} /> Fields</button>` : null}
                  </td>
                </tr>
                ${g.matters.map((cm) => html`
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
                        <button class="btn btn-ghost btn-sm" title="Custom fields for this matter only"
                          onClick=${() => setFieldsFor({
                            owner: { matter_id: cm.id },
                            title: `Custom fields — ${cm.short_name || cm.cm_number}`,
                          })}><${Icon} name="settings" size=${16} /></button>
                        <button class="btn btn-ghost btn-sm" title="Edit" onClick=${() => setEditing(cm)}><${Icon} name="edit" size=${16} /></button>
                        <button class="btn btn-ghost btn-sm" title=${cm.status === 'archived' ? 'Unarchive' : 'Archive'}
                          onClick=${() => toggleArchive(cm)}><${Icon} name=${cm.status === 'archived' ? 'archiveRestore' : 'archive'} size=${16} /></button>
                        <button class="btn btn-ghost btn-sm" title=${cm.entry_count > 0 ? 'Has entries — archive instead' : 'Delete'}
                          disabled=${cm.entry_count > 0} onClick=${() => del(cm)}><${Icon} name="trash" size=${16} /></button>
                      </div>
                    </td>
                  </tr>`)}
              <//>`)}
            ${clientGroups.length === 0 ? html`
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
    ${fieldsFor ? html`
      <${CustomFieldsModal} owner=${fieldsFor.owner} title=${fieldsFor.title}
        onClose=${() => { setFieldsFor(null); bumpRefresh(); }} />` : null}
  `;
}

// Inline client naming — the minimal affordance from spec §3.3 ("a visible
// prompt to name it"). Enter/blur saves via PATCH /api/clients/:id.
function ClientNameCell({ group, onSaved }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(group.client_name || '');

  async function save() {
    setEditing(false);
    const name = text.trim();
    if (name === (group.client_name || '')) return;
    try {
      await api.patch(`/api/clients/${group.client_id}`, { name });
      emitToast(name ? 'Client named' : 'Client name cleared');
      onSaved();
    } catch (e) {
      emitToast(e.message, { error: true });
    }
  }

  if (editing) {
    return html`
      <input type="text" value=${text} autoFocus placeholder="Client name…"
        style=${{ maxWidth: '280px' }}
        onInput=${(e) => setText(e.target.value)}
        onBlur=${save}
        onKeyDown=${(e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setEditing(false); }} />`;
  }
  if (!group.client_id) {
    return html`<span class="client-name-cell muted small">(no client)</span>`;
  }
  return html`
    <span class="client-name-cell">
      ${group.client_name ? html`
        <strong>${group.client_name}</strong>
        <button class="btn btn-ghost btn-sm" title="Edit client name"
          onClick=${() => { setText(group.client_name || ''); setEditing(true); }}>
          <${Icon} name="edit" size=${14} /></button>` : html`
        <button type="button" class="client-name-add" title="Name this client"
          onClick=${() => { setText(''); setEditing(true); }}>
          + Name this client
        </button>`}
    </span>`;
}
