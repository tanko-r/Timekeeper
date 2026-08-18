#!/usr/bin/env node
// Export time entries as LoRA training data.
//
// The shape of the job, from the data: only ~15 entries carry a real ai_brief,
// so there are not hundreds of brief -> narrative pairs to learn from. What
// there ARE is hundreds of examples of how David writes. So the target is
// VOICE, not translation: given a matter and a few terse notes, produce a
// narrative that sounds like his.
//
// Inputs for the other ~413 are built by degrading each narrative into the
// notes someone would have typed to get it — drop filler, keep the content
// words, lowercase. That is backtranslation. It is a real technique and it has
// a real failure mode: the model can learn "un-abbreviate the input" rather
// than "write like David". The held-out split is what catches that, so do not
// skip the eval.
//
//   node scripts/finetune-export.mjs                 # writes train/valid jsonl
//   node scripts/finetune-export.mjs --db /path/db
//
// Output: data/finetune/{train,valid}.jsonl  (gitignored, real client text)

import Database from 'better-sqlite3';
import { writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

const DB = flag('db', `${homedir()}/Projects/timekeeper-prod/data/timekeeper.db`);
const OUT = flag('out', 'data/finetune');
const VALID_FRACTION = 0.1;

mkdirSync(OUT, { recursive: true });
const db = new Database(DB, { readonly: true });

// Filler this house voice does not use. Measured baseline (2026-08-01, 357
// entries): p10 4 words, p50 11, p90 29. Anything that pads is not signal.
const FILLER = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'at',
  'by', 'from', 'as', 'is', 'was', 'be', 'been', 'that', 'this', 'it', 'its',
  'regarding', 'concerning', 'various', 'certain', 'related', 'relating',
  'further', 'additional', 'respecting', 'pertaining',
]);

// Degrade a narrative into the notes that would have produced it: content
// words only, lowercased, original order. Deterministic — no clock, no random,
// so re-running gives the same split and the same inputs.
function toBrief(narrative) {
  const words = narrative
    .replace(/[;,.]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .filter((w) => !FILLER.has(w.toLowerCase()))
    .map((w) => w.toLowerCase());
  return words.join(' ').slice(0, 300);
}

const rows = db.prepare(`
  select e.id, e.narrative, e.ai_brief, m.short_name
  from entries e left join matters m on m.id = e.cm_id
  where e.narrative is not null and length(trim(e.narrative)) > 2
    and e.deleted_at is null
  order by e.id
`).all();

const SYSTEM = 'Write one attorney time entry narrative. Match the house voice: '
  + 'terse, past tense, no filler, no invented time amounts.';

let real = 0;
const samples = rows.map((r) => {
  const hasReal = r.ai_brief && r.ai_brief.trim().length > 2;
  if (hasReal) real += 1;
  const brief = hasReal ? r.ai_brief.trim() : toBrief(r.narrative);
  const matter = (r.short_name || '').trim();
  return {
    id: r.id,
    synthetic: !hasReal,
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: matter ? `Matter: ${matter}\nNotes: ${brief}` : `Notes: ${brief}` },
      { role: 'assistant', content: r.narrative.trim() },
    ],
  };
});

// Deterministic split on id, so validation never drifts between runs.
const valid = samples.filter((s) => s.id % Math.round(1 / VALID_FRACTION) === 0);
const validIds = new Set(valid.map((s) => s.id));
const train = samples.filter((s) => !validIds.has(s.id));

const write = (name, list) =>
  writeFileSync(`${OUT}/${name}.jsonl`, `${list.map((s) => JSON.stringify({ messages: s.messages })).join('\n')}\n`);
write('train', train);
write('valid', valid);

const words = (s) => s.messages[2].content.split(/\s+/).length;
const w = samples.map(words).sort((a, b) => a - b);
console.log(`source db:        ${DB}`);
console.log(`total samples:    ${samples.length}  (${real} real briefs, ${samples.length - real} synthetic)`);
console.log(`train / valid:    ${train.length} / ${valid.length}`);
console.log(`narrative words:  p50 ${w[Math.floor(w.length * 0.5)]}  p90 ${w[Math.floor(w.length * 0.9)]}  max ${w[w.length - 1]}`);
console.log(`\nwrote ${OUT}/train.jsonl and ${OUT}/valid.jsonl  (real client text — local only)`);
