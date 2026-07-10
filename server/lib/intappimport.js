// Pure mapping logic for the one-off Intapp history import
// (scripts/import-intapp-history.mjs): the firm's "My Released Time" export
// becomes finalized+exported entries so the phrasebook / people / matter
// recency layers start with real history. Nothing here touches the database.

import { CM_RE } from './validation.js';

const MONTHS = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

// "Transferred May/07/2026 02:00:21 (MDT)" → '2026-05-07'. The transfer
// (release-to-billing) date is the only date Intapp exports — close enough
// for phrasebook recency, which is all this import feeds.
export function parseTransferDate(status) {
  const m = /^Transferred\s+([A-Za-z]{3})\/(\d{2})\/(\d{4})\b/.exec(String(status ?? ''));
  if (!m) return null;
  const month = MONTHS[m[1].toLowerCase()];
  return month ? `${m[3]}-${month}-${m[2]}` : null;
}

// Matches "<anything>(<content>)" anchored at the end of the segment — same
// shape as parseNarrativeEdit in public/js/lib/narrativesync.js: the greedy
// leading group makes the LAST parenthetical win, so fragments may contain
// their own parens ("(MAT1) design call (1.3)").
const TRAILING_PAREN_RE = /^([\s\S]*)\(([^)]*)\)\s*$/;

// Split a task-billed narrative ("A (1.2); b (0.3).") back into task lines.
// Returns [{fragment, duration}] only when EVERY segment carries a positive
// allocation, there are 2+ segments, and the allocations sum to the entry's
// hours — otherwise null and the caller keeps the free-text narrative.
export function parseTaskLines(narrative, hours) {
  const raw = String(narrative ?? '').trim().replace(/\.\s*$/, '');
  if (!raw) return null;
  const segments = raw.split(';');
  if (segments.length < 2) return null;

  const lines = [];
  let sum = 0;
  for (const seg of segments) {
    const m = TRAILING_PAREN_RE.exec(seg.trim());
    if (!m) return null;
    const fragment = m[1].trim();
    const duration = Number(m[2].trim());
    if (!fragment || m[2].trim() === '' || !Number.isFinite(duration) || duration <= 0) return null;
    lines.push({ fragment, duration });
    sum += duration;
  }
  if (Math.abs(sum - Number(hours)) > 0.005) return null;
  return lines;
}

// rows: [{hours, cm_number, client_name, matter_name, narrative, status}]
// opts.existingByCm: Map<cm_number, matter row> for matters already in the DB
// opts.existingEntryKeys: Set<`date|cm_number|narrative`> for idempotent re-runs
// Returns { plan, counts }; each plan item is
//   { rowNum, action: 'import'|'skip', reason, entry, newMatter } where entry =
//   { date, cm_number, narrative, hours, tasks } and newMatter is set on the
//   first row that needs a not-yet-existing matter created.
export function planIntappImport(rows, opts = {}) {
  const existingByCm = opts.existingByCm || new Map();
  const existingEntryKeys = opts.existingEntryKeys || new Set();
  const plannedMatters = new Set();

  const plan = (rows || []).map((row, i) => {
    const out = { rowNum: i + 1, action: 'skip', reason: null, entry: null, newMatter: null };
    const cm_number = String(row.cm_number ?? '').trim();
    const narrative = String(row.narrative ?? '').trim();
    const hours = Number(row.hours);
    const date = parseTransferDate(row.status);

    if (!CM_RE.test(cm_number)) { out.reason = `invalid CM number "${cm_number}"`; return out; }
    if (!date) { out.reason = 'no transfer date in status'; return out; }
    if (!narrative) { out.reason = 'empty narrative'; return out; }
    if (!Number.isFinite(hours) || hours <= 0) { out.reason = `bad hours "${row.hours}"`; return out; }
    if (existingEntryKeys.has(`${date}|${cm_number}|${narrative}`)) {
      out.reason = 'already imported';
      return out;
    }

    if (!existingByCm.has(cm_number) && !plannedMatters.has(cm_number)) {
      plannedMatters.add(cm_number);
      out.newMatter = {
        cm_number,
        client_name: String(row.client_name ?? '').trim(),
        matter_name: String(row.matter_name ?? '').trim(),
      };
    }

    out.action = 'import';
    out.entry = { date, cm_number, narrative, hours, tasks: parseTaskLines(narrative, hours) };
    return out;
  });

  const counts = {
    import: plan.filter((p) => p.action === 'import').length,
    skip: plan.filter((p) => p.action === 'skip').length,
    newMatters: plannedMatters.size,
  };
  return { plan, counts };
}
