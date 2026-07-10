import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

const CSV = [
  'CM Number,Matter Name,Group',
  '100001-000100,Acme merger,Corporate',
  '100001-000101,Firm CLE,Firm',       // group "Firm" → non-billable (seed default)
  '100001-000102,Missing group matter,', // blank group → ungrouped + billable
  'bad-number,Should skip,Corporate',    // invalid CM → skip
  '100001-000103,,Corporate',            // no name → skip
].join('\r\n') + '\r\n';

async function withServer(fn) {
  const t = await startTestServer();
  try { await fn(t); } finally { await t.close(); }
}

test('import/preview detects columns and plans create vs skip', () =>
  withServer(async (t) => {
    const { status, body } = await t.fetchJson('POST', '/api/timers/import/preview', { csv: CSV });
    assert.equal(status, 200);
    assert.deepEqual(body.mapping, {
      cm_number: 0, client_number: -1, client_name: -1,
      matter_number: -1, matter_name: 1, group: 2,
    });
    assert.equal(body.counts.create, 3);
    assert.equal(body.counts.skip, 2);
    const firm = body.plan.find((p) => p.cm_number === '100001-000101');
    assert.equal(firm.billable, 0);
  }));

test('import creates matters, groups (reused/created), timers; existing CM skipped', () =>
  withServer(async (t) => {
    // Seed one matter so its row is skipped as "already exists".
    await t.fetchJson('POST', '/api/cms', { cm_number: '100001-000100', short_name: 'Pre-existing' });

    const { status, body } = await t.fetchJson('POST', '/api/timers/import', { csv: CSV });
    assert.equal(status, 201);
    assert.equal(body.created, 2);  // 000101 + 000102 (000100 now skipped)
    assert.equal(body.skipped, 3);

    const timers = (await t.fetchJson('GET', '/api/timers')).body;
    const cle = timers.find((x) => x.name === 'Firm CLE');
    assert.ok(cle, 'Firm CLE timer created');
    assert.equal(cle.cm_number, '100001-000101');

    // The "Firm" group was created and the timer attached to it.
    const groups = (await t.fetchJson('GET', '/api/timer-groups')).body;
    const firmGroup = groups.find((g) => g.name === 'Firm');
    assert.ok(firmGroup, 'Firm group created');
    assert.equal(cle.group_id, firmGroup.id);

    // The new matter is non-billable; the ungrouped one is billable.
    const cms = (await t.fetchJson('GET', '/api/cms')).body;
    assert.equal(cms.find((c) => c.cm_number === '100001-000101').billable, 0);
    assert.equal(cms.find((c) => c.cm_number === '100001-000102').billable, 1);
    assert.equal(timers.find((x) => x.name === 'Missing group matter').group_id, null);
  }));

test('import reuses an existing group by name (case-insensitive)', () =>
  withServer(async (t) => {
    const grp = (await t.fetchJson('POST', '/api/timer-groups', { name: 'Corporate' })).body;
    await t.fetchJson('POST', '/api/timers/import', {
      csv: 'CM Number,Matter Name,Group\r\n100001-000200,New corp matter,corporate\r\n',
    });
    const timers = (await t.fetchJson('GET', '/api/timers')).body;
    assert.equal(timers.find((x) => x.name === 'New corp matter').group_id, grp.id);
    const groups = (await t.fetchJson('GET', '/api/timer-groups')).body;
    assert.equal(groups.filter((g) => g.name.toLowerCase() === 'corporate').length, 1);
  }));

test('import respects an explicit column mapping override', () =>
  withServer(async (t) => {
    // Columns deliberately out of the default order.
    const csv = 'Group,Matter,CM\r\nCorporate,Reordered matter,100001-000300\r\n';
    const mapping = { group: 0, matter_name: 1, cm_number: 2 };
    const preview = (await t.fetchJson('POST', '/api/timers/import/preview', { csv, mapping })).body;
    assert.equal(preview.counts.create, 1);
    assert.equal(preview.plan[0].cm_number, '100001-000300');

    const res = (await t.fetchJson('POST', '/api/timers/import', { csv, mapping })).body;
    assert.equal(res.created, 1);
  }));

test('empty CSV is a 400', () =>
  withServer(async (t) => {
    const { status } = await t.fetchJson('POST', '/api/timers/import/preview', { csv: '' });
    assert.equal(status, 400);
  }));

test('import with a client-name column names the client, never clobbering an existing name', () =>
  withServer(async (t) => {
    const csv = [
      'CM Number,Matter Name,Client Name,Group',
      '100001-000400,Acme merger,Acme Holdings,Corporate',
      '100001-000401,Acme lease,,Corporate',     // blank name on a known client — no-op
      '100006-000001,Beta suit,Beta LLC,Litigation',
    ].join('\r\n') + '\r\n';
    const { status } = await t.fetchJson('POST', '/api/timers/import', { csv });
    assert.equal(status, 201);
    const clients = (await t.fetchJson('GET', '/api/clients')).body;
    assert.equal(clients.find((c) => c.client_number === '100001').name, 'Acme Holdings');
    assert.equal(clients.find((c) => c.client_number === '100006').name, 'Beta LLC');

    // a later import spelling the client differently keeps the existing name
    await t.fetchJson('POST', '/api/timers/import', {
      csv: 'CM Number,Matter Name,Client Name\r\n100001-000402,Acme appeal,ACME HOLDINGS LLC\r\n',
    });
    const again = (await t.fetchJson('GET', '/api/clients')).body;
    assert.equal(again.find((c) => c.client_number === '100001').name, 'Acme Holdings');
  }));

test('import with separate client/matter number+name columns (locked pairs)', () =>
  withServer(async (t) => {
    const csv = [
      'Client Number,Client Name,Matter Number,Matter Name,Group',
      '100001,Acme Holdings,12,Acme merger,Corporate',
      '100001,Acme Holdings,000013,Acme lease,Corporate',
    ].join('\r\n') + '\r\n';
    const preview = (await t.fetchJson('POST', '/api/timers/import/preview', { csv })).body;
    assert.equal(preview.counts.create, 2);
    assert.equal(preview.plan[0].cm_number, '100001-000012');

    const { status, body } = await t.fetchJson('POST', '/api/timers/import', { csv });
    assert.equal(status, 201);
    assert.equal(body.created, 2);
    const cms = (await t.fetchJson('GET', '/api/cms')).body;
    assert.ok(cms.find((c) => c.cm_number === '100001-000012'));
    assert.ok(cms.find((c) => c.cm_number === '100001-000013'));
    const acme = (await t.fetchJson('GET', '/api/clients')).body
      .find((c) => c.client_number === '100001');
    assert.equal(acme.name, 'Acme Holdings');
  }));

test('timer import links imported matters to clients', () => withServer(async (t) => {
  const csv = 'CM Number,Matter Name,Group\r\n888001-000001,Imported A,Litigation\r\n888001-000002,Imported B,Litigation\r\n';
  const { status } = await t.fetchJson('POST', '/api/timers/import', { csv });
  assert.equal(status, 201);
  const clients = t.db.prepare("SELECT COUNT(*) c FROM clients WHERE client_number='888001'").get().c;
  assert.equal(clients, 1);
  const linked = t.db.prepare("SELECT COUNT(*) c FROM matters WHERE matter_number IN ('000001','000002') AND client_id IS NOT NULL").get().c;
  assert.equal(linked, 2);
}));
