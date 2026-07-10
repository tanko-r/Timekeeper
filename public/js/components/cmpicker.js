import { api } from '/js/api.js';
import {
  html, useState, useEffect, useRef, Field, Modal, emitToast, clientLabel,
} from '/js/ui.js';

const SIX_RE = /^\d{6}$/;
const CM_RE = /^\d{6}-\d{6}$/;

// Type-ahead Client/Matter picker. value = cm object or null.
// onChange(cm). allowCreate shows a "New client/matter…" row.
// Search is one unified fuzzy query over client name/number + matter
// name/number (ranked server-side by /api/cms/picker).
export function CmPicker({ value, onChange, autoFocus, allowCreate = true, placeholder = 'Search client or matter…' }) {
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

  // Hierarchy shown per row: client (name, or number while unnamed) › matter.
  const renderItem = (cm, idx) => html`
    <div key=${cm.id} class=${'cmpicker-item' + (hover === idx ? ' hover' : '')}
      onMouseEnter=${() => setHover(idx)} onMouseDown=${(e) => { e.preventDefault(); pick(cm); }}>
      ${cm.favorite ? html`<span title="Favorite">★</span>` : null}
      ${clientLabel(cm) ? html`<span class="client" title=${clientLabel(cm)}>${clientLabel(cm)} ›</span>` : null}
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

// Kept export name/props: edit mode is unchanged; create mode is the new
// client→matter path (spec §3.4).
export function NewCmModal(props) {
  return props.existing
    ? html`<${EditCmModal} ...${props} />`
    : html`<${CreateMatterModal} ...${props} />`;
}

// ---------- edit (unchanged behavior from the old modal) ----------

function EditCmModal({ existing, onCreated, onClose }) {
  const [num, setNum] = useState(existing.cm_number);
  const [name, setName] = useState(existing.short_name);
  // Client name lives on the shared clients row, not the matter — only
  // offer it here when this row actually carries a client_id to PATCH.
  const hasClient = existing.client_id != null;
  const [clientName, setClientName] = useState(existing.client_name || '');
  const [taskBilling, setTaskBilling] = useState(existing.client_task_billing ?? 1);
  const [billable, setBillable] = useState(!!existing.billable);
  const [favorite, setFavorite] = useState(!!existing.favorite);
  const [error, setError] = useState(null);

  const valid = CM_RE.test(num);

  async function save(e) {
    e.preventDefault();
    setError(null);
    try {
      const body = { cm_number: num, short_name: name, billable: billable ? 1 : 0, favorite: favorite ? 1 : 0 };
      const cm = await api.patch(`/api/cms/${existing.id}`, body);
      const trimmedClientName = clientName.trim();
      if (hasClient && trimmedClientName !== (existing.client_name || '')) {
        await api.patch(`/api/clients/${existing.client_id}`, { name: trimmedClientName });
      }
      if (hasClient && (taskBilling ? 1 : 0) !== (existing.client_task_billing ?? 1)) {
        await api.patch(`/api/clients/${existing.client_id}`, { task_billing: taskBilling ? 1 : 0 });
      }
      emitToast('CM updated');
      onCreated(cm);
    } catch (err) {
      setError(err.message);
    }
  }

  return html`
    <${Modal} title="Edit client/matter" onClose=${onClose}>
      <form onSubmit=${save} class="grid">
        <${Field} label="CM number" hint="Format: 123456-123456">
          <input type="text" value=${num} maxLength=${13}
            onInput=${(e) => setNum(e.target.value.replace(/[^\d-]/g, ''))} />
        <//>
        ${hasClient ? html`
          <${Field} label="Client name" hint=${`Shared by every matter under client ${existing.client_number}`}>
            <input type="text" value=${clientName} placeholder="e.g. Meridian"
              onInput=${(e) => setClientName(e.target.value)} />
          <//>` : null}
        ${hasClient ? html`
          <label class="checkbox-row">
            <input type="checkbox" checked=${taskBilling} onChange=${(e) => setTaskBilling(e.target.checked)} />
            Task billing — narratives get per-task allocations like "(0.5)"
          </label>` : null}
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
          <button class="btn btn-primary" disabled=${!valid}>Save</button>
        </div>
      </form>
    <//>`;
}

// ---------- create: client → matter path ----------

function CreateMatterModal({ initialQ = '', onCreated, onClose }) {
  const digits = String(initialQ).replace(/\D/g, ''); // "100001-000012" → prefill both
  const [clients, setClients] = useState([]);
  const [clientQ, setClientQ] = useState(digits.slice(0, 6));
  const [picked, setPicked] = useState(null); // existing client chosen from the list
  const [clientName, setClientName] = useState('');
  const [listOpen, setListOpen] = useState(false);
  const [matterNum, setMatterNum] = useState(digits.slice(6, 12));
  const [name, setName] = useState(/^[\d\s-]*$/.test(initialQ) ? '' : initialQ);
  const [billable, setBillable] = useState(true);
  const [favorite, setFavorite] = useState(false);
  const [wantNew, setWantNew] = useState(false); // explicit "＋ New client…" mode
  const [error, setError] = useState(null);

  useEffect(() => { api.get('/api/clients').then(setClients).catch(() => {}); }, []);

  const ql = clientQ.trim().toLowerCase();
  const matches = (ql
    ? clients.filter((c) => c.client_number.includes(ql) || (c.name || '').toLowerCase().includes(ql))
    : clients).slice(0, 8);
  const exact = clients.find((c) => c.client_number === clientQ.trim()) || null;
  const effective = picked || exact; // existing client this matter will join
  const newNumber = !effective && SIX_RE.test(clientQ.trim()) ? clientQ.trim() : null;
  const clientNumber = effective ? effective.client_number : newNumber;
  const needsName = !!newNumber || (effective && !effective.name);
  // Brand-new client: name and number are entered together, as a locked pair.
  const valid = !!clientNumber && SIX_RE.test(matterNum.trim())
    && (!newNumber || clientName.trim() !== '');
  const qt = clientQ.trim();
  const qIsText = qt !== '' && !/^[\d\s-]+$/.test(qt);

  function startNewClient() {
    if (qIsText) { setClientName(qt); setClientQ(''); }
    setWantNew(true);
    setListOpen(false);
  }

  async function save(e) {
    e.preventDefault();
    setError(null);
    try {
      const body = {
        cm_number: `${clientNumber}-${matterNum.trim()}`,
        short_name: name, billable: billable ? 1 : 0, favorite: favorite ? 1 : 0,
      };
      if (needsName && clientName.trim()) body.client_name = clientName.trim();
      const cm = await api.post('/api/cms', body);
      emitToast(`CM ${cm.cm_number} created`);
      onCreated(cm);
    } catch (err) {
      setError(err.message);
    }
  }

  return html`
    <${Modal} title="New client/matter" onClose=${onClose}>
      <form onSubmit=${save} class="grid">
        <${Field} label="Client" hint=${effective
          ? `Existing client ${effective.client_number}${effective.name ? '' : ' (unnamed)'}`
          : newNumber ? `New client ${newNumber} — created together with this matter`
          : wantNew ? 'Now type the 6-digit client number'
          : 'Search by name or 6-digit number — or pick “＋ New client…” below'}>
          ${picked ? html`
            <button type="button" class="btn" style=${{ justifyContent: 'space-between' }} title="Change client"
              onClick=${() => { setPicked(null); setClientQ(''); setListOpen(true); }}>
              <span>${clientLabel(picked)}</span>
              <span class="muted mono small">${picked.client_number}</span>
            </button>` : html`
            <div class="cmpicker">
              <input type="search" data-nc-client value=${clientQ} autoFocus
                placeholder=${wantNew ? '6-digit client number' : 'e.g. Meridian or 100004'}
                onFocus=${() => setListOpen(true)}
                onInput=${(e) => { setClientQ(e.target.value); setListOpen(true); }}
                onBlur=${() => setTimeout(() => setListOpen(false), 150)} />
              ${listOpen && !exact && (matches.length > 0 || qt !== '') ? html`
                <div class="cmpicker-menu">
                  ${matches.map((c) => html`
                    <div key=${c.id} class="cmpicker-item"
                      onMouseDown=${(ev) => { ev.preventDefault(); setPicked(c); setListOpen(false); }}>
                      <span class="name">${clientLabel(c)}</span>
                      <span class="num">${c.client_number} · ${c.matter_count} matter${c.matter_count === 1 ? '' : 's'}</span>
                    </div>`)}
                  ${!wantNew ? html`
                    <div class="cmpicker-item" onMouseDown=${(ev) => { ev.preventDefault(); startNewClient(); }}>
                      <span class="name" style=${{ color: 'var(--accent)' }}>
                        ＋ New client${qIsText ? ` “${qt}”` : ''}…</span>
                    </div>` : null}
                </div>` : null}
            </div>`}
        <//>
        ${needsName || wantNew ? html`
          <${Field} label="Client name"
            hint=${newNumber || wantNew
              ? 'Required — saved together with the client number'
              : 'Optional — shown instead of the bare number everywhere'}>
            <input type="text" data-nc-client-name value=${clientName} placeholder="e.g. Meridian"
              onInput=${(e) => setClientName(e.target.value)} />
          <//>` : null}
        <${Field} label="Matter number" hint="6 digits">
          <input type="text" data-nc-matter value=${matterNum} placeholder="000012" maxLength=${6}
            onInput=${(e) => setMatterNum(e.target.value.replace(/\D/g, ''))} />
        <//>
        <${Field} label="Short name" hint="Your own shorthand — searchable">
          <input type="text" data-nc-name value=${name} onInput=${(e) => setName(e.target.value)} />
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
          <button class="btn btn-primary" disabled=${!valid}>Create matter</button>
        </div>
      </form>
    <//>`;
}
