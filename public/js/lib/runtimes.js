// Helpers for the entry editor's "last run" row (start / stop of the timer
// behind an entry). Pure, so they are unit-tested. All times are local.

const pad = (n) => String(n).padStart(2, '0');

function localDay(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// 'time' when the run began today (a plain time box is enough); 'datetime'
// when it began on an earlier day, so the date has to be visible and editable.
export function runKind(startIso, todayStr) {
  if (!startIso) return 'time';
  return localDay(new Date(startIso)) < todayStr ? 'datetime' : 'time';
}

// ISO → value for <input type="time"> or <input type="datetime-local">.
export function toInputValue(iso, kind) {
  if (!iso) return '';
  const d = new Date(iso);
  const t = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return kind === 'datetime' ? `${localDay(d)}T${t}` : t;
}

// Input value → ISO string, or null when blank or not a valid time.
// A bare time belongs to `dayStr`.
export function fromInputValue(value, dayStr) {
  if (!value) return null;
  const text = value.includes('T') ? value : `${dayStr}T${value}`;
  const d = new Date(text);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// "9:14 PM", or "Mon 9:14 PM" when it is not today.
export function fmtRunStamp(iso, todayStr) {
  if (!iso) return '';
  const d = new Date(iso);
  const h = d.getHours();
  const clock = `${h % 12 || 12}:${pad(d.getMinutes())} ${h < 12 ? 'AM' : 'PM'}`;
  if (localDay(d) === todayStr) return clock;
  return `${d.toLocaleDateString('en-US', { weekday: 'short' })} ${clock}`;
}
