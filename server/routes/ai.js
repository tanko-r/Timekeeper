import { Router } from 'express';
import { getSetting } from '../db.js';
import { correctInitials } from '../lib/people.js';
import { allocateTenths } from '../lib/allocate.js';
import { matterSuggestions, matterPeopleList } from './matters.js';
import { todayLocal } from '../lib/dates.js';
import { containsTimeAmounts, stripTimeAmounts } from '../lib/timeAmounts.js';
import {
  pickExemplars, pickPairs, renderGlossary, foreignTerms, vocabulary,
} from '../lib/exemplars.js';

// Local-LLM narrative assist via Ollama (localhost only — no cloud calls).
// Brief description in → professional narrative + optional task split out.

function parseJsonLoose(s) {
  try { return JSON.parse(s); } catch { /* fall through */ }
  const m = String(s).match(/\{[\s\S]*\}/);
  if (m) {
    try { return JSON.parse(m[0]); } catch { /* fall through */ }
  }
  return null;
}

// The editable part of the prompt (Settings → AI). The format contract below
// is ALWAYS appended so custom instructions can't break response parsing.
// POSITIVE-ONLY rules (spec 2026-08-01 §1). Every constraint is phrased as
// what to do, and no rule contains a literal phrase to avoid or a placeholder
// name. This is not stylistic: a design prototype that listed forbidden
// phrases emitted them verbatim, and invented a person named after the
// placeholder in its own name-formatting rule. A small model treats any string
// in the prompt as vocabulary, whatever the surrounding sentence claims.
//
// The old default also contradicted itself ("make reasonable conjecture" vs
// "do not invent"), which llama3.1:8b resolved by padding — the filler David
// reported. Substance now comes from the exemplars and pairs appended by
// buildVoiceContext(), not from prose here.
export const DEFAULT_AI_INSTRUCTIONS = `You are a legal billing assistant. The attorney types terse shorthand for work performed. You render it as a billing narrative in the attorney's own voice.

Match the length, rhythm and register of the attorney's entries shown below. Brevity is the point: most entries are a single sentence.

Those entries show you how the attorney writes. Take only their shape. Every name, document and subject in your answer comes from the attorney's description of this work.

- Write in present tense.
- Separate distinct tasks with semicolons. End with a period.
- Write a person as an initial and a surname when the description or the matter history gives you their surname. A name you cannot match that way stays exactly as the attorney typed it.
- Expand abbreviations into the full document name.
- State what the work touched: the document, the person, the subject. Stop there.
- Every noun in your output must trace to a word the attorney wrote. Where the shorthand names no subject, leave it unnamed.
- Drop articles wherever the attorney's entries drop them.`;

// NOTE on casing (2026-08-11, third pass). Both contracts below used to end
// their fragment rule with "the first word is a lowercase verb". David asked
// why the split case-folds proper nouns when plain Expand never does, and he
// was right that the difference is the prompt, not the model: these were the
// only prompts in the app containing the word "lowercase", and the split was
// the only path that folded. An 8B applies a rule about the first word to the
// whole clause.
//
// Measured on llama3.1:8b against the live database, on the reported entry:
//
//   plain Expand (buildNarrateMessages — says nothing about case)   0/4 folded
//   this contract WITH "lowercase"                                  1/4 folded
//   this contract without it                                       0/12 folded
//
// The folding run lost "E. Hodgson", "Second Amendment", "Option Agreement"
// and "Memorandum" together. "verb" is kept because it anchors the clause to
// an action; only the word "lowercase" is gone. Nothing is lost by that:
// generateNarrative capitalises the leading clause itself, and David does not
// mind a capitalised fragment.
//
// Watch item, NOT caused by this change and not fixed by it: on some runs the
// model imports people and stock phrases from OTHER matters in the voice
// context ("email with J. Busse and C. Pierce regarding legal descriptions"
// for an entry naming neither). Measured on the same entry, 5 runs each: with
// the few-shot pairs 2/5, without them 5/5 — so the pairs spliced in below
// reduce it. A later batch of 10 came back clean, so the rate swings hard.
// Dropping the exemplar block for the rewrite contract was tried and measured
// 0/5 against 0/5 — no evidence either way, so it was not changed.
export function formatContract(codes) {
  return `Rules for tasks:
- The tasks account for every distinct piece of work in the description. Where the attorney separated clauses with semicolons, give one task per clause, in the same order. Up to 8 tasks.
- task_code MUST be one of: ${codes.join(', ')}.
- fragment: the billing-narrative clause for that task, in the same voice and at the same length as the attorney's entries above. Keep the documents, parties and subject matter from the description that belong to that task, and name nothing the description did not. The first word is a verb; no trailing period.
- share: fraction of the total time for that task; all shares sum to 1.

Respond with ONLY this JSON, no other text:
{"narrative": "...", "tasks": [{"task_code": "...", "fragment": "...", "share": 0.5}]}`;
}

// The contract for a split the attorney has ALREADY made (2026-08-11
// feedback). When the narrative box holds "a; b; c" the semicolons are the
// division — asking an 8B to work out the division again is what dropped a
// clause on a third of runs, reordered them on others, and merged two into
// one. Measured on llama3.1:8b, the same narrative under this 1:1 contract
// came back as exactly N tasks, in order, three runs out of three. The model
// is left with the job it is actually good at: writing the clause.
export function rewriteContract(codes, n) {
  return `The attorney has already divided this work into ${n} tasks and numbered them below. Rewrite each one as a billing-narrative clause, in the attorney's voice.

- Answer with exactly ${n} tasks, one for each numbered line, in the same order.
- Task 1 rewrites line 1, task 2 rewrites line 2, and so on. Each task covers its own line and no other.
- task_code MUST be one of: ${codes.join(', ')}.
- fragment: that line rewritten. Expand the attorney's abbreviations into full document names and keep every party, document and subject it names. Name nothing the line did not. The first word is a verb; no trailing punctuation.

Respond with ONLY this JSON, no other text:
{"tasks": [{"task_code": "...", "fragment": "..."}]}`;
}

export function systemPrompt(codes, custom, voice, { clauseCount = 0 } = {}) {
  const instructions = String(custom || '').trim() || DEFAULT_AI_INSTRUCTIONS;
  const contract = clauseCount >= 2 ? rewriteContract(codes, clauseCount) : formatContract(codes);
  return `${instructions}${(voice && voice.prompt) || ''}\n\n${contract}`;
}

// When a call knows its matter, the roster + recurring phrases ride along so
// the model can resolve informal references ("jeff", "the lease") against
// real history (2026-07-10 feedback). Deterministic and instant — the same
// memory layer the phrasebook/people endpoints read.
export function matterAiContext(db, cmId, today) {
  if (!cmId) return null;
  const names = matterPeopleList(db, cmId);
  const sugg = matterSuggestions(db, cmId, today);
  // OWN-MATTER phrases only. Both blocks below are captioned as this matter's
  // history, and the model is told to resolve names against them — so anything
  // in here becomes a candidate fact for THIS matter's billing narrative. A
  // phrase flagged source:'client' is wording borrowed from a sibling matter;
  // it stays shared in the phrasebook and ghost text, where sharing is the
  // point, but it never rides into a prompt that writes another matter's
  // sentence (docs/ui/BRIEF.md, "The AI prompts obey the same line").
  const phrases = (sugg ? sugg.phrases : [])
    .filter((p) => p.source === 'matter')
    .slice(0, 6).map((p) => `- ${p.text}`);
  const parts = [];
  if (names.length) parts.push(`People from this matter's history: ${names.join(', ')}.`);
  if (phrases.length) parts.push(`The attorney's recent work on this matter:\n${phrases.join('\n')}`);
  return parts.length ? parts.join('\n\n') : null;
}

// Hand-authored bootstrap pairs (spec §4). Deliberately generic — they exist
// only until real (brief → corrected narrative) pairs accumulate, at which
// point pickPairs displaces them permanently. Kept few and short so they teach
// the compression ratio without anchoring subject matter.
export const SEED_PAIRS = [
  { brief: 'rev lease; conf w client', seed: true,
    narrative: 'Review and analyze lease and confer with client regarding same.' },
  { brief: 'draft easement amendment per comments; send to client', seed: true,
    narrative: 'Draft revisions to easement amendment incorporating comments and transmit to client.' },
  { brief: 'tc w opposing counsel re discovery', seed: true,
    narrative: 'Telephone conference with opposing counsel regarding discovery responses.' },
  { brief: 'emails w title co re escrow', seed: true,
    narrative: 'Email with title company regarding escrow.' },
  // Demonstrates the two cases prose rules could not hold (measured
  // 2026-08-01): a first name with no known surname stays as typed rather
  // than being resolved to someone borrowed from the exemplars, and an
  // unnamed party stays unnamed rather than acquiring a name.
  { brief: 'rev easement; talked to mike about it', seed: true,
    narrative: 'Review and analyze easement and confer with Mike regarding same.' },
  { brief: 'draft ltr to county re permit condition', seed: true,
    narrative: 'Draft letter to County regarding permit condition.' },
];

// The voice layer: real narratives as style exemplars, the shortcuts table as
// an abbreviation authority, and few-shot pairs as chat turns. Returns a
// prompt fragment plus the turns to splice in before the live request.
//
// Two filters, both load-bearing:
//   narrative_ai = 0   — text David wrote or corrected. Without it,
//     recency-weighted selection feeds the model's own output back as "the
//     attorney's voice" and compounds the verbosity this design removes.
//   status = 'finalized' — the version David signed off on. Narratives
//     autosave every 600ms, so a draft is a moving target: mid-thought wording
//     would be taught as readily as the wording he settled on.
const FINAL = "deleted_at IS NULL AND status = 'finalized' AND narrative_ai = 0";

// Fully synthetic house-voice examples for a matter with no history of its own.
// The seed pairs are hand-authored and name no real client, so they teach
// length, rhythm and register without a single borrowed fact — which is exactly
// what the brief prescribes for the cold-matter case.
const SYNTHETIC_EXEMPLARS = SEED_PAIRS.map((p) => p.narrative);

export function buildVoiceContext(db, { cmId = null, brief = '' } = {}) {
  if (!db) return { prompt: '', turns: [] };

  // MATTER-SCOPED, both pools (2026-08-15). These two blocks paste the
  // attorney's real finished narratives into the prompt — the exemplars as
  // "The attorney's entries", the pairs as prior chat turns to imitate. They
  // used to be drawn from the whole database, with cmId acting only as a sort
  // key, so a brand-new matter got the *maximum* dose of other clients' work:
  // whole billing sentences naming other clients' parties and documents, shown
  // to a model that was about to write this matter's sentence. docs/ui/BRIEF.md
  // is explicit — "those pairs come from the same matter; where a matter has
  // none, use fully synthetic examples. Never put one client's or one matter's
  // real narrative into a prompt that writes another's."
  const own = cmId == null ? [] : db.prepare(`
    SELECT narrative FROM entries
    WHERE ${FINAL} AND cm_id = ?
      AND narrative IS NOT NULL AND length(trim(narrative)) > 0
    ORDER BY date DESC LIMIT 60
  `).all(cmId).map((r) => r.narrative);

  const ownExemplars = pickExemplars(own, { count: 6 });
  const exemplars = ownExemplars.length
    ? ownExemplars
    : pickExemplars(SYNTHETIC_EXEMPLARS, { count: 6 });
  const glossary = renderGlossary(db.prepare(
    'SELECT abbrev, phrase FROM shortcuts ORDER BY id DESC').all());

  const pool = cmId == null ? [] : db.prepare(`
    SELECT ai_brief AS brief, narrative, cm_id, date FROM entries
    WHERE ${FINAL} AND cm_id = ?
      AND ai_brief IS NOT NULL AND length(trim(ai_brief)) > 0
      AND narrative IS NOT NULL AND length(trim(narrative)) > 0
    ORDER BY date DESC LIMIT 300
  `).all(cmId);
  const pairs = pickPairs(pool, SEED_PAIRS, { count: 6, cmId, brief });

  // Two blocks, because they are not wanted on the same occasions. The
  // exemplars teach voice and belong in every call. The glossary is an
  // EXPANSION authority — it earns its place only when the input is shorthand.
  const glossaryBlock = glossary
    ? `The attorney's shorthand, and the full wording it stands for:\n${glossary}`
    : null;
  const exemplarBlock = exemplars.length
    ? `The attorney's entries:\n${exemplars.join('\n')}`
    : null;
  const join = (blocks) => {
    const kept = blocks.filter(Boolean);
    return kept.length ? `\n\n${kept.join('\n\n')}` : '';
  };
  return {
    prompt: join([glossaryBlock, exemplarBlock]),
    // Rewrites (shorter / longer) get this one instead: their input is already
    // finished prose, so a list of short forms has nothing left to expand and
    // can only tempt the model into putting the shorthand back (2026-08-06
    // feedback). Same reason the shorthand→narrative pairs are dropped below.
    rewritePrompt: join([exemplarBlock]),
    turns: pairs.flatMap((p) => [
      { role: 'user', content: `Work done: ${p.brief}` },
      { role: 'assistant', content: p.narrative },
    ]),
  };
}

export const NAME_RESOLUTION_RULE = `\n\nThe context may list people and phrases from this matter's history. When the description refers to someone informally (first name, initials, or nickname), use the matching name from that history — e.g. "jeff" becomes "J. Larson" if that is the only plausible match. Keep names with no clear match exactly as written; never invent people who appear in neither the description nor the history.`;

export async function checkOllamaReachable(url) {
  try {
    const resp = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(2500) });
    if (resp.ok) {
      const data = await resp.json();
      return { reachable: true, models: (data.models || []).map((m) => m.name) };
    }
  } catch { /* ollama down */ }
  return { reachable: false, models: [] };
}

// Ground the prose in the entry's recorded hours (2026-07-14 feedback: a
// 0.1h entry must not read like a multi-hour work block). Returns '' when
// the caller doesn't know the time, so nothing is ever invented.
export function timeGroundingRule(totalHours) {
  const h = Number(totalHours);
  if (!Number.isFinite(h) || h <= 0) return '';
  const mins = Math.round(h * 60);
  return `\n\nThe recorded time for this entry is ${h} hours (${mins} minutes). The narrative must describe only what could plausibly be done in that time: under half an hour is a single brief action in one short sentence; only longer entries justify multiple actions or extended detail.`;
}

// The two rewrite asks, kept in one place so the demonstrations below are
// worded identically to the live request — a few-shot turn only teaches if the
// model reads it as the same kind of question.
export const REWRITE_ASK = {
  shorter: (n) => `Rewrite this billing narrative to be tighter and shorter while keeping every distinct piece of work:\n\n${n}`,
  longer: (n) => `Rewrite this billing narrative with slightly more specific detail. Do not invent facts, names, or documents:\n\n${n}`,
};

// What "shorter" is allowed to cut, shown rather than stated (2026-08-06
// feedback: told to tighten, llama3.1:8b shrank "A. Hollowell" to "AH" and
// "Purchase and Sale Agreement" to "PSA" — a prose rule saying "keep names in
// full" would only have put more short forms in front of it). The pairs cut
// articles and doubled verbs while every name and document title survives
// intact. House fictional names only.
export const REWRITE_SHOTS = {
  shorter: [{
    before: 'Review and analyze the Purchase and Sale Agreement and confer with J. Larson regarding the escrow schedule; draft the revisions to the easement amendment.',
    after: 'Review Purchase and Sale Agreement and confer with J. Larson regarding escrow schedule; draft revisions to easement amendment.',
  }],
  longer: [{
    before: 'Review lease and email client.',
    after: 'Review and analyze lease and email to client regarding same.',
  }],
};

export function rewriteShots(mode) {
  return (REWRITE_SHOTS[mode] || []).flatMap((s) => [
    { role: 'user', content: REWRITE_ASK[mode](s.before) },
    { role: 'assistant', content: s.after },
  ]);
}

// Plain-text narrative prompt (NO JSON contract — unlike /ai/expand) shared
// by the background suggested-narrative refinement and the streaming
// /api/ai/narrate endpoint (Task 6 / spec §6 "faster AI narration").
export function buildNarrateMessages({ instructions, brief, narrative, mode = 'draft', context, totalHours, voice }) {
  const base = String(instructions || '').trim() || DEFAULT_AI_INSTRUCTIONS;
  // A rewrite is handed finished prose, so it takes the voice block WITHOUT
  // the abbreviation glossary (2026-08-06 feedback: names David had already
  // expanded came back as shorthand). Older callers that only supply `prompt`
  // keep their previous behaviour.
  const rewriting = mode === 'shorter' || mode === 'longer';
  const voicePrompt = (voice && (rewriting ? (voice.rewritePrompt ?? voice.prompt) : voice.prompt)) || '';
  const system = `${base}${voicePrompt}\n\nRespond with ONLY the billing narrative itself — plain text. No JSON, no quotes, no preamble, no explanations.\n\nNever include time amounts, durations, or task-billing parentheticals such as "(0.5)" — the app records time separately from the narrative text.${timeGroundingRule(totalHours)}${context ? NAME_RESOLUTION_RULE : ''}`;
  const user = rewriting
    ? [context, REWRITE_ASK[mode](narrative)].filter(Boolean).join('\n\n')
    : [context, `Work done: ${brief}`].filter(Boolean).join('\n\n');
  // Few-shot pairs sit between the system prompt and the live request so the
  // model reads them as prior exchanges it should imitate. Rewrites get their
  // OWN demonstrations: the voice pairs are shorthand→narrative, which is the
  // wrong transformation for an input that is already finished prose.
  const shots = rewriting ? rewriteShots(mode) : ((voice && voice.turns) || []);
  return [{ role: 'system', content: system }, ...shots, { role: 'user', content: user }];
}

// Every word this matter is entitled to use: its own entries (narratives and
// task fragments), its own roster, its own identifiers, and whatever the caller
// put in front of the model (the timer label / brief). Drafts count as well as
// finalized text — the question here is provenance, not quality.
function ownVocabulary(db, cmId, extra = []) {
  const rows = db.prepare(`
    SELECT narrative AS text FROM entries WHERE cm_id = ? AND deleted_at IS NULL
    UNION ALL
    SELECT et.fragment FROM entry_tasks et JOIN entries e ON e.id = et.entry_id
      WHERE e.cm_id = ? AND e.deleted_at IS NULL
    UNION ALL
    SELECT name FROM matter_people WHERE matter_id = ?
    UNION ALL
    SELECT m.short_name FROM matters m WHERE m.id = ?
    UNION ALL
    SELECT m.cm_number FROM matters m WHERE m.id = ?
    UNION ALL
    SELECT c.name FROM clients c JOIN matters m ON m.client_id = c.id WHERE m.id = ?
  `).all(cmId, cmId, cmId, cmId, cmId, cmId).map((r) => r.text);
  return vocabulary(rows.concat(extra));
}

// The same, for every OTHER matter in the database — siblings of the same
// client included, because the boundary is the matter and not the client.
function otherMatterVocabulary(db, cmId) {
  const rows = db.prepare(`
    SELECT narrative AS text FROM entries
      WHERE cm_id IS NOT NULL AND cm_id IS NOT ? AND deleted_at IS NULL
    UNION ALL
    SELECT et.fragment FROM entry_tasks et JOIN entries e ON e.id = et.entry_id
      WHERE e.cm_id IS NOT NULL AND e.cm_id IS NOT ? AND e.deleted_at IS NULL
    UNION ALL
    SELECT name FROM matter_people WHERE matter_id IS NOT ?
  `).all(cmId, cmId, cmId).map((r) => r.text);
  return vocabulary(rows);
}

// Background refinement of a timer's pre-computed narrative (spec §6,
// "suggested narrative on timer start": phrasebook first, "optional async
// llama3.1 pass"). FIRE-AND-FORGET: callers must never block a request on
// this — timers.js calls it as `refineSuggestedNarrative(deps, id).catch(...)`.
// No-op when AI is disabled (the default, so tests without a stub are
// unaffected). The UPDATE is guarded by running=1 AND by the matter the
// refinement was BUILT for: llama3.1:8b can take minutes and the fetch timeout
// is 180s, so the timer can be re-pointed at another client while the request
// is in flight. running=1 alone let a sentence written from matter A's history
// re-stamp itself onto a timer now pointing at client B (docs/ui/BRIEF.md,
// "Data integrity"). cm_id is captured before the request and re-checked in the
// WHERE clause, so a moved timer simply keeps whatever its new matter gave it.
export async function refineSuggestedNarrative({ db, clock }, timerId) {
  const cfg = getSetting(db, 'ai') || {};
  if (!cfg.enabled) return;
  const timer = db.prepare(
    'SELECT t.id, t.name, t.cm_id, m.short_name FROM timers t JOIN matters m ON m.id = t.cm_id WHERE t.id=?'
  ).get(timerId);
  if (!timer) return;
  // The matter this refinement is FOR, captured before a single byte goes out.
  const sourceCmId = timer.cm_id;
  const brief = `Matter: ${timer.short_name || timer.name}. Timer label: ${timer.name}. Draft the single most likely billing narrative for today's work session on this matter.`;
  const messages = buildNarrateMessages({
    instructions: cfg.systemPrompt,
    brief,
    context: matterAiContext(db, sourceCmId, todayLocal(clock ? clock() : new Date())),
    voice: buildVoiceContext(db, { cmId: sourceCmId, brief: timer.name }),
  });
  const resp = await fetch(`${cfg.url}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: cfg.model, stream: false, options: { temperature: 0.3 }, messages }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!resp.ok) return;
  const data = await resp.json();
  const text = String((data.message && data.message.content) || '')
    .trim().replace(/^["']|["']$/g, '').slice(0, 300);
  if (!text || text.includes('{')) return; // refuse JSON-ish garbage
  if (containsTimeAmounts(text)) return; // refuse invented durations — keep the phrasebook suggestion
  // THE OUTPUT-SIDE MATTER BOUNDARY. The prompt above is matter-scoped, but
  // that is a promise about the model's INPUT, and this value is stored with no
  // human in the loop: it becomes the AI stop chip, one tap from a bill. So the
  // answer itself is checked — if it names a party or document that belongs to
  // another matter and appears nowhere in this matter's own vocabulary, it is
  // refused outright and the timer keeps the deterministic phrasebook
  // suggestion. The brief allows exactly this ("offer generic phrasing or offer
  // nothing"); a borrowed sentence is the one outcome it does not allow.
  const foreign = foreignTerms(
    text,
    ownVocabulary(db, sourceCmId, [timer.name, timer.short_name, brief]),
    otherMatterVocabulary(db, sourceCmId),
  );
  if (foreign.length) return;
  // still running AND still the same matter — otherwise this sentence belongs
  // to a matter the timer has left, and writing it would be a cross-matter leak
  db.prepare('UPDATE timers SET suggested_narrative=? WHERE id=? AND running=1 AND cm_id IS ?')
    .run(text, timerId, sourceCmId);
}

// The model invents initials. Measured 2026-08-18 on the fine-tuned narrative
// model: given the note "pierce", with C. Pierce outside its context window, it
// wrote "R. Pierce" through PyTorch and "J. Pierce" through Ollama. Two of four
// sampled generations were wrong this way.
//
// This is the same output-side principle as foreignTerms above: the answer is
// checked, not trusted, because it lands one tap from a bill. Unlike a borrowed
// sentence, a wrong initial is repairable — matter_people knows the right one —
// so this corrects rather than refuses, and reports what it changed.
function rosterFor(db, cmId) {
  if (cmId == null) return [];
  return db.prepare(
    'SELECT name FROM matter_people WHERE matter_id = ? ORDER BY count DESC'
  ).all(cmId).map((r) => r.name);
}

function withRosterInitials(db, cmId, text) {
  const { text: fixed, fixes } = correctInitials(text, rosterFor(db, cmId));
  return { narrative: fixed, initial_fixes: fixes };
}

export function aiRouter({ db }) {
  const r = Router();

  r.get('/ai/status', async (req, res) => {
    const cfg = getSetting(db, 'ai') || {};
    const { reachable, models } = await checkOllamaReachable(cfg.url);
    res.json({
      enabled: !!cfg.enabled, model: cfg.model, url: cfg.url, reachable, models,
      systemPrompt: cfg.systemPrompt || '',
      defaultPrompt: DEFAULT_AI_INSTRUCTIONS,
    });
  });

  r.post('/ai/expand', async (req, res) => {
    const cfg = getSetting(db, 'ai') || {};
    if (!cfg.enabled) return res.status(400).json({ error: 'ai_disabled' });
    const b = req.body || {};
    // "Expand → split into tasks" seeds from whatever the narrative box shows,
    // and an AUTO narrative shows a task-billing parenthetical per clause. The
    // amounts are the app's own bookkeeping — the model is being asked about
    // the work, and `totalHours` already tells it the time (2026-08-11).
    const brief = stripTimeAmounts(String(b.brief || '').trim());
    if (!brief) return res.status(400).json({ error: 'Describe the work first.' });
    const totalHours = b.totalHours != null ? Number(b.totalHours) : null;

    // The caller sends `clauses` when the attorney has ALREADY divided the
    // work (an allocated narrative — see the entry editor). That switches the
    // request from "split this" to "rewrite each of these", which is the only
    // form llama3.1:8b answers reliably.
    const clauses = (Array.isArray(b.clauses) ? b.clauses : [])
      .map((c) => stripTimeAmounts(String(c || '').trim()))
      .filter(Boolean)
      .slice(0, 12);
    const rewriting = clauses.length >= 2;

    const codes = db.prepare(
      'SELECT name FROM task_codes WHERE active=1 ORDER BY sort_order, id').all().map((x) => x.name);
    const matterCtx = matterAiContext(db, b.cm_id, todayLocal(new Date()));
    const voice = buildVoiceContext(db, { cmId: b.cm_id, brief });

    let content;
    try {
      const resp = await fetch(`${cfg.url}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: cfg.model,
          stream: false,
          format: 'json',
          options: { temperature: 0.3 },
          messages: [
            // The voice block sits before the JSON contract so the format
            // rules stay last and closest to the request — the exemplars
            // teach register, the contract still owns the response shape.
            { role: 'system', content: systemPrompt(codes, cfg.systemPrompt, voice, { clauseCount: clauses.length }) + timeGroundingRule(totalHours) + (matterCtx ? NAME_RESOLUTION_RULE : '') },
            // The few-shot pairs, which this route built and then dropped on
            // the floor until 2026-08-11. /ai/narrate has always spliced them
            // in, and that is the whole reason plain Expand reads well while
            // Expand → split into tasks did not: the split was the ONLY AI
            // path in the app running with no demonstrations at all. Measured
            // on llama3.1:8b, adding them turned "draft psa; review loi; email
            // w client re title co comments" from two tasks (the email clause
            // silently gone) into three, properly expanded, and stopped the
            // model answering in gerunds and inventing a person who appears
            // nowhere in the brief. They go AFTER the system message for the
            // same reason as in buildNarrateMessages — prior exchanges to
            // imitate, not instructions to follow.
            ...voice.turns,
            {
              role: 'user',
              content: [
                matterCtx,
                rewriting
                  ? clauses.map((c, i) => `${i + 1}. ${c}`).join('\n')
                  : (totalHours
                    ? `Total time: ${totalHours} hours.\nWork done: ${brief}`
                    : `Work done: ${brief}`),
              ].filter(Boolean).join('\n\n'),
            },
          ],
        }),
        // 12B on CPU can be slow — generous timeout.
        signal: AbortSignal.timeout(180_000),
      });
      if (!resp.ok) throw new Error(`ollama returned ${resp.status}`);
      const data = await resp.json();
      content = data.message && data.message.content;
    } catch (e) {
      return res.status(502).json({
        error: 'ollama_unreachable',
        message: `Could not reach the local model: ${e.message}`,
      });
    }

    const parsed = parseJsonLoose(content);
    const rawTasks = parsed && Array.isArray(parsed.tasks) ? parsed.tasks : [];
    // The rewrite contract asks for tasks only — there is no narrative to
    // write, because the attorney already wrote it. The split contract still
    // has to produce one.
    const unusable = !parsed || (rewriting ? rawTasks.length === 0 : typeof parsed.narrative !== 'string');
    if (unusable) {
      return res.status(502).json({ error: 'ai_bad_response', message: 'Model returned unusable output — try again.' });
    }
    const tasks = rawTasks.slice(0, rewriting ? clauses.length : 8).map((t) => ({
      task_code: codes.includes(t.task_code) ? t.task_code : (codes[0] || ''),
      fragment: String(t.fragment || '').trim().slice(0, 400),
      share: Number(t.share) > 0 ? Number(t.share) : 0,
    }));
    // Split on the firm's billing increment, not a hardcoded tenth — otherwise
    // a quarter-hour firm gets task lines that don't add up to the entry total.
    const increment = (getSetting(db, 'rounding') || {}).increment || 0.1;
    const hours = totalHours && tasks.length
      ? allocateTenths(totalHours, tasks.map((t) => t.share), increment)
      : null;

    const split = withRosterInitials(db, b.cm_id,
      typeof parsed.narrative === 'string' ? parsed.narrative.trim() : '');
    res.json({
      narrative: split.narrative,
      initial_fixes: split.initial_fixes,
      tasks: tasks.map((t, i) => ({
        task_code: t.task_code,
        fragment: t.fragment,
        hours: hours ? hours[i] : null,
      })),
    });
  });

  // Streamed narrative (spec §6 "faster AI narration"): plain-text tokens as
  // NDJSON lines — {"token":"…"} per chunk, then {"done":true,"narrative":…}
  // — so the UI renders while llama3.1:8b grinds (~180s on CPU). Fails as
  // normal JSON before the first byte; as an {"error":…} line after.
  // Unlike /ai/expand this never asks for JSON output — token streams of a
  // JSON document aren't displayable, so the structured task-split flow keeps
  // the blocking endpoint and this one owns narrative-only generation.
  r.post('/ai/narrate', async (req, res) => {
    const cfg = getSetting(db, 'ai') || {};
    if (!cfg.enabled) return res.status(400).json({ error: 'ai_disabled' });
    const b = req.body || {};
    const mode = ['draft', 'regenerate', 'shorter', 'longer'].includes(b.mode) ? b.mode : 'draft';
    const brief = String(b.brief || '').trim();
    const narrative = String(b.narrative || '').trim();
    if ((mode === 'shorter' || mode === 'longer') ? !narrative : !brief) {
      return res.status(400).json({ error: 'Describe the work first.' });
    }
    const matterCtx = matterAiContext(db, b.cm_id, todayLocal(new Date()));
    const messages = buildNarrateMessages({
      instructions: cfg.systemPrompt, brief, narrative, mode,
      totalHours: b.totalHours,
      context: [b.context ? String(b.context).slice(0, 2000) : null, matterCtx]
        .filter(Boolean).join('\n\n') || null,
      voice: buildVoiceContext(db, { cmId: b.cm_id, brief: brief || narrative }),
    });

    // If the client goes away mid-stream (navigated off, or a regenerate
    // superseded this request), stop pulling tokens — otherwise Ollama keeps
    // generating for up to 180s with nobody reading. ServerResponse 'close'
    // fires on premature disconnect AND on normal completion; the
    // writableEnded guard limits the abort to the former.
    const upstream = new AbortController();
    res.on('close', () => { if (!res.writableEnded) upstream.abort(); });

    let resp;
    try {
      resp = await fetch(`${cfg.url}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: cfg.model, stream: true,
          // regenerate wants a *different* sample; rewrites stay conservative
          options: { temperature: mode === 'regenerate' ? 0.8 : 0.3 },
          messages,
        }),
        signal: AbortSignal.any([upstream.signal, AbortSignal.timeout(180_000)]),
      });
      if (!resp.ok || !resp.body) throw new Error(`ollama returned ${resp.status}`);
    } catch (e) {
      if (res.writableEnded || res.destroyed) return; // client already gone
      return res.status(502).json({
        error: 'ollama_unreachable',
        message: `Could not reach the local model: ${e.message}`,
      });
    }

    res.setHeader('content-type', 'application/x-ndjson');
    res.setHeader('cache-control', 'no-store');
    const send = (obj) => res.write(JSON.stringify(obj) + '\n');
    let full = '';
    try {
      let buf = '';
      // Stateful decoder: a multi-byte UTF-8 sequence (em dash, curly quote)
      // can straddle two network chunks; per-chunk toString() would corrupt
      // it to U+FFFD.
      const decoder = new TextDecoder('utf-8');
      for await (const chunk of resp.body) {
        buf += decoder.decode(chunk, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let data;
          try { data = JSON.parse(line); } catch { continue; }
          const token = data.message && data.message.content;
          if (token) { full += token; send({ token }); }
        }
      }
      decoder.decode(); // flush (NDJSON ends with \n, so nothing pending)
      const done = withRosterInitials(db, b.cm_id, full.trim());
      send({ done: true, narrative: done.narrative, initial_fixes: done.initial_fixes });
    } catch (e) {
      // Client-gone aborts land here too — never write to a dead socket.
      if (!res.writableEnded && !res.destroyed) {
        send({ error: 'ai_stream_failed', message: e.message });
      }
    }
    if (!res.writableEnded) res.end();
  });

  return r;
}
