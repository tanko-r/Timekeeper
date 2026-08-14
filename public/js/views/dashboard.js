import { api, downloadText } from '/js/api.js';
import {
  html, useState, useEffect, useMemo, useCallback, useAsync, Spinner, ErrorBox, fmtHours, fmtDateLong,
  fmtDateFull, addDays, emitToast, Confirm, Icon,
} from '/js/ui.js';
import { TimerGrid } from '/js/components/timergrid.js';
import { TargetMeter } from '/js/components/targetmeter.js';
import { EntryList } from '/js/components/entrylist.js';
import { TodayFooter } from '/js/components/todayfooter.js';
import { CloseOut } from '/js/components/closeout.js';
import { SummaryModal } from '/js/components/summary.js';
import { buildDaySummary } from '/js/lib/daysummary.js';
import { nav } from '/js/app.js';

export function DashboardView({ settings, openEditor, refreshKey, bumpRefresh }) {
  const { loading, data, error, reload } = useAsync(() => api.get('/api/dashboard'), [refreshKey]);
  const [warnGate, setWarnGate] = useState(null);
  const [closeOut, setCloseOut] = useState(false);
  const [summary, setSummary] = useState(null);
  // Timestamp of the dashboard payload — the footer adds wall-clock time since
  // this moment to the (fetch-frozen) running-timer seconds.
  const fetchedAt = useMemo(() => Date.now(), [data]);
  useEffect(() => {
    const onCloseDay = () => setCloseOut(true);
    window.addEventListener('tk:close-day', onCloseDay);
    return () => window.removeEventListener('tk:close-day', onCloseDay);
  }, []);

  // Today read back as prose — everything filed, drafts included, since this
  // is for recall rather than for billing. Shared by the footer button and
  // the `s` shortcut, so it lives above the early returns.
  const showSummary = useCallback(() => {
    if (!data) return;
    setSummary(buildDaySummary(data.entries, {
      title: fmtDateFull(data.date),
      increment: settings?.rounding?.increment || 0.1,
    }));
  }, [data, settings]);

  useEffect(() => {
    window.addEventListener('tk:day-summary', showSummary);
    return () => window.removeEventListener('tk:day-summary', showSummary);
  }, [showSummary]);

  // Re-pull today's totals + running timers when the tab/PWA wakes, so the
  // footer clock and filed total are current on resume (mobile pauses timers
  // while backgrounded). See TimerGrid for the same pattern.
  useEffect(() => {
    const onWake = () => { if (document.visibilityState === 'visible') reload(); };
    document.addEventListener('visibilitychange', onWake);
    window.addEventListener('focus', onWake);
    return () => {
      document.removeEventListener('visibilitychange', onWake);
      window.removeEventListener('focus', onWake);
    };
  }, [reload]);

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

  // entries whose timer is running right now get the pulsing "running" chip.
  // (Running quick timers used to render as ghost rows here — their entry is
  // a REAL matterless entry in the list now, 2026-07-13.)
  const runningEntryIds = new Set((d.timers || [])
    .filter((t) => t.running && t.linked_entry_id).map((t) => t.linked_entry_id));

  const alerts = d.alerts;
  const hasAlerts = alerts.invalidDrafts.length > 0 || alerts.unfinalized.count > 0
    || alerts.reverted.count > 0 || alerts.unexported.count > 0;

  // Each stalled bucket opens the Export page already filtered to itself, from
  // the oldest entry in it — the range is what makes the entries visible, so
  // guessing it would be the one way this click-through could lie.
  const attentionLink = (kind, b) => `#/export/${kind}/${b.oldest}`;

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
      <button class="btn" onClick=${() => finalizeToday()}><${Icon} name="lock" size=${16} /> Finalize today</button>
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
              ${a.short_name ?? 'No matter yet'} — ${a.codes.includes('no_matter') ? 'assign a matter'
                : a.codes.includes('narrative_empty') ? 'no narrative' : 'check validation'}
            </button>`)}
          ${alerts.unfinalized.count > 0 ? html`
            <button class="alert-pill" title=${`Oldest ${alerts.unfinalized.oldest} — time recorded on a day that is already over`}
              onClick=${() => nav(attentionLink('unfinalized', alerts.unfinalized))}>
              ${alerts.unfinalized.count} ${alerts.unfinalized.count === 1 ? 'entry' : 'entries'} on earlier
              days not finalized · ${fmtHours(alerts.unfinalized.hours)}h
            </button>` : null}
          ${alerts.reverted.count > 0 ? html`
            <button class="alert-pill" title=${'Finalized once and unlocked since — it still reads as done everywhere else'}
              onClick=${() => nav(attentionLink('unfinalized', alerts.reverted))}>
              ${alerts.reverted.count} unlocked after finalizing · ${fmtHours(alerts.reverted.hours)}h
            </button>` : null}
          ${alerts.unexported.count > 0 ? html`
            <button class="alert-pill" title=${`Oldest ${alerts.unexported.oldest} — finalized but never sent`}
              onClick=${() => nav(attentionLink('unexported', alerts.unexported))}>
              ${alerts.unexported.count} finalized ${alerts.unexported.count === 1 ? 'entry' : 'entries'}
              not yet exported · ${fmtHours(alerts.unexported.hours)}h
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
      <${EntryList} entries=${d.entries} openEditor=${openEditor} onChanged=${bumpRefresh}
        settings=${settings} runningIds=${runningEntryIds} timers=${d.timers} fetchedAt=${fetchedAt} />
    </div>

    ${warnGate ? html`
      <${Confirm} title="Finalize with warnings?" confirmLabel="Finalize anyway"
        message=${warnGate.message}
        onConfirm=${() => finalizeToday(true)}
        onClose=${() => setWarnGate(null)} />` : null}
    </div>

    <${TodayFooter} today=${d.today} timers=${d.timers} fetchedAt=${fetchedAt}
      onCloseDay=${() => setCloseOut(true)} onSummary=${showSummary} />

    ${summary ? html`
      <${SummaryModal} text=${summary} title=${`Summary — ${fmtDateFull(d.date)}`}
        filename=${`timekeeper-summary-${d.date}.txt`} onClose=${() => setSummary(null)} />` : null}

    ${closeOut ? html`
      <${CloseOut} onClose=${(changed) => { setCloseOut(false); if (changed) bumpRefresh(); }} openEditor=${openEditor} />` : null}
  `;
}
