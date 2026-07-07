import { api, downloadText } from '/js/api.js';
import {
  html, useAsync, Spinner, ErrorBox, fmtHours, fmtDateLong, emitToast,
  BillableBadge, StatusChip, ValidationList,
} from '/js/ui.js';
import { TimerGrid } from '/js/components/timergrid.js';
import { TargetMeter } from '/js/components/targetmeter.js';
import { EntryList } from '/js/components/entrylist.js';
import { nav } from '/js/app.js';

export function DashboardView({ settings, openEditor, refreshKey, bumpRefresh }) {
  const { loading, data, error, reload } = useAsync(() => api.get('/api/dashboard'), [refreshKey]);

  if (error) return html`<${ErrorBox} error=${error} />`;
  if (loading && !data) return html`<${Spinner} />`;
  const d = data;

  const alerts = d.alerts;
  const hasAlerts = alerts.invalidDrafts.length > 0 || alerts.backlogCount > 0 || alerts.unexportedFinalized > 0;

  async function finalizeToday() {
    const r = await api.post('/api/finalize-day', { date: d.date, ack: true });
    if (r.blocked.length > 0) {
      emitToast(`${r.finalized.length} finalized — ${r.blocked.length} blocked (missing narrative?)`, { error: true });
    } else if (r.finalized.length > 0) {
      emitToast(`Finalized ${r.finalized.length} ${r.finalized.length === 1 ? 'entry' : 'entries'}`);
    } else {
      emitToast('Nothing to finalize today.');
    }
    bumpRefresh();
  }

  async function exportToday() {
    const r = await api.post('/api/export', { from: d.date, to: d.date });
    if (r.count === 0) {
      emitToast('No finalized entries today — finalize first (or use the Export page for drafts).');
      return;
    }
    downloadText(`timekeeper-${d.date}.csv`, r.csv);
    emitToast(`Exported ${r.count} ${r.count === 1 ? 'entry' : 'entries'}`);
    bumpRefresh();
  }

  return html`
    <div class="page-head">
      <h1>${fmtDateLong(d.date)}</h1>
      <div class="spacer"></div>
      <button class="btn" onClick=${finalizeToday}>🔒 Finalize today</button>
      <button class="btn" onClick=${exportToday}>📤 Export today</button>
      <button class="btn btn-primary" onClick=${() => openEditor({ template: {} })}>＋ New entry (n)</button>
    </div>

    ${hasAlerts ? html`
      <div class="alert-banner" style=${{ marginBottom: '14px' }}>
        <div class="row">
          <strong>Needs attention:</strong>
          ${alerts.invalidDrafts.map((a) => html`
            <button key=${a.id} class="alert-pill" title=${a.codes.join(', ')}
              onClick=${() => openEditor({ id: a.id })}>
              ✍️ ${a.short_name} — ${a.codes.includes('narrative_empty') ? 'no narrative' : 'check validation'}
            </button>`)}
          ${alerts.backlogCount > 0 ? html`
            <button class="alert-pill" onClick=${() => nav('#/search')}>
              📚 ${alerts.backlogCount} older draft${alerts.backlogCount === 1 ? '' : 's'} need review
            </button>` : null}
          ${alerts.unexportedFinalized > 0 ? html`
            <button class="alert-pill" onClick=${() => nav('#/export')}>
              📤 ${alerts.unexportedFinalized} finalized ${alerts.unexportedFinalized === 1 ? 'entry' : 'entries'} not yet exported
            </button>` : null}
        </div>
      </div>` : null}

    <div class="card">
      <h2>Today</h2>
      <${TargetMeter} billable=${d.today.billable} nonbillable=${d.today.nonbillable} target=${d.today.target} />
    </div>

    <div class="section-title"><h2>Timers</h2></div>
    <${TimerGrid} settings=${settings} onEntryChanged=${bumpRefresh} openEditor=${openEditor} />

    <div class="section-title">
      <h2>Today’s entries</h2>
      <span class="muted small">${d.entries.length} ${d.entries.length === 1 ? 'entry' : 'entries'} · ${fmtHours(d.today.total)}h</span>
    </div>
    <${EntryList} entries=${d.entries} openEditor=${openEditor} onChanged=${bumpRefresh} settings=${settings} />
  `;
}
