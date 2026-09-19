// Site-code narrative prefixes (2026-09-19 feedback). Some clients want every
// narrative to open with the matter's site code in parens — "(ABC02)" — and a
// fixed-fee matter's with its descriptor too — "(ABC89 - Water Agreement)".
// The code is read from the matter's short name, which already starts with it
// by house habit ("ABC02 - Cedar Point (WA)", "abc09", "QR49 - Harbor").

// A leading code: 2-4 letters then 1-3 digits, any case, as a whole token.
const LEADING_RE = /^\s*([A-Za-z]{2,4}\d{1,3})(?![A-Za-z0-9])/;
// Anywhere else only the strict upper-case 3+2 shape counts, so a stray token
// like "FY26" in "Real Estate Dev-General FY26" is never taken for a site.
const ANYWHERE_RE = /(?:^|[^A-Za-z0-9])([A-Z]{3}\d{2})(?![A-Za-z0-9])/;
// A "(flat fee)" tag in the short name is bookkeeping, not a descriptor.
const FEE_TAG_RE = /\s*\((?:flat|fixed)[\s-]*fee\)\s*/gi;

export function siteCode(shortName) {
  const s = String(shortName || '');
  const m = LEADING_RE.exec(s) || ANYWHERE_RE.exec(s);
  return m ? m[1].toUpperCase() : null;
}

// The descriptor is whatever follows a LEADING code, minus separators and the
// fee tag. A code found mid-name has no well-defined descriptor.
function descriptor(shortName) {
  const s = String(shortName || '');
  const m = LEADING_RE.exec(s);
  if (!m) return '';
  return s.slice(m[0].length).replace(FEE_TAG_RE, ' ')
    .replace(/^[\s\-–—:]+/, '').replace(/\s+/g, ' ').trim();
}

// matter: { short_name, fixed_fee }. Returns "(CODE)", "(CODE - Descriptor)",
// or null when the name carries no site code. Whether the matter's client
// wants a prefix at all is the caller's question.
export function narrativePrefix(matter) {
  if (!matter) return null;
  const code = siteCode(matter.short_name);
  if (!code) return null;
  const desc = matter.fixed_fee ? descriptor(matter.short_name) : '';
  return desc ? `(${code} - ${desc})` : `(${code})`;
}

// The narrative a new entry starts with: the timer's own template if it has
// one, else the matter prefix; then any stashed text. A stash the attorney
// already opened with the prefix does not get it twice.
export function seedNarrative({ template, prefix, draft } = {}) {
  const lead = String(template || '').trim() || String(prefix || '').trim();
  const rest = String(draft || '').trim();
  if (lead && rest.startsWith(lead)) return rest;
  return [lead, rest].filter(Boolean).join(' ');
}
