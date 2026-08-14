// Join narratives borrowed from past entries into one (2026-08-14 feedback:
// "Import narrative from one or more entries").
//
// ZERO imports on purpose, same rule as narrativesync.js: this module runs
// unchanged in the browser (no-build) and under node:test.
//
// The result mirrors the app's own multi-clause narrative shape
// (server/lib/narrative.js buildNarrative): clauses separated by "; ", one
// terminal period, first letter capitalized. Anything else would read as a
// foreign body next to the narratives the app writes itself.
export function joinNarratives(texts) {
  const parts = (texts || [])
    .map((t) => String(t || '').trim().replace(/[.;\s]+$/, ''))
    .filter(Boolean);
  if (parts.length === 0) return '';
  const joined = parts.join('; ');
  return joined.charAt(0).toUpperCase() + joined.slice(1) + '.';
}

// Fold borrowed text into what the narrative box already holds. Empty box →
// the borrowed text becomes the narrative; otherwise it joins on as one more
// clause, because replacing text the attorney typed is not something a button
// labelled "Insert" is allowed to do.
export function insertNarrative(current, addition) {
  const cur = String(current || '').trim();
  const add = String(addition || '').trim();
  if (!add) return cur;
  if (!cur) return joinNarratives([add]);
  return joinNarratives([cur, add]);
}
