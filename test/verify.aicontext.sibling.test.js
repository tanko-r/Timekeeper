// =========================================================================
// ADVERSARIAL VERIFICATION — claim: "matterAiContext asserts in the prompt
// that a sibling matter's narrative and people are 'this matter's'".
//
// EVERY TEST IN THIS FILE IS EXPECTED TO FAIL ON THE CURRENT CODE.
// They exist to PROVE a leak, not to pass. Do not "fix the test".
//
// Standard (docs/ui/BRIEF.md, "Data integrity"):
//   "A narrative written for matter A may never be shown as belonging to,
//    suggested for, pre-filled into, or written onto an entry for matter B.
//    Not across clients, and not between two matters of the SAME client."
//   "The AI prompts obey the same line. ... Never put one client's or one
//    matter's real narrative into a prompt that writes another's."
//
// NOT tested here, because it is shared BY DESIGN: the shortcut/text-expansion
// table, ghost text, and generic style guidance in the prompts.
//
// Written independently of test/integrity.suggestions.test.js so the evidence
// is first-hand: this file drives the REAL HTTP endpoints against a stub
// Ollama, captures the exact bytes on the wire, and then reads the sqlite
// rows directly to prove the sentence belongs to a different matter.
// =========================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { startTestServer } from './helpers.js';
import { setSetting, getSetting } from '../server/db.js';
import { matterAiContext } from '../server/routes/ai.js';
import { matterPeopleList, matterSuggestions } from '../server/routes/matters.js';

async function withServer(fn) {
  const t = await startTestServer();
  try { return await fn(t); } finally { await t.close(); }
}

const mkCm = async (t, cm_number, short_name, client_name) =>
  (await t.fetchJson('POST', '/api/cms', { cm_number, short_name, client_name })).body;

// House fictional names only (BRIEF: no real client/matter data in the repo).
// TWO MATTERS OF THE SAME CLIENT — the harder half of the rule.
const CM_HARBOR = '100001-000010';   // Northgate Partners — Harbor Lease (worked)
const CM_RIDGE = '100001-000020';    // Northgate Partners — Ridgeline Permit (cold)

// One client-facing sentence, unmistakably about Harbor Lease and nobody else.
// It names a document ("Harbor Lease termination notice") and a counterparty
// ("T. Vance"). If it surfaces anywhere near Ridgeline Permit, a narrative has
// crossed a matter boundary.
const HARBOR_NARRATIVE =
  'Review and analyze the Harbor Lease termination notice and confer with T. Vance regarding same.';

// Two matters, one client; Harbor worked once, Ridgeline never touched.
async function seed(t) {
  const harbor = await mkCm(t, CM_HARBOR, 'Harbor Lease', 'Northgate Partners');
  const ridge = await mkCm(t, CM_RIDGE, 'Ridgeline Permit', 'Northgate Partners');
  const entry = (await t.fetchJson('POST', '/api/entries', {
    date: '2026-08-10', cm_id: harbor.id, narrative: HARBOR_NARRATIVE,
    tasks: [{ task_code: 'Review', duration: 0.6, fragment: '' }],
  })).body;
  return { harbor, ridge, entry };
}

// ---------------------------------------------------------------------------
// STEP 1 — the two ingredients the claim names, checked separately so the
// mechanism is visible rather than inferred.
// ---------------------------------------------------------------------------
test('LEAK (ingredient): matterPeopleList hands a cold matter a sibling\'s counterparty', () =>
  withServer(async (t) => {
    const { ridge } = await seed(t);
    const names = matterPeopleList(t.db, ridge.id);
    assert.deepEqual(names, [],
      `Ridgeline Permit has no history, yet its roster is: ${JSON.stringify(names)}`);
  }));

test('LEAK (ingredient): matterSuggestions blends the sibling\'s whole narrative', () =>
  withServer(async (t) => {
    const { ridge } = await seed(t);
    const sugg = matterSuggestions(t.db, ridge.id, '2026-08-14');
    const texts = sugg.phrases.map((p) => p.text);
    assert.deepEqual(texts, [],
      `Ridgeline Permit's phrase list carries Harbor Lease's sentence: ${JSON.stringify(texts)}`);
  }));

// ---------------------------------------------------------------------------
// STEP 2 — THE CLAIM ITSELF. matterAiContext drops `source` and emits the
// borrowed sentence under a heading that asserts it is this matter's own work.
// ---------------------------------------------------------------------------
test('LEAK: matterAiContext labels a sibling matter\'s narrative as "this matter"', () =>
  withServer(async (t) => {
    const { ridge } = await seed(t);
    const ctx = matterAiContext(t.db, ridge.id, '2026-08-14') || '';
    assert.ok(!ctx.includes('Harbor Lease'),
      `prompt context built for Ridgeline Permit claims Harbor Lease's work as its own:\n---\n${ctx}\n---`);
  }));

// ---------------------------------------------------------------------------
// STEP 3 — END TO END, through the real HTTP route, capturing the exact
// request body sent to the model. This is what actually reaches the LLM when
// the lawyer presses the AI button on a Ridgeline Permit entry.
// ---------------------------------------------------------------------------
function startStubOllama(reply) {
  return new Promise((resolve) => {
    const state = { lastChat: null };
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
        state.lastChat = JSON.parse(body);
        if (state.lastChat.stream) {
          res.setHeader('content-type', 'application/x-ndjson');
          res.write(JSON.stringify({ message: { role: 'assistant', content: reply }, done: false }) + '\n');
          res.end(JSON.stringify({ message: { role: 'assistant', content: '' }, done: true }) + '\n');
        } else {
          res.end(JSON.stringify({ message: { role: 'assistant', content: reply } }));
        }
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve({
      url: `http://127.0.0.1:${srv.address().port}`,
      state,
      close: () => new Promise((r) => srv.close(r)),
    }));
  });
}

test('LEAK: POST /api/ai/narrate for the cold matter puts the sibling\'s sentence on the wire', async () => {
  const stub = await startStubOllama('Draft permit condition letter to County.');
  try {
    await withServer(async (t) => {
      setSetting(t.db, 'ai', { ...getSetting(t.db, 'ai'), enabled: true, url: stub.url });
      const { harbor, ridge, entry } = await seed(t);

      const r = await t.fetchJson('POST', '/api/ai/narrate', {
        mode: 'draft', brief: 'draft ltr re permit condition', cm_id: ridge.id,
      });
      assert.equal(r.status, 200);

      const messages = stub.state.lastChat.messages;
      const user = messages.filter((m) => m.role === 'user').map((m) => m.content).join('\n');

      // ---- read the DATABASE directly: whose sentence is this? ----
      const rows = t.db.prepare(
        'SELECT id, cm_id, narrative FROM entries WHERE narrative LIKE ?'
      ).all('%Harbor Lease termination notice%');
      const owner = rows.map((x) => x.cm_id);
      const detail = JSON.stringify({
        stored_rows: rows, entry_id: entry.id,
        harbor_matter_id: harbor.id, ridgeline_matter_id: ridge.id,
      });
      // Sanity: the sentence is stored against Harbor Lease and nothing else.
      assert.deepEqual(owner, [harbor.id], `precondition broken: ${detail}`);

      assert.ok(!user.includes('Harbor Lease'),
        'the AI request that writes RIDGELINE PERMIT\'s narrative carries HARBOR LEASE\'s\n'
        + `billing sentence in its user message.\nstored: ${detail}\n---\n${user}\n---`);
    });
  } finally {
    await stub.close();
  }
});

test('LEAK: POST /api/ai/expand for the cold matter puts the sibling\'s sentence on the wire', async () => {
  const stub = await startStubOllama(JSON.stringify({
    narrative: 'Draft letter to County regarding permit condition.',
    tasks: [{ task_code: 'Draft', fragment: 'Draft letter to County', share: 1 }],
  }));
  try {
    await withServer(async (t) => {
      setSetting(t.db, 'ai', { ...getSetting(t.db, 'ai'), enabled: true, url: stub.url });
      const { ridge } = await seed(t);

      const r = await t.fetchJson('POST', '/api/ai/expand', {
        brief: 'draft ltr re permit condition', cm_id: ridge.id, totalHours: 0.4,
      });
      assert.equal(r.status, 200);
      const wire = JSON.stringify(stub.state.lastChat.messages);
      assert.ok(!wire.includes('Harbor Lease'),
        `the /ai/expand request for Ridgeline Permit quotes Harbor Lease's narrative:\n${wire}`);
    });
  } finally {
    await stub.close();
  }
});

// ---------------------------------------------------------------------------
// STEP 3b — SCOPE OF THE MECHANISM, variation 1: it is NOT limited to cold
// matters. matterSuggestions blends siblings only when own history is thin
// (THIN_PHRASES = 5), but matterPeopleList blends ALWAYS — its own comment
// says so. So a mature matter with a full phrasebook still gets the sibling's
// counterparty listed under "People from this matter's history", and
// NAME_RESOLUTION_RULE then tells the model to resolve informal references
// against that roster.
// ---------------------------------------------------------------------------
test('LEAK: even a matter with a FULL history is given the sibling\'s counterparty', () =>
  withServer(async (t) => {
    const { ridge } = await seed(t);
    // Six of Ridgeline's own phrases — comfortably over THIN_PHRASES, so the
    // phrase blend switches off and only the people blend remains.
    for (const [i, n] of [
      'Prepare application for grading permit.',
      'Review County staff report on the permit condition.',
      'Draft response to notice of incomplete application.',
      'Analyze setback variance requirements.',
      'Prepare hearing outline for planning commission.',
      'Revise site plan exhibit for resubmittal.',
    ].entries()) {
      await t.fetchJson('POST', '/api/entries', {
        date: `2026-08-0${i + 1}`, cm_id: ridge.id, narrative: n,
        tasks: [{ task_code: 'Draft', duration: 0.3, fragment: '' }],
      });
    }
    const sugg = matterSuggestions(t.db, ridge.id, '2026-08-14');
    assert.equal(sugg.borrowed, false, 'precondition: phrase blend should be off now');

    const ctx = matterAiContext(t.db, ridge.id, '2026-08-14') || '';
    assert.ok(!ctx.includes('T. Vance'),
      `Ridgeline Permit has its own full history and STILL claims Harbor Lease's\n`
      + `counterparty as its own:\n---\n${ctx}\n---`);
  }));

// ---------------------------------------------------------------------------
// STEP 3c — SCOPE, variation 2: the boundary. matterAiContext's blend is
// scoped by client_id, so this particular mechanism does NOT reach across
// clients. Recorded so the finding is not overstated. THIS TEST SHOULD PASS.
// ---------------------------------------------------------------------------
test('BOUNDARY (expected to pass): matterAiContext does not cross a CLIENT boundary', () =>
  withServer(async (t) => {
    await seed(t);
    const borealis = await mkCm(t, '100002-000010', 'Borealis Merger', 'Acme Holdings');
    const ctx = matterAiContext(t.db, borealis.id, '2026-08-14') || '';
    assert.equal(ctx, '', `unexpected cross-client context:\n${ctx}`);
  }));

// ---------------------------------------------------------------------------
// STEP 4 — the ordinary-use path with no button press at all: starting a timer
// on the cold matter fires refineSuggestedNarrative(), which builds the same
// context and writes the model's answer to timers.suggested_narrative. Proves
// the context is reachable without the lawyer invoking anything named "AI".
// ---------------------------------------------------------------------------
test('LEAK: merely starting a timer on the cold matter sends the sibling\'s sentence to the model', async () => {
  const stub = await startStubOllama('Prepare permit condition summary.');
  try {
    await withServer(async (t) => {
      setSetting(t.db, 'ai', { ...getSetting(t.db, 'ai'), enabled: true, url: stub.url });
      const { ridge } = await seed(t);

      const timer = (await t.fetchJson('POST', '/api/timers',
        { name: 'Ridgeline Permit', cm_id: ridge.id })).body;
      await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
      // refineSuggestedNarrative is fire-and-forget — give it a tick to land.
      for (let i = 0; i < 50 && !stub.state.lastChat; i++) {
        await new Promise((r) => setTimeout(r, 20));
      }
      assert.ok(stub.state.lastChat, 'no model call was made on timer start');
      const wire = JSON.stringify(stub.state.lastChat.messages);
      assert.ok(!wire.includes('Harbor Lease'),
        `timer start on Ridgeline Permit sent Harbor Lease's narrative to the model:\n${wire}`);
    });
  } finally {
    await stub.close();
  }
});
