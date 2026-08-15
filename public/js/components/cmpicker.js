import { api } from '/js/api.js';
import {
  html, React, useState, useEffect, useRef, Field, Modal, emitToast, clientLabel,
} from '/js/ui.js';
import { useDismissLayer } from '/js/components/overlay.js';

const SIX_RE = /^\d{6}$/;
const CM_RE = /^\d{6}-\d{6}$/;

// A DOM id is a document-wide fact and there can be two pickers on one screen
// (the entry editor's, and the ledger filter's), so the ids that wire the
// combobox together come from React's own id generator. The colons React puts
// in them are legal in an id attribute and legal in getElementById, but they
// are not legal in a CSS selector without escaping, so they come out here.
const uid = () => React.useId().replace(/:/g, '');

// Type-ahead Client/Matter picker. value = cm object or null.
// onChange(cm). allowCreate shows a "New client/matter…" row.
// Search is one unified fuzzy query over client name/number + matter
// name/number (ranked server-side by /api/cms/picker).
//
// THE ARIA 1.2 COMBOBOX PATTERN, on the app's most-used control.
// Measured on the open picker before this: the input had no role, no
// aria-expanded, no aria-controls, no aria-activedescendant and no
// aria-autocomplete; the menu had no role and no id; all six rows had no role,
// no aria-selected and no id, so querySelectorAll('[role="option"]').length was
// 0. A screen-reader user typing into it heard a plain text field that appeared
// to do nothing while six results came and went underneath.
//
// The pattern (component-notes §9, and the same one cmdk/Linear/Raycast build
// on): ONE text input keeps real DOM focus at all times; the arrow keys move a
// VIRTUAL cursor — aria-activedescendant pointing at the option's id — rather
// than moving focus onto the rows, which is what lets the input go on receiving
// keystrokes while the list filters underneath. Moving real focus into the list
// is the single most common command-palette accessibility bug; it is not what
// this does, and `hover` was already the virtual cursor. It just had no name
// assistive technology could read.
export function CmPicker({ value, onChange, autoFocus, allowCreate = true, placeholder = 'Search client or matter…' }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState([]);
  const [hover, setHover] = useState(0);
  const [creating, setCreating] = useState(false);
  const boxRef = useRef(null);
  const id = uid();
  const listId = `${id}-list`;
  const optId = (i) => `${id}-opt-${i}`;

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

  // The open listbox is a LAYER, not a detail of the input. Registering it with
  // the overlay primitive is what makes the first Escape close just this list
  // and leave the entry editor standing (see the dismissal stack in
  // components/overlay.js); it is also why onKey below has no Escape branch —
  // the dialog's own capture listener always beat it to the key.
  useDismissLayer(open, () => setOpen(false), boxRef);

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
    }
    // Escape is not handled here — useDismissLayer above owns it.
  }

  const favorites = items.filter((c) => c.favorite);
  const rest = items.filter((c) => !c.favorite);
  // How many rows the cursor can land on, and therefore whether there is an
  // active option to point aria-activedescendant at. An empty result set with
  // no "New…" row has no cursor, so the attribute is omitted rather than
  // pointing at an id that does not exist.
  const optionCount = items.length + (allowCreate ? 1 : 0);
  const activeId = open && optionCount > 0 && hover < optionCount ? optId(hover) : undefined;

  // Hierarchy shown per row: client (name, or number while unnamed) › matter.
  // aria-selected marks the row the virtual cursor is on — the one Enter takes
  // — so the visual highlight and the announced state cannot drift apart.
  const renderItem = (cm, idx) => html`
    <div key=${cm.id} id=${optId(idx)} role="option" aria-selected=${hover === idx}
      class=${'cmpicker-item' + (hover === idx ? ' hover' : '')}
      onMouseEnter=${() => setHover(idx)} onMouseDown=${(e) => { e.preventDefault(); pick(cm); }}>
      ${cm.favorite ? html`<span title="Favorite">★</span>` : null}
      ${clientLabel(cm) ? html`<span class="client" title=${clientLabel(cm)}>${clientLabel(cm)}</span>` : null}
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
          role="combobox" aria-expanded=${open ? 'true' : 'false'}
          aria-controls=${open ? listId : undefined}
          aria-activedescendant=${activeId}
          aria-autocomplete="list" aria-haspopup="listbox"
          autoComplete="off" autoCorrect="off" spellCheck=${false}
          onFocus=${() => setOpen(true)}
          onInput=${(e) => { setQ(e.target.value); setOpen(true); }}
          onKeyDown=${onKey} />`}
      ${open ? html`
        ${/* The rows are grouped, so a screen reader hears "Favorites, 2 items"
              rather than one undifferentiated run of results. A listbox may own
              options and groups; the visible section heading names its group
              through aria-labelledby instead of being a stray text node inside
              the list. */''}
        <div class="cmpicker-menu" id=${listId} role="listbox" aria-label=${placeholder}>
          ${favorites.length ? html`
            <div role="group" aria-labelledby=${`${id}-g-fav`}>
              <div class="cmpicker-section" id=${`${id}-g-fav`}>Favorites</div>
              ${favorites.map((cm) => renderItem(cm, items.indexOf(cm)))}
            </div>` : null}
          ${favorites.length && rest.length ? html`
            <div role="group" aria-labelledby=${`${id}-g-rest`}>
              <div class="cmpicker-section" id=${`${id}-g-rest`}>Recent & all</div>
              ${rest.map((cm) => renderItem(cm, items.indexOf(cm)))}
            </div>` : null}
          ${!favorites.length ? rest.map((cm) => renderItem(cm, items.indexOf(cm))) : null}
          ${items.length === 0 ? html`
            <div class="cmpicker-item muted" role="presentation">No matches</div>` : null}
          ${allowCreate ? html`
            <div id=${optId(items.length)} role="option" aria-selected=${hover === items.length}
              class=${'cmpicker-item' + (hover === items.length ? ' hover' : '')}
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
  // New clients start block-billed: task lines are the exception, so a matter
  // created in a hurry must not silently demand them at finalize time.
  const [taskBilling, setTaskBilling] = useState(false);
  const [wantNew, setWantNew] = useState(false); // explicit "＋ New client…" mode
  const [error, setError] = useState(null);
  const clientBoxRef = useRef(null);
  // The client list is the same combobox pattern as CmPicker above. It starts
  // with the cursor OFF the list (-1) rather than on the first row, because
  // this input sits inside a <form> where Enter means "submit" until the user
  // has actually arrowed into the results — a keyboard user typing a six-digit
  // client number and pressing Enter must still get the form's own behaviour.
  const [hoverC, setHoverC] = useState(-1);
  const cid = uid();
  const clientListId = `${cid}-list`;
  const clientOptId = (i) => `${cid}-opt-${i}`;

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
  // Same layer rule as CmPicker's own listbox: while this dialog's client list
  // is down, Escape closes the LIST. A half-filled new-matter form is not
  // something to lose to a keystroke aimed at a dropdown.
  const clientListOpen = listOpen && !exact && (matches.length > 0 || qt !== '');
  useDismissLayer(clientListOpen, () => setListOpen(false), clientBoxRef);

  // Show the existing client's own setting once one is chosen, so the checkbox
  // never claims a matter is block-billed when its client is task-billed.
  useEffect(() => {
    if (effective) setTaskBilling(!!effective.task_billing);
  }, [effective ? effective.id : null]);

  function startNewClient() {
    if (qIsText) { setClientName(qt); setClientQ(''); }
    setWantNew(true);
    setListOpen(false);
  }

  // Every row in this list used to be a bare <div> with a mousedown handler:
  // reachable by pointer, unreachable by keyboard, and invisible to a screen
  // reader. Arrow keys move the same virtual cursor CmPicker uses.
  const clientRows = matches.length + (wantNew ? 0 : 1);
  function onClientKey(e) {
    if (!clientListOpen) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHoverC((h) => Math.min(h + 1, clientRows - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHoverC((h) => Math.max(h - 1, -1));
    } else if (e.key === 'Enter' && hoverC >= 0) {
      e.preventDefault();
      if (hoverC < matches.length) { setPicked(matches[hoverC]); setListOpen(false); }
      else startNewClient();
    }
    // Escape is not handled here — useDismissLayer above owns it.
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
      body.client_task_billing = taskBilling ? 1 : 0;
      const cm = await api.post('/api/cms', body);
      // The server only honors client_task_billing for a client it just
      // created; an existing client takes a deliberate PATCH instead.
      if (effective && (taskBilling ? 1 : 0) !== (effective.task_billing ?? 1)) {
        await api.patch(`/api/clients/${effective.id}`, { task_billing: taskBilling ? 1 : 0 });
        cm.client_task_billing = taskBilling ? 1 : 0;
      }
      emitToast(`CM ${cm.cm_number} created`);
      onCreated(cm);
    } catch (err) {
      setError(err.message);
    }
  }

  return html`
    <${Modal} title="New client/matter" onClose=${onClose}>
      <form onSubmit=${save} class="grid">
        <${Field} label="Client number" hint=${effective
          ? `Existing client ${effective.client_number}${effective.name ? '' : ' (unnamed)'}`
          : newNumber ? `New client ${newNumber} — created together with this matter`
          : wantNew ? 'Now type the 6-digit client number'
          : 'Type the 6-digit number — or type a name to search existing clients'}>
          ${picked ? html`
            <button type="button" class="btn" style=${{ justifyContent: 'space-between' }} title="Change client"
              onClick=${() => { setPicked(null); setClientQ(''); setListOpen(true); }}>
              <span>${clientLabel(picked)}</span>
              <span class="muted mono small">${picked.client_number}</span>
            </button>` : html`
            <div class="cmpicker" ref=${clientBoxRef}>
              <input type="search" data-nc-client value=${clientQ} autoFocus
                placeholder=${wantNew ? '6-digit client number' : 'e.g. 100004 — or a name to search'}
                role="combobox" aria-expanded=${clientListOpen ? 'true' : 'false'}
                aria-controls=${clientListOpen ? clientListId : undefined}
                aria-activedescendant=${clientListOpen && hoverC >= 0 ? clientOptId(hoverC) : undefined}
                aria-autocomplete="list" aria-haspopup="listbox"
                autoComplete="off" autoCorrect="off" spellCheck=${false}
                onFocus=${() => setListOpen(true)}
                onInput=${(e) => { setClientQ(e.target.value); setListOpen(true); setHoverC(-1); }}
                onKeyDown=${onClientKey}
                onBlur=${() => setTimeout(() => setListOpen(false), 150)} />
              ${clientListOpen ? html`
                <div class="cmpicker-menu" id=${clientListId} role="listbox" aria-label="Existing clients">
                  ${matches.map((c, i) => html`
                    <div key=${c.id} id=${clientOptId(i)} role="option" aria-selected=${hoverC === i}
                      class=${'cmpicker-item' + (hoverC === i ? ' hover' : '')}
                      onMouseEnter=${() => setHoverC(i)}
                      onMouseDown=${(ev) => { ev.preventDefault(); setPicked(c); setListOpen(false); }}>
                      <span class="name">${clientLabel(c)}</span>
                      <span class="num">${c.client_number} · ${c.matter_count} matter${c.matter_count === 1 ? '' : 's'}</span>
                    </div>`)}
                  ${!wantNew ? html`
                    <div id=${clientOptId(matches.length)} role="option" aria-selected=${hoverC === matches.length}
                      class=${'cmpicker-item' + (hoverC === matches.length ? ' hover' : '')}
                      onMouseEnter=${() => setHoverC(matches.length)}
                      onMouseDown=${(ev) => { ev.preventDefault(); startNewClient(); }}>
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
          <input type="checkbox" data-nc-task-billing checked=${taskBilling}
            onChange=${(e) => setTaskBilling(e.target.checked)} />
          Task billing — this client needs task lines and allocations like "(0.5)"
          ${effective ? html`<span class="muted small"> · applies to every matter under ${effective.client_number}</span>` : null}
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
