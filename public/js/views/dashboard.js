import { api, downloadText } from '/js/api.js';
import {
  html, useState, useEffect, useMemo, useAsync, Spinner, ErrorBox, fmtHours, fmtDateLong, addDays, emitToast, Confirm, Icon,
} from '/js/ui.js';
import { TimerGrid } from '/js/components/timergrid.js';
import { TargetMeter } from '/js/components/targetmeter.js';
import { EntryList } from '/js/components/entrylist.js';
import { TodayFooter } from '/js/components/todayfooter.js';
import { CloseOut } from '/js/components/closeout.js';
import { nav } from '/js/app.js';

export function DashboardView({ settings, openEditor, refreshKey, bumpRefresh }) {
  const { loading, data, error, reload } = useAsync(() => api.get('/api/dashboard'), [refreshKey]);
  const [warnGate, setWarnGate] = useState(null);
  const [closeOut, setCloseOut] = useState(false);
  // Timestamp of the dashboard payload — the footer adds wall-clock time since
  // this moment to the (fetch-frozen) running-timer seconds.
  const fetchedAt = useMemo(() => Date.now(), [data]);
  useEffect(() => {
    const onCloseDay = () => setCloseOut(true);
    window.addEventListener('tk:close-day', onCloseDay);
    return () => window.removeEventListener('tk:close-day', onCloseDay);
  }, []);

  // [ / ] step into the adjacent days' viewers, same keys as the day view
  useEffect(() => {
    if (!data) return undefined;
    const onKey = (e) => {
      const tag = (e.target.tagName || '').toLowerCase();
      if (['input', 'textarea', 'select'].includes(tag)) return;
      if (e.key === '[') nav(`#/day/${addDays(data.date, -1)}`);
      if (e.key === ']') nav(`#/day/${addDays(data.date, 1)}`);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [data]);

  if (error) return html`<${ErrorBox} error=${error} />`;
  if (loading && !data) return html`<${Spinner} />`;
  const d = data;

  // entries whose timer is running right now get the pulsing "running" chip;
  // running quick timers with no matter yet render as ghost rows below
  const runningEntryIds = new Set((d.timers || [])
    .filter((t) => t.running && t.linked_entry_id).map((t) => t.linked_entry_id));
  const unassignedRunning = (d.timers || []).filter((t) => t.running && !t.cm_id);

  const alerts = d.alerts;
  const hasAlerts = alerts.invalidDrafts.length > 0 || alerts.backlogCount > 0 || alerts.unexportedFinalized > 0;

  // Two-step finalize: warnings must be seen before they're acknowledged.
  async function finalizeToday(ack = false) {
    const r = await api.post('/api/finalize-day', { date: d.date, ack });
    const warnOnly = r.blocked.filter((b) => b.blocks.length === 0);
    const hard = r.blocked.length - warnOnly.length;
    if (!ack && warnOnly.length > 0) {
      const msgs = [...new Set(warnOnly.flatMap((b) => b.warns.map((w) => w.message)))].slice(0, 4);
      setWarnGate({
        count: warnOnly.length,
        message: `${warnOnly.length} ${warnOnly.length === 1 ? 'entry has' : 'entries have'} validation warnings: ${msgs.join(' · ')}`,
      });
      if (r.finalized.length) emitToast(`${r.finalized.length} clean ${r.finalized.length === 1 ? 'entry' : 'entries'} finalized`);
      bumpRefresh();
      return;
    }
    if (hard > 0) {
      emitToast(`${r.finalized.length} finalized — ${hard} blocked (missing narrative?). Open them from the banner.`, { error: true });
    } else if (r.finalized.length > 0) {
      emitToast(`Finalized ${r.finalized.length} ${r.finalized.length === 1 ? 'entry' : 'entries'}`);
    } else if (!ack) {
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
    <div class="dashboard-view">
    <div class="page-head">
      <button class="btn" title="Previous day ([) — past days keep everything recorded on them"
        onClick=${() => nav(`#/day/${addDays(d.date, -1)}`)}><${Icon} name="chevronLeft" size=${16} /></button>
      <h1>${fmtDateLong(d.date)}</h1>
      <button class="btn" title="Next day (])"
        onClick=${() => nav(`#/day/${addDays(d.date, 1)}`)}><${Icon} name="chevronRight" size=${16} /></button>
      <div class="spacer"></div>
      <button class="btn" onClick=${finalizeToday}><${Icon} name="lock" size=${16} /> Finalize today</button>
      <button class="btn" onClick=${exportToday}><${Icon} name="export" size=${16} /> Export today</button>
      <button class="btn btn-primary" onClick=${() => openEditor({ template: {} })}>
        <${Icon} name="plus" size=${16} /> New entry (n)</button>
    </div>

    ${hasAlerts ? html`
      <div class="alert-banner" style=${{ marginBottom: '14px' }}>
        <div class="row">
          <strong><${Icon} name="alert" size=${16} /> Needs attention:</strong>
          ${alerts.invalidDrafts.map((a) => html`
            <button key=${a.id} class="alert-pill" title=${a.codes.join(', ')}
              onClick=${() => openEditor({ id: a.id })}>
              ${a.short_name} — ${a.codes.includes('narrative_empty') ? 'no narrative' : 'check validation'}
            </button>`)}
          ${alerts.backlogCount > 0 ? html`
            <button class="alert-pill" onClick=${() => nav('#/search')}>
              ${alerts.backlogCount} older draft${alerts.backlogCount === 1 ? '' : 's'} need review
            </button>` : null}
          ${alerts.unexportedFinalized > 0 ? html`
            <button class="alert-pill" onClick=${() => nav('#/export')}>
              ${alerts.unexportedFinalized} finalized ${alerts.unexportedFinalized === 1 ? 'entry' : 'entries'} not yet exported
            </button>` : null}
        </div>
      </div>` : null}

    <div class="card">
      <h2>Today</h2>
      <${TargetMeter} billable=${d.today.billable} nonbillable=${d.today.nonbillable} target=${d.today.target} />
    </div>

    <div class="panel">
      <${TimerGrid} settings=${settings} onEntryChanged=${bumpRefresh} openEditor=${openEditor} />
    </div>

    <div class="panel">
      <div class="section-title">
        <h2>Today’s entries</h2>
        <span class="muted small">${d.entries.length} ${d.entries.length === 1 ? 'entry' : 'entries'} · ${fmtHours(d.today.total)}h</span>
      </div>
      ${unassignedRunning.map((t) => html`
        <div key=${'ghost-' + t.id} class="entry-card running-ghost">
          <div class="body">
            <div class="entry-meta">
              <span class="chip chip-running"><${Icon} name="timer" size=${12} /> running</span>
              <strong>${t.name}</strong>
            </div>
            <p class="narrative"><em class="muted">No matter yet — this time becomes an entry once one is assigned.</em></p>
          </div>
          <div style=${{ textAlign: 'right' }}>
            <div class="hours muted">${fmtHours(Math.ceil((t.elapsed_seconds / 3600) * 10) / 10)}</div>
            <button class="btn btn-sm"
              onClick=${() => window.dispatchEvent(new CustomEvent('tk:edit-timer', { detail: { id: t.id } }))}>
              Assign matter
            </button>
          </div>
        </div>`)}
      <${EntryList} entries=${d.entries} openEditor=${openEditor} onChanged=${bumpRefresh}
        settings=${settings} runningIds=${runningEntryIds} />
    </div>

    ${warnGate ? html`
      <${Confirm} title="Finalize with warnings?" confirmLabel="Finalize anyway"
        message=${warnGate.message}
        onConfirm=${() => finalizeToday(true)}
        onClose=${() => setWarnGate(null)} />` : null}
    </div>

    <${TodayFooter} today=${d.today} timers=${d.timers} fetchedAt=${fetchedAt} onCloseDay=${() => setCloseOut(true)} />

    ${closeOut ? html`
      <${CloseOut} onClose=${(changed) => { setCloseOut(false); if (changed) bumpRefresh(); }} openEditor=${openEditor} />` : null}
  `;
}
