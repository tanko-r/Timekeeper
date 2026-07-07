import { api } from '/js/api.js';
import {
  html, useEffect, useAsync, Spinner, ErrorBox, fmtHours, fmtDateLong,
  addDays, todayStr, emitToast,
} from '/js/ui.js';
import { EntryList } from '/js/components/entrylist.js';
import { nav } from '/js/app.js';

export function DayView({ date, settings, openEditor, refreshKey, bumpRefresh }) {
  const day = date || todayStr();
  const { loading, data, error } = useAsync(
    () => api.get(`/api/entries?date=${day}`), [day, refreshKey]);

  useEffect(() => {
    const onKey = (e) => {
      const tag = (e.target.tagName || '').toLowerCase();
      if (['input', 'textarea', 'select'].includes(tag)) return;
      if (e.key === '[') nav(`#/day/${addDays(day, -1)}`);
      if (e.key === ']') nav(`#/day/${addDays(day, 1)}`);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [day]);

  if (error) return html`<${ErrorBox} error=${error} />`;
  const entries = data || [];
  const total = entries.reduce((a, e) => a + e.total, 0);
  const billable = entries.reduce((a, e) => a + (e.billable ? e.total : 0), 0);

  async function finalizeDay() {
    const r = await api.post('/api/finalize-day', { date: day, ack: true });
    if (r.blocked.length > 0) {
      emitToast(`${r.finalized.length} finalized, ${r.blocked.length} blocked — open them to fix.`, { error: true });
    } else {
      emitToast(r.finalized.length ? `Finalized ${r.finalized.length}` : 'Nothing to finalize.');
    }
    bumpRefresh();
  }

  return html`
    <div class="page-head">
      <button class="btn" title="Previous day ([)" onClick=${() => nav(`#/day/${addDays(day, -1)}`)}>‹</button>
      <h1>${fmtDateLong(day)}</h1>
      <button class="btn" title="Next day (])" onClick=${() => nav(`#/day/${addDays(day, 1)}`)}>›</button>
      ${day !== todayStr() ? html`<button class="btn btn-sm" onClick=${() => nav(`#/day/${todayStr()}`)}>Today</button>` : null}
      <div class="spacer"></div>
      <span class="muted">${fmtHours(billable)}h billable · ${fmtHours(total)}h total</span>
      <button class="btn" onClick=${finalizeDay}>🔒 Finalize day</button>
      <button class="btn btn-primary" onClick=${() => openEditor({ template: { date: day } })}>＋ Entry</button>
    </div>
    ${loading && !data ? html`<${Spinner} />` : html`
      <${EntryList} entries=${entries} openEditor=${openEditor} onChanged=${bumpRefresh} settings=${settings} />`}
  `;
}
