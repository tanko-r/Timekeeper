import { html, useEffect, useRef, useState, fmtHours, fmtClock, Icon } from '/js/ui.js';

// Persistent "today" footer (spec §4): ambient awareness — live running
// clock, billable-vs-target meter, one key to close the day. Dashboard only.
export function TodayFooter({ today, timers, onCloseDay }) {
  const running = (timers || []).filter((t) => t.running);
  const [, tick] = useState(0);
  useEffect(() => {
    if (!running.length) return undefined;
    const h = setInterval(() => tick((x) => x + 1), 1000);
    return () => clearInterval(h);
  }, [running.length]);

  // subtle pulse when the filed total changes (Task 7 owns the wider motion language)
  const prev = useRef(today.total);
  const [bump, setBump] = useState(false);
  useEffect(() => {
    if (today.total !== prev.current) {
      prev.current = today.total;
      setBump(true);
      const t = setTimeout(() => setBump(false), 400);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [today.total]);

  const target = today.target || 0;
  const pct = target ? Math.min(100, Math.round((today.billable / target) * 100)) : 0;
  const liveSecs = running.reduce((s, t) => s + t.elapsed_seconds, 0)
    + (running.length ? Math.floor((Date.now() % 1000) / 1000) : 0);

  return html`
    <div class="today-footer">
      <span class=${'tf-total mono' + (bump ? ' bump' : '')} title="Filed today (all entries)">
        ${fmtHours(today.total)}h</span>
      <span class="muted small">filed</span>
      ${target ? html`
        <span class="tf-meter" title=${`${fmtHours(today.billable)}h billable of ${fmtHours(target)}h target`}>
          <span class="tf-meter-fill" style=${{ width: pct + '%' }}></span>
        </span>
        <span class="muted small">${pct}%</span>` : null}
      <span class="spacer" style=${{ flex: 1 }}></span>
      ${running.length ? html`
        <span class="tf-running" title=${running.map((t) => t.name).join(', ')}>
          <${Icon} name="timer" size=${14} />
          <span class="mono">${fmtClock(liveSecs)}</span>
          <span class="muted small">${running.length === 1 ? running[0].name : `${running.length} running`}</span>
        </span>` : null}
      <button class="btn btn-sm btn-primary" onClick=${onCloseDay} title="Review, finalize, and export today (c)">
        <${Icon} name="lock" size=${14} /> Close the day <kbd>c</kbd>
      </button>
    </div>`;
}
