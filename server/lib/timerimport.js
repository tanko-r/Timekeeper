// Pure planning logic for the CSV → batch-timer importer. The route parses the
// CSV (server/lib/csv.js) and then asks these functions what to do; nothing
// here touches the database, so it's all unit-testable.

import { CM_RE } from './validation.js';

// Guess which column holds each field from the header row. Header text is
// normalized to lowercase alphanumerics before matching, and a column is only
// claimed once so "Matter Number" and "Matter Name" don't collide. Returns a
// column index per field, or -1 when nothing matches (user fixes it in the UI).
export function detectMapping(headers) {
  const norm = (headers || []).map((h) => String(h ?? '').toLowerCase().replace(/[^a-z0-9]/g, ''));
  const used = new Set();
  const find = (needles) => {
    for (let i = 0; i < norm.length; i++) {
      if (!used.has(i) && norm[i] && needles.some((n) => norm[i].includes(n))) {
        used.add(i);
        return i;
      }
    }
    return -1;
  };
  // Order matters throughout: number columns before name columns so the
  // name needles ('client', 'name') can't steal "Client Number" / "Matter
  // Name" style headers, and client_name before matter_name so matter_name's
  // broad 'name' needle can't take a "Client Name" column.
  const client_number = find(['clientnumber', 'clientno', 'clientnum']);
  // With an explicit client-number column, "Matter Number" is the matter's
  // own number (the locked pairs model: client number+name, matter
  // number+name). Without one, it usually means the combined CM — firms
  // label 100001-000012 a "matter number" too.
  let matter_number = -1;
  let cm_number;
  if (client_number >= 0) {
    matter_number = find(['matternumber', 'matterno', 'matternum']);
    cm_number = find(['cmnumber', 'clientmatter', 'cmno', 'cm']);
  } else {
    cm_number = find(['cmnumber', 'matternumber', 'clientmatter', 'cmno', 'cm']);
  }
  return {
    cm_number,
    client_number,
    client_name: find(['clientname', 'client']),
    matter_number,
    matter_name: find(['mattername', 'name', 'matterdescription', 'description', 'matter']),
    group: find(['group', 'practice', 'category', 'section']),
  };
}

// Normalize an untrusted mapping from the client into {field: index}. Any index
// out of range for the header count becomes -1 (treated as "unmapped").
export function normalizeMapping(mapping, headerCount) {
  const out = {};
  for (const field of ['cm_number', 'client_number', 'client_name', 'matter_number', 'matter_name', 'group']) {
    const i = Number(mapping && mapping[field]);
    out[field] = Number.isInteger(i) && i >= 0 && i < headerCount ? i : -1;
  }
  return out;
}

// Turn parsed CSV rows into an actionable plan. `rows` includes the header row
// (row 0). Each data row becomes one plan entry with action 'create' or 'skip'
// plus a reason. A matter is created only when its CM number is valid, has a
// name, isn't already in the system, and isn't a duplicate earlier in the file.
// Billability is decided solely by the Group: groups in `nonBillableGroups`
// (case-insensitive) produce non-billable matters.
export function planImport(rows, mapping, opts = {}) {
  const existing = new Set(
    (opts.existingCmNumbers || []).map((s) => String(s).trim()));
  const nonBillable = new Set(
    (opts.nonBillableGroups || [])
      .map((s) => String(s).trim().toLowerCase())
      .filter(Boolean));

  const at = (row, idx) => (idx >= 0 && idx < row.length ? String(row[idx] ?? '').trim() : '');
  const seen = new Set();
  const plan = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    // Separate client+matter number columns (the locked pairs model) beat a
    // combined CM column when both are mapped. Numeric parts are zero-padded
    // to the canonical 6-6 shape; non-numeric garbage is left alone so it
    // still fails CM_RE and surfaces as a skip.
    const pad6 = (s) => (/^\d{1,6}$/.test(s) ? s.padStart(6, '0') : s);
    const client_number = at(row, mapping.client_number);
    const matter_number = at(row, mapping.matter_number);
    let cm_number = at(row, mapping.cm_number);
    if (client_number || matter_number) {
      cm_number = `${pad6(client_number)}-${pad6(matter_number)}`;
    }
    const client_name = at(row, mapping.client_name);
    const matter_name = at(row, mapping.matter_name);
    const group = at(row, mapping.group);

    // Wholly empty rows are noise, not skips — drop them silently.
    if (!client_number && !matter_number && !at(row, mapping.cm_number)
      && !matter_name && !group && !client_name) continue;

    const billable = group && nonBillable.has(group.toLowerCase()) ? 0 : 1;

    let action = 'create';
    let reason = null;
    if (!CM_RE.test(cm_number)) { action = 'skip'; reason = 'invalid CM number'; }
    else if (!matter_name) { action = 'skip'; reason = 'missing name'; }
    else if (existing.has(cm_number)) { action = 'skip'; reason = 'already exists'; }
    else if (seen.has(cm_number)) { action = 'skip'; reason = 'duplicate in file'; }
    else seen.add(cm_number);

    plan.push({ rowNum: i + 1, cm_number, client_name, matter_name, group, billable, action, reason });
  }

  const counts = {
    create: plan.filter((p) => p.action === 'create').length,
    skip: plan.filter((p) => p.action === 'skip').length,
  };
  return { plan, counts };
}
