// Hour rounding. increment in hours (e.g. 0.1 = 6 minutes), mode 'nearest'|'up'.

const EPS = 1e-9;

function clean(x) {
  return Math.round(x * 10000) / 10000;
}

export function roundHours(hours, { increment, mode } = {}) {
  if (!increment || increment <= 0) return hours;
  const units = hours / increment;
  const rounded = mode === 'up' ? Math.ceil(units - EPS) : Math.round(units + EPS);
  return clean(rounded * increment);
}

export function secondsToHours(seconds, rounding = {}) {
  const raw = seconds / 3600;
  if (rounding.enabled) return roundHours(raw, rounding);
  return clean(Math.round(raw * 100) / 100);
}

// ── the billing quantum (owner decision, 2026-08-16) ──────────────────────
// "All billing should be done in 1/10 hr increments." Every figure that is
// STORED, billed or exported — an entry's total and each of its task lines —
// is a multiple of the configured increment, rounded UP (the audited rule).
// Quantising at the point of storage is what makes the ledger, the CSV, the
// .TIM and the narrative's own bracketed allocations agree by construction:
// there is no second formatter to keep in sync, and durationLabel()'s
// toFixed() becomes exact rather than lossy.
//
// Deliberately independent of `rounding.enabled`: that setting governs how
// elapsed SECONDS become hours (raw vs snapped), not whether a BILLED figure
// may be a non-tenth. Turning rounding off must not put 0.75 h on a bill.
export function billingIncrement(rounding = {}) {
  const inc = Number((rounding || {}).increment);
  return Number.isFinite(inc) && inc > 0 ? inc : 0.1;
}

export function quantizeBilled(hours, rounding = {}) {
  const h = Number(hours);
  // Non-numbers and negatives are refused upstream (normalizeTasks, the
  // editor); pass them through untouched rather than inventing a figure.
  if (!Number.isFinite(h) || h <= 0) return Number.isFinite(h) ? h : hours;
  return roundHours(h, { increment: billingIncrement(rounding), mode: 'up' });
}
