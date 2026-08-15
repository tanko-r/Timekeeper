// EXPORT — a mode of the entries ledger, not a destination of its own.
//
// The teardown (§12, §A) found this screen to be the ledger's list plus two
// columns and three buttons, holding a top-level navigation slot and a phone
// bottom-bar slot for a job done once a day — while Close the day already
// exports at the end of its sweep. So Export is one tap inside Entries now
// (#/entries/export), and everything below the filters comes from
// views/search.js: the same head, the same rows, the same bulk actions.
//
// THE DEEP-LINK CONTRACT IS UNCHANGED. The dashboard's attention line still
// links here as #/export/<filter>/<from>; app.js canonicalises that to
// #/entries/export/<filter>/<from> and hands the two arguments to this view as
// `focus` and `focusFrom`, exactly as before. #/export alone still means
// "everything in range, finalized only".
//
// AND THE WORD "EXPORT" NO LONGER NAMES A FILE. The teardown's labelling bug:
// four buttons across the app said "Export" and produced two different
// formats, so a lawyer who exported from the dashboard and then fed the file
// to DTE Axiom had been misled by our own wording. Every control here says
// which file it makes — "Download .TIM", "Download CSV", "Copy as text" — and
// the word Export is left to name the SCREEN, which is the one thing it can
// name unambiguously.
import { api, downloadText } from '/js/api.js';
import {
  html, React, useState, useEffect, useAsync, Spinner, ErrorBox, Icon,
  todayStr, emitToast,
} from '/js/ui.js';
import { LedgerHead, LedgerSelection, LedgerTable, RangeControls } from '/js/views/search.js';
import { EmptyState } from '/js/components/entrylist.js';

// The dashboard's attention line deep-links in here as #/export/<filter>/<from>,
// so the page opens on a range that actually contains the flagged entries.
const FILTERS = [
  ['all', 'All', 'Everything in range (finalized only unless drafts are included)'],
  ['unfinalized', 'Not finalized', 'Time recorded but never locked in — it cannot export until it is finalized'],
  ['unexported', 'Not exported', 'Finalized and never sent, including anything edited after an earlier export'],
  ['either', 'Either', 'Everything still owed something — unfinalized or unexported'],
];

// The three things this screen can produce, each named by the file it makes.
const FORMATS = {
  tim: { label: 'Download .TIM', icon: 'export' },
  csv: { label: 'Download CSV', icon: 'download' },
};

export function ExportView({ settings, refreshKey, bumpRefresh, focus, focusFrom, openEditor }) {
  const increment = settings?.rounding?.increment || 0.1;
  const [from, setFrom] = useState(focusFrom || todayStr());
  const [to, setTo] = useState(todayStr());
  const [includeDrafts, setIncludeDrafts] = useState(false);
  const [attention, setAttention] = useState(
    FILTERS.some(([k]) => k === focus) ? focus : 'all');
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState(() => new Set());

  // A later deep link re-enters the same mounted view, so the hash — not the
  // last thing clicked — decides the filter. Plain #/export means "all".
  useEffect(() => {
    setAttention(FILTERS.some(([k]) => k === focus) ? focus : 'all');
    if (focusFrom) { setFrom(focusFrom); setTo(todayStr()); }
  }, [focus, focusFrom]);

  const attQs = attention === 'all' ? '' : `&attention=${attention}`;
  const { loading, data, error } = useAsync(
    () => api.get(`/api/export/preview?from=${from}&to=${to}&includeDrafts=${includeDrafts ? 1 : 0}${attQs}`),
    [from, to, includeDrafts, attention, refreshKey]);

  const entries = data?.entries || [];
  const shownHours = entries.reduce((a, e) => a + (Number(e.total) || 0), 0);
  // Drafts can ride along in a file (they always could, via "Include drafts")
  // but they are not stamped, so the export does not settle them.
  const draftCount = entries.filter((e) => e.status === 'draft' && e.cm).length;
  const ready = data ? data.count : 0;

  useEffect(() => { setSelected(new Set()); }, [from, to, includeDrafts, attention, refreshKey]);

  async function doExport(format) {
    const r = await api.post('/api/export', { from, to, includeDrafts, attention });
    if (r.count === 0) { emitToast('Nothing to export in that range.'); return; }
    const range = `${from}${from !== to ? `_${to}` : ''}`;
    if (format === 'tim') {
      downloadText(`time_${range.replace(/-/g, '')}.TIM`, r.tim, 'text/plain');
    } else {
      downloadText(`timekeeper-${range}.csv`, r.csv);
    }
    emitToast(`${r.count} ${r.count === 1 ? 'entry' : 'entries'} written to a ${format === 'tim' ? '.TIM' : 'CSV'} file`);
    bumpRefresh();
  }

  async function copyText() {
    const r = await api.post('/api/export', { from, to, includeDrafts, attention, markExported: false });
    if (r.count === 0) { emitToast('Nothing in range.'); return; }
    await navigator.clipboard.writeText(r.text);
    emitToast('Plain-text summary copied to the clipboard');
  }

  const toggle = (id) => setSelected((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });
  const allSelected = entries.length > 0 && entries.every((e) => selected.has(e.id));

  // One filled primary per screen (tokens.css §7a) — and it is the file that
  // actually goes to the billing system.
  const actions = html`
    <${React.Fragment}>
      <button type="button" class="btn" onClick=${copyText} disabled=${!data || ready === 0}
        title="Put a plain-text summary on the clipboard — no file, and nothing is marked exported">
        <${Icon} name="clipboard" size=${16} /> Copy as text</button>
      <button type="button" class="btn" onClick=${() => doExport('csv')} disabled=${!data || ready === 0}
        title="Download these entries as a CSV spreadsheet">
        <${Icon} name=${FORMATS.csv.icon} size=${16} /> ${FORMATS.csv.label}</button>
      <button type="button" class="btn btn-primary" onClick=${() => doExport('tim')} disabled=${!data || ready === 0}
        title="Download the DTE Axiom / TimeSaver import file">
        <${Icon} name=${FORMATS.tim.icon} size=${16} /> ${FORMATS.tim.label}${data ? ` (${ready})` : ''}</button>
    <//>`;

  return html`
    <${LedgerHead} title="Export" count=${entries.length} hours=${shownHours} increment=${increment}
      note=${data ? `${ready} ready to send` : null} actions=${actions} />

    <div class="card ledger-filters ledger-export-filters">
      <div class="ledger-field-row">
        <span class="field-label" id="tk-export-show">Show</span>
        <div class="seg ledger-seg" role="group" aria-labelledby="tk-export-show">
          ${FILTERS.map(([key, label, tip]) => html`
            <button key=${key} type="button" class=${attention === key ? 'on' : ''} title=${tip}
              aria-pressed=${attention === key ? 'true' : 'false'}
              onClick=${() => setAttention(key)}>${label}</button>`)}
        </div>
      </div>
      <p class="muted small ledger-filter-note">
        ${FILTERS.find(([k]) => k === attention)[2]}
      </p>

      <div class="filter-bar">
        <${RangeControls} from=${from} to=${to} onRange=${(f, t) => { setFrom(f); setTo(t); }} />
        ${/* A CHECKBOX THAT CHANGES WITHOUT YOU TOUCHING IT IS A LIE (teardown
              §12): this used to render disabled, with a COMPUTED tick, whenever
              the status filter was not "All". It is a real control when it is a
              real choice, and a sentence when the filter has already decided. */''}
        ${attention === 'all' ? html`
          <label class="checkbox-row">
            <input type="checkbox" checked=${includeDrafts}
              onChange=${(e) => setIncludeDrafts(e.target.checked)} />
            Include drafts
          </label>` : html`
          <p class="muted small ledger-drafts-note">
            ${attention === 'unexported'
              ? 'Finalized entries only — that is what “not exported” means.'
              : 'Drafts are included: this filter is looking for them.'}
          </p>`}
      </div>

      ${/* WHICH BUTTON MAKES WHICH FILE. */''}
      <p class="muted small ledger-formats">
        <strong>.TIM</strong> is the DTE Axiom / TimeSaver import file (its constants live in
        Settings → .TIM export). <strong>CSV</strong> is the same entries as a spreadsheet.${' '}
        <strong>Copy as text</strong> puts a readable summary on the clipboard — no file, and
        nothing is marked as sent. Downloading a file stamps each entry exported; you can
        re-export any time.
      </p>
      ${draftCount > 0 ? html`
        <p class="small ledger-warn-draft">
          ${draftCount} of these ${draftCount === 1 ? 'is a draft' : 'are drafts'} — a draft goes into the
          file but is never stamped exported, so it will keep asking to be finalized.
        </p>` : null}
      ${data && data.unassociated > 0 ? html`
        <p class="small ledger-warn-blocked">
          ${data.unassociated} ${data.unassociated === 1 ? 'entry in this range has' : 'entries in this range have'} no
          client/matter and can’t export — assign ${data.unassociated === 1 ? 'one' : 'them'} from the list below first.
        </p>` : null}
    </div>

    <${LedgerSelection} entries=${entries} selected=${selected} setSelected=${setSelected}
      selecting=${selecting} setSelecting=${setSelecting} bumpRefresh=${bumpRefresh} />

    ${error ? html`<${ErrorBox} error=${error} />`
      : loading && !data ? html`<${Spinner} />`
        : entries.length === 0 ? html`
          <div class="card ledger-empty">
            <${EmptyState} icon="export"
              heading=${attention === 'all' ? 'Nothing in this range to send' : 'Nothing in this range needs attention'}
              description=${attention === 'all'
                ? (includeDrafts
                  ? 'No entries at all fall between these two dates. Try a wider range.'
                  : 'Only finalized entries export by default. Widen the range, or tick “Include drafts” to see what is still unfinished.')
                : 'Every entry between these two dates is finalized and already exported.'}
              actionLabel="Widen to this month"
              onAction=${() => { const t = todayStr(); setFrom(`${t.slice(0, 8)}01`); setTo(t); }} />
          </div>`
          : html`
            <${LedgerTable} entries=${entries} increment=${increment} mode="export"
              openEditor=${openEditor} onChanged=${bumpRefresh}
              selected=${selected} onToggle=${toggle} selecting=${selecting}
              onSelectAll=${() => setSelected(allSelected ? new Set() : new Set(entries.map((e) => e.id)))} />`}
  `;
}
