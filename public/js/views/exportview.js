import { api, downloadText } from '/js/api.js';
import {
  html, useState, useEffect, useAsync, Spinner, ErrorBox, fmtHours, todayStr, addDays,
  emitToast, BillableBadge, fmtStamp, Icon, markJustFinalized,
} from '/js/ui.js';

// The dashboard's "needs attention" pills deep-link in here as
// #/export/<filter>/<from>, so the page opens on a range that actually
// contains the flagged entries.
const FILTERS = [
  ['all', 'All', 'Everything in range (finalized only unless drafts are included)'],
  ['unfinalized', 'Not finalized', 'Time recorded but never locked in — it cannot export until it is finalized'],
  ['unexported', 'Not exported', 'Finalized and never sent, including anything edited after an earlier export'],
  ['either', 'Either', 'Everything still owed something — unfinalized or unexported'],
];

export function ExportView({ refreshKey, bumpRefresh, focus, focusFrom, openEditor }) {
  const [from, setFrom] = useState(focusFrom || todayStr());
  const [to, setTo] = useState(todayStr());
  const [includeDrafts, setIncludeDrafts] = useState(false);
  const [attention, setAttention] = useState(
    FILTERS.some(([k]) => k === focus) ? focus : 'all');

  // A later pill click re-enters the same mounted view, so the hash — not the
  // last thing clicked — decides the filter. Plain #/export means "all".
  useEffect(() => {
    setAttention(FILTERS.some(([k]) => k === focus) ? focus : 'all');
    if (focusFrom) { setFrom(focusFrom); setTo(todayStr()); }
  }, [focus, focusFrom]);

  const attQs = attention === 'all' ? '' : `&attention=${attention}`;
  const { loading, data, error, reload } = useAsync(
    () => api.get(`/api/export/preview?from=${from}&to=${to}&includeDrafts=${includeDrafts ? 1 : 0}${attQs}`),
    [from, to, includeDrafts, attention, refreshKey]);

  async function doExport(format) {
    const r = await api.post('/api/export', { from, to, includeDrafts, attention });
    if (r.count === 0) { emitToast('Nothing to export in that range.'); return; }
    const range = `${from}${from !== to ? `_${to}` : ''}`;
    if (format === 'tim') {
      downloadText(`time_${range.replace(/-/g, '')}.TIM`, r.tim, 'text/plain');
    } else {
      downloadText(`timekeeper-${range}.csv`, r.csv);
    }
    emitToast(`Exported ${r.count} ${r.count === 1 ? 'entry' : 'entries'} — ${format === 'tim' ? '.TIM' : 'CSV'} downloaded`);
    bumpRefresh();
  }

  async function finalize(entry) {
    try {
      await api.post(`/api/entries/${entry.id}/finalize`);
      markJustFinalized(entry.id);
      emitToast('Finalized', {
        actionLabel: 'Unlock',
        action: async () => { await api.post(`/api/entries/${entry.id}/unlock`); bumpRefresh(); },
      });
      bumpRefresh();
    } catch (e) {
      if (e.status === 422) openEditor({ id: entry.id }); // show the findings in the editor
      else emitToast(e.message, { error: true });
    }
  }

  async function copyText() {
    const r = await api.post('/api/export', { from, to, includeDrafts, attention, markExported: false });
    if (r.count === 0) { emitToast('Nothing in range.'); return; }
    await navigator.clipboard.writeText(r.text);
    emitToast('Plain-text summary copied to clipboard');
  }

  const entries = data?.entries || [];
  const shownHours = entries.reduce((a, e) => a + (Number(e.total) || 0), 0);
  // Drafts can ride along in a file (they always could, via "Include drafts")
  // but they are not stamped, so the export does not settle them.
  const draftCount = entries.filter((e) => e.status === 'draft' && e.cm).length;

  return html`
    <div class="page-head"><h1>Export</h1>
      <div class="spacer" style=${{ flex: 1 }}></div>
      ${data ? html`<span class="muted">${entries.length} ${entries.length === 1 ? 'entry' : 'entries'} shown · ${fmtHours(shownHours)}h</span>` : null}
    </div>
    <div class="card">
      <div class="row" style=${{ marginBottom: '10px' }}>
        <span class="muted small">Show</span>
        <div class="seg" role="group" aria-label="Status filter" style=${{ marginLeft: 0 }}>
          ${FILTERS.map(([key, label, tip]) => html`
            <button key=${key} class=${attention === key ? 'on' : ''} title=${tip}
              onClick=${() => setAttention(key)}>${label}</button>`)}
        </div>
        ${attention !== 'all' ? html`
          <span class="muted small">${FILTERS.find(([k]) => k === attention)[2]}</span>` : null}
      </div>
      ${/* Three groups — presets, range, actions (shell.css .filter-bar). A
            group may wrap; the controls inside one never wrap away from each
            other, which is what tore the date range apart at 390px. */''}
      <div class="filter-bar">
        <div class="filter-presets" role="group" aria-label="Quick ranges">
          <button class="btn btn-sm" onClick=${() => { setFrom(todayStr()); setTo(todayStr()); }}>Today</button>
          <button class="btn btn-sm" onClick=${() => { setFrom(addDays(todayStr(), -1)); setTo(addDays(todayStr(), -1)); }}>Yesterday</button>
          <button class="btn btn-sm" onClick=${() => {
            const t = todayStr();
            const dow = (new Date().getDay() + 6) % 7;
            setFrom(addDays(t, -dow)); setTo(t);
          }}>This week</button>
          <button class="btn btn-sm" onClick=${() => {
            const t = todayStr();
            setFrom(t.slice(0, 8) + '01'); setTo(t);
          }}>This month</button>
          <button class="btn btn-sm" onClick=${() => {
            const t = todayStr();
            const firstOfThis = new Date(t.slice(0, 8) + '01T12:00:00');
            const lastMonthEnd = new Date(firstOfThis.getTime() - 86400000);
            const y = lastMonthEnd.getFullYear();
            const m = String(lastMonthEnd.getMonth() + 1).padStart(2, '0');
            const d = String(lastMonthEnd.getDate()).padStart(2, '0');
            setFrom(`${y}-${m}-01`); setTo(`${y}-${m}-${d}`);
          }}>Last month</button>
        </div>
        <div class="date-range">
          <label class="range-field">
            <span class="field-label">From</span>
            <input type="date" value=${from} onChange=${(e) => setFrom(e.target.value)} />
          </label>
          <label class="range-field">
            <span class="field-label">To</span>
            <input type="date" value=${to} onChange=${(e) => setTo(e.target.value)} />
          </label>
        </div>
        <label class="checkbox-row" title=${attention === 'all' ? ''
          : 'The status filter already decides this'}>
          <input type="checkbox" checked=${attention === 'all' ? includeDrafts : attention !== 'unexported'}
            disabled=${attention !== 'all'}
            onChange=${(e) => setIncludeDrafts(e.target.checked)} />
          Include drafts
        </label>
        <div class="filter-actions">
          <button class="btn" onClick=${copyText} disabled=${!data || data.count === 0}>
            <${Icon} name="clipboard" size=${16} /> Copy text</button>
          <button class="btn" onClick=${() => doExport('csv')} disabled=${!data || data.count === 0}>
            <${Icon} name="download" size=${16} /> CSV${data ? ` (${data.count})` : ''}</button>
          <button class="btn btn-primary" onClick=${() => doExport('tim')} disabled=${!data || data.count === 0}>
            <${Icon} name="export" size=${16} /> .TIM${data ? ` (${data.count})` : ''}
          </button>
        </div>
      </div>
      <p class="muted small" style=${{ marginBottom: 0 }}>
        Only finalized entries export by default. The .TIM file imports directly into
        DTE Axiom/TimeSaver (constants in Settings). Exporting stamps each entry — re-export any time.
      </p>
      ${draftCount > 0 ? html`
        <p class="small" style=${{ marginBottom: 0, color: 'var(--status-warning)' }}>
          ${draftCount} of these ${draftCount === 1 ? 'is a draft' : 'are drafts'} — a draft goes into the
          file but is never stamped exported, so it will keep asking to be finalized.
        </p>` : null}
      ${data && data.unassociated > 0 ? html`
        <p class="small" style=${{ marginBottom: 0, color: 'var(--danger)' }}>
          ${data.unassociated} ${data.unassociated === 1 ? 'entry in this range has' : 'entries in this range have'} no
          client/matter and can’t export — assign ${data.unassociated === 1 ? 'one' : 'them'} from the entry list first.
        </p>` : null}
    </div>

    ${error ? html`<${ErrorBox} error=${error} />` : loading && !data ? html`<${Spinner} />` : html`
      <div class="card table-wrap table-cards export-table" style=${{ padding: 0 }}>
        <table class="tk">
          <thead><tr>
            <th>Date</th><th>CM</th><th>Narrative</th><th>Billable</th>
            <th style=${{ textAlign: 'right' }}>Hours</th><th>Exported</th><th></th>
          </tr></thead>
          <tbody>
            ${entries.map((e) => html`
              <tr key=${e.id} class=${e.cm ? '' : 'row-blocked'}>
                <td class="mono small">${e.date}</td>
                <td>${e.cm ? html`
                  <div>${e.cm.short_name}</div><div class="muted small mono">${e.cm.cm_number}</div>`
                  : html`<em class="muted">no matter yet — can’t export</em>`}</td>
                <td><div style=${{ maxWidth: '380px' }}>${e.narrative}</div>
                  ${e.status === 'draft' ? html`<span class="chip chip-draft">draft</span>` : null}
                  ${e.status === 'draft' && e.ever_finalized ? html`
                    <span class="chip chip-reverted" title=${'Finalized once, then unlocked'
                      + (e.exported_at ? ` — and already exported ${fmtStamp(e.exported_at)}` : '')}>
                      <${Icon} name="unlock" size=${12} /> unlocked</span>` : null}</td>
                <td><${BillableBadge} billable=${e.billable} /></td>
                <td class="mono" style=${{ textAlign: 'right' }}>${fmtHours(e.total)}</td>
                <td class="small muted">${e.status === 'draft'
                  ? (e.exported_at ? html`<span title=${`Sent ${fmtStamp(e.exported_at)}, edited since`}>stale</span>` : '—')
                  : e.exported_at ? `✓ ${fmtStamp(e.exported_at)}` : 'pending'}</td>
                <td>
                  ${e.status === 'draft' ? html`
                    <button class="btn btn-ghost btn-sm" title="Edit" onClick=${() => openEditor({ id: e.id })}><${Icon} name="edit" size=${16} /></button>
                    <button class="btn btn-ghost btn-sm" title="Finalize" onClick=${() => finalize(e)}><${Icon} name="lock" size=${16} /></button>` : html`
                    <button class="btn btn-ghost btn-sm" title="View" onClick=${() => openEditor({ id: e.id })}><${Icon} name="eye" size=${16} /></button>`}
                </td>
              </tr>`)}
            ${entries.length === 0 ? html`
              <tr><td colSpan="7" class="muted" style=${{ textAlign: 'center', padding: '30px' }}>
                ${attention === 'all'
                  ? html`Nothing in this range${includeDrafts ? '' : ' (finalized only — tick “Include drafts” to preview drafts)'}.`
                  : html`Nothing in this range needs attention — all of it is finalized and exported.`}
              </td></tr>` : null}
          </tbody>
        </table>
      </div>`}
  `;
}
