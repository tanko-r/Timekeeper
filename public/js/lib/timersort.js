// A–Z ordering for timer cards. Pure and zero-dep so node:test can import it
// (timergrid.js itself pulls in the React vendor bundle — same reason
// lib/pip.js and lib/titlebar.js keep their own copies of small helpers).
//
// 2026-07-27 feedback: the toolbar's A–Z button sorted by the matter's short
// name, which is invisible on the card — so the result looked unsorted. The
// caption (timers.name) is what the eye reads, so that leads; the matter is
// only a tiebreak between identical captions. `numeric` keeps AVC2 in front of
// AVC10, and `sensitivity: 'base'` keeps case out of it.
const COLLATE = { sensitivity: 'base', numeric: true };

export function compareTimersAZ(a, b) {
  return String(a.name || '').localeCompare(String(b.name || ''), undefined, COLLATE)
    || String(a.cm_short_name || '').localeCompare(String(b.cm_short_name || ''), undefined, COLLATE);
}
