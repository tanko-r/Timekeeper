import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

// One server for the file, task-codes test style.
const srv = await startTestServer();
test.after(() => srv.close());
const { fetchJson, db } = srv;

// seed: client 111111 with matters -000001 and -000002
const { body: m1 } = await fetchJson('POST', '/api/cms', { cm_number: '111111-000001', short_name: 'Meridian A' });
const { body: m2 } = await fetchJson('POST', '/api/cms', { cm_number: '111111-000002', short_name: 'Meridian B' });
const clientId = db.prepare("SELECT id FROM clients WHERE client_number='111111'").get().id;

test('POST validates ownership and shape', async () => {
  assert.equal((await fetchJson('POST', '/api/custom-fields', { name: 'Phase' })).status, 400);
  assert.equal((await fetchJson('POST', '/api/custom-fields',
    { client_id: clientId, matter_id: m1.id, name: 'Phase' })).status, 400);
  assert.equal((await fetchJson('POST', '/api/custom-fields', { client_id: 999999, name: 'Phase' })).status, 400);
  assert.equal((await fetchJson('POST', '/api/custom-fields', { client_id: clientId, name: '  ' })).status, 400);
  assert.equal((await fetchJson('POST', '/api/custom-fields',
    { client_id: clientId, name: 'Bad', pattern: '(' })).status, 400);
  assert.equal((await fetchJson('POST', '/api/custom-fields',
    { client_id: clientId, name: 'Bad', options: 'P100,P200' })).status, 400); // must be an array
});

let phaseId, taskId, matterPhaseId;

test('CRUD round-trip with parsed options', async () => {
  const phase = await fetchJson('POST', '/api/custom-fields', {
    client_id: clientId, name: 'Phase', type: 'select', options: ['P100', 'P200'], required: true,
  });
  assert.equal(phase.status, 201);
  assert.deepEqual(phase.body.options, ['P100', 'P200']);
  phaseId = phase.body.id;

  const dup = await fetchJson('POST', '/api/custom-fields', { client_id: clientId, name: 'Phase' });
  assert.equal(dup.status, 409);

  const task = await fetchJson('POST', '/api/custom-fields', {
    client_id: clientId, name: 'Task', pattern: 'A\\d{3}', pattern_hint: 'A###',
  });
  assert.equal(task.status, 201);
  taskId = task.body.id;

  const list = await fetchJson('GET', `/api/custom-fields?client_id=${clientId}`);
  assert.deepEqual(list.body.map((f) => f.name), ['Phase', 'Task']);

  const patched = await fetchJson('PATCH', `/api/custom-fields/${taskId}`, { required: true, pattern_hint: 'A### (UTBMS)' });
  assert.equal(patched.body.required, 1);

  await fetchJson('PUT', '/api/custom-fields/order', { ids: [taskId, phaseId] });
  const reordered = await fetchJson('GET', `/api/custom-fields?client_id=${clientId}`);
  assert.deepEqual(reordered.body.map((f) => f.name), ['Task', 'Phase']);
  await fetchJson('PUT', '/api/custom-fields/order', { ids: [phaseId, taskId] }); // restore
});

test('effective merge: matter override wins, inactive drop out', async () => {
  const mp = await fetchJson('POST', '/api/custom-fields', {
    matter_id: m1.id, name: 'phase', type: 'text', pattern: 'PH-\\d+',
  });
  matterPhaseId = mp.body.id;
  const eff1 = await fetchJson('GET', `/api/custom-fields/effective/${m1.id}`);
  assert.deepEqual(eff1.body.map((f) => f.id), [taskId, matterPhaseId]); // client Task + matter phase (override)
  const eff2 = await fetchJson('GET', `/api/custom-fields/effective/${m2.id}`);
  assert.deepEqual(eff2.body.map((f) => f.id), [phaseId, taskId]); // sibling matter: client set untouched
  assert.equal((await fetchJson('GET', '/api/custom-fields/effective/424242')).status, 404);

  await fetchJson('PATCH', `/api/custom-fields/${matterPhaseId}`, { active: false });
  const eff3 = await fetchJson('GET', `/api/custom-fields/effective/${m1.id}`);
  assert.deepEqual(eff3.body.map((f) => f.id), [phaseId, taskId]); // override released
  await fetchJson('PATCH', `/api/custom-fields/${matterPhaseId}`, { active: true });
});

test('DELETE blocked once values exist', async () => {
  const e = await fetchJson('POST', '/api/entries', {
    date: '2026-07-15', cm_id: m1.id, narrative: 'seed', tasks: [{ duration: 0.5 }],
  });
  db.prepare('INSERT INTO entry_custom_values (entry_id, field_id, value) VALUES (?, ?, ?)')
    .run(e.body.id, matterPhaseId, 'PH-1');
  const blocked = await fetchJson('DELETE', `/api/custom-fields/${matterPhaseId}`);
  assert.equal(blocked.status, 409);
  db.prepare('DELETE FROM entry_custom_values WHERE field_id=?').run(matterPhaseId);
  assert.equal((await fetchJson('DELETE', `/api/custom-fields/${matterPhaseId}`)).status, 200);
});
