import { api } from '/js/api.js';
import { html, useState, useEffect, Modal, emitToast } from '/js/ui.js';

// Manage custom-field definitions for one owner: { client_id } (applies to
// every matter under the client) or { matter_id } (that matter only; a
// same-named matter field overrides the client one). Values themselves are
// entered on entries — this is definitions only, task-codes style.
export function CustomFieldsModal({ owner, title, onClose }) {
  const [fields, setFields] = useState(null);
  const blank = { name: '', type: 'text', options: '', pattern: '', required: false };
  const [draft, setDraft] = useState(blank);

  const ownerQuery = owner.client_id ? `client_id=${owner.client_id}` : `matter_id=${owner.matter_id}`;
  const reload = () => api.get(`/api/custom-fields?${ownerQuery}&includeInactive=1`).then(setFields);
  useEffect(() => { reload().catch((e) => emitToast(e.message, { error: true })); }, []);

  const guard = (p) => p.catch((e) => emitToast(e.message, { error: true }));

  async function add(e) {
    e.preventDefault();
    if (!draft.name.trim()) return;
    await guard(api.post('/api/custom-fields', {
      ...owner,
      name: draft.name.trim(),
      type: draft.type,
      options: draft.type === 'select' ? splitOptions(draft.options) : [],
      pattern: draft.type === 'text' ? draft.pattern.trim() : '',
      required: draft.required,
    }).then(() => { setDraft(blank); return reload(); }));
  }

  const patch = (id, body) => guard(api.patch(`/api/custom-fields/${id}`, body).then(reload));

  async function move(i, dir) {
    const ids = fields.map((f) => f.id);
    const j = i + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    await guard(api.put('/api/custom-fields/order', { ids }).then(reload));
  }

  return html`
    <${Modal} title=${title} onClose=${onClose} wide=${true}>
      <p class="muted small">
        These fields appear on every time entry ${owner.client_id ? 'for matters under this client' : 'for this matter'} —
        e.g. a "Phase" or "Task" code the billing system requires. Values ride along on the CSV export.
        Required fields block finalizing until filled.
      </p>
      ${fields === null ? null : fields.length === 0 ? html`<p class="muted small">No fields yet.</p>` : html`
        <div class="grid" style=${{ gap: '6px' }}>
          ${fields.map((f, i) => html`
            <div key=${f.id} class="row custom-field-row" style=${{ flexWrap: 'nowrap', opacity: f.active ? 1 : 0.5 }}>
              <div class="reorder" style=${{ display: 'flex', flexDirection: 'column' }}>
                <button class="btn btn-ghost btn-sm" style=${{ padding: '0 6px' }} onClick=${() => move(i, -1)}>▲</button>
                <button class="btn btn-ghost btn-sm" style=${{ padding: '0 6px' }} onClick=${() => move(i, 1)}>▼</button>
              </div>
              <input type="text" defaultValue=${f.name} style=${{ width: '120px' }} title="Field name"
                onBlur=${(e) => { const v = e.target.value.trim(); if (v && v !== f.name) patch(f.id, { name: v }); }} />
              <select value=${f.type} title="Field type" onChange=${(e) => patch(f.id, { type: e.target.value })}>
                <option value="text">Text</option>
                <option value="select">Dropdown</option>
              </select>
              ${f.type === 'select' ? html`
                <input type="text" placeholder="options, comma-separated" title="Dropdown options"
                  defaultValue=${f.options.join(', ')}
                  onBlur=${(e) => patch(f.id, { options: splitOptions(e.target.value) })} />` : html`
                <input type="text" placeholder="format regex (optional), e.g. P\\d{3}" title="Format regex"
                  defaultValue=${f.pattern || ''}
                  onBlur=${(e) => patch(f.id, { pattern: e.target.value })} />`}
              <input type="text" placeholder="hint, e.g. P###" title="Shown as the input placeholder"
                defaultValue=${f.pattern_hint || ''} style=${{ width: '100px' }}
                onBlur=${(e) => patch(f.id, { pattern_hint: e.target.value })} />
              <label class="checkbox-row small" title="Finalize blocks while this field is empty">
                <input type="checkbox" checked=${!!f.required} onChange=${(e) => patch(f.id, { required: e.target.checked })} />
                req
              </label>
              <button class="btn btn-sm" title=${f.active ? 'Hide from entries (values kept)' : 'Reactivate'}
                onClick=${() => patch(f.id, { active: f.active ? 0 : 1 })}>${f.active ? 'Active' : 'Hidden'}</button>
              <button class="btn btn-ghost btn-sm" title="Delete (blocked once values exist — deactivate instead)"
                onClick=${() => guard(api.del(`/api/custom-fields/${f.id}`).then(reload))}>🗑</button>
            </div>`)}
        </div>`}
      <form class="row" style=${{ marginTop: '12px', flexWrap: 'nowrap' }} onSubmit=${add}>
        <input type="text" placeholder="New field name, e.g. Phase" value=${draft.name}
          onInput=${(e) => setDraft({ ...draft, name: e.target.value })} />
        <select value=${draft.type} onChange=${(e) => setDraft({ ...draft, type: e.target.value })}>
          <option value="text">Text</option>
          <option value="select">Dropdown</option>
        </select>
        ${draft.type === 'select' ? html`
          <input type="text" placeholder="options, comma-separated" value=${draft.options}
            onInput=${(e) => setDraft({ ...draft, options: e.target.value })} />` : html`
          <input type="text" placeholder="format regex (optional)" value=${draft.pattern}
            onInput=${(e) => setDraft({ ...draft, pattern: e.target.value })} />`}
        <label class="checkbox-row small">
          <input type="checkbox" checked=${draft.required}
            onChange=${(e) => setDraft({ ...draft, required: e.target.checked })} />
          required
        </label>
        <button class="btn">Add</button>
      </form>
    <//>`;
}

function splitOptions(text) {
  return String(text || '').split(',').map((s) => s.trim()).filter(Boolean);
}
