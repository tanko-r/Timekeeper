// Deterministic document / organisation extraction from narrative text
// (spec 2026-08-30). The sibling of server/lib/people.js: pure functions
// only, no DB, no clock. The matter_entities cache that stores these lives in
// server/routes/entries.js (rebuildMatterMemory).
//
// Measured on the live database before this was written: a plain
// capitalised-run regex already recovers the real document names, and fails in
// exactly two ways — a verb glued to its object ("Prepare Closing Binder") and
// two organisations joined by "and" ("Acme and Cedar Utility"). The head-noun
// test below is what tells those two cases apart, so both rules can apply
// without fighting each other.
import { stripMatterTag } from './exemplars.js';
import { extractPeople } from './people.js';

// A capitalised run ENDING in one of these is a document, and an "and" inside
// it belongs to the name. Anything else is an organisation, and an "and"
// inside it joins two of them. Extend freely — a document type missing here is
// degraded, not broken: it still predicts, just filed as an organisation.
const HEAD_NOUNS = new Set([
  'agreement', 'agreements', 'amendment', 'amendments', 'lease', 'leases',
  'easement', 'easements', 'deed', 'deeds', 'contract', 'contracts',
  'memorandum', 'letter', 'letters', 'intent', 'survey', 'surveys', 'plat',
  'plats', 'binder', 'addendum', 'assignment', 'consent', 'notice', 'report',
  'reports', 'schedule', 'exhibit', 'ordinance', 'resolution', 'permit',
  'application', 'order', 'opinion', 'certificate', 'policy', 'commitment',
  'abstract', 'sheet', 'estoppel', 'affidavit', 'declaration', 'covenant',
  'covenants', 'plan', 'plans', 'addenda', 'amendments', 'entry', 'review',
]);

// A narrative starts with a verb, and the verb is capitalised because it
// starts the sentence — not because it is part of the thing's name.
const LEAD_VERBS = new Set([
  'draft', 'drafted', 'review', 'reviewed', 'revise', 'revised', 'prepare',
  'prepared', 'analyze', 'analyzed', 'analyse', 'analysed', 'negotiate',
  'negotiated', 'attend', 'attended', 'execute', 'executed', 'circulate',
  'circulated', 'update', 'updated', 'finalize', 'finalized', 'research',
  'researched', 'call', 'email', 'emails', 'emailed', 'compose', 'composed',
  'confirm', 'confirmed', 'conduct', 'conducted', 'create', 'created',
  'follow', 'followed', 'discuss', 'discussed', 'correspond', 'corresponded',
]);

// Lowercase words that may sit INSIDE a name without ending it.
const JOINERS = new Set(['of', 'and', 'the', 'to', 'for']);

const MAX_RUN = 5;
const ACRONYM = /^[A-Z]{2,}$/;

const isCapitalised = (w) => /^[A-Z]/.test(w);
const bareWord = (w) => w.replace(/^[^A-Za-z]+/, '').replace(/[^A-Za-z'’-]+$/, '');

export function extractEntities(text) {
  const clean = stripMatterTag(String(text ?? '').replace(/\s+/g, ' ').trim());
  if (!clean) return [];
  // Whatever people.js claims is a person is not ours to file. Doing this once
  // for the whole text (rather than per clause) is deliberate: the trigger
  // that identifies a name can sit in a different clause from the name.
  const people = new Set(extractPeople(clean).map((n) => n.toLowerCase()));
  const out = [];
  const seen = new Set();
  for (const clause of clean.split(/[.;:]/)) {
    for (const cand of clauseRuns(clause)) {
      for (const entity of classify(cand, people)) {
        const key = `${entity.kind}|${entity.name.toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(entity);
      }
    }
  }
  return out;
}

// Every maximal run of capitalised words in one clause, joiners allowed
// inside. `atStart` records whether the run opened the clause, because a
// capital there is grammar rather than evidence.
function clauseRuns(clause) {
  const words = clause.trim().split(/\s+/).filter(Boolean);
  const bare = words.map(bareWord);
  // A comma ends a run: "A. Turner, M. Smith" is two things, not one.
  const breaks = words.map((w) => /[,]/.test(w));
  const runs = [];
  let i = 0;
  while (i < words.length) {
    if (!bare[i] || !isCapitalised(bare[i])) { i += 1; continue; }
    const start = i;
    const run = [bare[i]];
    // MAX_RUN counts CAPITALISED words only. Counting the whole run would let
    // a lead verb and a joiner eat two of the five slots, truncating
    // "Circulate the Purchase and Sale Agreement" before its head noun.
    let caps = 1;
    let j = i + 1;
    if (breaks[i]) { runs.push({ run, atStart: start === 0 }); i = j; continue; }
    while (j < words.length && caps < MAX_RUN) {
      if (bare[j] && isCapitalised(bare[j])) {
        run.push(bare[j]);
        caps += 1;
        j += 1;
        if (breaks[j - 1]) break;
        continue;
      }
      // a joiner only survives if a capitalised word follows it
      if (JOINERS.has((bare[j] || '').toLowerCase())
        && j + 1 < words.length && bare[j + 1] && isCapitalised(bare[j + 1])) {
        run.push(bare[j].toLowerCase());
        j += 1;
        continue;
      }
      break;
    }
    runs.push({ run, atStart: start === 0 });
    i = Math.max(j, i + 1);
  }
  return runs;
}

// Joiners belong INSIDE a name, never at either edge. The leading trim
// matters because stripping the lead verb exposes one: "Revise the Agreement"
// leaves "the Agreement", which is a head noun with a determiner, not a name.
function trimJoiners(words) {
  const out = words.slice();
  while (out.length && JOINERS.has(out[out.length - 1].toLowerCase())) out.pop();
  while (out.length && JOINERS.has(out[0].toLowerCase())) out.shift();
  return out;
}

function classify({ run, atStart }, people) {
  let words = run;
  if (words.length && LEAD_VERBS.has(words[0].toLowerCase())) {
    words = words.slice(1);
  } else if (words.length > 1 && words[1].toLowerCase() === 'the') {
    // LEAD_VERBS can never be complete — "Recirculate the Access Agreement"
    // was captured whole until this rule existed. English does not put a
    // determiner inside a noun phrase, so a capitalised word sitting directly
    // in front of "the" is a verb, whatever the list happens to know.
    words = words.slice(1);
  }
  words = trimJoiners(words);
  if (!words.length) return [];
  // A single letter is an initial, so the run is somebody's name that
  // extractPeople did not claim (a trigger it does not know). Never a thing.
  if (words.some((w) => w.length === 1)) return [];

  const last = words[words.length - 1].toLowerCase();
  if (HEAD_NOUNS.has(last)) {
    // "the Agreement" names nothing — a document needs a qualifier.
    if (words.length < 2) return [];
    const name = words.join(' ');
    return people.has(name.toLowerCase()) ? [] : [{ name, kind: 'document' }];
  }

  // organisation: "and" joins two of them
  const parts = [];
  let current = [];
  for (const w of words) {
    if (w.toLowerCase() === 'and') {
      if (current.length) parts.push(current);
      current = [];
      continue;
    }
    current.push(w);
  }
  if (current.length) parts.push(current);

  const out = [];
  parts.forEach((part, idx) => {
    const kept = trimJoiners(part.filter((w) => !JOINERS.has(w.toLowerCase())));
    if (!kept.length) return;
    // Only the FIRST part can be the clause opener, and only a lone opening
    // word is suspect — "Analysis of title" must not become an organisation.
    if (kept.length === 1 && atStart && idx === 0 && !ACRONYM.test(kept[0])) return;
    const name = kept.join(' ');
    if (people.has(name.toLowerCase())) return;
    out.push({ name, kind: 'org' });
  });
  return out;
}

const DAY_MS = 86_400_000;
// A derived row must be seen twice before it predicts, so a one-off typo never
// becomes a suggestion. A row the attorney typed himself is wanted from the
// moment he types it, so the floor does not apply to it.
const MIN_USES = 2;

// Frequency × recency, the phrasebook's decay so the two tiers age at the same
// rate. rankPhrases decays each sighting separately; this table stores only a
// count and a last date, so this is that shape approximated. Accepted (spec):
// entities are ranked against each other, never against phrases.
export function rankEntities(rows, {
  today, halfLifeDays = 30, minUses = MIN_USES, limit = 20,
} = {}) {
  const todayMs = Date.parse(`${today}T00:00:00Z`);
  return (rows || [])
    .filter((r) => r && !r.hidden)
    .filter((r) => r.origin === 'manual' || (r.count || 0) >= minUses)
    .map((r) => {
      // No date = a hand-typed row that has never been seen in an entry. Score
      // it as a single fully-decayed sighting: present, but under anything the
      // matter actually used.
      const ageDays = r.last_seen_at
        ? Math.max(0, (todayMs - Date.parse(`${r.last_seen_at}T00:00:00Z`)) / DAY_MS)
        : Infinity;
      const decay = ageDays === Infinity ? 0 : Math.pow(0.5, ageDays / halfLifeDays);
      const score = Math.max(0, r.count || 0) * decay;
      return { ...r, score: Math.round(score * 1000) / 1000 };
    })
    .sort((a, b) => b.score - a.score
      || (b.count || 0) - (a.count || 0)
      || a.name.localeCompare(b.name))
    .slice(0, limit);
}
