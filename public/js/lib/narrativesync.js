// Client mirror of the server narrative rules (server/lib/narrative.js), plus
// the edit-through parser and the hours-rebalance rule that make the entry
// editor's narrative textarea a two-way surface (spec Task 2).
//
// ZERO imports on purpose: the same ES module runs in the browser (no-build)
// and under node:test (test/narrativesync.test.js). In particular this file
// must NOT import fmtHours from ui.js — the minimal formatting logic is
// copied in below and kept honest by a fixture-table drift test.

// ---------- hours formatting (mirrors ui.js fmtHours exactly) ----------

function formatHours(h, increment = 0.1) {
  const s = String(increment);
  const decimals = s.includes('.') ? Math.max(1, s.length - s.indexOf('.') - 1) : 1;
  return Number(h || 0).toFixed(decimals);
}

function decimalsOf(increment) {
  const s = String(increment ?? 0.1);
  const dot = s.indexOf('.');
  return dot === -1 ? 0 : s.length - dot - 1;
}

function cleanFragment(text) {
  return String(text || '').trim().replace(/[.;\s]+$/, '');
}

// ---------- generateNarrative ----------

export function generateNarrative(lines, { increment = 0.1, taskBilling = true } = {}) {
  const substantive = (lines || [])
    .map((l) => ({
      text: cleanFragment(l.fragment) || cleanFragment(l.task_code),
      duration: Number(l.duration) || 0,
    }))
    .filter((l) => l.text || l.duration > 0);

  if (substantive.length < 2) return null;

  const parts = substantive.map((l, i) => {
    let text = l.text || 'Time';
    if (i === 0) text = text.charAt(0).toUpperCase() + text.slice(1);
    return taskBilling ? `${text} (${formatHours(l.duration, increment)})` : text;
  });
  return parts.join('; ') + '.';
}

// ---------- parseNarrativeEdit ----------

// Matches "<anything>(<content>)" anchored at the end of the string. The
// leading `.*` is greedy, so backtracking finds the LAST parenthetical in
// the segment, which lets a fragment legitimately contain its own parens.
const TRAILING_PAREN_RE = /^([\s\S]*)\(([^)]*)\)\s*$/;

export function parseNarrativeEdit(text, lineCount, { taskBilling = true } = {}) {
  const raw = String(text || '').trim().replace(/\.\s*$/, '');
  if (!raw) return null;

  const rawSegments = raw.split(';');
  if (rawSegments.length !== lineCount) return null;

  if (taskBilling) {
    const segments = [];
    for (const seg of rawSegments) {
      const trimmed = seg.trim();
      const m = TRAILING_PAREN_RE.exec(trimmed);
      if (!m) return null;
      const fragment = m[1].trim();
      const numStr = m[2].trim();
      const duration = Number(numStr);
      // A non-positive allocation is structurally meaningless in a task-billed
      // narrative (and the server rejects negatives), so treat it as a break
      // → null, giving a clean AUTO detach instead of an autosave 400 loop.
      if (!fragment || numStr === '' || !Number.isFinite(duration) || duration <= 0) return null;
      segments.push({ fragment, duration });
    }
    return { segments };
  }

  const segments = [];
  for (const seg of rawSegments) {
    const fragment = seg.trim();
    if (!fragment) return null;
    segments.push({ fragment, duration: null });
  }
  return { segments };
}

// ---------- rebalanceHours ----------

// David's auto-rebalance rule (deliberately simple, not a solver): the
// changed line gets its new value; the delta is pulled from (or returned to)
// the OTHER lines in reverse order, each floored at one increment. Whatever
// can't be absorbed just changes the effective total — no error, no
// redistribution gymnastics. Internally works in integer multiples of the
// increment to dodge float drift.
//
// `total` is accepted-but-inert: the rule only ever preserves whatever the
// lines summed to BEFORE this edit (see the delta-absorption loop below), so
// it never reads `total`. Callers naturally have the entry's current total in
// hand though, so the param stays part of the contract for a future stricter
// mode (e.g. clamping the rebalance to an explicit total) without a
// signature change.
export function rebalanceHours(durations, changedIndex, newValue, { total, increment = 0.1 } = {}) { // eslint-disable-line no-unused-vars
  const scale = 10 ** decimalsOf(increment);
  const toUnits = (x) => Math.round(Number(x || 0) * scale);
  const fromUnits = (u) => u / scale;
  const incUnits = Math.max(1, Math.round(increment * scale));

  const units = (durations || []).map(toUnits);
  const n = units.length;
  if (changedIndex < 0 || changedIndex >= n) return units.map(fromUnits);

  const oldUnits = units[changedIndex];
  let newUnits = Math.round(toUnits(newValue) / incUnits) * incUnits;
  newUnits = Math.max(incUnits, newUnits);
  units[changedIndex] = newUnits;

  let delta = newUnits - oldUnits; // > 0: changed line grew, must shrink others
  for (let i = n - 1; i >= 0 && delta !== 0; i--) {
    if (i === changedIndex) continue;
    if (delta > 0) {
      const avail = Math.max(0, units[i] - incUnits);
      const take = Math.min(avail, delta);
      if (take > 0) {
        units[i] -= take;
        delta -= take;
      }
    } else {
      // changed line shrank: the whole delta is returned to this one line.
      units[i] += -delta;
      delta = 0;
    }
  }

  return units.map(fromUnits);
}

// ---------- formatSuggestion ----------

export function formatSuggestion(text) {
  let t = String(text || '').trim();
  if (!t) return t;
  t = t.charAt(0).toUpperCase() + t.slice(1);
  if (!/[.!?]$/.test(t)) t += '.';
  return t;
}
