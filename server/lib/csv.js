// RFC-4180 CSV with spreadsheet formula defanging (leading = + - @ get a
// literal apostrophe so Excel/Sheets treat them as text, not formulas).

function encodeField(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return String(value);
  let s = String(value);
  if (/^[=+\-@]/.test(s)) s = `'${s}`;
  if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function toCsv(header, rows) {
  const lines = [header, ...rows].map((row) => row.map(encodeField).join(','));
  return lines.join('\r\n') + '\r\n';
}
