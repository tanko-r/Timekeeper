import { html, fmtHours } from '/js/ui.js';

// THE DAY'S NUMBERS, IN ONE PLACE — AND IN FEWER BANDS.
//
// This used to be a lone progress bar inside a `.card` with an `<h2>Today</h2>`
// over it, and the sticky footer said the same thing again in a different
// framing ("64%" vs "2.9h to go"), and the entry list's header said it a third
// time ("4 entries · 5.5h"). The teardown (§4) deleted the card; this replaced
// it with a stat strip.
//
// WAVE-1b: the strip itself was still four stacked bands — hero row, legend
// row, bar, week row — 132px on a 390px phone, before a single row of work.
// It is THREE lines now and about 80px: the hero with the target beside it,
// the bar, and one caption line carrying the split and the week. The hero
// figure is untouched; what went is the vertical air between four things that
// are all the same sentence.
//
// Mercury's big-number/small-cents treatment is used once and only once, on
// today's filed total. Colour identity is always labelled in the legend, never
// colour alone (Primer ProgressBar's multi-segment rule), and no figure here
// takes an accent — rank is size and weight (tokens.css §7a, tier 3).
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
        ${target != null ? html`
          <span class="daystat-target">
            ${remaining > 0
              ? html`<strong class="mono">${fmtHours(remaining)}h</strong> to ${fmtHours(target)}h`
              : html`<span class="daystat-met">✓ ${fmtHours(target)}h target met</span>`}
          </span>` : null}
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

      ${/* One caption line for everything the bar cannot say by itself: which
            segment is which, and the number a lawyer actually manages — week
            to date against target (teardown D6), which used to cost a whole
            band of its own with a second miniature meter in it. */''}
      <p class="daystat-legend meter-legend">
        <span><span class="dot dot-billable"></span>Billable <strong class="mono">${fmtHours(billable)}h</strong></span>
        <span><span class="dot dot-nonbillable"></span>Non-billable <strong class="mono">${fmtHours(nonbillable)}h</strong></span>
        ${/* one interpolated string, not sibling elements: htm drops the
              whitespace-only text node between two tags on separate lines,
              which is how "27.4hof 40.0h" happened */''}
        ${week && week.target > 0 ? html`
          <span class="daystat-week">Week to date <strong class="mono">${fmtHours(week.billable)}h</strong>
            <span class="muted">${` of ${fmtHours(week.target)}h · ${weekPct}%`}</span></span>` : null}
      </p>
    </section>`;
}
