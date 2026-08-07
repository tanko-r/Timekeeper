import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { startTestServer } from './helpers.js';
import { setSetting, getSetting } from '../server/db.js';

// Stub Ollama server; records the last /api/chat request body.
function startStubOllama(chatBody) {
  return new Promise((resolve) => {
    const state = { lastChat: null };
    const srv = createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/api/tags') {
        res.end(JSON.stringify({ models: [{ name: 'llama3.1:8b' }, { name: 'gemma4:12b' }] }));
      } else if (req.url === '/api/chat') {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
          state.lastChat = JSON.parse(body);
          if (state.lastChat.stream) {
            // Ollama streaming shape: NDJSON chunks, each carrying a token
            res.setHeader('content-type', 'application/x-ndjson');
            for (const token of String(chatBody).match(/.{1,12}/gs) || []) {
              res.write(JSON.stringify({ message: { role: 'assistant', content: token }, done: false }) + '\n');
            }
            res.end(JSON.stringify({ message: { role: 'assistant', content: '' }, done: true }) + '\n');
          } else {
            res.end(JSON.stringify({ message: { role: 'assistant', content: chatBody } }));
          }
        });
      } else {
        res.statusCode = 404;
        res.end('{}');
      }
    });
    srv.listen(0, '127.0.0.1', () => resolve({
      url: `http://127.0.0.1:${srv.address().port}`,
      state,
      close: () => new Promise((r) => srv.close(r)),
    }));
  });
}

const GOOD_CHAT = JSON.stringify({
  narrative: 'Reviewed lease agreement; drafted amendment regarding renewal terms.',
  tasks: [
    { task_code: 'Review', fragment: 'review lease agreement', share: 0.6 },
    { task_code: 'Draft', fragment: 'draft amendment re renewal terms', share: 0.4 },
  ],
});

// containsTimeAmounts accept/reject cases (incl. citation subsections and
// years) live in test/timeAmounts.test.js, which runs one fixture table
// against BOTH the server helper and its browser mirror.

test('ai status reports reachability and local models', async () => {
  const stub = await startStubOllama(GOOD_CHAT);
  const t = await startTestServer();
  try {
    setSetting(t.db, 'ai', { ...getSetting(t.db, 'ai'), enabled: true, url: stub.url });
    const r = await t.fetchJson('GET', '/api/ai/status');
    assert.equal(r.status, 200);
    assert.equal(r.body.reachable, true);
    assert.deepEqual(r.body.models, ['llama3.1:8b', 'gemma4:12b']);

    setSetting(t.db, 'ai', { ...getSetting(t.db, 'ai'), url: 'http://127.0.0.1:1' });
    const dead = await t.fetchJson('GET', '/api/ai/status');
    assert.equal(dead.body.reachable, false);
  } finally { await t.close(); await stub.close(); }
});

test('ai expand: narrative + task split allocated to tenths of the total', async () => {
  const stub = await startStubOllama(GOOD_CHAT);
  const t = await startTestServer();
  try {
    setSetting(t.db, 'ai', { enabled: true, model: 'llama3.1:8b', url: stub.url });
    const r = await t.fetchJson('POST', '/api/ai/expand', {
      brief: 'lease amendment work for acme', totalHours: 1.5,
    });
    assert.equal(r.status, 200);
    assert.match(r.body.narrative, /Reviewed lease/);
    assert.equal(r.body.tasks.length, 2);
    assert.equal(r.body.tasks[0].hours, 0.9);
    assert.equal(r.body.tasks[1].hours, 0.6);
    assert.equal(r.body.tasks[0].task_code, 'Review');
  } finally { await t.close(); await stub.close(); }
});

test('ai expand is refused when disabled; unreachable ollama is a clean 502', async () => {
  const t = await startTestServer();
  try {
    const off = await t.fetchJson('POST', '/api/ai/expand', { brief: 'x' });
    assert.equal(off.status, 400);
    assert.equal(off.body.error, 'ai_disabled');

    setSetting(t.db, 'ai', { enabled: true, model: 'llama3.1:8b', url: 'http://127.0.0.1:1' });
    const dead = await t.fetchJson('POST', '/api/ai/expand', { brief: 'lease work', totalHours: 1 });
    assert.equal(dead.status, 502);
  } finally { await t.close(); }
});

test('custom system prompt is used, with the format contract always appended', async () => {
  const stub = await startStubOllama(GOOD_CHAT);
  const t = await startTestServer();
  try {
    const custom = 'Always write in the third person about Attorney Cole.';
    setSetting(t.db, 'ai', { enabled: true, model: 'llama3.1:8b', url: stub.url, systemPrompt: custom });
    await t.fetchJson('POST', '/api/ai/expand', { brief: 'lease work' });
    const system = stub.state.lastChat.messages[0].content;
    assert.ok(system.startsWith(custom), 'custom instructions lead the prompt');
    assert.ok(system.includes('task_code MUST be one of'), 'format contract still appended');
    assert.ok(system.includes('Respond with ONLY this JSON'), 'JSON contract still appended');

    const status = (await t.fetchJson('GET', '/api/ai/status')).body;
    assert.equal(status.systemPrompt, custom);
    assert.ok(status.defaultPrompt.length > 50, 'default instructions exposed for the UI');
  } finally { await t.close(); await stub.close(); }
});

test('ai expand survives fenced/dirty model output', async () => {
  const stub = await startStubOllama('```json\n' + GOOD_CHAT + '\n```');
  const t = await startTestServer();
  try {
    setSetting(t.db, 'ai', { enabled: true, model: 'llama3.1:8b', url: stub.url });
    const r = await t.fetchJson('POST', '/api/ai/expand', { brief: 'lease work' });
    assert.equal(r.status, 200);
    assert.equal(r.body.tasks.length, 2);
    assert.equal(r.body.tasks[0].hours, null, 'no total → no allocation');
  } finally { await t.close(); await stub.close(); }
});

test('timer start refines the suggested narrative via the local model (async, non-blocking)', async () => {
  const stub = await startStubOllama('Reviewed and revised lease legal description; correspondence with counsel.');
  const t = await startTestServer();
  try {
    setSetting(t.db, 'ai', { enabled: true, model: 'llama3.1:8b', url: stub.url });
    const cm = (await t.fetchJson('POST', '/api/cms', { cm_number: '100001-000012', short_name: 'Cedar Lease' })).body;
    const timer = (await t.fetchJson('POST', '/api/timers', { name: 'MTR12', cm_id: cm.id })).body;
    await t.fetchJson('POST', `/api/timers/${timer.id}/start`); // returns before the LLM does
    let val = null;
    for (let i = 0; i < 40 && !val; i++) { // fire-and-forget → poll briefly
      await new Promise((r) => setTimeout(r, 50));
      val = t.db.prepare('SELECT suggested_narrative FROM timers WHERE id=?').get(timer.id).suggested_narrative;
    }
    assert.equal(val, 'Reviewed and revised lease legal description; correspondence with counsel.');
  } finally { await t.close(); await stub.close(); }
});

test('timer start refine REJECTS an LLM narrative carrying invented time amounts, keeping the phrasebook suggestion', async () => {
  const stub = await startStubOllama(
    'Analyzed and revised development agreement (0.5); drafted amendments regarding escrow (0.3).');
  const t = await startTestServer();
  try {
    setSetting(t.db, 'ai', { enabled: true, model: 'llama3.1:8b', url: stub.url });
    const cm = (await t.fetchJson('POST', '/api/cms', { cm_number: '100001-000013', short_name: 'Acme dev' })).body;
    // seed one prior entry so the phrasebook has a clean hit
    await t.fetchJson('POST', '/api/entries', {
      date: '2026-06-01', cm_id: cm.id,
      tasks: [{ task_code: 'Draft', duration: 0.5, fragment: 'draft development agreement' }],
    });
    const timer = (await t.fetchJson('POST', '/api/timers', { name: 'Dev', cm_id: cm.id })).body;
    await t.fetchJson('POST', `/api/timers/${timer.id}/start`); // returns before the LLM does
    const synced = t.db.prepare('SELECT suggested_narrative FROM timers WHERE id=?').get(timer.id).suggested_narrative;
    assert.equal(synced, 'draft development agreement', 'synchronous phrasebook pick lands immediately');

    // Give the fire-and-forget background refine ample time to hit the stub,
    // parse a time-amount-laden reply, and reject it.
    let sawChat = false;
    for (let i = 0; i < 40 && !sawChat; i++) {
      await new Promise((r) => setTimeout(r, 50));
      sawChat = !!stub.state.lastChat;
    }
    assert.ok(sawChat, 'background refine did call the stub');
    await new Promise((r) => setTimeout(r, 200)); // let the (already-resolved) UPDATE guard run
    const after = t.db.prepare('SELECT suggested_narrative FROM timers WHERE id=?').get(timer.id).suggested_narrative;
    assert.equal(after, 'draft development agreement',
      'polluted LLM output must never overwrite the phrasebook suggestion');
  } finally { await t.close(); await stub.close(); }
});

test('ai narrate streams NDJSON tokens and a final assembled narrative', async () => {
  const stub = await startStubOllama('Reviewed lease exhibit; revised legal description.');
  const t = await startTestServer();
  try {
    setSetting(t.db, 'ai', { enabled: true, model: 'llama3.1:8b', url: stub.url });
    const res = await fetch(`${t.base}/api/ai/narrate`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ brief: 'lease exhibit work', mode: 'draft' }),
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /x-ndjson/);
    const lines = (await res.text()).trim().split('\n').map((l) => JSON.parse(l));
    const last = lines.at(-1);
    assert.equal(last.done, true);
    assert.equal(last.narrative, 'Reviewed lease exhibit; revised legal description.');
    const tokens = lines.slice(0, -1);
    assert.ok(tokens.length >= 2, 'multiple token chunks streamed');
    assert.equal(tokens.map((x) => x.token).join(''), last.narrative);
    assert.equal(stub.state.lastChat.stream, true);
  } finally { await t.close(); await stub.close(); }
});

test('ai narrate: validation, shorter/longer rewrite modes, clean failures', async () => {
  const stub = await startStubOllama('Shorter version.');
  const t = await startTestServer();
  try {
    // disabled → clean 400 before any streaming
    assert.equal((await t.fetchJson('POST', '/api/ai/narrate', { brief: 'x' })).status, 400);
    setSetting(t.db, 'ai', { enabled: true, model: 'llama3.1:8b', url: stub.url });
    assert.equal((await t.fetchJson('POST', '/api/ai/narrate', { mode: 'shorter' })).status, 400); // no narrative
    assert.equal((await t.fetchJson('POST', '/api/ai/narrate', {})).status, 400);                  // no brief

    const res = await fetch(`${t.base}/api/ai/narrate`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'shorter', narrative: 'A very long narrative about the lease.' }),
    });
    assert.equal(res.status, 200);
    const last = JSON.parse((await res.text()).trim().split('\n').at(-1));
    assert.equal(last.narrative, 'Shorter version.');
    // the live request is the LAST turn — a rewrite demonstration rides in
    // ahead of it (2026-08-06: shows what "shorter" may cut, and that names
    // and document titles are not it)
    const user = stub.state.lastChat.messages.at(-1).content;
    assert.ok(user.includes('A very long narrative about the lease.'));
    const demo = stub.state.lastChat.messages.slice(1, -1);
    assert.equal(demo.length, 2, 'one shorter-rewrite demonstration pair');
    assert.match(demo[1].content, /J\. Larson/, 'the demonstration keeps the name in full');
    assert.match(stub.state.lastChat.messages[0].content, /plain text/);
    assert.ok(!stub.state.lastChat.messages[0].content.includes('Respond with ONLY this JSON'),
      'no JSON contract in narrate prompts');

    // unreachable ollama → clean 502 JSON (nothing streamed)
    setSetting(t.db, 'ai', { enabled: true, model: 'llama3.1:8b', url: 'http://127.0.0.1:1' });
    assert.equal((await t.fetchJson('POST', '/api/ai/narrate', { brief: 'x' })).status, 502);
  } finally { await t.close(); await stub.close(); }
});

test('ai narrate: multi-byte UTF-8 split across network chunks arrives intact', async () => {
  // Stub that cuts its stream one byte into the em dash's 3-byte UTF-8
  // sequence, so per-chunk Buffer.toString('utf8') would emit U+FFFD.
  const line = (content, done) =>
    JSON.stringify({ message: { role: 'assistant', content }, done }) + '\n';
  const payload = Buffer.from(
    line('Reviewed lease — ', false) + line('revised “Exhibit A”.', false) + line('', true), 'utf8');
  const cut = payload.indexOf(Buffer.from('—', 'utf8')) + 1;
  const srv = createServer((req, res) => {
    res.setHeader('content-type', 'application/x-ndjson');
    res.write(payload.subarray(0, cut));
    setTimeout(() => res.end(payload.subarray(cut)), 30); // force a separate TCP chunk
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const t = await startTestServer();
  try {
    setSetting(t.db, 'ai', { enabled: true, model: 'llama3.1:8b', url: `http://127.0.0.1:${srv.address().port}` });
    const res = await fetch(`${t.base}/api/ai/narrate`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ brief: 'lease work' }),
    });
    assert.equal(res.status, 200);
    const last = JSON.parse((await res.text()).trim().split('\n').at(-1));
    assert.equal(last.done, true);
    assert.ok(!last.narrative.includes('�'), 'no replacement characters from split multi-byte sequences');
    assert.equal(last.narrative, 'Reviewed lease — revised “Exhibit A”.');
  } finally { await t.close(); await new Promise((r) => srv.close(r)); }
});

test('ai narrate aborts the upstream Ollama request when the client disconnects', async () => {
  const upstream = { closed: false };
  const srv = createServer((req, res) => {
    res.setHeader('content-type', 'application/x-ndjson');
    res.write(JSON.stringify({ message: { role: 'assistant', content: 'Reviewed ' }, done: false }) + '\n');
    res.on('close', () => { upstream.closed = true; });
    // …then hold the stream open, like a model still generating.
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const t = await startTestServer();
  try {
    setSetting(t.db, 'ai', { enabled: true, model: 'llama3.1:8b', url: `http://127.0.0.1:${srv.address().port}` });
    const controller = new AbortController();
    const res = await fetch(`${t.base}/api/ai/narrate`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ brief: 'x' }), signal: controller.signal,
    });
    const reader = res.body.getReader();
    await reader.read();          // first token arrived — the stream is live
    controller.abort();           // client walks away mid-stream
    for (let i = 0; i < 40 && !upstream.closed; i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal(upstream.closed, true, 'server tore down its Ollama connection');
    const alive = await t.fetchJson('GET', '/api/timers');
    assert.equal(alive.status, 200, 'server still healthy after the aborted stream');
  } finally { await t.close(); await new Promise((r) => srv.close(r)); }
});

// 2026-07-10 feedback: "jeff" in a brief should resolve against the matter's
// history — the roster and recent phrases ride along as prompt context on
// every AI call that knows its matter.
test('ai narrate/expand carry matter people + phrases so informal names can resolve', async () => {
  const stub = await startStubOllama('Reviewed Vertex Backstop Agreement; incorporated revisions from J. Larson.');
  const t = await startTestServer();
  try {
    setSetting(t.db, 'ai', { enabled: true, model: 'llama3.1:8b', url: stub.url });
    const cm = (await t.fetchJson('POST', '/api/cms', {
      cm_number: '100001-000012', short_name: 'Acme lease',
    })).body;
    // history: an entry whose narrative mentions J. Larson (people extraction
    // fills matter_people on the write)
    await t.fetchJson('POST', '/api/entries', {
      date: '2026-07-06', cm_id: cm.id,
      narrative: 'Telephone conference with J. Larson regarding Compensation Agreement.',
    });

    const r = await t.fetchJson('POST', '/api/ai/narrate', {
      mode: 'draft', brief: 'mark up backstop agreement from jeff', cm_id: cm.id,
    });
    assert.equal(r.status, 200);
    const sys = stub.state.lastChat.messages[0].content;
    // Few-shot pairs sit between the system prompt and the live request
    // (spec 2026-08-01 §4), so the real user turn is always the last one.
    const lastUser = (msgs) => msgs[msgs.length - 1].content;
    const user = lastUser(stub.state.lastChat.messages);
    assert.match(user, /J\. Larson/, 'people roster rides along');
    assert.match(user, /Compensation Agreement/, 'recent phrases ride along');
    assert.match(sys, /informal|first name/i, 'name-resolution rule present');

    // rewrite modes get the same context
    await t.fetchJson('POST', '/api/ai/narrate', {
      mode: 'shorter', narrative: 'Reviewed agreement and mark up from jeff.', cm_id: cm.id,
    });
    assert.match(lastUser(stub.state.lastChat.messages), /J\. Larson/);

    // /ai/expand too
    await t.fetchJson('POST', '/api/ai/expand', {
      brief: 'call with jeff re backstop', totalHours: 0.5, cm_id: cm.id,
    });
    assert.match(lastUser(stub.state.lastChat.messages), /J\. Larson/);

    // no cm_id → no matter context, no crash
    const bare = await t.fetchJson('POST', '/api/ai/narrate', { mode: 'draft', brief: 'misc work' });
    assert.equal(bare.status, 200);
    assert.doesNotMatch(stub.state.lastChat.messages[1].content, /J\. Larson/);
  } finally { await t.close(); await stub.close(); }
});

// 2026-07-14 feedback: a 0.1h entry was narrated like a multi-hour work
// block. When the caller knows the recorded time, every AI narrative call
// carries a grounding rule so the prose scales to the hours.
test('ai narrate/expand ground the prompt in the recorded time', async () => {
  const stub = await startStubOllama(GOOD_CHAT);
  const t = await startTestServer();
  try {
    setSetting(t.db, 'ai', { enabled: true, model: 'llama3.1:8b', url: stub.url });

    const r = await t.fetchJson('POST', '/api/ai/narrate', {
      mode: 'draft', brief: 'quick call re lease', totalHours: 0.1,
    });
    assert.equal(r.status, 200);
    let sys = stub.state.lastChat.messages[0].content;
    assert.match(sys, /0\.1 hours \(6 minutes\)/, 'grounding rule carries the exact time');
    assert.match(sys, /plausibly/i, 'grounding rule instructs scaling');

    // rewrite modes ground too
    await t.fetchJson('POST', '/api/ai/narrate', {
      mode: 'shorter', narrative: 'Reviewed and revised the lease agreement.', totalHours: 0.2,
    });
    assert.match(stub.state.lastChat.messages[0].content, /0\.2 hours \(12 minutes\)/);

    // no time known → no invented grounding
    await t.fetchJson('POST', '/api/ai/narrate', { mode: 'draft', brief: 'misc work' });
    assert.doesNotMatch(stub.state.lastChat.messages[0].content, /recorded time/i);

    // /ai/expand gets the same rule in its system prompt
    await t.fetchJson('POST', '/api/ai/expand', { brief: 'lease work', totalHours: 1.5 });
    assert.match(stub.state.lastChat.messages[0].content, /1\.5 hours \(90 minutes\)/);
  } finally { await t.close(); await stub.close(); }
});
