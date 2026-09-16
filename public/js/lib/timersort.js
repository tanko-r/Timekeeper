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

// 2026-09-15/16 feedback: the time-based tabs (Today/Yesterday/Week/Recent)
// show one list mixing every client, alphabetized purely by caption — so
// timers for the same client end up scattered. Group them by client, same
// header style as the "All" tab's named groups — except a client with only
// ONE timer in this list gets no header of its own (that would be a lot of
// one-line "headers" for a busy Recent tab); those singles are pooled into a
// single trailing "Other Clients" bucket instead.
// Ordered by each client's first appearance in `timers`, so the existing
// order (typically A–Z by name) still governs both which client's group
// comes first and the order within it; "Other Clients" always comes last,
// in the same first-appearance order among the singles.
// A timer with no client (client_id null/undefined) groups with its peers
// under "No client" the same as any other client — it only lands in "Other
// Clients" if it is the ONLY matterless timer in the list, same rule as
// everyone else.
// Returns [{ key, label, list }, …] — `list` inside each group keeps the
// timers' relative order from the input.
export function groupTimersByClient(timers) {
  const order = [];
  const buckets = new Map(); // key -> { key, label, list }
  for (const t of timers) {
    const key = t.client_id ?? 'none';
    if (!buckets.has(key)) {
      const label = t.client_name || t.client_number || 'No client';
      buckets.set(key, { key: `client-${key}`, label, list: [] });
      order.push(key);
    }
    buckets.get(key).list.push(t);
  }
  const groups = order.map((key) => buckets.get(key));
  const solo = groups.filter((g) => g.list.length === 1);
  const result = groups.filter((g) => g.list.length > 1);
  if (solo.length) {
    result.push({ key: 'other-clients', label: 'Other Clients', list: solo.flatMap((g) => g.list) });
  }
  return result;
}
