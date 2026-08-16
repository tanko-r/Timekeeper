// ════════════════════════════════════════════════════════════════════════
// ADVERSARIAL VERIFICATION — claim: "an in-flight AI suggestion for matter A
// lands on a timer after it is re-pointed to matter B"
// (server/routes/ai.js refineSuggestedNarrative(), the UPDATE at line 331).
//
// THESE TESTS ARE **EXPECTED TO FAIL** on ui-overhaul-2026-08 as of
// 2026-08-15. The failure IS the finding. Do not relax the assertions.
//
// Written independently of test/integrity.ai.test.js, and deliberately
// stricter about the setup: the claimant's version called
// refineSuggestedNarrative() by hand on a timer that was never started and
// then hand-wrote `UPDATE timers SET running=1` so the guard would pass.
// Everything below goes through the real HTTP routes a user's browser hits —
// POST /api/timers/:id/start (which fires the refinement itself,
// fire-and-forget) and PATCH /api/timers/:id (the re-point). No test-only
// writes to the timers table at all.
//
// House fictional names only (Verity / Northgate), per docs/ui/BRIEF.md.
// ════════════════════════════════════════════════════════════════════════
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { startTestServer } from './helpers.js';
import { setSetting } from '../server/db.js';

// Verity's client-facing facts: a named party and a named document. Anything
// matching this belongs to Verity's matter and nowhere else.
const VERITY_FACTS = /Verity|Okafor|Escrow Instructions/;

// What the stub model "writes" after reading Verity's history. Realistic
// output for the prompt that is actually sent (asserted below).
const VERITY_SUGGESTION =
  'Review Verity Escrow Instructions and confer with P. Okafor regarding release of funds.';

// A stub Ollama that parks /api/chat until release() is called, so the
// window between "request sent" and "response written back" is deterministic
// rather than a sleep race. Records every request body it received.
function startStubOllama(reply) {
  return new Promise((resolve) => {
    const state = { chats: [], received: 0 };
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
        state.received++;
        await gate;
        res.end(JSON.stringify({ message: { role: 'assistant', content: reply } }));
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

const until = async (fn, ms = 5000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 15));
  }
  return false;
};

async function makeCm(t, cm_number, short_name) {
  const r = await t.fetchJson('POST', '/api/cms', { cm_number, short_name });
  assert.equal(r.status, 201, `cm ${cm_number}: ${JSON.stringify(r.body)}`);
  return r.body;
}

// Only a finalized, hand-written entry counts as history for the prompt
// builders (server/routes/ai.js FINAL).
async function addEntry(t, cmId, date, narrative) {
  const r = await t.fetchJson('POST', '/api/entries', { date, cm_id: cmId, narrative });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  t.db.prepare("UPDATE entries SET status='finalized', ever_finalized=1 WHERE id=?")
    .run(r.body.id);
  return r.body;
}

// ════════════════════════════════════════════════════════════════════════
// THE REPRODUCTION. Everyday sequence: start the timer, notice it is on the
// wrong matter, re-point it. The slow local model answers afterwards.
// ════════════════════════════════════════════════════════════════════════
test('LEAK: a background AI suggestion built from Verity lands on the timer after it is re-pointed to Northgate', async () => {
  const stub = await startStubOllama(VERITY_SUGGESTION);
  const t = await startTestServer();
  try {
    // Two different clients, so this is the widest possible boundary.
    const verity = await makeCm(t, '200002-000001', 'Verity Merger');
    const northgate = await makeCm(t, '100001-000001', 'Northgate Ground Lease');

    // Verity has real history; Northgate has none.
    await addEntry(t, verity.id, '2026-08-01',
      'Review Verity Escrow Instructions and confer with P. Okafor regarding closing.');
    await addEntry(t, verity.id, '2026-08-02',
      'Draft revisions to Verity Escrow Instructions and email to P. Okafor.');

    setSetting(t.db, 'ai', { enabled: true, model: 'llama3.1:8b', url: stub.url });

    // 1. Start a timer on Verity through the real route. The route fires
    //    refineSuggestedNarrative() fire-and-forget and returns at once.
    const timer = (await t.fetchJson('POST', '/api/timers',
      { name: 'Verity', cm_id: verity.id })).body;
    const started = await t.fetchJson('POST', `/api/timers/${timer.id}/start`, {});
    assert.equal(started.status, 200, JSON.stringify(started.body));

    // 2. The model has the request and is thinking (llama3.1:8b on CPU takes
    //    tens of seconds to minutes; the route allows it 180).
    assert.ok(await until(() => stub.state.received > 0), 'stub Ollama received the chat request');

    // PROVENANCE: the prompt in flight is built from Verity's history, and
    // knows nothing about Northgate.
    const sent = JSON.stringify(stub.state.chats[0]);
    assert.match(sent, VERITY_FACTS, 'the in-flight prompt is built from Verity');
    assert.doesNotMatch(sent, /Northgate/, 'the in-flight prompt never mentions Northgate');

    // 3. The attorney notices the timer is on the wrong matter and re-points
    //    it — matter→matter re-pointing is explicitly supported.
    const moved = await t.fetchJson('PATCH', `/api/timers/${timer.id}`, { cm_id: northgate.id });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));

    // The re-point did exactly what it promises: the old matter's suggestion
    // is gone, and the timer is still running.
    const afterPatch = t.db.prepare(
      'SELECT cm_id, running, suggested_narrative FROM timers WHERE id=?').get(timer.id);
    assert.equal(afterPatch.cm_id, northgate.id);
    assert.equal(afterPatch.running, 1, 'a re-pointed timer keeps running');
    assert.equal(afterPatch.suggested_narrative, null,
      'PATCH clears the suggestion — "suggestion belonged to the old matter"');

    // 4. The local model finally answers.
    stub.release();
    await until(() => t.db.prepare('SELECT suggested_narrative s FROM timers WHERE id=?')
      .get(timer.id).s != null);

    // ── read the database directly ──────────────────────────────────────
    const row = t.db.prepare(
      'SELECT cm_id, running, suggested_narrative FROM timers WHERE id=?').get(timer.id);
    assert.equal(row.cm_id, northgate.id, 'the timer is on Northgate now');
    assert.doesNotMatch(String(row.suggested_narrative || ''), VERITY_FACTS,
      `a narrative written from Verity's history must never attach to a Northgate timer `
      + `(stored: ${JSON.stringify(row.suggested_narrative)})`);
  } finally {
    stub.release();
    await t.close();
    await stub.close();
  }
});

// ════════════════════════════════════════════════════════════════════════
// AND IT REACHES THE UI. The stop-chip sheet reads timer.suggested_narrative
// straight off GET /api/timers and offers it as the AI chip
// (public/js/components/stopchips.js:283). Same sequence, asserted through
// the API the browser actually calls, plus the entry the chip would write.
// ════════════════════════════════════════════════════════════════════════
test('LEAK: the re-pointed timer serves Verity\'s sentence as the AI stop chip for a Northgate entry', async () => {
  const stub = await startStubOllama(VERITY_SUGGESTION);
  const t = await startTestServer();
  try {
    const verity = await makeCm(t, '200002-000001', 'Verity Merger');
    const northgate = await makeCm(t, '100001-000001', 'Northgate Ground Lease');
    await addEntry(t, verity.id, '2026-08-01',
      'Review Verity Escrow Instructions and confer with P. Okafor regarding closing.');
    setSetting(t.db, 'ai', { enabled: true, model: 'llama3.1:8b', url: stub.url });

    const timer = (await t.fetchJson('POST', '/api/timers',
      { name: 'Verity', cm_id: verity.id })).body;
    await t.fetchJson('POST', `/api/timers/${timer.id}/start`, {});
    assert.ok(await until(() => stub.state.received > 0), 'stub Ollama received the chat request');

    const moved = await t.fetchJson('PATCH', `/api/timers/${timer.id}`, { cm_id: northgate.id });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));

    stub.release();
    await until(() => t.db.prepare('SELECT suggested_narrative s FROM timers WHERE id=?')
      .get(timer.id).s != null);

    // What the browser gets on its next poll.
    const list = await t.fetchJson('GET', '/api/timers');
    assert.equal(list.status, 200);
    const served = (list.body.timers || list.body).find((x) => x.id === timer.id);
    assert.equal(served.cm_id, northgate.id);
    assert.doesNotMatch(String(served.suggested_narrative || ''), VERITY_FACTS,
      `GET /api/timers serves Verity's sentence on a Northgate timer `
      + `(served: ${JSON.stringify(served.suggested_narrative)})`);

    // And the entry that timer is filling is a Northgate entry — so the chip
    // is offered as the narrative for Northgate's bill.
    const linked = t.db.prepare(
      'SELECT e.id, e.cm_id FROM entries e JOIN timers t ON t.linked_entry_id = e.id WHERE t.id=?')
      .get(timer.id);
    assert.equal(linked.cm_id, northgate.id, 'the timer is filling a Northgate entry');
  } finally {
    stub.release();
    await t.close();
    await stub.close();
  }
});
