// Deterministic text-expansion engine (spec §6): expands a just-typed
// abbreviation into its phrase when a delimiter is typed after it
// ("tc/oc " → "telephone conference with opposing counsel ").
// ZERO imports on purpose: the same ES module runs in the browser (no-build)
// and under node:test (test/expand.test.js).
//
// Rules:
// - Expansion triggers only when the character just typed (the one before
//   `caret`) is a delimiter: whitespace or . , ; : ) — mid-word never expands.
// - The candidate abbreviation is the run of non-delimiter characters
//   immediately before that delimiter ("tc/oc" survives; "IA." → "IA").
//   Consequence: abbreviations cannot contain delimiter characters.
// - Matching is case-insensitive. If the typed abbreviation starts uppercase
//   and the phrase starts lowercase, the phrase is capitalized (sentence
//   starts stay sentences).
// - Returns { text, caret } with the delimiter preserved and the caret placed
//   after it, or null when nothing expands.

const DELIMS = new Set([' ', '\n', '\t', '.', ',', ';', ':', ')']);

export function expandShortcuts(text, caret, shortcuts) {
  if (!text || caret < 2 || !Array.isArray(shortcuts) || shortcuts.length === 0) return null;
  const delim = text[caret - 1];
  if (!DELIMS.has(delim)) return null;
  let start = caret - 1;
  while (start > 0 && !DELIMS.has(text[start - 1])) start--;
  const typed = text.slice(start, caret - 1);
  if (!typed) return null;
  const hit = shortcuts.find((s) => String(s.abbrev).toLowerCase() === typed.toLowerCase());
  if (!hit || typed === hit.phrase) return null;
  let phrase = String(hit.phrase);
  if (/^[A-Z]/.test(typed) && /^[a-z]/.test(phrase)) {
    phrase = phrase[0].toUpperCase() + phrase.slice(1);
  }
  return {
    text: text.slice(0, start) + phrase + text.slice(caret - 1),
    caret: start + phrase.length + 1,
  };
}
