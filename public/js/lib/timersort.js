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

// 2026-09-15 feedback: the time-based tabs (Today/Yesterday/Week/Recent) and
// "All" show one list mixing every client, alphabetized purely by caption —
// so timers for the same client end up scattered. Cluster them WITHOUT a
// visible label (the ask was "subtle whitespace", not headers): a stable
// group-by on client_id, ordered by each client's first appearance, so the
// existing order (typically A–Z by name) still governs both the order
// clients appear in and the order within each client's run. Matterless
// timers (client_id null/undefined) all share one cluster rather than each
// getting its own — there's no client to tell them apart by.
// Returns { list, starts }: `list` is the reordered timers; `starts` is the
// set of timer ids that begin a new cluster — every one except the very
// first card overall, which needs no leading gap before anything is on
// screen yet.
export function clusterByClient(timers) {
  const order = [];
  const buckets = new Map();
  for (const t of timers) {
    const key = t.client_id ?? 'none';
    if (!buckets.has(key)) { buckets.set(key, []); order.push(key); }
    buckets.get(key).push(t);
  }
  const list = [];
  const starts = new Set();
  order.forEach((key, i) => {
    const items = buckets.get(key);
    if (i > 0 && items.length) starts.add(items[0].id);
    list.push(...items);
  });
  return { list, starts };
}
