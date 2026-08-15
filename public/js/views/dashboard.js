import { api, downloadText } from '/js/api.js';
import {
  html, useState, useEffect, useMemo, useCallback, useAsync, Spinner, ErrorBox, fmtHours, fmtDateLong,
  fmtDateFull, addDays, todayStr, emitToast, Confirm, ContextMenu, Icon,
} from '/js/ui.js';
import { TodayList } from '/js/components/timergrid.js';
import { TargetMeter } from '/js/components/targetmeter.js';
import { TodayFooter } from '/js/components/todayfooter.js';
import { CloseOut } from '/js/components/closeout.js';
import { SummaryModal } from '/js/components/summary.js';
import { buildDaySummary } from '/js/lib/daysummary.js';
import { nav } from '/js/app.js';

// Monday of the ISO week containing `dateStr`.
function mondayOf(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d, 12);
  dt.setDate(dt.getDate() - ((dt.getDay() + 6) % 7));
  return todayStr(dt);
}

export function DashboardView({ settings, openEditor, refreshKey, bumpRefresh }) {
  const { loading, data, error, reload } = useAsync(() => api.get('/api/dashboard'), [refreshKey]);
  const [warnGate, setWarnGate] = useState(null);
  const [closeOut, setCloseOut] = useState(false);
  const [summary, setSummary] = useState(null);
  const [dayMenu, setDayMenu] = useState(null);

  // WEEK TO DATE (teardown D6: "the number a lawyer actually manages — am I on
  // pace this week — appears nowhere on the screen he lives on"). One extra
  // read of the existing /api/stats range endpoint; no API change.
  const weekRange = useMemo(() => {
    const today = todayStr();
    return { from: mondayOf(today), to: today };
  }, [refreshKey]);
  const week = useAsync(
    () => api.get(`/api/stats?from=${weekRange.from}&to=${weekRange.to}`).catch(() => null),
    [weekRange.from, weekRange.to, refreshKey]);

  useEffect(() => {
    const onCloseDay = () => setCloseOut(true);
    window.addEventListener('tk:close-day', onCloseDay);
    return () => window.removeEventListener('tk:close-day', onCloseDay);
  }, []);

  // Today read back as prose — everything filed, drafts included, since this
  // is for recall rather than for billing. Shared by the day menu and the
  // `s` shortcut, so it lives above the early returns.
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
  // while backgrounded). See TodayList for the same pattern.
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

  const alerts = d.alerts;
  // Per-entry defects are inline states on their own rows now (teardown §3);
  // what stays up here is the count plus a jump to the first one.
  const needNarrative = alerts.invalidDrafts.filter((a) => a.codes.includes('narrative_empty'));
  const needMatter = alerts.invalidDrafts.filter((a) => a.codes.includes('no_matter'));
  const otherInvalid = alerts.invalidDrafts.filter(
    (a) => !a.codes.includes('narrative_empty') && !a.codes.includes('no_matter'));

  // Each stalled bucket opens the Export page already filtered to itself, from
  // the oldest entry in it — the range is what makes the entries visible, so
  // guessing it would be the one way this click-through could lie.
  const attentionLink = (kind, b) => `#/export/${kind}/${b.oldest}`;
  const jumpToEntry = (id) => window.dispatchEvent(new CustomEvent('tk:focus-entry', { detail: { id } }));

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
      emitToast(`${r.finalized.length} finalized — ${hard} blocked (missing narrative?). Close the day walks you through them.`, { error: true });
    } else if (r.finalized.length > 0) {
      emitToast(`Finalized ${r.finalized.length} ${r.finalized.length === 1 ? 'entry' : 'entries'}`);
    } else if (!ack) {
      emitToast('Nothing to finalize today.');
    }
    bumpRefresh();
  }

  async function exportTodayCsv() {
    const r = await api.post('/api/export', { from: d.date, to: d.date });
    if (r.count === 0) {
      emitToast('No finalized entries today — finalize first (or use the Export page for drafts).');
      return;
    }
    downloadText(`timekeeper-${d.date}.csv`, r.csv);
    emitToast(`Exported ${r.count} ${r.count === 1 ? 'entry' : 'entries'} as CSV`);
    bumpRefresh();
  }

  // The rare day-level actions. Close the day (the footer's one key) does
  // review + finalize + export in one guided pass; these are the escape
  // hatches for the exceptional case, and each names the file it makes.
  const dayMenuItems = [
    { label: 'New entry…', icon: 'plus', onClick: () => openEditor({ template: {} }) },
    { label: 'Day summary as text…', icon: 'clipboard', onClick: showSummary },
    { hr: true },
    { label: 'Finalize today without exporting', icon: 'lock', onClick: () => finalizeToday() },
    { label: 'Download today as CSV', icon: 'export', onClick: exportTodayCsv },
  ];

  const weekTarget = (d.today.target || 0) * 5;
  const weekData = week.data && typeof week.data.totalHours === 'number'
    ? { billable: week.data.billableHours, total: week.data.totalHours, target: weekTarget }
    : null;

  const hasStale = alerts.unfinalized.count > 0 || alerts.reverted.count > 0;
  const quietItems = [
    needNarrative.length > 0 ? {
      key: 'narr',
      label: `${needNarrative.length} ${needNarrative.length === 1 ? 'entry needs' : 'entries need'} a narrative`,
      title: 'Jump to the first one and start typing',
      onClick: () => jumpToEntry(needNarrative[0].id),
    } : null,
    needMatter.length > 0 ? {
      key: 'matter',
      label: `${needMatter.length} without a matter`,
      title: 'Open the first one and assign its client/matter',
      onClick: () => openEditor({ id: needMatter[0].id }),
    } : null,
    otherInvalid.length > 0 ? {
      key: 'valid',
      label: `${otherInvalid.length} with validation findings`,
      title: otherInvalid[0].codes.join(', '),
      onClick: () => openEditor({ id: otherInvalid[0].id }),
    } : null,
    alerts.unexported.count > 0 ? {
      key: 'unexported',
      label: `${alerts.unexported.count} finalized, not yet exported · ${fmtHours(alerts.unexported.hours)}h`,
      title: `Oldest ${alerts.unexported.oldest} — finalized but never sent`,
      onClick: () => nav(attentionLink('unexported', alerts.unexported)),
    } : null,
  ].filter(Boolean);

  return html`
    <div class="dashboard-view">
    <div class="page-head day-head">
      <button class="btn btn-icon" title="Previous day ([) — past days keep everything recorded on them"
        aria-label="Previous day"
        onClick=${() => nav(`#/day/${addDays(d.date, -1)}`)}><${Icon} name="chevronLeft" size=${16} /></button>
      <h1>${fmtDateLong(d.date)}</h1>
      <button class="btn btn-icon" title="Next day (])" aria-label="Next day"
        onClick=${() => nav(`#/day/${addDays(d.date, 1)}`)}><${Icon} name="chevronRight" size=${16} /></button>
      ${/* The day's rare actions — new entry, summary, finalize, export — sit
            next to the day they act on, one tap deep. Finalize day and Export
            used to be two visually prominent header buttons that were both
            strict subsets of Close the day (teardown §2). */''}
      <button class="btn btn-icon day-menu-btn" title="Day actions — new entry, summary, finalize, export"
        aria-label="Day actions"
        onClick=${(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setDayMenu({ x: Math.max(8, r.left - 40), y: r.bottom + 4 });
        }}><${Icon} name="more" size=${16} /></button>
      <div class="spacer"></div>
      ${/* ONE primary, and it is the app's most frequent verb — on a phone it
            is the first control on the screen, where the first thing that
            could start a timer used to sit 978px down. */''}
      <div class="page-head-actions">
        <button class="btn btn-primary day-quick" title="Quick start — a timer running now; assign the matter after the call"
          onClick=${() => window.dispatchEvent(new CustomEvent('tk:quick-timer'))}>
          <${Icon} name="play" size=${16} /> Quick start</button>
      </div>
    </div>

    ${/* The day's numbers, in the ONE place they live now: the meter card, the
          footer percentage and the entry-list header all said this. */''}
    <${TargetMeter} billable=${d.today.billable} nonbillable=${d.today.nonbillable}
      target=${d.today.target} total=${d.today.total} week=${weekData} />

    ${hasStale || quietItems.length > 0 ? html`
      <div class="attn">
        ${alerts.unfinalized.count > 0 ? html`
          <div class="attn-stale" role="status">
            <${Icon} name="alert" size=${18} />
            <div class="attn-stale-text">
              <strong>${`${alerts.unfinalized.count} ${alerts.unfinalized.count === 1 ? 'entry' : 'entries'} on earlier days ${alerts.unfinalized.count === 1 ? 'is' : 'are'} not finalized`}</strong>
              <span class="muted small">${`${fmtHours(alerts.unfinalized.hours)}h · oldest ${alerts.unfinalized.oldest} — time recorded on a day that is already over`}</span>
            </div>
            <button class="btn btn-sm attn-action"
              onClick=${() => nav(attentionLink('unfinalized', alerts.unfinalized))}>Review</button>
          </div>` : null}
        ${alerts.reverted.count > 0 ? html`
          <div class="attn-stale" role="status">
            <${Icon} name="unlock" size=${18} />
            <div class="attn-stale-text">
              <strong>${`${alerts.reverted.count} unlocked after finalizing`}</strong>
              <span class="muted small">${`${fmtHours(alerts.reverted.hours)}h — still reads as done everywhere else`}</span>
            </div>
            <button class="btn btn-sm attn-action"
              onClick=${() => nav(attentionLink('unfinalized', alerts.reverted))}>Review</button>
          </div>` : null}
        ${quietItems.length > 0 ? html`
          <p class="attn-line">
            ${quietItems.map((it) => html`
              <button key=${it.key} class="attn-link" title=${it.title} onClick=${it.onClick}>${it.label}</button>`)}
          </p>` : null}
      </div>` : null}

    <${TodayList} settings=${settings} entries=${d.entries} onEntryChanged=${bumpRefresh}
      openEditor=${openEditor} />

    ${dayMenu ? html`
      <${ContextMenu} x=${dayMenu.x} y=${dayMenu.y} items=${dayMenuItems}
        onClose=${() => setDayMenu(null)} />` : null}

    ${warnGate ? html`
      <${Confirm} title="Finalize with warnings?" confirmLabel="Finalize anyway"
        message=${warnGate.message}
        onConfirm=${() => finalizeToday(true)}
        onClose=${() => setWarnGate(null)} />` : null}
    </div>

    <${TodayFooter} today=${d.today} onCloseDay=${() => setCloseOut(true)} />

    ${summary ? html`
      <${SummaryModal} text=${summary} title=${`Summary — ${fmtDateFull(d.date)}`}
        filename=${`timekeeper-summary-${d.date}.txt`} onClose=${() => setSummary(null)} />` : null}

    ${closeOut ? html`
      <${CloseOut} onClose=${(changed) => { setCloseOut(false); if (changed) bumpRefresh(); }} openEditor=${openEditor} />` : null}
  `;
}
