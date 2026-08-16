// ADVERSARIAL VERIFICATION — independent reproduction of the claim:
//   "POST /api/entries/:id/copy launders AI provenance off a narrative and
//    feeds model output back as the attorney's voice."
//
// These tests are written to FAIL while the defect exists. Do not "fix" them
// by relaxing the assertions — the fix belongs in
// server/routes/entries.js POST /:id/copy (the INSERT at ~line 473, which
// lists narrative_manual but omits narrative_ai, ai_brief and ai_draft).
//
// Test 3 is a CONTROL and is expected to PASS: it proves the exemplar filter
// works on the source entry, so the copy is the laundering channel and not a
// filter that never worked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';
import { buildVoiceContext } from '../server/routes/ai.js';

// 13 words, ends with a period, no filler markers, no dangling connector —
// clears isUsableExemplar() and looksLikeHouseVoice() so the ONLY thing that
// can keep it out of the exemplar pool is narrative_ai = 1.
const AI_TEXT =
  'Review and analyze the escrow schedule and confer with J. Larson regarding closing.';

async function withServer(fn) {
  const t = await startTestServer();
  try {
    const a = (await t.fetchJson('POST', '/api/cms', {
      cm_number: '100001-000012', short_name: 'Acme lease', billable: 1,
    })).body;
    const b = (await t.fetchJson('POST', '/api/cms', {
      cm_number: '100002-000030', short_name: 'Northgate merger', billable: 1,
    })).body;
    await fn(t, a, b);
  } finally { await t.close(); }
}

// Creates a draft entry on `cm` whose narrative is model output the attorney
// accepted untouched: narrative_ai = 1, with the brief and the raw draft kept.
async function makeAiEntry(t, cm, date) {
  const r = await t.fetchJson('POST', '/api/entries', {
    date, cm_id: cm.id,
    narrative: AI_TEXT,
    narrative_ai: 1,
    ai_brief: 'rev escrow sched; call larson',
    ai_draft: AI_TEXT,
    tasks: [{ task_code: 'Review', duration: 0.5, fragment: '' }],
  });
  assert.equal(r.status, 201, 'setup: AI entry created');
  return r.body;
}

test('REPRO 1 (expected to FAIL): copy must carry narrative_ai / ai_brief / ai_draft', () =>
  withServer(async (t, a) => {
    const src = await makeAiEntry(t, a, '2026-08-10');

    // Confirm the source really is stored as model output before copying.
    const srcRow = t.db.prepare(
      'SELECT cm_id, narrative, narrative_ai, ai_brief, ai_draft FROM entries WHERE id=?'
    ).get(src.id);
    assert.equal(srcRow.narrative_ai, 1, 'setup: source stored as AI-written');
    assert.equal(srcRow.ai_brief, 'rev escrow sched; call larson');
    assert.equal(srcRow.ai_draft, AI_TEXT);

    const copy = await t.fetchJson('POST', `/api/entries/${src.id}/copy`, { date: '2026-08-11' });
    assert.equal(copy.status, 201, 'copy created');

    // Read the row straight out of SQLite — not the API projection.
    const row = t.db.prepare(
      'SELECT cm_id, narrative, narrative_ai, ai_brief, ai_draft FROM entries WHERE id=?'
    ).get(copy.body.id);

    // The copied narrative is byte-identical model output on the same matter…
    assert.equal(row.narrative, AI_TEXT, 'copy carries the same narrative text');
    assert.equal(row.cm_id, srcRow.cm_id, 'copy stays on the source matter');

    // …so its provenance must survive the copy.
    assert.equal(row.narrative_ai, 1,
      'DEFECT: the copy of AI-written text is stored as the attorney\'s own (narrative_ai=0)');
    assert.equal(row.ai_brief, srcRow.ai_brief,
      'DEFECT: the shorthand behind the narrative is dropped by copy');
    assert.equal(row.ai_draft, srcRow.ai_draft,
      'DEFECT: the model\'s original draft is dropped by copy, so a later correction yields no labelled pair');
  }));

test('REPRO 2 (expected to FAIL): a finalized copy of AI text must stay out of the exemplar pool', () =>
  withServer(async (t, a, b) => {
    const src = await makeAiEntry(t, a, '2026-08-10');
    const copy = (await t.fetchJson('POST', `/api/entries/${src.id}/copy`, { date: '2026-08-11' })).body;

    // Finalizing is the only signal the voice layer accepts. Both entries get
    // finalized, exactly as a working day ends.
    assert.equal((await t.fetchJson('POST', `/api/entries/${src.id}/finalize`, { ack: true })).status, 200);
    assert.equal((await t.fetchJson('POST', `/api/entries/${copy.id}/finalize`, { ack: true })).status, 200);

    const rows = t.db.prepare(
      'SELECT id, cm_id, narrative_ai FROM entries ORDER BY id').all();

    // Same matter: the model's own sentence must not come back as the voice.
    const own = buildVoiceContext(t.db, { cmId: a.id, brief: 'rev escrow sched' });
    assert.ok(!own.prompt.includes(AI_TEXT),
      `DEFECT: AI output taught back as the attorney's voice on its own matter.\nrows=${JSON.stringify(rows)}\nprompt=${own.prompt}`);

    // Different matter, different client: matter A's AI-written sentence must
    // not appear in the prompt that writes matter B's narrative.
    const other = buildVoiceContext(t.db, { cmId: b.id, brief: 'rev escrow sched' });
    assert.ok(!other.prompt.includes(AI_TEXT),
      `DEFECT: matter A's AI-written narrative is in the prompt for matter B.\nprompt=${other.prompt}`);
  }));

test('CONTROL (expected to PASS): the source AI entry alone never reaches the exemplar pool', () =>
  withServer(async (t, a) => {
    const src = await makeAiEntry(t, a, '2026-08-10');
    assert.equal((await t.fetchJson('POST', `/api/entries/${src.id}/finalize`, { ack: true })).status, 200);

    const ctx = buildVoiceContext(t.db, { cmId: a.id, brief: 'rev escrow sched' });
    assert.ok(!ctx.prompt.includes(AI_TEXT),
      'the narrative_ai filter itself works when provenance is intact');
  }));
