// Divide `total` hours across `shares` (largest-remainder method), quantised to
// the firm's billing increment.
//
// The result ALWAYS sums EXACTLY to `total` — no time is invented and none is
// lost. When `total` is a whole multiple of `increment` (the normal case: an
// entry's hours are already rounded to the increment before they get here)
// every returned line is itself a multiple of the increment. When it is not,
// the sub-increment tail is handed to the largest line rather than rounded
// away, because losing it would change the bill.
//
// `increment` defaults to 0.1, so the two-argument call keeps the historic
// tenth-of-an-hour behaviour byte for byte.
//
// Degenerate shares fall back to an even split; every line gets at least one
// increment when the total allows it.

// Hours are decimal and don't divide cleanly in binary floating point, so all
// the arithmetic happens in integer micro-hours (1e-6 h). Increments are a user
// setting entered to two decimals, so this is far finer than anything real.
const MICRO = 1e6;
const micro = (x) => Math.round(Number(x) * MICRO);

export function allocateTenths(total, shares, increment = 0.1) {
  const n = shares.length;
  if (n === 0) return [];

  const inc = Number(increment) > 0 ? Number(increment) : 0.1;
  const q = Math.max(1, micro(inc));
  const totalMicro = Math.max(0, micro(total));
  const units = Math.floor(totalMicro / q);   // whole increments to hand out
  const leftover = totalMicro - units * q;    // sub-increment tail, never dropped

  const sum = shares.reduce((a, b) => a + (Number(b) > 0 ? Number(b) : 0), 0);
  const norm = sum > 0
    ? shares.map((s) => (Number(s) > 0 ? Number(s) : 0) / sum)
    : shares.map(() => 1 / n);

  const raw = norm.map((s) => s * units);
  const base = raw.map(Math.floor);
  const remainder = units - base.reduce((a, b) => a + b, 0);
  const byFraction = raw
    .map((r, i) => [r - Math.floor(r), i])
    .sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (let k = 0; k < remainder; k++) base[byFraction[k % n][1]] += 1;

  // lift zero lines to one increment by shaving the largest, when there's room
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

  const out = base.map((u) => u * q);
  if (leftover > 0) {
    // The total wasn't a whole number of increments. Give the tail to the
    // biggest line instead of rounding it off the bill.
    let maxIdx = 0;
    for (let i = 1; i < n; i++) if (out[i] > out[maxIdx]) maxIdx = i;
    out[maxIdx] += leftover;
  }
  return out.map((m) => m / MICRO);
}
