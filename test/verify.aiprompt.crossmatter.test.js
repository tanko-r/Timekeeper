// =========================================================================
// ADVERSARIAL VERIFICATION — "every AI prompt carries other clients' real
// narratives" (claim under audit, docs/ui/BRIEF.md "Data integrity").
//
// EVERY TEST IN THIS FILE IS WRITTEN TO FAIL ON THE CURRENT CODE.
// They exist to PROVE a leak, not to pass. Do not "fix the test" — the
// assertion IS the specification:
//
//   "Where a prompt includes before/after narrative pairs as examples, those
//    pairs come from the same matter; where a matter has none, use fully
//    synthetic examples. Never put one client's or one matter's real
//    narrative into a prompt that writes another's."
//
// Written independently of test/integrity.suggestions.test.js so the finding
// rests on evidence produced by the verifier, not on the claimant's harness.
// Deliberately NOT tested here (shared by design, not a defect): the shortcut
// glossary / text expansions and generic style prose in the prompt.
//
// Every path is exercised through the real HTTP API on a real server over a
// temp database, with a stub Ollama that records the exact /api/chat body.
// =========================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { startTestServer } from './helpers.js';
import { setSetting, getSetting } from '../server/db.js';
import { buildVoiceContext } from '../server/routes/ai.js';

// House fictional names only (BRIEF: no real client/matter data in the repo).
const CM_A = '900001-000010'; // Northgate Partners — Harbor Lease
const CM_A2 = '900001-000020'; // Northgate Partners — Ridgeline Permit (sibling)
const CM_B = '900002-000010'; // Acme Holdings — Borealis Merger (other client)

// A whole client-facing sentence, unmistakably about ONE matter. Two proper
// nouns that exist nowhere else in the app, the prompts, or the seed data:
// "Harbor Lease" (the document) and "T. Vance" (the person). If either string
// turns up in a prompt written for another matter, a narrative has crossed a
// matter boundary.
const A_NARRATIVE =
  'Review and analyze Harbor Lease termination notice and confer with T. Vance regarding same.';
const A_BRIEF = 'rev harbor termination notice; conf w vance';
const LEAK_MARKERS = ['Harbor Lease', 'T. Vance'];

const mkCm = async (t, cm_number, short_name, client_name) =>
  (await t.fetchJson('POST', '/api/cms', { cm_number, short_name, client_name })).body;

async function withServer(fn) {
  const t = await startTestServer();
  try { return await fn(t); } finally { await t.close(); }
}

// Ordinary use: the attorney writes an entry with the AI (so ai_brief is
// recorded, exactly as public/js/components/entryeditor.js sends it), corrects
// the wording himself (narrative_ai = 0), and finalizes the day through the
// real endpoint. That is all it takes to enter both prompt pools.
async function seedFinalizedEntry(t, cmId, { narrative, ai_brief, date = '2026-08-10' }) {
  const e = (await t.fetchJson('POST', '/api/entries', {
    date, cm_id: cmId, narrative, ai_brief,
    tasks: [{ task_code: 'Review', duration: 0.6, fragment: '' }],
  })).body;
  const fin = await t.fetchJson('POST', `/api/entries/${e.id}/finalize`, { ack: true });
  assert.equal(fin.status, 200, `finalize failed: ${JSON.stringify(fin.body)}`);
  // Prove the row really is in the pool the prompt reads from.
  const row = t.db.prepare(
    'SELECT status, narrative_ai, ai_brief, narrative, cm_id FROM entries WHERE id=?').get(e.id);
  assert.equal(row.status, 'finalized');
  assert.equal(row.narrative_ai, 0);
  return { id: e.id, row };
}

// A stub Ollama that records the request body verbatim. `reply` may be a
// function of the recorded body, which lets one test model the documented
// failure mode (ai.js:69-73: "the model imports people and stock phrases from
// OTHER matters in the voice context").
function startStubOllama(reply) {
  return new Promise((resolve) => {
    const state = { chats: [] };
    const srv = createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/api/tags') {
        res.end(JSON.stringify({ models: [{ name: 'llama3.1:8b' }] }));
        return;
      }
      if (req.url !== '/api/chat') { res.statusCode = 404; res.end('{}'); return; }
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const chat = JSON.parse(body);
        state.chats.push(chat);
        const text = typeof reply === 'function' ? reply(chat) : reply;
        if (chat.stream) {
          res.setHeader('content-type', 'application/x-ndjson');
          res.write(JSON.stringify({ message: { role: 'assistant', content: text }, done: false }) + '\n');
          res.end(JSON.stringify({ message: { role: 'assistant', content: '' }, done: true }) + '\n');
        } else {
          res.end(JSON.stringify({ message: { role: 'assistant', content: text } }));
        }
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve({
      url: `http://127.0.0.1:${srv.address().port}`,
      state,
      last: () => state.chats[state.chats.length - 1],
      close: () => new Promise((r) => srv.close(r)),
    }));
  });
}

function assertNoLeak(haystack, what) {
  for (const marker of LEAK_MARKERS) {
    assert.ok(!String(haystack).includes(marker),
      `${what} contains "${marker}", which belongs to another matter.\n---\n${haystack}\n---`);
  }
}

// ---------------------------------------------------------------------------
// 1 — UNIT. buildVoiceContext for a matter of a DIFFERENT client with no
// history of its own. Every example in its prompt must be synthetic.
// ---------------------------------------------------------------------------
test('LEAK: voice context for one client is built from another client\'s narrative', () =>
  withServer(async (t) => {
    const a = await mkCm(t, CM_A, 'Harbor Lease', 'Northgate Partners');
    const b = await mkCm(t, CM_B, 'Borealis Merger', 'Acme Holdings');
    await seedFinalizedEntry(t, a.id, { narrative: A_NARRATIVE, ai_brief: A_BRIEF });

    const voice = buildVoiceContext(t.db, { cmId: b.id, brief: 'draft merger cert' });
    const turns = voice.turns.map((x) => `${x.role}: ${x.content}`).join('\n');

    assertNoLeak(turns, 'the few-shot turns for Acme Holdings / Borealis Merger');
    assertNoLeak(voice.prompt, 'the exemplar block for Acme Holdings / Borealis Merger');
    assertNoLeak(voice.rewritePrompt, 'the rewrite exemplar block for Borealis Merger');
  }));

// ---------------------------------------------------------------------------
// 2 — UNIT. Same client, two matters. The brief bans this too: "not between
// two matters of the SAME client."
// ---------------------------------------------------------------------------
test('LEAK: voice context for a sibling matter of the same client carries the sibling\'s narrative', () =>
  withServer(async (t) => {
    const a = await mkCm(t, CM_A, 'Harbor Lease', 'Northgate Partners');
    const a2 = await mkCm(t, CM_A2, 'Ridgeline Permit', 'Northgate Partners');
    await seedFinalizedEntry(t, a.id, { narrative: A_NARRATIVE, ai_brief: A_BRIEF });

    const voice = buildVoiceContext(t.db, { cmId: a2.id, brief: 'draft permit application' });
    assertNoLeak(voice.turns.map((x) => x.content).join('\n'),
      'the few-shot turns for Ridgeline Permit');
    assertNoLeak(voice.prompt, 'the exemplar block for Ridgeline Permit');
  }));

// ---------------------------------------------------------------------------
// 3 — UNIT. A matter WITH its own history is not protected either: the pools
// are unscoped, so its own narratives are merely sorted ahead of the others.
// ---------------------------------------------------------------------------
test('LEAK: a matter with its own history still gets another client\'s narrative in the prompt', () =>
  withServer(async (t) => {
    const a = await mkCm(t, CM_A, 'Harbor Lease', 'Northgate Partners');
    const b = await mkCm(t, CM_B, 'Borealis Merger', 'Acme Holdings');
    await seedFinalizedEntry(t, a.id, { narrative: A_NARRATIVE, ai_brief: A_BRIEF });
    await seedFinalizedEntry(t, b.id, {
      date: '2026-08-11',
      narrative: 'Draft certificate of merger and email to client regarding filing.',
      ai_brief: 'draft cert of merger; email client re filing',
    });

    const voice = buildVoiceContext(t.db, { cmId: b.id, brief: 'draft merger cert' });
    assertNoLeak(voice.turns.map((x) => x.content).join('\n'),
      'the few-shot turns for Borealis Merger (which has its own history)');
    assertNoLeak(voice.prompt, 'the exemplar block for Borealis Merger');
  }));

// ---------------------------------------------------------------------------
// 4 — END TO END, /api/ai/narrate. The bytes actually sent to the model.
// ---------------------------------------------------------------------------
test('LEAK: the /api/ai/narrate request body for one client quotes another client\'s narrative', async () => {
  const stub = await startStubOllama('Draft certificate of merger.');
  try {
    await withServer(async (t) => {
      setSetting(t.db, 'ai', { ...getSetting(t.db, 'ai'), enabled: true, url: stub.url });
      const a = await mkCm(t, CM_A, 'Harbor Lease', 'Northgate Partners');
      const b = await mkCm(t, CM_B, 'Borealis Merger', 'Acme Holdings');
      await seedFinalizedEntry(t, a.id, { narrative: A_NARRATIVE, ai_brief: A_BRIEF });

      const r = await t.fetchJson('POST', '/api/ai/narrate', {
        mode: 'draft', brief: 'draft merger cert', cm_id: b.id,
      });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assertNoLeak(JSON.stringify(stub.last().messages, null, 1),
        'the /api/ai/narrate body that writes Acme Holdings\' narrative');
    });
  } finally { await stub.close(); }
});

// ---------------------------------------------------------------------------
// 5 — END TO END, /api/ai/expand, BOTH contracts (split and rewrite).
// ---------------------------------------------------------------------------
test('LEAK: the /api/ai/expand request body (split contract) quotes another client\'s narrative', async () => {
  const stub = await startStubOllama(JSON.stringify({
    narrative: 'Draft certificate of merger.',
    tasks: [{ task_code: 'Draft', fragment: 'Draft certificate of merger', share: 1 }],
  }));
  try {
    await withServer(async (t) => {
      setSetting(t.db, 'ai', { ...getSetting(t.db, 'ai'), enabled: true, url: stub.url });
      const a = await mkCm(t, CM_A, 'Harbor Lease', 'Northgate Partners');
      const b = await mkCm(t, CM_B, 'Borealis Merger', 'Acme Holdings');
      await seedFinalizedEntry(t, a.id, { narrative: A_NARRATIVE, ai_brief: A_BRIEF });

      const r = await t.fetchJson('POST', '/api/ai/expand', {
        brief: 'draft merger cert', cm_id: b.id, totalHours: 0.5,
      });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assertNoLeak(JSON.stringify(stub.last().messages, null, 1),
        'the /api/ai/expand (split) body for Acme Holdings');
    });
  } finally { await stub.close(); }
});

test('LEAK: the /api/ai/expand request body (rewrite contract) quotes another client\'s narrative', async () => {
  const stub = await startStubOllama(JSON.stringify({
    tasks: [
      { task_code: 'Draft', fragment: 'Draft certificate of merger' },
      { task_code: 'Correspondence', fragment: 'Email client regarding filing' },
    ],
  }));
  try {
    await withServer(async (t) => {
      setSetting(t.db, 'ai', { ...getSetting(t.db, 'ai'), enabled: true, url: stub.url });
      const a = await mkCm(t, CM_A, 'Harbor Lease', 'Northgate Partners');
      const b = await mkCm(t, CM_B, 'Borealis Merger', 'Acme Holdings');
      await seedFinalizedEntry(t, a.id, { narrative: A_NARRATIVE, ai_brief: A_BRIEF });

      const r = await t.fetchJson('POST', '/api/ai/expand', {
        brief: 'draft cert of merger; email client re filing', cm_id: b.id, totalHours: 0.5,
        clauses: ['draft cert of merger', 'email client re filing'],
      });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assertNoLeak(JSON.stringify(stub.last().messages, null, 1),
        'the /api/ai/expand (rewrite) body for Acme Holdings');
    });
  } finally { await stub.close(); }
});

// ---------------------------------------------------------------------------
// 6 — THE CHAIN CLOSES, AND IT IS VISIBLE IN THE DATABASE.
//
// Starting a timer on Borealis Merger fires the background
// refineSuggestedNarrative, whose prompt carries Harbor Lease's sentence. The
// stub plays the documented failure mode (ai.js:69-73 — "the model imports
// people and stock phrases from OTHER matters in the voice context", measured
// 2/5 runs WITH the pairs) by echoing a phrase it found in its own prompt.
// The result is UPDATEd onto timers.suggested_narrative, which
// stopchips.js:283 renders as the ✦ chip: one tap writes it to the entry.
//
// Asserted on the row read straight out of the database.
// ---------------------------------------------------------------------------
test('LEAK: another matter\'s party lands in timers.suggested_narrative for this matter', async () => {
  // Only "imports a person from the voice context" — the same behaviour the
  // source comment records. Everything else in the reply is about Borealis.
  const stub = await startStubOllama((chat) => {
    const wire = JSON.stringify(chat.messages);
    return wire.includes('T. Vance')
      ? 'Draft certificate of merger and confer with T. Vance regarding same.'
      : 'Draft certificate of merger.';
  });
  try {
    await withServer(async (t) => {
      setSetting(t.db, 'ai', { ...getSetting(t.db, 'ai'), enabled: true, url: stub.url });
      const a = await mkCm(t, CM_A, 'Harbor Lease', 'Northgate Partners');
      const b = await mkCm(t, CM_B, 'Borealis Merger', 'Acme Holdings');
      await seedFinalizedEntry(t, a.id, { narrative: A_NARRATIVE, ai_brief: A_BRIEF });

      const timer = (await t.fetchJson('POST', '/api/timers',
        { name: 'Borealis Merger', cm_id: b.id })).body;
      await t.fetchJson('POST', `/api/timers/${timer.id}/start`);

      // refineSuggestedNarrative is fire-and-forget; wait for the write.
      const read = () => t.db.prepare(
        'SELECT suggested_narrative FROM timers WHERE id=?').get(timer.id).suggested_narrative;
      for (let i = 0; i < 100 && !read(); i++) {
        await new Promise((r) => setTimeout(r, 20));
      }

      // The stored row, read straight out of the database, comes first: it is
      // the strongest form of the finding — a persisted value on matter B
      // carrying a party who exists only on matter A.
      const stored = read();
      assertNoLeak(stored,
        `timers.suggested_narrative for timer #${timer.id} (matter ${b.id}, Borealis Merger)`);

      // The deterministic half: the prompt that produced it.
      const sent = stub.state.chats.map((c) => JSON.stringify(c.messages)).join('\n');
      assertNoLeak(sent, 'the background refine prompt for Borealis Merger');
    });
  } finally { await stub.close(); }
});
