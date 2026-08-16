// =========================================================================
// ADVERSARIAL VERIFICATION — claim: "the exemplar block in the AI prompt is
// selected from the WHOLE database, not from the matter being written."
//
// Target: server/routes/ai.js buildVoiceContext(), lines 163-180. The `own`
// query is filtered by cm_id; the `recent` query is NOT filtered by anything
// (ORDER BY date DESC LIMIT 200 over every finalized, hand-written entry).
// The union goes to pickExemplars(), which sorts by WORD COUNT and samples
// evenly across that range — it never sees cm_id, so length alone decides.
//
// EVERY TEST MARKED "PROOF:" IS WRITTEN TO FAIL ON THE CURRENT CODE.
// The assertion IS the specification (docs/ui/BRIEF.md, "Data integrity"):
//   "Never put one client's or one matter's real narrative into a prompt
//    that writes another's."
// Do NOT relax an assertion to make this file green. It goes green when the
// exemplar pool is scoped to the matter (falling back to generic/synthetic
// phrasing where a matter has none).
//
// DELIBERATELY NOT TESTED (shared by design, per the brief): the shortcut
// glossary / text expansions, the hand-authored SEED_PAIRS, and generic
// style prose in the prompt. Those are reusable wording, not client facts.
//
// Fixtures are hand-authored, realistic billing narratives — NOT the
// claimant's greek-letter padding — filed and finalized through the real
// HTTP endpoints, so nothing here depends on the claimant's harness.
// House fictional names only.
// =========================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { startTestServer } from './helpers.js';
import { setSetting, getSetting } from '../server/db.js';
import { buildVoiceContext } from '../server/routes/ai.js';

// ── fixtures ──────────────────────────────────────────────────────────────

// Matter under the pen. Eight of its OWN finalized, house-voice narratives —
// spanning 6 to 15 words, so it needs nothing borrowed at any length.
const RIDGEWAY = [
  'Review Ridgeway ground lease estoppel certificate.',
  'Draft memorandum regarding Ridgeway ground lease renewal option.',
  'Review ground lease exhibits and email to client regarding same.',
  'Telephone conference with client regarding Ridgeway ground lease renewal notice.',
  'Draft revisions to ground lease amendment and transmit to client for signature.',
  'Review title commitment for Ridgeway parcel and email to client regarding survey exception.',
  'Draft estoppel certificate for ground lease and confer with client regarding delivery deadline.',
  'Review and analyze ground lease assignment and draft consent letter to landlord regarding proposed transfer.',
];

// A DIFFERENT CLIENT. Each sentence carries the three things a billing
// narrative exists to carry and that must never travel: a named counterparty,
// a named document, and the subject of the negotiation.
const HALBERD = [
  'Review Halberd Disclosure Schedules and confer with T. Marchetti regarding indemnity basket and survival period.',
  'Draft revisions to Halberd asset purchase agreement and email to T. Marchetti regarding working capital adjustment.',
  'Review Halberd Disclosure Schedules against diligence file and draft memorandum to T. Marchetti regarding open items.',
];

// Strings that exist ONLY in Halberd's narratives — not in the app's prompts,
// not in SEED_PAIRS, not in REWRITE_SHOTS, not in the demo seed. If one of
// these turns up in a prompt written for Ridgeway, a client-facing sentence
// has crossed a client boundary.
const HALBERD_FACTS = /Halberd|Marchetti|Disclosure Schedules/;

async function withServer(fn) {
  const t = await startTestServer();
  try { return await fn(t); } finally { await t.close(); }
}

const mkCm = async (t, cm_number, short_name, client_name) => {
  const r = await t.fetchJson('POST', '/api/cms', { cm_number, short_name, client_name });
  assert.equal(r.status, 201, `cm ${cm_number}: ${JSON.stringify(r.body)}`);
  return r.body;
};

// Ordinary use, end to end: the attorney files an entry with a narrative he
// wrote himself (narrative_ai stays 0) and finalizes it through the real
// endpoint. That is the entire qualification for both prompt pools
// (server/routes/ai.js FINAL).
async function fileAndFinalize(t, cmId, date, narrative) {
  const c = await t.fetchJson('POST', '/api/entries', {
    date, cm_id: cmId, narrative,
    tasks: [{ task_code: 'Review', duration: 0.5, fragment: '' }],
  });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  const f = await t.fetchJson('POST', `/api/entries/${c.body.id}/finalize`, { ack: true });
  assert.equal(f.status, 200, `finalize: ${JSON.stringify(f.body)}`);
  const row = t.db.prepare(
    'SELECT id, cm_id, status, narrative_ai, narrative FROM entries WHERE id=?').get(c.body.id);
  assert.equal(row.status, 'finalized');
  assert.equal(row.narrative_ai, 0);
  return row;
}

async function seedTwoClients(t) {
  const ridgeway = await mkCm(t, '710001-000001', 'Ridgeway Ground Lease', 'Ridgeway Partners');
  const halberd = await mkCm(t, '820002-000001', 'Halberd Asset Purchase', 'Halberd Industries');
  for (const [i, n] of RIDGEWAY.entries()) {
    await fileAndFinalize(t, ridgeway.id, `2026-07-1${i}`, n);
  }
  for (const [i, n] of HALBERD.entries()) {
    await fileAndFinalize(t, halberd.id, `2026-08-0${i + 1}`, n);
  }
  return { ridgeway, halberd };
}

// Pull the exemplar block back out of the prompt so a failure prints the
// offending lines and nothing else.
function exemplarLines(prompt) {
  const m = String(prompt).match(/The attorney's entries:\n([\s\S]*?)(?:\n\n|$)/);
  return m ? m[1].split('\n').filter(Boolean) : [];
}

function startStubOllama(reply) {
  return new Promise((resolve) => {
    const state = { chats: [] };
    const srv = createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [{ name: 'llama3.1:8b' }] }));
      if (req.url !== '/api/chat') { res.statusCode = 404; return res.end('{}'); }
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const chat = JSON.parse(body);
        state.chats.push(chat);
        if (chat.stream) {
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
      last: () => state.chats[state.chats.length - 1],
      close: () => new Promise((r) => srv.close(r)),
    }));
  });
}

// =========================================================================
// CONTROL — PASSES on current code. Proves the fixtures clear every quality
// gate in server/lib/exemplars.js and that the harness is sound, so a
// failure below is the code and not the scaffolding.
// =========================================================================

test('CONTROL: with only its own client in the database, Ridgeway gets only Ridgeway exemplars', () =>
  withServer(async (t) => {
    const ridgeway = await mkCm(t, '710001-000001', 'Ridgeway Ground Lease', 'Ridgeway Partners');
    for (const [i, n] of RIDGEWAY.entries()) {
      await fileAndFinalize(t, ridgeway.id, `2026-07-1${i}`, n);
    }
    const v = buildVoiceContext(t.db, { cmId: ridgeway.id, brief: 'rev ground lease' });
    const lines = exemplarLines(v.prompt);
    assert.equal(lines.length, 6, 'six exemplar slots are filled from its own history');
    assert.doesNotMatch(v.prompt, HALBERD_FACTS);
  }));

// =========================================================================
// PROOF 1 — the unit. EXPECTED TO FAIL.
// =========================================================================

test('PROOF: the exemplar block for Ridgeway quotes another client\'s narratives verbatim', () =>
  withServer(async (t) => {
    const { ridgeway } = await seedTwoClients(t);

    const v = buildVoiceContext(t.db, { cmId: ridgeway.id, brief: 'rev ground lease estoppel' });
    const lines = exemplarLines(v.prompt);
    const foreign = lines.filter((l) => HALBERD_FACTS.test(l));

    assert.deepEqual(foreign, [],
      `Ridgeway has eight finalized narratives of its own, yet ${foreign.length} of the `
      + `${lines.length} exemplars in its prompt belong to Halberd Industries.\n`
      + `--- The attorney's entries: ---\n${lines.join('\n')}\n------`);
  }));

// =========================================================================
// PROOF 2 — PROVENANCE, read straight out of the database. EXPECTED TO FAIL.
// For each exemplar line, look up the entry row it was copied from and check
// which matter that row actually belongs to. This is the form of the finding
// that cannot be argued with: a row whose cm_id is not the matter being
// written, whose narrative text is sitting in that matter's prompt.
// =========================================================================

test('PROOF: an exemplar in Ridgeway\'s prompt traces to an entry row owned by a different matter', () =>
  withServer(async (t) => {
    const { ridgeway, halberd } = await seedTwoClients(t);

    const v = buildVoiceContext(t.db, { cmId: ridgeway.id, brief: 'rev ground lease estoppel' });
    const lines = exemplarLines(v.prompt);

    const find = t.db.prepare(`
      SELECT e.id, e.cm_id, e.date, e.narrative, m.cm_number, m.short_name,
             COALESCE(c.name, '') AS client_name
      FROM entries e
      JOIN matters m ON m.id = e.cm_id
      LEFT JOIN clients c ON c.id = m.client_id
      WHERE e.narrative = ?`);
    const rows = lines.map((l) => find.get(l)).filter(Boolean);
    assert.equal(rows.length, lines.length, 'every exemplar traces to a stored entry row');

    const foreign = rows.filter((r) => r.cm_id !== ridgeway.id);
    const show = (r) => `  entry #${r.id} cm_id=${r.cm_id} (${r.cm_number} ${r.client_name} — `
      + `${r.short_name}) ${r.date}\n    "${r.narrative}"`;

    assert.deepEqual(foreign, [],
      `The prompt writing matter ${ridgeway.id} (710001-000001 Ridgeway Partners) was built from `
      + `${foreign.length} entry row(s) belonging to other matters `
      + `(Halberd is cm_id=${halberd.id}):\n${foreign.map(show).join('\n')}`);
  }));

// =========================================================================
// PROOF 2b — the leak is not a knife-edge sampling artifact. EXPECTED TO
// FAIL. pickExemplars() returns the pool WHOLE when it holds six or fewer
// usable narratives (server/lib/exemplars.js:115), which is the ordinary
// state of a young database: a new matter's first AI call is then handed
// EVERY other client's narrative in the app, unsampled.
// =========================================================================

test('PROOF: on a young database every other client\'s narrative goes into the prompt whole', () =>
  withServer(async (t) => {
    const ridgeway = await mkCm(t, '710001-000001', 'Ridgeway Ground Lease', 'Ridgeway Partners');
    const halberd = await mkCm(t, '820002-000001', 'Halberd Asset Purchase', 'Halberd Industries');
    await fileAndFinalize(t, ridgeway.id, '2026-07-10', RIDGEWAY[0]);
    for (const [i, n] of HALBERD.entries()) {
      await fileAndFinalize(t, halberd.id, `2026-08-0${i + 1}`, n);
    }

    const v = buildVoiceContext(t.db, { cmId: ridgeway.id, brief: 'rev ground lease estoppel' });
    const lines = exemplarLines(v.prompt);
    const foreign = lines.filter((l) => HALBERD_FACTS.test(l));

    assert.deepEqual(foreign, [],
      `${foreign.length} of the ${lines.length} exemplars written into Ridgeway's prompt are `
      + `Halberd Industries' (cm_id=${halberd.id}) client-facing sentences.\n`
      + `--- The attorney's entries: ---\n${lines.join('\n')}\n------`);
  }));

// =========================================================================
// PROOF 3 — it reaches the wire. EXPECTED TO FAIL.
// The bytes actually POSTed to the model on the two live endpoints and in
// all four narrate modes. Whatever the prose rule "Take only their shape"
// (ai.js:38) is worth, this is what the model is handed.
// =========================================================================

test('PROOF: POST /api/ai/narrate for Ridgeway sends another client\'s narrative to the model', async () => {
  const stub = await startStubOllama('Review Ridgeway ground lease estoppel certificate.');
  try {
    await withServer(async (t) => {
      const { ridgeway } = await seedTwoClients(t);
      setSetting(t.db, 'ai', { ...getSetting(t.db, 'ai'), enabled: true, url: stub.url });

      const offenders = [];
      for (const [mode, body] of [
        ['draft', { brief: 'rev estoppel cert; email client' }],
        ['regenerate', { brief: 'rev estoppel cert; email client' }],
        ['shorter', { narrative: 'Review and analyze the ground lease estoppel certificate.' }],
        ['longer', { narrative: 'Review estoppel certificate.' }],
      ]) {
        const r = await t.fetchJson('POST', '/api/ai/narrate',
          { mode, cm_id: ridgeway.id, ...body });
        assert.equal(r.status, 200, `${mode}: ${JSON.stringify(r.body)}`);
        const wire = JSON.stringify(stub.last().messages, null, 1);
        if (HALBERD_FACTS.test(wire)) {
          offenders.push(`${mode}: ${(wire.match(/[^"\\]*(?:Halberd|Marchetti)[^"\\]*/g) || []).join(' | ')}`);
        }
      }

      assert.deepEqual(offenders, [],
        `Halberd Industries' narratives were POSTed to the model writing Ridgeway:\n`
        + offenders.join('\n'));
    });
  } finally { await stub.close(); }
});

test('PROOF: POST /api/ai/expand for Ridgeway sends another client\'s narrative to the model', async () => {
  const stub = await startStubOllama(JSON.stringify({
    narrative: 'Review Ridgeway ground lease estoppel certificate.',
    tasks: [{ task_code: 'Review', fragment: 'Review estoppel certificate', share: 1 }],
  }));
  try {
    await withServer(async (t) => {
      const { ridgeway } = await seedTwoClients(t);
      setSetting(t.db, 'ai', { ...getSetting(t.db, 'ai'), enabled: true, url: stub.url });

      const r = await t.fetchJson('POST', '/api/ai/expand',
        { brief: 'rev estoppel cert', cm_id: ridgeway.id, totalHours: 0.4 });
      assert.equal(r.status, 200, JSON.stringify(r.body));

      const wire = JSON.stringify(stub.last().messages, null, 1);
      assert.doesNotMatch(wire, HALBERD_FACTS,
        `the /api/ai/expand body for Ridgeway carries Halberd's narratives:\n${wire}`);
    });
  } finally { await stub.close(); }
});
