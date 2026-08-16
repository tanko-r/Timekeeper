// ===========================================================================
// THE MATTER FENCE — regression tests for the four cross-matter writes a
// critic proved against a real database, plus the two prompt-scoping leaks
// found auditing the same four files for the same shape.
//
// The standard is docs/ui/BRIEF.md, "Data integrity: non-negotiable":
//
//   A NARRATIVE — the client-facing sentence that lands on a bill and
//   describes work done on a specific matter — may never be shown as
//   belonging to, suggested for, pre-filled into, or written onto an entry
//   for another matter. Not across clients, and NOT between two matters of
//   the same client.
//
//   Reusable wording is different and must STAY shared: the phrasebook,
//   ghost text, text expansions and task-line FRAGMENTS are shared by
//   design. Several tests below assert that sharing still works, so a later
//   over-correction fails here too.
//
// Every assertion reads the real SQLite row on a real server (test/helpers.js)
// and proves ownership by joining the stored text back to the entry — and the
// matter — it was written for. Nothing is inferred from source code.
//
// House fictional names only (Sigma / Northgate / Verity / Acme).
// ===========================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { startTestServer } from './helpers.js';
import { setSetting } from '../server/db.js';
import { buildVoiceContext, matterAiContext } from '../server/routes/ai.js';

const TODAY = '2026-08-14';

function makeClock(iso = '2026-08-14T09:00:00-07:00') {
  let now = new Date(iso).getTime();
  const clock = () => new Date(now);
  clock.advance = (seconds) => { now += seconds * 1000; };
  return clock;
}

async function withServer(fn) {
  const clock = makeClock();
  const t = await startTestServer({ clock });
  try { return await fn(t, clock); } finally { await t.close(); }
}

const mkCm = async (t, cm_number, short_name, client_name) => {
  const r = await t.fetchJson('POST', '/api/cms', {
    cm_number, short_name, client_name, billable: 1,
  });
  assert.ok(r.status < 300, `cm create failed: ${JSON.stringify(r.body)}`);
  return r.body;
};

const addEntry = async (t, cm_id, date, narrative, tasks) => {
  const r = await t.fetchJson('POST', '/api/entries', {
    date, cm_id, narrative,
    tasks: tasks || [{ task_code: 'Review', duration: 0.5, fragment: '' }],
  });
  assert.ok(r.status < 300, `entry create failed: ${JSON.stringify(r.body)}`);
  return r.body;
};

const startTimer = async (t, name, cm_id) => {
  const timer = (await t.fetchJson('POST', '/api/timers', { name, cm_id })).body;
  const started = await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
  assert.equal(started.status, 200, JSON.stringify(started.body));
  return timer;
};

const suggestionRow = (t, timerId) => t.db.prepare(
  'SELECT cm_id, suggested_narrative FROM timers WHERE id=?').get(timerId);

// PROVENANCE, the only thing these tests trust: which matters own an entry
// whose narrative is (or starts with) this text? rankPhrases -> normalizePhrase
// strips trailing punctuation, so a stored phrase is a PREFIX of the narrative
// it came from.
function ownersOfText(t, text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return [];
  return t.db.prepare(`
    SELECT DISTINCT m.id AS matter_id, m.short_name, e.id AS entry_id
    FROM entries e JOIN matters m ON m.id = e.cm_id
    WHERE e.deleted_at IS NULL AND e.narrative LIKE ? || '%'
  `).all(trimmed);
}

const foreignTo = (t, text, matterId) =>
  ownersOfText(t, text).filter((o) => o.matter_id !== matterId);

// ═══════════════════════════════════════════════════════════════════════════
// 1. THE FENCE — PATCH /api/entries/:id { source_cm_id }
//
// A suggestion is BUILT for one matter and APPLIED later. In between, the
// entry's matter can move. `source_cm_id` is the matter the suggested text was
// built for; the server refuses the write when it no longer matches.
// ═══════════════════════════════════════════════════════════════════════════

// Distinctive enough that no phrasing accident could produce it: it names a
// party and a document belonging to one matter and nothing else.
const HARBOR_SENTENCE =
  'Telephone conference with T. Vance regarding the Harbor Lease estoppel certificate.';

test('FENCE: a matching source_cm_id saves exactly as an unfenced write would', () =>
  withServer(async (t) => {
    const harbor = await mkCm(t, '900100-000011', 'Harbor Lease', 'Northgate Partners');
    const entry = await addEntry(t, harbor.id, TODAY, '');

    const r = await t.fetchJson('PATCH', `/api/entries/${entry.id}`, {
      narrative: HARBOR_SENTENCE, narrative_manual: 1, source_cm_id: harbor.id,
    });

    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(
      t.db.prepare('SELECT narrative FROM entries WHERE id=?').get(entry.id).narrative,
      HARBOR_SENTENCE,
      'a suggestion applied to the matter it was built for must still land');
  }));

test('FENCE: a mismatched source_cm_id is refused 409 and the narrative is untouched', () =>
  withServer(async (t) => {
    const harbor = await mkCm(t, '900100-000011', 'Harbor Lease', 'Northgate Partners');
    const borealis = await mkCm(t, '900200-000011', 'Borealis Merger', 'Acme Holdings');
    const entry = await addEntry(t, harbor.id, TODAY, 'Open file and calendar deadlines.');

    // the entry moves matters while a suggestion built for Harbor is in flight
    const moved = await t.fetchJson('PATCH', `/api/entries/${entry.id}`, { cm_id: borealis.id });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));

    const before = t.db.prepare('SELECT narrative, cm_id FROM entries WHERE id=?').get(entry.id);
    const r = await t.fetchJson('PATCH', `/api/entries/${entry.id}`, {
      narrative: HARBOR_SENTENCE, source_cm_id: harbor.id,
    });

    assert.equal(r.status, 409, `expected a refusal, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.code, 'matter_changed');
    assert.equal(r.body.source_cm_id, harbor.id);
    assert.equal(r.body.cm_id, borealis.id);
    // the message has to be readable by the lawyer who triggered it
    assert.match(r.body.error, /Harbor Lease/, 'the message names the matter the text was written for');
    assert.match(r.body.error, /Borealis Merger/, 'and the matter the entry is on now');
    assert.match(r.body.error, /Nothing was saved/i);

    const after = t.db.prepare('SELECT narrative, cm_id FROM entries WHERE id=?').get(entry.id);
    assert.deepEqual(after, before, 'a refused write must change nothing at all');
    assert.deepEqual(foreignTo(t, after.narrative, borealis.id), [],
      'the Acme entry must not be carrying a Northgate sentence');
  }));

test('FENCE: the refusal blocks the WHOLE payload, not only the narrative', () =>
  withServer(async (t) => {
    const harbor = await mkCm(t, '900100-000011', 'Harbor Lease', 'Northgate Partners');
    const borealis = await mkCm(t, '900200-000011', 'Borealis Merger', 'Acme Holdings');
    const entry = await addEntry(t, harbor.id, TODAY, 'Open file.',
      [{ task_code: 'Review', duration: 0.4, fragment: 'open file' }]);
    await t.fetchJson('PATCH', `/api/entries/${entry.id}`, { cm_id: borealis.id });

    const before = t.db.prepare(
      'SELECT narrative, billable, total_override, date FROM entries WHERE id=?').get(entry.id);
    const tasksBefore = t.db.prepare(
      'SELECT task_code, duration, fragment FROM entry_tasks WHERE entry_id=? ORDER BY sort_order').all(entry.id);

    const r = await t.fetchJson('PATCH', `/api/entries/${entry.id}`, {
      narrative: HARBOR_SENTENCE,
      tasks: [{ task_code: 'Draft', duration: 2.5, fragment: 'draft Harbor Lease estoppel certificate' }],
      total_override: 2.5,
      billable: 0,
      date: '2026-08-13',
      source_cm_id: harbor.id,
    });

    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.deepEqual(
      t.db.prepare('SELECT narrative, billable, total_override, date FROM entries WHERE id=?').get(entry.id),
      before, 'no field of a fenced payload may be applied');
    assert.deepEqual(
      t.db.prepare('SELECT task_code, duration, fragment FROM entry_tasks WHERE entry_id=? ORDER BY sort_order').all(entry.id),
      tasksBefore, 'and the task lines it carried must not land either');
  }));

test('FENCE: absent source_cm_id behaves exactly as today (hand typing is never fenced)', () =>
  withServer(async (t) => {
    const harbor = await mkCm(t, '900100-000011', 'Harbor Lease', 'Northgate Partners');
    const borealis = await mkCm(t, '900200-000011', 'Borealis Merger', 'Acme Holdings');
    const entry = await addEntry(t, harbor.id, TODAY, 'Open file.');
    await t.fetchJson('PATCH', `/api/entries/${entry.id}`, { cm_id: borealis.id });

    // no source_cm_id at all
    const plain = await t.fetchJson('PATCH', `/api/entries/${entry.id}`, {
      narrative: 'Draft Borealis Merger disclosure schedules.', narrative_manual: 1,
    });
    assert.equal(plain.status, 200, JSON.stringify(plain.body));
    assert.equal(
      t.db.prepare('SELECT narrative FROM entries WHERE id=?').get(entry.id).narrative,
      'Draft Borealis Merger disclosure schedules.');

    // an explicit null means "this text has no source matter" — same as absent
    const nulled = await t.fetchJson('PATCH', `/api/entries/${entry.id}`, {
      narrative: 'Revise Borealis Merger disclosure schedules.', source_cm_id: null,
    });
    assert.equal(nulled.status, 200, JSON.stringify(nulled.body));
    assert.equal(
      t.db.prepare('SELECT narrative FROM entries WHERE id=?').get(entry.id).narrative,
      'Revise Borealis Merger disclosure schedules.');
  }));

test('FENCE: text built for a matter cannot be written onto a still-matterless entry', () =>
  withServer(async (t, clock) => {
    const harbor = await mkCm(t, '900100-000011', 'Harbor Lease', 'Northgate Partners');
    // a quick timer's entry: real, carries time, has no matter yet
    const timer = (await t.fetchJson('POST', '/api/timers', { name: 'Quick timer' })).body;
    const started = await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
    clock.advance(600);
    const stopped = (await t.fetchJson('POST', `/api/timers/${timer.id}/stop`)).body;
    const entryId = stopped.entry ? stopped.entry.id : started.body.entry.id;
    assert.equal(t.db.prepare('SELECT cm_id FROM entries WHERE id=?').get(entryId).cm_id, null);

    const r = await t.fetchJson('PATCH', `/api/entries/${entryId}`, {
      narrative: HARBOR_SENTENCE, source_cm_id: harbor.id,
    });
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.match(r.body.error, /no matter/);
    assert.equal(
      t.db.prepare('SELECT narrative FROM entries WHERE id=?').get(entryId).narrative, '',
      'the matterless entry keeps its empty narrative');
  }));

test('FENCE: the real race — the timer under an open editor is re-pointed mid-edit', () =>
  withServer(async (t, clock) => {
    const harbor = await mkCm(t, '900100-000011', 'Harbor Lease', 'Northgate Partners');
    const borealis = await mkCm(t, '900200-000011', 'Borealis Merger', 'Acme Holdings');
    const timer = await startTimer(t, 'Harbor Lease', harbor.id);
    clock.advance(600);
    const stop = (await t.fetchJson('POST', `/api/timers/${timer.id}/stop`)).body;
    const entryId = stop.entry.id;

    // the editor is open on this entry, showing Harbor Lease suggestions. The
    // timer is re-pointed (wrong matter picked at start) — which MOVES the entry.
    // move_entry: the race this test reproduces is an edit landing on an entry
    // that has just CHANGED MATTER, so the move is the stimulus. Since
    // 2026-08-16 an entry holding work moves only when asked (the owner's
    // "ask me each time" rule); without the flag the entry stays and there is
    // no race to reproduce.
    const repoint = await t.fetchJson('PATCH', `/api/timers/${timer.id}`,
      { cm_id: borealis.id, move_entry: true });
    assert.equal(repoint.status, 200, JSON.stringify(repoint.body));
    assert.equal(t.db.prepare('SELECT cm_id FROM entries WHERE id=?').get(entryId).cm_id, borealis.id);

    // ...and only now does the editor's autosave of the chosen Harbor chip land
    const late = await t.fetchJson('PATCH', `/api/entries/${entryId}`, {
      narrative: HARBOR_SENTENCE, narrative_manual: 1, source_cm_id: harbor.id,
    });

    assert.equal(late.status, 409, JSON.stringify(late.body));
    const stored = t.db.prepare('SELECT narrative FROM entries WHERE id=?').get(entryId).narrative;
    assert.ok(!/Harbor Lease/.test(stored),
      `the Acme entry now reads ${JSON.stringify(stored)}`);
  }));

// ═══════════════════════════════════════════════════════════════════════════
// 2. SIBLING NARRATIVES ARE NEVER SUGGESTED
//
// matterSuggestions blends sibling material when a matter has fewer than five
// ranked phrases of its own. That blend may carry task-line FRAGMENTS (shared
// by design) and must never carry a whole NARRATIVE.
// ═══════════════════════════════════════════════════════════════════════════

const SIGMA_ONE_SENTENCE =
  'Prepare the Sigma one water rights transfer application and confer with R. Okafor regarding the point of diversion.';

test('SIBLINGS: /suggestions offers a cold matter no narrative owned by another matter', () =>
  withServer(async (t) => {
    const one = await mkCm(t, '900300-000011', 'Sigma one', 'Sigma Holdings');
    const two = await mkCm(t, '900300-000022', 'Sigma two', 'Sigma Holdings');
    assert.equal(one.client_id, two.client_id, 'precondition: two matters of ONE client');
    for (const d of ['2026-08-11', '2026-08-12', '2026-08-13']) {
      await addEntry(t, one.id, d, SIGMA_ONE_SENTENCE);
    }

    const body = (await t.fetchJson('GET', `/api/matters/${two.id}/suggestions`)).body;
    const leaked = (body.phrases || []).filter((p) => foreignTo(t, p.text, two.id).length > 0);

    assert.deepEqual(leaked, [], 'Sigma two was offered Sigma one\'s billing sentence: '
      + JSON.stringify(leaked));
  }));

test('SIBLINGS: reusable task-line FRAGMENTS are still shared, and still flagged source:"client"', () =>
  withServer(async (t) => {
    const one = await mkCm(t, '900300-000011', 'Sigma one', 'Sigma Holdings');
    const two = await mkCm(t, '900300-000022', 'Sigma two', 'Sigma Holdings');
    const stranger = await mkCm(t, '900400-000011', 'Borealis Merger', 'Acme Holdings');
    await addEntry(t, one.id, '2026-08-12', '',
      [{ task_code: 'Negotiate', duration: 0.5, fragment: 'negotiate crossing agreement' }]);
    await addEntry(t, stranger.id, '2026-08-12', '',
      [{ task_code: 'Draft', duration: 0.5, fragment: 'draft stranger fragment' }]);

    const body = (await t.fetchJson('GET', `/api/matters/${two.id}/suggestions`)).body;
    const texts = (body.phrases || []).map((p) => p.text);

    assert.equal(body.borrowed, true, 'the blend must still fire for a thin matter');
    assert.ok(texts.includes('negotiate crossing agreement'),
      'reusable wording is SUPPOSED to be shared across a client\'s matters (BRIEF)');
    assert.equal(body.phrases.find((p) => p.text === 'negotiate crossing agreement').source, 'client',
      'and it must be labelled borrowed, so consumers can tell it from matter-own text');
    assert.ok(!texts.includes('draft stranger fragment'), 'but never across clients');
  }));

test('SIBLINGS: the measured close-out path — nothing foreign reaches the export file', () =>
  withServer(async (t, clock) => {
    // The critic's scenario: matter "Sigma two" with no history, sibling
    // "Sigma one" with plenty. Stop the timer, dismiss the offer, close out,
    // finalize, export — touching no narrative by hand at any point.
    const one = await mkCm(t, '900300-000011', 'Sigma one', 'Sigma Holdings');
    const two = await mkCm(t, '900300-000022', 'Sigma two', 'Sigma Holdings');
    for (const d of ['2026-08-11', '2026-08-12', '2026-08-13']) {
      await addEntry(t, one.id, d, SIGMA_ONE_SENTENCE);
    }

    const timer = await startTimer(t, 'Sigma two', two.id);
    clock.advance(900);
    const stop = (await t.fetchJson('POST', `/api/timers/${timer.id}/stop`)).body;
    const entryId = stop.entry.id;

    // Everything the server offers this entry, applied the way the close-out
    // sheet applies it. On the fixed server both are empty; the hand-typed
    // fallback keeps the entry finalizable either way, so the assertion below
    // is about FOREIGN text and nothing else.
    const offered = [
      suggestionRow(t, timer.id).suggested_narrative,
      ((await t.fetchJson('GET', `/api/matters/${two.id}/suggestions`)).body.phrases[0] || {}).text,
    ].filter(Boolean);
    const narrative = offered[0] || 'Attend to Sigma two file.';
    const patched = await t.fetchJson('PATCH', `/api/entries/${entryId}`, {
      narrative, narrative_manual: 1,
    });
    assert.equal(patched.status, 200, JSON.stringify(patched.body));

    const fin = await t.fetchJson('POST', `/api/entries/${entryId}/finalize`, { ack: true });
    assert.equal(fin.status, 200, `finalize: ${JSON.stringify(fin.body)}`);
    const exported = await t.fetchJson('POST', '/api/export', { from: TODAY, to: TODAY });
    assert.equal(exported.status, 200, JSON.stringify(exported.body));

    assert.ok(exported.body.csv.includes(entryId === null ? '' : narrative.slice(0, 20)),
      'precondition: the entry really did reach the export file');
    assert.ok(!/Sigma one|R\. Okafor|point of diversion/.test(exported.body.csv),
      'Sigma one\'s billing sentence reached the export file for Sigma two:\n'
      + exported.body.csv);
    assert.deepEqual(foreignTo(t, narrative, two.id), [],
      `the finalized Sigma two entry carries ${JSON.stringify(narrative)}`);
  }));

// ═══════════════════════════════════════════════════════════════════════════
// 3. STARTING A TIMER STAMPS ONLY ITS OWN MATTER'S TEXT
// ═══════════════════════════════════════════════════════════════════════════

test('TIMER START: a cold matter with a busy sibling is stamped with nothing', () =>
  withServer(async (t) => {
    const one = await mkCm(t, '900300-000011', 'Sigma one', 'Sigma Holdings');
    const two = await mkCm(t, '900300-000022', 'Sigma two', 'Sigma Holdings');
    for (const d of ['2026-08-11', '2026-08-12', '2026-08-13']) {
      await addEntry(t, one.id, d, SIGMA_ONE_SENTENCE);
    }

    const timer = await startTimer(t, 'Sigma two', two.id);
    const row = suggestionRow(t, timer.id);

    assert.deepEqual(foreignTo(t, row.suggested_narrative, two.id), [],
      `timers.suggested_narrative = ${JSON.stringify(row.suggested_narrative)}`);
    assert.equal(row.suggested_narrative, null,
      'a matter with no history of its own gets nothing — the brief\'s "offer nothing" case');
  }));

test('TIMER START: a sibling FRAGMENT is not a narrative and is not stamped either', () =>
  withServer(async (t) => {
    // Fragments stay shared in the phrasebook (proved above). What must not
    // happen is one being promoted into a whole suggested narrative for a
    // matter it was never written for.
    const one = await mkCm(t, '900300-000011', 'Sigma one', 'Sigma Holdings');
    const two = await mkCm(t, '900300-000022', 'Sigma two', 'Sigma Holdings');
    for (const d of ['2026-08-11', '2026-08-12', '2026-08-13']) {
      await addEntry(t, one.id, d, '',
        [{ task_code: 'Negotiate', duration: 0.5, fragment: 'negotiate Sigma one crossing agreement' }]);
    }

    const timer = await startTimer(t, 'Sigma two', two.id);
    assert.equal(suggestionRow(t, timer.id).suggested_narrative, null,
      'borrowed wording must not become this matter\'s suggested narrative');

    // control: the shared phrasebook is untouched by that restriction
    const phrases = (await t.fetchJson('GET', `/api/matters/${two.id}/suggestions`)).body.phrases;
    assert.ok(phrases.some((p) => p.text === 'negotiate Sigma one crossing agreement'),
      'the fragment is still offered as reusable wording');
  }));

test('TIMER START: the matter\'s OWN phrase is still pre-computed (capability preserved)', () =>
  withServer(async (t) => {
    const cm = await mkCm(t, '900300-000011', 'Sigma one', 'Sigma Holdings');
    await addEntry(t, cm.id, '2026-08-13', '',
      [{ task_code: 'Revise', duration: 0.5, fragment: 'revise lease legal description' }]);

    const timer = await startTimer(t, 'Sigma one', cm.id);
    assert.equal(suggestionRow(t, timer.id).suggested_narrative, 'revise lease legal description');
  }));

// ═══════════════════════════════════════════════════════════════════════════
// 4. AN IN-FLIGHT AI REFINEMENT MUST NOT LAND ON A TIMER THAT HAS MOVED
//
// llama3.1:8b takes minutes and the fetch timeout is 180s, so the window is
// real. The stub below parks the request until the test releases it, making
// the race deterministic instead of a sleep.
// ═══════════════════════════════════════════════════════════════════════════

function startGatedOllama(reply) {
  return new Promise((resolve) => {
    const state = { chats: [] };
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
        await gate;
        res.end(JSON.stringify({ message: { role: 'assistant', content: reply } }));
      });
      return undefined;
    });
    srv.listen(0, '127.0.0.1', () => resolve({
      url: `http://127.0.0.1:${srv.address().port}`,
      state,
      release: () => release(),
      close: () => new Promise((r) => srv.close(r)),
    }));
  });
}

const waitFor = async (fn, ms = 3000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
};

const VERITY_SUGGESTION =
  'Review Verity Escrow Instructions and confer with P. Okafor regarding release of funds.';

test('AI REFINE: a refinement built for matter A never lands on a timer re-pointed to client B', async () => {
  const stub = await startGatedOllama(VERITY_SUGGESTION);
  const clock = makeClock();
  const t = await startTestServer({ clock });
  try {
    setSetting(t.db, 'ai', { enabled: true, model: 'llama3.1:8b', url: stub.url });
    const verity = await mkCm(t, '900500-000011', 'Verity Escrow', 'Verity Title');
    const northgate = await mkCm(t, '900600-000011', 'Harbor Lease', 'Northgate Partners');

    const timer = await startTimer(t, 'Verity Escrow', verity.id);
    assert.ok(await waitFor(() => stub.state.chats.length > 0),
      'precondition: starting the timer fired the background refinement');

    // the attorney realises the wrong timer was running and re-points it
    const repoint = await t.fetchJson('PATCH', `/api/timers/${timer.id}`, { cm_id: northgate.id });
    assert.equal(repoint.status, 200, JSON.stringify(repoint.body));
    assert.equal(suggestionRow(t, timer.id).cm_id, northgate.id);

    stub.release();
    // give the resolved refinement every chance to run its UPDATE
    await waitFor(() => suggestionRow(t, timer.id).suggested_narrative != null, 1500);

    const row = suggestionRow(t, timer.id);
    assert.equal(row.cm_id, northgate.id, 'precondition: the timer is on Northgate now');
    assert.ok(!/Verity|Okafor|Escrow Instructions/.test(String(row.suggested_narrative || '')),
      'a Verity sentence was re-stamped onto a Northgate timer: '
      + JSON.stringify(row.suggested_narrative));
    assert.equal(row.suggested_narrative, null,
      're-pointing clears the suggestion, and the in-flight refinement must not restore it');
  } finally { await t.close(); await stub.close(); }
});

test('AI REFINE: a timer left alone still gets its refinement (capability preserved)', async () => {
  const stub = await startGatedOllama(VERITY_SUGGESTION);
  const clock = makeClock();
  const t = await startTestServer({ clock });
  try {
    setSetting(t.db, 'ai', { enabled: true, model: 'llama3.1:8b', url: stub.url });
    const verity = await mkCm(t, '900500-000011', 'Verity Escrow', 'Verity Title');
    const timer = await startTimer(t, 'Verity Escrow', verity.id);
    assert.ok(await waitFor(() => stub.state.chats.length > 0), 'refinement fired');
    stub.release();
    assert.ok(
      await waitFor(() => suggestionRow(t, timer.id).suggested_narrative === VERITY_SUGGESTION),
      'the refinement must still reach a timer that never moved');
  } finally { await t.close(); await stub.close(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. AUDIT FINDINGS IN THE SAME FILES — the prompt is a surface too
//
// Everything below is the same shape as the four defects: a read that widens
// from matter to client (or to the whole database) and then feeds a prompt
// which writes a billing narrative for ONE matter.
// ═══════════════════════════════════════════════════════════════════════════

test('PROMPT: matterAiContext claims only what is true — this matter\'s own phrases and people', () =>
  withServer(async (t) => {
    const one = await mkCm(t, '900300-000011', 'Sigma one', 'Sigma Holdings');
    const two = await mkCm(t, '900300-000022', 'Sigma two', 'Sigma Holdings');
    for (const d of ['2026-08-11', '2026-08-12', '2026-08-13']) {
      await addEntry(t, one.id, d, SIGMA_ONE_SENTENCE,
        [{ task_code: 'Draft', duration: 0.5, fragment: 'prepare Sigma one transfer application' }]);
    }

    const ctx = String(matterAiContext(t.db, two.id, TODAY) || '');

    assert.ok(!/Sigma one|point of diversion/.test(ctx),
      'the prompt written for Sigma two describes Sigma one\'s work as its own:\n' + ctx);
    assert.ok(!/Okafor/.test(ctx),
      'and hands it a counterparty who appears on no entry of this matter:\n' + ctx);
  }));

test('PROMPT: a cold matter is taught from synthetic examples, never another client\'s narratives', () =>
  withServer(async (t) => {
    const verity = await mkCm(t, '900500-000011', 'Verity Escrow', 'Verity Title');
    const cold = await mkCm(t, '900600-000011', 'Harbor Lease', 'Northgate Partners');
    for (let i = 0; i < 4; i += 1) {
      const e = await addEntry(t, verity.id, `2026-08-0${i + 1}`,
        'Review Verity Escrow Instructions and confer with P. Okafor regarding release of funds.');
      t.db.prepare("UPDATE entries SET status='finalized', ever_finalized=1, ai_brief=? WHERE id=?")
        .run(`rev escrow ${i}`, e.id);
    }

    const v = buildVoiceContext(t.db, { cmId: cold.id, brief: 'rev lease' });
    const wire = [v.prompt, ...v.turns.map((x) => x.content)].join('\n');

    assert.ok(!/Verity|Okafor|Escrow Instructions/.test(wire),
      'Northgate\'s prompt quotes Verity Title\'s billing sentences:\n' + wire);
    assert.ok(/The attorney's entries:/.test(v.prompt),
      'the cold matter still gets voice examples — synthetic ones');
    assert.ok(v.turns.length > 0, 'and still gets few-shot demonstrations (the seeds)');
    for (const line of v.prompt.split('\n').filter((l) => /[a-z]\.$/.test(l))) {
      assert.deepEqual(ownersOfText(t, line), [],
        `an exemplar traces back to a real entry row: ${JSON.stringify(line)}`);
    }
  }));

test('PROMPT: a matter with its own finalized history still teaches from it (capability preserved)', () =>
  withServer(async (t) => {
    const cm = await mkCm(t, '900600-000011', 'Harbor Lease', 'Northgate Partners');
    const e = await addEntry(t, cm.id, '2026-08-01',
      'Review Harbor Lease estoppel certificate and confer with client regarding same.');
    t.db.prepare("UPDATE entries SET status='finalized', ever_finalized=1, ai_brief='rev estoppel' WHERE id=?")
      .run(e.id);

    const v = buildVoiceContext(t.db, { cmId: cm.id, brief: 'rev estoppel' });
    assert.match(v.prompt, /Harbor Lease estoppel certificate/,
      'its own finalized narrative is exactly what it should be taught from');
    assert.ok(v.turns.some((x) => x.content.includes('rev estoppel')),
      'and its own (brief -> narrative) pair is still a demonstration');
  }));
