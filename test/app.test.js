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

// The shell must never be handed out with a lifetime the client can sit on:
// the service worker is what makes the app load fast, and a browser-held copy
// only breaks updates. Express's own default (max-age=0) is not enough —
// Cloudflare's Browser Cache TTL rewrites a bare max-age=0 into hours, which
// is how a remote PWA ended up running pre-fix JS after a CACHE bump.
test('shell assets are served no-cache so updates are never pinned', async () => {
  const t = await startTestServer();
  try {
    for (const path of ['/', '/index.html', '/js/app.js', '/css/app.css', '/sw.js', '/#/anything']) {
      const res = await fetch(t.base + path);
      assert.equal(res.status, 200, path);
      assert.equal(res.headers.get('cache-control'), 'no-cache', path);
    }
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
