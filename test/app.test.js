import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

test('server boots, health endpoint responds, SPA shell served', async () => {
  const t = await startTestServer();
  try {
    const health = await t.fetchJson('GET', '/api/health');
    assert.equal(health.status, 200);
    assert.equal(health.body.ok, true);

    const shell = await fetch(t.base + '/');
    assert.equal(shell.status, 200);
    const html = await shell.text();
    assert.match(html, /Timekeeper/);

    const vendor = await fetch(t.base + '/vendor/react.production.min.js');
    assert.equal(vendor.status, 200);
  } finally {
    await t.close();
  }
});

test('unknown /api path returns JSON 404, not HTML', async () => {
  const t = await startTestServer();
  try {
    const res = await t.fetchJson('GET', '/api/nope');
    assert.equal(res.status, 404);
    assert.ok(res.body.error);
  } finally {
    await t.close();
  }
});
