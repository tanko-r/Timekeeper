// =========================================================================
// DATA-INTEGRITY AUDIT — the suggestion sources that propose narrative text
//
// EVERY TEST IN THIS FILE IS EXPECTED TO FAIL ON THE CURRENT CODE.
// They are written to PROVE a leak, not to pass. Do not "fix the test" — the
// assertion is the specification (docs/ui/BRIEF.md, "Data integrity"):
//
//   A narrative — the client-facing sentence describing work done on a
//   specific matter — may never be shown as belonging to, suggested for,
//   pre-filled into, or written onto an entry for a DIFFERENT matter. Not
//   across clients, and not between two matters of the same client.
//
// What is deliberately NOT tested here, because it is shared BY DESIGN and
// is not a defect: the shortcut/text-expansion table (server/routes/
// shortcuts.js, public/js/lib/expand.js) and generic style guidance in the
// AI prompts. Reusable wording is shared; a sentence about a particular
// matter is not.
//
// Findings written up in docs/ui/integrity-suggestions.md.
// =========================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { startTestServer } from './helpers.js';
import { setSetting, getSetting } from '../server/db.js';
import { buildVoiceContext, matterAiContext } from '../server/routes/ai.js';

async function withServer(fn) {
  const t = await startTestServer();
  try { return await fn(t); } finally { await t.close(); }
}

const mkCm = async (t, cm_number, short_name, client_name) =>
  (await t.fetchJson('POST', '/api/cms', { cm_number, short_name, client_name })).body;

// Only finalized, human-written narratives reach the voice layer (ai.js FINAL).
function finalize(t, id) {
  t.db.prepare("UPDATE entries SET status='finalized', ever_finalized=1 WHERE id=?").run(id);
}

// House fictional names only (BRIEF: no real client/matter data in the repo).
// Two matters of the SAME client…
const CM_HARBOR = '100001-000010';   // Northgate Partners — Harbor Lease
const CM_RIDGE = '100001-000020';    // Northgate Partners — Ridgeline Permit (cold)
// …and one matter of a DIFFERENT client.
const CM_BOREALIS = '100002-000010'; // Acme Holdings — Borealis Merger

// A whole client-facing sentence, unmistakably about Harbor Lease and nobody
// else. If this string turns up anywhere near Ridgeline or Borealis, a
// narrative has crossed a matter boundary.
const HARBOR_NARRATIVE =
  'Review and analyze the Harbor Lease termination notice and confer with T. Vance regarding same.';
const HARBOR_BRIEF = 'rev harbor termination notice; conf w vance';

// ---------------------------------------------------------------------------
// LEAK 1 — /api/matters/:id/suggestions hands a cold matter its SIBLING
// matter's finished narratives.
//
// This one endpoint feeds four surfaces: the stop-timer chips
// (components/stopchips.js), the close-out pre-fill (components/closeout.js
// `valueOf`), ghost-text completion (components/ghosttext.js) and the timer's
// suggested_narrative at start (routes/timers.js `doStart`). Whatever it
// returns is what a lawyer is offered — and, at close-out, what gets written
// and finalized with no tap at all.
// ---------------------------------------------------------------------------
test('LEAK: a cold matter is offered its sibling matter\'s narrative', () =>
  withServer(async (t) => {
    const harbor = await mkCm(t, CM_HARBOR, 'Harbor Lease', 'Northgate Partners');
    const ridge = await mkCm(t, CM_RIDGE, 'Ridgeline Permit', 'Northgate Partners');

    await t.fetchJson('POST', '/api/entries', {
      date: '2026-08-10', cm_id: harbor.id, narrative: HARBOR_NARRATIVE,
      tasks: [{ task_code: 'Review', duration: 0.6, fragment: '' }],
    });

    const r = await t.fetchJson('GET', `/api/matters/${ridge.id}/suggestions`);
    assert.equal(r.status, 200);
    const texts = r.body.phrases.map((p) => p.text);

    // Ridgeline Permit has never been worked on. The only honest answers are
    // "nothing" or generic phrasing — never Harbor Lease's billing sentence.
    assert.deepEqual(texts, [],
      `Ridgeline Permit's phrasebook carries Harbor Lease's narrative: ${JSON.stringify(texts)}`);
  }));

// The same endpoint decides what the close-out dialog PRE-FILLS. closeout.js
// keeps only `p.text` — `source` is dropped on the floor — and `valueOf()`
// returns phrases[0] as the value of the narrative box. The primary button
// then saves every box and finalizes the day. So phrases[0] on a cold matter
// is not a suggestion: it is what lands on the bill.
test('LEAK: the close-out pre-fill value for a cold matter is a sibling\'s narrative', () =>
  withServer(async (t) => {
    const harbor = await mkCm(t, CM_HARBOR, 'Harbor Lease', 'Northgate Partners');
    const ridge = await mkCm(t, CM_RIDGE, 'Ridgeline Permit', 'Northgate Partners');
    await t.fetchJson('POST', '/api/entries', {
      date: '2026-08-10', cm_id: harbor.id, narrative: HARBOR_NARRATIVE,
      tasks: [{ task_code: 'Review', duration: 0.6, fragment: '' }],
    });

    const r = await t.fetchJson('GET', `/api/matters/${ridge.id}/suggestions`);
    // exactly closeout.js's own expression
    const prefill = r.body.phrases.map((p) => p.text)[0] || '';
    assert.ok(!prefill.includes('Harbor Lease'),
      `close-out would pre-fill Ridgeline Permit's entry with: ${JSON.stringify(prefill)}`);
  }));

// ---------------------------------------------------------------------------
// LEAK 2 — starting a timer on a cold matter stamps a SIBLING matter's
// narrative onto timers.suggested_narrative, and stopchips.js renders that
// string as the ✦ "suggested when this timer started" chip: one tap writes it
// onto the entry.
// ---------------------------------------------------------------------------
test('LEAK: a timer started on a cold matter is pre-loaded with a sibling\'s narrative', () =>
  withServer(async (t) => {
    const harbor = await mkCm(t, CM_HARBOR, 'Harbor Lease', 'Northgate Partners');
    const ridge = await mkCm(t, CM_RIDGE, 'Ridgeline Permit', 'Northgate Partners');
    await t.fetchJson('POST', '/api/entries', {
      date: '2026-08-10', cm_id: harbor.id, narrative: HARBOR_NARRATIVE,
      tasks: [{ task_code: 'Review', duration: 0.6, fragment: '' }],
    });

    const timer = (await t.fetchJson('POST', '/api/timers',
      { name: 'Ridgeline Permit', cm_id: ridge.id })).body;
    await t.fetchJson('POST', `/api/timers/${timer.id}/start`);

    const row = t.db.prepare('SELECT suggested_narrative FROM timers WHERE id=?').get(timer.id);
    assert.equal(row.suggested_narrative, null,
      `Ridgeline's timer carries Harbor Lease's sentence as its suggestion: ${JSON.stringify(row.suggested_narrative)}`);
  }));

// ---------------------------------------------------------------------------
// LEAK 3 — matterAiContext asserts a sibling matter's narrative IS this
// matter's history. The block is literally headed "The attorney's recent work
// on this matter:" and routes/ai.js splices it into the prompt that writes the
// other matter's narrative.
// ---------------------------------------------------------------------------
test('LEAK: the AI matter context labels a sibling\'s narrative as "this matter"', () =>
  withServer(async (t) => {
    const harbor = await mkCm(t, CM_HARBOR, 'Harbor Lease', 'Northgate Partners');
    const ridge = await mkCm(t, CM_RIDGE, 'Ridgeline Permit', 'Northgate Partners');
    await t.fetchJson('POST', '/api/entries', {
      date: '2026-08-10', cm_id: harbor.id, narrative: HARBOR_NARRATIVE,
      tasks: [{ task_code: 'Review', duration: 0.6, fragment: '' }],
    });

    const ctx = matterAiContext(t.db, ridge.id, '2026-08-14') || '';
    assert.ok(!ctx.includes('Harbor Lease'),
      `prompt context for Ridgeline Permit claims Harbor Lease's work as its own:\n${ctx}`);
  }));

// ---------------------------------------------------------------------------
// LEAK 4 — the voice layer feeds ANOTHER CLIENT's real narratives into the
// prompt, as style exemplars and as few-shot before/after pairs.
//
// BRIEF: "Where a prompt includes before/after narrative pairs as examples,
// those pairs come from the same matter; where a matter has none, use fully
// synthetic examples." ai.js ships six synthetic SEED_PAIRS for exactly this,
// but pickPairs only reaches for them to top up a thin pool — a real
// cross-client pair always outranks them.
// ---------------------------------------------------------------------------
test('LEAK: few-shot pairs for one client are another client\'s real narratives', () =>
  withServer(async (t) => {
    const harbor = await mkCm(t, CM_HARBOR, 'Harbor Lease', 'Northgate Partners');
    const borealis = await mkCm(t, CM_BOREALIS, 'Borealis Merger', 'Acme Holdings');

    const e = (await t.fetchJson('POST', '/api/entries', {
      date: '2026-08-10', cm_id: harbor.id,
      narrative: HARBOR_NARRATIVE, ai_brief: HARBOR_BRIEF,
      tasks: [{ task_code: 'Review', duration: 0.6, fragment: '' }],
    })).body;
    finalize(t, e.id);

    // Borealis Merger belongs to a different client and has no history at all,
    // so every example in its prompt must be synthetic.
    const voice = buildVoiceContext(t.db, { cmId: borealis.id, brief: 'draft merger cert' });
    const turns = voice.turns.map((x) => x.content).join('\n');
    assert.ok(!turns.includes('Harbor Lease'),
      `Acme's prompt teaches from Northgate's narrative:\n${turns}`);
    assert.ok(!voice.prompt.includes('Harbor Lease'),
      `Acme's exemplar block quotes Northgate's narrative:\n${voice.prompt}`);
  }));

// ---------------------------------------------------------------------------
// LEAK 5 — end-to-end: the bytes actually sent to the model. A narrate call
// for Acme's matter carries Northgate's billing sentence in its system prompt
// and in its few-shot turns.
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

test('LEAK: the prompt sent to the model for one client quotes another client\'s narrative', async () => {
  const stub = await startStubOllama('Draft certificate of merger.');
  try {
    await withServer(async (t) => {
      setSetting(t.db, 'ai', { ...getSetting(t.db, 'ai'), enabled: true, url: stub.url });
      const harbor = await mkCm(t, CM_HARBOR, 'Harbor Lease', 'Northgate Partners');
      const borealis = await mkCm(t, CM_BOREALIS, 'Borealis Merger', 'Acme Holdings');
      const e = (await t.fetchJson('POST', '/api/entries', {
        date: '2026-08-10', cm_id: harbor.id,
        narrative: HARBOR_NARRATIVE, ai_brief: HARBOR_BRIEF,
        tasks: [{ task_code: 'Review', duration: 0.6, fragment: '' }],
      })).body;
      finalize(t, e.id);

      const r = await t.fetchJson('POST', '/api/ai/narrate', {
        mode: 'draft', brief: 'draft merger cert', cm_id: borealis.id,
      });
      assert.equal(r.status, 200);
      const wire = JSON.stringify(stub.state.lastChat.messages);
      assert.ok(!wire.includes('Harbor Lease'),
        'the request body that writes Acme Holdings\' narrative contains Northgate Partners\' billing sentence');
    });
  } finally {
    await stub.close();
  }
});

// ---------------------------------------------------------------------------
// LEAK 6 — the timer's stashed narrative follows the timer to a new matter.
//
// routes/timers.js PATCH clears suggested_narrative when the matter changes
// ("suggestion belonged to the old matter") but keeps draft_narrative on
// purpose. draft_narrative is narrative text the attorney typed for the OLD
// matter in the float window (public/js/lib/pip.js `saveNarrative`, stash
// mode), and syncToEntry seeds the NEXT entry the timer creates with it — so
// re-pointing a timer writes one matter's sentence straight onto another
// matter's entry, with no chip, no toast and no undo.
// ---------------------------------------------------------------------------
test('LEAK: a timer\'s stashed narrative is written onto the next matter\'s entry', () =>
  withServer(async (t) => {
    const harbor = await mkCm(t, CM_HARBOR, 'Harbor Lease', 'Northgate Partners');
    const borealis = await mkCm(t, CM_BOREALIS, 'Borealis Merger', 'Acme Holdings');

    const timer = (await t.fetchJson('POST', '/api/timers',
      { name: 'Harbor Lease', cm_id: harbor.id })).body;
    // typed in the float window before any entry existed → timers.draft_narrative
    await t.fetchJson('PATCH', `/api/timers/${timer.id}`, { draft_narrative: HARBOR_NARRATIVE });
    // wrong timer — re-point it at the matter actually being worked on
    await t.fetchJson('PATCH', `/api/timers/${timer.id}`, { cm_id: borealis.id });

    const started = (await t.fetchJson('POST', `/api/timers/${timer.id}/start`)).body;
    const entry = started.entry;
    assert.equal(entry.cm.id, borealis.id);
    assert.equal(entry.narrative, '',
      `Acme's brand-new entry opened holding Northgate's narrative: ${JSON.stringify(entry.narrative)}`);
  }));

// ---------------------------------------------------------------------------
// LEAK 7 — same mechanism, the per-timer narrative template. Set while the
// timer pointed at one matter, it survives a re-point and seeds every entry
// the timer creates on the new matter.
// ---------------------------------------------------------------------------
test('LEAK: a timer\'s narrative template survives a matter change', () =>
  withServer(async (t) => {
    const harbor = await mkCm(t, CM_HARBOR, 'Harbor Lease', 'Northgate Partners');
    const borealis = await mkCm(t, CM_BOREALIS, 'Borealis Merger', 'Acme Holdings');

    const timer = (await t.fetchJson('POST', '/api/timers',
      { name: 'Harbor Lease', cm_id: harbor.id, narrative_template: HARBOR_NARRATIVE })).body;
    await t.fetchJson('PATCH', `/api/timers/${timer.id}`, { cm_id: borealis.id });
    const started = (await t.fetchJson('POST', `/api/timers/${timer.id}/start`)).body;

    assert.equal(started.entry.narrative, '',
      `Acme's entry opened holding Northgate's templated narrative: ${JSON.stringify(started.entry.narrative)}`);
  }));
