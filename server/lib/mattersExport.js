// Client/matter roster export — the reference list itself, not time entries.
// Distinct from routes/export.js, which exports billable time. This one answers
// "what client-matters do I have?" for a spreadsheet or for the firm's records.

import { toCsv } from './csv.js';

export const MATTERS_CSV_HEADER = [
  'client_number', 'client_name', 'matter_number', 'cm_number',
  'short_name', 'billable', 'status', 'favorite', 'entry_count', 'last_used_at',
];

// Numbers are fixed-width digit strings, so a plain string compare orders them
// correctly and needs no parseInt.
function byNumber(a, b) {
  return String(a.client_number || '').localeCompare(String(b.client_number || ''))
    || String(a.matter_number || '').localeCompare(String(b.matter_number || ''));
}

export function buildMattersCsv(rows) {
  const sorted = [...rows].sort(byNumber);
  return toCsv(MATTERS_CSV_HEADER, sorted.map((m) => [
    m.client_number ?? '',
    m.client_name ?? '',
    m.matter_number ?? '',
    m.cm_number ?? '',
    m.short_name ?? '',
    m.billable ? 'billable' : 'non-billable',
    m.status ?? '',
    m.favorite ? 'yes' : 'no',
    m.entry_count ?? 0,
    m.last_used_at ?? '',
  ]));
}
