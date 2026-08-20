// Deterministic counterparty-name extraction from narrative text (spec §5):
// "telephone conference with M. Smith", "email to John Doe", ...
// Pure functions only — no DB access, no clock. The matter_people cache that
// stores these lives in server/routes/entries.js (rebuildMatterPeople).

// Roles are not people: a capture whose lowercased form is one of these is
// dropped ("Opposing Counsel" describes a role, not a rosterable person).
const GENERIC_ROLES = new Set([
  'opposing counsel', 'counsel', 'co-counsel', 'client', 'clients',
  'opposing', 'counterparty', 'all parties', 'parties', 'team', 'staff',
  'lender', 'borrower', 'landlord', 'tenant', 'seller', 'buyer', 'broker',
  'title company', 'escrow', 'county', 'city', 'the county', 'the city',
]);

// Connector tokens end a name capture ("John Smith Re Draft" → "John Smith").
// Also includes the trigger vocabulary itself (conference, call, email, ...)
// plus a couple of common narrative verbs (reviewed, drafted): callers join
// narrative + fragments across entries with plain newlines and no terminal
// punctuation, and NAME's \s+ separator matches across those newlines, so
// without this a name capture can otherwise bleed into the next clause
// ("John Smith\n\nEmail to Mary Jones" → "John Smith Email"; "John Smith
// Reviewed the draft" → "John Smith Reviewed").
const CUT_WORDS = new Set([
  're', 'regarding', 'about', 'concerning', 'and', 'for', 'on',
  'conference', 'conferences', 'call', 'calls', 'meeting', 'meetings', 'meet',
  'confer', 'discussion', 'discussions', 'correspondence', 'correspond',
  'zoom', 'negotiation', 'negotiations', 'negotiate', 'spoke', 'speak',
  'email', 'emails', 'e-mail', 'e-mails', 'letter', 'letters', 'memo', 'memos',
  'voicemail', 'voicemails', 'message', 'messages',
  'reviewed', 'drafted',
]);

// Trigger phrases that introduce a counterparty. Two families:
//   <meeting word> with X     (telephone conference with, call with, ...)
//   <writing word> to/from X  (email to, letter from, ...)
const TRIGGERS = /\b(?:(?:(?:telephone|video|phone)\s+)?(?:conference|conferences|call|calls|meeting|meetings|meet|confer|discussion|discussions|correspondence|correspond|zoom|negotiation|negotiations|negotiate|spoke|speak)\s+with|(?:e-?mail|e-?mails|letter|letters|memo|memos|voicemail|voicemails|message|messages|correspondence)\s+(?:to|from))\s+/gi;

// A name: optional courtesy title (consumed, not captured), then 1–4
// capitalized tokens; single-letter initials keep their period ("M. Smith").
// \w never matches "." or ",", so trailing sentence punctuation is excluded.
const NAME = /^(?:(?:Mr|Ms|Mrs|Dr)\.?\s+)?((?:[A-Z]\.|[A-Z][\w'’-]+)(?:\s+(?:[A-Z]\.|[A-Z][\w'’-]+)){0,3})/;

const POSSESSIVE = /['’]s$/i;
const SINGLE_INITIAL = /^[A-Z]\.$/;

export function extractPeople(text) {
  const s = String(text ?? '');
  const found = [];
  const seen = new Set();
  TRIGGERS.lastIndex = 0; // module-level /g regex is stateful — always reset
  let m;
  while ((m = TRIGGERS.exec(s)) !== null) {
    let rest = s.slice(TRIGGERS.lastIndex);
    // one trigger can introduce a list: "with A. Foo, B. Bar and C. Baz"
    for (;;) {
      const nm = NAME.exec(rest);
      if (!nm) break;
      const name = cleanName(nm[1]);
      if (name) {
        const key = name.toLowerCase();
        if (!seen.has(key)) { seen.add(key); found.push(name); }
      }
      const after = rest.slice(nm[0].length);
      const joiner = /^(?:\s*,)?\s+and\s+/i.exec(after) || /^\s*,\s*/.exec(after);
      if (!joiner) break;
      rest = after.slice(joiner[0].length);
    }
  }
  return found;
}

function cleanName(raw) {
  let words = raw.trim().split(/\s+/);
  const cut = words.findIndex((w) => CUT_WORDS.has(w.toLowerCase()));
  if (cut !== -1) words = words.slice(0, cut);
  if (words.length === 0) return null;
  // "Sam's counsel" describes someone by relation — not a name
  if (words.some((w) => POSSESSIVE.test(w))) return null;
  // a bare initial ("call with M.") carries no identity
  if (words.length === 1 && SINGLE_INITIAL.test(words[0])) return null;
  const name = words.join(' ');
  if (GENERIC_ROLES.has(name.toLowerCase())) return null;
  return name;
}

// The narrative model invents initials. Measured 2026-08-18: given the note
// "pierce", with C. Pierce outside its context window, the fine-tuned model
// wrote "R. Pierce" through PyTorch and "J. Pierce" through Ollama — a real
// colleague, the wrong initial, stated with no hedging. Two of four sampled
// generations were wrong this way. On a fee bill that is worse than vagueness.
//
// The matter_people roster already holds the answer, so the roster decides and
// the model only proposes. Same shape as the de-identification pipeline: the
// database is authoritative, the model supplements it.
//
// roster is a list of canonical names ("C. Pierce"). Returns the corrected text
// plus what changed, so a caller can surface the corrections rather than apply
// them silently — a name quietly rewritten under an attorney is its own hazard.
export function correctInitials(text, roster) {
  const s = String(text ?? '');
  const bySurname = new Map();
  for (const raw of roster || []) {
    const m = INITIAL_SURNAME.exec(String(raw ?? '').trim());
    // First writer wins: a roster ordered by frequency puts the common
    // spelling first, and two people sharing a surname cannot be told apart
    // from a surname alone — so leave those to the human.
    if (m && !bySurname.has(m[2].toLowerCase())) bySurname.set(m[2].toLowerCase(), m[0]);
  }
  if (!s || bySurname.size === 0) return { text: s, fixes: [] };

  const fixes = [];
  // ONE pass with an optional initial group. Running an initial-fixer and then
  // a bare-surname-fixer turns "R. Pierce" into "C. C. Pierce", because the
  // second pass matches the surname the first just wrote.
  const out = s.replace(SURNAME_MAYBE_INITIAL, (whole, _initial, surname) => {
    const canonical = bySurname.get(surname.toLowerCase());
    if (!canonical || whole === canonical) return whole;
    fixes.push({ from: whole, to: canonical });
    return canonical;
  });
  return { text: out, fixes };
}

const INITIAL_SURNAME = /^([A-Z])\.\s*([A-Z][\w'’-]+)$/;
// Optional "X. " prefix, then a word. Case-insensitive on the surname so a
// model that writes "dimaggio" still resolves, but the roster spelling is what
// gets written back.
const SURNAME_MAYBE_INITIAL = /\b(?:([A-Za-z])\.\s*)?([A-Za-z][\w'’-]{2,})\b/g;
