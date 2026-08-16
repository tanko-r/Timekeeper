// ════════════════════════════════════════════════════════════════════════
// ADVERSARIAL VERIFICATION — few-shot pair selection crosses the matter
// boundary. THESE TESTS ARE EXPECTED TO **FAIL** on ui-overhaul-2026-08 as
// of 2026-08-15. A failure here is the proof, not a bug in the test.
//
// Rule under test (docs/ui/BRIEF.md §"Data integrity"):
//   "Where a prompt includes before/after narrative pairs as examples, those
//    pairs come from the same matter; where a matter has none, use fully
//    synthetic examples. Never put one client's or one matter's real
//    narrative into a prompt that writes another's."
//
// Nothing here touches the phrasebook, ghost text, or text expansions —
// those are shared by design and are NOT under test.
//
// Every fixture is built through the real HTTP API on a real server over a
// temp database (test/helpers.js), and finalized through the real finalize
// endpoint, so the scenario is exactly what the attorney does day to day.
// House fictional names only (Northgate / Verity / Acme).
// ════════════════════════════════════════════════════════════════════════
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { startTestServer } from './helpers.js';
import { setSetting } from '../server/db.js';
import { buildVoiceContext, SEED_PAIRS } from '../server/routes/ai.js';

async function withServer(fn) {
  const t = await startTestServer();
  try { return await fn(t); } finally { await t.close(); }
}

async function makeCm(t, cm_number, short_name) {
  const r = await t.fetchJson('POST', '/api/cms', { cm_number, short_name });
  assert.equal(r.status, 201, `cm ${cm_number}: ${JSON.stringify(r.body)}`);
  return r.body;
}

// The ordinary path: type an entry, then finalize it. `ack:true` is the same
// "yes I meant that" the UI sends when validation only warns.
async function fileAndFinalize(t, cmId, date, { brief, narrative, hours = 0.4 }) {
  const created = await t.fetchJson('POST', '/api/entries', {
    date, cm_id: cmId, narrative, ai_brief: brief,
    tasks: [{ task_code: 'Review', duration: hours, fragment: '' }],
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const fin = await t.fetchJson('POST', `/api/entries/${created.body.id}/finalize`, { ack: true });
  assert.equal(fin.status, 200, JSON.stringify(fin.body));
  // Precondition: the row really is teaching material (FINAL in ai.js), the
  // narrative survived task-sync unchanged, and it is flagged as the
  // attorney's own writing rather than the model's.
  const row = t.db.prepare(
    'SELECT cm_id, narrative, ai_brief, status, narrative_ai, deleted_at FROM entries WHERE id=?'
  ).get(created.body.id);
  assert.equal(row.status, 'finalized');
  assert.equal(row.narrative_ai, 0);
  assert.equal(row.deleted_at, null);
  assert.equal(row.narrative, narrative, 'fixture narrative stored verbatim');
  assert.equal(row.ai_brief, brief);
  assert.equal(row.cm_id, cmId);
  return created.body.id;
}

// ── the two matters ───────────────────────────────────────────────────────
// Verity is a DIFFERENT CLIENT. Each of its narratives carries the two things
// a billing sentence must never export: a named counterparty and a named
// document.
const VERITY_WORK = [
  { brief: 'tc w okafor re escrow release',
    narrative: 'Telephone conference with P. Okafor regarding escrow release under Verity Escrow Instructions.' },
  { brief: 'drafted escrow instrs; email okafor',
    narrative: 'Draft Verity Escrow Instructions and email to P. Okafor regarding signature pages.' },
  { brief: 'emails w title co re verity closing',
    narrative: 'Email with title company regarding Verity closing timeline and P. Okafor comments.' },
];

// The attorney's briefs on one matter naturally repeat their lead verb —
// this is a week of "rev …" shorthand, not a contrivance.
const NORTHGATE_WORK = [
  { brief: 'rev northgate ground lease exhibit a',
    narrative: 'Review Northgate ground lease exhibit A regarding parking allocation.' },
  { brief: 'rev northgate estoppel from lender',
    narrative: 'Review Northgate estoppel certificate received from lender.' },
  { brief: 'rev northgate rent roll',
    narrative: 'Review Northgate rent roll and reconcile against ground lease schedule.' },
  { brief: 'rev northgate title commitment',
    narrative: 'Review Northgate title commitment and schedule B exceptions.' },
  { brief: 'rev northgate survey markup',
    narrative: 'Review Northgate survey markup and encroachment along the north boundary.' },
  { brief: 'rev northgate sncda draft',
    narrative: 'Review Northgate subordination and non-disturbance agreement draft.' },
];

// Anything matching this is Verity's client-facing sentence.
const VERITY_FACTS = /Verity|Okafor|Escrow Instructions/;

async function seedVerity(t, cm) {
  const ids = [];
  for (const [i, w] of VERITY_WORK.entries()) {
    ids.push(await fileAndFinalize(t, cm.id, `2026-08-0${i + 1}`, w));
  }
  return ids;
}

async function seedNorthgate(t, cm) {
  const ids = [];
  for (const [i, w] of NORTHGATE_WORK.entries()) {
    ids.push(await fileAndFinalize(t, cm.id, `2026-07-1${i}`, w));
  }
  return ids;
}

// The heart of the audit: take each narrative the prompt is about to show the
// model as a prior answer, and look it up in the database. If the row that
// owns that sentence is on a different matter than the prompt is writing for,
// that is the leak, named by row id.
function traceTurns(t, turns, promptCmId) {
  const foreign = [];
  for (const turn of turns) {
    if (turn.role !== 'assistant') continue;
    const row = t.db.prepare(
      'SELECT id, cm_id, date, narrative FROM entries WHERE narrative = ? AND deleted_at IS NULL'
    ).get(turn.content);
    if (row && row.cm_id !== promptCmId) foreign.push(row);
  }
  return foreign;
}

function describe(rows, t) {
  return rows.map((r) => {
    const m = t.db.prepare('SELECT cm_number, short_name FROM matters WHERE id=?').get(r.cm_id);
    return `  entries.id=${r.id} cm_id=${r.cm_id} (${m.cm_number} ${m.short_name}) ${JSON.stringify(r.narrative)}`;
  }).join('\n');
}

// ════════════════════════════════════════════════════════════════════════
// CONTROL — the harness and fixtures are sound.
// ════════════════════════════════════════════════════════════════════════

test('CONTROL: with only its own history, a matter\'s pairs are all its own', () =>
  withServer(async (t) => {
    const north = await makeCm(t, '100001-000001', 'Northgate Ground Lease');
    await seedNorthgate(t, north);
    const v = buildVoiceContext(t.db, { cmId: north.id, brief: 'rev ground lease' });
    assert.ok(v.turns.length > 0, 'precondition: pairs were built at all');
    assert.equal(traceTurns(t, v.turns, north.id).length, 0);
    assert.doesNotMatch(v.turns.map((x) => x.content).join('\n'), VERITY_FACTS);
  }));

test('CONTROL: the hand-authored seeds name no client', () => {
  for (const p of SEED_PAIRS) {
    assert.equal(p.seed, true);
    assert.doesNotMatch(p.narrative, VERITY_FACTS);
  }
});

// ════════════════════════════════════════════════════════════════════════
// LEAK A — a matter with NO history of its own is handed a live client's
// pairs, ahead of the synthetic seeds that exist for exactly this case.
// ════════════════════════════════════════════════════════════════════════

test('LEAK: a brand-new matter is given another client\'s pairs instead of the seeds', () =>
  withServer(async (t) => {
    const verityCm = await makeCm(t, '200002-000001', 'Verity Merger');
    await seedVerity(t, verityCm);
    const fresh = await makeCm(t, '300003-000001', 'Acme Option');

    // Precondition: the new matter has nothing of its own.
    const own = t.db.prepare('SELECT COUNT(*) n FROM entries WHERE cm_id=?').get(fresh.id).n;
    assert.equal(own, 0, 'precondition: the new matter has no entries');

    const v = buildVoiceContext(t.db, { cmId: fresh.id, brief: 'rev option agmt' });
    const foreign = traceTurns(t, v.turns, fresh.id);

    assert.equal(foreign.length, 0,
      `${foreign.length} of the ${v.turns.length / 2} few-shot pairs shown to the model `
      + `for matter ${fresh.cm_number} are rows belonging to another matter:\n${describe(foreign, t)}`);
  }));

// ════════════════════════════════════════════════════════════════════════
// LEAK B — the boundary is crossed even when the matter has MORE of its own
// pairs than there are slots. pickPairs' pass-1 verb-diversity filter keeps
// only the first same-matter pair per lead verb, and the freed slots go to
// another client before pass 2 comes back for the rest.
// ════════════════════════════════════════════════════════════════════════

test('LEAK: pairs cross the client boundary even when the matter has plenty of its own', () =>
  withServer(async (t) => {
    const north = await makeCm(t, '100001-000001', 'Northgate Ground Lease');
    const verityCm = await makeCm(t, '200002-000001', 'Verity Merger');
    await seedNorthgate(t, north);     // six of its own — more than the six slots
    await seedVerity(t, verityCm);

    const v = buildVoiceContext(t.db, { cmId: north.id, brief: 'rev ground lease' });
    const foreign = traceTurns(t, v.turns, north.id);

    assert.equal(foreign.length, 0,
      `Northgate has ${NORTHGATE_WORK.length} qualifying pairs of its own, yet `
      + `${foreign.length} of the ${v.turns.length / 2} slots hold another client's rows:\n`
      + describe(foreign, t));
  }));

// ════════════════════════════════════════════════════════════════════════
// LEAK C — it reaches the wire. The same pairs are serialized into the body
// POSTed to Ollama as {role:'assistant'} turns, i.e. handed to the model as
// its own prior answers, which is the strongest verbatim-reproduction path
// there is.
// ════════════════════════════════════════════════════════════════════════

function startStubOllama(reply) {
  return new Promise((resolve) => {
    const state = { chats: [] };
    const srv = createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [] }));
      if (req.url !== '/api/chat') { res.statusCode = 404; return res.end('{}'); }
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const parsed = JSON.parse(body);
        state.chats.push(parsed);
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
      close: () => new Promise((r) => srv.close(r)),
    }));
  });
}

test('LEAK: another client\'s narrative is POSTed to the model on /api/ai/narrate', async () => {
  const stub = await startStubOllama('Review Northgate ground lease and email to client regarding same.');
  await withServer(async (t) => {
    try {
      const north = await makeCm(t, '100001-000001', 'Northgate Ground Lease');
      const verityCm = await makeCm(t, '200002-000001', 'Verity Merger');
      await seedNorthgate(t, north);
      await seedVerity(t, verityCm);
      setSetting(t.db, 'ai', { enabled: true, model: 'llama3.1:8b', url: stub.url });

      const r = await t.fetchJson('POST', '/api/ai/narrate',
        { brief: 'rev ground lease; email client', cm_id: north.id, mode: 'draft' });
      assert.equal(r.status, 200, JSON.stringify(r.body));

      const sent = stub.state.chats.at(-1);
      const assistantTurns = sent.messages.filter((m) => m.role === 'assistant').map((m) => m.content);
      const foreign = assistantTurns.filter((c) => {
        const row = t.db.prepare('SELECT cm_id FROM entries WHERE narrative=? AND deleted_at IS NULL').get(c);
        return row && row.cm_id !== north.id;
      });
      assert.equal(foreign.length, 0,
        'the request body POSTed to Ollama while writing Northgate contains another '
        + `client's stored narratives as prior assistant turns:\n  ${foreign.join('\n  ')}`);
    } finally { await stub.close(); }
  });
});

test('LEAK: another client\'s narrative is POSTed to the model on /api/ai/expand', async () => {
  const stub = await startStubOllama(JSON.stringify({
    narrative: 'Review Northgate ground lease.',
    tasks: [{ task_code: 'Review', fragment: 'review Northgate ground lease', share: 1 }],
  }));
  await withServer(async (t) => {
    try {
      const north = await makeCm(t, '100001-000001', 'Northgate Ground Lease');
      const verityCm = await makeCm(t, '200002-000001', 'Verity Merger');
      await seedNorthgate(t, north);
      await seedVerity(t, verityCm);
      setSetting(t.db, 'ai', { enabled: true, model: 'llama3.1:8b', url: stub.url });

      const r = await t.fetchJson('POST', '/api/ai/expand',
        { brief: 'rev ground lease', cm_id: north.id, totalHours: 0.4 });
      assert.equal(r.status, 200, JSON.stringify(r.body));

      const sent = JSON.stringify(stub.state.chats.at(-1));
      assert.doesNotMatch(sent, VERITY_FACTS,
        'nothing naming another client may be POSTed to the model writing Northgate');
    } finally { await stub.close(); }
  });
});
