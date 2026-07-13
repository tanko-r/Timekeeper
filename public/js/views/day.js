import { api } from '/js/api.js';
import {
  html, useState, useEffect, useAsync, Spinner, ErrorBox, fmtHours, fmtDateLong,
  addDays, todayStr, emitToast, Confirm, Icon,
} from '/js/ui.js';
import { EntryList } from '/js/components/entrylist.js';
import { nav } from '/js/app.js';

export function DayView({ date, settings, openEditor, refreshKey, bumpRefresh }) {
  const day = date || todayStr();
  const { loading, data, error } = useAsync(
    () => api.get(`/api/entries?date=${day}`), [day, refreshKey]);

  // stepping onto today lands on the dashboard — that's today's real screen
  const goDay = (dateStr) => nav(dateStr === todayStr() ? '#/' : `#/day/${dateStr}`);

  useEffect(() => {
    const onKey = (e) => {
      const tag = (e.target.tagName || '').toLowerCase();
      if (['input', 'textarea', 'select'].includes(tag)) return;
      if (e.key === '[') goDay(addDays(day, -1));
      if (e.key === ']') goDay(addDays(day, 1));
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [day]);

  const [warnGate, setWarnGate] = useState(null);
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

  return html`
    <div class="page-head">
      <button class="btn" title="Previous day ([)" onClick=${() => goDay(addDays(day, -1))}><${Icon} name="chevronLeft" size=${16} /></button>
      <h1>${fmtDateLong(day)}</h1>
      <button class="btn" title="Next day (])" onClick=${() => goDay(addDays(day, 1))}><${Icon} name="chevronRight" size=${16} /></button>
      ${day !== todayStr() ? html`<button class="btn btn-sm" onClick=${() => nav('#/')}>Today</button>` : null}
      <div class="spacer"></div>
      <span class="muted">${fmtHours(billable)}h billable · ${fmtHours(total)}h total</span>
      <button class="btn" onClick=${finalizeDay}><${Icon} name="lock" size=${16} /> Finalize day</button>
      <button class="btn btn-primary" onClick=${() => openEditor({ template: { date: day } })}><${Icon} name="plus" size=${16} /> Entry</button>
    </div>
    ${loading && !data ? html`<${Spinner} />` : html`
      <${EntryList} entries=${entries} openEditor=${openEditor} onChanged=${bumpRefresh} settings=${settings} />`}
    ${warnGate ? html`
      <${Confirm} title="Finalize with warnings?" confirmLabel="Finalize anyway"
        message=${warnGate.message}
        onConfirm=${() => finalizeDay(true)}
        onClose=${() => setWarnGate(null)} />` : null}
  `;
}
