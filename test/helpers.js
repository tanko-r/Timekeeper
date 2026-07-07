// Shared test bootstrap: spins up a real server on an ephemeral port with a
// temp database, returns { base, db, close, fetchJson }.
process.env.TZ = 'America/Los_Angeles';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function startTestServer(overrides = {}) {
  const { openDb } = await import('../server/db.js');
  const { createApp } = await import('../server/app.js');
  const dir = mkdtempSync(join(tmpdir(), 'tk-test-'));
  const db = openDb(join(dir, 'test.db'));
  const config = {
    PORT: 0,
    HOST: '127.0.0.1',
    DATA_DIR: dir,
    TRUST_LAN: true,
    ...overrides.config,
  };
  const clock = overrides.clock || (() => new Date());
  const app = createApp({ db, config, clock });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  async function fetchJson(method, path, body, headers = {}) {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
    return { status: res.status, body: json, headers: res.headers };
  }

  return {
    base,
    db,
    dir,
    fetchJson,
    close: async () => {
      await new Promise((r) => server.close(r));
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
