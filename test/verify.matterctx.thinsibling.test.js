// ═══════════════════════════════════════════════════════════════════════════
// ADVERSARIAL VERIFICATION — independent, first-hand.
//
// CLAIM UNDER TEST: "Matter-context block presents a sibling matter's
// narratives as this matter's own history."  server/routes/ai.js
// matterAiContext() lines 116-125, via matterSuggestions()
// (server/routes/matters.js:42-55).
//
// EVERY TEST BELOW THAT IS PREFIXED "LEAK:" IS **EXPECTED TO FAIL** ON
// ui-overhaul-2026-08 AS OF 2026-08-15. THE FAILURE IS THE EVIDENCE.
// Do NOT "fix the test" — the assertion IS the rule.
// Tests prefixed "BOUNDARY:" or "CONTROL:" are expected to PASS; they exist
// to keep the finding from being overstated.
//
// Standard — docs/ui/BRIEF.md, "Data integrity: non-negotiable":
//   "A narrative written for matter A may never be shown as belonging to,
//    suggested for, pre-filled into, or written onto an entry for matter B.
//    Not across clients, and not between two matters of the SAME client."
//   "Never put one client's or one matter's real narrative into a prompt
//    that writes another's."
//
// NOT tested here because the brief says it is shared BY DESIGN and is NOT a
// defect: the phrasebook / /api/matters/:id/suggestions endpoint itself, ghost
// text, text expansions (the `shortcuts` glossary), and the generic style
// guidance in DEFAULT_AI_INSTRUCTIONS / SEED_PAIRS. This file makes NO claim
// about those and proposes no change to matterSuggestions. The narrow question
// is whether matterAiContext, which alone drops the source/borrowed flag that
// every other consumer carries, asserts a SIBLING matter's real narrative to
// the model as facts about the matter being billed.
//
// House fictional names only (Acme / Northgate / Verity), per the brief.
// ═══════════════════════════════════════════════════════════════════════════
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { startTestServer } from './helpers.js';
import { setSetting, getSetting } from '../server/db.js';
import { matterAiContext } from '../server/routes/ai.js';
import { matterSuggestions, matterPeopleList } from '../server/routes/matters.js';

const TODAY = '2026-08-14';

async function withServer(fn) {
  const t = await startTestServer();
  try { return await fn(t); } finally { await t.close(); }
}

async function makeCm(t, cm_number, short_name, client_name) {
  const r = await t.fetchJson('POST', '/api/cms',
    { cm_number, short_name, ...(client_name ? { client_name } : {}) });
  assert.equal(r.status, 201, `cm ${cm_number}: ${JSON.stringify(r.body)}`);
  return r.body;
}

// Entries filed the ordinary way: through the real POST /api/entries, left as
// DRAFTS. Deliberately NOT finalized — matterSuggestions filters only on
// deleted_at, so the bar for this leak is "the lawyer typed one entry", not
// "the lawyer finalized a day".
async function addEntry(t, cmId, date, narrative, tasks) {
  const r = await t.fetchJson('POST', '/api/entries', {
    date, cm_id: cmId, narrative,
    tasks: tasks || [{ task_code: 'Draft', duration: 0.4, fragment: '' }],
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
}

// The claimant's exact fixture: client 400004, two matters of that ONE client.
const CLIENT = '400004';
const CM_WETLAND = `${CLIENT}-000001`;  // thin / cold — the matter being billed
const CM_REZONE = `${CLIENT}-000002`;   // worked — the matter that must not leak

// Whole client-facing sentences about the REZONE matter. Each names a document
// ("Rezone Application", "rezone hearing notice") and a counterparty
// ("R. Calder"). Anything matching REZONE_FACTS is Rezone's billing prose and
// belongs nowhere near a Wetland prompt.
const REZONE_NARRATIVES = [
  'Draft Rezone Application and confer with R. Calder regarding submittal deadline.',
  'Review R. Calder comments on the Rezone Application and revise narrative statement.',
  'Prepare rezone hearing notice for publication and transmit to R. Calder.',
];
const REZONE_FACTS = /Rezone Application|rezone hearing notice|Calder/;

async function seed(t) {
  const wetland = await makeCm(t, CM_WETLAND, 'Acme Wetland', 'Acme Holdings');
  const rezone = await makeCm(t, CM_REZONE, 'Acme Rezone', 'Acme Holdings');
  const filed = [];
  for (const [i, n] of REZONE_NARRATIVES.entries()) {
    filed.push(await addEntry(t, rezone.id, `2026-08-0${i + 1}`, n));
  }
  assert.notEqual(wetland.id, rezone.id);
  return { wetland, rezone, filed };
}

// Reads the sqlite rows directly and returns, for every stored narrative that
// matches REZONE_FACTS, the matter it is actually filed against. The claim is
// only confirmed if the text in the prompt belongs to a DIFFERENT matter row.
function ownersOfRezoneProse(t) {
  return t.db.prepare(`
    SELECT e.id AS entry_id, e.cm_id, m.short_name, m.cm_number, e.narrative
    FROM entries e JOIN matters m ON m.id = e.cm_id
    WHERE e.deleted_at IS NULL AND e.narrative REGEXP_LIKE_STUB IS NULL
  `.replace('AND e.narrative REGEXP_LIKE_STUB IS NULL', `AND (
       e.narrative LIKE '%Rezone Application%'
    OR e.narrative LIKE '%rezone hearing notice%'
    OR e.narrative LIKE '%Calder%')`)).all();
}

// ───────────────────────────────────────────────────────────────────────────
// STEP 0 — CONTROL. Prove the fixture is what it claims to be before any
// leak assertion runs: same client, different matters, prose filed ONLY
// against Rezone.
// ───────────────────────────────────────────────────────────────────────────
test('CONTROL (expected to pass): the Rezone prose is stored only against the Rezone matter', () =>
  withServer(async (t) => {
    const { wetland, rezone } = await seed(t);
    const rows = ownersOfRezoneProse(t);
    assert.equal(rows.length, REZONE_NARRATIVES.length, JSON.stringify(rows, null, 2));
    for (const r of rows) {
      assert.equal(r.cm_id, rezone.id,
        `stored against the wrong matter: ${JSON.stringify(r)}`);
      assert.notEqual(r.cm_id, wetland.id);
    }
    const client = t.db.prepare(`
      SELECT (SELECT client_id FROM matters WHERE id=?) AS a,
             (SELECT client_id FROM matters WHERE id=?) AS b`).get(wetland.id, rezone.id);
    assert.equal(client.a, client.b, 'fixture must be two matters of ONE client');
    // And Wetland genuinely has nothing of its own.
    assert.equal(t.db.prepare(
      'SELECT COUNT(*) c FROM entries WHERE cm_id=? AND deleted_at IS NULL').get(wetland.id).c, 0);
  }));

// ───────────────────────────────────────────────────────────────────────────
// STEP 1 — THE CLAIMED MECHANISM, in two halves, so it is observed and not
// inferred. matterSuggestions DOES mark the borrowed rows (source:'client',
// borrowed:true) — that is correct and is NOT the defect. matterAiContext
// then discards both and prints the rows under a heading that asserts they
// are this matter's own work.
// ───────────────────────────────────────────────────────────────────────────
test('CONTROL (expected to pass): matterSuggestions correctly LABELS the borrowed rows', () =>
  withServer(async (t) => {
    const { wetland } = await seed(t);
    const s = matterSuggestions(t.db, wetland.id, TODAY);
    assert.equal(s.borrowed, true, 'the blend is flagged at source');
    assert.ok(s.phrases.length > 0);
    for (const p of s.phrases) {
      assert.equal(p.source, 'client',
        `every Wetland phrase is borrowed: ${JSON.stringify(p)}`);
    }
  }));

test('LEAK: matterAiContext prints a sibling matter\'s narrative under "this matter"', () =>
  withServer(async (t) => {
    const { wetland } = await seed(t);
    const ctx = matterAiContext(t.db, wetland.id, TODAY) || '';

    // Show the heading verbatim in the failure so the assertion is unarguable.
    const heading = "The attorney's recent work on this matter:";
    const under = ctx.includes(heading) ? ctx.slice(ctx.indexOf(heading)) : '(heading absent)';

    assert.doesNotMatch(ctx, REZONE_FACTS,
      'the Acme Wetland prompt context states the Acme Rezone matter\'s billing\n'
      + `prose as Wetland's own history.\n--- context ---\n${ctx}\n--- block ---\n${under}\n---`);
  }));

test('LEAK: the source/borrowed flag every other consumer carries is dropped here', () =>
  withServer(async (t) => {
    const { wetland } = await seed(t);
    const s = matterSuggestions(t.db, wetland.id, TODAY);
    const ctx = matterAiContext(t.db, wetland.id, TODAY) || '';
    // Each borrowed phrase reaches the prompt as a bare "- <sentence>" bullet
    // with nothing distinguishing it from the matter's own work.
    const bare = s.phrases.slice(0, 6)
      .filter((p) => p.source === 'client' && ctx.includes(`- ${p.text}`));
    assert.equal(bare.length, 0,
      `${bare.length} phrase(s) marked source:'client' are emitted unmarked:\n`
      + bare.map((p) => `  - ${p.text}   [source=${p.source}]`).join('\n')
      + `\n--- context ---\n${ctx}\n---`);
  }));

// ───────────────────────────────────────────────────────────────────────────
// STEP 2 — ON THE WIRE. Everything above is a function call; this is what the
// model actually receives when the lawyer presses the AI button on a Wetland
// entry. Stub Ollama records the exact request body.
// ───────────────────────────────────────────────────────────────────────────
function startStubOllama(reply) {
  return new Promise((resolve) => {
    const state = { lastChat: null, calls: 0 };
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
        state.calls += 1;
        if (state.lastChat.stream) {
          res.setHeader('content-type', 'application/x-ndjson');
          res.write(JSON.stringify({ message: { role: 'assistant', content: reply } }) + '\n');
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

test('LEAK: POST /api/ai/narrate for the thin matter puts the sibling\'s sentence on the wire', async () => {
  const stub = await startStubOllama('Prepare wetland delineation summary.');
  try {
    await withServer(async (t) => {
      setSetting(t.db, 'ai', { ...getSetting(t.db, 'ai'), enabled: true, url: stub.url });
      const { wetland, rezone } = await seed(t);

      // Exactly what public/js/components/entryeditor.js aiNarrate() posts.
      const r = await t.fetchJson('POST', '/api/ai/narrate', {
        mode: 'draft', brief: 'rev wetland delineation; call re buffer',
        cm_id: wetland.id, totalHours: 0.4,
      });
      assert.equal(r.status, 200, JSON.stringify(r.body));

      const msgs = stub.state.lastChat.messages;
      const wire = JSON.stringify(msgs);

      // Read the DB directly: whose sentence is on the wire?
      const rows = ownersOfRezoneProse(t);
      const owners = [...new Set(rows.map((x) => x.cm_id))];
      assert.deepEqual(owners, [rezone.id],
        `precondition broken: ${JSON.stringify(rows, null, 2)}`);

      const userMsg = msgs.filter((m) => m.role === 'user').map((m) => m.content).join('\n---\n');
      assert.doesNotMatch(wire, REZONE_FACTS,
        'the request that writes ACME WETLAND\'s narrative carries ACME REZONE\'s\n'
        + `billing sentences.\nstored rows: ${JSON.stringify(rows, null, 2)}\n`
        + `--- user message ---\n${userMsg}\n---`);
    });
  } finally { await stub.close(); }
});

test('LEAK: POST /api/ai/expand for the thin matter puts the sibling\'s sentence on the wire', async () => {
  const stub = await startStubOllama(JSON.stringify({
    narrative: 'Review wetland delineation report.',
    tasks: [{ task_code: 'Review', fragment: 'Review wetland delineation report', share: 1 }],
  }));
  try {
    await withServer(async (t) => {
      setSetting(t.db, 'ai', { ...getSetting(t.db, 'ai'), enabled: true, url: stub.url });
      const { wetland } = await seed(t);

      const r = await t.fetchJson('POST', '/api/ai/expand', {
        brief: 'rev wetland delineation; call re buffer',
        cm_id: wetland.id, totalHours: 0.4,
      });
      assert.equal(r.status, 200, JSON.stringify(r.body));

      const wire = JSON.stringify(stub.state.lastChat.messages);
      assert.doesNotMatch(wire, REZONE_FACTS,
        `the /ai/expand request for Acme Wetland quotes Acme Rezone's narratives:\n${wire}`);
    });
  } finally { await stub.close(); }
});

// ───────────────────────────────────────────────────────────────────────────
// STEP 3 — VARIATION 1: the amplifier the claim names. NAME_RESOLUTION_RULE
// is appended to the system prompt WHENEVER this context exists, and it tells
// the model in so many words to resolve informal references using the names it
// finds in that history. So the sibling's counterparty is not merely present,
// it is nominated as the resolution target.
// ───────────────────────────────────────────────────────────────────────────
test('LEAK: the prompt instructs the model to resolve names against the borrowed history', async () => {
  const stub = await startStubOllama('Confer regarding wetland buffer.');
  try {
    await withServer(async (t) => {
      setSetting(t.db, 'ai', { ...getSetting(t.db, 'ai'), enabled: true, url: stub.url });
      const { wetland } = await seed(t);

      const r = await t.fetchJson('POST', '/api/ai/narrate', {
        // A first name with no surname anywhere in Wetland's own history —
        // precisely the input NAME_RESOLUTION_RULE tells the model to resolve.
        mode: 'draft', brief: 'call with rick re wetland buffer', cm_id: wetland.id,
      });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const msgs = stub.state.lastChat.messages;
      const system = msgs.find((m) => m.role === 'system').content;
      const user = msgs.filter((m) => m.role === 'user').map((m) => m.content).join('\n');

      const ruleOn = /use the matching name from that history/.test(system);
      const calderOffered = /Calder/.test(user) || /Calder/.test(system);
      assert.ok(!(ruleOn && calderOffered),
        'the system prompt tells the model to resolve "rick" against "this matter\'s\n'
        + 'history", and the history it is given is the SIBLING matter\'s roster:\n'
        + `  name-resolution rule present: ${ruleOn}\n  R. Calder offered: ${calderOffered}\n`
        + `--- user message ---\n${user}\n---`);
    });
  } finally { await stub.close(); }
});

// ───────────────────────────────────────────────────────────────────────────
// STEP 3b — VARIATION 2: is it only cold matters? matterSuggestions blends
// siblings only below THIN_PHRASES (5). Test the boundary at 4 own phrases —
// a matter the lawyer has genuinely worked, four separate days.
// ───────────────────────────────────────────────────────────────────────────
test('LEAK: a WORKED matter with four of its own narratives is still fed the sibling\'s', () =>
  withServer(async (t) => {
    const { wetland } = await seed(t);
    for (const [i, n] of [
      'Review wetland delineation report and prepare comment memorandum.',
      'Analyze buffer averaging alternatives under the critical areas ordinance.',
      'Prepare mitigation plan outline for agency review.',
      'Revise wetland exhibit for resubmittal.',
    ].entries()) {
      await addEntry(t, wetland.id, `2026-08-1${i}`, n);
    }
    const s = matterSuggestions(t.db, wetland.id, TODAY);
    assert.equal(s.phrases.filter((p) => p.source === 'matter').length, 4,
      'precondition: four own phrases, one under THIN_PHRASES');

    const ctx = matterAiContext(t.db, wetland.id, TODAY) || '';
    assert.doesNotMatch(ctx, REZONE_FACTS,
      'a worked matter with four of its own narratives is STILL handed the\n'
      + `sibling's:\n--- context ---\n${ctx}\n---`);
  }));

// ───────────────────────────────────────────────────────────────────────────
// STEP 3c — VARIATION 3: does the phrase leak switch off once the matter is
// no longer thin? It should — this narrows the finding. But the PEOPLE blend
// is unconditional (matters.js:61-79 says so in its own comment), so the
// sibling's counterparty survives even a full own history.
// ───────────────────────────────────────────────────────────────────────────
test('BOUNDARY (expected to pass): with 5+ own phrases the sibling NARRATIVES stop', () =>
  withServer(async (t) => {
    const { wetland } = await seed(t);
    for (const [i, n] of [
      'Review wetland delineation report and prepare comment memorandum.',
      'Analyze buffer averaging alternatives under the critical areas ordinance.',
      'Prepare mitigation plan outline for agency review.',
      'Revise wetland exhibit for resubmittal.',
      'Confer with agency biologist regarding site visit scheduling.',
      'Draft response to agency request for additional information.',
    ].entries()) {
      await addEntry(t, wetland.id, `2026-08-1${i}`, n);
    }
    const s = matterSuggestions(t.db, wetland.id, TODAY);
    assert.equal(s.borrowed, false, 'phrase blend is off above THIN_PHRASES');
    const ctx = matterAiContext(t.db, wetland.id, TODAY) || '';
    assert.doesNotMatch(ctx, /Rezone Application|rezone hearing notice/,
      `sibling narratives should be gone here:\n${ctx}`);
  }));

test('BOUNDARY (expected to pass): matterAiContext does not cross a CLIENT boundary', () =>
  withServer(async (t) => {
    await seed(t);
    const other = await makeCm(t, '100001-000010', 'Northgate Harbor Lease', 'Northgate Partners');
    const ctx = matterAiContext(t.db, other.id, TODAY) || '';
    assert.doesNotMatch(ctx, REZONE_FACTS,
      `unexpected cross-client leak via matterAiContext:\n${ctx}`);
  }));

// ───────────────────────────────────────────────────────────────────────────
// STEP 4 — ORDINARY USE, no AI button at all. Starting a timer on the thin
// matter fires refineSuggestedNarrative(), which builds the same context. The
// lawyer never types the word "AI"; he presses start.
// ───────────────────────────────────────────────────────────────────────────
test('LEAK: merely starting a timer on the thin matter sends the sibling\'s sentences to the model', async () => {
  const stub = await startStubOllama('Prepare wetland buffer summary.');
  try {
    await withServer(async (t) => {
      setSetting(t.db, 'ai', { ...getSetting(t.db, 'ai'), enabled: true, url: stub.url });
      const { wetland } = await seed(t);

      const timer = (await t.fetchJson('POST', '/api/timers',
        { name: 'Acme Wetland', cm_id: wetland.id })).body;
      const started = await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
      assert.equal(started.status, 200, JSON.stringify(started.body));
      // fire-and-forget — wait for the stub to be hit
      for (let i = 0; i < 100 && !stub.state.lastChat; i++) {
        await new Promise((r) => setTimeout(r, 20));
      }
      assert.ok(stub.state.lastChat, 'no model call was made on timer start');
      const wire = JSON.stringify(stub.state.lastChat.messages);
      assert.doesNotMatch(wire, REZONE_FACTS,
        `starting a timer on Acme Wetland sent Acme Rezone's narratives to the model:\n${wire}`);
    });
  } finally { await stub.close(); }
});

// ───────────────────────────────────────────────────────────────────────────
// STEP 5 — DOES IT LAND IN THE DATABASE? The strongest form of the rule is a
// stored row whose text belongs to another matter. If the model echoes the
// borrowed history it was told is "this matter's", the answer is written to
// timers.suggested_narrative — which is what the stop-timer chips offer.
// The stub stands in for llama3.1:8b doing exactly what the prompt told it.
// ───────────────────────────────────────────────────────────────────────────
test('LEAK: a model answer built from the borrowed history is stored on the thin matter\'s timer', async () => {
  // What an 8B plausibly returns when the prompt asserts these sentences are
  // this matter's recent work and asks for the likely next step.
  const ECHO = 'Confer with R. Calder regarding the Rezone Application.';
  const stub = await startStubOllama(ECHO);
  try {
    await withServer(async (t) => {
      setSetting(t.db, 'ai', { ...getSetting(t.db, 'ai'), enabled: true, url: stub.url });
      const { wetland, rezone } = await seed(t);

      const timer = (await t.fetchJson('POST', '/api/timers',
        { name: 'Acme Wetland', cm_id: wetland.id })).body;
      await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
      for (let i = 0; i < 100; i++) {
        const row = t.db.prepare('SELECT suggested_narrative s FROM timers WHERE id=?').get(timer.id);
        if (row && row.s) break;
        await new Promise((r) => setTimeout(r, 20));
      }
      const row = t.db.prepare(
        'SELECT cm_id, suggested_narrative FROM timers WHERE id=?').get(timer.id);
      assert.equal(row.cm_id, wetland.id);
      assert.doesNotMatch(String(row.suggested_narrative || ''), REZONE_FACTS,
        'a stop-timer suggestion naming the REZONE matter\'s document and party is\n'
        + `stored against the WETLAND timer (wetland=${wetland.id}, rezone=${rezone.id}):\n`
        + `  ${JSON.stringify(row)}`);
    });
  } finally { await stub.close(); }
});

// ───────────────────────────────────────────────────────────────────────────
// STEP 6 — ADJACENT FINDING, discovered while verifying the above and NOT
// part of the original claim. The test at STEP 5 failed with text that was
// NOT the stub's reply, which means no LLM wrote it.
//
// server/routes/timers.js:484-488 takes matterSuggestions().phrases and stores
// the top clean phrase verbatim as timers.suggested_narrative, WITHOUT
// consulting p.source — the same dropped flag, in a second place. AI is
// DISABLED here (the shipped default), so there is no model in the loop at
// all: the sibling's whole billing sentence is copied onto this matter's timer
// row by pressing start. public/js/components/stopchips.js:283 then offers
// that row as a stop chip.
//
// This is a defect against the brief's stop-chip rule ("If the matter has no
// prior narratives, offer generic phrasing or offer nothing — never another
// matter's sentence"), reported separately. It is recorded here only because
// it establishes that the sibling blend reaches a STORED ROW with no AI.
// ───────────────────────────────────────────────────────────────────────────
test('LEAK (adjacent, AI DISABLED): starting a timer copies the sibling\'s whole narrative onto the timer row', () =>
  withServer(async (t) => {
    assert.equal(getSetting(t.db, 'ai').enabled, false, 'AI is off — the shipped default');
    const { wetland, rezone } = await seed(t);

    const timer = (await t.fetchJson('POST', '/api/timers',
      { name: 'Acme Wetland', cm_id: wetland.id })).body;
    const started = await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
    assert.equal(started.status, 200, JSON.stringify(started.body));

    const row = t.db.prepare(
      'SELECT cm_id, suggested_narrative FROM timers WHERE id=?').get(timer.id);
    assert.equal(row.cm_id, wetland.id);

    // Whose sentence is it? Ask the entries table.
    const owner = t.db.prepare(`
      SELECT e.cm_id, m.short_name, m.cm_number FROM entries e
      JOIN matters m ON m.id = e.cm_id
      WHERE e.deleted_at IS NULL AND TRIM(e.narrative) LIKE ?
    `).all(`${String(row.suggested_narrative || ' ')}%`);

    assert.doesNotMatch(String(row.suggested_narrative || ''), REZONE_FACTS,
      'with NO AI anywhere in the loop, pressing start on the Acme Wetland timer\n'
      + 'stored the Acme Rezone matter\'s billing sentence on the Wetland timer row:\n'
      + `  timers.suggested_narrative = ${JSON.stringify(row.suggested_narrative)}\n`
      + `  that sentence is filed against: ${JSON.stringify(owner)}\n`
      + `  (wetland matter id=${wetland.id}, rezone matter id=${rezone.id})`);
  }));
