import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

test('backup: sqlite download, json dump without secrets, list', async () => {
  const t = await startTestServer();
  try {
    await t.fetchJson('POST', '/api/cms', { cm_number: '100001-000012', short_name: 'Acme' });
    await t.fetchJson('POST', '/api/auth/password', { next: 'correct horse battery' });

    const dbRes = await fetch(t.base + '/api/backup/db');
    assert.equal(dbRes.status, 200);
    assert.match(dbRes.headers.get('content-disposition') || '', /attachment/);
    const buf = Buffer.from(await dbRes.arrayBuffer());
    assert.equal(buf.subarray(0, 15).toString(), 'SQLite format 3');

    const json = await t.fetchJson('GET', '/api/backup/json');
    assert.equal(json.status, 200);
    assert.equal(json.body.matters.length, 1);
    assert.ok(Array.isArray(json.body.matter_people), 'dump must include matter_people');
    assert.ok(Array.isArray(json.body.shortcuts), 'dump must include shortcuts');
    assert.ok(Array.isArray(json.body.clients));
    assert.ok(Array.isArray(json.body.entries));
    assert.ok(Array.isArray(json.body.task_codes));
    assert.equal(JSON.stringify(json.body).includes('passwordHash'), false);

    const list = await t.fetchJson('GET', '/api/backup/list');
    assert.equal(list.status, 200);
    assert.ok(Array.isArray(list.body));
  } finally { await t.close(); }
});
