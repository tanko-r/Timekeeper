// Pure enable/disable logic for the spike page's "Run via server Ollama"
// button, split out of spike-webllm.html so it's unit-testable without a
// DOM/browser (see test/spike-ollama-status.test.js). Mirrors the same
// `status.reachable` / `cfg.enabled` fields the app's Settings → AI panel
// reads off GET /api/ai/status (public/js/views/settings.js).
export function ollamaEnableState(status) {
  if (!status || !status.enabled) return { enabled: false, reason: 'AI is disabled in Settings → AI.' };
  if (!status.reachable) return { enabled: false, reason: `Ollama not reachable at ${status.url}.` };
  return { enabled: true, reason: `Ready — ${status.model} @ ${status.url}.` };
}
