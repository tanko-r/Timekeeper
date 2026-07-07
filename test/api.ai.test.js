import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { startTestServer } from './helpers.js';
import { setSetting, getSetting } from '../server/db.js';

// Stub Ollama server.
function startStubOllama(chatBody) {
  return new Promise((resolve) => {
    const srv = createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/api/tags') {
        res.end(JSON.stringify({ models: [{ name: 'llama3.1:8b' }, { name: 'gemma4:12b' }] }));
      } else if (req.url === '/api/chat') {
        res.end(JSON.stringify({ message: { role: 'assistant', content: chatBody } }));
      } else {
        res.statusCode = 404;
        res.end('{}');
      }
    });
    srv.listen(0, '127.0.0.1', () => resolve({
      url: `http://127.0.0.1:${srv.address().port}`,
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
