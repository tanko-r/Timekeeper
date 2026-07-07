import { api } from '/js/api.js';
import {
  html, useState, useAsync, Spinner, ErrorBox, fmtHours, addDays, todayStr,
} from '/js/ui.js';
import { nav } from '/js/app.js';

const pad = (n) => String(n).padStart(2, '0');

function monthOf(dateStr) { return dateStr.slice(0, 7); }

function gridFor(yyyyMm) {
  const [y, m] = yyyyMm.split('-').map(Number);
  const first = new Date(y, m - 1, 1, 12);
  const startOffset = (first.getDay() + 6) % 7; // Monday start
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

function weekFor(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dow = (new Date(y, m - 1, d, 12).getDay() + 6) % 7;
  const monday = addDays(dateStr, -dow);
  return Array.from({ length: 7 }, (_, i) => addDays(monday, i));
}

export function CalendarView({ settings, openEditor, refreshKey }) {
  const [mode, setMode] = useState('month');
  const [anchor, setAnchor] = useState(todayStr());

  const range = mode === 'month'
    ? { from: gridFor(monthOf(anchor))[0].date, to: gridFor(monthOf(anchor))[41].date }
    : { from: weekFor(anchor)[0], to: weekFor(anchor)[6] };

  const { loading, data, error } = useAsync(
    () => api.get(`/api/entries?from=${range.from}&to=${range.to}`),
    [range.from, range.to, refreshKey]);

  if (error) return html`<${ErrorBox} error=${error} />`;

  const byDay = new Map();
  for (const e of data || []) {
    if (!byDay.has(e.date)) byDay.set(e.date, { total: 0, billable: 0, nonbillable: 0, entries: [] });
    const d = byDay.get(e.date);
    d.total += e.total;
    if (e.billable) d.billable += e.total; else d.nonbillable += e.total;
    d.entries.push(e);
  }

  const target = settings?.targets?.dailyHours || 0;
  const statusFor = (day, info) => {
    if (!target || !info || info.total === 0 || day.weekend) return null;
    const pct = info.total / target;
    if (pct >= 1) return ['good', '✓'];
    if (pct >= 0.5) return ['warning', '◐'];
    return ['serious', '!'];
  };

  const monthLabel = (() => {
    const [y, m] = monthOf(anchor).split('-').map(Number);
    return new Date(y, m - 1, 1, 12).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  })();

  function shift(dir) {
    if (mode === 'month') {
      const [y, m] = monthOf(anchor).split('-').map(Number);
      const d = new Date(y, m - 1 + dir, 1, 12);
      setAnchor(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-01`);
    } else {
      setAnchor(addDays(anchor, dir * 7));
    }
  }

  return html`
    <div class="page-head">
      <button class="btn" onClick=${() => shift(-1)}>‹</button>
      <h1>${mode === 'month' ? monthLabel : `Week of ${weekFor(anchor)[0]}`}</h1>
      <button class="btn" onClick=${() => shift(1)}>›</button>
      <button class="btn btn-sm" onClick=${() => setAnchor(todayStr())}>Today</button>
      <div class="spacer"></div>
      <div class="row" style=${{ gap: '4px' }}>
        <button class=${'btn btn-sm' + (mode === 'month' ? ' btn-primary' : '')} onClick=${() => setMode('month')}>Month</button>
        <button class=${'btn btn-sm' + (mode === 'week' ? ' btn-primary' : '')} onClick=${() => setMode('week')}>Week</button>
      </div>
    </div>
    <div class="meter-legend" style=${{ marginBottom: '10px' }}>
      <span><span class="dot dot-billable"></span>Billable</span>
      <span><span class="dot dot-nonbillable"></span>Non-billable</span>
      ${target ? html`<span class="muted">✓ ≥${fmtHours(target)}h · ◐ ≥50% · ! under 50%</span>` : null}
    </div>
    ${loading && !data ? html`<${Spinner} />` : mode === 'month' ? html`
      <div class="cal-grid">
        ${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => html`<div key=${d} class="cal-dow">${d}</div>`)}
        ${gridFor(monthOf(anchor)).map((cell) => {
          const info = byDay.get(cell.date);
          const status = statusFor(cell, info);
          const scale = Math.max(target || 0, info ? info.total : 0, 0.1);
          return html`
            <button key=${cell.date}
              class=${'cal-day' + (cell.inMonth ? '' : ' other-month') + (cell.weekend ? ' weekend' : '') + (cell.date === todayStr() ? ' today' : '')}
              onClick=${() => nav(`#/day/${cell.date}`)}>
              <span class="cal-num">${cell.dayNum}</span>
              ${status ? html`<span class=${'cal-status ' + status[0]} title=${'vs ' + fmtHours(target) + 'h target'}>${status[1]}</span>` : null}
              ${info ? html`
                <span class="cal-hours mono">${fmtHours(info.total)}</span>
                <span class="cal-split" title=${`${fmtHours(info.billable)} billable / ${fmtHours(info.nonbillable)} non-billable`}>
                  ${info.billable > 0 ? html`<span class="b" style=${{ width: `${(info.billable / scale) * 100}%` }}></span>` : null}
                  ${info.nonbillable > 0 ? html`<span class="nb" style=${{ width: `${(info.nonbillable / scale) * 100}%` }}></span>` : null}
                </span>` : null}
            </button>`;
        })}
      </div>` : html`
      <div class="week-strip">
        ${weekFor(anchor).map((day) => {
          const info = byDay.get(day);
          return html`
            <div key=${day} class="week-col">
              <div class="col-head">
                <a href=${`#/day/${day}`}>${day.slice(5)}</a>
                <span class="mono muted">${info ? fmtHours(info.total) : ''}</span>
              </div>
              ${(info?.entries || []).map((e) => html`
                <div key=${e.id} class="week-entry" title=${e.narrative}
                  onClick=${() => openEditor({ id: e.id })}>
                  <span class="mono">${fmtHours(e.total)}</span> ${e.cm.short_name}
                </div>`)}
            </div>`;
        })}
      </div>`}
  `;
}
