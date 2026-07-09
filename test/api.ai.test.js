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
    const user = stub.state.lastChat.messages[1].content;
    assert.ok(user.includes('A very long narrative about the lease.'));
    assert.match(stub.state.lastChat.messages[0].content, /plain text/);
    assert.ok(!stub.state.lastChat.messages[0].content.includes('Respond with ONLY this JSON'),
      'no JSON contract in narrate prompts');

    // unreachable ollama → clean 502 JSON (nothing streamed)
    setSetting(t.db, 'ai', { enabled: true, model: 'llama3.1:8b', url: 'http://127.0.0.1:1' });
    assert.equal((await t.fetchJson('POST', '/api/ai/narrate', { brief: 'x' })).status, 502);
  } finally { await t.close(); await stub.close(); }
});
