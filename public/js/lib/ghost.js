// Ghost-text completion engine (spec §6): deterministic, from the matter's
// phrasebook — NEVER an LLM. Pure and dependency-free so the same ES module
// runs in the browser (no-build) and under node:test (test/ghost.test.js).
//
// The "segment" being completed is the text after the last sentence break
// (. ; :) — narratives are chains of clauses, and each clause completes
// independently. Matching is a case-insensitive prefix test against the
// ranked phrase list; the first (highest-ranked) hit wins. Returns the
// remainder to append (phrase casing), or null.

const SEGMENT_BREAK = /[.;:]/;

export function ghostCompletion(value, caret, phrases, { minChars = 2 } = {}) {
  const text = String(value ?? '');
  if (caret !== text.length || text.length === 0) return null; // only complete at the end
  let cut = -1;
  for (let i = text.length - 1; i >= 0; i--) {
    if (SEGMENT_BREAK.test(text[i])) { cut = i; break; }
  }
  const seg = text.slice(cut + 1).replace(/^\s+/, '');
  if (seg.length < minChars) return null;
  const low = seg.toLowerCase();
  for (const p of phrases || []) {
    const phrase = String(p);
    const pl = phrase.toLowerCase();
    if (pl.length > low.length && pl.startsWith(low)) return phrase.slice(seg.length);
  }
  return null;
}
