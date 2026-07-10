// Unit tests for the spike page's "Run via server Ollama" enable logic
// (public/js/spike-ollama-status.js). This is the fix for the button that
// stayed permanently disabled: it must enable off GET /api/ai/status alone,
// independent of whether a WebLLM browser model has loaded.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ollamaEnableState } from '../public/js/spike-ollama-status.js';

test('enabled + reachable -> button enabled', () => {
  const r = ollamaEnableState({ enabled: true, reachable: true, model: 'llama3.1:8b', url: 'http://127.0.0.1:11434' });
  assert.equal(r.enabled, true);
  assert.match(r.reason, /llama3\.1:8b/);
});

test('AI disabled in Settings -> button disabled with reason', () => {
  const r = ollamaEnableState({ enabled: false, reachable: true, model: 'llama3.1:8b', url: 'http://127.0.0.1:11434' });
  assert.equal(r.enabled, false);
  assert.match(r.reason, /disabled in Settings/);
});

test('enabled but Ollama unreachable -> button disabled with reason', () => {
  const r = ollamaEnableState({ enabled: true, reachable: false, model: 'llama3.1:8b', url: 'http://127.0.0.1:11434' });
  assert.equal(r.enabled, false);
  assert.match(r.reason, /not reachable/);
});

test('missing/null status -> button disabled, no throw', () => {
  const r = ollamaEnableState(null);
  assert.equal(r.enabled, false);
});
