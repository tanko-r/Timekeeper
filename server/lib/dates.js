// Local-time date helpers. All "date" strings are YYYY-MM-DD in the server's
// time zone; construction goes through the local Date constructor so DST is
// handled by the platform.

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function pad(n) {
  return String(n).padStart(2, '0');
}

export function todayLocal(now = new Date()) {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function isValidDate(str) {
  const m = DATE_RE.exec(str || '');
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(y, mo - 1, d, 12);
  return dt.getFullYear() === y && dt.getMonth() === mo - 1 && dt.getDate() === d;
}

function parts(dateStr) {
  const m = DATE_RE.exec(dateStr);
  if (!m) throw new Error(`invalid date: ${dateStr}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function addDays(dateStr, n) {
  const [y, mo, d] = parts(dateStr);
  return todayLocal(new Date(y, mo - 1, d + n, 12)); // noon dodges DST edges
}

export function localMidnightMs(dateStr) {
  const [y, mo, d] = parts(dateStr);
  return new Date(y, mo - 1, d).getTime();
}

export function weekBounds(dateStr) {
  const [y, mo, d] = parts(dateStr);
  const dow = new Date(y, mo - 1, d, 12).getDay(); // 0=Sun..6=Sat
  const sinceMonday = (dow + 6) % 7;
  const from = addDays(dateStr, -sinceMonday);
  return { from, to: addDays(from, 6) };
}
