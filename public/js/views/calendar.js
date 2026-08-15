import { api, downloadText } from '/js/api.js';
import {
  html, useState, useEffect, useRef, useCallback, useAsync, Spinner, ErrorBox, fmtHours,
  fmtDateLong, fmtDateFull, addDays, todayStr, emitToast, Icon, Confirm,
} from '/js/ui.js';
import { Menu, menuTriggerProps } from '/js/components/menu.js';
import { rangeFor, shiftAnchor } from '/js/lib/daterange.js';
import { buildDaySummary } from '/js/lib/daysummary.js';
import { EntryList } from '/js/components/entrylist.js';
import { SummaryModal } from '/js/components/summary.js';

// ===========================================================================
// CALENDAR — one screen, three jobs (teardown §8, §9, §13)
//
// It answers, at a glance and in one place:
//
//   which days are thin      the cell's bar runs in a TRACK whose full width
//                            is the daily target, so a short day is short on
//                            screen. The old `✓ ≥8.0h · ◐ ≥50% · ! under 50%`
//                            legend was a cipher nobody would learn — three
//                            8px glyphs in a corner explained in muted 11px
//                            text — and it is gone.
//   which days are not closed  a marked corner on any day still carrying a
//                            draft, named in the legend and in every cell's
//                            accessible name (never colour alone).
//   where the month went     the period strip, which is part of the PAGE
//                            HEADER on both sections and both viewports, and
//                            the two bar lists in the Statistics section.
//
// IT ABSORBED TWO SCREENS.
//
//   Day (`#/day/<date>`)  was a near-copy of this file's own selected-day
//     panel: the same EntryList, the same Day/Week/Month/Range control, a
//     header with four actions arranged differently from the dashboard's four.
//     views/day.js is a five-line adapter now; the route still resolves, `[`
//     and `]` still walk days, `s` still reads the day back as prose, and the
//     day's rare actions (summary, finalize, CSV) live in ONE "⋯" menu shaped
//     exactly like the dashboard's, instead of a second toolbar.
//
//   Stats (`#/calendar/stats`)  asked "how am I doing over time" about the
//     same period this screen already draws. Its four tiles became the period
//     strip — which is on BOTH sections, so the calendar itself now carries
//     the month total and the billable ratio. Its two BarLists moved into the
//     Statistics section unchanged. Its "By day" sparkline (ten bars, two
//     labels, values readable only by hovering — unavailable on touch) became
//     a labelled, valued bar list, because the values were the only part of it
//     that was information.
//
// NO TABLES. A month grid is a grid; everything else here is a list of rows.
// ===========================================================================

const pad = (n) => String(n).padStart(2, '0');

function monthOf(dateStr) { return dateStr.slice(0, 7); }

const chunk7 = (cells) => Array.from({ length: cells.length / 7 }, (_, i) => cells.slice(i * 7, i * 7 + 7));

// weekStart: 0 = Sunday (default), 1 = Monday — from settings.calendar.
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const dowLabels = (weekStart) => Array.from({ length: 7 }, (_, i) => DOW[(i + weekStart) % 7]);

function gridFor(yyyyMm, weekStart = 0) {
  const [y, m] = yyyyMm.split('-').map(Number);
  const first = new Date(y, m - 1, 1, 12);
  const startOffset = (first.getDay() - weekStart + 7) % 7;
  const start = new Date(y, m - 1, 1 - startOffset, 12);
  const cells = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i, 12);
    cells.push({
      date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
      inMonth: d.getMonth() === m - 1,
      weekend: d.getDay() === 0 || d.getDay() === 6,
      dayNum: d.getDate(),
    });
  }
  return cells;
}

function weekFor(dateStr, weekStart = 0) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dow = (new Date(y, m - 1, d, 12).getDay() - weekStart + 7) % 7;
  const first = addDays(dateStr, -dow);
  return Array.from({ length: 7 }, (_, i) => addDays(first, i));
}

const monthName = (dateStr) => {
  const [y, m] = monthOf(dateStr).split('-').map(Number);
  return new Date(y, m - 1, 1, 12).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
};

// "Aug 9" — short enough to be a page title on a 390px phone.
const shortDate = (dateStr) => {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d, 12).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

// Mercury's big-figure/small-fraction treatment (reference-analysis §1): the
// magnitude reads before the precision does. `.figure-frac` is the shared
// primitive in base.css, so the calendar, the strip and the day panel all
// render an hour figure the same way.
function Hours({ value, size = 'md' }) {
  const s = fmtHours(value);
  const dot = s.indexOf('.');
  const whole = dot < 0 ? s : s.slice(0, dot);
  const frac = dot < 0 ? '' : s.slice(dot);
  return html`<span class=${`figure-${size} tnum`}>${whole}<span class="figure-frac">${frac}h</span></span>`;
}

// PHONE OR NOT, as a fact the render can branch on rather than a guess. The
// two places this screen has to know: the day-actions overflow (a popover on a
// desktop, a bottom sheet under a thumb) and whether selecting a day should
// scroll its panel into view. 767px is the app's one phone breakpoint —
// overlay.js, base.css tier 1 and every module's media query use the same
// number.
const PHONE_MQ = '(max-width: 767px)';
function usePhone() {
  const [phone, setPhone] = useState(() => (typeof window.matchMedia === 'function'
    ? window.matchMedia(PHONE_MQ).matches : false));
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined;
    const mq = window.matchMedia(PHONE_MQ);
    const on = () => setPhone(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return phone;
}

// ---------------------------------------------------------------------------
// The period strip — what used to be the four Stats tiles.
//
// Mercury's Bill Pay card stack, three tiers: a figure, the caption that says
// what it is, and one secondary number underneath. That shape carries all four
// of the old tiles (Total · Billable · Billable ratio · Days with time) in
// three tiles instead of four, and adds the one number a lawyer actually
// chases — how many days in this period still have drafts on them.
//
// IT LIVES IN THE PAGE HEADER, on every surface. The wave critic measured the
// same three numbers in three different places: under the desktop Calendar's
// title, under the mobile Statistics title, and at the very BOTTOM of the
// mobile Calendar — y≈2200 of a 2470px page, below all five entry rows. Two
// chips of one destination disagreeing about where their shared header lives
// is the cross-screen inconsistency the teardown flagged in §8, so the strip
// is now a child of `.cal-head` and cannot drift again.
//
// On a phone the Calendar section renders `.period-line` instead — the same
// readings on one wrapping line, because the grid underneath is what the thumb
// came for and 233px of stacked tiles above it is not a header, it is a
// screen. Statistics keeps the full stack: there the numbers ARE the screen.
// Exactly one of the two is ever displayed (views.css), so nothing is said
// twice to a screen reader.
// ---------------------------------------------------------------------------
function PeriodStrip({ periodLabel, totals }) {
  const ratio = totals.total > 0 ? Math.round((totals.billable / totals.total) * 100) : 0;
  return html`
    <div class="stat-tiles period-strip">
      ${/* No period word here: the <h1> two lines above says "August 2026". */''}
      <p class="period-line">
        <span><span class="period-fig">${fmtHours(totals.total)}h</span> total</span>
        <span><span class="period-fig">${fmtHours(totals.billable)}h</span> billable</span>
        <span class=${totals.draftDays > 0 ? 'period-warn' : ''}>${totals.draftDays === 0
          ? 'all days closed'
          : `${totals.draftDays} ${totals.draftDays === 1 ? 'day' : 'days'} not closed`}</span>
      </p>
      <div class="stat-tile hero">
        <div class="k">Total ${periodLabel}</div>
        <div class="v"><${Hours} value=${totals.total} size="hero" /></div>
        <div class="s">${totals.days} ${totals.days === 1 ? 'day' : 'days'} with time recorded</div>
      </div>
      <div class="stat-tile">
        <div class="k">Billable</div>
        <div class="v"><${Hours} value=${totals.billable} size="lg" /></div>
        <div class="s">${ratio}% of tracked time is billable</div>
      </div>
      <div class=${'stat-tile' + (totals.draftDays > 0 ? ' needs-attention' : '')}>
        <div class="k">Not closed</div>
        <div class="v figure-lg tnum">${totals.draftDays}</div>
        <div class="s">
          ${totals.draftDays === 0
            ? 'every day here is finalized'
            : `${totals.draftDays === 1 ? 'day' : 'days'} still holding drafts · ${fmtHours(totals.draftHours)}h`}
        </div>
      </div>
    </div>`;
}

// Single-hue horizontal bars (magnitude), values ALWAYS labelled — the one
// component the teardown praised in Stats, kept exactly as it was and now used
// three times, including for the by-day figures that used to be readable only
// by hovering a <title>.
function BarList({ rows, labelKey, max, title }) {
  return html`
    <div class="bar-list">
      ${rows.map((r) => html`
        <div key=${r[labelKey]} class="bar-row">
          <span class="bar-label" title=${r[labelKey]}>${r[labelKey]}</span>
          <div class="bar-track">
            <div class="bar-fill" style=${{ width: `${Math.max(1, (r.hours / max) * 100)}%` }}></div>
          </div>
          <span class="bar-value mono">${fmtHours(r.hours)}h</span>
        </div>`)}
      ${rows.length === 0 ? html`<p class="muted small">No ${title} in this period.</p>` : null}
    </div>`;
}

// THE DAY-ACTIONS OVERFLOW used to be a private popover/sheet pair defined
// here — one of the app's three menu components. It goes through the shared
// `Menu` (components/menu.js) now, which is the same popover-above-1024 /
// bottom-sheet-below split this file was already making, built once.

// ---------------------------------------------------------------------------
// The selected day — the whole of the old Day view, inline, no navigation.
//
// One primary action (New entry) and one "⋯" overflow, which is the answer
// Carbon, Primer, Polaris and Fluent all converge on for a row or panel
// carrying more than two actions — and the same shape the Today screen's day
// header uses, so the two screens no longer arrange the same four words two
// different ways.
// ---------------------------------------------------------------------------
function DayPanel({
  selected, scope, setScope, customFrom, customTo, setCustomFrom, setCustomTo,
  entries, loading, settings, openEditor, bumpRefresh, onStep, onMenu, menuOpen, title, panelRef,
}) {
  const total = entries.reduce((a, e) => a + e.total, 0);
  const billable = entries.reduce((a, e) => a + (e.billable ? e.total : 0), 0);
  const drafts = entries.filter((e) => e.status === 'draft').length;

  return html`
    <section class="panel day-panel" ref=${panelRef} aria-label=${`Entries — ${title}`}>
      <div class="day-panel-head">
        <button class="btn btn-icon" title="Previous ([)" aria-label=${`Previous ${scope}`}
          onClick=${() => onStep(-1)}><${Icon} name="chevronLeft" size=${16} /></button>
        <h2>${title}</h2>
        <button class="btn btn-icon" title="Next (])" aria-label=${`Next ${scope}`}
          onClick=${() => onStep(1)}><${Icon} name="chevronRight" size=${16} /></button>
        <span class="day-panel-sum muted small">
          ${`${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}`}
          ${drafts > 0 ? html`<span> · ${drafts} draft</span>` : null}
          <span> · </span><span class="mono">${fmtHours(billable)}h</span> billable
          <span> · </span><span class="mono">${fmtHours(total)}h</span> total
        </span>
        <div class="spacer"></div>
        ${/* The trigger element itself, not a pair of coordinates: the shared
              menu measures its own height against it, right-aligns to it, flips
              above it when the window is short, and gives focus back to it. */''}
        <button class="btn btn-icon day-panel-menu" aria-label="Day actions"
          title="Day actions — summary, finalize, download CSV"
          ...${menuTriggerProps(menuOpen)}
          onClick=${(e) => onMenu({ anchor: e.currentTarget })}><${Icon} name="more" size=${16} /></button>
        <button class="btn btn-primary" title="Record time on this day by hand (n)"
          onClick=${() => openEditor({ template: { date: selected } })}>
          <${Icon} name="plus" size=${16} /> New entry</button>
      </div>
      <div class="day-panel-scope">
        ${/* A view toggle over one dataset — Apple classes this as a control,
              not navigation, and caps it at five equal-width segments. */''}
        <div class="seg" role="group" aria-label="Panel range">
          ${[['day', 'Day'], ['week', 'Week'], ['month', 'Month'], ['range', 'Range']].map(([v, label]) => html`
            <button key=${v} class=${scope === v ? 'on' : ''}
              aria-pressed=${scope === v}
              title=${v === 'range' ? 'Pick a custom from/to range' : `Show the whole ${label.toLowerCase()} around this day`}
              onClick=${() => {
                if (v === 'range' && scope !== 'range') { setCustomFrom(selected); setCustomTo(selected); }
                setScope(v);
              }}>${label}</button>`)}
        </div>
        ${scope === 'range' ? html`
          <span class="date-range">
            <label class="range-field">
              <span class="field-label">From</span>
              <input type="date" value=${customFrom} required
                onChange=${(e) => { if (e.target.value) setCustomFrom(e.target.value); }} />
            </label>
            <label class="range-field">
              <span class="field-label">To</span>
              <input type="date" value=${customTo} required
                onChange=${(e) => { if (e.target.value) setCustomTo(e.target.value); }} />
            </label>
          </span>` : null}
      </div>
      ${loading ? html`<${Spinner} />` : html`
        <${EntryList} entries=${entries} openEditor=${openEditor} onChanged=${bumpRefresh}
          settings=${settings} showDate=${scope !== 'day'} />`}
    </section>`;
}

// ---------------------------------------------------------------------------

// WHERE YOU WERE, ACROSS A SECTION SWITCH. Calendar and Statistics are two
// chips of one destination sharing one period header, but they are two mounted
// components, so without this, stepping back to June and tapping Statistics
// silently reported on August. Session-scoped and deliberately not persisted:
// a fresh load starts on today, `Today` is always one tap, and a `#/day/<date>`
// deep link always wins.
let lastView = null;

export function CalendarView({
  settings, openEditor, refreshKey, bumpRefresh, focusDay = null, section = 'calendar',
}) {
  const weekStart = settings?.calendar?.weekStartsOn === 1 ? 1 : 0; // default Sunday
  const start = focusDay || todayStr();

  const [mode, setMode] = useState(() => (focusDay ? 'month' : lastView?.mode || 'month'));
  const [anchor, setAnchor] = useState(() => (focusDay || lastView?.anchor || start));
  const [selected, setSelected] = useState(() => (focusDay || lastView?.selected || start));
  const [scope, setScope] = useState('day');        // day | week | month | range
  const [customFrom, setCustomFrom] = useState(start);
  const [customTo, setCustomTo] = useState(start);
  const [statsRange, setStatsRange] = useState(null); // Statistics' custom range
  const [dayMenu, setDayMenu] = useState(null);
  const [summary, setSummary] = useState(null);
  const [warnGate, setWarnGate] = useState(null);
  const phone = usePhone();
  const panelRef = useRef(null);
  // Bumped by a tap on a day cell, and only by a tap: the effect that reads it
  // must not fire on a `[`/`]` step, a deep link or a re-render.
  const [revealPanel, setRevealPanel] = useState(0);

  // `#/day/<date>` is a DEEP LINK into this screen, not a screen of its own:
  // it lands with that day drawn and selected. Stepping with [ and ] moves the
  // selection in place rather than pushing a history entry per keystroke.
  useEffect(() => {
    if (!focusDay) return;
    setAnchor(focusDay);
    setSelected(focusDay);
    setCustomFrom(focusDay);
    setCustomTo(focusDay);
  }, [focusDay]);

  useEffect(() => { lastView = { mode, anchor, selected }; }, [mode, anchor, selected]);

  // ---- the period on screen ----
  // A hand-typed range can arrive backwards; read it in whichever order makes
  // a range, exactly as the day panel's own Range scope does.
  const statsPeriod = section === 'stats' && statsRange
    ? (statsRange.from <= statsRange.to ? statsRange : { from: statsRange.to, to: statsRange.from })
    : null;
  const period = statsPeriod || rangeFor(mode, anchor, weekStart);
  const cells = gridFor(monthOf(anchor), weekStart);
  const weekDays = weekFor(anchor, weekStart);
  const gridRange = mode === 'month'
    ? { from: cells[0].date, to: cells[41].date }
    : { from: weekDays[0], to: weekDays[6] };
  // The grid needs the days that spill out of the month; Statistics needs
  // exactly the period (or the custom range) and nothing else.
  const fetchRange = section === 'stats' ? period : gridRange;

  const { loading, data, error } = useAsync(
    () => api.get(`/api/entries?from=${fetchRange.from}&to=${fetchRange.to}`),
    [fetchRange.from, fetchRange.to, refreshKey]);

  const statsQ = useAsync(
    () => (section === 'stats'
      ? api.get(`/api/stats?from=${period.from}&to=${period.to}`)
      : Promise.resolve(null)),
    [section, period.from, period.to, refreshKey]);

  // ---- the selected day's entries (the absorbed Day view) ----
  const panelRange = scope === 'range'
    ? (customFrom <= customTo ? { from: customFrom, to: customTo } : { from: customTo, to: customFrom })
    : rangeFor(scope, selected || todayStr(), weekStart);
  const showPanel = section === 'calendar' && !!selected;
  // Day, Week and Month scopes always sit INSIDE the 42-cell grid we already
  // fetched (the grid is whole weeks and always spans the whole month), so the
  // panel is a filter over data in hand — it paints in the same frame as the
  // grid instead of arriving a request later and pushing the page down. Only a
  // custom Range can reach outside, and only that asks the server again.
  const panelInGrid = showPanel
    && panelRange.from >= gridRange.from && panelRange.to <= gridRange.to;
  const panelQ = useAsync(
    () => (showPanel && !panelInGrid
      ? api.get(`/api/entries?from=${panelRange.from}&to=${panelRange.to}`)
      : Promise.resolve(null)),
    [showPanel, panelInGrid, panelRange.from, panelRange.to, refreshKey]);
  const panelEntries = panelInGrid
    ? (data || []).filter((e) => e.date >= panelRange.from && e.date <= panelRange.to)
    : (panelQ.data || []);
  const panelLoading = panelInGrid ? (loading && !data) : (panelQ.loading && !panelQ.data);

  const panelTitle = scope === 'day' ? fmtDateLong(selected || todayStr())
    : scope === 'week' ? `Week of ${fmtDateLong(panelRange.from)}`
      : scope === 'month' ? monthName(selected || todayStr())
        : 'Custom range';
  // Spelled out in full for the summary, which is prose rather than chrome.
  const summaryTitle = scope === 'day' ? fmtDateFull(selected || todayStr()) : panelTitle;
  const scopeWord = scope === 'day' ? 'this day'
    : scope === 'week' ? 'this week' : scope === 'month' ? 'this month' : 'this range';

  // ---- period figures: the old Stats tiles, on both sections ----
  const inPeriod = (d) => d >= period.from && d <= period.to;
  const byDay = new Map();
  for (const e of data || []) {
    if (!byDay.has(e.date)) byDay.set(e.date, { total: 0, billable: 0, nonbillable: 0, draft: 0, entries: [] });
    const d = byDay.get(e.date);
    d.total += e.total;
    if (e.billable) d.billable += e.total; else d.nonbillable += e.total;
    if (e.status === 'draft') d.draft += 1;
    d.entries.push(e);
  }
  const totals = { total: 0, billable: 0, days: 0, draftDays: 0, draftHours: 0 };
  for (const [date, info] of byDay) {
    if (!inPeriod(date)) continue;
    totals.total += info.total;
    totals.billable += info.billable;
    totals.days += 1;
    if (info.draft > 0) {
      totals.draftDays += 1;
      totals.draftHours += info.entries.reduce((a, e) => a + (e.status === 'draft' ? e.total : 0), 0);
    }
  }

  const target = settings?.targets?.dailyHours || 0;
  const busiest = Math.max(0.1, ...[...byDay.values()].map((d) => d.total));
  // The TRACK is the target: a day that does not fill it is a thin day, which
  // is the whole question this screen exists to answer. With no target set the
  // track falls back to the busiest day in view, so the bars stay comparable.
  const cellScale = target > 0 ? target : busiest;

  const rangeLabel = statsPeriod
    ? `${shortDate(statsPeriod.from)} – ${shortDate(statsPeriod.to)}`
    : null;
  const periodLabel = rangeLabel
    || (mode === 'month' ? `in ${monthName(anchor)}` : 'this week');
  const headTitle = rangeLabel
    || (mode === 'month' ? monthName(anchor) : `Week of ${shortDate(weekDays[0])}`);

  // ---- moving around ----
  const withinPeriod = (d) => (mode === 'month'
    ? monthOf(d) === monthOf(anchor)
    : weekDays.includes(d));

  const shiftPeriod = (dir) => {
    const next = shiftAnchor(mode, anchor, dir);
    setStatsRange(null);
    setAnchor(next);
    if (section === 'calendar') setSelected(next);
  };
  const goToday = () => {
    setStatsRange(null);
    setAnchor(todayStr());
    setSelected(todayStr());
  };
  const stepSelection = (dir) => {
    const base = selected || todayStr();
    const next = scope === 'range' ? addDays(base, dir) : shiftAnchor(scope, base, dir);
    setSelected(next);
    if (!withinPeriod(next)) setAnchor(next);
  };
  // Single tap SELECTS. Nothing here behaves differently by click count any
  // more — the old onDoubleClick "open the day" accelerator was pointer-only
  // and the day it opened is this panel now.
  //
  // …AND ON A PHONE, SELECTING SHOWS YOU SOMETHING. Measured before this at
  // 390×844: tapping Aug 12 left scrollY at 0, put the day panel's head at
  // y≈790 — under a bottom navigation bar that starts at 784 — and its first
  // entry at y=1002, 158px below the fold. The teardown's whole case for
  // merging Day into Calendar was "select a day, entries appear below without
  // a navigation"; on the device David actually uses they did not appear at
  // all until he scrolled ~430px, and the only feedback a thumb got from the
  // merge's core interaction was a 2px ring on a 48×60 cell.
  const pick = (date) => {
    const opening = date !== selected;
    setSelected((cur) => (cur === date ? null : date));
    if (mode === 'month' && monthOf(date) !== monthOf(anchor)) setAnchor(date);
    if (opening && phone) setRevealPanel((n) => n + 1);
  };

  // The scroll itself, once the panel has been laid out with the new day in
  // it. The run bar's height is NOT arithmetic here: `.day-panel` carries a
  // `scroll-margin-top` of --runbar-total (views.css), so the browser resolves
  // the offset at scroll time and a timer that starts or stops mid-gesture
  // cannot leave the panel head under the bar. Two frames — one for React's
  // commit, one for the layout it invalidates.
  useEffect(() => {
    if (!revealPanel) return undefined;
    let raf = requestAnimationFrame(() => {
      raf = requestAnimationFrame(() => {
        const el = panelRef.current;
        if (!el) return;
        const reduce = typeof window.matchMedia === 'function'
          && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        el.scrollIntoView({ block: 'start', behavior: reduce ? 'auto' : 'smooth' });
      });
    });
    return () => cancelAnimationFrame(raf);
  }, [revealPanel]);

  // [ and ] keep working exactly as they did on the day view: previous / next.
  // On Statistics they move the period, which is the only thing on screen.
  useEffect(() => {
    const onKey = (e) => {
      const tag = (e.target.tagName || '').toLowerCase();
      if (['input', 'textarea', 'select'].includes(tag) || e.target.isContentEditable) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key !== '[' && e.key !== ']') return;
      e.preventDefault();
      const dir = e.key === '[' ? -1 : 1;
      if (section === 'stats') shiftPeriod(dir); else stepSelection(dir);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [section, mode, anchor, selected, scope, weekStart]); // eslint-disable-line

  // `s` — read the range on screen back as prose. Drafts included: this is for
  // recall, not for billing.
  const showSummary = useCallback(() => {
    setSummary(buildDaySummary(panelEntries, {
      title: summaryTitle,
      increment: settings?.rounding?.increment || 0.1,
      showDates: scope !== 'day',
    }));
  }, [panelEntries, summaryTitle, scope, settings]);

  useEffect(() => {
    window.addEventListener('tk:day-summary', showSummary);
    return () => window.removeEventListener('tk:day-summary', showSummary);
  }, [showSummary]);

  async function finalizeDay(ack = false) {
    const r = await api.post('/api/finalize-day', { date: selected, ack });
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

  // Every export control in the app names the file it makes now (teardown §12:
  // four buttons, one word, two formats).
  async function exportRangeCsv() {
    const r = await api.post('/api/export', { from: panelRange.from, to: panelRange.to });
    if (r.count === 0) {
      emitToast('No finalized entries in this range — finalize first (or use Entries → Export for drafts).');
      return;
    }
    downloadText(`timekeeper-${panelRange.from}${panelRange.to !== panelRange.from ? `_${panelRange.to}` : ''}.csv`, r.csv);
    emitToast(`Exported ${r.count} ${r.count === 1 ? 'entry' : 'entries'} as CSV`);
    bumpRefresh();
  }

  const dayMenuItems = [
    { label: 'Summary as text…', icon: 'clipboard', onClick: showSummary },
    { hr: true },
    ...(scope === 'day'
      ? [{ label: 'Finalize day without exporting', icon: 'lock', onClick: () => finalizeDay() }]
      : []),
    { label: `Download ${scopeWord} as CSV`, icon: 'export', onClick: exportRangeCsv },
  ];

  if (error) return html`<${ErrorBox} error=${error} />`;

  // ---- the head: one period control, and the period's figures, for the whole
  // screen. The strip is INSIDE the header on both sections and both viewports
  // (see PeriodStrip): three numbers that describe the period cannot live in
  // three different places on three surfaces. ----
  const head = html`
    <div class="page-head cal-head" data-section=${section}>
      <button class="btn btn-icon" title=${`Previous ${mode} ([)`} aria-label=${`Previous ${mode}`}
        onClick=${() => shiftPeriod(-1)}><${Icon} name="chevronLeft" size=${16} /></button>
      <h1>${headTitle}</h1>
      <button class="btn btn-icon" title=${`Next ${mode} (])`} aria-label=${`Next ${mode}`}
        onClick=${() => shiftPeriod(1)}><${Icon} name="chevronRight" size=${16} /></button>
      <button class="btn btn-sm" onClick=${goToday}>Today</button>
      <div class="spacer"></div>
      <div class="seg" role="group" aria-label="Calendar period">
        ${[['month', 'Month'], ['week', 'Week']].map(([v, label]) => html`
          <button key=${v} class=${mode === v ? 'on' : ''} aria-pressed=${mode === v}
            title=${`Show the whole ${label.toLowerCase()}`}
            onClick=${() => { setStatsRange(null); setMode(v); }}>${label}</button>`)}
      </div>
      <${PeriodStrip} periodLabel=${periodLabel} totals=${totals} />
    </div>`;

  // =========================================================================
  // STATISTICS — the absorbed Stats screen, on the period this screen is on.
  // =========================================================================
  if (section === 'stats') {
    const s = statsQ.data;
    const maxCm = s ? Math.max(...s.byCm.map((x) => x.hours), 0.1) : 1;
    const maxTask = s ? Math.max(...s.byTask.map((x) => x.hours), 0.1) : 1;
    const maxDay = s ? Math.max(...s.byDay.map((x) => x.hours), 0.1) : 1;
    return html`
      ${head}
      <div class="cal-view" data-section="stats">
        <div class="stats-range">
          ${statsRange ? html`
            <span class="date-range">
              <label class="range-field">
                <span class="field-label">From</span>
                ${/* An emptied date input would send from='' and 400 the
                      whole screen into an error box, so a blank is ignored
                      rather than committed. */''}
                <input type="date" value=${statsRange.from} required
                  onChange=${(e) => setStatsRange((r) => (e.target.value ? { ...r, from: e.target.value } : r))} />
              </label>
              <label class="range-field">
                <span class="field-label">To</span>
                <input type="date" value=${statsRange.to} required
                  onChange=${(e) => setStatsRange((r) => (e.target.value ? { ...r, to: e.target.value } : r))} />
              </label>
            </span>
            <button class="btn btn-sm" onClick=${() => setStatsRange(null)}>
              Back to ${mode === 'month' ? monthName(anchor) : 'this week'}</button>` : html`
            ${/* The old presets (This week / This month / Last month) are the
                  period control in the header now — one arrow back is last
                  month. Custom stays, because nothing else spans an arbitrary
                  range. */''}
            <button class="btn btn-sm"
              title="Report on any from/to range instead of the period above"
              onClick=${() => setStatsRange({ from: period.from, to: period.to })}>
              <${Icon} name="calendar" size=${15} /> Custom range…</button>`}
        </div>
        ${statsQ.loading && !s ? html`<${Spinner} />` : html`
          <section class="panel">
            <div class="section-title"><h2>Hours by client / matter</h2></div>
            <${BarList} rows=${s.byCm} labelKey="short_name" max=${maxCm} title="matters" />
          </section>
          <section class="panel">
            <div class="section-title"><h2>Hours by task</h2></div>
            <${BarList} rows=${s.byTask} labelKey="task" max=${maxTask} title="task codes" />
          </section>
          <section class="panel">
            <div class="section-title">
              <h2>Hours by day</h2>
              <span class="muted small">The calendar draws the same figures against your target.</span>
            </div>
            ${/* Was ten flat accent bars with two axis labels and the hours
                  hidden in a title attribute — decoration on a desktop and
                  nothing at all on a phone. */''}
            <${BarList} rows=${s.byDay.map((d) => ({ ...d, day: fmtDateLong(d.date).replace(/,[^,]*$/, '') }))}
              labelKey="day" max=${maxDay} title="days" />
          </section>`}
      </div>
      ${summary ? html`
        <${SummaryModal} text=${summary} title=${`Summary — ${summaryTitle}`}
          filename=${`timekeeper-summary-${panelRange.from}.txt`}
          onClose=${() => setSummary(null)} />` : null}`;
  }

  // =========================================================================
  // CALENDAR
  // =========================================================================
  const cellLabel = (cell, info) => {
    const when = fmtDateFull(cell.date);
    if (!info) return `${when} — no time recorded`;
    const bits = [`${fmtHours(info.total)} hours`, `${fmtHours(info.billable)} billable`];
    if (info.draft > 0) bits.push(`${info.draft} not finalized`);
    return `${when} — ${bits.join(', ')}`;
  };

  const dayCell = (cell) => {
    const info = byDay.get(cell.date);
    const empty = !info;
    return html`
      <button key=${cell.date}
        class=${'cal-day' + (cell.inMonth ? '' : ' other-month') + (cell.weekend ? ' weekend' : '')
          + (cell.date === todayStr() ? ' today' : '') + (cell.date === selected ? ' selected' : '')
          + (empty ? ' is-empty' : '')}
        aria-pressed=${cell.date === selected}
        aria-label=${cellLabel(cell, info)}
        onClick=${() => pick(cell.date)}>
        <span class="cal-num" aria-hidden="true">${cell.dayNum}</span>
        ${info && info.draft > 0 ? html`<span class="cal-draft" aria-hidden="true"></span>` : null}
        ${info ? html`
          <span class="cal-hours" aria-hidden="true"><${Hours} value=${info.total} size="lg" /></span>
          <span class="cal-split" aria-hidden="true">
            ${info.billable > 0 ? html`<span class="b" style=${{ width: `${Math.min(100, (info.billable / cellScale) * 100)}%` }}></span>` : null}
            ${info.nonbillable > 0 ? html`<span class="nb" style=${{ width: `${Math.min(100, (info.nonbillable / cellScale) * 100)}%` }}></span>` : null}
          </span>` : null}
      </button>`;
  };

  return html`
    ${head}
    <div class="cal-view" data-section="calendar">
      ${loading && !data ? html`<${Spinner} />` : mode === 'month' ? html`
        <div class="cal-grid">
          ${dowLabels(weekStart).map((d) => html`<div key=${d} class="cal-dow">${d}</div>`)}
          <div class="cal-dow cal-total-head">Total</div>
          ${chunk7(cells).flatMap((week, wi) => [
            ...week.map(dayCell),
            (() => {
              const wk = week.reduce((a, cell) => {
                const info = byDay.get(cell.date);
                if (info) { a.billable += info.billable; a.nonbillable += info.nonbillable; }
                return a;
              }, { billable: 0, nonbillable: 0 });
              const wtotal = wk.billable + wk.nonbillable;
              return html`
                <div key=${'wt' + wi} class=${'cal-week-total' + (wtotal > 0 ? '' : ' is-empty')}
                  title=${`${fmtHours(wk.billable)} billable / ${fmtHours(wk.nonbillable)} non-billable this week`}>
                  ${wtotal > 0 ? html`
                    <span class="cal-wt-label">Week</span>
                    <span class="cal-wt-b mono">${fmtHours(wk.billable)}</span>
                    ${wk.nonbillable > 0 ? html`<span class="cal-wt-nb mono">${fmtHours(wk.nonbillable)}</span>` : null}` : null}
                </div>`;
            })(),
          ])}
        </div>` : html`
        <div class="week-strip">
          ${weekDays.map((day) => {
            const info = byDay.get(day);
            return html`
              <div key=${day} class=${'week-col' + (day === selected ? ' selected' : '')}>
                <button class="week-day-btn" aria-pressed=${day === selected}
                  aria-label=${cellLabel({ date: day }, info)}
                  onClick=${() => pick(day)}>
                  <span class="week-day-name">${fmtDateLong(day).replace(/,.*$/, '')} ${Number(day.slice(8))}</span>
                  ${info && info.draft > 0 ? html`<span class="dot dot-draft" aria-hidden="true"></span>` : null}
                  <span class="mono">${info ? fmtHours(info.total) : '—'}</span>
                </button>
                ${(info?.entries || []).map((e) => html`
                  ${/* A preview, not a control: these were click-to-open <div>s
                        with no keyboard path and no accessible name. The day's
                        entries open from the panel below, which is a real
                        list. */''}
                  <p key=${e.id} class="week-entry">
                    <span class="mono">${fmtHours(e.total)}</span> ${e.cm ? e.cm.short_name : 'No matter yet'}
                  </p>`)}
              </div>`;
          })}
        </div>`}
      ${/* Labelled, not a cipher: every mark on the grid is named here in
            words, and each cell repeats the whole reading in its accessible
            name so a phone and a screen reader get what a hover used to. */''}
      <p class="cal-legend">
        ${mode === 'month' ? html`
          <span><span class="dot dot-billable"></span>Billable</span>
          <span><span class="dot dot-nonbillable"></span>Non-billable</span>` : null}
        <span><span class="dot dot-draft"></span>Not finalized</span>
        ${mode === 'month' ? html`
          <span class="muted cal-key">${target > 0
            ? `A full bar is your ${fmtHours(target)}h daily target.`
            : 'Bars compare each day with the busiest day in view.'}</span>` : null}
      </p>
      ${showPanel ? html`
        <${DayPanel} selected=${selected} scope=${scope} setScope=${setScope}
          customFrom=${customFrom} customTo=${customTo}
          setCustomFrom=${setCustomFrom} setCustomTo=${setCustomTo}
          entries=${panelEntries} loading=${panelLoading}
          settings=${settings} openEditor=${openEditor} bumpRefresh=${bumpRefresh}
          onStep=${stepSelection} onMenu=${setDayMenu} menuOpen=${!!dayMenu} title=${panelTitle}
          panelRef=${panelRef} />` : null}
    </div>
    ${dayMenu ? html`
      <${Menu} anchor=${dayMenu.anchor} title="Day actions" items=${dayMenuItems}
        onClose=${() => setDayMenu(null)} />` : null}
    ${summary ? html`
      <${SummaryModal} text=${summary} title=${`Summary — ${summaryTitle}`}
        filename=${`timekeeper-summary-${panelRange.from}${panelRange.to !== panelRange.from ? `_${panelRange.to}` : ''}.txt`}
        onClose=${() => setSummary(null)} />` : null}
    ${warnGate ? html`
      <${Confirm} title="Finalize with warnings?" confirmLabel="Finalize anyway"
        message=${warnGate.message}
        onConfirm=${() => finalizeDay(true)}
        onClose=${() => setWarnGate(null)} />` : null}
  `;
}
