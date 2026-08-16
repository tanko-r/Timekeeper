// ════════════════════════════════════════════════════════════════════════
// DATA-INTEGRITY PROOF TESTS — THESE ARE **EXPECTED TO FAIL** ON master
// AND ON ui-overhaul-2026-08 AS OF 2026-08-15.
//
// Every test in this file asserts a rule from docs/ui/BRIEF.md §"Data
// integrity". Each failure is a real, reproduced leak of one matter's
// client-facing narrative into the AI prompt that writes ANOTHER matter's
// narrative. Do NOT "fix" these tests by relaxing the assertion — the
// assertion IS the rule. They go green when the prompt builders are scoped.
//
// Findings write-up: docs/ui/integrity-ai.md
//
// House fictional names only (Northgate / Verity / Acme), per the brief.
// ════════════════════════════════════════════════════════════════════════
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { startTestServer } from './helpers.js';
import { setSetting } from '../server/db.js';
import {
  buildVoiceContext, matterAiContext, refineSuggestedNarrative, SEED_PAIRS,
} from '../server/routes/ai.js';

// ── fixtures ──────────────────────────────────────────────────────────────

async function withServer(fn) {
  const t = await startTestServer();
  try { return await fn(t); } finally { await t.close(); }
}

async function makeCm(t, cm_number, short_name) {
  const r = await t.fetchJson('POST', '/api/cms', { cm_number, short_name });
  assert.equal(r.status, 201, `cm ${cm_number}: ${JSON.stringify(r.body)}`);
  return r.body;
}

// Only a finalized, hand-written entry is teaching material (server/routes/
// ai.js FINAL), so fixtures have to be signed off the way David signs off.
function finalize(t, id) {
  t.db.prepare("UPDATE entries SET status='finalized', ever_finalized=1 WHERE id=?").run(id);
}

async function addEntry(t, cmId, date, narrative, extra = {}) {
  const r = await t.fetchJson('POST', '/api/entries',
    { date, cm_id: cmId, narrative, ...extra });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  finalize(t, r.body.id);
  return r.body;
}

// Narratives of an EXACT word count, so exemplar selection (which samples
// evenly across the sorted length range) is deterministic rather than lucky.
// The prose is filler; the point of every fixture is its PROVENANCE.
const PAD = ['alpha', 'beta', 'gamma', 'delta', 'epsilon',
  'zeta', 'eta', 'theta', 'iota', 'kappa', 'lambda', 'mu'];

function ofWords(head, words) {
  const need = words - head.length;
  assert.ok(need >= 0 && need <= PAD.length, `cannot build a ${words}-word narrative`);
  const text = [...head, ...PAD.slice(0, need)].join(' ') + '.';
  assert.equal(text.split(/\s+/).length, words, 'fixture word count');
  return text;
}

// The matter under the pen.
const NORTHGATE_HEAD = ['Review', 'Northgate', 'ground', 'lease', 'regarding'];
const northgate = (words) => ofWords(NORTHGATE_HEAD, words);

// A DIFFERENT CLIENT entirely. Carries the two things a narrative must never
// export: a named party and a named document.
const VERITY_HEAD = ['Review', 'Verity', 'Escrow', 'Instructions', 'and',
  'confer', 'with', 'P.', 'Okafor', 'regarding'];
const verity = (words) => ofWords(VERITY_HEAD, words);

// Anything matching this is Verity's client-facing sentence and belongs
// nowhere near a Northgate prompt.
const VERITY_FACTS = /Verity|Okafor|Escrow Instructions/;

async function seedVerity(t, cm, { withBriefs = false } = {}) {
  const briefs = ['drafted escrow instrs; call okafor',
    'tc w okafor re escrow release', 'emails w title co re verity closing'];
  const out = [];
  for (const [i, words] of [15, 17, 19].entries()) {
    out.push(await addEntry(t, cm.id, `2026-08-0${i + 1}`, verity(words),
      withBriefs ? { ai_brief: briefs[i] } : {}));
  }
  return out;
}

// ── stub Ollama ───────────────────────────────────────────────────────────
// `hold: true` parks every /api/chat request until release() is called, so a
// background refinement can be caught mid-flight deterministically.

function startStubOllama(reply, { hold = false } = {}) {
  return new Promise((resolve) => {
    const state = { chats: [], pending: 0 };
    let release;
    const gate = new Promise((r) => { release = r; });
    const srv = createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [] }));
      if (req.url !== '/api/chat') { res.statusCode = 404; return res.end('{}'); }
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', async () => {
        state.chats.push(JSON.parse(body));
        state.pending++;
        if (hold) await gate;
        const parsed = JSON.parse(body);
        if (parsed.stream) {
          res.setHeader('content-type', 'application/x-ndjson');
          res.end(JSON.stringify({ message: { role: 'assistant', content: reply }, done: true }) + '\n');
        } else {
          res.end(JSON.stringify({ message: { role: 'assistant', content: reply } }));
        }
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve({
      url: `http://127.0.0.1:${srv.address().port}`,
      state,
      release: () => release(),
      close: () => new Promise((r) => srv.close(r)),
    }));
  });
}

const until = async (fn, ms = 4000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 15));
  }
  return false;
};

// ════════════════════════════════════════════════════════════════════════
// CONTROL — passes today. Proves the harness and the fixtures are sound, so
// a failure below is the code and not the scaffolding.
// ════════════════════════════════════════════════════════════════════════

test('CONTROL: the hand-authored seed pairs belong to no client', () => {
  for (const p of SEED_PAIRS) {
    assert.equal(p.seed, true, 'a seed pair is flagged as synthetic');
    assert.doesNotMatch(p.narrative, VERITY_FACTS);
  }
});

// ════════════════════════════════════════════════════════════════════════
// LEAK 1 — the exemplar block is selected from the WHOLE DATABASE.
// server/routes/ai.js buildVoiceContext(): the `recent` query has no cm_id
// filter, and pickExemplars() samples evenly across the length range of
// own+recent combined. Another client's finished narratives are pasted into
// the prompt under the heading "The attorney's entries:".
// ════════════════════════════════════════════════════════════════════════

test('LEAK: exemplars in a Northgate prompt include another client\'s narratives', async () => {
  await withServer(async (t) => {
    const north = await makeCm(t, '100001-000001', 'Northgate Ground Lease');
    const other = await makeCm(t, '200002-000001', 'Verity Merger');
    // Northgate is a WELL-ESTABLISHED matter: eight of its own finalized,
    // house-voice narratives. It needs nothing borrowed.
    for (const [i, words] of [6, 7, 8, 9, 10, 11, 12, 13].entries()) {
      await addEntry(t, north.id, `2026-07-1${i}`, northgate(words));
    }
    await seedVerity(t, other);

    const v = buildVoiceContext(t.db, { cmId: north.id, brief: 'rev ground lease' });

    assert.doesNotMatch(v.prompt, VERITY_FACTS,
      'a prompt writing Northgate must not quote Verity\'s narratives');
    assert.doesNotMatch(v.rewritePrompt, VERITY_FACTS,
      'the rewrite prompt carries the same exemplar block');
  });
});

// ════════════════════════════════════════════════════════════════════════
// LEAK 2 — few-shot pairs are selected from the WHOLE DATABASE too.
// pickPairs() takes cmId as a SORT KEY, not a filter (server/lib/
// exemplars.js: `const matter = (cmId != null && b.cm_id === cmId) - …`).
// A matter with no history of its own does not fall back to SEED_PAIRS; it
// borrows the nearest other client's real (brief → narrative) pairs and
// splices them in as prior assistant turns for the model to imitate.
// ════════════════════════════════════════════════════════════════════════

test('LEAK: a brand-new matter is given another client\'s pairs instead of the seeds', async () => {
  await withServer(async (t) => {
    const fresh = await makeCm(t, '300003-000001', 'Acme Option');
    const other = await makeCm(t, '200002-000001', 'Verity Merger');
    await seedVerity(t, other, { withBriefs: true });

    const v = buildVoiceContext(t.db, { cmId: fresh.id, brief: 'rev option agmt' });
    const shown = v.turns.map((x) => x.content).join('\n');

    assert.doesNotMatch(shown, VERITY_FACTS,
      'a matter with no history gets synthetic seeds — never a live client\'s pairs');
  });
});

test('LEAK: pairs cross the client boundary even when the matter has plenty of its own', async () => {
  await withServer(async (t) => {
    const north = await makeCm(t, '100001-000001', 'Northgate Ground Lease');
    const other = await makeCm(t, '200002-000001', 'Verity Merger');
    // Six Northgate pairs — more than the six slots. Every one shares a lead
    // verb, which is enough for pickPairs' verb-diversity pass to skip five of
    // them and reach for another client's work to fill the gap.
    for (let i = 0; i < 6; i++) {
      await addEntry(t, north.id, `2026-07-1${i}`, northgate(8 + i),
        { ai_brief: `rev northgate exhibit ${i}` });
    }
    await seedVerity(t, other, { withBriefs: true });

    const v = buildVoiceContext(t.db, { cmId: north.id, brief: 'rev ground lease' });
    const shown = v.turns.map((x) => x.content).join('\n');

    assert.doesNotMatch(shown, VERITY_FACTS,
      'Northgate has six pairs of its own; none of the six slots may go to Verity');
  });
});

// ════════════════════════════════════════════════════════════════════════
// LEAK 3 — it reaches the wire. The same context is serialized into the
// body POSTed to Ollama, where the model can reproduce it verbatim.
// ════════════════════════════════════════════════════════════════════════

test('LEAK: another client\'s narrative is sent to the model on POST /api/ai/narrate', async () => {
  const stub = await startStubOllama('Review Northgate ground lease and email to client regarding same.');
  await withServer(async (t) => {
    try {
      const north = await makeCm(t, '100001-000001', 'Northgate Ground Lease');
      const other = await makeCm(t, '200002-000001', 'Verity Merger');
      for (const [i, words] of [6, 7, 8, 9, 10, 11, 12, 13].entries()) {
        await addEntry(t, north.id, `2026-07-1${i}`, northgate(words),
          { ai_brief: `rev northgate exhibit ${i}` });
      }
      await seedVerity(t, other, { withBriefs: true });
      setSetting(t.db, 'ai', { enabled: true, model: 'llama3.1:8b', url: stub.url });

      const r = await t.fetchJson('POST', '/api/ai/narrate',
        { brief: 'rev ground lease; email client', cm_id: north.id, mode: 'draft' });
      assert.equal(r.status, 200);

      const sent = JSON.stringify(stub.state.chats.at(-1));
      assert.doesNotMatch(sent, VERITY_FACTS,
        'nothing naming another client may be POSTed to the model writing Northgate');
    } finally { await stub.close(); }
  });
});

// ════════════════════════════════════════════════════════════════════════
// LEAK 4 — sibling-matter borrow inside the prompt.
// matterAiContext() (server/routes/ai.js) reads matterSuggestions(), which
// blends a SIBLING MATTER's phrases in when own history is thin, and then
// labels the whole blend "The attorney's recent work on this matter". The
// sibling's phrases are whole narratives and task fragments — real facts
// about a different matter, asserted to the model as this one's history,
// with NAME_RESOLUTION_RULE inviting it to reuse the names it finds there.
//
// NOT a claim that the phrasebook should be scoped per matter — the brief
// says sharing reusable wording is intended. The defect is narrower: this
// prompt drops the `source: 'client'` / `borrowed` distinction the rest of
// the app preserves, and states another matter's sentence as this one's.
// ════════════════════════════════════════════════════════════════════════

test('LEAK: a thin matter\'s prompt states a sibling matter\'s narrative as its own history', async () => {
  await withServer(async (t) => {
    // Same client (400004), two different matters.
    const thin = await makeCm(t, '400004-000001', 'Acme Wetland');
    const sibling = await makeCm(t, '400004-000002', 'Acme Rezone');
    for (const [i, words] of [10, 12, 14].entries()) {
      await addEntry(t, sibling.id, `2026-08-0${i + 1}`,
        ofWords(['Draft', 'Rezone', 'Application', 'and', 'confer', 'with',
          'R.', 'Calder', 'regarding'], words));
    }

    const ctx = matterAiContext(t.db, thin.id, '2026-08-14') || '';

    assert.doesNotMatch(ctx, /Rezone Application|Calder/,
      'the Wetland prompt may not present the Rezone matter\'s work as Wetland\'s history');
  });
});

// ════════════════════════════════════════════════════════════════════════
// LEAK 5 — a previous request's AI output lands on a re-pointed timer.
// refineSuggestedNarrative() resolves the timer's matter ONCE, before a
// call that can take 180s, then writes back guarded only by `running=1`.
// PATCH /api/timers/:id clears suggested_narrative when the matter changes
// ("suggestion belonged to the old matter") — but a refinement already in
// flight for the OLD matter overwrites that null afterwards. The text then
// surfaces as the AI stop chip on the NEW matter.
// ════════════════════════════════════════════════════════════════════════

test('LEAK: an in-flight AI suggestion for matter A lands on the timer after it moves to matter B', async () => {
  const LEAKED = 'Review Verity Escrow Instructions and confer with P. Okafor regarding release.';
  const stub = await startStubOllama(LEAKED, { hold: true });
  await withServer(async (t) => {
    try {
      const a = await makeCm(t, '200002-000001', 'Verity Merger');
      const b = await makeCm(t, '100001-000001', 'Northgate Ground Lease');
      setSetting(t.db, 'ai', { enabled: true, model: 'llama3.1:8b', url: stub.url });

      const timer = (await t.fetchJson('POST', '/api/timers',
        { name: 'Verity', cm_id: a.id })).body;
      // Kick the refinement off by hand — same call the start route makes
      // fire-and-forget, but awaitable so the race is deterministic.
      const inFlight = refineSuggestedNarrative({ db: t.db, clock: () => new Date() }, timer.id);
      assert.ok(await until(() => stub.state.pending > 0), 'stub received the chat request');

      // The attorney realises it was the wrong matter and re-points the timer.
      const moved = await t.fetchJson('PATCH', `/api/timers/${timer.id}`, { cm_id: b.id });
      assert.equal(moved.status, 200, JSON.stringify(moved.body));
      t.db.prepare('UPDATE timers SET running=1 WHERE id=?').run(timer.id);

      stub.release();
      await inFlight;

      const row = t.db.prepare('SELECT cm_id, suggested_narrative FROM timers WHERE id=?')
        .get(timer.id);
      assert.equal(row.cm_id, b.id, 'the timer is on Northgate now');
      assert.doesNotMatch(String(row.suggested_narrative || ''), VERITY_FACTS,
        'a suggestion written from Verity\'s history must never attach to Northgate');
    } finally { await stub.close(); }
  });
});

// ════════════════════════════════════════════════════════════════════════
// LEAK 6 — the reverse direction. Quick capture's AI-written narrative is
// filed with no provenance, so narrative_ai stays 0 and the model's own
// sentence about matter A joins the global exemplar pool — from where
// LEAK 1 hands it to every other matter.
// POST /api/quickcapture returns no AI flag, and public/js/components/
// quickcapture.js files `{ date, cm_id, narrative, tasks }` with nothing to
// mark it. Compare entryeditor.js, which does send narrative_ai.
// ════════════════════════════════════════════════════════════════════════

test('LEAK: an AI-written quick-capture narrative is stored as the attorney\'s own', async () => {
  const stub = await startStubOllama(JSON.stringify({
    hours: 0.3, task_code: 'Review', person: 'P. Okafor', topic: 'escrow release',
    narrative: 'Review Verity Escrow Instructions and confer with P. Okafor regarding release.',
  }));
  await withServer(async (t) => {
    try {
      const verityCm = await makeCm(t, '200002-000001', 'Verity Merger');
      await makeCm(t, '100001-000001', 'Northgate Ground Lease');
      setSetting(t.db, 'ai', { enabled: true, model: 'llama3.1:8b', url: stub.url });

      const qc = await t.fetchJson('POST', '/api/quickcapture',
        { line: '.3 verity escrow release', ai: true });
      assert.equal(qc.status, 200);
      assert.match(String(qc.body.narrative || ''), /Okafor/,
        'precondition: the model wrote this narrative');

      // Exactly what public/js/components/quickcapture.js posts.
      const filed = await t.fetchJson('POST', '/api/entries', {
        date: '2026-08-14', cm_id: verityCm.id, narrative: qc.body.narrative,
        tasks: [{ task_code: 'Review', duration: 0.3, fragment: '' }],
      });
      assert.equal(filed.status, 201, JSON.stringify(filed.body));

      const row = t.db.prepare('SELECT narrative_ai FROM entries WHERE id=?').get(filed.body.id);
      assert.equal(row.narrative_ai, 1,
        'the model wrote it and it was accepted untouched — it must not become teaching material');
    } finally { await stub.close(); }
  });
});
