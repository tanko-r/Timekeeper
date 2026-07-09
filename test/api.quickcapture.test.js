import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { startTestServer } from './helpers.js';
import { setSetting } from '../server/db.js';

// Minimal stub Ollama server — no /api/tags handling needed here since this
// route never checks reachability, only /api/chat. Fuller stub (with
// /api/tags + streaming) lives in test/api.ai.test.js; copied/trimmed here
// per the brief rather than importing, since this endpoint only ever makes
// one non-streaming /api/chat call.
function startStubOllama(chatBody) {
  return new Promise((resolve) => {
    const srv = createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => res.end(JSON.stringify({ message: { role: 'assistant', content: chatBody } })));
    });
    srv.listen(0, '127.0.0.1', () => resolve({
      url: `http://127.0.0.1:${srv.address().port}`,
      close: () => new Promise((r) => srv.close(r)),
    }));
  });
}

async function seed(t) {
  const cm = (await t.fetchJson('POST', '/api/cms',
    { cm_number: '100001-000012', short_name: 'Loading Dock Lease', client_name: 'Meridian' })).body;
  return cm;
}

test('deterministic parse over the live matter list', async () => {
  const t = await startTestServer();
  try {
    const cm = await seed(t);
    const r = await t.fetchJson('POST', '/api/quickcapture', { line: 'call sam re loading dock .3' });
    assert.equal(r.status, 200);
    assert.equal(r.body.hours, 0.3);
    assert.equal(r.body.task_code, 'Call/Conference');
    assert.equal(r.body.matches[0].id, cm.id);
    assert.deepEqual(r.body.missing, []);
  } finally { await t.close(); }
});

test('400 on empty line; archived matters excluded from matching', async () => {
  const t = await startTestServer();
  try {
    const cm = await seed(t);
    assert.equal((await t.fetchJson('POST', '/api/quickcapture', {})).status, 400);
    await t.fetchJson('PATCH', `/api/cms/${cm.id}`, { status: 'archived' });
    const r = await t.fetchJson('POST', '/api/quickcapture', { line: 'call re loading dock .3' });
    assert.ok(r.body.missing.includes('matter'));
  } finally { await t.close(); }
});

test('ai:true fills ONLY missing fields; deterministic wins; amounts rejected', async () => {
  const stub = await startStubOllama(JSON.stringify({
    hours: 2.5, task_code: 'Research', topic: 'zoning setback',
    narrative: 'Research zoning setback requirements (0.5)',
  }));
  const t = await startTestServer();
  try {
    await seed(t);
    setSetting(t.db, 'ai', { enabled: true, model: 'llama3.1:8b', url: stub.url });
    const r = await t.fetchJson('POST', '/api/quickcapture', { line: 'zoning setback question .3', ai: true });
    assert.equal(r.body.hours, 0.3, 'deterministic duration is kept');
    assert.equal(r.body.task_code, 'Research', 'missing action filled by the model');
    assert.ok(!r.body.narrative.includes('(0.5)'), 'amount-laden narrative discarded');
  } finally { await t.close(); await stub.close(); }
});

test('ai:true can supply the topic and rematch the matter from it', async () => {
  // "call jane .5" has no re-marker, so the deterministic topic ("jane")
  // matches nothing; the LLM's topic must drive a second matter match.
  const stub = await startStubOllama(JSON.stringify({
    hours: null, task_code: null, topic: 'loading dock', narrative: null,
  }));
  const t = await startTestServer();
  try {
    const cm = await seed(t);
    setSetting(t.db, 'ai', { enabled: true, model: 'llama3.1:8b', url: stub.url });
    const r = await t.fetchJson('POST', '/api/quickcapture', { line: 'call jane .5', ai: true });
    assert.equal(r.status, 200);
    assert.equal(r.body.matches[0] && r.body.matches[0].id, cm.id, 'LLM topic re-matched the matter');
    assert.ok(!r.body.missing.includes('matter'), 'matter no longer missing');
    assert.equal(r.body.hours, 0.5, 'deterministic duration kept');
    assert.equal(r.body.task_code, 'Call/Conference', 'deterministic verb kept');
  } finally { await t.close(); await stub.close(); }
});

test('ai fill: lowercase task_code normalized; out-of-range hours rejected', async () => {
  const stub = await startStubOllama(JSON.stringify({
    hours: 99, task_code: 'research', topic: null, narrative: null,
  }));
  const t = await startTestServer();
  try {
    await seed(t);
    setSetting(t.db, 'ai', { enabled: true, model: 'llama3.1:8b', url: stub.url });
    const r = await t.fetchJson('POST', '/api/quickcapture', { line: 'zoning setback stuff', ai: true });
    assert.equal(r.body.task_code, 'Research', 'case-insensitive match normalized to canonical code');
    assert.equal(r.body.hours, null, 'hours outside 0<h<=12 rejected');
    assert.ok(r.body.missing.includes('hours'));
  } finally { await t.close(); await stub.close(); }
});

test('ai:true with AI disabled degrades to the deterministic result', async () => {
  const t = await startTestServer();
  try {
    await seed(t);
    const r = await t.fetchJson('POST', '/api/quickcapture', { line: 'zoning setback question', ai: true });
    assert.equal(r.status, 200);
    assert.ok(r.body.missing.includes('action'));
  } finally { await t.close(); }
});
