import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';
import { setSetting, getSetting } from '../server/db.js';

const REMOTE = { 'cf-connecting-ip': '203.0.113.5', 'cf-ray': 'abc123-SJC' };

async function withServer(fn) {
  const t = await startTestServer();
  try { await fn(t); } finally { await t.close(); }
}

function cookieFrom(res) {
  const raw = res.headers.get('set-cookie') || '';
  return raw.split(';')[0];
}

test('LAN requests pass with no password configured; remote is refused', () =>
  withServer(async (t) => {
    const lan = await t.fetchJson('GET', '/api/settings');
    assert.equal(lan.status, 200);

    const remote = await t.fetchJson('GET', '/api/settings', undefined, REMOTE);
    assert.equal(remote.status, 403);
    assert.equal(remote.body.error, 'no_password_set');

    // static shell still serves remotely (it holds no data)
    const shell = await fetch(t.base + '/', { headers: REMOTE });
    assert.equal(shell.status, 200);
  }));

test('full remote flow: set password on LAN, login remotely, cookie works, logout kills it', () =>
  withServer(async (t) => {
    const set = await t.fetchJson('POST', '/api/auth/password', { next: 'correct horse battery' });
    assert.equal(set.status, 200);

    const before = await t.fetchJson('GET', '/api/settings', undefined, REMOTE);
    assert.equal(before.status, 401);
    assert.equal(before.body.error, 'auth_required');

    const bad = await t.fetchJson('POST', '/api/auth/login', { password: 'wrong' }, REMOTE);
    assert.equal(bad.status, 401);

    const login = await fetch(t.base + '/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...REMOTE },
      body: JSON.stringify({ password: 'correct horse battery' }),
    });
    assert.equal(login.status, 200);
    const cookie = cookieFrom(login);
    assert.match(cookie, /^tk_session=/);

    const authed = await t.fetchJson('GET', '/api/settings', undefined, { ...REMOTE, cookie });
    assert.equal(authed.status, 200);

    const status = (await t.fetchJson('GET', '/api/auth/status', undefined, { ...REMOTE, cookie })).body;
    assert.equal(status.loggedIn, true);
    assert.equal(status.remote, true);
    assert.equal(status.passwordSet, true);

    await t.fetchJson('POST', '/api/auth/logout', {}, { ...REMOTE, cookie });
    const after = await t.fetchJson('GET', '/api/settings', undefined, { ...REMOTE, cookie });
    assert.equal(after.status, 401);
  }));

test('login rate limited after repeated failures', () =>
  withServer(async (t) => {
    await t.fetchJson('POST', '/api/auth/password', { next: 'correct horse battery' });
    let last;
    for (let i = 0; i < 11; i++) {
      last = await t.fetchJson('POST', '/api/auth/login', { password: `wrong-${i}` }, REMOTE);
    }
    assert.equal(last.status, 429);
  }));

test('password change requires current password once set', () =>
  withServer(async (t) => {
    await t.fetchJson('POST', '/api/auth/password', { next: 'correct horse battery' });
    const noCurrent = await t.fetchJson('POST', '/api/auth/password', { next: 'new password here' });
    assert.equal(noCurrent.status, 401);
    const wrong = await t.fetchJson('POST', '/api/auth/password', {
      current: 'nope', next: 'new password here',
    });
    assert.equal(wrong.status, 401);
    const ok = await t.fetchJson('POST', '/api/auth/password', {
      current: 'correct horse battery', next: 'new password here',
    });
    assert.equal(ok.status, 200);
    // password change cannot be driven from a remote, unauthenticated request
    const remote = await t.fetchJson('POST', '/api/auth/password', {
      current: 'new password here', next: 'sneaky remote change',
    }, REMOTE);
    assert.equal(remote.status, 401);
  }));

test('auth mode always guards LAN too; mode off guards nothing', () =>
  withServer(async (t) => {
    await t.fetchJson('POST', '/api/auth/password', { next: 'correct horse battery' });
    setSetting(t.db, 'auth', { ...getSetting(t.db, 'auth'), mode: 'always' });
    const lan = await t.fetchJson('GET', '/api/settings');
    assert.equal(lan.status, 401);

    setSetting(t.db, 'auth', { ...getSetting(t.db, 'auth'), mode: 'off' });
    const remote = await t.fetchJson('GET', '/api/settings', undefined, REMOTE);
    assert.equal(remote.status, 200);
  }));

test('auth mode endpoint: validates value, guarded from unauthenticated remote', () =>
  withServer(async (t) => {
    const bad = await t.fetchJson('POST', '/api/auth/mode', { mode: 'bogus' });
    assert.equal(bad.status, 400);

    const ok = await t.fetchJson('POST', '/api/auth/mode', { mode: 'always' });
    assert.equal(ok.status, 200);
    assert.equal(getSetting(t.db, 'auth').mode, 'always');

    // remote + no session cannot flip the mode (would be a lockout/bypass vector)
    const remote = await t.fetchJson('POST', '/api/auth/mode', { mode: 'off' }, REMOTE);
    assert.equal(remote.status, 401);
    assert.equal(getSetting(t.db, 'auth').mode, 'always');
  }));

test('mutating requests with a foreign Origin are rejected', () =>
  withServer(async (t) => {
    const evil = await t.fetchJson('POST', '/api/cms',
      { cm_number: '111111-000001', short_name: 'x' },
      { origin: 'https://evil.example.com' });
    assert.equal(evil.status, 403);

    const sameHost = await t.fetchJson('POST', '/api/cms',
      { cm_number: '111111-000001', short_name: 'x' },
      { origin: t.base });
    assert.equal(sameHost.status, 201);
  }));

test('backup endpoints are guarded from unauthenticated remote requests', () =>
  withServer(async (t) => {
    const r = await t.fetchJson('GET', '/api/backup/db', undefined, REMOTE);
    assert.equal(r.status, 403); // no password set → refused outright
    await t.fetchJson('POST', '/api/auth/password', { next: 'correct horse battery' });
    const r2 = await t.fetchJson('GET', '/api/backup/db', undefined, REMOTE);
    assert.equal(r2.status, 401);
  }));

test('Tailscale CGNAT peers count as local (LAN-equivalent)', async () => {
  const { isRemote } = await import('../server/auth.js');
  const fake = (ip, headers = {}) => ({ headers, ip, socket: { remoteAddress: ip } });
  assert.equal(isRemote(fake('100.100.100.100')), false); // tailnet peer
  assert.equal(isRemote(fake('100.130.0.1')), true);    // outside 100.64/10
  assert.equal(isRemote(fake('8.8.8.8')), true);
});
