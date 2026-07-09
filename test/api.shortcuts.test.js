import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

async function withServer(fn) {
  const t = await startTestServer();
  try { await fn(t); } finally { await t.close(); }
}

test('shortcuts: create, list (alpha, case-insensitive), delete', () => withServer(async (t) => {
  const a = await t.fetchJson('POST', '/api/shortcuts', { abbrev: 'IA', phrase: 'Interconnect Agreement' });
  assert.equal(a.status, 201);
  assert.equal(a.body.abbrev, 'IA');
  await t.fetchJson('POST', '/api/shortcuts', { abbrev: 'agmt', phrase: '  access   agreement ' });

  const list = (await t.fetchJson('GET', '/api/shortcuts')).body;
  assert.deepEqual(list.map((s) => s.abbrev), ['agmt', 'IA']);
  assert.equal(list.find((s) => s.abbrev === 'agmt').phrase, 'access agreement'); // whitespace collapsed

  assert.equal((await t.fetchJson('DELETE', `/api/shortcuts/${a.body.id}`)).status, 200);
  assert.equal((await t.fetchJson('GET', '/api/shortcuts')).body.length, 1);
  assert.equal((await t.fetchJson('DELETE', '/api/shortcuts/999')).status, 404);
}));

test('shortcuts: validation and case-insensitive uniqueness', () => withServer(async (t) => {
  assert.equal((await t.fetchJson('POST', '/api/shortcuts', { abbrev: 'has space', phrase: 'x' })).status, 400);
  assert.equal((await t.fetchJson('POST', '/api/shortcuts', { abbrev: '', phrase: 'x' })).status, 400);
  assert.equal((await t.fetchJson('POST', '/api/shortcuts', { abbrev: 'ok', phrase: '' })).status, 400);
  assert.equal((await t.fetchJson('POST', '/api/shortcuts', { abbrev: 'IA', phrase: 'one' })).status, 201);
  assert.equal((await t.fetchJson('POST', '/api/shortcuts', { abbrev: 'ia', phrase: 'two' })).status, 409);
}));
