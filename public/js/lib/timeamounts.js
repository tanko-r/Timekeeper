// Browser-side mirror of server/lib/timeAmounts.js — ZERO imports (runs
// no-build in the browser, same as ghost.js/expand.js). Suggested narratives
// must never carry a time amount (the app records duration separately), so
// this filters chip candidates client-side; the server applies the same
// regexes when picking the timer-start suggestion and refining it via the
// local LLM (server/routes/timers.js, server/routes/ai.js).
const PAREN_AMOUNT = /\(\s*\d+(?:\.\d+)?\s*\)/;
const WORDED_AMOUNT = /\b\d+(?:\.\d+)?\s*(?:hours?|hrs?|h)\b/i;

export function containsTimeAmounts(text) {
  const s = String(text ?? '');
  return PAREN_AMOUNT.test(s) || WORDED_AMOUNT.test(s);
}
