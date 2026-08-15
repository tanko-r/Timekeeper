import { api, downloadText } from '/js/api.js';
import {
  html, React, useState, useEffect, useMemo, useCallback, useAsync, Spinner, ErrorBox, fmtHours, fmtDateLong,
  fmtDateFull, addDays, todayStr, emitToast, Confirm, Icon,
} from '/js/ui.js';
import { usePhone } from '/js/components/entrylist.js';
import { Menu, menuTriggerProps } from '/js/components/menu.js';
import { TodayList } from '/js/components/timergrid.js';
import { TargetMeter } from '/js/components/targetmeter.js';
import { TodayFooter } from '/js/components/todayfooter.js';
import { CloseOut } from '/js/components/closeout.js';
import { SummaryModal } from '/js/components/summary.js';
import { buildDaySummary } from '/js/lib/daysummary.js';
import { nav } from '/js/app.js';

// The date without its year — a phone's header has room for one of the two,
// and "2026" is not the half a lawyer keying today's time is reading.
function fmtDateShort(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d, 12).toLocaleDateString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric',
  });
}

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
  const [attnMenu, setAttnMenu] = useState(null);
  const phone = usePhone();

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
  // ONE BAND, ONE LINE. The wave critic measured the phone's first screen and
  // found 338px of header, meter and attention before the first row of work —
  // 46% of a 390×844 viewport — of which this block was an amber banner ROW
  // plus a second row of backlog links. The teardown's §C sketch is a single
  // attention line ("2 need a narrative · 17 finalized entries not yet
  // exported") and that is what this is now: one band, every count a real link
  // to exactly what it counts, the stale-time warning first and carrying the
  // band's amber rail because unfinalized time on a day that is already over
  // is the most expensive failure mode in legal billing (teardown D3).
  //
  // Nothing lost: the Review button became the warning's own text-as-link (it
  // opened the same filtered ledger), and the detail that used to be a second
  // line — oldest date, hours — is in each link's tooltip and on the page it
  // opens.
  const attnItems = [
    alerts.unfinalized.count > 0 ? {
      key: 'unfinalized',
      stale: true,
      label: `${alerts.unfinalized.count} ${alerts.unfinalized.count === 1 ? 'entry' : 'entries'} not finalized · ${fmtHours(alerts.unfinalized.hours)}h`,
      sheetLabel: `Review ${alerts.unfinalized.count} unfinalized ${alerts.unfinalized.count === 1 ? 'entry' : 'entries'} on earlier days`,
      icon: 'alert',
      title: `Oldest ${alerts.unfinalized.oldest} — time recorded on a day that is already over`,
      onClick: () => nav(attentionLink('unfinalized', alerts.unfinalized)),
    } : null,
    alerts.reverted.count > 0 ? {
      key: 'reverted',
      stale: true,
      label: `${alerts.reverted.count} unlocked after finalizing · ${fmtHours(alerts.reverted.hours)}h`,
      sheetLabel: `Review ${alerts.reverted.count} unlocked after finalizing`,
      icon: 'unlock',
      title: 'Still reads as done everywhere else',
      onClick: () => nav(attentionLink('unfinalized', alerts.reverted)),
    } : null,
    needNarrative.length > 0 ? {
      key: 'narr',
      icon: 'edit',
      label: `${needNarrative.length} ${needNarrative.length === 1 ? 'entry needs' : 'entries need'} a narrative`,
      title: 'Jump to the first one and start typing',
      onClick: () => jumpToEntry(needNarrative[0].id),
    } : null,
    needMatter.length > 0 ? {
      key: 'matter',
      icon: 'folder',
      label: `${needMatter.length} without a matter`,
      title: 'Open the first one and assign its client/matter',
      onClick: () => openEditor({ id: needMatter[0].id }),
    } : null,
    otherInvalid.length > 0 ? {
      key: 'valid',
      icon: 'alert',
      label: `${otherInvalid.length} with validation findings`,
      title: otherInvalid[0].codes.join(', '),
      onClick: () => openEditor({ id: otherInvalid[0].id }),
    } : null,
    alerts.unexported.count > 0 ? {
      key: 'unexported',
      icon: 'export',
      label: `${alerts.unexported.count} finalized, not yet exported · ${fmtHours(alerts.unexported.hours)}h`,
      title: `Oldest ${alerts.unexported.oldest} — finalized but never sent`,
      onClick: () => nav(attentionLink('unexported', alerts.unexported)),
    } : null,
  ].filter(Boolean);
  const attnMenuItems = attnItems.map((it) => ({
    label: it.sheetLabel || it.label, icon: it.icon, onClick: it.onClick,
  }));

  return html`
    <div class="dashboard-view">
    ${/* ONE BAND, NOT TWO. The date navigation and the day's one primary
          action shared a header that broke into two full-width rows on a
          phone — 104px of it — before a single number or row of work. They
          are one line now, and the title drops its year at 390px, which is
          the only part of the date a lawyer keying today's time does not
          need. */''}
    <div class="page-head day-head">
      <button class="btn btn-icon" title="Previous day ([) — past days keep everything recorded on them"
        aria-label="Previous day"
        onClick=${() => nav(`#/day/${addDays(d.date, -1)}`)}><${Icon} name="chevronLeft" size=${16} /></button>
      <h1>
        <span class="dh-long">${fmtDateLong(d.date)}</span>
        <span class="dh-short" aria-hidden="true">${fmtDateShort(d.date)}</span>
      </h1>
      <button class="btn btn-icon" title="Next day (])" aria-label="Next day"
        onClick=${() => nav(`#/day/${addDays(d.date, 1)}`)}><${Icon} name="chevronRight" size=${16} /></button>
      ${/* The day's rare actions — new entry, summary, finalize, export — sit
            next to the day they act on, one tap deep. Finalize day and Export
            used to be two visually prominent header buttons that were both
            strict subsets of Close the day (teardown §2). */''}
      <button class="btn btn-icon day-menu-btn" title="Day actions — new entry, summary, finalize, export"
        aria-label="Day actions" ...${menuTriggerProps(!!dayMenu)}
        onClick=${(e) => setDayMenu({ anchor: e.currentTarget })}><${Icon} name="more" size=${16} /></button>
      <div class="spacer"></div>
      ${/* ONE primary, and it is the app's most frequent verb — on a phone it
            is the first control on the screen, where the first thing that
            could start a timer used to sit 978px down. */''}
      <div class="page-head-actions">
        <button class="btn btn-primary day-quick" title="Quick start — a timer running now; assign the matter after the call"
          onClick=${() => window.dispatchEvent(new CustomEvent('tk:quick-timer'))}>
          <${Icon} name="play" size=${16} />
          <span class="dq-long">Quick start</span>
          <span class="dq-short" aria-hidden="true">Quick</span>
        </button>
      </div>
    </div>

    ${/* The day's numbers, in the ONE place they live now: the meter card, the
          footer percentage and the entry-list header all said this. */''}
    <${TargetMeter} billable=${d.today.billable} nonbillable=${d.today.nonbillable}
      target=${d.today.target} total=${d.today.total} week=${weekData} />

    ${/* ATTENTION, IN ONE 44px BAND.
          On a phone it is the most urgent item as a direct link plus "+N more"
          — one tap to the thing that matters, one tap deeper to a 48px sheet
          row for each of the rest. On a desktop, where the line has 1400px to
          play with, every count is inline. Either way it is ONE band, not a
          banner row above a link row. */''}
    ${attnItems.length > 0 ? html`
      <div class=${'attn' + (hasStale ? ' attn-warn' : '')} role="status">
        <${Icon} name=${attnItems[0].icon} size=${16} className="attn-icon" />
        <p class="attn-line">
          ${(phone ? attnItems.slice(0, 1) : attnItems).map((it, i) => html`
            <${React.Fragment} key=${it.key}>
              ${i > 0 ? html`<span class="attn-dot" aria-hidden="true">·</span>` : null}
              <button class=${'attn-link' + (it.stale ? ' attn-link-stale' : '')}
                title=${it.title} onClick=${it.onClick}>${it.label}</button>
            <//>`)}
        </p>
        ${phone && attnItems.length > 1 ? html`
          <button class="btn btn-sm attn-more" title="Everything else that needs attention today"
            ...${menuTriggerProps(!!attnMenu)}
            onClick=${(e) => setAttnMenu({ anchor: e.currentTarget })}>
            +${attnItems.length - 1} more</button>` : null}
      </div>` : null}

    <${TodayList} settings=${settings} entries=${d.entries} onEntryChanged=${bumpRefresh}
      openEditor=${openEditor} />

    ${dayMenu ? html`
      <${Menu} anchor=${dayMenu.anchor} title="Day actions" items=${dayMenuItems}
        onClose=${() => setDayMenu(null)} />` : null}

    ${attnMenu ? html`
      <${Menu} anchor=${attnMenu.anchor} title="Needs attention" items=${attnMenuItems}
        onClose=${() => setAttnMenu(null)} />` : null}

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
