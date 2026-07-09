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
