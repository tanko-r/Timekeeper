import { api } from '/js/api.js';
import {
  html, useState, useEffect, useRef, Field, Modal, emitToast,
} from '/js/ui.js';

// Type-ahead Client/Matter picker. value = cm object or null.
// onChange(cm). allowCreate shows a "New CM…" row.
export function CmPicker({ value, onChange, autoFocus, allowCreate = true, placeholder = 'Search CM number or name…' }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState([]);
  const [hover, setHover] = useState(0);
  const [creating, setCreating] = useState(false);
  const boxRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    api.get(`/api/cms/picker?q=${encodeURIComponent(q)}`)
      .then((rows) => { if (alive) { setItems(rows); setHover(0); } })
      .catch(() => {});
    return () => { alive = false; };
  }, [q, open]);

  useEffect(() => {
    const onDoc = (e) => {
      if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  function pick(cm) {
    onChange(cm);
    setOpen(false);
    setQ('');
  }

  function onKey(e) {
    if (!open) return;
    const max = items.length - 1 + (allowCreate ? 1 : 0);
    if (e.key === 'ArrowDown') { e.preventDefault(); setHover((h) => Math.min(h + 1, max)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHover((h) => Math.max(h - 1, 0)); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      if (hover < items.length) pick(items[hover]);
      else if (allowCreate) setCreating(true);
    } else if (e.key === 'Escape') { setOpen(false); }
  }

  const favorites = items.filter((c) => c.favorite);
  const rest = items.filter((c) => !c.favorite);

  const renderItem = (cm, idx) => html`
    <div key=${cm.id} class=${'cmpicker-item' + (hover === idx ? ' hover' : '')}
      onMouseEnter=${() => setHover(idx)} onMouseDown=${(e) => { e.preventDefault(); pick(cm); }}>
      ${cm.favorite ? html`<span title="Favorite">★</span>` : null}
      <span class="name">${cm.short_name || '(unnamed)'}</span>
      <span class="num">${cm.cm_number}</span>
    </div>`;

  return html`
    <div class="cmpicker" ref=${boxRef}>
      ${value && !open ? html`
        <div class="row" style=${{ flexWrap: 'nowrap' }}>
          <button type="button" class="btn" style=${{ flex: 1, justifyContent: 'space-between', overflow: 'hidden' }}
            onClick=${() => setOpen(true)} title="Change CM">
            <span style=${{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
              ${value.favorite ? '★ ' : ''}${value.short_name || '(unnamed)'}
            </span>
            <span class="muted mono small">${value.cm_number}</span>
          </button>
        </div>` : html`
        <input type="search" value=${q} placeholder=${placeholder} autoFocus=${autoFocus}
          onFocus=${() => setOpen(true)}
          onInput=${(e) => { setQ(e.target.value); setOpen(true); }}
          onKeyDown=${onKey} />`}
      ${open ? html`
        <div class="cmpicker-menu">
          ${favorites.length ? html`<div class="cmpicker-section">Favorites</div>` : null}
          ${favorites.map((cm) => renderItem(cm, items.indexOf(cm)))}
          ${favorites.length && rest.length ? html`<div class="cmpicker-section">Recent & all</div>` : null}
          ${rest.map((cm) => renderItem(cm, items.indexOf(cm)))}
          ${items.length === 0 ? html`<div class="cmpicker-item muted">No matches</div>` : null}
          ${allowCreate ? html`
            <div class=${'cmpicker-item' + (hover === items.length ? ' hover' : '')}
              onMouseEnter=${() => setHover(items.length)}
              onMouseDown=${(e) => { e.preventDefault(); setCreating(true); }}>
              <span class="name" style=${{ color: 'var(--accent)' }}>＋ New client/matter…</span>
            </div>` : null}
        </div>` : null}
      ${creating ? html`
        <${NewCmModal} initialQ=${q}
          onCreated=${(cm) => { setCreating(false); pick(cm); }}
          onClose=${() => setCreating(false)} />` : null}
    </div>`;
}

export function NewCmModal({ initialQ = '', onCreated, onClose, existing }) {
  const isEdit = !!existing;
  const [num, setNum] = useState(existing ? existing.cm_number : (/^[\d-]+$/.test(initialQ) ? initialQ : ''));
  const [name, setName] = useState(existing ? existing.short_name : (/^[\d-]+$/.test(initialQ) ? '' : initialQ));
  const [billable, setBillable] = useState(existing ? !!existing.billable : true);
  const [favorite, setFavorite] = useState(existing ? !!existing.favorite : false);
  const [error, setError] = useState(null);

  const valid = /^\d{6}-\d{6}$/.test(num);

  async function save(e) {
    e.preventDefault();
    setError(null);
    try {
      const body = { cm_number: num, short_name: name, billable: billable ? 1 : 0, favorite: favorite ? 1 : 0 };
      const cm = isEdit
        ? await api.patch(`/api/cms/${existing.id}`, body)
        : await api.post('/api/cms', body);
      emitToast(isEdit ? 'CM updated' : `CM ${cm.cm_number} created`);
      onCreated(cm);
    } catch (err) {
      setError(err.message);
    }
  }

  return html`
    <${Modal} title=${isEdit ? 'Edit client/matter' : 'New client/matter'} onClose=${onClose}>
      <form onSubmit=${save} class="grid">
        <${Field} label="CM number" hint="Format: 123456-123456">
          <input type="text" value=${num} placeholder="000000-000000" autoFocus=${!isEdit}
            maxLength=${13} onInput=${(e) => setNum(e.target.value.replace(/[^\d-]/g, ''))} />
        <//>
        <${Field} label="Short name" hint="Your own shorthand — searchable">
          <input type="text" value=${name} onInput=${(e) => setName(e.target.value)} />
        <//>
        <label class="checkbox-row">
          <input type="checkbox" checked=${billable} onChange=${(e) => setBillable(e.target.checked)} />
          Billable by default
        </label>
        <label class="checkbox-row">
          <input type="checkbox" checked=${favorite} onChange=${(e) => setFavorite(e.target.checked)} />
          Pin as favorite
        </label>
        ${error ? html`<div class="error-box">${error}</div>` : null}
        <div class="row-end">
          <button type="button" class="btn" onClick=${onClose}>Cancel</button>
          <button class="btn btn-primary" disabled=${!valid}>${isEdit ? 'Save' : 'Create'}</button>
        </div>
      </form>
    <//>`;
}
