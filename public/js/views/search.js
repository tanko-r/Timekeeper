// THE ENTRIES LEDGER — every entry ever recorded, filterable, bulk-editable,
// exportable. Formerly "Search".
//
// The teardown (§10, §A) found that this screen was mis-named into invisibility:
// with empty filters it is already "all 23 entries · 44.8h", i.e. the app's
// ledger and its ONLY bulk-edit surface, and calling it Search hid both facts.
// It also found Export (§12) to be this same list with two extra columns and
// three download buttons, on its own top-level destination and its own phone
// bottom-bar slot, for a job done once a day.
//
// So this file owns the ledger, and exports the pieces Export reuses:
//
//   LedgerHead        the page header + the one figure-of-the-moment
//   RangeControls     presets + From/To — one range vocabulary for both modes
//   LedgerSelection   the selection bar and every bulk action, with a touch path
//   LedgerTable       THE row renderer, shared by both modes, cards on a phone
//
// views/exportview.js is now a thin surface over those four: same head, same
// rows, same bulk actions, different filters and its own download actions.
// Nothing about the export deep-link contract changed — see the route table in
// app.js; #/export[/<filter>[/<from>]] still lands on the export surface with
// its filter and its start date applied.
import { api } from '/js/api.js';
import {
  html, React, useState, useEffect, useRef, useAsync, Spinner, ErrorBox, Icon,
  fmtHours, fmtStamp, todayStr, addDays, emitToast, markJustFinalized,
  BillableBadge, StatusChip, Modal, Confirm, ContextMenu,
} from '/js/ui.js';
import { CmPicker } from '/js/components/cmpicker.js';
// The dashboard's row component owns both of these, and they are the reason
// this list is not a second implementation of "an entry": InlineNarrative is
// the app's fastest narrative path (click the text, edit in place, ghost-text
// completion, shortcut expansion) and EmptyState is Primer's Blankslate
// anatomy. A ledger row is a different shape from a dashboard row — it carries
// a date, a selection box and an export stamp, and it never carries a timer —
// but everything the two rows genuinely share comes from there, not from here.
import { EmptyState, InlineNarrative } from '/js/components/entrylist.js';

// ---------------------------------------------------------------------------
// The one figure of the moment. Mercury's big-number/small-decimal treatment
// (reference-analysis §1, §4): magnitude reads before precision. Used exactly
// once per screen — the ledger's answer to "how much time does this filter
// select?".
// ---------------------------------------------------------------------------
function Figure({ hours, increment }) {
  const s = fmtHours(hours || 0, increment);
  const dot = s.indexOf('.');
  return html`
    <span class="ledger-figure">
      <span class="ledger-figure-num">
        ${dot < 0 ? s : s.slice(0, dot)}
        ${dot < 0 ? null : html`<span class="ledger-figure-dec">${s.slice(dot)}</span>`}
      </span>
      <span class="ledger-figure-unit">h</span>
    </span>`;
}

// The shared page header: title, the screen's actions (right, one primary
// last — .page-head-actions gives that its phone layout for free), and the
// figure on its own line below.
export function LedgerHead({ title, count, hours, increment, note, actions }) {
  return html`
    <div class="page-head ledger-head">
      <h1>${title}</h1>
      <div class="spacer"></div>
      ${actions ? html`<div class="page-head-actions">${actions}</div>` : null}
      <div class="page-head-tools ledger-figures">
        <${Figure} hours=${hours} increment=${increment} />
        <span class="ledger-figure-cap">
          ${count} ${count === 1 ? 'entry' : 'entries'}${note ? ` · ${note}` : ''}
        </span>
      </div>
    </div>`;
}

// ---------------------------------------------------------------------------
// Date range — one vocabulary, both modes. The presets are the fast path and
// the two inputs are the ground truth; shell.css's .filter-presets /
// .date-range own the responsive grouping (a group may wrap, the things inside
// one never wrap away from each other).
// ---------------------------------------------------------------------------
export const RANGE_PRESETS = [
  ['Today', () => [todayStr(), todayStr()]],
  ['Yesterday', () => [addDays(todayStr(), -1), addDays(todayStr(), -1)]],
  ['This week', () => {
    const t = todayStr();
    return [addDays(t, -((new Date().getDay() + 6) % 7)), t];
  }],
  ['This month', () => {
    const t = todayStr();
    return [`${t.slice(0, 8)}01`, t];
  }],
  ['Last month', () => {
    const t = todayStr();
    const end = new Date(new Date(`${t.slice(0, 8)}01T12:00:00`).getTime() - 86400000);
    const y = end.getFullYear();
    const m = String(end.getMonth() + 1).padStart(2, '0');
    return [`${y}-${m}-01`, `${y}-${m}-${String(end.getDate()).padStart(2, '0')}`];
  }],
];

export function RangeControls({ from, to, onRange }) {
  return html`
    <${React.Fragment}>
      <div class="filter-presets" role="group" aria-label="Quick ranges">
        ${RANGE_PRESETS.map(([label, calc]) => html`
          <button key=${label} type="button" class="btn btn-sm"
            onClick=${() => { const [f, t] = calc(); onRange(f, t); }}>${label}</button>`)}
      </div>
      <div class="date-range">
        <label class="range-field">
          <span class="field-label">From</span>
          <input type="date" value=${from} onChange=${(e) => onRange(e.target.value, to)} />
        </label>
        <label class="range-field">
          <span class="field-label">To</span>
          <input type="date" value=${to} onChange=${(e) => onRange(from, e.target.value)} />
        </label>
      </div>
    <//>`;
}

// A header checkbox with three states. React has no `indeterminate` attribute,
// so it has to be written onto the node.
function TriCheckbox({ checked, indeterminate, onChange, label }) {
  const ref = useRef(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = !!indeterminate && !checked;
  }, [indeterminate, checked]);
  return html`<input type="checkbox" ref=${ref} checked=${checked}
    aria-label=${label} onChange=${onChange} />`;
}

// ---------------------------------------------------------------------------
// SELECTION AND BULK ACTIONS — and the touch path the teardown found missing.
//
// Before: a checkbox column with no persistent action bar, the bar appearing
// only after a selection and pinned `position: sticky; top: 8px` (which
// runbar.css flagged: it would hide under the running-timer bar the moment a
// timer started). And on a phone the header row of a `.table-cards` table is
// display:none, so select-all had no control at all.
//
// Now: an explicit "Select all N" button inside the bar (reachable at every
// width), a "Select" toggle that turns the row checkboxes on for a thumb, an
// explicit Done that leaves selection mode, and a bar that sticks to the TOP
// under the runbar on a desktop and to the BOTTOM above the navigation bar on
// a phone — where the thumb is, and where the rows you are ticking are.
// ---------------------------------------------------------------------------
export function LedgerSelection({
  entries, selected, setSelected, selecting, setSelecting, bumpRefresh,
}) {
  const [reassigning, setReassigning] = useState(false);
  const [warnGate, setWarnGate] = useState(null);
  const n = selected.size;
  const allSelected = entries.length > 0 && entries.every((e) => selected.has(e.id));

  async function bulk(action, extra = {}) {
    const { ids: givenIds, ...rest } = extra;
    const ids = givenIds || [...selected];
    const r = await api.post('/api/entries/bulk', { ids, action, ...rest });
    if (action === 'delete' && r.done.length > 0) {
      const restored = r.done.slice();
      emitToast(`${r.done.length} deleted`, {
        actionLabel: 'Undo',
        action: async () => {
          await api.post('/api/entries/bulk', { ids: restored, action: 'restore' });
          bumpRefresh();
        },
      });
    }
    if (action === 'finalize' && !extra.ack) {
      const warnOnly = r.failed.filter((f) => f.blocks && f.blocks.length === 0);
      if (warnOnly.length > 0) {
        const msgs = [...new Set(warnOnly.flatMap((f) => (f.warns || []).map((w) => w.message)))].slice(0, 4);
        setWarnGate({
          ids: warnOnly.map((f) => f.id),
          message: `${warnOnly.length} ${warnOnly.length === 1 ? 'entry has' : 'entries have'} warnings: ${msgs.join(' · ')}`,
        });
        if (r.done.length) emitToast(`${r.done.length} clean finalized`);
        bumpRefresh();
        return;
      }
    }
    if (r.failed.length > 0) {
      emitToast(`${r.done.length} done, ${r.failed.length} skipped (${r.failed[0].error || 'validation'})`, { error: true });
    } else if (action !== 'delete') {
      emitToast(`${r.done.length} ${action === 'set_cm' ? 'reassigned' : action === 'finalize' ? 'finalized' : `${action}ed`}`);
    }
    bumpRefresh();
  }

  const modals = html`
    <${React.Fragment}>
      ${reassigning ? html`
        <${Modal} title=${`Reassign ${n} ${n === 1 ? 'entry' : 'entries'}`} onClose=${() => setReassigning(false)}>
          <${CmPicker} autoFocus=${true} onChange=${async (cm) => {
            setReassigning(false);
            await bulk('set_cm', { cm_id: cm.id });
          }} />
        <//>` : null}
      ${warnGate ? html`
        <${Confirm} title="Finalize with warnings?" confirmLabel="Finalize anyway"
          message=${warnGate.message}
          onConfirm=${() => bulk('finalize', { ack: true, ids: warnGate.ids })}
          onClose=${() => setWarnGate(null)} />` : null}
    <//>`;

  if (!selecting && n === 0) return modals;

  return html`
    <${React.Fragment}>
      <div class="ledger-bulk" role="group" aria-label="Actions for the selected entries">
        <button type="button" class="btn btn-sm ledger-bulk-all"
          onClick=${() => setSelected(allSelected ? new Set() : new Set(entries.map((e) => e.id)))}>
          ${allSelected ? 'Clear selection' : `Select all ${entries.length}`}
        </button>
        <strong class="ledger-bulk-count" aria-live="polite">
          ${n} selected
        </strong>
        <div class="ledger-bulk-actions">
          <button type="button" class="btn btn-sm" disabled=${n === 0} onClick=${() => bulk('finalize')}>
            <${Icon} name="lock" size=${14} /> Finalize</button>
          <button type="button" class="btn btn-sm" disabled=${n === 0} onClick=${() => bulk('unlock')}>
            <${Icon} name="unlock" size=${14} /> Unlock</button>
          <button type="button" class="btn btn-sm" disabled=${n === 0} onClick=${() => setReassigning(true)}>
            <${Icon} name="briefcase" size=${14} /> Reassign matter</button>
          <button type="button" class="btn btn-sm btn-danger" disabled=${n === 0} onClick=${() => bulk('delete')}>
            <${Icon} name="trash" size=${14} /> Delete</button>
        </div>
        <button type="button" class="btn btn-sm ledger-bulk-done"
          onClick=${() => { setSelected(new Set()); setSelecting(false); }}>Done</button>
      </div>
      ${modals}
    <//>`;
}

// ---------------------------------------------------------------------------
// THE LEDGER ROW — one renderer, both modes, both viewports.
//
// It is still a <table> in the DOM, because a ledger on a desktop genuinely is
// a table (Attio's own product screen is a table; the reference bar for
// scanning many rows is aligned columns) — but base.css's `.table-cards`
// turns every row into a CARD below 768px, and ledger.css says what this
// table's columns mean when they stack. So the measured failure the teardown
// recorded — "the desktop table is 839px wide inside a 356px scroller… Hours
// is entirely off-screen and Narrative is cut mid-word" — cannot recur: there
// is no sideways scroller on a phone at all.
//
// Cells carry data-col rather than relying on :nth-child, so a column that is
// present in one mode and absent in another cannot silently shift the phone
// layout of every column after it.
//
// Actions: ONE labelled overflow per row (teardown E8), plus the matter name
// as the row's open affordance — exactly the shape the dashboard's entry row
// uses, so a row means the same thing on both screens. Nothing was dropped:
// view/edit, finalize one, unlock, copy to today and delete are all in the
// menu, which is a real button with a real 44px target rather than five
// unlabelled ghost glyphs identified only by a pointer-only `title`.
// ---------------------------------------------------------------------------
export function LedgerTable({
  entries, increment = 0.1, mode = 'ledger', openEditor, onChanged,
  selected, onToggle, onSelectAll, selecting = false,
}) {
  const [menu, setMenu] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const allSelected = entries.length > 0 && entries.every((e) => selected.has(e.id));
  const someSelected = entries.some((e) => selected.has(e.id));

  async function finalize(entry) {
    try {
      await api.post(`/api/entries/${entry.id}/finalize`);
      markJustFinalized(entry.id);
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

  async function del(entry) {
    await api.del(`/api/entries/${entry.id}`);
    onChanged();
    emitToast(`Deleted ${fmtHours(entry.total, increment)}h ${entry.cm ? `entry for ${entry.cm.short_name}` : 'unassociated entry'}`, {
      actionLabel: 'Undo',
      action: async () => { await api.post(`/api/entries/${entry.id}/restore`); onChanged(); },
    });
  }

  const rowMenuItems = (e) => [
    { label: e.status === 'draft' ? 'Open entry…' : 'View entry…', icon: 'eye', onClick: () => openEditor({ id: e.id }) },
    ...(e.status === 'draft'
      ? [{ label: 'Finalize this entry', icon: 'lock', onClick: () => finalize(e) }]
      : [{ label: 'Unlock for editing', icon: 'unlock', onClick: () => unlock(e) }]),
    { label: 'Copy to today', icon: 'copy', onClick: () => openEditor({ copyFrom: e.id }) },
    ...(e.status === 'draft'
      ? [{ hr: true }, { label: 'Delete entry', icon: 'trash', danger: true, onClick: () => setDeleting(e) }]
      : []),
  ];

  // The export stamp. Four real states, and the one column on this screen that
  // answers "has this left the building?".
  const exportCell = (e) => {
    if (e.status === 'draft') {
      return e.exported_at
        ? html`<span class="ledger-stale" title=${`Sent ${fmtStamp(e.exported_at)}, edited since`}>stale</span>`
        : html`<span class="muted">—</span>`;
    }
    return e.exported_at
      ? html`<span class="ledger-sent" title=${`Exported ${fmtStamp(e.exported_at)}`}>✓ ${fmtStamp(e.exported_at)}</span>`
      : html`<span class="muted">pending</span>`;
  };

  return html`
    <${React.Fragment}>
      <div class="card table-wrap table-cards ledger-wrap">
        <table class=${`tk ledger-table${selecting ? ' selecting' : ''}`}>
          <thead>
            <tr>
              <th data-col="select" scope="col">
                <${TriCheckbox} checked=${allSelected} indeterminate=${someSelected}
                  label=${allSelected ? 'Clear the selection' : 'Select every entry in this list'}
                  onChange=${onSelectAll} />
              </th>
              <th data-col="date" scope="col">Date</th>
              <th data-col="cm" scope="col">Client / matter</th>
              <th data-col="narrative" scope="col">Narrative</th>
              <th data-col="status" scope="col">Status</th>
              <th data-col="hours" scope="col">Hours</th>
              <th data-col="exported" scope="col">Exported</th>
              <th data-col="actions" scope="col"><span class="ledger-th-hidden">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            ${entries.map((e) => html`
              <tr key=${e.id} class=${e.cm ? '' : 'row-blocked'}>
                <td data-col="select">
                  <input type="checkbox" checked=${selected.has(e.id)}
                    aria-label=${`Select the ${e.date} entry${e.cm ? ` for ${e.cm.short_name}` : ''}`}
                    onChange=${() => onToggle(e.id)} />
                </td>
                <td data-col="date" class="mono small">${e.date}</td>
                <td data-col="cm">
                  ${e.cm ? html`
                    <button type="button" class="ledger-open" title="Open this entry"
                      onClick=${() => openEditor({ id: e.id })}>${e.cm.short_name}</button>
                    <span class="muted mono small ledger-cm-number">${e.cm.cm_number}</span>` : html`
                    <span class="muted ledger-nomatter">
                      No matter yet${mode === 'export' ? ' — can’t export' : ''}
                    </span>
                    <button type="button" class="btn btn-sm"
                      title="Assign a client/matter — required before this entry can finalize or export"
                      onClick=${() => openEditor({ id: e.id })}>Assign matter</button>`}
                </td>
                <td data-col="narrative">
                  <${InlineNarrative} entry=${e} onChanged=${onChanged} />
                </td>
                <td data-col="status">
                  <div class="ledger-chipset">
                    ${e.billable ? null : html`<${BillableBadge} billable=${0} />`}
                    <${StatusChip} entry=${e} />
                    ${e.status === 'draft' && e.ever_finalized ? html`
                      <span class="chip chip-reverted" title=${'Finalized once, then unlocked'
                        + (e.exported_at ? ` — and already exported ${fmtStamp(e.exported_at)}` : '')}>
                        <${Icon} name="unlock" size=${12} /> unlocked</span>` : null}
                  </div>
                </td>
                <td data-col="hours" class="ledger-hours">${fmtHours(e.total, increment)}</td>
                <td data-col="exported" class="small">${exportCell(e)}</td>
                <td data-col="actions">
                  <button type="button" class="btn btn-ghost btn-sm btn-icon ledger-more"
                    title="More actions for this entry" aria-label="More actions for this entry"
                    aria-haspopup="menu"
                    onClick=${(ev) => {
                      const r = ev.currentTarget.getBoundingClientRect();
                      setMenu({ x: r.left, y: r.bottom + 2, entry: e });
                    }}><${Icon} name="more" size=${16} /></button>
                </td>
              </tr>`)}
          </tbody>
        </table>
      </div>
      ${menu ? html`
        <${ContextMenu} x=${menu.x} y=${menu.y} items=${rowMenuItems(menu.entry)}
          onClose=${() => setMenu(null)} />` : null}
      ${deleting ? html`
        <${Confirm} title="Delete entry" danger confirmLabel="Delete"
          message=${`Delete this ${fmtHours(deleting.total, increment)}h entry${deleting.cm ? ` for ${deleting.cm.short_name}` : ''}? You'll have a few seconds to undo from the toast.`}
          onConfirm=${() => del(deleting)}
          onClose=${() => setDeleting(null)} />` : null}
    <//>`;
}

// ---------------------------------------------------------------------------
// THE LEDGER ITSELF
// ---------------------------------------------------------------------------

const EMPTY_FILTERS = { q: '', cm: null, from: '', to: '', task: '', billable: '', status: '', exported: '' };

export function SearchView({ settings, openEditor, refreshKey, bumpRefresh }) {
  const increment = settings?.rounding?.increment || 0.1;
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [showFilters, setShowFilters] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState(() => new Set());
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
  // "Not exported yet" is the one filter the entries endpoint does not carry,
  // and the teardown asked for it here by name (§12). It is applied on the
  // client rather than by widening the API, because this is a UI pass and the
  // list is already capped server-side.
  const fetched = data || [];
  const entries = filters.exported === ''
    ? fetched
    : fetched.filter((e) => (filters.exported === 'yes' ? !!e.exported_at : !e.exported_at));
  const total = entries.reduce((a, e) => a + e.total, 0);

  useEffect(() => { setSelected(new Set()); }, [qs, refreshKey, filters.exported]);

  const set = (patch) => setFilters((f) => ({ ...f, ...patch }));
  const toggle = (id) => setSelected((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });
  const allSelected = entries.length > 0 && entries.every((e) => selected.has(e.id));

  // ACTIVE FILTERS ARE CHIPS, NOT A PERMANENT WALL OF CONTROLS.
  // Before: six filter controls, always expanded, above the fold, on every
  // visit — on a screen whose default answer is "everything". Attio, Linear
  // and Notion all answer this the same way: the search box is always there,
  // and a filter you have actually applied becomes a chip you can see and
  // remove. The controls themselves live one tap away behind "Filters".
  const chips = [];
  if (filters.cm) chips.push(['cm', filters.cm.short_name, () => set({ cm: null })]);
  if (filters.from) chips.push(['from', `From ${filters.from}`, () => set({ from: '' })]);
  if (filters.to) chips.push(['to', `To ${filters.to}`, () => set({ to: '' })]);
  if (filters.task) chips.push(['task', filters.task, () => set({ task: '' })]);
  if (filters.billable !== '') {
    chips.push(['billable', filters.billable === '1' ? 'Billable' : 'Non-billable', () => set({ billable: '' })]);
  }
  if (filters.status) {
    chips.push(['status', filters.status === 'draft' ? 'Draft' : 'Finalized', () => set({ status: '' })]);
  }
  if (filters.exported) {
    chips.push(['exported', filters.exported === 'yes' ? 'Exported' : 'Not exported yet', () => set({ exported: '' })]);
  }
  const filtered = chips.length > 0 || !!filters.q;

  return html`
    <${LedgerHead} title="Entries" count=${entries.length} hours=${total} increment=${increment}
      note=${filtered ? 'matching these filters' : 'everything ever recorded'} />

    <div class="ledger-toolbar">
      <div class="ledger-search-wrap">
        <${Icon} name="search" size=${16} className="ledger-search-icon" />
        <input type="search" data-search-q class="ledger-search"
          placeholder="Search narratives…" aria-label="Search narratives"
          value=${filters.q} onInput=${(e) => set({ q: e.target.value })} />
      </div>
      <button type="button" class="btn ledger-filter-btn" aria-expanded=${showFilters ? 'true' : 'false'}
        onClick=${() => setShowFilters((v) => !v)}>
        Filters
        ${chips.length > 0 ? html`<span class="ledger-filter-count">${chips.length}</span>` : null}
        <${Icon} name=${showFilters ? 'chevronUp' : 'chevronDown'} size=${14} />
      </button>
      ${/* THE TOUCH PATH INTO BULK EDITING. On a desktop the checkbox column is
            always there; on a phone the row cards would spend a quarter of
            their width on a control used once a month, so this turns it on —
            and the selection bar it opens carries Select all, so nothing
            depends on the table header a phone never renders. */''}
      <button type="button" class="btn ledger-select-btn" aria-pressed=${selecting ? 'true' : 'false'}
        onClick=${() => { setSelecting((v) => !v); if (selecting) setSelected(new Set()); }}>
        <${Icon} name="check" size=${16} /> ${selecting ? 'Stop selecting' : 'Select'}
      </button>
    </div>

    ${chips.length > 0 ? html`
      <div class="ledger-chips" role="group" aria-label="Active filters">
        ${chips.map(([key, label, clear]) => html`
          <button key=${key} type="button" class="ledger-chip" onClick=${clear}
            title=${`Remove the ${label} filter`}>
            <span>${label}</span><${Icon} name="x" size=${13} />
          </button>`)}
        <button type="button" class="btn btn-sm" onClick=${() => setFilters(EMPTY_FILTERS)}>Clear all</button>
      </div>` : null}

    ${showFilters ? html`
      <div class="card ledger-filters">
        <div class="ledger-filter-grid">
          <label class="range-field">
            <span class="field-label">Client / matter</span>
            <${CmPicker} value=${filters.cm} allowCreate=${false} placeholder="Any client/matter"
              onChange=${(cm) => set({ cm })} />
          </label>
          <label class="range-field">
            <span class="field-label">Task</span>
            <select value=${filters.task} onChange=${(e) => set({ task: e.target.value })}>
              <option value="">Any task</option>
              ${taskCodes.map((c) => html`<option key=${c.id} value=${c.name}>${c.name}</option>`)}
            </select>
          </label>
          <label class="range-field">
            <span class="field-label">Billable</span>
            <select value=${filters.billable} onChange=${(e) => set({ billable: e.target.value })}>
              <option value="">Billable and non-billable</option>
              <option value="1">Billable only</option>
              <option value="0">Non-billable only</option>
            </select>
          </label>
          <label class="range-field">
            <span class="field-label">Status</span>
            <select value=${filters.status} onChange=${(e) => set({ status: e.target.value })}>
              <option value="">Any status</option>
              <option value="draft">Draft</option>
              <option value="finalized">Finalized</option>
            </select>
          </label>
          <label class="range-field">
            <span class="field-label">Export</span>
            <select value=${filters.exported} onChange=${(e) => set({ exported: e.target.value })}>
              <option value="">Sent or not</option>
              <option value="no">Not exported yet</option>
              <option value="yes">Already exported</option>
            </select>
          </label>
        </div>
        <div class="filter-bar ledger-filter-range">
          <${RangeControls} from=${filters.from} to=${filters.to}
            onRange=${(f, t) => set({ from: f, to: t })} />
        </div>
      </div>` : null}

    <${LedgerSelection} entries=${entries} selected=${selected} setSelected=${setSelected}
      selecting=${selecting} setSelecting=${setSelecting} bumpRefresh=${bumpRefresh} />

    ${error ? html`<${ErrorBox} error=${error} />`
      : loading && !data ? html`<${Spinner} />`
        : entries.length === 0 ? html`
          <div class="card ledger-empty">
            ${filtered ? html`
              <${EmptyState} icon="search" heading="No entries match these filters"
                description="Nothing recorded so far fits every filter you have on. Widen the range or drop a filter to see more of the ledger."
                actionLabel="Clear the filters" onAction=${() => { setFilters(EMPTY_FILTERS); }} />` : html`
              <${EmptyState} icon="clock" heading="No time recorded yet"
                description="Every entry you file — from a timer, from quick capture, or by hand — lands here, and this is where you edit, finalize and export them in bulk."
                actionLabel="Add an entry" onAction=${() => openEditor({ template: {} })} />`}
          </div>`
          : html`
            <${LedgerTable} entries=${entries} increment=${increment} mode="ledger"
              openEditor=${openEditor} onChanged=${bumpRefresh}
              selected=${selected} onToggle=${toggle} selecting=${selecting}
              onSelectAll=${() => setSelected(allSelected ? new Set() : new Set(entries.map((e) => e.id)))} />`}
  `;
}
