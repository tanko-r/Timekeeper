import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

async function withData(fn) {
  const clock = () => new Date('2026-07-06T15:00:00-07:00');
  const t = await startTestServer({ clock });
  try {
    const acme = (await t.fetchJson('POST', '/api/cms', {
      cm_number: '100001-000012', short_name: 'Acme lease', billable: 1,
    })).body;
    const bono = (await t.fetchJson('POST', '/api/cms', {
      cm_number: '100001-000099', short_name: 'Pro bono', billable: 0,
    })).body;

    const fin = (await t.fetchJson('POST', '/api/entries', {
      date: '2026-07-06', cm_id: acme.id, narrative: 'x',
      tasks: [
        { task_code: 'Review', duration: 1.2, fragment: 'review lease, "exhibit A"' },
        { task_code: 'Draft', duration: 0.3, fragment: 'draft email to landlord' },
      ],
    })).body;
    await t.fetchJson('POST', `/api/entries/${fin.id}/finalize`);

    const draft = (await t.fetchJson('POST', '/api/entries', {
      date: '2026-07-06', cm_id: bono.id,
      narrative: 'Drafted pro bono intake memorandum for clinic.',
      tasks: [{ task_code: 'Draft', duration: 0.8, fragment: '' }],
    })).body;

    await fn(t, { acme, bono, fin, draft });
  } finally { await t.close(); }
}

test('export: finalized only by default, exact CSV shape, stamps exported_at', () =>
  withData(async (t, { fin, draft }) => {
    const r = await t.fetchJson('POST', '/api/export', { from: '2026-07-06', to: '2026-07-06' });
    assert.equal(r.status, 200);
    assert.equal(r.body.count, 1);
    assert.deepEqual(r.body.entry_ids, [fin.id]);

    const lines = r.body.csv.trimEnd().split('\r\n');
    assert.equal(lines[0], 'date,cm_number,cm_short_name,billable,task,duration,narrative,entry_total,entry_id');
    assert.equal(lines.length, 3); // header + 2 task lines
    assert.ok(lines[1].startsWith('2026-07-06,100001-000012,Acme lease,billable,Review,1.2,'));
    assert.match(lines[1], /""exhibit A""/); // quotes escaped
    assert.ok(lines[2].includes(',Draft,0.3,'));

    // text summary groups by entry
    assert.match(r.body.text, /Acme lease/);
    assert.match(r.body.text, /1\.5/);

    const after = (await t.fetchJson('GET', `/api/entries/${fin.id}`)).body;
    assert.ok(after.exported_at);
    const draftAfter = (await t.fetchJson('GET', `/api/entries/${draft.id}`)).body;
    assert.equal(draftAfter.exported_at, null);
  }));

test('export can include drafts explicitly', () =>
  withData(async (t) => {
    const r = await t.fetchJson('POST', '/api/export', {
      from: '2026-07-06', to: '2026-07-06', includeDrafts: true,
    });
    assert.equal(r.body.count, 2);
  }));

test('preview does not stamp exported_at', () =>
  withData(async (t, { fin }) => {
    const r = await t.fetchJson('GET', '/api/export/preview?from=2026-07-06&to=2026-07-06');
    assert.equal(r.body.count, 1);
    const after = (await t.fetchJson('GET', `/api/entries/${fin.id}`)).body;
    assert.equal(after.exported_at, null);
  }));

test('stats aggregates by cm, task, day with billable ratio', () =>
  withData(async (t) => {
    const r = (await t.fetchJson('GET', '/api/stats?from=2026-07-01&to=2026-07-31')).body;
    const acmeRow = r.byCm.find((c) => c.cm_number === '100001-000012');
    assert.equal(acmeRow.hours, 1.5);
    assert.equal(acmeRow.billableHours, 1.5);
    const bonoRow = r.byCm.find((c) => c.cm_number === '100001-000099');
    assert.equal(bonoRow.billableHours, 0);
    assert.equal(r.byTask.find((x) => x.task === 'Draft').hours, 1.1);
    assert.equal(r.byDay.find((d) => d.date === '2026-07-06').hours, 2.3);
    assert.ok(Math.abs(r.billableRatio - 1.5 / 2.3) < 0.001);
  }));

test('dashboard: today totals, alerts for invalid drafts and unexported finalized', () =>
  withData(async (t, { acme, draft }) => {
    // an invalid draft today (empty narrative) and a backlog draft yesterday
    const bad = (await t.fetchJson('POST', '/api/entries', {
      date: '2026-07-06', cm_id: acme.id, narrative: '',
      tasks: [{ task_code: 'Research', duration: 0.5, fragment: '' }],
    })).body;
    await t.fetchJson('POST', '/api/entries', {
      date: '2026-07-05', cm_id: acme.id, narrative: '',
      tasks: [{ task_code: 'Research', duration: 0.2, fragment: '' }],
    });

    const d = (await t.fetchJson('GET', '/api/dashboard')).body;
    assert.equal(d.date, '2026-07-06');
    assert.equal(d.today.total, 2.8); // 1.5 + 0.8 + 0.5
    assert.equal(d.today.billable, 2.0);
    assert.equal(d.today.nonbillable, 0.8);
    assert.equal(d.today.target, 8);
    assert.ok(d.alerts.invalidDrafts.some((e) => e.id === bad.id));
    assert.ok(!d.alerts.invalidDrafts.some((e) => e.id === draft.id)); // clean draft not flagged
    assert.equal(d.alerts.backlogCount, 1);
    assert.equal(d.alerts.unexportedFinalized, 1);
    assert.ok(Array.isArray(d.timers));
  }));

test('export stamps only finalized entries; finalize clears exported_at', () =>
  withData(async (t, { fin, draft }) => {
    await t.fetchJson('POST', '/api/export', { from: '2026-07-06', to: '2026-07-06', includeDrafts: true });
    const draftAfter = (await t.fetchJson('GET', `/api/entries/${draft.id}`)).body;
    assert.equal(draftAfter.exported_at, null, 'drafts must not be stamped');

    // exported finalized entry gets unlocked, edited, re-finalized → needs re-export
    await t.fetchJson('POST', `/api/entries/${fin.id}/unlock`);
    await t.fetchJson('PATCH', `/api/entries/${fin.id}`, { billable: 0 });
    await t.fetchJson('POST', `/api/entries/${fin.id}/finalize`);
    const refin = (await t.fetchJson('GET', `/api/entries/${fin.id}`)).body;
    assert.equal(refin.exported_at, null, 'finalize must clear exported_at so it re-alerts');
  }));

test('CSV emits stored durations exactly (no display re-rounding)', () =>
  withData(async (t, { acme }) => {
    const e = (await t.fetchJson('POST', '/api/entries', {
      date: '2026-07-05', cm_id: acme.id, narrative: 'Prepared deposition outline for witness.',
      tasks: [{ task_code: 'Draft', duration: 1.25, fragment: '' }],
    })).body;
    await t.fetchJson('POST', `/api/entries/${e.id}/finalize`);
    const r = await t.fetchJson('POST', '/api/export', { from: '2026-07-05', to: '2026-07-05' });
    const line = r.body.csv.split('\r\n')[1];
    assert.ok(line.includes(',Draft,1.25,'), `duration must stay 1.25, got: ${line}`);
  }));

test('CSV grows field:<Name> columns; no fields = legacy header', () =>
  withData(async (t) => {
    const { body: cm } = await t.fetchJson('POST', '/api/cms', { cm_number: '555666-000001', short_name: 'CF Export' });
    const clientId = t.db.prepare("SELECT id FROM clients WHERE client_number='555666'").get().id;
    const { body: phase } = await t.fetchJson('POST', '/api/custom-fields',
      { client_id: clientId, name: 'Phase', type: 'select', options: ['P100'] });
    await t.fetchJson('POST', '/api/entries', {
      date: '2031-01-05', cm_id: cm.id, narrative: 'Exported with a phase code narrative.',
      tasks: [{ duration: 0.3, fragment: 'phase-coded work' }],
      custom_values: { [phase.id]: 'P100' },
    });

    const withField = await t.fetchJson('POST', '/api/export',
      { from: '2031-01-05', to: '2031-01-05', includeDrafts: true, markExported: false });
    const header = withField.body.csv.split('\r\n')[0];
    assert.equal(header.endsWith(',field:Phase'), true);
    assert.equal(withField.body.csv.includes('P100'), true);

    // a range with no custom-field entries keeps the legacy header exactly
    const plain = await t.fetchJson('POST', '/api/export',
      { from: '2031-02-01', to: '2031-02-01', includeDrafts: true, markExported: false });
    assert.equal(plain.body.csv.split('\r\n')[0],
      'date,cm_number,cm_short_name,billable,task,duration,narrative,entry_total,entry_id');
  }));
