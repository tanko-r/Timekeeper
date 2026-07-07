// Divide `total` hours into tenths across `shares` (largest-remainder method).
// The result always sums exactly to the total; zero/degenerate shares fall
// back to an even split; every line gets at least 0.1 when the total allows.

export function allocateTenths(total, shares) {
  const n = shares.length;
  if (n === 0) return [];
  const units = Math.max(0, Math.round(total * 10));
  const sum = shares.reduce((a, b) => a + (Number(b) > 0 ? Number(b) : 0), 0);
  const norm = sum > 0
    ? shares.map((s) => (Number(s) > 0 ? Number(s) : 0) / sum)
    : shares.map(() => 1 / n);

  const raw = norm.map((s) => s * units);
  const base = raw.map(Math.floor);
  let remainder = units - base.reduce((a, b) => a + b, 0);
  const byFraction = raw
    .map((r, i) => [r - Math.floor(r), i])
    .sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (let k = 0; k < remainder; k++) base[byFraction[k % n][1]] += 1;

  // lift zero lines to a tenth by shaving the largest, when there's room
  if (units >= n) {
    for (let i = 0; i < n; i++) {
      while (base[i] === 0) {
        const maxIdx = base.indexOf(Math.max(...base));
        if (base[maxIdx] <= 1) break;
        base[maxIdx] -= 1;
        base[i] += 1;
      }
    }
  }

  return base.map((u) => Math.round(u) / 10);
}
