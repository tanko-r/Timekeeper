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

// Parse RFC-4180 CSV text into an array of rows, each an array of string cells.
// Handles quoted fields, embedded commas/newlines, "" escaping, and CRLF or LF
// line endings. Fully blank lines (including a trailing newline) yield no row.
export function parseCsv(text) {
  const s = String(text ?? '');
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let dirty = false; // has the current row seen any content (char, comma, quote)?

  const endField = () => { row.push(field); field = ''; };
  const endRow = () => {
    if (dirty) { endField(); rows.push(row); }
    row = [];
    dirty = false;
  };

  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"') { inQuotes = true; dirty = true; }
    else if (c === ',') { endField(); dirty = true; }
    else if (c === '\n') { endRow(); }
    else if (c === '\r') { /* handled by the following \n */ }
    else { field += c; dirty = true; }
  }
  endRow(); // flush a final line with no trailing newline
  return rows;
}
