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

test('loadEntry cm payload gains client_name and client_task_billing (additive)', () =>
  withServer(async (t, cm) => {
    const created = (await t.fetchJson('POST', '/api/entries', {
      date: '2026-07-06', cm_id: cm.id,
      narrative: 'Reviewed lease agreement for renewal terms.',
      tasks: [{ task_code: 'Review', duration: 0.5, fragment: '' }],
    })).body;
    assert.equal(created.cm.client_task_billing, 1); // default, matches client_task_billing = 1
    assert.equal(created.cm.client_name, ''); // blank client, not null — named-but-empty

    const clientId = t.db.prepare('SELECT client_id FROM matters WHERE id=?').get(cm.id).client_id;
    await t.fetchJson('PATCH', `/api/clients/${clientId}`, { name: 'Acme Corp', task_billing: 0 });
    const reloaded = (await t.fetchJson('GET', `/api/entries/${created.id}`)).body;
    assert.equal(reloaded.cm.client_name, 'Acme Corp');
    assert.equal(reloaded.cm.client_task_billing, 0);
  }));

test('a matter with no linked client defaults to client_task_billing: 1, client_name: null', () =>
  withServer(async (t, cm) => {
    // No API path leaves client_id null (POST /api/cms always ensures a client);
    // simulate a pre-client-split matter directly, as the migration replay tests do.
    const bare = t.db.prepare(
      "INSERT INTO matters (cm_number, short_name, billable, client_id) VALUES ('100007-000001', 'Bare', 1, NULL)"
    ).run();
    const e = (await t.fetchJson('POST', '/api/entries', {
      date: '2026-07-06', cm_id: bare.lastInsertRowid,
      narrative: 'Reviewed lease agreement for renewal terms.',
      tasks: [{ task_code: 'Review', duration: 0.5, fragment: '' }],
    })).body;
    assert.equal(e.cm.client_task_billing, 1);
    assert.equal(e.cm.client_name, null);
  }));

test('block-billing client (task_billing=0): auto-narrative joins fragments without allocations', () =>
  withServer(async (t, cm) => {
    const clientId = t.db.prepare('SELECT client_id FROM matters WHERE id=?').get(cm.id).client_id;
    await t.fetchJson('PATCH', `/api/clients/${clientId}`, { task_billing: 0 });

    const created = (await t.fetchJson('POST', '/api/entries', {
      date: '2026-07-06', cm_id: cm.id, narrative: 'ignored once multi-line',
      tasks: [
        { task_code: 'Review', duration: 1.2, fragment: 'review lease' },
        { task_code: 'Draft', duration: 0.3, fragment: 'draft email to landlord' },
      ],
    })).body;
    assert.equal(created.narrative, 'Review lease; draft email to landlord.');
    assert.equal(created.narrative_auto, true);
  }));

test('POST without narrative_manual defaults to 0 (unchanged behavior)', () =>
  withServer(async (t, cm) => {
    const created = (await t.fetchJson('POST', '/api/entries', {
      date: '2026-07-06', cm_id: cm.id,
      tasks: [{ task_code: 'Review', duration: 0.5, fragment: '' }],
    })).body;
    assert.equal(created.narrative_manual, 0);
  }));

test('manual narrative (narrative_manual=1) survives a task-touching PATCH and reload', () =>
  withServer(async (t, cm) => {
    const created = (await t.fetchJson('POST', '/api/entries', {
      date: '2026-07-06', cm_id: cm.id, narrative: 'ignored once multi-line',
      tasks: [
        { task_code: 'Review', duration: 1.2, fragment: 'review lease' },
        { task_code: 'Draft', duration: 0.3, fragment: 'draft email to landlord' },
      ],
    })).body;
    assert.equal(created.narrative_auto, true); // narrative_manual defaults to 0

    const manualText = 'Handled lease renewal end to end for the client.';
    const detached = (await t.fetchJson('PATCH', `/api/entries/${created.id}`, {
      narrative: manualText, narrative_manual: 1,
    })).body;
    assert.equal(detached.narrative, manualText);
    assert.equal(detached.narrative_auto, false);

    // a task-touching save must NOT regenerate the narrative once detached
    const touched = (await t.fetchJson('PATCH', `/api/entries/${created.id}`, {
      tasks: [
        { task_code: 'Review', duration: 1.0, fragment: 'review lease' },
        { task_code: 'Draft', duration: 0.5, fragment: 'draft email to landlord' },
      ],
    })).body;
    assert.equal(touched.narrative, manualText);
    assert.equal(touched.narrative_auto, false);

    // reload confirms it's durable in the DB, not just echoed back from the PATCH
    const reloaded = (await t.fetchJson('GET', `/api/entries/${created.id}`)).body;
    assert.equal(reloaded.narrative, manualText);
    assert.equal(reloaded.narrative_auto, false);
  }));

test('flipping narrative_manual back to 0 regenerates the narrative (task- and block-billing)', () =>
  withServer(async (t, cm) => {
    const clientId = t.db.prepare('SELECT client_id FROM matters WHERE id=?').get(cm.id).client_id;
    const created = (await t.fetchJson('POST', '/api/entries', {
      date: '2026-07-06', cm_id: cm.id,
      tasks: [
        { task_code: 'Review', duration: 1.2, fragment: 'review lease' },
        { task_code: 'Draft', duration: 0.3, fragment: 'draft email to landlord' },
      ],
    })).body;
    await t.fetchJson('PATCH', `/api/entries/${created.id}`, { narrative: 'manual text', narrative_manual: 1 });

    const reAuto = (await t.fetchJson('PATCH', `/api/entries/${created.id}`, { narrative_manual: 0 })).body;
    assert.equal(reAuto.narrative, 'Review lease (1.2); draft email to landlord (0.3).');
    assert.equal(reAuto.narrative_auto, true);

    // same re-sync path on a block-billing client
    await t.fetchJson('PATCH', `/api/clients/${clientId}`, { task_billing: 0 });
    await t.fetchJson('PATCH', `/api/entries/${created.id}`, { narrative: 'manual text again', narrative_manual: 1 });
    const reAutoBlock = (await t.fetchJson('PATCH', `/api/entries/${created.id}`, { narrative_manual: 0 })).body;
    assert.equal(reAutoBlock.narrative, 'Review lease; draft email to landlord.');
    assert.equal(reAutoBlock.narrative_auto, true);
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
    assert.equal(copy.narrative_manual, 0); // source wasn't detached, copy isn't either
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

test('entry writes maintain the matter people roster', () =>
  withServer(async (t, cm) => {
    const created = (await t.fetchJson('POST', '/api/entries', {
      date: '2026-07-06', cm_id: cm.id,
      narrative: 'Telephone conference with M. Smith regarding lease terms.',
      tasks: [{ task_code: 'Call/Conference', duration: 0.5, fragment: '' }],
    })).body;
    const roster = () => t.db.prepare(
      'SELECT name, count, last_seen_at FROM matter_people WHERE matter_id=? ORDER BY name'
    ).all(cm.id);
    assert.deepEqual(roster(), [{ name: 'M. Smith', count: 1, last_seen_at: '2026-07-06' }]);

    // a second entry mentioning the same person bumps count and recency
    await t.fetchJson('POST', '/api/entries', {
      date: '2026-07-07', cm_id: cm.id,
      narrative: 'Email to M. Smith re revised legal description.',
      tasks: [{ task_code: 'Correspondence', duration: 0.2, fragment: '' }],
    });
    assert.deepEqual(roster(), [{ name: 'M. Smith', count: 2, last_seen_at: '2026-07-07' }]);

    // editing the mention away rebuilds — derived cache, not append-only
    await t.fetchJson('PATCH', `/api/entries/${created.id}`, {
      narrative: 'Review lease exhibit.',
    });
    assert.deepEqual(roster(), [{ name: 'M. Smith', count: 1, last_seen_at: '2026-07-07' }]);
  }));

test('moving or deleting an entry re-attributes its people', () =>
  withServer(async (t, cm, nb) => {
    const e = (await t.fetchJson('POST', '/api/entries', {
      date: '2026-07-06', cm_id: cm.id,
      narrative: 'Call with A. Turner re loading dock lease.',
      tasks: [{ task_code: 'Call/Conference', duration: 0.3, fragment: '' }],
    })).body;
    const count = (matterId) => t.db.prepare(
      'SELECT COUNT(*) c FROM matter_people WHERE matter_id=?').get(matterId).c;

    // move to the other matter → roster follows
    await t.fetchJson('PATCH', `/api/entries/${e.id}`, { cm_id: nb.id });
    assert.equal(count(cm.id), 0);
    assert.equal(t.db.prepare(
      'SELECT name FROM matter_people WHERE matter_id=?').get(nb.id).name, 'A. Turner');

    // soft delete → roster empties; restore → it returns
    await t.fetchJson('DELETE', `/api/entries/${e.id}`);
    assert.equal(count(nb.id), 0);
    await t.fetchJson('POST', `/api/entries/${e.id}/restore`);
    assert.equal(count(nb.id), 1);
  }));

test('names in task fragments count too, once per entry', () =>
  withServer(async (t, cm) => {
    await t.fetchJson('POST', '/api/entries', {
      date: '2026-07-06', cm_id: cm.id,
      tasks: [
        { task_code: 'Call/Conference', duration: 0.4, fragment: 'telephone conference with B. Novak re access road' },
        { task_code: 'Correspondence', duration: 0.2, fragment: 'email to B. Novak re same' },
      ],
    });
    const rows = t.db.prepare(
      'SELECT name, count FROM matter_people WHERE matter_id=?').all(cm.id);
    assert.deepEqual(rows, [{ name: 'B. Novak', count: 1 }]); // per-entry dedupe
  }));
