import { html, fmtHours } from '/js/ui.js';

// THE DAY'S NUMBERS, IN ONE PLACE.
//
// This used to be a lone progress bar inside a `.card` with an `<h2>Today</h2>`
// over it — and the sticky footer said the same thing again in a different
// framing ("64%" vs "2.9h to go"), and the entry list's header said it a third
// time ("4 entries · 5.5h"). The teardown (§4) deleted the card; this is what
// replaced it: a stat strip under the day header, no card chrome, one hero
// figure, then the split, then the bar, then the number nobody had anywhere —
// week to date against target (teardown D6).
//
// Mercury's big-number/small-cents treatment is used once and only once, on
// today's filed total; everything else stays data-dense, per the reference
// analysis' warning that inflating every figure fights the density goal.
// Colour identity is always labelled in the legend, never colour alone
// (Primer ProgressBar's multi-segment rule).
export function TargetMeter({ billable, nonbillable, target, total = null, week = null }) {
  const filed = total == null ? billable + nonbillable : total;
  const scaleMax = Math.max(target || 0, billable + nonbillable, 0.1) * 1.08;
  const pct = (v) => `${Math.min(100, (v / scaleMax) * 100)}%`;
  const remaining = target != null ? Math.max(0, target - billable) : null;

  const figure = fmtHours(filed);
  const [whole, tenth] = figure.split('.');

  const weekPct = week && week.target > 0
    ? Math.min(100, Math.round((week.billable / week.target) * 100)) : null;

  return html`
    <section class="daystat" aria-label="Today at a glance">
      <div class="daystat-row">
        <p class="daystat-hero">
          <span class="daystat-num"><span class="daystat-int">${whole}</span><span class="daystat-dec">.${tenth}</span></span>
          <span class="daystat-unit">h</span>
          <span class="daystat-cap">filed today</span>
        </p>
        <div class="meter-legend daystat-legend">
          <span><span class="dot dot-billable"></span>Billable <strong class="mono">${fmtHours(billable)}h</strong></span>
          <span><span class="dot dot-nonbillable"></span>Non-billable <strong class="mono">${fmtHours(nonbillable)}h</strong></span>
          ${target != null ? html`
            <span class="daystat-target">
              ${remaining > 0
                ? html`<strong class="mono">${fmtHours(remaining)}h</strong> to ${fmtHours(target)}h`
                : html`<span class="daystat-met">✓ ${fmtHours(target)}h target met</span>`}
            </span>` : null}
        </div>
      </div>

      <div class="meter-bar" role="img"
        aria-label=${`Today: ${fmtHours(billable)} billable, ${fmtHours(nonbillable)} non-billable`
          + (target != null ? `, target ${fmtHours(target)}` : '')}>
        <div class="meter-fill billable" style=${{ width: pct(billable) }}
          title=${`Billable ${fmtHours(billable)}h`}></div>
        <div class="meter-fill nonbillable"
          style=${{ left: pct(billable), width: pct(nonbillable) }}
          title=${`Non-billable ${fmtHours(nonbillable)}h`}></div>
        ${target != null && target > 0 ? html`
          <div class="meter-target" style=${{ left: pct(target) }} title=${`Target ${fmtHours(target)}h`}></div>` : null}
      </div>

      ${week && week.target > 0 ? html`
        <p class="daystat-week">
          <span class="daystat-week-label">Week to date</span>
          <span class="meter-bar daystat-weekbar" role="img"
            aria-label=${`Week to date: ${fmtHours(week.billable)} billable of ${fmtHours(week.target)} target`}>
            <span class="meter-fill billable" style=${{ width: `${weekPct}%` }}></span>
          </span>
          <strong class="mono">${fmtHours(week.billable)}h</strong>
          <span class="muted">of ${fmtHours(week.target)}h</span>
          <span class="muted small">${weekPct}%</span>
        </p>` : null}
    </section>`;
}
