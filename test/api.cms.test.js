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

test('creating a CM links (and creates) its client and sets matter_number', () => withServer(async (t) => {
  const created = await t.fetchJson('POST', '/api/cms', {
    cm_number: '777001-000042', short_name: 'Linked matter', billable: 1,
  });
  assert.equal(created.status, 201);
  const row = t.db.prepare('SELECT client_id, matter_number FROM matters WHERE id=?').get(created.body.id);
  assert.equal(row.matter_number, '000042');
  const client = t.db.prepare('SELECT client_number, name FROM clients WHERE id=?').get(row.client_id);
  assert.equal(client.client_number, '777001');
  assert.equal(client.name, ''); // blank until named

  // a second matter for the same client reuses the client row
  const second = await t.fetchJson('POST', '/api/cms', { cm_number: '777001-000043', short_name: 'Second' });
  const row2 = t.db.prepare('SELECT client_id FROM matters WHERE id=?').get(second.body.id);
  assert.equal(row2.client_id, row.client_id);
  assert.equal(t.db.prepare("SELECT COUNT(*) c FROM clients WHERE client_number='777001'").get().c, 1);
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

test('picker: one unified fuzzy search over client and matter fields', () => withServer(async (t) => {
  await t.fetchJson('POST', '/api/cms', { cm_number: '100004-000001', short_name: 'Harbor Lease' });
  await t.fetchJson('POST', '/api/cms', { cm_number: '100004-000002', short_name: 'Summit Development' });
  await t.fetchJson('POST', '/api/cms', { cm_number: '100001-000012', short_name: 'Acme lease' });
  const client = (await t.fetchJson('GET', '/api/clients')).body.find((c) => c.client_number === '100004');
  await t.fetchJson('PATCH', `/api/clients/${client.id}`, { name: 'Meridian' });

  // "meri harbor" → client name + matter name, one result
  const fuzzy = (await t.fetchJson('GET', '/api/cms/picker?q=meri%20harbor')).body;
  assert.deepEqual(fuzzy.map((m) => m.short_name), ['Harbor Lease']);

  // client name alone matches all of that client's matters
  const byClient = (await t.fetchJson('GET', '/api/cms/picker?q=meridian')).body;
  assert.equal(byClient.length, 2);

  // 6-digit client number matches its matters
  const byClientNum = (await t.fetchJson('GET', '/api/cms/picker?q=100004')).body;
  assert.equal(byClientNum.length, 2);
}));

test('POST /api/cms client_name names a blank client but never overwrites', () => withServer(async (t) => {
  const a = (await t.fetchJson('POST', '/api/cms', {
    cm_number: '512001-000001', short_name: 'First', client_name: 'Brightwater',
  })).body;
  assert.equal(a.client_name, 'Brightwater');

  const b = (await t.fetchJson('POST', '/api/cms', {
    cm_number: '512001-000002', short_name: 'Second', client_name: 'WRONG',
  })).body;
  assert.equal(b.client_name, 'Brightwater'); // existing name kept
}));

test('POST /api/cms client_name: null or non-string is ignored, not coerced', () => withServer(async (t) => {
  const a = (await t.fetchJson('POST', '/api/cms', {
    cm_number: '512002-000001', short_name: 'First', client_name: null,
  })).body;
  assert.equal(a.client_name, ''); // stays blank, not the string "null"

  const b = (await t.fetchJson('POST', '/api/cms', {
    cm_number: '512002-000002', short_name: 'Second', client_name: 42,
  })).body;
  assert.equal(b.client_name, ''); // non-string ignored, not coerced

  // A later, real string name can still fill the still-blank client.
  const c = (await t.fetchJson('POST', '/api/cms', {
    cm_number: '512002-000003', short_name: 'Third', client_name: 'Real Name',
  })).body;
  assert.equal(c.client_name, 'Real Name');
}));

test('POST /api/cms duplicate cm_number: 409 leaves no client_name side effect', () => withServer(async (t) => {
  const a = (await t.fetchJson('POST', '/api/cms', {
    cm_number: '999001-000001', short_name: 'First',
  })).body;
  assert.equal(a.client_name, '');

  const dup = await t.fetchJson('POST', '/api/cms', {
    cm_number: '999001-000001', short_name: 'Duplicate', client_name: 'SnuckIn',
  });
  assert.equal(dup.status, 409);

  // A failed (409) request must not have named the client behind the scenes.
  const picker = (await t.fetchJson('GET', '/api/cms/picker?q=999001')).body;
  assert.equal(picker.length, 1);
  assert.equal(picker[0].client_name, '');
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

test('matter payloads include client fields', () => withServer(async (t) => {
  const created = (await t.fetchJson('POST', '/api/cms', { cm_number: '909001-000007', short_name: 'Enriched' })).body;
  assert.equal(created.client_number, '909001');
  assert.equal(created.matter_number, '000007');
  assert.equal(created.client_name, '');
  assert.ok(created.client_id);

  const picker = (await t.fetchJson('GET', '/api/cms/picker?q=909001')).body;
  assert.equal(picker[0].client_number, '909001');

  const list = (await t.fetchJson('GET', '/api/cms')).body;
  assert.ok(list.every((m) => 'client_number' in m));
}));

test('matter payloads include client_task_billing (additive), defaulting to 1', () => withServer(async (t) => {
  const created = (await t.fetchJson('POST', '/api/cms', { cm_number: '909002-000001', short_name: 'Flagged' })).body;
  assert.equal(created.client_task_billing, 1);

  await t.fetchJson('PATCH', `/api/clients/${created.client_id}`, { task_billing: 0 });
  const list = (await t.fetchJson('GET', '/api/cms')).body;
  assert.equal(list.find((m) => m.id === created.id).client_task_billing, 0);

  const picker = (await t.fetchJson('GET', '/api/cms/picker?q=909002')).body;
  assert.equal(picker[0].client_task_billing, 0);
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

test('client_name locks to the number at creation — a later matter never renames the client', () => withServer(async (t) => {
  const first = await t.fetchJson('POST', '/api/cms', {
    cm_number: '555001-000001', short_name: 'First matter', client_name: 'Initech',
  });
  assert.equal(first.status, 201);
  assert.equal(first.body.client_name, 'Initech');

  const second = await t.fetchJson('POST', '/api/cms', {
    cm_number: '555001-000002', short_name: 'Second matter', client_name: 'Wrong Name LLC',
  });
  assert.equal(second.status, 201);
  assert.equal(second.body.client_name, 'Initech', 'existing client name kept — matters never rename');
}));
