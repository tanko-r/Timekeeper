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
// `total` is the entry's total hours, and it bounds the rule (2026-08-11
// feedback: "I manually increased the time at the top of the entry, but now I
// can't allocate that time in the task lines"). Raising the total leaves an
// unallocated remainder, and preserving the lines' old sum meant every attempt
// to type that remainder into a line was immediately clawed back out of the
// other lines — the sum could never reach the new total. A growing line now
// spends the unallocated remainder FIRST and only then pulls from the other
// lines. Omit `total` and the rule keeps its original sum-preserving behaviour.
export function rebalanceHours(durations, changedIndex, newValue, { total, increment = 0.1 } = {}) {
  const scale = 10 ** decimalsOf(increment);
  const toUnits = (x) => Math.round(Number(x || 0) * scale);
  const fromUnits = (u) => u / scale;
  const incUnits = Math.max(1, Math.round(increment * scale));

  const units = (durations || []).map(toUnits);
  const n = units.length;
  if (changedIndex < 0 || changedIndex >= n) return units.map(fromUnits);

  // Hours the total leaves unspoken for, measured BEFORE this edit. Growth
  // draws on this pool first; an exactly- or over-allocated entry has none,
  // which is the original sum-preserving behaviour.
  const totalUnits = Number.isFinite(Number(total)) ? toUnits(total) : null;
  const oldSum = units.reduce((a, b) => a + b, 0);
  const headroom = totalUnits == null ? 0 : Math.max(0, totalUnits - oldSum);

  const oldUnits = units[changedIndex];
  let newUnits = Math.round(toUnits(newValue) / incUnits) * incUnits;
  newUnits = Math.max(incUnits, newUnits);
  units[changedIndex] = newUnits;

  let delta = newUnits - oldUnits; // > 0: changed line grew, must shrink others
  if (delta > 0) delta -= Math.min(delta, headroom); // spend the remainder first
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

// ---------- splitNarrativeSegments ----------

// Literal "split into tasks" (2026-07-14 feedback): divide an existing
// narrative into task fragments at semicolons, keeping the wording verbatim
// — no AI, no flattening. A segment ending in a numeric parenthetical
// ("draft amendment (1.2)") surrenders it as that task's duration; anything
// else leaves duration null for the caller to allocate. The trailing period
// of the final segment is dropped (generateNarrative re-adds it).
const TRAILING_HOURS_RE = /^([\s\S]*?)\s*\((\d+(?:\.\d+)?)\)\s*$/;

export function splitNarrativeSegments(text) {
  const raw = String(text || '').trim().replace(/\.\s*$/, '');
  if (!raw) return [];
  return raw.split(';')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((seg) => {
      const m = TRAILING_HOURS_RE.exec(seg);
      if (m && m[1].trim()) return { fragment: m[1].trim(), duration: Number(m[2]) };
      return { fragment: seg, duration: null };
    });
}

// ---------- alignTasksToClauses ----------

// Anchor an AI task split to clauses the attorney already wrote (2026-08-11
// feedback: "the split into tasks … seems to delete tasks"). Measured against
// llama3.1:8b on a 5-clause narrative, one run in three came back with only
// four tasks and two runs in three reordered them. Re-deriving a split the
// attorney has ALREADY made is a lossy round trip, and a lost line is a lost
// billed task.
//
// The clauses therefore fix the SHAPE of the answer — how many task lines
// there are, in what order, and what each is worth — while the model still
// writes the WORDING. Expanding and rewriting is the point of the button, so
// a matched clause always takes the model's text; the attorney's own clause
// is the fallback that rescues one the model dropped, so no described work
// goes unbilled. Each model task is claimed by at most one clause, best
// overlap first. Hours come from the attorney's own allocation when the
// narrative carried one, otherwise from the matched task.
//
// Deliberately NOT done here: forcing the attorney's capitalisation back onto
// the model's text. He writes shorthand with erratic capitals ("rev Lease and
// easement"), so his casing is not an authority to restore — the model
// lowercasing it to "review and analyze lease and easement" is the correct
// answer, and a restore rule would put the typos into the bill.

const STOP = new Set(['a', 'an', 'and', 'the', 'to', 'of', 'for', 'with', 'in', 'on', 're']);

function words(text) {
  return String(text || '').toLowerCase().match(/[a-z0-9]+/g) || [];
}

function overlap(a, b) {
  const setB = new Set(words(b).filter((w) => !STOP.has(w)));
  if (setB.size === 0) return 0;
  let hits = 0;
  for (const w of new Set(words(a).filter((x) => !STOP.has(x)))) if (setB.has(w)) hits += 1;
  return hits;
}

export function alignTasksToClauses(clauses, tasks) {
  const list = clauses || [];
  const pool = (tasks || []).map((t, i) => ({ t, i, taken: false }));

  // Every (clause, task) pair scored once, then claimed strongest-first so a
  // near-duplicate clause can't steal the task its twin matches better.
  const pairs = [];
  list.forEach((c, ci) => {
    pool.forEach((p) => {
      const score = overlap(c.fragment, p.t.fragment);
      if (score > 0) pairs.push({ ci, pi: p.i, score });
    });
  });
  pairs.sort((a, b) => b.score - a.score || a.ci - b.ci || a.pi - b.pi);

  const matched = new Array(list.length).fill(null);
  for (const { ci, pi } of pairs) {
    if (matched[ci] || pool[pi].taken) continue;
    matched[ci] = pool[pi].t;
    pool[pi].taken = true;
  }

  return list.map((c, ci) => ({
    task_code: (matched[ci] && matched[ci].task_code) || '',
    fragment: matched[ci] && cleanFragment(matched[ci].fragment)
      ? matched[ci].fragment
      : c.fragment,
    hours: c.duration != null ? c.duration
      : (matched[ci] && matched[ci].hours != null ? matched[ci].hours : null),
  }));
}

// ---------- formatSuggestion ----------

export function formatSuggestion(text) {
  let t = String(text || '').trim();
  if (!t) return t;
  t = t.charAt(0).toUpperCase() + t.slice(1);
  if (!/[.!?]$/.test(t)) t += '.';
  return t;
}
