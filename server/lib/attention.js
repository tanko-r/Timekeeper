// Where time leaks, and how we catch it.
//
// An entry makes two hops on its way to the billing system: draft →
// finalized, then finalized → exported. Time is at risk in the gap after
// either hop, and the two gaps read differently:
//
//   unfinalized — recorded but never locked in. Ordinary for today; a leak on
//                 any earlier day.
//   unexported  — locked in but never sent to the assistant. A leak on any
//                 day, however old.
//
// The case that actually bites is neither of those on its own: an entry that
// made both hops and was later unlocked to fix a typo. It drops back to draft
// and keeps its now-stale exported_at, so every "finalized?" and "exported?"
// question answers in a way that makes it look finished. `ever_finalized` is
// the only column that remembers it was ever done, which is what isReverted
// reads — see finalizeOne(), which clears exported_at on the way back up so
// the entry re-alerts as unexported once it is finalized again.
//
// Predicates take an entry ROW (not an enriched entry) so the dashboard, the
// export filter and the tests all classify from the same three columns.

export const ATTENTION_KINDS = ['unfinalized', 'unexported', 'either'];

// How far back the dashboard banner scans for unfinalized time. A stray draft
// older than this has stopped being a nudge and started being furniture; the
// Export page's filters still reach it with an explicit date range.
export const ATTENTION_WINDOW_DAYS = 90;

// Hours actually on an entry, in SQL: the manual override wins, otherwise the
// sum of its task lines. Mirrors effectiveTotal()/enrich() in routes/entries.js.
export const ENTRY_HOURS_SQL = `COALESCE(entries.total_override,
  (SELECT COALESCE(SUM(duration), 0) FROM entry_tasks WHERE entry_tasks.entry_id = entries.id))`;

const live = (e) => !e.deleted_at;

export function isUnfinalized(e) {
  return live(e) && e.status === 'draft';
}

export function isUnexported(e) {
  return live(e) && e.status === 'finalized' && !e.exported_at;
}

// Finalized once, now a draft again — the entry that already looked done.
export function isReverted(e) {
  return isUnfinalized(e) && !!e.ever_finalized;
}

export function needsAttention(e, kind) {
  if (kind === 'unfinalized') return isUnfinalized(e);
  if (kind === 'unexported') return isUnexported(e);
  if (kind === 'either') return isUnfinalized(e) || isUnexported(e);
  return true; // 'all', or no filter at all
}

// The same three predicates as a WHERE fragment over `entries`. Returns '' for
// no filter so callers can splice it in unconditionally.
export function attentionSql(kind) {
  if (kind === 'unfinalized') return "entries.status = 'draft'";
  if (kind === 'unexported') return "(entries.status = 'finalized' AND entries.exported_at IS NULL)";
  if (kind === 'either') return "(entries.status = 'draft' OR entries.exported_at IS NULL)";
  return '';
}
