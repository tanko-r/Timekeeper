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

export function isUsableExemplar(text) {
  const t = cleanCandidate(text);
  if (!t.endsWith('.')) return false;
  if (DANGLING.test(t)) return false;
  const words = t.split(/\s+/).length;
  return words >= MIN_WORDS && words <= MAX_WORDS;
}

// Even spread across the length range, so the model learns that entries vary
// from one clause to several — sampling by recency alone would teach whatever
// length happened to be recent.
export function pickExemplars(candidates, { count = 6 } = {}) {
  const usable = [...new Set(
    (candidates || []).map(cleanCandidate).filter(isUsableExemplar))]
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
    const key = `${cleanCandidate(p.brief).toLowerCase()}|${cleanCandidate(p.narrative).toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    real.push(p);
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

export function renderGlossary(rows) {
  const list = (rows || [])
    .filter((r) => r && r.abbrev && r.phrase)
    .slice(0, GLOSSARY_LIMIT)
    .map((r) => `${r.abbrev} = ${r.phrase}`);
  return list.length ? list.join('\n') : '';
}
