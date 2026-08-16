// THE ENTRIES LEDGER — every entry ever recorded, filterable, bulk-editable,
// exportable. Formerly "Search", and, since this wave, formerly "Export" too.
//
// The teardown (§10, §A) found that this screen was mis-named into invisibility:
// with empty filters it is already "all 23 entries · 44.8h", i.e. the app's
// ledger and its ONLY bulk-edit surface, and calling it Search hid both facts.
// It also found Export (§12) to be this same list with two extra columns and
// three download buttons, on its own top-level destination and its own phone
// bottom-bar slot, for a job done once a day.
//
// THE LAST WAVE MOVED THE COLUMN AND THE CHIP AND LEFT THE PAGE STANDING. The
// standing critic measured what was left: 28 interactive controls above the
// fold on a 900px desktop viewport, the first and only table row at y=486, and
// on a phone "roughly 994px of controls" before the single row the page was
// about. So Export is not a page any more, in any viewport:
//
//   Export…            an action in this ledger's header and in its bulk bar
//   the format choice  a dialog over the ledger (the shared overlay primitive)
//   range and status   THE LEDGER'S OWN FILTER CHIPS — there is no second
//                      filter UI, because there was never a second question
//   #/entries/export…  the ledger, with the chips that deep link asks for
//
// What this file exports:
//
//   LedgerHead        the page header, one figure, and the counts you act on
//   RangeControls     presets + From/To — one range vocabulary for the screen
//   LedgerSelection   the selection bar and every bulk action, with a touch path
//   LedgerTable       THE row renderer, cards + sticky day headers on a phone
//   ExportDialog      the format choice, and nothing else
//   SearchView        the ledger itself; views/exportview.js re-exports it as
//                     ExportView so the two routes are the SAME component (a
//                     wrapper would remount the ledger and throw away the very
//                     filter chips the dialog reads its scope from)
import { api, downloadText } from '/js/api.js';
import {
  html, React, useState, useEffect, useRef, useAsync, Spinner, ErrorBox, Icon,
  fmtHours, fmtStamp, todayStr, addDays, emitToast, markJustFinalized,
  BillableBadge, StatusChip, Modal, Confirm,
} from '/js/ui.js';
import { Menu, menuTriggerProps, rowMenuItems as sharedRowMenuItems } from '/js/components/menu.js';
import { CmPicker } from '/js/components/cmpicker.js';
// The shared overlay primitive, used directly rather than through ui.js's
// Modal for one reason: Modal fixes the panel's className, and this dialog
// needs one more class on it (see .export-modal-instant in ledger.css — a
// dialog the ROUTE opened is the destination, not a response to a click on the
// screen behind it, so it does not slide in over that screen). Everything else
// — portal, scrim, focus trap, Escape, scroll lock, phone bottom-sheet shape —
// is the primitive's, exactly as it is for every other dialog in the app.
import { Overlay } from '/js/components/overlay.js';
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

// Compact day label for a range summary and a day-group header. Deliberately
// not fmtDateLong: "Sat, Aug 15, 2026" twice over is a line and a half of a
// phone dialog spent on two dates that are almost always in this year.
function dayLabel(dateStr, { withYear = false } = {}) {
  if (!dateStr) return '';
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d, 12).toLocaleDateString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric',
    ...(withYear || y !== new Date().getFullYear() ? { year: 'numeric' } : {}),
  });
}

function rangeLabel(from, to) {
  const sameYear = from.slice(0, 4) === to.slice(0, 4);
  if (from === to) return dayLabel(from);
  return `${dayLabel(from, { withYear: !sameYear })} – ${dayLabel(to)}`;
}

// The shared page header. The figure rides on the title's line (it is the
// answer to the title, not a second heading), the actions sit right, and the
// line below is the one a lawyer can act on — see COUNTS YOU CAN ACT ON in
// SearchView.
export function LedgerHead({ title, count, hours, increment, note, actions, stats }) {
  return html`
    <div class="page-head ledger-head">
      <div class="ledger-head-title">
        <h1>${title}</h1>
        <${Figure} hours=${hours} increment=${increment} />
      </div>
      <div class="spacer"></div>
      ${actions ? html`<div class="page-head-actions">${actions}</div>` : null}
      <div class="page-head-tools ledger-figures">
        <span class="ledger-figure-cap">
          ${count} ${count === 1 ? 'entry' : 'entries'}${note ? ` · ${note}` : ''}
        </span>
        ${(stats || []).map((s) => html`
          <button key=${s.key} type="button" class=${`ledger-stat ledger-stat-${s.key}`}
            onClick=${s.onClick} title=${s.title}>
            <span class="ledger-stat-n">${s.n}</span> ${s.label}
          </button>`)}
      </div>
    </div>`;
}

// ---------------------------------------------------------------------------
// Date range — the presets are the fast path and the two inputs are the ground
// truth; shell.css's .filter-presets / .date-range own the responsive grouping
// (a group may wrap, the things inside one never wrap away from each other).
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
// An explicit "Select all N" button inside the bar (reachable at every width),
// a "Select" toggle that turns the row checkboxes on for a thumb, an explicit
// Done that leaves selection mode, and a bar that sticks to the TOP under the
// runbar on a desktop and to the BOTTOM above the navigation bar on a phone.
//
// EXPORT LIVES HERE NOW. The standing critic: "The bulk bar offers Finalize,
// Unlock, Reassign matter, Delete, Done — no Export… there is no way to export
// the entries you just picked out." There is one, and it opens the same dialog
// the header opens, scoped to the selection.
// ---------------------------------------------------------------------------
export function LedgerSelection({
  entries, selected, setSelected, selecting, setSelecting, bumpRefresh, onExport,
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
          ${onExport ? html`
            <button type="button" class="btn btn-sm ledger-bulk-export" disabled=${n === 0}
              aria-haspopup="dialog" onClick=${onExport}
              title="Choose a file format for the entries you have selected">
              <${Icon} name="export" size=${14} /> Export…</button>` : null}
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
// THE LEDGER ROW — one renderer, both viewports.
//
// It is still a <table> in the DOM, because a ledger on a desktop genuinely is
// a table — but base.css's `.table-cards` turns every row into a CARD below
// 768px, and ledger.css says what this table's columns mean when they stack.
//
// DAY GROUPS. The standing critic on the phone list: "5,082px of undifferen-
// tiated cards for 23 entries with no date grouping, no month header and no
// running subtotal — every card repeats the same three-line shape at the same
// visual weight." The rows arrive sorted by date, so a group header row goes in
// ahead of each new date carrying that day's total (Attio's tasks list does
// exactly this with Today/Upcoming/Completed). It is a real <tr> so the table
// stays a table for a screen reader, and on a phone it sticks under the run bar
// while you scroll its day.
//
// Cells carry data-col rather than relying on :nth-child, so a column that is
// present in one mode and absent in another cannot silently shift the phone
// layout of every column after it.
//
// Actions: ONE labelled overflow per row (teardown E8), plus the matter name
// as the row's open affordance — exactly the shape the dashboard's entry row
// uses, so a row means the same thing on both screens.
// ---------------------------------------------------------------------------
export function LedgerTable({
  entries, increment = 0.1, openEditor, onChanged,
  selected, onToggle, onSelectAll, selecting = false,
}) {
  const [menu, setMenu] = useState(null);
  const [deleting, setDeleting] = useState(null);
  // "Write narrative here" — the shared row menu's item, so the ledger reaches
  // the inline editor by thumb the same way the two work lists do.
  const [writingId, setWritingId] = useState(null);
  const allSelected = entries.length > 0 && entries.every((e) => selected.has(e.id));
  const someSelected = entries.some((e) => selected.has(e.id));

  // Total per day, for the group header. One pass, keyed by the date string.
  const dayTotals = new Map();
  for (const e of entries) {
    dayTotals.set(e.date, (dayTotals.get(e.date) || 0) + (Number(e.total) || 0));
  }

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

  // THE SAME ROW MENU THE TWO WORK LISTS CARRY (components/menu.js). It was a
  // fourth hand-written item list until this wave; building it from the shared
  // model is what makes `Delete entry` appear on every row that has an entry
  // — present and disabled with its reason on a finalized one, rather than
  // silently absent on half the ledger.
  const rowMenuItems = (e) => sharedRowMenuItems({
    entries: [e], focus: e, fmtHours: (h) => fmtHours(h, increment),
  }, {
    openEntry: (x) => openEditor({ id: x.id }),
    writeNarrative: (x) => setWritingId(x.id),
    finalize: (x) => finalize(x),
    unlock: (x) => unlock(x),
    copyToToday: (x) => openEditor({ copyFrom: x.id }),
    deleteEntry: (x) => setDeleting(x),
  });

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

  let lastDate = null;

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
            ${entries.flatMap((e) => {
              const rows = [];
              if (e.date !== lastDate) {
                lastDate = e.date;
                rows.push(html`
                  <tr key=${`day-${e.date}`} class="ledger-daybreak">
                    <th colspan="8" scope="colgroup">
                      <span class="ledger-daybreak-date">${dayLabel(e.date)}</span>
                      <span class="ledger-daybreak-total">${fmtHours(dayTotals.get(e.date), increment)}h</span>
                    </th>
                  </tr>`);
              }
              rows.push(html`
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
                      <span class="muted ledger-nomatter">No matter yet — can’t export</span>
                      <button type="button" class="btn btn-sm"
                        title="Assign a client/matter — required before this entry can finalize or export"
                        onClick=${() => openEditor({ id: e.id })}>Assign matter</button>`}
                  </td>
                  <td data-col="narrative">
                    <${InlineNarrative} entry=${e} onChanged=${onChanged}
                      autoEdit=${writingId === e.id} onDone=${() => setWritingId(null)} />
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
                      title="Row menu" aria-label=${`Row menu — ${e.cm ? e.cm.short_name : 'entry with no matter'}`}
                      ...${menuTriggerProps(!!menu && menu.entry === e)}
                      onClick=${(ev) => setMenu({ anchor: ev.currentTarget, entry: e })}>
                      <${Icon} name="more" size=${16} /></button>
                  </td>
                </tr>`);
              return rows;
            })}
          </tbody>
        </table>
      </div>
      ${menu ? html`
        <${Menu} anchor=${menu.anchor}
          title=${menu.entry.cm ? menu.entry.cm.short_name : 'Entry'}
          items=${rowMenuItems(menu.entry)}
          onClose=${() => setMenu(null)} />` : null}
      ${deleting ? html`
        <${Confirm} title="Delete entry" danger confirmLabel="Delete"
          message=${`Delete this ${fmtHours(deleting.total, increment)}h entry${deleting.cm ? ` for ${deleting.cm.short_name}` : ''}? You'll have a few seconds to undo from the toast.`}
          onConfirm=${() => del(deleting)}
          onClose=${() => setDeleting(null)} />` : null}
    <//>`;
}

// ===========================================================================
// EXPORT — THE DIALOG THAT REPLACED THE PAGE
//
// The page carried fifteen controls to move one row: a 4-item status segmented
// control, 5 presets, 2 date inputs, an "Include drafts" checkbox and 3
// download buttons, above a copy of this very table. Every one of those
// questions except "which file?" is a question the ledger behind this dialog
// already answers with its filter chips, so this dialog asks only that one.
//
// TWO RULES IT KEEPS, because the last version broke both:
//
//   1. IT NEVER CLAIMS A COUNT IT HAS NOT BEEN TOLD. Everything on screen —
//      the entry count, the hours, the range — comes from the same
//      /api/export/preview call that the download itself is built from, with
//      the same arguments. The old page could say "3.8 h · 4 entries · 4 ready
//      to send" beside a sentence reading "it cannot export until it is
//      finalized"; there is no second sentence here to contradict the number.
//
//   2. IT NEVER WRITES A BLANK BILLING LINE. `narrative_empty` is a *block*
//      in lib/validation.js, so a finalized entry always has a narrative and
//      only an included DRAFT can be blank. The old page wrote three of those
//      into a .TIM with an empty na= field. Here, a blank narrative in scope
//      disables the two controls that make a file, says so in the button's own
//      accessible name, and offers the way out (leave the drafts out, or go
//      and write the narrative).
//
// "Copy as text" is never blocked: it renders "(no narrative)" in plain sight
// and marks nothing as sent, which is the honest way to look at unfinished
// time.
// ===========================================================================

const FORMATS = [
  {
    key: 'text',
    label: 'Copy as text',
    icon: 'clipboard',
    hint: 'A readable summary on the clipboard. Nothing is marked as sent.',
    makesFile: false,
  },
  {
    key: 'csv',
    label: 'Download CSV',
    icon: 'download',
    hint: 'The same entries as a spreadsheet, one row per task line.',
    makesFile: true,
  },
  {
    key: 'tim',
    label: 'Download .TIM',
    icon: 'export',
    hint: 'The DTE Axiom / TimeSaver import file. Constants live in Settings → .TIM export.',
    makesFile: true,
    primary: true,
  },
];

// What the file will hold, in the app's own words, for each server-side rule.
const SCOPE_WORDS = {
  unfinalized: 'every entry still a draft',
  unexported: 'every finalized entry never sent',
  either: 'everything still owed something — unfinalized or never sent',
};

// One sentence, and — where there is one — the control that answers it. The
// control is a real .btn on its own line rather than a link inside the prose:
// the harness measures a link in a paragraph as an interactive element, and a
// 44px target is not something to buy back with padding tricks inside a dialog
// a thumb has to use.
function Note({ tone, actionLabel, onAction, children }) {
  return html`
    <div class=${`export-note${tone ? ` export-note-${tone}` : ''}`}>
      <p>${children}</p>
      ${actionLabel ? html`
        <button type="button" class="btn btn-sm" onClick=${onAction}>${actionLabel}</button>` : null}
    </div>`;
}

export function ExportDialog({ scope, increment, onClose, onDone, onShowDrafts }) {
  const [includeDrafts, setIncludeDrafts] = useState(!!scope.includeDrafts);
  const [busy, setBusy] = useState(false);
  const { from, to, attention } = scope;
  const drafting = attention ? null : includeDrafts;

  // The preview must ask for the SAME scope the download will send, or the
  // number under the button is not the number the file holds.
  const attQs = attention ? `&attention=${attention}` : '';
  const scopeQs = (scope.cm_id ? `&cm_id=${scope.cm_id}` : '')
    + (scope.ids ? `&ids=${scope.ids.join(',')}` : '');
  const scopeKey = `${scope.cm_id || ''}|${(scope.ids || []).join(',')}`;
  const { loading, data, error } = useAsync(
    () => api.get(`/api/export/preview?from=${from}&to=${to}&includeDrafts=${includeDrafts ? 1 : 0}${attQs}${scopeQs}`),
    [from, to, attention, includeDrafts, scopeKey]);

  // The preview returns every row in range (matterless included, so the count
  // of time that cannot leave is visible); the rows that become a file are the
  // ones with a client/matter, and `count` is their number.
  const rows = data ? data.entries : [];
  const willWrite = rows.filter((e) => e.cm);
  const ready = data ? data.count : 0;
  const hours = willWrite.reduce((a, e) => a + (Number(e.total) || 0), 0);
  const blank = willWrite.filter((e) => !String(e.narrative || '').trim());
  const drafts = willWrite.filter((e) => e.status === 'draft');
  const unassociated = data ? data.unassociated : 0;

  // Does the file hold exactly what the caller pointed at? Only a selection can
  // disagree, and it must say so rather than quietly widening.
  const picked = scope.ids || null;
  const exact = !picked || (picked.length === willWrite.length
    && willWrite.every((e) => picked.includes(e.id)));

  async function run(format) {
    if (busy) return;
    setBusy(true);
    try {
      const body = {
        from, to, includeDrafts, attention,
        cm_id: scope.cm_id || null,
        ids: scope.ids || null,
        ...(format === 'text' ? { markExported: false } : {}),
      };
      const r = await api.post('/api/export', body);
      if (r.count === 0) { emitToast('Nothing in that range to send.'); return; }
      if (format === 'text') {
        await navigator.clipboard.writeText(r.text);
        emitToast('Plain-text summary copied to the clipboard');
      } else {
        const range = `${from}${from !== to ? `_${to}` : ''}`;
        const wrote = format === 'tim'
          ? downloadText(`time_${range.replace(/-/g, '')}.TIM`, r.tim, 'text/plain')
          : downloadText(`timekeeper-${range}.csv`, r.csv);
        // The stamp happens HERE and nowhere else. The server built the payload
        // but marked nothing: only this side knows the file was really written,
        // so only this side may say the time has been sent. downloadText throws
        // rather than returning if it could not hand over a file.
        if (wrote && r.batch) await api.post(`/api/export/${r.batch}/confirm`);
        emitToast(`${r.count} ${r.count === 1 ? 'entry' : 'entries'} written to a ${format === 'tim' ? '.TIM' : 'CSV'} file`);
      }
      onDone();
      onClose();
    } catch (e) {
      emitToast(e.message, { error: true });
    } finally {
      setBusy(false);
    }
  }

  const blockedReason = blank.length > 0
    ? `${blank.length} of ${blank.length === 1 ? 'these entries has' : 'these entries have'} no narrative — a blank billing line cannot go to the billing system.`
    : ready === 0 ? 'Nothing in this range is ready to send.' : null;

  const scopeWord = attention
    ? SCOPE_WORDS[attention]
    : (includeDrafts ? 'every entry, drafts included' : 'every finalized entry');

  return html`
    <${Overlay} title="Export" onClose=${() => onClose()} size="md"
      initialFocus=".export-format"
      className=${`modal export-modal${scope.fromRoute ? ' export-modal-instant' : ''}`}>
      ${error ? html`<${ErrorBox} error=${error} />` : null}
      ${loading && !data ? html`<${Spinner} />` : html`
        <${React.Fragment}>
          <p class="export-scope">
            <strong class="export-scope-count">
              ${ready} ${ready === 1 ? 'entry' : 'entries'} · ${fmtHours(hours, increment)} h
            </strong>
            <span class="export-scope-rule">
              ${scopeWord}, ${rangeLabel(from, to)}
            </span>
          </p>

          ${!exact ? html`
            <${Note}>
              You picked ${picked.length} ${picked.length === 1 ? 'entry' : 'entries'};
              a file is written from a date range, so this one covers
              ${' '}${ready} — ${scopeWord} between those two dates.
            <//>` : null}

          ${(scope.caveats || []).length > 0 ? html`
            <${Note}>
              ${(scope.caveats || []).join(' and ')} ${(scope.caveats || []).length === 1 ? 'does' : 'do'}
              ${' '}not travel into a file: a file is a date range plus a status.
            <//>` : null}

          ${drafting === false ? html`
            <${Note} actionLabel="Include drafts" onAction=${() => setIncludeDrafts(true)}>
              Drafts are left out of the file — they are not finalized.
            <//>` : null}
          ${drafting === true ? html`
            <${Note} actionLabel="Leave drafts out" onAction=${() => setIncludeDrafts(false)}>
              ${drafts.length} ${drafts.length === 1 ? 'draft is' : 'drafts are'} included.
              A draft that goes into the file is marked sent like anything else — it is a real
              billing line once it is imported.
            <//>` : null}

          ${blank.length > 0 ? html`
            <${Note} tone="blocked"
              actionLabel=${onShowDrafts ? 'Show them in the ledger' : null}
              onAction=${onShowDrafts ? () => { onClose(); onShowDrafts(from, to); } : null}>
              <strong>${blank.length} ${blank.length === 1 ? 'entry has' : 'entries have'} no narrative.</strong>
              ${' '}A .TIM or CSV line with an empty narrative reaches the billing system as a blank
              bill, so no file is written until ${blank.length === 1 ? 'it has' : 'they have'} one.
            <//>` : null}

          ${unassociated > 0 ? html`
            <${Note} tone="blocked">
              ${unassociated} ${unassociated === 1 ? 'entry in this range has' : 'entries in this range have'} no
              client/matter, so ${unassociated === 1 ? 'it is' : 'they are'} not in the file — assign one from the ledger.
            <//>` : null}

          <div class="export-formats" role="group" aria-label="File format">
            ${FORMATS.map((f) => {
              const off = !data || ready === 0 || busy
                || (f.makesFile && blank.length > 0);
              const why = f.makesFile && blank.length > 0 ? blockedReason
                : ready === 0 ? 'Nothing in this range is ready to send.' : null;
              return html`
                <button key=${f.key} type="button"
                  class=${`export-format${f.primary ? ' is-primary' : ''}`}
                  disabled=${off} aria-label=${why ? `${f.label} — unavailable. ${why}` : f.label}
                  title=${why || f.hint}
                  onClick=${() => run(f.key)}>
                  <${Icon} name=${f.icon} size=${18} />
                  <span class="export-format-text">
                    <span class="export-format-name">
                      ${f.label}
                      ${ready > 0 ? html`<span class="export-format-count">${ready}</span>` : null}
                    </span>
                    <span class="export-format-hint">${why || f.hint}</span>
                  </span>
                </button>`;
            })}
          </div>

          <p class="export-foot muted small">
            An entry is marked exported once the file has actually downloaded, and not before;
            you can re-export any time. Range, status, client/matter and any picked rows all come
            from the ledger behind this dialog.
          </p>
        <//>`}
    <//>`;
}

// ---------------------------------------------------------------------------
// THE LEDGER ITSELF
// ---------------------------------------------------------------------------

const EMPTY_FILTERS = { q: '', cm: null, from: '', to: '', task: '', billable: '', status: '', exported: '' };

// #/entries/export[/<filter>[/<from>]] — and its pre-canonical form #/export…,
// which app.js rewrites in an effect, i.e. one frame after this renders.
//
// The route is read from the hash rather than taken as a prop because BOTH
// routes are this same component (see views/exportview.js): a wrapper
// component would give React a different element type at the same position,
// remounting the ledger and discarding the filter chips whose whole job now is
// to tell the export dialog what to write.
function exportRouteOf(hash) {
  const parts = String(hash || '').replace(/^#\/?/, '').split('/').filter(Boolean);
  if (parts[0] === 'export') return { filter: parts[1] || 'all', from: parts[2] || null };
  if (parts[0] === 'entries' && parts[1] === 'export') return { filter: parts[2] || 'all', from: parts[3] || null };
  return null;
}

// The deep-link contract, expressed as ledger chips. Every filter the old
// Export page's segmented control offered is one of these; §12 asked for the
// link to keep working and point at "the ledger with that chip applied".
const FILTER_CHIPS = {
  all: {},
  unfinalized: { status: 'draft', exported: '' },
  unexported: { status: 'finalized', exported: 'no' },
  either: { status: '', exported: 'no' },
};

// …and the same mapping read backwards: what the server must be asked for, to
// write the entries the ledger is currently showing. This is the only place
// that decides it, so the dialog's summary and its download cannot disagree.
function attentionOf(filters) {
  if (filters.status === 'draft') return 'unfinalized';
  if (filters.status === 'finalized' && filters.exported === 'no') return 'unexported';
  if (!filters.status && filters.exported === 'no') return 'either';
  return null;
}

// Which of the ledger's filters cannot become part of a file. Named out loud
// rather than silently dropped.
function caveatsOf(filters) {
  const c = [];
  if (filters.q) c.push('the search text');
  // The client/matter filter USED to be listed here. It travels now: scopeFor
  // sends cm_id and POST /api/export narrows on it, so a ledger chipped to one
  // matter writes and stamps that matter only.
  if (filters.task) c.push('the task filter');
  if (filters.billable !== '') c.push('the billable filter');
  if (filters.exported === 'yes') c.push('the “already exported” filter');
  // A draft that was exported, then unlocked, keeps its stale stamp: the ledger
  // can hide it and the server's "unfinalized" rule cannot.
  if (filters.status === 'draft' && filters.exported === 'no') c.push('the “not exported yet” filter');
  return c;
}

function scopeFor(filters, list, { ids = null, useListDates = false } = {}) {
  const dates = list.map((e) => e.date).filter(Boolean).sort();
  const first = dates[0] || todayStr();
  const last = dates[dates.length - 1] || todayStr();
  return {
    from: useListDates ? first : (filters.from || first),
    to: useListDates ? last : (filters.to || last),
    attention: attentionOf(filters),
    includeDrafts: list.some((e) => e.status === 'draft') && !attentionOf(filters) && !!ids,
    caveats: caveatsOf(filters),
    // The two narrowings a file can carry. A date range on its own is WIDER
    // than what the screen is showing, and the export stamps whatever it wrote:
    // without these, chipping the ledger to one matter still wrote — and marked
    // exported — a second client's time.
    cm_id: filters.cm ? filters.cm.id : null,
    ids,
  };
}

export function SearchView({ settings, openEditor, refreshKey, bumpRefresh }) {
  const increment = settings?.rounding?.increment || 0.1;
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [showFilters, setShowFilters] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState(() => new Set());
  const [taskCodes, setTaskCodes] = useState([]);
  const [exportScope, setExportScope] = useState(null);
  const [route, setRoute] = useState(() => exportRouteOf(location.hash));

  useEffect(() => { api.get('/api/task-codes?includeInactive=1').then(setTaskCodes).catch(() => {}); }, []);

  useEffect(() => {
    const onHash = () => setRoute(exportRouteOf(location.hash));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

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

  // THE DEEP LINK, AND WHERE THE DIALOG COMES UP.
  //
  // #/entries/export        → the ledger, unfiltered, with the dialog open.
  //                           This is the navigation item's target: "Export"
  //                           is a thing you do, and doing it is one tap.
  // #/entries/export/<f>…   → the ledger with that filter's chips applied and
  //                           NO dialog. These links come from the dashboard's
  //                           stalled-time callout, whose button says *Review*;
  //                           opening a download dialog over the list someone
  //                           came to read would be answering a question they
  //                           did not ask. Export… is right there in the head.
  const routeKey = route ? `${route.filter}:${route.from || ''}` : '';
  useEffect(() => {
    // A deep link carries a filter: apply it as chips and leave the list to be
    // read. Bare #/entries/export carries none, so it changes nothing about
    // what is on screen and simply opens the dialog over it.
    const deep = !!route && (route.filter !== 'all' || !!route.from);
    if (deep) {
      const next = { ...EMPTY_FILTERS, ...(FILTER_CHIPS[route.filter] || {}) };
      if (route.from) { next.from = route.from; next.to = todayStr(); }
      setFilters(next);
    }
    if (route && !deep) setExportScope({ pending: true, fromRoute: true });
    else setExportScope((s) => (s && s.fromRoute ? null : s));
  }, [routeKey]);

  // A route-opened dialog has no range until the ledger's rows have landed, so
  // it opens `pending` and takes its scope from the list a moment later.
  useEffect(() => {
    if (!exportScope || !exportScope.pending || loading) return;
    setExportScope({ ...scopeFor(filters, entries), fromRoute: true });
  }, [exportScope && exportScope.pending, loading, entries.length]);

  function closeExport() {
    const wasRoute = exportScope && exportScope.fromRoute;
    setExportScope(null);
    // Leave the export route behind, or the navigation item that opened this
    // becomes a dead control: tapping "Export" again would not change the hash
    // and nothing would reopen. A push, not a replace, so Back reopens it.
    if (wasRoute && exportRouteOf(location.hash)) location.hash = '#/entries';
  }

  // COUNTS YOU CAN ACT ON, in place of "everything ever recorded". The two
  // numbers a lawyer does something about are the drafts that still need a
  // narrative and the finalized time that has never been sent; each one is a
  // control that applies its own filter chip.
  const draftCount = entries.filter((e) => e.status === 'draft').length;
  const unsentCount = entries.filter((e) => e.status === 'finalized' && !e.exported_at).length;
  const stats = [];
  if (draftCount > 0 && filters.status !== 'draft') {
    stats.push({
      key: 'unfinalized', n: draftCount, label: 'unfinalized',
      title: 'Show only the entries that are still drafts',
      onClick: () => set({ status: 'draft', exported: '' }),
    });
  }
  if (unsentCount > 0 && !(filters.status === 'finalized' && filters.exported === 'no')) {
    stats.push({
      key: 'unsent', n: unsentCount, label: 'not sent',
      title: 'Show only the finalized entries that have never been exported',
      onClick: () => set({ status: 'finalized', exported: 'no' }),
    });
  }

  // ACTIVE FILTERS ARE CHIPS, NOT A PERMANENT WALL OF CONTROLS.
  // Attio, Linear and Notion all answer this the same way: the search box is
  // always there, and a filter you have actually applied becomes a chip you
  // can see and remove. The controls themselves live one tap away behind
  // "Filters".
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

  const headActions = html`
    <button type="button" class="btn ledger-export-btn" aria-haspopup="dialog"
      disabled=${entries.length === 0}
      title="Choose a file format for the entries this ledger is showing"
      onClick=${() => setExportScope(scopeFor(filters, entries))}>
      <${Icon} name="export" size=${16} /> Export…
    </button>`;

  return html`
    <${LedgerHead} title="Entries" count=${entries.length} hours=${total} increment=${increment}
      note=${filtered ? 'matching these filters' : null} actions=${headActions} stats=${stats} />

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
      selecting=${selecting} setSelecting=${setSelecting} bumpRefresh=${bumpRefresh}
      onExport=${() => setExportScope(scopeFor(
        filters, entries.filter((e) => selected.has(e.id)),
        { ids: [...selected], useListDates: true },
      ))} />

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
            <${LedgerTable} entries=${entries} increment=${increment}
              openEditor=${openEditor} onChanged=${bumpRefresh}
              selected=${selected} onToggle=${toggle} selecting=${selecting}
              onSelectAll=${() => setSelected(allSelected ? new Set() : new Set(entries.map((e) => e.id)))} />`}

    ${exportScope && !exportScope.pending ? html`
      <${ExportDialog} scope=${exportScope} increment=${increment}
        onClose=${closeExport} onDone=${bumpRefresh}
        onShowDrafts=${(f, t) => setFilters({ ...EMPTY_FILTERS, from: f, to: t, status: 'draft' })} />` : null}
  `;
}
