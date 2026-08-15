import { api, downloadText } from '/js/api.js';
import {
  html, useState, useEffect, useRef, useAsync, Spinner, ErrorBox, emitToast, BillableBadge,
  fmtStamp, Icon, clientLabel, React, createPortal, Overlay, Confirm,
} from '/js/ui.js';
import { useDismissLayer } from '/js/components/overlay.js';
import { NewCmModal } from '/js/components/cmpicker.js';
import { CustomFieldsModal } from '/js/components/customfields.js';
import { TimerImport } from '/js/components/timerimport.js';
import { EmptyState } from '/js/components/entrylist.js';

// CLIENTS & MATTERS — reference data, not a daily destination.
//
// Teardown §14/§A: "matters are configured once and used constantly through the
// CM picker… it does not deserve a top-level slot when starting a timer does
// not have one." So this is a SECTION of Settings now (`#/settings/cms`, with
// `#/cms` canonicalised onto it by app.js's route table) rather than a screen.
// `CmsSection` is the part Settings renders; `CmsView` is the old whole-page
// shape, kept so any caller that still mounts a page gets a page.
//
// Two other findings from the same section are answered here:
//
//   ROW ACTIONS (§14 form, E8). Four unlabelled trailing icons per matter row
//   (gear / pencil / archive / trash) plus a leading star became: the star
//   inline — the one action worth a permanent slot — the matter NAME as the
//   edit affordance (Primer ActionList: the row opens the record), and one
//   labelled "⋯" carrying custom fields, archive/restore and delete.
//
//   THE PHONE (§14 mobile, E10). "The table is 741px inside a 356px scroller.
//   All four action icons and the Last used column are off-screen; you must
//   scroll a nested table sideways by 385px — more than the visible width — to
//   archive a matter." The markup is unchanged (so every selector still works)
//   and `table-cards` restacks each row into a two-line card below 768px:
//   line 1 is star · name · ⋯, line 2 is number · billing · entries · last
//   used. No horizontal scroller, nothing off-screen.
//
//   THE MENU BEHIND THE ⋯ (this wave). Moving five capabilities behind an
//   overflow only works if the overflow itself does. See ActionMenu below.

export function CmsView(props) {
  return html`
    <${React.Fragment}>
      <div class="page-head"><h1>Clients & Matters</h1></div>
      <${CmsSection} ...${props} />
    <//>`;
}

export function CmsSection({ refreshKey, bumpRefresh }) {
  const [q, setQ] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [editing, setEditing] = useState(null); // 'new' | cm
  const [fieldsFor, setFieldsFor] = useState(null); // { owner: {client_id}|{matter_id}, title }
  const [importing, setImporting] = useState(false);
  const [menu, setMenu] = useState(null); // { anchor, cm } | { anchor, group } | { anchor, list }
  const [deleting, setDeleting] = useState(null);

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
        client_name: cm.client_name, task_billing: cm.client_task_billing ?? 1,
        matters: [],
      });
    }
    byClient.get(key).matters.push(cm);
  }
  const clientGroups = [...byClient.values()].sort((a, b) =>
    (clientLabel(a) || '').localeCompare(clientLabel(b) || '', undefined, { sensitivity: 'base' }));

  const after = async () => { await reload(); bumpRefresh(); };

  async function toggleFavorite(cm) {
    await api.patch(`/api/cms/${cm.id}`, { favorite: cm.favorite ? 0 : 1 });
    reload();
  }

  async function toggleArchive(cm) {
    await api.patch(`/api/cms/${cm.id}`, { status: cm.status === 'archived' ? 'active' : 'archived' });
    emitToast(cm.status === 'archived' ? 'Restored to active' : 'Archived — hidden from pickers, entries kept');
    after();
  }

  // Client-level: narratives on this client's matters carry per-task
  // allocations. It lives on the clients row, so the client group header is
  // where it belongs; the matter Edit dialog still offers it too.
  async function toggleTaskBilling(g) {
    await api.patch(`/api/clients/${g.client_id}`, { task_billing: g.task_billing ? 0 : 1 });
    emitToast(g.task_billing ? 'Task billing off for this client' : 'Task billing on for this client');
    after();
  }

  // Roster export — always the full list (archived included), regardless of the
  // filter box or the "show archived" checkbox. Those two shape the screen; the
  // file is the reference document.
  async function exportCsv() {
    try {
      const r = await api.get('/api/cms/export');
      downloadText('client-matters.csv', r.csv);
      emitToast(`Exported ${r.count} client-matter${r.count === 1 ? '' : 's'}`);
    } catch (e) {
      emitToast(e.message, { error: true });
    }
  }

  async function del(cm) {
    try {
      await api.del(`/api/cms/${cm.id}`);
      emitToast('CM deleted');
      after();
    } catch (e) {
      emitToast(e.message, { error: true });
    }
  }

  const openFields = (owner, title) => setFieldsFor({ owner, title });

  const matterMenuItems = (cm) => [
    { label: 'Edit matter…', icon: 'edit', onClick: () => setEditing(cm) },
    {
      label: 'Custom fields…',
      icon: 'settings',
      onClick: () => openFields({ matter_id: cm.id }, `Custom fields — ${cm.short_name || cm.cm_number}`),
    },
    {
      label: cm.status === 'archived' ? 'Restore to active' : 'Archive matter',
      icon: cm.status === 'archived' ? 'archiveRestore' : 'archive',
      onClick: () => toggleArchive(cm),
    },
    { hr: true },
    {
      // A disabled row that says WHY: deleting a matter with recorded time is
      // refused by the server, and "archive instead" is the real answer.
      label: cm.entry_count > 0
        ? `Delete — ${cm.entry_count} entr${cm.entry_count === 1 ? 'y' : 'ies'} recorded, archive instead`
        : 'Delete matter',
      icon: 'trash',
      danger: true,
      disabled: cm.entry_count > 0,
      onClick: () => setDeleting(cm),
    },
  ];

  const clientMenuItems = (g) => [
    {
      label: 'Custom fields for every matter…',
      icon: 'settings',
      onClick: () => openFields({ client_id: g.client_id },
        `Custom fields — client ${clientLabel(g) || g.client_number}`),
    },
    {
      label: g.task_billing ? 'Turn off task billing' : 'Turn on task billing',
      icon: g.task_billing ? 'x' : 'check',
      onClick: () => toggleTaskBilling(g),
    },
  ];

  const listMenuItems = () => [
    { label: 'Import matters from CSV…', icon: 'download', onClick: () => setImporting(true) },
    { label: 'Download matter list (CSV)', icon: 'export', onClick: exportCsv },
  ];

  // The trigger itself is what the menu anchors to and what focus goes back to
  // when it closes, so it is what gets stored — not a pair of coordinates.
  const openMenu = (ev, payload) => setMenu({ anchor: ev.currentTarget, ...payload });

  // A sheet covers the row you tapped, so it has to name its subject.
  const menuTitle = !menu ? ''
    : menu.cm ? (menu.cm.short_name || menu.cm.cm_number)
      : menu.group ? (clientLabel(menu.group) || `Client ${menu.group.client_number}`)
        : 'Matter list';
  const menuItems = !menu ? []
    : menu.cm ? matterMenuItems(menu.cm)
      : menu.group ? clientMenuItems(menu.group)
        : listMenuItems();

  const matterCount = rows.length;
  const clientCount = clientGroups.length;

  return html`
    <section class="card set-card cms-card">
      <div class="set-card-head">
        <div class="set-card-title">
          <h2>Clients & matters</h2>
          <p class="set-card-sub">
            ${matterCount} matter${matterCount === 1 ? '' : 's'} ·
            ${' '}${clientCount} client${clientCount === 1 ? '' : 's'}${showArchived ? ' · archived included' : ''}
          </p>
        </div>
        <div class="set-card-actions">
          <button class="btn btn-primary" onClick=${() => setEditing('new')}>
            <${Icon} name="plus" size=${16} /> New matter
          </button>
          <button class="btn btn-icon cms-more" title="More matter-list actions"
            aria-label="More matter-list actions" aria-haspopup="menu"
            onClick=${(ev) => openMenu(ev, { list: true })}>
            <${Icon} name="moreV" size=${18} />
          </button>
        </div>
      </div>

      <div class="cms-filters">
        <div class="cms-search">
          <${Icon} name="search" size=${16} className="cms-search-icon" />
          <input type="search" aria-label="Filter matters"
            placeholder="Filter by client, number, or name…" value=${q}
            onInput=${(e) => setQ(e.target.value)} />
        </div>
        <button type="button" class="btn btn-sm set-chip"
          aria-pressed=${showArchived ? 'true' : 'false'}
          onClick=${() => setShowArchived((v) => !v)}>
          <${Icon} name="archive" size=${14} /> Show archived
        </button>
      </div>

      ${error ? html`<${ErrorBox} error=${error} />`
        : loading && !data ? html`<${Spinner} />`
          : clientGroups.length === 0 ? html`
            <${EmptyState} icon="briefcase"
              heading=${q ? 'No matter matches that filter' : 'No clients or matters yet'}
              description=${q
                ? 'Nothing here matches what you typed. Clear the filter to see the whole list, or create the matter you were looking for.'
                : 'Matters are the list every timer, entry and export picks from. Create the first one, or import a roster from a CSV your firm already has.'}
              actionLabel=${q ? 'Clear the filter' : 'New matter'}
              onAction=${q ? () => setQ('') : () => setEditing('new')}
              secondaryLabel=${q ? null : 'Import from CSV…'}
              onSecondary=${q ? null : () => setImporting(true)} />`
            : html`
        <div class="table-wrap table-cards cms-table">
          <table class="tk">
            <thead><tr>
              <th style=${{ width: '34px' }}></th>
              <th>CM number</th><th>Matter</th>
              <th>Default</th><th>Entries</th><th>Last used</th>
              <th></th>
            </tr></thead>
            <tbody>
              ${clientGroups.map((g) => html`
                <${React.Fragment} key=${g.client_id ?? g.matters[0].id}>
                  <tr class="client-row">
                    <td></td>
                    <td class="mono"><span class="muted small">Client</span> ${g.client_number || '—'}</td>
                    <td colSpan="5">
                      <div class="client-row-inner">
                        <${ClientNameCell} group=${g} onSaved=${after} />
                        ${g.task_billing
                          ? html`<span class="chip" title="Narratives on this client carry per-task allocations">task billing</span>`
                          : null}
                        ${/* One flex item, so the pair never splits across two
                              lines. Below 768px the labelled Fields button
                              stands down — the same capability is the first
                              item of the "⋯" menu beside it, which is the only
                              one of the two a thumb needs. */''}
                        ${g.client_id != null ? html`
                          <span class="client-row-tools">
                            <button class="btn btn-ghost btn-sm cms-fields-btn"
                              title="Custom fields for every matter under this client"
                              onClick=${() => openFields({ client_id: g.client_id },
                                `Custom fields — client ${clientLabel(g) || g.client_number}`)}>
                              <${Icon} name="settings" size=${14} /> Fields
                            </button>
                            <button class="btn btn-icon btn-ghost btn-sm"
                              title="More actions for this client" aria-haspopup="menu"
                              aria-label=${`More actions for client ${clientLabel(g) || g.client_number}`}
                              onClick=${(ev) => openMenu(ev, { group: g })}>
                              <${Icon} name="moreV" size=${16} />
                            </button>
                          </span>` : null}
                      </div>
                    </td>
                  </tr>
                  ${g.matters.map((cm) => html`
                    <tr key=${cm.id} class=${'cm-row' + (cm.status === 'archived' ? ' cm-archived' : '')}>
                      <td>
                        <button class=${'star' + (cm.favorite ? ' on' : '')}
                          title=${cm.favorite ? 'Remove from favourites' : 'Add to favourites'}
                          aria-pressed=${cm.favorite ? 'true' : 'false'}
                          aria-label=${`Favourite ${cm.short_name || cm.cm_number}`}
                          onClick=${() => toggleFavorite(cm)}>★</button>
                      </td>
                      <td class="mono cm-number">${cm.cm_number}</td>
                      <td class="cm-name-cell">
                        ${/* the row's own open affordance — Primer ActionList's
                              "the row opens the record", and the reason the
                              pencil could leave the row */''}
                        <button class="cm-name" title="Edit"
                          aria-label=${`Edit ${cm.short_name || cm.cm_number}`}
                          onClick=${() => setEditing(cm)}>${cm.short_name || cm.cm_number}</button>
                        ${cm.status === 'archived' ? html`<span class="chip">archived</span>` : ''}
                      </td>
                      <td><${BillableBadge} billable=${cm.billable} /></td>
                      <td class="mono cm-entries">${cm.entry_count ?? 0}<span class="cm-unit">
                        ${(cm.entry_count ?? 0) === 1 ? ' entry' : ' entries'}</span></td>
                      <td class="small muted cm-used">${cm.last_used_at ? fmtStamp(cm.last_used_at) : '—'}</td>
                      <td class="cm-actions">
                        <button class="btn btn-icon btn-ghost btn-sm"
                          title="More actions for this matter" aria-haspopup="menu"
                          aria-label=${`More actions for ${cm.short_name || cm.cm_number}`}
                          onClick=${(ev) => openMenu(ev, { cm })}>
                          <${Icon} name="moreV" size=${16} />
                        </button>
                      </td>
                    </tr>`)}
                <//>`)}
            </tbody>
          </table>
        </div>`}
    </section>

    ${menu ? html`
      <${ActionMenu} anchor=${menu.anchor} title=${menuTitle} items=${menuItems}
        onClose=${() => setMenu(null)} />` : null}

    ${editing ? html`
      <${NewCmModal} existing=${editing === 'new' ? null : editing}
        onCreated=${() => { setEditing(null); after(); }}
        onClose=${() => setEditing(null)} />` : null}
    ${fieldsFor ? html`
      <${CustomFieldsModal} owner=${fieldsFor.owner} title=${fieldsFor.title}
        onClose=${() => { setFieldsFor(null); bumpRefresh(); }} />` : null}
    ${importing ? html`
      <${TimerImport} onDone=${() => { setImporting(false); after(); }}
        onClose=${() => setImporting(false)} />` : null}
    ${deleting ? html`
      <${Confirm} title="Delete matter" danger confirmLabel="Delete"
        message=${`Delete ${deleting.short_name || deleting.cm_number}? It has no entries, so nothing recorded is lost — but the number goes with it.`}
        onConfirm=${() => del(deleting)}
        onClose=${() => setDeleting(null)} />` : null}
  `;
}

// ---------------------------------------------------------------------------
// THE ROW OVERFLOW — one menu, two real shapes
// ---------------------------------------------------------------------------
//
// E8 moved five capabilities behind a "⋯" here, which is only an improvement if
// the thing behind the ⋯ works. The critic measured the shared `ContextMenu`
// this file used to call and found it did not:
//
//   * every row in it is 28 CSS px tall (measured at 390×844: matter rows
//     291×28, client rows 239×28, header rows 230×28) while the triggers are a
//     correct 44×44 — so the ONLY touch path to Edit matter, Custom fields,
//     Archive matter, Turn off task billing, Import matters from CSV and
//     Download matter list was half the touch floor. The --strict fence never
//     saw it, because it photographs the page at rest and never opens a menu.
//   * it declares `role="menu"` and does no focus management: Enter on the ⋯
//     opened it with focus still on the trigger, ArrowDown did nothing, and Tab
//     walked on to the NEXT ROW's favourite star with the menu still standing.
//     A keyboard user could open the menu and never reach an item in it.
//
// So this area brings its own, built to the shape each pointer actually wants —
// the same split the section switcher above it makes, and the same one the
// overlay primitive makes for dialogs:
//
//   below 768px  a modal bottom sheet through the SHARED Overlay primitive, so
//                the scrim, the focus trap, the scroll lock, Escape, the
//                grabber and the safe-area inset all come from the one place
//                they live. Rows are 48px (Material 3's list-item-in-a-sheet),
//                titled with the matter or client they act on — because a sheet
//                covers the row you tapped and has to say what it is about.
//   at ≥768px    an anchored popover on the WAI-ARIA menu-button pattern
//                (Primer ActionMenu, Polaris ActionList): focus moves to the
//                first enabled item on open, ↑/↓ wrap, Home/End jump, Esc or
//                Tab closes and hands focus back to the ⋯ that opened it.
//
// It also measures itself before it paints. The shared menu's clamp assumed
// 34px rows, so any change to row height could push a menu opened near the
// bottom of the window off the screen; this one asks the DOM how tall it is and
// flips above its trigger when it has to.
//
// `items` is the same shape ContextMenu takes — {label, icon?, onClick,
// disabled?, danger?, hr?} — so the three menus above are unchanged.

const PHONE_Q = '(max-width: 767px)';

function useIsPhone() {
  const [phone, setPhone] = useState(
    () => !!(window.matchMedia && window.matchMedia(PHONE_Q).matches));
  useEffect(() => {
    if (!window.matchMedia) return undefined;
    const mq = window.matchMedia(PHONE_Q);
    const on = () => setPhone(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return phone;
}

function ActionMenu(props) {
  const phone = useIsPhone();
  return phone ? html`<${ActionSheet} ...${props} />` : html`<${ActionPopover} ...${props} />`;
}

function ActionSheet({ title, items, onClose }) {
  return html`
    <${Overlay} title=${title} size="sm" className="act-sheet" onClose=${() => onClose()}>
      <div class="act-list">
        ${items.map((item, i) => (item.hr
          ? html`<div key=${i} class="act-sep" role="separator"></div>`
          : html`
            <button key=${i} type="button" disabled=${item.disabled}
              class=${'act-row' + (item.danger ? ' danger' : '')}
              onClick=${() => { onClose(); item.onClick(); }}>
              <span class="act-ico">
                ${item.icon ? html`<${Icon} name=${item.icon} size=${18} />` : null}
              </span>
              <span class="act-label">${item.label}</span>
            </button>`))}
      </div>
    <//>`;
}

function ActionPopover({ items, anchor, onClose }) {
  const ref = useRef(null);
  const [pos, setPos] = useState(null);

  // Escape goes through the shared dismissal stack rather than a private
  // listener, so a menu opened from inside a dialog still closes itself first
  // and leaves the dialog standing (overlay.js, useDismissLayer).
  useDismissLayer(true, () => onClose(), ref);

  // First paint is anchored from the trigger alone — the menu has to be on
  // screen and focusable before it can be measured. The layout effect below
  // then corrects it, before the browser paints, so nothing flashes.
  const guess = useRef(null);
  if (!guess.current) {
    const r = anchor ? anchor.getBoundingClientRect() : { right: 280, bottom: 8 };
    guess.current = { left: Math.max(8, r.right - 264), top: r.bottom + 4 };
  }

  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !anchor) return;
    const r = anchor.getBoundingClientRect();
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const PAD = 8;
    const left = Math.min(Math.max(PAD, r.right - w), Math.max(PAD, window.innerWidth - w - PAD));
    const below = r.bottom + 4;
    const above = r.top - h - 4;
    const top = below + h <= window.innerHeight - PAD ? below
      : above >= PAD ? above
        : Math.max(PAD, window.innerHeight - h - PAD);
    setPos((p) => (p && p.left === left && p.top === top ? p : { left, top }));
  }, [anchor, items.length]);

  // The menu-button contract: focus in on open, focus back to the trigger on
  // close, however it closed.
  useEffect(() => {
    const el = ref.current;
    const first = el && el.querySelector('.act-item:not([disabled])');
    if (first || el) (first || el).focus({ preventScroll: true });
    return () => {
      if (anchor && anchor.isConnected && typeof anchor.focus === 'function') {
        anchor.focus({ preventScroll: true });
      }
    };
  }, []);

  useEffect(() => {
    const away = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose(); };
    document.addEventListener('mousedown', away);
    document.addEventListener('contextmenu', away);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('contextmenu', away);
    };
  }, [onClose]);

  const onKeyDown = (e) => {
    const el = ref.current;
    if (!el) return;
    const rows = [...el.querySelectorAll('.act-item:not([disabled])')];
    if (rows.length === 0) return;
    const i = rows.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); rows[i < 0 ? 0 : (i + 1) % rows.length].focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); rows[i <= 0 ? rows.length - 1 : i - 1].focus(); }
    else if (e.key === 'Home') { e.preventDefault(); rows[0].focus(); }
    else if (e.key === 'End') { e.preventDefault(); rows[rows.length - 1].focus(); }
    // Tab out of a menu closes it (Primer, Polaris, WAI-ARIA APG all agree) —
    // it must never leave an open menu behind while focus walks the page.
    else if (e.key === 'Tab') { e.preventDefault(); onClose(); }
  };

  const p = pos || guess.current;
  return createPortal(html`
    <div class="act-menu" ref=${ref} role="menu" aria-orientation="vertical" tabIndex=${-1}
      style=${{ left: `${p.left}px`, top: `${p.top}px` }} onKeyDown=${onKeyDown}>
      ${items.map((item, i) => (item.hr
        ? html`<div key=${i} class="act-sep" role="separator"></div>`
        : html`
          <button key=${i} type="button" role="menuitem" tabIndex=${-1}
            class=${'act-item' + (item.danger ? ' danger' : '')}
            disabled=${item.disabled}
            onClick=${() => { onClose(); item.onClick(); }}>
            <span class="act-ico">
              ${item.icon ? html`<${Icon} name=${item.icon} size=${16} />` : null}
            </span>
            <span class="act-label">${item.label}</span>
          </button>`))}
    </div>`, document.body);
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
