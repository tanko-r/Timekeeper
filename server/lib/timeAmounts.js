// Suggested narratives must never invent time amounts: the app records
// duration separately from the narrative text, and a narrative generated (or
// refined) BEFORE a timer stops has no real duration to describe yet. This
// guard flags text that looks like it's carrying a billed amount — either a
// task-billing parenthetical ("(0.5)") or a spelled-out amount ("2 hours",
// "1.5 hrs", "0.3 h") — so callers can reject/skip it.
//
// Deliberately narrow — this is an attorney billing app, so citation
// subsections like "12(b)(6)", "1542(3)", or "Rule 56(c)(2)" are everyday
// narrative text and must NOT trip this. Every real task-billing
// parenthetical here is a DECIMAL ("(0.5)", "(1.2)"), so the parenthetical
// pattern requires one; the bare "h" suffix likewise requires a decimal
// ("0.3 h" yes, "8h x 10w" no) while "hours"/"hrs" also match integers
// ("2 hours" is unambiguously a duration). Shared fixture table in
// test/timeAmounts.test.js runs against BOTH this file and the client
// mirror (public/js/lib/timeamounts.js) — keep the logic identical.
const PAREN_AMOUNT = /\(\s*\d+\.\d+\s*\)/;
const WORDED_AMOUNT = /\b\d+(?:\.\d+)?\s*(?:hours?|hrs?)\b|\b\d+\.\d+\s*h\b/i;

export function containsTimeAmounts(text) {
  const s = String(text ?? '');
  return PAREN_AMOUNT.test(s) || WORDED_AMOUNT.test(s);
}

// The removal half of the same rule, for text on its way INTO the model
// ("Expand → split into tasks" seeds from the narrative box, and an AUTO
// narrative carries a parenthetical per task). The amounts are the app's
// bookkeeping; the model is being asked about the work. Same patterns, so
// citations and dimensions survive untouched.
const PAREN_AMOUNT_G = /\s*\(\s*\d+\.\d+\s*\)/g;
const WORDED_AMOUNT_G = /\b\d+(?:\.\d+)?\s*(?:hours?|hrs?)\b|\b\d+\.\d+\s*h\b/gi;

export function stripTimeAmounts(text) {
  return String(text ?? '')
    .replace(PAREN_AMOUNT_G, '')
    .replace(WORDED_AMOUNT_G, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([;,.])/g, '$1')
    .trim();
}
