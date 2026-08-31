import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

async function withServer(fn) {
  const t = await startTestServer();
  try { await fn(t); } finally { await t.close(); }
}

const KINDS = ['document', 'org', 'person'];

test('dictionary: add a global row, list it, rename it', () =>
  withServer(async (t) => {
    const made = await t.fetchJson('POST', '/api/dictionary',
      { name: 'Standard Form Lease', kind: 'document' });
    assert.equal(made.status, 201);
    assert.equal(made.body.matter_id, null);
    assert.equal(made.body.origin, 'manual');

    const list = await t.fetchJson('GET', '/api/dictionary');
    assert.deepEqual(list.body.rows.map((r) => r.name), ['Standard Form Lease']);

    const patched = await t.fetchJson('PATCH', `/api/dictionary/${made.body.id}`,
      { name: 'Standard Lease Form' });
    assert.equal(patched.body.name, 'Standard Lease Form');
    assert.equal(patched.body.locked, 1);
  }));

test('dictionary: validation', () =>
  withServer(async (t) => {
    assert.equal((await t.fetchJson('POST', '/api/dictionary',
      { name: '   ', kind: 'document' })).status, 400);
    assert.equal((await t.fetchJson('POST', '/api/dictionary',
      { name: 'Thing', kind: 'gadget' })).status, 400);
    assert.equal((await t.fetchJson('POST', '/api/dictionary',
      { name: 'Thing', kind: 'org', matter_id: 9999 })).status, 404);
    await t.fetchJson('POST', '/api/dictionary', { name: 'Thing', kind: 'org' });
    assert.equal((await t.fetchJson('POST', '/api/dictionary',
      { name: 'thing', kind: 'org' })).status, 409);
    assert.equal((await t.fetchJson('PATCH', '/api/dictionary/9999',
      { name: 'x' })).status, 404);
    for (const kind of KINDS) {
      assert.equal((await t.fetchJson('POST', '/api/dictionary',
        { name: `Row ${kind}`, kind })).status, 201);
    }
  }));

test('dictionary: deleting a derived row hides it, deleting a manual row removes it', () =>
  withServer(async (t) => {
    const cm = (await t.fetchJson('POST', '/api/cms',
      { cm_number: '100001-000012', short_name: 'Cedar Lease' })).body;
    await t.fetchJson('POST', '/api/entries', {
      date: '2026-08-20', cm_id: cm.id,
      narrative: 'Revise the Access Agreement.',
      tasks: [{ task_code: 'Revise', duration: 0.5, fragment: '' }],
    });
    const rows = (await t.fetchJson('GET', `/api/dictionary?matter_id=${cm.id}`)).body.rows;
    const derived = rows.find((r) => r.name === 'Access Agreement');
    assert.equal(derived.origin, 'derived');

    const gone = await t.fetchJson('DELETE', `/api/dictionary/${derived.id}`);
    assert.equal(gone.body.hidden, true);
    const still = (await t.fetchJson('GET', `/api/dictionary?matter_id=${cm.id}`)).body.rows
      .find((r) => r.id === derived.id);
    assert.equal(still.hidden, 1);   // listed, so he can undo it

    const manual = (await t.fetchJson('POST', '/api/dictionary',
      { name: 'Typed Row', kind: 'org', matter_id: cm.id })).body;
    const removed = await t.fetchJson('DELETE', `/api/dictionary/${manual.id}`);
    assert.equal(removed.body.hidden, false);
    assert.ok(!(await t.fetchJson('GET', `/api/dictionary?matter_id=${cm.id}`)).body.rows
      .some((r) => r.id === manual.id));
  }));

test('dictionary: a matter listing carries its own rows then the global ones', () =>
  withServer(async (t) => {
    const cm = (await t.fetchJson('POST', '/api/cms',
      { cm_number: '100001-000012', short_name: 'Cedar Lease' })).body;
    await t.fetchJson('POST', '/api/dictionary', { name: 'Global Form', kind: 'document' });
    await t.fetchJson('POST', '/api/dictionary',
      { name: 'Matter Thing', kind: 'org', matter_id: cm.id });
    const rows = (await t.fetchJson('GET', `/api/dictionary?matter_id=${cm.id}`)).body.rows;
    assert.deepEqual(rows.map((r) => r.name), ['Matter Thing', 'Global Form']);
  }));

test('dictionary: a hidden row stops predicting immediately', () =>
  withServer(async (t) => {
    const cm = (await t.fetchJson('POST', '/api/cms',
      { cm_number: '100001-000012', short_name: 'Cedar Lease' })).body;
    for (const date of ['2026-08-20', '2026-08-21']) {
      await t.fetchJson('POST', '/api/entries', {
        date, cm_id: cm.id, narrative: 'Revise the Access Agreement.',
        tasks: [{ task_code: 'Revise', duration: 0.4, fragment: '' }],
      });
    }
    const before = await t.fetchJson('GET', `/api/matters/${cm.id}/suggestions`);
    assert.ok(before.body.entities.some((e) => e.name === 'Access Agreement'));

    const row = (await t.fetchJson('GET', `/api/dictionary?matter_id=${cm.id}`)).body.rows
      .find((r) => r.name === 'Access Agreement');
    await t.fetchJson('DELETE', `/api/dictionary/${row.id}`);

    const after = await t.fetchJson('GET', `/api/matters/${cm.id}/suggestions`);
    assert.ok(!after.body.entities.some((e) => e.name === 'Access Agreement'));
  }));
