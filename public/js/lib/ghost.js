// Ghost-text completion engine (spec §6; second tier added 2026-08-30):
// deterministic, from the matter's phrasebook and its entity dictionary —
// NEVER an LLM. Pure and dependency-free so the same ES module runs in the
// browser (no-build) and under node:test (test/ghost.test.js).
//
// TIER 1 completes a whole ranked PHRASE from the start of the clause. That is
// the proven behaviour and it always gets first refusal.
// TIER 2 completes a THING mid-clause — the documents, organisations and
// people this matter has seen — because "review and analyze " is not the start
// of any stored phrase and never will be.
//
// The "segment" being completed is the text after the last sentence break
// (. ; :) — narratives are chains of clauses, and each clause completes
// independently. Returns the remainder to append, or null.

const SEGMENT_BREAK = /[.;:]/;

// "A. Turner" is one name, not the end of a sentence. A full stop directly
// after a lone letter is an initial, so it must not cut the clause — tier 2
// completes names that CONTAIN initials, and cutting there loses both the
// half-typed name and the trigger word that justified offering one.
function isClauseBreak(text, i) {
  if (!SEGMENT_BREAK.test(text[i])) return false;
  if (text[i] !== '.') return true;
  const prev = text[i - 1];
  if (!prev || !/[A-Za-z]/.test(prev)) return true;
  const before = text[i - 2];
  return !(before === undefined || /\s/.test(before));
}

// After a space, a guess needs a reason. These are the words that give one.
// The person set is deliberately the connector vocabulary server/lib/people.js
// uses to FIND names, so what the app learned from is what it predicts into.
const PERSON_TRIGGERS = new Set(['with', 'to', 'from']);
const ENTITY_TRIGGERS = new Set([
  'regarding', 're', 'about', 'concerning', 'of', 'on',
  'review', 'reviewed', 'analyze', 'analyzed', 'revise', 'revised', 'draft',
  'drafted', 'prepare', 'prepared', 'negotiate', 'negotiated', 'execute',
  'executed', 'circulate', 'circulated', 'update', 'updated', 'finalize',
  'finalized', 'comment',
]);

// ghostMatch returns the full match — { text, prefixFix } — or null.
//   text        the remainder to append, exactly as ghostCompletion always
//               returned it
//   prefixFix   null, or { length, text }: the caller mistyped the case of
//               `length` characters just before the caret, and correcting
//               them to `text` makes the typed part match the candidate's
//               real casing (e.g. typed "s" of a person named "S. Minhas").
//               Tier 1 (the phrasebook) never sets this — its casing
//               contract is deliberately "typed part stays exactly as
//               typed" (see the case-insensitive test above). It exists
//               only for tier 2, where the candidate is a proper noun.
export function ghostMatch(value, caret, phrases, {
  minChars = 2, entities = [], people = [],
} = {}) {
  const text = String(value ?? '');
  if (caret !== text.length || text.length === 0) return null; // only complete at the end
  let cut = -1;
  for (let i = text.length - 1; i >= 0; i--) {
    if (isClauseBreak(text, i)) { cut = i; break; }
  }
  const seg = text.slice(cut + 1).replace(/^\s+/, '');

  // ── tier 1: the phrasebook, unchanged ──────────────────────────────────
  if (seg.length >= minChars) {
    const low = seg.toLowerCase();
    for (const p of phrases || []) {
      const phrase = String(p);
      const pl = phrase.toLowerCase();
      if (pl.length > low.length && pl.startsWith(low)) {
        return { text: phrase.slice(seg.length), prefixFix: null };
      }
    }
  }

  // ── tier 2: an entity, a person, or the chain ──────────────────────────
  return entityMatch(seg, text, entities || [], people || []);
}

// Back-compat convenience for callers that only ever wanted the remainder
// (tests, and any future plain-string use) — same contract as before.
export function ghostCompletion(value, caret, phrases, opts) {
  const m = ghostMatch(value, caret, phrases, opts);
  return m ? m.text : null;
}

const nameOf = (x) => String((x && x.name) || x || '');
const already = (text, name) => text.toLowerCase().includes(name.toLowerCase());
const noFix = (text) => (text ? { text, prefixFix: null } : null);

function entityMatch(seg, text, entities, people) {
  const docsAndOrgs = entities.map(nameOf);
  const persons = people.map(nameOf);

  // Mid-word: the attorney is typing the thing's name. No trigger needed —
  // a part-typed word is its own evidence.
  if (seg && !/\s$/.test(seg)) {
    return prefixHit(seg, [...docsAndOrgs, ...persons]);
  }

  const words = seg.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  const last = words[words.length - 1].replace(/[^A-Za-z,]/g, '').toLowerCase();
  const lastRaw = words[words.length - 1];

  // "call with A. Turner and " / "…, " — another person in the same list
  const isListJoin = last === 'and' || /,$/.test(lastRaw);
  const clauseHasPersonTrigger = words.some(
    (w) => PERSON_TRIGGERS.has(w.replace(/[^A-Za-z]/g, '').toLowerCase()));
  if (isListJoin && clauseHasPersonTrigger) return noFix(firstUnused(persons, text));

  if (PERSON_TRIGGERS.has(last)) return noFix(firstUnused(persons, text));
  if (ENTITY_TRIGGERS.has(last)) return noFix(firstUnused(docsAndOrgs, text));

  // The chain: a name has been accepted, the clause names no document yet.
  // Documents only — "email with M. Smith regarding Cedar Utility" reads wrong.
  if (clauseHasPersonTrigger && persons.some((n) => already(seg, n))) {
    const docs = entities.filter((e) => e && e.kind === 'document').map(nameOf);
    const next = firstUnused(docs, text);
    return next ? { text: `regarding ${next}`, prefixFix: null } : null;
  }
  return null;
}

// The longest typed word-prefix that starts one of the names, matched at a
// word boundary so "…analyze Devel" completes but "…analyzeDevel" does not.
// A single typed character is enough: the ghost was already showing the
// whole name before the attorney typed anything (the trigger-word branch
// above), so requiring more than one character here would make it go dark
// for a keystroke before picking back up.
const PREFIX_MIN_CHARS = 1;

function prefixHit(seg, names) {
  const starts = [0];
  for (let i = 0; i < seg.length; i++) if (/\s/.test(seg[i])) starts.push(i + 1);
  for (const pos of starts) {
    const typed = seg.slice(pos);
    if (typed.length < PREFIX_MIN_CHARS) continue;
    const low = typed.toLowerCase();
    for (const name of names) {
      const nl = name.toLowerCase();
      if (nl.length > low.length && nl.startsWith(low)) {
        const correct = name.slice(0, typed.length);
        const prefixFix = correct === typed ? null : { length: typed.length, text: correct };
        return { text: name.slice(typed.length), prefixFix };
      }
    }
  }
  return null;
}

function firstUnused(names, text) {
  for (const name of names) if (!already(text, name)) return name;
  return null;
}
