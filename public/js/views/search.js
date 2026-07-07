import { api } from '/js/api.js';
import {
  html, useState, useEffect, useAsync, Spinner, ErrorBox, fmtHours,
  emitToast, BillableBadge, StatusChip, Modal,
} from '/js/ui.js';
import { CmPicker } from '/js/components/cmpicker.js';

export function SearchView({ settings, openEditor, refreshKey, bumpRefresh }) {
  const [filters, setFilters] = useState({ q: '', cm: null, from: '', to: '', task: '', billable: '', status: '' });
  const [selected, setSelected] = useState(new Set());
  const [reassigning, setReassigning] = useState(false);
  const [taskCodes, setTaskCodes] = useState([]);

  useEffect(() => { api.get('/api/task-codes?includeInactive=1').then(setTaskCodes).catch(() => {}); }, []);

  const qs = (() => {
    const p = new URLSearchParams();
    if (filters.q) p.set('q', filters.q);
    if (filters.cm) p.set('cm_id', filters.cm.id);
    if (filters.from) p.set('from', filters.from);
    if (filters.to) p.set('to', filters.to);
    if (filters.task) p.set('task', filters.task);
    if (filters.billable !== '') p.set('billable', filters.billable);
    if (filters.status) p.set('status', filters.status);
    return p.toString();
  })();

  const { loading, data, error } = useAsync(() => api.get(`/api/entries?${qs}`), [qs, refreshKey]);
  const entries = data || [];
  const total = entries.reduce((a, e) => a + e.total, 0);

  useEffect(() => { setSelected(new Set()); }, [qs, refreshKey]);

  const set = (patch) => setFilters((f) => ({ ...f, ...patch }));
  const toggle = (id) => setSelected((s) => {
    const n = new Set(s);
    n.has(id) ? n.delete(id) : n.add(id);
    return n;
  });
  const allSelected = entries.length > 0 && entries.every((e) => selected.has(e.id));

  async function bulk(action, extra = {}) {
    const ids = [...selected];
    const r = await api.post('/api/entries/bulk', { ids, action, ...extra });
    if (r.failed.length > 0) {
      emitToast(`${r.done.length} done, ${r.failed.length} failed (check validation/finalized state)`, { error: true });
    } else {
      emitToast(`${r.done.length} ${action === 'set_cm' ? 'reassigned' : action + 'd'}`);
    }
    bumpRefresh();
  }

  return html`
    <div class="page-head"><h1>Search</h1>
      <div class="spacer"></div>
      <span class="muted">${entries.length} entries · ${fmtHours(total)}h</span>
    </div>

    <div class="card">
      <div class="grid" style=${{ gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
        <input type="search" data-search-q placeholder="Keyword in narrative…" value=${filters.q}
          onInput=${(e) => set({ q: e.target.value })} />
        <${CmPicker} value=${filters.cm} allowCreate=${false} placeholder="Any client/matter"
          onChange=${(cm) => set({ cm })} />
      </div>
      <div class="row" style=${{ marginTop: '10px' }}>
        <input type="date" value=${filters.from} style=${{ width: '160px' }} onChange=${(e) => set({ from: e.target.value })} />
        <span class="muted">→</span>
        <input type="date" value=${filters.to} style=${{ width: '160px' }} onChange=${(e) => set({ to: e.target.value })} />
        <select value=${filters.task} style=${{ width: '170px' }} onChange=${(e) => set({ task: e.target.value })}>
          <option value="">Any task</option>
          ${taskCodes.map((c) => html`<option key=${c.id} value=${c.name}>${c.name}</option>`)}
        </select>
        <select value=${filters.billable} style=${{ width: '140px' }} onChange=${(e) => set({ billable: e.target.value })}>
          <option value="">Billable + non</option>
          <option value="1">Billable</option>
          <option value="0">Non-billable</option>
        </select>
        <select value=${filters.status} style=${{ width: '130px' }} onChange=${(e) => set({ status: e.target.value })}>
          <option value="">Any status</option>
          <option value="draft">Draft</option>
          <option value="finalized">Finalized</option>
        </select>
        ${filters.cm || filters.q || filters.from || filters.to || filters.task || filters.billable !== '' || filters.status ? html`
          <button class="btn btn-sm" onClick=${() => setFilters({ q: '', cm: null, from: '', to: '', task: '', billable: '', status: '' })}>Clear</button>` : null}
      </div>
    </div>

    ${selected.size > 0 ? html`
      <div class="card row" style=${{ position: 'sticky', top: '8px', zIndex: 40 }}>
        <strong>${selected.size} selected</strong>
        <button class="btn btn-sm" onClick=${() => bulk('finalize', { ack: true })}>🔒 Finalize</button>
        <button class="btn btn-sm" onClick=${() => bulk('unlock')}>🔓 Unlock</button>
        <button class="btn btn-sm" onClick=${() => setReassigning(true)}>📁 Reassign CM</button>
        <button class="btn btn-sm btn-danger" onClick=${() => bulk('delete')}>🗑 Delete</button>
      </div>` : null}

    ${error ? html`<${ErrorBox} error=${error} />` : loading && !data ? html`<${Spinner} />` : html`
      <div class="card table-wrap" style=${{ padding: 0 }}>
        <table class="tk">
          <thead><tr>
            <th style=${{ width: '30px' }}><input type="checkbox" checked=${allSelected}
              onChange=${() => setSelected(allSelected ? new Set() : new Set(entries.map((e) => e.id)))} /></th>
            <th>Date</th><th>CM</th><th>Narrative</th><th>Status</th><th style=${{ textAlign: 'right' }}>Hours</th>
          </tr></thead>
          <tbody>
            ${entries.map((e) => html`
              <tr key=${e.id} class="clickable">
                <td onClick=${(ev) => ev.stopPropagation()}>
                  <input type="checkbox" checked=${selected.has(e.id)} onChange=${() => toggle(e.id)} />
                </td>
                <td class="mono small" onClick=${() => openEditor({ id: e.id })}>${e.date}</td>
                <td onClick=${() => openEditor({ id: e.id })}>
                  <div>${e.cm.short_name}</div>
                  <div class="muted small mono">${e.cm.cm_number}</div>
                </td>
                <td onClick=${() => openEditor({ id: e.id })}>
                  <div style=${{ maxWidth: '420px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                    title=${e.narrative}>${e.narrative || html`<em class="muted">no narrative</em>`}</div>
                </td>
                <td onClick=${() => openEditor({ id: e.id })}>
                  <div class="row" style=${{ gap: '4px' }}>
                    <${BillableBadge} billable=${e.billable} />
                    <${StatusChip} entry=${e} />
                  </div>
                </td>
                <td class="mono" style=${{ textAlign: 'right', fontWeight: 650 }}
                  onClick=${() => openEditor({ id: e.id })}>${fmtHours(e.total)}</td>
              </tr>`)}
            ${entries.length === 0 ? html`<tr><td colSpan="6" class="muted" style=${{ textAlign: 'center', padding: '30px' }}>No matching entries</td></tr>` : null}
          </tbody>
        </table>
      </div>`}

    ${reassigning ? html`
      <${Modal} title=${`Reassign ${selected.size} entries`} onClose=${() => setReassigning(false)}>
        <${CmPicker} autoFocus=${true} onChange=${async (cm) => {
          setReassigning(false);
          await bulk('set_cm', { cm_id: cm.id });
        }} />
      <//>` : null}
  `;
}
