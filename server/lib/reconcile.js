// ── keeping an entry's task lines equal to its billed total ────────────────
//
// An entry carries TWO records of the same hours: `entries.total_override` (the
// figure the screen, the .TIM and the CSV's per-entry total column all report)
// and its `entry_tasks` rows (the figure the CSV's per-line `duration` column
// reports, and the one the client-facing narrative prints its "(0.5)" brackets
// from). Every write that moves one without moving the other opens a gap
// between two numbers that leave the building in the SAME export — under-billing
// when the lines fall short, over-billing when they exceed. docs/ui/BRIEF.md
// forbids both ("no time may be lost… nothing double-counted").
//
// The reconcile is a DELTA, not a re-split: only the change since the last sync
// is placed, onto the LAST line and cascading backwards if that line cannot
// absorb it all. Every allocation the attorney typed above it is left exactly as
// he set it, and a single line still just mirrors the total.
//
// THE TENTH RULE (owner decision, 2026-08-16): "all billing should be done in
// 1/10 hr increments." So when the target total is itself a multiple of the
// increment — which every stored total is, since server/lib/rounding.js
// quantizeBilled() runs at the point of storage — the whole allocation is done
// in WHOLE INCREMENT UNITS. A line can then only ever come out a multiple of the
// increment, so the narrative's brackets, the CSV duration column and the .TIM
// all agree exactly and none of them needs a formatter to hide a 0.05.
//
// A total that is NOT a multiple (a legacy row banked before the rule, or a
// caller that has not adopted it) falls back to exact decimal arithmetic: the
// lines still add up to the total, which is the rule that outranks tidiness.

import { billingIncrement } from './rounding.js';

const round4 = (n) => Math.round(n * 10000) / 10000;
const num = (x) => Number(x) || 0;

// PURE. Given the current line durations (in order) and the total they must add
// up to, return the durations they should hold. Same length, same order; a line
// that does not change comes back with the value it had. Never returns a
// negative duration — a delta bigger than the tail can absorb keeps cascading
// backwards, and any remainder that survives the first line is dropped there
// rather than written as a negative (which no billing system accepts).
export function allocateLines(durations, total, { increment } = {}) {
  const cur = durations.map(num);
  if (cur.length === 0) return [];
  const inc = billingIncrement({ increment });
  const target = Number(total);
  if (!Number.isFinite(target)) return cur;

  // Whole-increment arithmetic whenever the target is a whole number of
  // increments (the normal case — see THE TENTH RULE above).
  const units = target / inc;
  if (Math.abs(units - Math.round(units)) < 1e-6) {
    const u = cur.map((d) => Math.round(d / inc));
    let remaining = Math.round(units) - u.reduce((a, b) => a + b, 0);
    for (let i = u.length - 1; i >= 0 && remaining !== 0; i--) {
      const next = Math.max(0, u[i] + remaining);
      remaining -= next - u[i];
      u[i] = next;
    }
    return u.map((n) => round4(n * inc));
  }

  const out = cur.slice();
  let remaining = round4(target - out.reduce((a, b) => a + b, 0));
  for (let i = out.length - 1; i >= 0 && remaining !== 0; i--) {
    const next = Math.max(0, round4(out[i] + remaining));
    remaining = round4(remaining - (next - out[i]));
    out[i] = next;
  }
  return out;
}

// Apply allocateLines() to an entry's stored rows. `lines` is [{ id, duration }]
// in sort order; only rows whose duration actually changes are written, so a
// reconcile that has nothing to do touches no rows at all.
//
// Safe to call inside an outer db.transaction (better-sqlite3 nests via
// savepoints) and safe to call on an entry with no lines — a total with nothing
// to allocate it to is left alone rather than invented into existence.
export function reconcileLines(db, lines, total, rounding = {}) {
  if (!Array.isArray(lines) || lines.length === 0) return false;
  const next = allocateLines(lines.map((l) => l.duration), total, rounding);
  const upd = db.prepare('UPDATE entry_tasks SET duration=? WHERE id=?');
  let changed = false;
  for (let i = 0; i < lines.length; i++) {
    if (next[i] !== num(lines[i].duration)) {
      upd.run(next[i], lines[i].id);
      changed = true;
    }
  }
  return changed;
}

// The same reconcile addressed by entry id: reads the entry's lines in the
// canonical order (sort_order, id — the order the narrative and the CSV print
// them in) and reconciles them to `total`.
export function reconcileEntryLines(db, entryId, total, rounding = {}) {
  const lines = db.prepare(
    'SELECT id, duration FROM entry_tasks WHERE entry_id=? ORDER BY sort_order, id').all(entryId);
  return reconcileLines(db, lines, total, rounding);
}
