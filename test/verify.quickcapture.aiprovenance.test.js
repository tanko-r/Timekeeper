// =========================================================================
// ADVERSARIAL VERIFICATION — claim: "Quick capture stores the model's own
// narrative as hand-written, feeding AI text back into the exemplar pool."
//
// Target chain, read end to end:
//   server/routes/quickcapture.js:43-46  — assigns the MODEL's sentence onto
//       parsed.narrative when the deterministic parse missed the action.
//   server/lib/quickcapture.js:158       — the returned shape is
//       { hours, task_code, person, topic, narrative, matterQuery, matches,
//         missing } — no provenance field, so the client has nothing to relay.
//   public/js/components/quickcapture.js:171-174 — file() posts exactly
//       { date, cm_id, narrative, tasks } and nothing else.
//   server/routes/entries.js:347         — `narrative_ai = b.narrative_ai ? 1
//       : 0`, so the omission stores 0 = "typed by hand".
//   server/routes/ai.js:161              — FINAL gates both prompt pools on
//       `narrative_ai = 0`, which the row now passes.
//
// EVERY TEST MARKED "PROOF:" IS WRITTEN TO FAIL ON THE CURRENT CODE.
// The assertion IS the specification (server/db.js:322-324 and
// docs/ui/BRIEF.md, "Data integrity"). Do NOT relax an assertion to make
// this file green. It goes green when quick capture marks the model's own
// narrative as the model's — i.e. the route reports provenance and the
// client relays it, exactly as entryeditor.js:342 and stopchips.js:427 do.
//
// DELIBERATELY NOT TESTED (shared by design, per the brief): the shortcut
// glossary / text expansions, SEED_PAIRS, REWRITE_SHOTS, and generic style
// prose. Those are reusable wording, not client facts.
//
// Nothing here reuses the claimant's harness: the stub model, the fixtures
// and the assertions are written from the source above. House fictional
// names only.
// =========================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { startTestServer } from './helpers.js';
import { setSetting } from '../server/db.js';
import { buildVoiceContext } from '../server/routes/ai.js';

// ── the sentence the model writes ────────────────────────────────────────
// A real billing narrative carries the three things that must never travel:
// a named counterparty, a named document, and the subject of the deal. This
// one is about Larkspur and only Larkspur.
const MODEL_NARRATIVE =
  'Review Larkspur escrow instructions and confer with P. Okafor regarding the holdback release deadline.';
// Strings that exist ONLY in that sentence — not in DEFAULT_AI_INSTRUCTIONS,
// not in SEED_PAIRS, not in REWRITE_SHOTS, not in the demo seed.
const LARKSPUR_FACTS = /Larkspur|Okafor|holdback/i;

// What the quick-capture LLM pass returns. Shape per buildLlmFillMessages
// (server/routes/quickcapture.js:80-83).
const STUB_FILL = JSON.stringify({
  hours: null,
  task_code: 'Review',
  person: 'P. Okafor',
  topic: 'escrow holdback release',
  narrative: MODEL_NARRATIVE,
});

function startStubOllama(chatBody) {
  return new Promise((resolve) => {
    const srv = createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        if (req.url.startsWith('/api/tags')) return res.end(JSON.stringify({ models: [{ name: 'llama3.1:8b' }] }));
        res.end(JSON.stringify({ message: { role: 'assistant', content: chatBody } }));
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve({
      url: `http://127.0.0.1:${srv.address().port}`,
      close: () => new Promise((r) => srv.close(r)),
    }));
  });
}

async function withServer(fn) {
  const t = await startTestServer();
  try { return await fn(t); } finally { await t.close(); }
}

const mkCm = async (t, cm_number, short_name, client_name) => {
  const r = await t.fetchJson('POST', '/api/cms', { cm_number, short_name, client_name });
  assert.equal(r.status, 201, `cm ${cm_number}: ${JSON.stringify(r.body)}`);
  return r.body;
};

// The exact sequence a lawyer performs: type a line, press "AI parse"
// (public/js/components/quickcapture.js:318 → requestParse(line, true) →
// POST /api/quickcapture { line, ai: true }), then press Enter, which is
// advance() → file() → POST /api/entries with the payload below verbatim.
async function quickCaptureAsTheUiDoes(t, { line, date }) {
  const qc = await t.fetchJson('POST', '/api/quickcapture', { line, ai: true });
  assert.equal(qc.status, 200, JSON.stringify(qc.body));
  const p = qc.body;
  assert.ok(p.matches.length > 0, `precondition: the line matched a matter (${line})`);
  assert.ok(p.hours != null, 'precondition: the line carried its own hours');
  assert.match(String(p.narrative || ''), LARKSPUR_FACTS,
    'precondition: the MODEL wrote the narrative that quick capture is about to file');

  // ── public/js/components/quickcapture.js:171-174, character for character ──
  const filed = await t.fetchJson('POST', '/api/entries', {
    date,
    cm_id: p.matches[0].id,
    narrative: p.narrative,
    tasks: [{ task_code: p.task_code || '', duration: p.hours, fragment: '' }],
  });
  assert.equal(filed.status, 201, JSON.stringify(filed.body));
  return { parsed: p, entryId: filed.body.id };
}

// ═══════════════════════════════════════════════════════════════════════
// 1. PROOF: the row lands with no provenance at all.
// ═══════════════════════════════════════════════════════════════════════
test('PROOF: a quick-capture narrative the MODEL wrote is stored as the attorney\'s own', async () => {
  const stub = await startStubOllama(STUB_FILL);
  await withServer(async (t) => {
    try {
      const larkspur = await mkCm(t, '610001-000001', 'Larkspur Escrow', 'Larkspur Holdings');
      setSetting(t.db, 'ai', { enabled: true, model: 'llama3.1:8b', url: stub.url });

      const { entryId } = await quickCaptureAsTheUiDoes(t,
        { line: 'larkspur escrow release .3', date: '2026-08-10' });

      const row = t.db.prepare(`SELECT cm_id, narrative, narrative_ai, ai_brief, ai_draft,
        narrative_manual, status FROM entries WHERE id=?`).get(entryId);

      // The narrative really is the model's, stored verbatim.
      assert.equal(row.cm_id, larkspur.id);
      assert.equal(row.narrative, MODEL_NARRATIVE);

      // server/db.js:323 — "narrative_ai = 1 → AI wrote it and it was
      // accepted untouched". Quick capture offers NO way to edit the
      // narrative before filing, so every narrative it files is accepted
      // untouched by construction.
      assert.equal(row.narrative_ai, 1,
        'the model wrote this sentence and the attorney never touched it — it must not be teaching material');
      // And no fallback trace either: nothing else records the provenance,
      // so the badge at entryeditor.js:1006 has nothing to show.
      assert.ok(row.ai_draft, 'ai_draft should preserve what the model actually wrote');
    } finally { await stub.close(); }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 2. PROOF: the flag is the ONLY difference. Same sentence, same matter,
//    same finalize — filed the quick-capture way it teaches every other
//    matter; filed the entry-editor way (narrative_ai: 1, per
//    entryeditor.js:342) it does not. This isolates the defect from the
//    separate question of whether the pool is matter-scoped.
// ═══════════════════════════════════════════════════════════════════════
async function promptForSiblingMatter(t, { sendProvenance }) {
  const larkspur = await mkCm(t, '610001-000001', 'Larkspur Escrow', 'Larkspur Holdings');
  const thornbury = await mkCm(t, '620002-000001', 'Thornbury Ground Lease', 'Thornbury Partners');

  const created = await t.fetchJson('POST', '/api/entries', {
    date: '2026-08-10',
    cm_id: larkspur.id,
    narrative: MODEL_NARRATIVE,
    tasks: [{ task_code: 'Review', duration: 0.3, fragment: '' }],
    ...(sendProvenance ? { narrative_ai: 1, ai_brief: 'larkspur escrow release' } : {}),
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const fin = await t.fetchJson('POST', `/api/entries/${created.body.id}/finalize`, { ack: true });
  assert.equal(fin.status, 200, `finalize: ${JSON.stringify(fin.body)}`);

  const stored = t.db.prepare('SELECT status, narrative_ai FROM entries WHERE id=?')
    .get(created.body.id);
  assert.equal(stored.status, 'finalized');

  // The prompt the app builds when the attorney next writes on the OTHER
  // matter (server/routes/ai.js buildVoiceContext).
  const ctx = buildVoiceContext(t.db, { cmId: thornbury.id, brief: 'rev lease' });
  return { stored, ctx, thornbury };
}

test('CONTROL: filed with narrative_ai=1 (the entry-editor path), the model\'s sentence stays out of the prompt', async () => {
  await withServer(async (t) => {
    const { stored, ctx } = await promptForSiblingMatter(t, { sendProvenance: true });
    assert.equal(stored.narrative_ai, 1, 'control precondition');
    const all = ctx.prompt + '\n' + ctx.turns.map((x) => x.content).join('\n');
    assert.doesNotMatch(all, LARKSPUR_FACTS,
      'control: the provenance flag keeps AI text out of the pools, exactly as designed');
  });
});

test('PROOF: filed the quick-capture way, the model\'s Larkspur sentence is taught while writing Thornbury', async () => {
  await withServer(async (t) => {
    const { stored, ctx } = await promptForSiblingMatter(t, { sendProvenance: false });
    assert.equal(stored.narrative_ai, 0, 'this is what quick capture stores today');
    const all = ctx.prompt + '\n' + ctx.turns.map((x) => x.content).join('\n');
    assert.doesNotMatch(all, LARKSPUR_FACTS,
      'a sentence naming Larkspur and P. Okafor must never appear in a prompt that writes Thornbury');
  });
});
