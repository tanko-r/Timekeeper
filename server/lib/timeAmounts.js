// Suggested narratives must never invent time amounts: the app records
// duration separately from the narrative text, and a narrative generated (or
// refined) BEFORE a timer stops has no real duration to describe yet. This
// guard flags text that looks like it's carrying a billed amount — either a
// task-billing parenthetical ("(0.5)") or a spelled-out amount ("2 hours",
// "1.5 hrs", "3h") — so callers can reject/skip it.
//
// Deliberately narrow: a bare number (a year, a room/section number, a
// docket entry) must NOT trip this. See test/api.ai.test.js for accept/
// reject cases, including the "2026 lease" guard case.
const PAREN_AMOUNT = /\(\s*\d+(?:\.\d+)?\s*\)/;
const WORDED_AMOUNT = /\b\d+(?:\.\d+)?\s*(?:hours?|hrs?|h)\b/i;

export function containsTimeAmounts(text) {
  const s = String(text ?? '');
  return PAREN_AMOUNT.test(s) || WORDED_AMOUNT.test(s);
}
