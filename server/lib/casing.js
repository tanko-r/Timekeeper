// Restore the attorney's own capitalisation to model output.
//
// 2026-08-11 feedback: "Expand → split into tasks … makes all uppercase words
// lowercase." The /ai/expand format contract asks for fragments that START
// lowercase (the narrative capitalises the leading clause itself), and
// llama3.1:8b applies that instruction to the whole clause — "E. Hodgson"
// comes back "e hodgson", "Second Amendment to Option Agreement" comes back
// "second amendment to option agreement". A prompt rule is the wrong tool
// here: the correct casing is already sitting in the attorney's text, so this
// puts it back deterministically after the model has spoken.
//
// Conservative by construction. A word is restored only when the source
// spells it ONE way, that spelling carries a capital, and the capital is not
// merely a side effect of the word starting a sentence.

// A word-ish run: a letter, then letters/digits/'/’/&/-, with an optional
// trailing period so an initial ("E.") stays one token.
const WORD = /[A-Za-z][A-Za-z0-9'’&-]*\.?/g;

// Everyday lowercase words whose capitalised form in the source is almost
// always positional or emphatic rather than a real proper noun. Restoring
// these turns "review the Lease" into noise.
const STOPWORDS = new Set([
  'a', 'an', 'and', 'as', 'at', 'by', 'for', 'from', 'in', 'of', 'on', 'or',
  'per', 're', 'the', 'to', 'via', 'with',
]);

function keyOf(token) {
  return token.toLowerCase().replace(/[^a-z0-9]/g, '');
}

// The spelling worth remembering. A trailing period is kept only for a single
// letter — that is an initial ("E."), not the end of a sentence.
function canonical(token) {
  const m = /^([A-Za-z][A-Za-z0-9'’&-]*)(\.?)$/.exec(token);
  if (!m) return null;
  return m[1] + (m[2] && m[1].length === 1 ? '.' : '');
}

// True when the match at `index` opens a sentence, so its capital says
// nothing about how the word is normally written. The period of an initial
// ("E. Hodgson", "J. Larson") is NOT a sentence end — read that way it hid
// every surname in the app from this map, which is the exact case the
// feedback was about.
function opensSentence(text, index) {
  for (let i = index - 1; i >= 0; i--) {
    const c = text[i];
    if (/\s/.test(c)) continue;
    if (c === '"' || c === "'" || c === '(' || c === '“' || c === '‘') continue;
    if (c === '!' || c === '?') return true;
    if (c !== '.') return false;
    // A lone letter before the period makes it an initial, not a full stop.
    const before = text.slice(0, i);
    return !/(?:^|[\s("'“‘])[A-Za-z]$/.test(before);
  }
  return true; // nothing but whitespace before it — start of the text
}

// key → the one capitalised spelling the source uses, for keys the source is
// unambiguous about.
export function sourceCasingMap(source) {
  const src = String(source || '');
  const spellings = new Map(); // key → Set of canonical spellings seen
  for (const m of src.matchAll(WORD)) {
    if (opensSentence(src, m.index)) continue;
    const spelling = canonical(m[0]);
    if (!spelling) continue;
    const key = keyOf(spelling);
    if (!key || STOPWORDS.has(key)) continue;
    if (!spellings.has(key)) spellings.set(key, new Set());
    spellings.get(key).add(spelling);
  }
  const map = new Map();
  for (const [key, set] of spellings) {
    if (set.size !== 1) continue; // the source can't make up its mind — leave it
    const [spelling] = set;
    if (!/[A-Z]/.test(spelling)) continue; // nothing to restore
    map.set(key, spelling);
  }
  return map;
}

export function restoreSourceCasing(text, source) {
  const out = String(text || '');
  if (!out) return '';
  const map = sourceCasingMap(source);
  if (map.size === 0) return out;

  let first = true;
  return out.replace(WORD, (token) => {
    // The leading word stays exactly as the model wrote it: fragments are
    // lowercase-first by contract, and restoring there would fight the rule.
    if (first) { first = false; return token; }
    const spelling = canonical(token);
    if (!spelling) return token;
    const want = map.get(keyOf(spelling));
    if (!want || want === spelling) return token;
    // The model's own trailing period (end of a sentence) is not the source's
    // to take away.
    const trailing = token.endsWith('.') && !want.endsWith('.') && spelling.length > 1 ? '.' : '';
    return want + trailing;
  });
}
