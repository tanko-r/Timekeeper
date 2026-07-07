import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

async function withServer(fn) {
  const t = await startTestServer();
  try {
    const cm = (await t.fetchJson('POST', '/api/cms', {
      cm_number: '100001-000012', short_name: 'Acme lease', billable: 1,
    })).body;
    const nb = (await t.fetchJson('POST', '/api/cms', {
      cm_number: '100001-000099', short_name: 'Pro bono', billable: 0,
    })).body;
    await fn(t, cm, nb);
  } finally { await t.close(); }
}

test('create entry: billable defaults from CM, totals sum, validation attached', () =>
  withServer(async (t, cm, nb) => {
    const r = await t.fetchJson('POST', '/api/entries', {
      date: '2026-07-06', cm_id: nb.id,
      narrative: 'Telephone conference with client regarding hearing.',
      tasks: [{ task_code: 'Call/Conference', duration: 0.5, fragment: '' }],
    });
    assert.equal(r.status, 201);
    assert.equal(r.body.billable, 0); // inherited from non-billable CM
    assert.equal(r.body.total, 0.5);
    assert.equal(r.body.status, 'draft');
    assert.deepEqual(r.body.validation, []);
    assert.equal(r.body.cm.short_name, 'Pro bono');

    const bad = await t.fetchJson('POST', '/api/entries', {
      date: 'not-a-date', cm_id: cm.id, tasks: [],
    });
    assert.equal(bad.status, 400);

    const noCm = await t.fetchJson('POST', '/api/entries', {
      date: '2026-07-06', cm_id: 9999, tasks: [],
    });
    assert.equal(noCm.status, 400);
  }));

test('multi-line entries get auto-generated narrative, kept in sync', () =>
  withServer(async (t, cm) => {
    const created = (await t.fetchJson('POST', '/api/entries', {
      date: '2026-07-06', cm_id: cm.id, narrative: 'ignored once multi-line',
      tasks: [
        { task_code: 'Review', duration: 1.2, fragment: 'review lease' },
        { task_code: 'Draft', duration: 0.3, fragment: 'draft email to landlord' },
      ],
    })).body;
    assert.equal(created.narrative, 'Review lease (1.2); draft email to landlord (0.3).');
    assert.equal(created.narrative_auto, true);
    assert.equal(created.total, 1.5);

    const patched = (await t.fetchJson('PATCH', `/api/entries/${created.id}`, {
      tasks: [
        { task_code: 'Review', duration: 1.2, fragment: 'review lease' },
        { task_code: 'Draft', duration: 0.4, fragment: 'draft email to landlord' },
        { task_code: 'Call/Conference', duration: 0.4, fragment: 'telephone conference with client' },
      ],
    })).body;
    assert.equal(patched.narrative,
      'Review lease (1.2); draft email to landlord (0.4); telephone conference with client (0.4).');
    assert.equal(patched.total, 2.0);

    // dropping to one line frees the narrative for direct editing
    const single = (await t.fetchJson('PATCH', `/api/entries/${created.id}`, {
      tasks: [{ task_code: 'Review', duration: 1.0, fragment: 'review lease' }],
      narrative: 'Review lease agreement for renewal terms.',
    })).body;
    assert.equal(single.narrative, 'Review lease agreement for renewal terms.');
    assert.equal(single.narrative_auto, false);
  }));

test('finalized entries reject edits with 409', () =>
  withServer(async (t, cm) => {
    const e = (await t.fetchJson('POST', '/api/entries', {
      date: '2026-07-06', cm_id: cm.id,
      narrative: 'Reviewed lease agreement for renewal terms.',
      tasks: [{ task_code: 'Review', duration: 0.5, fragment: '' }],
    })).body;
    t.db.prepare("UPDATE entries SET status='finalized' WHERE id=?").run(e.id);
    const r = await t.fetchJson('PATCH', `/api/entries/${e.id}`, { narrative: 'changed' });
    assert.equal(r.status, 409);
  }));

test('soft delete filters entry out; restore brings it back', () =>
  withServer(async (t, cm) => {
    const e = (await t.fetchJson('POST', '/api/entries', {
      date: '2026-07-06', cm_id: cm.id,
      narrative: 'Reviewed lease agreement for renewal terms.',
      tasks: [{ task_code: 'Review', duration: 0.5, fragment: '' }],
    })).body;
    await t.fetchJson('DELETE', `/api/entries/${e.id}`);
    assert.equal((await t.fetchJson('GET', '/api/entries?date=2026-07-06')).body.length, 0);

    const restored = await t.fetchJson('POST', `/api/entries/${e.id}/restore`);
    assert.equal(restored.status, 200);
    assert.equal((await t.fetchJson('GET', '/api/entries?date=2026-07-06')).body.length, 1);
  }));

test('copy entry to another date resets export/finalize state', () =>
  withServer(async (t, cm) => {
    const e = (await t.fetchJson('POST', '/api/entries', {
      date: '2026-07-01', cm_id: cm.id,
      narrative: 'Reviewed lease agreement for renewal terms.',
      tasks: [{ task_code: 'Review', duration: 0.5, fragment: '' }],
    })).body;
    t.db.prepare(
      "UPDATE entries SET status='finalized', exported_at='2026-07-01T20:00:00Z', ever_finalized=1 WHERE id=?"
    ).run(e.id);

    const copy = (await t.fetchJson('POST', `/api/entries/${e.id}/copy`, { date: '2026-07-06' })).body;
    assert.equal(copy.date, '2026-07-06');
    assert.equal(copy.status, 'draft');
    assert.equal(copy.exported_at, null);
    assert.equal(copy.narrative, e.narrative);
    assert.equal(copy.tasks.length, 1);
    assert.notEqual(copy.id, e.id);
  }));

test('filters: date range, cm, billable, status, narrative keyword', () =>
  withServer(async (t, cm, nb) => {
    const mk = (date, cmId, narrative, dur = 0.5) => t.fetchJson('POST', '/api/entries', {
      date, cm_id: cmId, narrative, tasks: [{ task_code: 'Review', duration: dur, fragment: '' }],
    });
    await mk('2026-07-01', cm.id, 'Reviewed lease agreement for renewal terms.');
    await mk('2026-07-03', nb.id, 'Drafted pro bono intake memorandum for clinic.');
    await mk('2026-07-06', cm.id, 'Telephone conference with landlord counsel.');

    assert.equal((await t.fetchJson('GET', '/api/entries?from=2026-07-02&to=2026-07-06')).body.length, 2);
    assert.equal((await t.fetchJson('GET', `/api/entries?cm_id=${cm.id}`)).body.length, 2);
    assert.equal((await t.fetchJson('GET', '/api/entries?billable=0')).body.length, 1);
    assert.equal((await t.fetchJson('GET', '/api/entries?q=landlord')).body.length, 1);
    assert.equal((await t.fetchJson('GET', '/api/entries?status=draft')).body.length, 3);
  }));
