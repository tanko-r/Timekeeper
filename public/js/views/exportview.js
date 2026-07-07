import { api, downloadText } from '/js/api.js';
import {
  html, useState, useAsync, Spinner, ErrorBox, fmtHours, todayStr, addDays,
  emitToast, BillableBadge, fmtStamp, Icon,
} from '/js/ui.js';

export function ExportView({ refreshKey, bumpRefresh }) {
  const [from, setFrom] = useState(todayStr());
  const [to, setTo] = useState(todayStr());
  const [includeDrafts, setIncludeDrafts] = useState(false);

  const { loading, data, error, reload } = useAsync(
    () => api.get(`/api/export/preview?from=${from}&to=${to}&includeDrafts=${includeDrafts ? 1 : 0}`),
    [from, to, includeDrafts, refreshKey]);

  async function doExport(format) {
    const r = await api.post('/api/export', { from, to, includeDrafts });
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

  async function copyText() {
    const r = await api.post('/api/export', { from, to, includeDrafts, markExported: false });
    if (r.count === 0) { emitToast('Nothing in range.'); return; }
    await navigator.clipboard.writeText(r.text);
    emitToast('Plain-text summary copied to clipboard');
  }

  const entries = data?.entries || [];

  return html`
    <div class="page-head"><h1>Export</h1></div>
    <div class="card">
      <div class="row">
        <button class="btn btn-sm" onClick=${() => { setFrom(todayStr()); setTo(todayStr()); }}>Today</button>
        <button class="btn btn-sm" onClick=${() => { setFrom(addDays(todayStr(), -1)); setTo(addDays(todayStr(), -1)); }}>Yesterday</button>
        <button class="btn btn-sm" onClick=${() => {
          const t = todayStr();
          const dow = (new Date().getDay() + 6) % 7;
          setFrom(addDays(t, -dow)); setTo(t);
        }}>This week</button>
        <input type="date" value=${from} style=${{ width: '160px' }} onChange=${(e) => setFrom(e.target.value)} />
        <span class="muted">→</span>
        <input type="date" value=${to} style=${{ width: '160px' }} onChange=${(e) => setTo(e.target.value)} />
        <label class="checkbox-row">
          <input type="checkbox" checked=${includeDrafts} onChange=${(e) => setIncludeDrafts(e.target.checked)} />
          Include drafts
        </label>
        <div class="spacer" style=${{ flex: 1 }}></div>
        <button class="btn" onClick=${copyText} disabled=${!data || data.count === 0}>
          <${Icon} name="clipboard" size=${16} /> Copy text</button>
        <button class="btn" onClick=${() => doExport('csv')} disabled=${!data || data.count === 0}>
          <${Icon} name="download" size=${16} /> CSV${data ? ` (${data.count})` : ''}</button>
        <button class="btn btn-primary" onClick=${() => doExport('tim')} disabled=${!data || data.count === 0}>
          <${Icon} name="export" size=${16} /> .TIM${data ? ` (${data.count})` : ''}
        </button>
      </div>
      <p class="muted small" style=${{ marginBottom: 0 }}>
        Only finalized entries export by default. The .TIM file imports directly into
        DTE Axiom/TimeSaver (constants in Settings). Exporting stamps each entry — re-export any time.
      </p>
    </div>

    ${error ? html`<${ErrorBox} error=${error} />` : loading && !data ? html`<${Spinner} />` : html`
      <div class="card table-wrap" style=${{ padding: 0 }}>
        <table class="tk">
          <thead><tr>
            <th>Date</th><th>CM</th><th>Narrative</th><th>Billable</th>
            <th style=${{ textAlign: 'right' }}>Hours</th><th>Exported</th>
          </tr></thead>
          <tbody>
            ${entries.map((e) => html`
              <tr key=${e.id}>
                <td class="mono small">${e.date}</td>
                <td><div>${e.cm.short_name}</div><div class="muted small mono">${e.cm.cm_number}</div></td>
                <td><div style=${{ maxWidth: '380px' }}>${e.narrative}</div>
                  ${e.status === 'draft' ? html`<span class="chip chip-draft">draft</span>` : null}</td>
                <td><${BillableBadge} billable=${e.billable} /></td>
                <td class="mono" style=${{ textAlign: 'right' }}>${fmtHours(e.total)}</td>
                <td class="small muted">${e.exported_at ? `✓ ${fmtStamp(e.exported_at)}` : 'pending'}</td>
              </tr>`)}
            ${entries.length === 0 ? html`
              <tr><td colSpan="6" class="muted" style=${{ textAlign: 'center', padding: '30px' }}>
                Nothing in this range${includeDrafts ? '' : ' (finalized only — tick “Include drafts” to preview drafts)'}.
              </td></tr>` : null}
          </tbody>
        </table>
      </div>`}
  `;
}
