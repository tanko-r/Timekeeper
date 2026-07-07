import { api } from '/js/api.js';
import {
  html, useState, useAsync, Spinner, ErrorBox, fmtHours, todayStr, addDays,
} from '/js/ui.js';

function monthBounds(offset = 0) {
  const now = new Date();
  const first = new Date(now.getFullYear(), now.getMonth() + offset, 1, 12);
  const last = new Date(now.getFullYear(), now.getMonth() + offset + 1, 0, 12);
  const f = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return { from: f(first), to: f(last) };
}

function weekBoundsOf(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dow = (new Date(y, m - 1, d, 12).getDay() + 6) % 7;
  const from = addDays(dateStr, -dow);
  return { from, to: addDays(from, 6) };
}

const PRESETS = [
  ['This week', () => weekBoundsOf(todayStr())],
  ['This month', () => monthBounds(0)],
  ['Last month', () => monthBounds(-1)],
];

// Single-hue horizontal bars (magnitude), values always labeled.
function BarList({ rows, labelKey, max }) {
  return html`
    <div>
      ${rows.map((r) => html`
        <div key=${r[labelKey]} class="bar-row">
          <span class="bar-label" title=${r[labelKey]}>${r[labelKey]}</span>
          <div class="bar-track">
            <div class="bar-fill" style=${{ width: `${Math.max(1, (r.hours / max) * 100)}%` }}
              title=${`${r[labelKey]}: ${fmtHours(r.hours)}h`}></div>
          </div>
          <span class="bar-value mono">${fmtHours(r.hours)}h</span>
        </div>`)}
      ${rows.length === 0 ? html`<p class="muted small">No data in range.</p>` : null}
    </div>`;
}

export function StatsView({ refreshKey }) {
  const [preset, setPreset] = useState('This month');
  const [custom, setCustom] = useState(monthBounds(0));

  const range = preset === 'Custom' ? custom : PRESETS.find(([n]) => n === preset)[1]();
  const { loading, data, error } = useAsync(
    () => api.get(`/api/stats?from=${range.from}&to=${range.to}`),
    [range.from, range.to, refreshKey]);

  if (error) return html`<${ErrorBox} error=${error} />`;

  const s = data;
  const maxCm = s ? Math.max(...s.byCm.map((x) => x.hours), 0.1) : 1;
  const maxTask = s ? Math.max(...s.byTask.map((x) => x.hours), 0.1) : 1;
  const maxDay = s ? Math.max(...s.byDay.map((x) => x.hours), 0.1) : 1;

  return html`
    <div class="page-head"><h1>Stats</h1>
      <div class="spacer"></div>
      ${PRESETS.map(([name]) => html`
        <button key=${name} class=${'btn btn-sm' + (preset === name ? ' btn-primary' : '')}
          onClick=${() => setPreset(name)}>${name}</button>`)}
      <button class=${'btn btn-sm' + (preset === 'Custom' ? ' btn-primary' : '')}
        onClick=${() => setPreset('Custom')}>Custom</button>
    </div>
    ${preset === 'Custom' ? html`
      <div class="row" style=${{ marginBottom: '12px' }}>
        <input type="date" value=${custom.from} style=${{ width: '160px' }}
          onChange=${(e) => setCustom((c) => ({ ...c, from: e.target.value }))} />
        <span class="muted">→</span>
        <input type="date" value=${custom.to} style=${{ width: '160px' }}
          onChange=${(e) => setCustom((c) => ({ ...c, to: e.target.value }))} />
      </div>` : null}

    ${loading && !s ? html`<${Spinner} />` : html`
      <div class="stat-tiles" style=${{ marginBottom: '14px' }}>
        <div class="stat-tile"><div class="k">Total</div><div class="v">${fmtHours(s.totalHours)}h</div></div>
        <div class="stat-tile"><div class="k">Billable</div><div class="v">${fmtHours(s.billableHours)}h</div></div>
        <div class="stat-tile"><div class="k">Billable ratio</div><div class="v">${Math.round(s.billableRatio * 100)}%</div></div>
        <div class="stat-tile"><div class="k">Days with time</div><div class="v">${s.byDay.length}</div></div>
      </div>

      <div class="card">
        <h2>By day</h2>
        <div class="spark" role="img" aria-label="Hours per day">
          ${s.byDay.map((d) => html`
            <div key=${d.date} class="col" title=${`${d.date}: ${fmtHours(d.hours)}h (${fmtHours(d.billableHours)} billable)`}>
              <div class="fill" style=${{ height: `${(d.hours / maxDay) * 100}%` }}></div>
            </div>`)}
          ${s.byDay.length === 0 ? html`<p class="muted small">No data in range.</p>` : null}
        </div>
        ${s.byDay.length > 0 ? html`
          <div class="spark-labels">
            <span>${s.byDay[0].date.slice(5)}</span>
            ${s.byDay.length > 2 ? html`<span style=${{ flex: s.byDay.length - 2 }}></span>` : null}
            ${s.byDay.length > 1 ? html`<span>${s.byDay[s.byDay.length - 1].date.slice(5)}</span>` : null}
          </div>` : null}
      </div>

      <div class="card">
        <h2>Hours by client/matter</h2>
        <${BarList} rows=${s.byCm.map((c) => ({ ...c, label: `${c.short_name}` }))} labelKey="short_name" max=${maxCm} />
      </div>

      <div class="card">
        <h2>Hours by task</h2>
        <${BarList} rows=${s.byTask} labelKey="task" max=${maxTask} />
      </div>`}
  `;
}
