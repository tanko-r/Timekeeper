import { rankMatters } from './matterSearch.js';

// Bill-from-a-sentence parser (spec §6, magic #1): one raw line —
// "call sam re loading dock lease .3" — into a proposed entry.
// Pure and deterministic; the LLM fallback for messy lines lives in the
// route (server/routes/quickcapture.js), never here.
//
// Grammar (all parts optional; `missing` reports what wasn't found):
//   <verb> [w/|with <Person…>] [re|re: <topic…>] [<duration>]
// - duration: ".3" "0.3" "1.25" (bare decimal ≤ 12) | "18m"/"90min" | "1h"/"1.5h"/"2hr(s)"
// - verb: first word, mapped to a task code (only if that code exists in
//   taskCodes); if unmapped the word is NOT consumed — it stays in the topic.
// - person: 1–2 tokens after w/ or with, stopped by re/end.
//   Exception: for Call/Conference-type verbs (call/called/tc/phone/meet/
//   meeting/conference/confer), a *bare* name — no w/|with marker — sitting
//   between the verb and a `re` marker is also read as the counterparty
//   (e.g. "call sam re ..." → person "Sam"). This only fires when a `re`
//   marker follows, so the boundary of the name is unambiguous; without a
//   `re` marker the bare word is left alone and falls into the topic, same
//   as any other verb.
// - topic: text after re/re: (minus the duration) — the full raw remainder,
//   used verbatim in the narrative; without re, the unconsumed remainder is
//   used instead.
// - matterQuery / matches: rankMatters uses AND semantics over whitespace
//   tokens, so a topic with a trailing abbreviation the matter data doesn't
//   spell out (e.g. "lease" vs. "Lease") would otherwise zero out an
//   otherwise-good match. matterQuery starts as the full topic and, if that
//   yields no matches, progressively drops trailing tokens and retries until
//   a match is found or nothing is left. `topic`/`narrative` always keep the
//   untrimmed text — only the search query is relaxed.
// - narrative stub by code: Call/Conference → "Telephone conference with P
//   regarding T"; Correspondence → "Correspondence with P regarding T";
//   otherwise "<Verb> T" (verb form = the mapped word, title-cased).

const VERB_MAP = new Map(Object.entries({
  call: 'Call/Conference', called: 'Call/Conference', tc: 'Call/Conference', phone: 'Call/Conference',
  meet: 'Call/Conference', meeting: 'Call/Conference', conference: 'Call/Conference', confer: 'Call/Conference',
  email: 'Correspondence', emailed: 'Correspondence', 'e-mail': 'Correspondence',
  corr: 'Correspondence', correspondence: 'Correspondence', letter: 'Correspondence',
  draft: 'Draft', drafted: 'Draft', prepare: 'Draft', prepared: 'Draft',
  revise: 'Revise', revised: 'Revise', edit: 'Revise', edited: 'Revise',
  review: 'Review', reviewed: 'Review', read: 'Review',
  research: 'Research', researched: 'Research',
  negotiate: 'Negotiate', negotiated: 'Negotiate',
  travel: 'Travel',
}));

const DUR_RE = /^(?:(\d*\.\d+|\d+(?:\.\d+)?)(h|hrs?|)|(\d+)(m|min))$/i;
const RE_MARKER = /^re:?$/i;
const WITH_MARKER = /^(w\/|with)$/i;

function parseDuration(token) {
  const m = DUR_RE.exec(token);
  if (!m) return null;
  if (m[3]) return Math.round((Number(m[3]) / 60) * 100) / 100; // minutes
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0 || n > 12) return null;
  if (!m[2] && !token.includes('.')) return null; // bare "3" is too ambiguous
  return n;
}

const titleCase = (w) => (w ? w[0].toUpperCase() + w.slice(1) : w);

// Progressively relax the matter query (drop trailing tokens) until
// rankMatters finds something, or nothing is left to try.
function resolveMatterQuery(topic, matters) {
  const tokens = topic.split(/\s+/).filter(Boolean);
  while (tokens.length) {
    const query = tokens.join(' ');
    const matches = rankMatters(query, matters, { limit: 3 });
    if (matches.length) return { matterQuery: query, matches };
    tokens.pop();
  }
  return { matterQuery: '', matches: [] };
}

export function parseQuickCapture(line, { matters = [], taskCodes = [] } = {}) {
  const tokens = String(line || '').trim().split(/\s+/).filter(Boolean);
  const codeSet = new Map(taskCodes.map((c) => [String(c).toLowerCase(), c]));

  // 1. duration: first parseable token anywhere, consumed
  let hours = null;
  for (let i = 0; i < tokens.length; i++) {
    const h = parseDuration(tokens[i]);
    if (h != null) { hours = h; tokens.splice(i, 1); break; }
  }

  // 2. verb: first word
  let task_code = null;
  let verbWord = null;
  if (tokens.length) {
    const mapped = VERB_MAP.get(tokens[0].toLowerCase());
    if (mapped && codeSet.has(mapped.toLowerCase())) {
      task_code = codeSet.get(mapped.toLowerCase());
      verbWord = tokens.shift();
    }
  }

  // 3. person: "w/ X [Y]" or "with X [Y]"
  let person = null;
  const wIdx = tokens.findIndex((t) => WITH_MARKER.test(t));
  if (wIdx !== -1) {
    const names = [];
    let j = wIdx + 1;
    while (j < tokens.length && names.length < 2 && !RE_MARKER.test(tokens[j])) { names.push(tokens[j]); j++; }
    if (names.length) {
      person = names.map(titleCase).join(' ');
      tokens.splice(wIdx, 1 + names.length);
    }
  }

  // 3b. bare-name counterparty for Call/Conference-type verbs: a name
  // sitting between the verb and "re" with no w/|with marker at all
  // ("call sam re ..." → person "Sam"). Only fires when a `re` marker
  // follows, so we know unambiguously where the name ends.
  if (task_code === 'Call/Conference' && !person) {
    const reIdx = tokens.findIndex((t) => RE_MARKER.test(t));
    if (reIdx > 0) {
      const count = Math.min(2, reIdx);
      person = tokens.slice(0, count).map(titleCase).join(' ');
      tokens.splice(0, count);
    }
  }

  // 4. topic: after "re"/"re:", else the remainder
  const reIdx = tokens.findIndex((t) => RE_MARKER.test(t));
  const topicTokens = reIdx !== -1 ? tokens.slice(reIdx + 1) : tokens.slice();
  const topic = topicTokens.join(' ');

  // 5. matter match from the topic (progressively relaxed, see header)
  let matterQuery = '';
  let matches = [];
  if (topic) {
    const resolved = resolveMatterQuery(topic, matters);
    matterQuery = resolved.matterQuery;
    matches = resolved.matches;
  }

  // 6. narrative stub
  let narrative = '';
  if (task_code === 'Call/Conference') {
    narrative = `Telephone conference${person ? ` with ${person}` : ''}${topic ? ` regarding ${topic}` : ''}`;
  } else if (task_code === 'Correspondence') {
    narrative = `Correspondence${person ? ` with ${person}` : ''}${topic ? ` regarding ${topic}` : ''}`;
  } else if (task_code) {
    narrative = `${titleCase(verbWord || task_code)}${topic ? ` ${topic}` : ''}`;
  } else {
    narrative = topic;
  }
  narrative = narrative.trim();
  if (!task_code && !topic) narrative = '';

  const missing = [];
  if (matches.length === 0) missing.push('matter');
  if (hours == null) missing.push('hours');
  if (!task_code) missing.push('action');

  return { hours, task_code, person, topic, narrative, matterQuery, matches, missing };
}
