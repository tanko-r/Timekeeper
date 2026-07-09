import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

async function withServer(fn) {
  const t = await startTestServer();
  try { await fn(t); } finally { await t.close(); }
}

test('CM CRUD with format validation', () => withServer(async (t) => {
  const bad = await t.fetchJson('POST', '/api/cms', { cm_number: '123-456', short_name: 'Bad' });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /format/i);

  const created = await t.fetchJson('POST', '/api/cms', {
    cm_number: '100001-000012', short_name: 'Acme lease dispute', billable: 1,
  });
  assert.equal(created.status, 201);
  const id = created.body.id;

  const dupe = await t.fetchJson('POST', '/api/cms', { cm_number: '100001-000012', short_name: 'dupe' });
  assert.equal(dupe.status, 409);

  const patched = await t.fetchJson('PATCH', `/api/cms/${id}`, { favorite: 1, short_name: 'Acme lease' });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.favorite, 1);
  assert.equal(patched.body.short_name, 'Acme lease');

  const list = await t.fetchJson('GET', '/api/cms');
  assert.equal(list.body.length, 1);
}));

test('archive hides from picker but keeps CM', () => withServer(async (t) => {
  const a = (await t.fetchJson('POST', '/api/cms', { cm_number: '111111-000001', short_name: 'Active co' })).body;
  const b = (await t.fetchJson('POST', '/api/cms', { cm_number: '111111-000002', short_name: 'Old co' })).body;
  await t.fetchJson('PATCH', `/api/cms/${b.id}`, { status: 'archived' });

  const picker = await t.fetchJson('GET', '/api/cms/picker?q=');
  assert.deepEqual(picker.body.map((c) => c.id), [a.id]);

  const all = await t.fetchJson('GET', '/api/cms?includeArchived=1');
  assert.equal(all.body.length, 2);

  const dflt = await t.fetchJson('GET', '/api/cms');
  assert.equal(dflt.body.length, 1);
}));

test('picker: favorites first, then recent, then alpha; searches number and name', () => withServer(async (t) => {
  const mk = async (num, name, fav = 0) =>
    (await t.fetchJson('POST', '/api/cms', { cm_number: num, short_name: name, favorite: fav })).body;
  const zebra = await mk('300000-000001', 'Zenith Corp');
  const apple = await mk('300000-000002', 'Aspen Partners');
  const fav = await mk('300000-000003', 'Favorite Client', 1);
  // make zebra "recent" via last_used_at
  t.db.prepare("UPDATE matters SET last_used_at='2026-07-06T10:00:00Z' WHERE id=?").run(zebra.id);

  const picker = (await t.fetchJson('GET', '/api/cms/picker?q=')).body;
  assert.deepEqual(picker.map((c) => c.id), [fav.id, zebra.id, apple.id]);

  const byNum = (await t.fetchJson('GET', '/api/cms/picker?q=300000-000002')).body;
  assert.deepEqual(byNum.map((c) => c.id), [apple.id]);

  const byName = (await t.fetchJson('GET', '/api/cms/picker?q=aspen')).body;
  assert.deepEqual(byName.map((c) => c.id), [apple.id]);
}));

test('cannot hard-delete a CM with entries; unreferenced CM deletes', () => withServer(async (t) => {
  const cm = (await t.fetchJson('POST', '/api/cms', { cm_number: '222222-000001', short_name: 'Used' })).body;
  t.db.prepare(
    "INSERT INTO entries (date, cm_id, narrative, billable, status, source) VALUES ('2026-07-06', ?, 'n', 1, 'draft', 'manual')"
  ).run(cm.id);
  const del = await t.fetchJson('DELETE', `/api/cms/${cm.id}`);
  assert.equal(del.status, 409);

  const free = (await t.fetchJson('POST', '/api/cms', { cm_number: '222222-000002', short_name: 'Unused' })).body;
  const ok = await t.fetchJson('DELETE', `/api/cms/${free.id}`);
  assert.equal(ok.status, 200);
}));

test('task codes: CRUD and reorder', () => withServer(async (t) => {
  const list = (await t.fetchJson('GET', '/api/task-codes')).body;
  assert.equal(list.length, 11);

  const added = await t.fetchJson('POST', '/api/task-codes', { name: 'Deposition' });
  assert.equal(added.status, 201);

  const renamed = await t.fetchJson('PATCH', `/api/task-codes/${added.body.id}`, { name: 'Deposition Prep' });
  assert.equal(renamed.body.name, 'Deposition Prep');

  const ids = (await t.fetchJson('GET', '/api/task-codes')).body.map((c) => c.id).reverse();
  const reordered = await t.fetchJson('PUT', '/api/task-codes/order', { ids });
  assert.equal(reordered.status, 200);
  const after = (await t.fetchJson('GET', '/api/task-codes')).body;
  assert.deepEqual(after.map((c) => c.id), ids);

  const gone = await t.fetchJson('DELETE', `/api/task-codes/${added.body.id}`);
  assert.equal(gone.status, 200);
  assert.equal((await t.fetchJson('GET', '/api/task-codes')).body.length, 11);
}));

test('settings: read and per-key deep merge', () => withServer(async (t) => {
  const before = (await t.fetchJson('GET', '/api/settings')).body;
  assert.equal(before.validation.minNarrativeChars, 20);

  const patched = await t.fetchJson('PATCH', '/api/settings', {
    validation: { minNarrativeChars: 30 },
    targets: { dailyHours: 7.5 },
  });
  assert.equal(patched.status, 200);

  const after = (await t.fetchJson('GET', '/api/settings')).body;
  assert.equal(after.validation.minNarrativeChars, 30);
  assert.deepEqual(after.validation.bannedPhrases, ['work on', 'attention to', 'review file']); // untouched by merge
  assert.equal(after.targets.dailyHours, 7.5);
  assert.equal(after.idleNudgeHours, 3);
  assert.equal(after.ai.enabled, false);
  assert.equal(after.tim.u2, 'GEN01');
}));
