// Custom fields (spec 2026-07-15): pure rules only — the merge that decides
// which definitions apply to a matter, and the per-entry value validation.
// DB access lives in routes/customfields.js.

// Accepts the stored JSON text OR an already-parsed array — enrich() attaches
// fields whose options the route layer has already parsed, and validation
// must work on both shapes.
export function parseOptions(text) {
  if (Array.isArray(text)) return text.map(String);
  try {
    const a = JSON.parse(text || '[]');
    return Array.isArray(a) ? a.map(String) : [];
  } catch {
    return [];
  }
}

// Client-level fields apply to every matter under the client; a matter-level
// field with the same name (case-insensitive) OVERRIDES the client one, so a
// one-off matter can tighten or replace its client's field without a dupe.
export function effectiveFields(clientFields = [], matterFields = []) {
  const bySort = (a, b) => (a.sort_order - b.sort_order) || (a.id - b.id);
  const overridden = new Set(matterFields.map((f) => String(f.name).toLowerCase()));
  return [
    ...clientFields.filter((f) => !overridden.has(String(f.name).toLowerCase())).sort(bySort),
    ...[...matterFields].sort(bySort),
  ];
}

// findings shaped like lib/validation.js: {level, code, message}.
// required+empty BLOCKS (the billing system would bounce the entry);
// format/option mismatches WARN (ack-able — a mistyped regex or a stale
// option list must never deadlock billing).
export function validateFieldValues(fields, values) {
  const findings = [];
  for (const f of fields) {
    const v = String((values || {})[f.id] ?? '').trim();
    if (!v) {
      if (f.required) {
        findings.push({
          level: 'block', code: 'custom_required',
          message: `"${f.name}" is required for this ${f.matter_id != null ? 'matter' : 'client'}.`,
        });
      }
      continue;
    }
    if (f.type === 'select') {
      const opts = parseOptions(f.options);
      if (opts.length > 0 && !opts.includes(v)) {
        findings.push({
          level: 'warn', code: 'custom_option',
          message: `"${f.name}" value "${v}" is not one of its dropdown options.`,
        });
      }
    } else if (f.pattern) {
      let re = null;
      try { re = new RegExp(`^(?:${f.pattern})$`); } catch { /* bad pattern never blocks billing */ }
      if (re && !re.test(v)) {
        findings.push({
          level: 'warn', code: 'custom_format',
          message: `"${f.name}" value "${v}" doesn't match the required format${f.pattern_hint ? ` (${f.pattern_hint})` : ''}.`,
        });
      }
    }
  }
  return findings;
}
