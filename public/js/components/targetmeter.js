import { html, fmtHours } from '/js/ui.js';

// Daily progress vs target. Billable (blue) and non-billable (yellow) segments
// with a marker at the target; identity is labeled in the legend, never
// color-alone.
export function TargetMeter({ billable, nonbillable, target }) {
  const total = billable + nonbillable;
  const scaleMax = Math.max(target || 0, total, 0.1) * 1.08;
  const pct = (v) => `${Math.min(100, (v / scaleMax) * 100)}%`;
  const remaining = target != null ? Math.max(0, target - billable) : null;

  return html`
    <div class="meter">
      <div class="meter-bar" role="img"
        aria-label=${`Today: ${fmtHours(billable)} billable, ${fmtHours(nonbillable)} non-billable` +
          (target != null ? `, target ${fmtHours(target)}` : '')}>
        <div class="meter-fill billable" style=${{ width: pct(billable) }}
          title=${`Billable ${fmtHours(billable)}h`}></div>
        <div class="meter-fill nonbillable"
          style=${{ left: pct(billable), width: pct(nonbillable) }}
          title=${`Non-billable ${fmtHours(nonbillable)}h`}></div>
        ${target != null && target > 0 ? html`
          <div class="meter-target" style=${{ left: pct(target) }} title=${`Target ${fmtHours(target)}h`}></div>` : null}
      </div>
      <div class="meter-legend">
        <span><span class="dot dot-billable"></span>Billable <strong class="mono">${fmtHours(billable)}h</strong></span>
        <span><span class="dot dot-nonbillable"></span>Non-billable <strong class="mono">${fmtHours(nonbillable)}h</strong></span>
        ${target != null ? html`
          <span class="muted">Target <strong class="mono">${fmtHours(target)}h</strong>
            ${remaining > 0
              ? html` · <span>${fmtHours(remaining)}h to go</span>`
              : html` · <span style=${{ color: 'var(--accent)', fontWeight: 650 }}>✓ met</span>`}
          </span>` : null}
      </div>
    </div>`;
}
