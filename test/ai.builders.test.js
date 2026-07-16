import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { systemPrompt, formatContract, NAME_RESOLUTION_RULE, DEFAULT_AI_INSTRUCTIONS, checkOllamaReachable } from '../server/routes/ai.js';

test('formatContract lists the given task codes and the JSON contract', () => {
  const out = formatContract(['Review', 'Draft']);
  assert.match(out, /task_code MUST be one of: Review, Draft/);
  assert.match(out, /"narrative": "\.\.\."/);
});

test('systemPrompt falls back to DEFAULT_AI_INSTRUCTIONS when custom is empty', () => {
  const out = systemPrompt(['Review'], '');
  assert.match(out, new RegExp(DEFAULT_AI_INSTRUCTIONS.split('\n')[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(out, /task_code MUST be one of: Review/);
});

test('systemPrompt uses custom instructions when provided', () => {
  const out = systemPrompt(['Review'], 'Be extremely terse.');
  assert.match(out, /Be extremely terse\./);
});

test('NAME_RESOLUTION_RULE mentions informal name resolution', () => {
  assert.match(NAME_RESOLUTION_RULE, /informal/);
});

function startStubTags(models) {
  return new Promise((resolve) => {
    const srv = createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ models: models.map((name) => ({ name })) }));
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, url: `http://127.0.0.1:${srv.address().port}` }));
  });
}

test('checkOllamaReachable reports reachable + model list on success', async () => {
  const { srv, url } = await startStubTags(['llama3.1:8b', 'gemma4:12b']);
  try {
    const result = await checkOllamaReachable(url);
    assert.deepEqual(result, { reachable: true, models: ['llama3.1:8b', 'gemma4:12b'] });
  } finally {
    srv.close();
  }
});

test('checkOllamaReachable reports unreachable when nothing is listening', async () => {
  const result = await checkOllamaReachable('http://127.0.0.1:1');
  assert.deepEqual(result, { reachable: false, models: [] });
});
