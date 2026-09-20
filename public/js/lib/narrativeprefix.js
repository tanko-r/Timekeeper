// Site-code narrative prefixes in the entry editor (2026-09-19 feedback). The
// server works out each matter's prefix ("(ABC02)", server/lib/sitecode.js)
// and sends it as cm.narrative_prefix; these helpers only decide where it
// goes in the narrative box.
//
// ZERO imports on purpose, same rule as narrativesync.js: this module runs
// unchanged in the browser (no-build) and under node:test.

// True when the box holds nothing the attorney wrote: empty, or just the prefix.
export function isPrefixOnly(narrative, prefix) {
  const n = String(narrative || '').trim();
  return n === '' || (!!prefix && n === String(prefix).trim());
}

// The box after the matter changes. Only an untouched box follows the matter —
// text the attorney typed is never rewritten. The trailing space leaves the
// caret ready for the first word.
export function prefixForMatter(narrative, oldPrefix, newPrefix) {
  if (!isPrefixOnly(narrative, oldPrefix)) return narrative;
  return newPrefix ? `${newPrefix} ` : '';
}

// Text added to a box that holds only the prefix goes after it, not in place
// of it (suggestion chips, "insert from history").
export function afterPrefix(prefix, text) {
  // Borrowed text (a chip, a past narrative) may already open with the
  // prefix — carry it once, not twice.
  const t = splitPrefix(text, prefix).body;
  return prefix ? `${prefix} ${t}` : t;
}

// Split a leading prefix off the narrative, so AI rewrites work on the prose
// alone and the prefix goes back in front of whatever the model returns.
export function splitPrefix(narrative, prefix) {
  const n = String(narrative || '').trim();
  const p = String(prefix || '').trim();
  if (p && n.startsWith(p)) return { lead: p, body: n.slice(p.length).trim() };
  return { lead: null, body: n };
}
