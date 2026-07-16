import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLlmFillMessages } from '../server/routes/quickcapture.js';

test('buildLlmFillMessages builds a system+user message pair', () => {
  const parsed = { hours: 0.5, task_code: 'Review', person: null, topic: null, narrative: null };
  const messages = buildLlmFillMessages('call w jeff re lease .5', parsed, ['Review', 'Draft']);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, 'system');
  assert.match(messages[0].content, /task_code MUST be one of: Review, Draft/);
  assert.equal(messages[1].role, 'user');
  assert.match(messages[1].content, /Line: call w jeff re lease \.5/);
  assert.match(messages[1].content, /"hours":0\.5/);
  assert.match(messages[1].content, /"task_code":"Review"/);
});
