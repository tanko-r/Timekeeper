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

test('clients: task_billing defaults to 1 and can be flipped to 0 via PATCH', () => withServer(async (t) => {
  await t.fetchJson('POST', '/api/cms', { cm_number: '808001-000001', short_name: 'M' });
  const client = (await t.fetchJson('GET', '/api/clients')).body[0];
  assert.equal(client.task_billing, 1);

  const patched = await t.fetchJson('PATCH', `/api/clients/${client.id}`, { task_billing: 0 });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.task_billing, 0);

  const get = await t.fetchJson('GET', `/api/clients/${client.id}`);
  assert.equal(get.body.task_billing, 0);

  // 0/1 coercion for truthy/falsy inputs, not raw passthrough
  const back = await t.fetchJson('PATCH', `/api/clients/${client.id}`, { task_billing: true });
  assert.equal(back.body.task_billing, 1);
}));

test('clients: 409 rejects client_number change when the client has matters (would break cm_number linkage)', () => withServer(async (t) => {
  await t.fetchJson('POST', '/api/cms', { cm_number: '111111-000001', short_name: 'M' });
  const client = (await t.fetchJson('GET', '/api/clients')).body.find((c) => c.client_number === '111111');

  const renamed = await t.fetchJson('PATCH', `/api/clients/${client.id}`, { client_number: '222222' });
  assert.equal(renamed.status, 409);

  // client_number is untouched, and the matter's derived cm_number/client link still agree.
  const stillThere = (await t.fetchJson('GET', `/api/clients/${client.id}`)).body;
  assert.equal(stillThere.client_number, '111111');
  const matter = t.db.prepare('SELECT cm_number, client_id FROM matters WHERE client_id=?').get(client.id);
  assert.equal(matter.cm_number, '111111-000001');

  // name-only patches are unaffected by the guard.
  const renamedOk = await t.fetchJson('PATCH', `/api/clients/${client.id}`, { name: 'Acme' });
  assert.equal(renamedOk.status, 200);
  assert.equal(renamedOk.body.name, 'Acme');
}));
