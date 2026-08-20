// Style exemplars and few-shot pairs for the narrative prompt (spec
// 2026-08-01 §2/§4). Pure functions over rows — callers do the SQL.
//
// Why this module exists: an 8B model imitates in-context examples far more
// strongly than it obeys prose rules. The measured fix for verbose, invented
// narratives was not a better rulebook but better examples — David's own
// entries, filtered for quality. These helpers are that filter.

const MIN_WORDS = 6;
const MAX_WORDS = 40;
const GLOSSARY_LIMIT = 40;
// Teaching material must be EXEMPLARY, not merely typical. The house median is
// 11 words and p90 is 29. A gate at 20 was previously chosen to sit well below
// p90 after a 23-word entry taught the model to copy its padding
// ("...conveying revised document for review"). Raised to 37 on 2026-08-18
// (David's call, made with that history in view) so multi-clause pairs up to
// that length — e.g. the 37-word Corvex entry — can teach. Watch for filler
// creeping back into the eval if this proves too high.
const TEACH_MAX_WORDS = 37;
// Ratio below which an "edit" is really just a nudge, leaving the text the
// model's. Measured separation: a typo fix scores ~0.08, a genuine reword ~0.33.
// model's rather than the attorney's.
const REWRITE_THRESHOLD = 0.25;

// Register markers, not a banned-word list for the prompt — these NEVER go
// into the prompt (naming a phrase there makes a small model emit it). They
// describe WHY work was done or restate a category instead of naming a thing,
// which is the filler that must not be taught back. Shared with
// scripts/ai-eval.mjs so the teaching bar and the eval bar cannot drift.
export const FILLER_MARKERS = [
  /\bin order to\b/i, /\bto ensure\b/i, /\bfor review and approval\b/i,
  /\bwith a view to\b/i, /\bas necessary\b/i, /\bas appropriate\b/i,
  /\bvarious matters\b/i, /\bfor the purpose of\b/i,
  /\bor other electronic means\b/i, /\bwith respect to the foregoing\b/i,
  /\bto discuss (?:outstanding|same|next)\b/i, /\bkey considerations\b/i,
  /\bcourse of action\b/i, /\bnext steps and\b/i,
  /\bto reflect (?:latest|the latest)\b/i, /\band completeness\b/i,
];

// A leading matter tag — "(MTR09 – Cedar Lease) …" or "[MTR09] …" — is display
// furniture from the import, and "(0.3)" allocations are recorded separately
// from the prose. Neither may be taught to the model: the format contract
// explicitly forbids it emitting parentheticals.
const MATTER_TAG = /^\s*[[(][^\])]*[\])]\s*/;
const TIME_ALLOCATION = /\s*\(\s*\d+(?:\.\d+)?\s*\)/g;

export function cleanCandidate(text) {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(MATTER_TAG, '')
    .replace(TIME_ALLOCATION, '')
    .trim();
}

// Guards the exemplar pool against entries that would teach the wrong thing.
// The dangling-connector case is a real bug from the design prototype: it
// learned from "…from R. Calder regarding;" and started emitting the same
// truncation.
const DANGLING = /\b(regarding|with|to|and|for|of|from|per|re)\s*[;.,]/i;

// Well-formed = a finished thought. Narratives autosave 600ms after typing
// stops, so half-edited text reaches the database routinely; this is what
// separates it from a real narrative.
export function isWellFormedNarrative(text) {
  const t = cleanCandidate(text);
  if (!t.endsWith('.')) return false;
  if (DANGLING.test(t)) return false;
  return t.split(/\s+/).length <= MAX_WORDS;
}

// An exemplar additionally has to be long enough to TEACH register — a
// four-word entry is well-formed but shows the model nothing about rhythm.
// Few-shot pairs deliberately skip that floor: a short, correct narrative is
// among the best outputs to demonstrate.
export function isUsableExemplar(text) {
  if (!isWellFormedNarrative(text)) return false;
  return cleanCandidate(text).split(/\s+/).length >= MIN_WORDS;
}

// Whether text is fit to TEACH from, as opposed to merely well-formed. Three
// days of live use (2026-08-04) proved well-formedness is not enough: lightly
// edited model output is perfectly well-formed and dragged the median from 11
// words to 18. This is the same bar scripts/ai-eval.mjs enforces on output —
// never demonstrate something that would fail the eval.
export function looksLikeHouseVoice(text) {
  const t = cleanCandidate(text);
  if (!t) return false;
  if (t.split(/\s+/).length > TEACH_MAX_WORDS) return false;
  return !FILLER_MARKERS.some((re) => re.test(t));
}

// How much of the final text is the attorney's rather than the model's.
// Returns 1 when there is no model draft to compare against (hand-typed, or
// predating ai_draft), so absent history never disqualifies an entry.
export function rewriteRatio(narrative, aiDraft) {
  const n = cleanCandidate(narrative).toLowerCase();
  const d = cleanCandidate(aiDraft || '').toLowerCase();
  if (!d || !n) return 1;
  const nt = n.match(/[a-z]{2,}/g) || [];
  const dt = new Set(d.match(/[a-z]{2,}/g) || []);
  if (!nt.length) return 1;
  const fresh = nt.filter((w) => !dt.has(w)).length;
  const lengthShift = Math.abs(nt.length - dt.size) / Math.max(nt.length, dt.size, 1);
  return Math.max(fresh / nt.length, lengthShift);
}

// Even spread across the length range, so the model learns that entries vary
// from one clause to several — sampling by recency alone would teach whatever
// length happened to be recent.
export function pickExemplars(candidates, { count = 6 } = {}) {
  const usable = [...new Set(
    (candidates || []).map(cleanCandidate)
      .filter((t) => isUsableExemplar(t) && looksLikeHouseVoice(t)))]
    .sort((a, b) => a.split(/\s+/).length - b.split(/\s+/).length);
  if (usable.length <= count) return usable;
  const out = [];
  for (let i = 0; i < count; i++) {
    out.push(usable[Math.floor((i + 0.5) * usable.length / count)]);
  }
  return [...new Set(out)];
}

// ── few-shot pairs ────────────────────────────────────────────────────────

const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'to', 'of', 'for', 'with',
  'w', 're', 'per', 'in', 'on', 'at', 'same', 'their', 'my', 'our']);

function tokens(s) {
  return new Set(String(s || '').toLowerCase().match(/[a-z]{2,}/g)?.filter((t) => !STOP.has(t)) || []);
}

function overlap(a, b) {
  let n = 0;
  for (const t of a) if (b.has(t)) n++;
  return n;
}

// An "echo" pair — brief already reads as the finished narrative — carries no
// lesson, and teaching the model that input sometimes equals output invites it
// to hand the shorthand straight back.
function isEcho(brief, narrative) {
  const b = cleanCandidate(brief).toLowerCase().replace(/[^a-z0-9 ]/g, '');
  const n = cleanCandidate(narrative).toLowerCase().replace(/[^a-z0-9 ]/g, '');
  if (!b || !n) return true;
  if (b === n) return true;
  const bt = tokens(b);
  const nt = tokens(n);
  if (!bt.size || !nt.size) return true;
  // Near-identical: the brief covers nearly all of the narrative's content
  // words and is not meaningfully shorter.
  return overlap(bt, nt) / nt.size >= 0.9 && bt.size >= nt.size * 0.9;
}

// Fixed slot count over a growing pool (spec §4). Prompt tokens are processed
// before generation starts, so slots stay constant and only the pool grows;
// selection quality is what improves over time. Seeds are hand-authored
// bootstrap pairs and are only used to top up a thin pool.
export function pickPairs(pool, seeds = [], { count = 6, cmId = null, brief = '' } = {}) {
  const wanted = tokens(brief);
  const seen = new Set();
  const real = [];
  for (const p of pool || []) {
    if (!p || isEcho(p.brief, p.narrative)) continue;
    // Narratives autosave 600ms after typing stops, so a pause mid-correction
    // persists half-edited text and makes it pool-eligible immediately. A pair
    // teaches what good OUTPUT looks like, so its narrative side has to clear
    // the same bar as an exemplar or it would teach truncation.
    if (!isWellFormedNarrative(p.narrative)) continue;
    // A pair demonstrates good OUTPUT. Filler or over-long text here teaches
    // the model to produce it.
    if (!looksLikeHouseVoice(p.narrative)) continue;
    // A nudge is not a correction: if the final text is still mostly the
    // model's draft, it is the model's voice wearing David's flag.
    if (rewriteRatio(p.narrative, p.ai_draft) < REWRITE_THRESHOLD) continue;
    const narrative = cleanCandidate(p.narrative);
    const key = `${cleanCandidate(p.brief).toLowerCase()}|${narrative.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // Emit CLEANED text — matter tags and (0.4) allocations reaching the
    // few-shot would demonstrate exactly what the format contract forbids.
    real.push({ ...p, brief: cleanCandidate(p.brief), narrative });
  }

  real.sort((a, b) => {
    const matter = (cmId != null && b.cm_id === cmId) - (cmId != null && a.cm_id === cmId);
    if (matter) return matter;
    const rel = overlap(tokens(b.brief), wanted) - overlap(tokens(a.brief), wanted);
    if (rel) return rel;
    return String(b.date || '').localeCompare(String(a.date || ''));
  });

  // Spread across work types so six "review" examples don't crowd out calls
  // and drafting — the lead verb is a good enough proxy.
  const chosen = [];
  const verbs = new Set();
  for (const pass of [1, 2]) {
    for (const p of real) {
      if (chosen.length >= count) break;
      if (chosen.includes(p)) continue;
      const verb = (String(p.brief).toLowerCase().match(/[a-z]+/) || [''])[0];
      if (pass === 1 && verbs.has(verb)) continue;
      verbs.add(verb);
      chosen.push(p);
    }
  }

  for (const s of seeds || []) {
    if (chosen.length >= count) break;
    if (isEcho(s.brief, s.narrative)) continue;
    chosen.push(s);
  }
  return chosen;
}

// An ARROW, not an equals sign (2026-08-06 feedback). "ah = A. Hessburg" is a
// symmetric claim, and an 8B model asked to shorten a narrative will happily
// read it right-to-left and put the shorthand back into finished prose. The
// arrow, and the heading the caller wraps it in, both point one way: shorthand
// in, full wording out.
export function renderGlossary(rows) {
  const list = (rows || [])
    .filter((r) => r && r.abbrev && r.phrase)
    .slice(0, GLOSSARY_LIMIT)
    .map((r) => `${r.abbrev} → ${r.phrase}`);
  return list.length ? list.join('\n') : '';
}
