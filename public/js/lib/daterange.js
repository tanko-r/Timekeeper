// Anchored date ranges for the Day / Week / Month entry viewers (calendar
// panel + day view). Pure string math on local-time YYYY-MM-DD; no imports
// so node:test can exercise it directly.

const pad = (n) => String(n).padStart(2, '0');
const toStr = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = (s) => s.split('-').map(Number);

export function addDaysStr(dateStr, n) {
  const [y, m, d] = parse(dateStr);
  return toStr(new Date(y, m - 1, d + n, 12));
}

// {from, to} inclusive for the mode containing `anchor`. Weeks start Monday.
export function rangeFor(mode, anchor) {
  if (mode === 'week') {
    const [y, m, d] = parse(anchor);
    const dow = (new Date(y, m - 1, d, 12).getDay() + 6) % 7;
    const from = addDaysStr(anchor, -dow);
    return { from, to: addDaysStr(from, 6) };
  }
  if (mode === 'month') {
    const [y, m] = parse(anchor);
    return {
      from: `${y}-${pad(m)}-01`,
      to: toStr(new Date(y, m, 0, 12)), // day 0 of next month = last of this
    };
  }
  return { from: anchor, to: anchor };
}

// Move the anchor one mode-unit forward/back. Month steps clamp the
// day-of-month (Jul 31 → Jun 30), so repeated stepping never skips a month.
export function shiftAnchor(mode, anchor, dir) {
  if (mode === 'week') return addDaysStr(anchor, dir * 7);
  if (mode === 'month') {
    const [y, m, d] = parse(anchor);
    const lastOfTarget = new Date(y, m - 1 + dir + 1, 0, 12).getDate();
    return toStr(new Date(y, m - 1 + dir, Math.min(d, lastOfTarget), 12));
  }
  return addDaysStr(anchor, dir);
}
