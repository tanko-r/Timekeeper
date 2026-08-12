// Browser-side mirror of server/lib/timeAmounts.js — ZERO imports (runs
// no-build in the browser, same as ghost.js/expand.js). Suggested narratives
// must never carry a time amount (the app records duration separately), so
// this filters chip candidates client-side; the server applies the same
// regexes when picking the timer-start suggestion and refining it via the
// local LLM (server/routes/timers.js, server/routes/ai.js).
//
// Citation subsections ("12(b)(6)", "1542(3)") must NOT match — real
// task-billing parentheticals are decimals, and the bare "h" suffix needs a
// decimal too ("0.3 h" yes, "8h x 10w" no). The shared fixture table in
// test/timeAmounts.test.js runs against BOTH copies — keep them identical.
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
