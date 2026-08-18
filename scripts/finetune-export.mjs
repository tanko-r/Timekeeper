#!/usr/bin/env node
// Export time entries as LoRA training pairs: terse notes -> full narrative.
//
// THE JOB, per David 2026-08-17: the model should EXTRAPOLATE. "call with
// pierce re access" should become a multi-clause narrative that names the
// Access Agreement, the call, and the follow-up revisions -- drawing on prior
// entries in the same matter to know what "access" refers to. Expansion is the
// point, not a bug.
//
// Two things are deliberately REMOVED from every target, because they are
// properties of the matter rather than of the voice, and the app knows them:
//
//   (YEL) / (EAT02) prefixes  -- Microsoft site-coded matters only. Measured:
//                                34/38 on YEL, 0/45 on SFP-Corvex.
//   per-clause times (0.4)    -- same matters, from entry_tasks.duration.
//                                The app inserts these. A model that writes
//                                its own hours is inventing billable time.
//
// Inputs are derived by compressing each clause to the way David actually
// types: lowercased, abbreviated verbs, surnames only, document names dropped.
// The dropped detail is what the model must recover from matter context --
// that gap IS the training signal.
//
//   node scripts/finetune-export.mjs            # writes train/valid jsonl
//   node scripts/finetune-export.mjs --sample 6 # print pairs, write nothing
//
// Output: data/finetune/{train,valid}.jsonl (gitignored, real client text)

import Database from 'better-sqlite3';
import { writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

const DB = flag('db', `${homedir()}/Projects/timekeeper-prod/data/timekeeper.db`);
const OUT = flag('out', 'data/finetune');
const SAMPLE = Number(flag('sample', 0));
const CONTEXT_N = Number(flag('context', 4));   // prior entries shown per matter
const MIN_WORDS = Number(flag('min-words', 12));
const MIN_GROUND = Number(flag('min-grounding', 0.5)); // targets worth learning from

const db = new Database(DB, { readonly: true });

// --- strip what belongs to the matter, not the voice --------------------------

const stripPrefix = (n) => n.replace(/^\s*(?:\([A-Za-z0-9 .\-]{2,30}\)\s*)+/, '');
const stripTimes = (n) => n.replace(/\s*\(\s*\d+(?:\.\d+)?\s*\)/g, '');
const clean = (n) => stripTimes(stripPrefix(String(n || '')))
  .replace(/\s*;\s*/g, '; ').replace(/\s+/g, ' ').replace(/\s+([.;,])/g, '$1').trim();

// --- derive the terse note David would have typed -----------------------------

// "Review and analyze" -> "rev". These are the abbreviations he actually uses.
const VERB = [
  [/^review and analyze\b/i, 'rev'], [/^review and respond to\b/i, 'rev+resp'],
  [/^review and revise\b/i, 'rev+revise'], [/^review\b/i, 'rev'],
  [/^analyze\b/i, 'analyze'], [/^revise\b/i, 'revise'], [/^revisions to\b/i, 'revise'],
  [/^prepare for\b/i, 'prep'], [/^prepare\b/i, 'prep'], [/^draft\b/i, 'draft'],
  [/^compose\b/i, 'draft'], [/^correspond with\b/i, 'email w'],
  [/^email(s)? with\b/i, 'email w'], [/^email to\b/i, 'email'], [/^emails? \b/i, 'email'],
  [/^call with\b/i, 'call w'], [/^conference call with\b/i, 'call w'],
  [/^teams meeting with\b/i, 'mtg w'], [/^confer with\b/i, 'confer w'],
  [/^attend\b/i, 'attend'], [/^messages with\b/i, 'msg w'],
  [/^follow up with\b/i, 'f/u w'], [/^follow-up\b/i, 'f/u'], [/^follow up\b/i, 'f/u'],
  [/^conduct call with\b/i, 'call w'], [/^communication with\b/i, 'msg w'],
];

const NOISE = new Set(['the', 'a', 'an', 'and', 'of', 'to', 'in', 'on', 'for', 'with',
  'at', 'by', 'from', 'as', 'is', 'was', 'be', 'that', 'this', 'it', 'its', 'same',
  'regarding', 'concerning', 'related', 'relating', 'various', 'certain', 'including',
  'respecting', 'pertaining', 'further', 'additional', 'their', 'his', 'her', 'our']);

function terseClause(raw) {
  let c = stripTimes(stripPrefix(raw)).trim();
  if (!c) return '';
  let verb = '';
  for (const [re, short] of VERB) {
    if (re.test(c)) { verb = short; c = c.replace(re, '').trim(); break; }
  }
  // "A. Smith" -> "smith": David types surnames, the model re-supplies initials.
  c = c.replace(/\b[A-Z]\.\s+([A-Z][a-z]+)/g, '$1');
  const words = c.split(/\s+/)
    .map((w) => w.replace(/[^A-Za-z0-9/&-]/g, ''))
    .filter((w) => w && !NOISE.has(w.toLowerCase()));
  // Keep the first few content words, but ALWAYS keep capitalised tokens: those
  // carry the people, documents and issues. David's own example ("call with
  // pierce re access") keeps both the person and the topic, and an input that
  // drops them asks the model to invent rather than to expand. Measured: 4-word
  // truncation grounded 65% of target entities; keeping entity words lifts it.
  const isEntity = (w) => /^[A-Z]/.test(w) || /^[A-Z]{2,}$/.test(w) || /\d/.test(w);
  const head = words.slice(0, 4);
  const kept = [...new Set([...head, ...words.filter(isEntity)])]
    .map((w) => (/^[A-Z]{2,}$/.test(w) ? w : w.toLowerCase()))
    .slice(0, 9);
  return [verb, kept.join(' ')].filter(Boolean).join(' ').trim();
}

const terse = (narrative) => clean(narrative).split(';')
  .map(terseClause).filter(Boolean).join('; ');

// --- grounding: can the target be derived from the input at all? -------------
//
// A target naming a person or document that appears NOWHERE in the notes or the
// matter history is not something a model can expand towards -- it can only
// learn to confabulate one. Measured on this corpus: 83% of target entities are
// recoverable, and the residual is genuine first-mentions (a colleague named for
// the first time). Those samples are dropped, not fixed: no context window
// recovers information that was never written down.

const STOP_ENT = new Set(['Review', 'Call', 'Draft', 'Prepare', 'Analyze', 'Email',
  'Emails', 'Revise', 'Confer', 'Attend', 'Messages', 'Follow', 'Teams',
  'Conference', 'Additional', 'Correspondence', 'Communication', 'Close', 'Notes']);

function entitiesOf(text) {
  const out = new Set();
  for (const m of text.matchAll(/\b[A-Z]\.\s*[A-Z][a-z]+/g)) out.add(m[0]);
  for (const m of text.matchAll(/\b(?:[A-Z][a-z]{2,}|[A-Z]{2,})(?:\s+(?:[A-Z][a-z]{2,}|[A-Z]{2,}|of|to|and))*\b/g)) {
    const v = m[0].trim();
    if (v.length > 3) out.add(v);
  }
  return [...out].filter((e) => !STOP_ENT.has(e));
}

function grounding(input, target) {
  const ents = entitiesOf(target);
  if (!ents.length) return 1;
  const low = input.toLowerCase();
  const hit = ents.filter((e) => {
    const l = e.toLowerCase();
    return low.includes(l) || low.includes(l.replace(/^[a-z]\.\s*/, ''));
  });
  return hit.length / ents.length;
}

// --- data ---------------------------------------------------------------------

const rows = db.prepare(`
  select e.id, e.date, e.cm_id, e.narrative, m.short_name
  from entries e left join matters m on m.id = e.cm_id
  where e.narrative is not null and length(trim(e.narrative)) > 2
    and e.deleted_at is null
  order by e.date, e.id
`).all();

// Prior narratives in the same matter, strictly BEFORE this entry. Ordering by
// date keeps the context leak-free: an entry never sees its own future.
const history = new Map();
function contextFor(row) {
  const key = row.cm_id ?? 'none';
  const prior = history.get(key) || [];
  // slice(-0) returns the WHOLE array in JS, not an empty one, so --context 0
  // would silently include every prior entry. Guard it explicitly.
  return CONTEXT_N > 0 ? prior.slice(-CONTEXT_N) : [];
}

const SYSTEM = 'You write attorney time entry narratives. Expand the terse notes into '
  + 'the full narrative: name the documents, people and issues the notes refer to, using '
  + 'the matter history for what abbreviations mean. Semicolon-separated clauses, past '
  + 'tense, no filler. Never invent hours.';

const samples = [];
let dropped = 0;
for (const r of rows) {
  const target = clean(r.narrative);
  const key = r.cm_id ?? 'none';
  const ctx = contextFor(r);
  if (!history.has(key)) history.set(key, []);
  history.get(key).push(target);

  if (target.split(/\s+/).length < MIN_WORDS) continue; // too short to teach expansion
  const notes = terse(r.narrative);
  if (!notes || notes.split(/\s+/).length >= target.split(/\s+/).length) continue;

  const user = [
    r.short_name ? `Matter: ${r.short_name}` : null,
    ctx.length ? `Recent work on this matter:\n${ctx.map((c) => `- ${c}`).join('\n')}` : null,
    `Notes: ${notes}`,
  ].filter(Boolean).join('\n\n');

  const ground = grounding(user, target);
  if (ground < MIN_GROUND) { dropped += 1; continue; }

  samples.push({
    id: r.id,
    ground,
    expansion: (target.split(/\s+/).length / Math.max(notes.split(/\s+/).length, 1)),
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: user },
      { role: 'assistant', content: target },
    ],
  });
}

if (SAMPLE) {
  for (const s of samples.slice(0, SAMPLE)) {
    console.log(`\n${'='.repeat(72)}\n#${s.id}   expansion ${s.expansion.toFixed(1)}x`);
    console.log(`\n--- INPUT ---\n${s.messages[1].content}`);
    console.log(`\n--- TARGET ---\n${s.messages[2].content}`);
  }
  process.exit(0);
}

mkdirSync(OUT, { recursive: true });
const valid = samples.filter((s) => s.id % 10 === 0);
const validIds = new Set(valid.map((s) => s.id));
const train = samples.filter((s) => !validIds.has(s.id));
const write = (n, l) => writeFileSync(`${OUT}/${n}.jsonl`,
  `${l.map((s) => JSON.stringify({ messages: s.messages })).join('\n')}\n`);
write('train', train);
write('valid', valid);

const e = samples.map((s) => s.expansion).sort((a, b) => a - b);
const w = samples.map((s) => s.messages[2].content.split(/\s+/).length).sort((a, b) => a - b);
console.log(`source:          ${DB}`);
const g = samples.map((s) => s.ground).sort((a, b) => a - b);
console.log(`dropped (< ${MIN_GROUND} grounded): ${dropped}  -- targets naming things the input never mentions`);
console.log(`grounding kept:  p50 ${g[Math.floor(g.length / 2)].toFixed(2)}  p10 ${g[Math.floor(g.length * 0.1)].toFixed(2)}`);
console.log(`usable samples:  ${samples.length} of ${rows.length}  (>= ${MIN_WORDS} words after stripping)`);
console.log(`train / valid:   ${train.length} / ${valid.length}`);
console.log(`expansion ratio: p50 ${e[Math.floor(e.length / 2)].toFixed(1)}x  p90 ${e[Math.floor(e.length * 0.9)].toFixed(1)}x`);
console.log(`target words:    p50 ${w[Math.floor(w.length / 2)]}  p90 ${w[Math.floor(w.length * 0.9)]}  max ${w[w.length - 1]}`);
console.log(`\nwrote ${OUT}/train.jsonl and ${OUT}/valid.jsonl  (real client text — local only)`);
