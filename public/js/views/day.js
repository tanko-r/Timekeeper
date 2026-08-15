import { api, downloadText } from '/js/api.js';
import {
  html, useState, useEffect, useCallback, useAsync, Spinner, ErrorBox, fmtHours, fmtDateLong,
  fmtDateFull, addDays, todayStr, emitToast, Confirm, Icon,
} from '/js/ui.js';
import { rangeFor, shiftAnchor } from '/js/lib/daterange.js';
import { buildDaySummary } from '/js/lib/daysummary.js';
import { EntryList } from '/js/components/entrylist.js';
import { SummaryModal } from '/js/components/summary.js';
import { nav } from '/js/app.js';

// Entry viewer for a date (2026-07-13 feedback): Day / Week / Month / Range
// scopes anchored on the VISIBLE date, with an export button for whatever
// range is on screen. Day mode keeps the finalize/new-entry day workflow.
export function DayView({ date, settings, openEditor, refreshKey, bumpRefresh }) {
  const day = date || todayStr();
  const [mode, setMode] = useState('day'); // day | week | month | range
  const [customFrom, setCustomFrom] = useState(day);
  const [customTo, setCustomTo] = useState(day);
  const weekStart = settings?.calendar?.weekStartsOn === 1 ? 1 : 0; // default Sunday

  const range = mode === 'range'
    ? (customFrom <= customTo ? { from: customFrom, to: customTo } : { from: customTo, to: customFrom })
    : rangeFor(mode, day, weekStart);

  const { loading, data, error } = useAsync(
    () => api.get(`/api/entries?from=${range.from}&to=${range.to}`),
    [range.from, range.to, refreshKey]);

  // stepping onto today lands on the dashboard — that's today's real screen
  const goDay = (dateStr) => nav(dateStr === todayStr() ? '#/' : `#/day/${dateStr}`);
  const step = (dir) => {
    if (mode === 'day') goDay(addDays(day, dir));
    else nav(`#/day/${shiftAnchor(mode, day, dir)}`);
  };

  useEffect(() => {
    const onKey = (e) => {
      const tag = (e.target.tagName || '').toLowerCase();
      if (['input', 'textarea', 'select'].includes(tag)) return;
      if (e.key === '[') step(-1);
      if (e.key === ']') step(1);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [day, mode]);

  const [warnGate, setWarnGate] = useState(null);
  const [summary, setSummary] = useState(null);

  const monthLabel = (() => {
    const [y, m] = day.split('-').map(Number);
    return new Date(y, m - 1, 1, 12).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  })();
  const title = mode === 'day' ? fmtDateLong(day)
    : mode === 'week' ? `Week of ${fmtDateLong(range.from)}`
    : mode === 'month' ? monthLabel
    : 'Custom range';
  // spelled out in full for the summary, which is prose rather than chrome
  const summaryTitle = mode === 'day' ? fmtDateFull(day) : title;

  // Reads the range on screen back as prose — everything in view, drafts
  // included, since this is for recall rather than for billing.
  const showSummary = useCallback(() => {
    setSummary(buildDaySummary(data || [], {
      title: summaryTitle,
      increment: settings?.rounding?.increment || 0.1,
      showDates: mode !== 'day',
    }));
  }, [data, summaryTitle, mode, settings]);

  useEffect(() => {
    window.addEventListener('tk:day-summary', showSummary);
    return () => window.removeEventListener('tk:day-summary', showSummary);
  }, [showSummary]);

  if (error) return html`<${ErrorBox} error=${error} />`;
  const entries = data || [];
  const total = entries.reduce((a, e) => a + e.total, 0);
  const billable = entries.reduce((a, e) => a + (e.billable ? e.total : 0), 0);

  async function finalizeDay(ack = false) {
    const r = await api.post('/api/finalize-day', { date: day, ack });
    const warnOnly = r.blocked.filter((b) => b.blocks.length === 0);
    const hard = r.blocked.length - warnOnly.length;
    if (!ack && warnOnly.length > 0) {
      const msgs = [...new Set(warnOnly.flatMap((b) => b.warns.map((w) => w.message)))].slice(0, 4);
      setWarnGate({ message: `${warnOnly.length} ${warnOnly.length === 1 ? 'entry has' : 'entries have'} warnings: ${msgs.join(' · ')}` });
      bumpRefresh();
      return;
    }
    if (hard > 0) {
      emitToast(`${r.finalized.length} finalized, ${hard} blocked — open them to fix.`, { error: true });
    } else {
      emitToast(r.finalized.length ? `Finalized ${r.finalized.length}` : ack ? 'Done.' : 'Nothing to finalize.');
    }
    bumpRefresh();
  }

  async function exportRange() {
    const r = await api.post('/api/export', { from: range.from, to: range.to });
    if (r.count === 0) {
      emitToast('No finalized entries in this range — finalize first (or use the Export page for drafts).');
      return;
    }
    downloadText(`timekeeper-${range.from}${range.to !== range.from ? `_${range.to}` : ''}.csv`, r.csv);
    emitToast(`Exported ${r.count} ${r.count === 1 ? 'entry' : 'entries'}`);
    bumpRefresh();
  }

  return html`
    <div class="page-head">
      ${mode !== 'range' ? html`
        <button class="btn" title=${`Previous ${mode} ([)`} onClick=${() => step(-1)}><${Icon} name="chevronLeft" size=${16} /></button>` : null}
      <h1>${title}</h1>
      ${mode !== 'range' ? html`
        <button class="btn" title=${`Next ${mode} (])`} onClick=${() => step(1)}><${Icon} name="chevronRight" size=${16} /></button>` : null}
      ${day !== todayStr() ? html`<button class="btn btn-sm" onClick=${() => nav('#/')}>Today</button>` : null}
      ${/* View controls, not page actions: shell.css gives .page-head-tools its
            own line so this header wraps the same way the dashboard's does. */''}
      <div class="page-head-tools">
        <div class="seg" role="group" aria-label="Range">
          ${[['day', 'Day'], ['week', 'Week'], ['month', 'Month'], ['range', 'Range']].map(([v, label]) => html`
            <button key=${v} class=${mode === v ? 'on' : ''}
              title=${v === 'range' ? 'Pick a custom from/to range' : `Show the ${label.toLowerCase()} around ${day}`}
              onClick=${() => setMode(v)}>${label}</button>`)}
        </div>
        ${mode === 'range' ? html`
          <span class="date-range">
            <label class="range-field">
              <span class="field-label">From</span>
              <input type="date" value=${customFrom} onChange=${(e) => setCustomFrom(e.target.value)} />
            </label>
            <label class="range-field">
              <span class="field-label">To</span>
              <input type="date" value=${customTo} onChange=${(e) => setCustomTo(e.target.value)} />
            </label>
          </span>` : null}
        <span class="muted">${fmtHours(billable)}h billable · ${fmtHours(total)}h total</span>
      </div>
      <div class="spacer"></div>
      <div class="page-head-actions">
        <button class="btn" title="Read the entries in view back as plain text — client, matter, hours, narrative (s)"
          onClick=${showSummary}><${Icon} name="clipboard" size=${16} /> Summary</button>
        <button class="btn" title="Download finalized entries in view as CSV (marks them exported)"
          onClick=${exportRange}><${Icon} name="export" size=${16} /> Export</button>
        ${mode === 'day' ? html`
          <button class="btn" onClick=${() => finalizeDay()}><${Icon} name="lock" size=${16} /> Finalize day</button>
          <button class="btn btn-primary" onClick=${() => openEditor({ template: { date: day } })}>
            <${Icon} name="plus" size=${16} /> New entry<kbd class="btn-kbd">n</kbd></button>` : null}
      </div>
    </div>
    ${loading && !data ? html`<${Spinner} />` : html`
      <${EntryList} entries=${entries} openEditor=${openEditor} onChanged=${bumpRefresh}
        settings=${settings} showDate=${mode !== 'day'} />`}
    ${summary ? html`
      <${SummaryModal} text=${summary} title=${`Summary — ${summaryTitle}`}
        filename=${`timekeeper-summary-${range.from}${range.to !== range.from ? `_${range.to}` : ''}.txt`}
        onClose=${() => setSummary(null)} />` : null}
    ${warnGate ? html`
      <${Confirm} title="Finalize with warnings?" confirmLabel="Finalize anyway"
        message=${warnGate.message}
        onConfirm=${() => finalizeDay(true)}
        onClose=${() => setWarnGate(null)} />` : null}
  `;
}
