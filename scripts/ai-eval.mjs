#!/usr/bin/env node
// Offline narrative eval (spec 2026-08-01 §6). Runs a fixed set of briefs
// through the configured local model and scores the output against the house
// voice measured from real history.
//
// NOT part of `npm test` — it needs a live Ollama and takes minutes. It is the
// regression check for prompt edits, and the yardstick any fine-tuned model
// has to beat.
//
//   node scripts/ai-eval.mjs            # score the current prompt
//   node scripts/ai-eval.mjs --verbose  # also print the assembled system prompt
//   AI_EVAL_MODEL=qwen3.5:4b node scripts/ai-eval.mjs
//
// Exit code 1 if any gate fails, so it can gate a commit.

import { openDb, getSetting } from '../server/db.js';
import { buildNarrateMessages, buildVoiceContext } from '../server/routes/ai.js';
import { loadConfig } from '../server/config.js';

// Baseline for comparison, measured 2026-08-01 from 357 imported entries:
// p10 4 words, p50 11, p90 29. The pre-rewrite prompt produced 40.
const MEDIAN_CEILING = 16;
const LONGEST_CEILING = 34;

// Filler markers. These describe WHY work was done or restate a category
// instead of naming a thing — the register David flagged. Deliberately not in
// the prompt: naming a phrase there makes a small model emit it.
const FILLER = [
  /\bin order to\b/i, /\bto ensure\b/i, /\bfor review and approval\b/i,
  /\bwith a view to\b/i, /\bas necessary\b/i, /\bas appropriate\b/i,
  /\bvarious matters\b/i, /\band other\b/i,
  /\bor other electronic means\b/i, /\bby email or\b/i,
  /\bfor the purpose of\b/i, /\bwith respect to the foregoing\b/i,
];
const TIME_AMOUNT = /\(\s*\d+(?:\.\d+)?\s*\)|\b\d+(?:\.\d+)?\s*(hours?|hrs?)\b/i;

const BRIEFS = [
  'draft psa; review loi; email w client; email w title co',
  'call w opposing counsel re discovery; rev their responses',
  'reviewed easement, talked to mike about it',
  'tc w client re strategy; follow up email',
  'revise lease amendment per nicol comments; send to client',
  'rev title commitment; note exceptions; email to client',
  'prep for closing; call w lender counsel',
  'draft response to city re records request',
];

const verbose = process.argv.includes('--verbose');
const db = openDb(loadConfig().DB_PATH);
const cfg = getSetting(db, 'ai') || {};
const model = process.env.AI_EVAL_MODEL || cfg.model;
const url = cfg.url || 'http://127.0.0.1:11434';

if (!model) {
  console.error('No model configured. Set one in Settings → AI, or AI_EVAL_MODEL=…');
  process.exit(2);
}

async function narrate(brief) {
  const messages = buildNarrateMessages({
    instructions: cfg.systemPrompt,
    brief, mode: 'draft',
    voice: buildVoiceContext(db, { brief }),
  });
  if (verbose && brief === BRIEFS[0]) {
    console.log('─'.repeat(72));
    console.log(messages[0].content);
    console.log(`─ ${(messages.length - 2) / 2} few-shot pairs ${'─'.repeat(50)}`);
  }
  const resp = await fetch(`${url}/api/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model, stream: false, options: { temperature: 0.3 }, messages,
    }),
    signal: AbortSignal.timeout(300_000),
  });
  if (!resp.ok) throw new Error(`ollama returned ${resp.status}`);
  const data = await resp.json();
  return String((data.message && data.message.content) || '').trim();
}

const words = (t) => t.split(/\s+/).filter(Boolean).length;
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

console.log(`model: ${model}   briefs: ${BRIEFS.length}\n`);
const rows = [];
for (const brief of BRIEFS) {
  let text;
  try {
    text = await narrate(brief);
  } catch (e) {
    console.error(`\nCould not reach the model: ${e.message}`);
    process.exit(2);
  }
  const filler = FILLER.filter((re) => re.test(text)).map((re) => re.source);
  const timey = TIME_AMOUNT.test(text);
  rows.push({ brief, text, w: words(text), filler, timey });
  const flags = [filler.length ? `FILLER(${filler.length})` : '', timey ? 'TIME' : '']
    .filter(Boolean).join(' ');
  console.log(`  ${brief}\n  → ${text}\n    [${words(text)} words] ${flags}\n`);
}

const ws = rows.map((r) => r.w);
const med = median(ws);
const longest = Math.max(...ws);
const fillerHits = rows.filter((r) => r.filler.length);
const timeHits = rows.filter((r) => r.timey);

const gates = [
  [`median ${med} ≤ ${MEDIAN_CEILING} words`, med <= MEDIAN_CEILING],
  [`longest ${longest} ≤ ${LONGEST_CEILING} words`, longest <= LONGEST_CEILING],
  [`no filler markers (${fillerHits.length} hit)`, fillerHits.length === 0],
  [`no invented time amounts (${timeHits.length} hit)`, timeHits.length === 0],
];

console.log('─'.repeat(72));
console.log(`words: min ${Math.min(...ws)}  median ${med}  max ${longest}   (real history median: 11)`);
for (const [label, ok] of gates) console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
if (fillerHits.length) {
  console.log('\nfiller:');
  for (const r of fillerHits) console.log(`  ${r.filler.join(', ')}\n    ${r.text}`);
}
db.close();
process.exit(gates.every(([, ok]) => ok) ? 0 : 1);
