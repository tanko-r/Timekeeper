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
