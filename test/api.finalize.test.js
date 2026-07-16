import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

async function withServer(fn) {
  const t = await startTestServer();
  try {
    const cm = (await t.fetchJson('POST', '/api/cms', {
      cm_number: '100001-000012', short_name: 'Acme lease', billable: 1,
    })).body;
    const mkEntry = async (overrides = {}) => (await t.fetchJson('POST', '/api/entries', {
      date: '2026-07-06', cm_id: cm.id,
      narrative: 'Reviewed lease agreement for renewal terms and exchanged emails.',
      tasks: [{ task_code: 'Review', duration: 0.5, fragment: '' }],
      ...overrides,
    })).body;
    await fn(t, cm, mkEntry);
  } finally { await t.close(); }
}

test('finalize clean entry locks it', () => withServer(async (t, cm, mkEntry) => {
  const e = await mkEntry();
  const r = await t.fetchJson('POST', `/api/entries/${e.id}/finalize`);
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'finalized');
  assert.ok(r.body.finalized_at);
  assert.equal(r.body.ever_finalized, 1);
  // and it is now locked
  const patch = await t.fetchJson('PATCH', `/api/entries/${e.id}`, { narrative: 'x' });
  assert.equal(patch.status, 409);
}));

test('warnings gate finalize until acknowledged', () => withServer(async (t, cm, mkEntry) => {
  const e = await mkEntry({ narrative: 'Reviewed docs.' }); // short → warn
  const r1 = await t.fetchJson('POST', `/api/entries/${e.id}/finalize`);
  assert.equal(r1.status, 422);
  assert.equal(r1.body.blocks.length, 0);
  assert.ok(r1.body.warns.some((w) => w.code === 'narrative_short'));

  const r2 = await t.fetchJson('POST', `/api/entries/${e.id}/finalize`, { ack: true });
  assert.equal(r2.status, 200);
  assert.equal(r2.body.ack_validation, 1);
}));

test('task-billing client: finalize warns when a stale narrative lacks allocations', () =>
  withServer(async (t, cm, mkEntry) => {
    // Write the entry while the client is block-billed (no allocations in the
    // synced narrative), then flip the client to task-billed WITHOUT touching
    // the entry — its narrative is now stale relative to the current flag,
    // which is exactly what the finalize warn should catch.
    const clientId = t.db.prepare('SELECT client_id FROM matters WHERE id=?').get(cm.id).client_id;
    await t.fetchJson('PATCH', `/api/clients/${clientId}`, { task_billing: 0 });
    const e = await mkEntry({
      narrative: 'Reviewed lease and drafted email to landlord regarding renewal.',
      tasks: [
        { task_code: 'Review', duration: 1.2, fragment: 'review lease' },
        { task_code: 'Draft', duration: 0.3, fragment: 'draft email to landlord' },
      ],
    });
    assert.equal(e.narrative, 'Review lease; draft email to landlord.');

    await t.fetchJson('PATCH', `/api/clients/${clientId}`, { task_billing: 1 });
    const r1 = await t.fetchJson('POST', `/api/entries/${e.id}/finalize`);
    assert.equal(r1.status, 422);
    assert.ok(r1.body.warns.some((w) => w.code === 'missing_allocations'));

    const r2 = await t.fetchJson('POST', `/api/entries/${e.id}/finalize`, { ack: true });
    assert.equal(r2.status, 200);
  }));

test('block-billing client: finalize does not warn about missing allocations', () =>
  withServer(async (t, cm, mkEntry) => {
    const clientId = t.db.prepare('SELECT client_id FROM matters WHERE id=?').get(cm.id).client_id;
    await t.fetchJson('PATCH', `/api/clients/${clientId}`, { task_billing: 0 });
    const e = await mkEntry({
      narrative: 'Reviewed lease and drafted email to landlord regarding renewal.',
      tasks: [
        { task_code: 'Review', duration: 1.2, fragment: 'review lease' },
        { task_code: 'Draft', duration: 0.3, fragment: 'draft email to landlord' },
      ],
    });
    const r = await t.fetchJson('POST', `/api/entries/${e.id}/finalize`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }));

test('blocks cannot be acknowledged away', () => withServer(async (t, cm, mkEntry) => {
  const e = await mkEntry({ narrative: '' });
  const r = await t.fetchJson('POST', `/api/entries/${e.id}/finalize`, { ack: true });
  assert.equal(r.status, 422);
  assert.ok(r.body.blocks.some((b) => b.code === 'narrative_empty'));
}));

test('unlock returns entry to draft and audits everything after', () =>
  withServer(async (t, cm, mkEntry) => {
    const e = await mkEntry();
    await t.fetchJson('POST', `/api/entries/${e.id}/finalize`);
    const unlocked = await t.fetchJson('POST', `/api/entries/${e.id}/unlock`);
    assert.equal(unlocked.status, 200);
    assert.equal(unlocked.body.status, 'draft');

    await t.fetchJson('PATCH', `/api/entries/${e.id}`, {
      narrative: 'Reviewed lease agreement and drafted summary email to client.',
    });

    const audit = (await t.fetchJson('GET', `/api/entries/${e.id}/audit`)).body;
    assert.equal(audit.length, 2);
    const actions = audit.map((a) => a.action).sort();
    assert.deepEqual(actions, ['edit', 'unlock']);
    const edit = audit.find((a) => a.action === 'edit');
    assert.ok(edit.detail.narrative, 'edit audit records narrative diff');
  }));

test('finalize-day finalizes what it can and reports the rest', () =>
  withServer(async (t, cm, mkEntry) => {
    const clean = await mkEntry();
    const warned = await mkEntry({ narrative: 'Short one.' });
    const blocked = await mkEntry({ narrative: '' });
    const other = await mkEntry({ date: '2026-07-05' }); // outside the day

    const r = await t.fetchJson('POST', '/api/finalize-day', { date: '2026-07-06', ack: true });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.finalized.sort(), [clean.id, warned.id].sort());
    assert.equal(r.body.blocked.length, 1);
    assert.equal(r.body.blocked[0].id, blocked.id);

    const still = (await t.fetchJson('GET', `/api/entries/${other.id}`)).body;
    assert.equal(still.status, 'draft');
  }));

test('bulk: set_cm, finalize, delete', () => withServer(async (t, cm, mkEntry) => {
  const cm2 = (await t.fetchJson('POST', '/api/cms', {
    cm_number: '100001-000044', short_name: 'Acme employment', billable: 1,
  })).body;
  const a = await mkEntry();
  const b = await mkEntry();
  const c = await mkEntry({ narrative: '' }); // will block finalize

  const moved = await t.fetchJson('POST', '/api/entries/bulk', {
    ids: [a.id, b.id], action: 'set_cm', cm_id: cm2.id,
  });
  assert.equal(moved.status, 200);
  assert.equal((await t.fetchJson('GET', `/api/entries/${a.id}`)).body.cm.id, cm2.id);

  const fin = await t.fetchJson('POST', '/api/entries/bulk', {
    ids: [a.id, b.id, c.id], action: 'finalize', ack: true,
  });
  assert.deepEqual(fin.body.done.sort(), [a.id, b.id].sort());
  assert.equal(fin.body.failed.length, 1);

  const del = await t.fetchJson('POST', '/api/entries/bulk', { ids: [c.id], action: 'delete' });
  assert.equal(del.body.done.length, 1);
  assert.equal((await t.fetchJson('GET', '/api/entries?date=2026-07-06')).body.length, 2);
}));

test('a blocked finalize with ack does not pre-acknowledge future warnings', () =>
  withServer(async (t, cm, mkEntry) => {
    const e = await mkEntry({ narrative: '' }); // hard block
    await t.fetchJson('POST', `/api/entries/${e.id}/finalize`, { ack: true }); // 422
    await t.fetchJson('PATCH', `/api/entries/${e.id}`, { narrative: 'Short.' }); // now warn-only
    const r = await t.fetchJson('POST', `/api/entries/${e.id}/finalize`); // no ack
    assert.equal(r.status, 422, 'warning must still gate — ack must not persist from the blocked attempt');
  }));

test('finalized entries cannot be deleted without unlock; delete of ever-finalized is audited', () =>
  withServer(async (t, cm, mkEntry) => {
    const e = await mkEntry();
    await t.fetchJson('POST', `/api/entries/${e.id}/finalize`);
    const del = await t.fetchJson('DELETE', `/api/entries/${e.id}`);
    assert.equal(del.status, 409);

    await t.fetchJson('POST', `/api/entries/${e.id}/unlock`);
    const del2 = await t.fetchJson('DELETE', `/api/entries/${e.id}`);
    assert.equal(del2.status, 200);
    const audit = (await t.fetchJson('GET', `/api/entries/${e.id}/audit`)).body;
    assert.ok(audit.some((a) => a.action === 'delete'), 'delete of ever-finalized entry must be audited');
  }));

test('bulk delete skips finalized entries; bulk unlock skips drafts; bulk finalize skips deleted', () =>
  withServer(async (t, cm, mkEntry) => {
    const fin = await mkEntry();
    await t.fetchJson('POST', `/api/entries/${fin.id}/finalize`);
    const draft = await mkEntry();
    const gone = await mkEntry();
    await t.fetchJson('DELETE', `/api/entries/${gone.id}`);

    const del = (await t.fetchJson('POST', '/api/entries/bulk', { ids: [fin.id, draft.id], action: 'delete' })).body;
    assert.deepEqual(del.done, [draft.id]);
    assert.equal(del.failed.length, 1);

    const unl = (await t.fetchJson('POST', '/api/entries/bulk', { ids: [fin.id, draft.id], action: 'unlock' })).body;
    assert.deepEqual(unl.done, [fin.id]);

    const fi = (await t.fetchJson('POST', '/api/entries/bulk', { ids: [gone.id], action: 'finalize', ack: true })).body;
    assert.equal(fi.done.length, 0, 'soft-deleted entries must not be finalized');
  }));

test('finalize: required custom field blocks until filled; format mismatch is ack-able', () =>
  withServer(async (t) => {
    const { body: cm } = await t.fetchJson('POST', '/api/cms', { cm_number: '333444-000001', short_name: 'CF Gate' });
    const { body: req } = await t.fetchJson('POST', '/api/custom-fields', {
      matter_id: cm.id, name: 'Task', pattern: 'A\\d{3}', pattern_hint: 'A###', required: true,
    });
    const { body: entry } = await t.fetchJson('POST', '/api/entries', {
      date: '2026-07-15', cm_id: cm.id,
      narrative: 'A long enough narrative describing real substantive work.',
      tasks: [{ duration: 0.5, fragment: 'real work' }],
    });

    const blocked = await t.fetchJson('POST', `/api/entries/${entry.id}/finalize`, {});
    assert.equal(blocked.status, 422);
    assert.equal(blocked.body.blocks.some((b) => b.code === 'custom_required'), true);

    await t.fetchJson('PATCH', `/api/entries/${entry.id}`, { custom_values: { [req.id]: 'WRONG' } });
    const warned = await t.fetchJson('POST', `/api/entries/${entry.id}/finalize`, {});
    assert.equal(warned.status, 422);
    assert.equal(warned.body.blocks.length, 0);
    assert.equal(warned.body.warns.some((w) => w.code === 'custom_format'), true);

    const acked = await t.fetchJson('POST', `/api/entries/${entry.id}/finalize`, { ack: true });
    assert.equal(acked.status, 200); // warn is ack-able

    await t.fetchJson('POST', `/api/entries/${entry.id}/unlock`, {});
    await t.fetchJson('PATCH', `/api/entries/${entry.id}`, { custom_values: { [req.id]: 'A103' }, ack_validation: 0 });
    const clean = await t.fetchJson('POST', `/api/entries/${entry.id}/finalize`, {});
    assert.equal(clean.status, 200);
  }));
