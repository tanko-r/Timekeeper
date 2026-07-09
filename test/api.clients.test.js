import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

async function withServer(fn) {
  const t = await startTestServer();
  try { await fn(t); } finally { await t.close(); }
}

test('clients: list reflects migrated/created clients with matter counts', () => withServer(async (t) => {
  await t.fetchJson('POST', '/api/cms', { cm_number: '505001-000001', short_name: 'M1' });
  await t.fetchJson('POST', '/api/cms', { cm_number: '505001-000002', short_name: 'M2' });
  await t.fetchJson('POST', '/api/cms', { cm_number: '505002-000001', short_name: 'Other' });

  const list = (await t.fetchJson('GET', '/api/clients')).body;
  const c1 = list.find((c) => c.client_number === '505001');
  const c2 = list.find((c) => c.client_number === '505002');
  assert.equal(c1.matter_count, 2);
  assert.equal(c2.matter_count, 1);
  assert.equal(c1.name, ''); // blank until named
}));

test('clients: PATCH sets the name', () => withServer(async (t) => {
  await t.fetchJson('POST', '/api/cms', { cm_number: '606001-000001', short_name: 'M' });
  const client = (await t.fetchJson('GET', '/api/clients')).body[0];
  const patched = await t.fetchJson('PATCH', `/api/clients/${client.id}`, { name: 'Meridian' });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.name, 'Meridian');

  const get = await t.fetchJson('GET', `/api/clients/${client.id}`);
  assert.equal(get.body.name, 'Meridian');
}));

test('clients: 404 for unknown id, 400 for bad client_number', () => withServer(async (t) => {
  assert.equal((await t.fetchJson('GET', '/api/clients/9999')).status, 404);
  await t.fetchJson('POST', '/api/cms', { cm_number: '707001-000001', short_name: 'M' });
  const client = (await t.fetchJson('GET', '/api/clients')).body[0];
  const bad = await t.fetchJson('PATCH', `/api/clients/${client.id}`, { client_number: '12345' });
  assert.equal(bad.status, 400);
}));
