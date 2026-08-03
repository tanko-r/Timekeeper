// Time leakage: entries that stalled between "recorded" and "in the billing
// system". The dashboard has to notice them and the Export page has to be able
// to filter down to exactly them. See server/lib/attention.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

const TODAY = '2026-07-06';

async function withData(fn) {
  let ms = new Date(`${TODAY}T15:00:00-07:00`).getTime();
  const clock = () => new Date(ms);
  clock.advance = (secs) => { ms += secs * 1000; };
  const t = await startTestServer({ clock });
  try {
    const acme = (await t.fetchJson('POST', '/api/cms', {
      cm_number: '100001-000012', short_name: 'Acme lease', billable: 1,
    })).body;
    const mk = async (date, hours, narrative = 'Reviewed and revised lease exhibits.') =>
      (await t.fetchJson('POST', '/api/entries', {
        date, cm_id: acme.id, narrative,
        tasks: [{ task_code: 'Review', duration: hours, fragment: '' }],
      })).body;
    await fn(t, { acme, mk, clock });
  } finally { await t.close(); }
}

const alerts = async (t) => (await t.fetchJson('GET', '/api/dashboard')).body.alerts;

test('a clean draft on an earlier day is flagged — time recorded, never locked in', () =>
  withData(async (t, { mk }) => {
    const older = await mk('2026-07-02', 0.4);
    await mk(TODAY, 1.0); // today's draft is work in progress, not a leak

    const a = await alerts(t);
    assert.equal(a.unfinalized.count, 1);
    assert.equal(a.unfinalized.hours, 0.4);
    assert.equal(a.unfinalized.oldest, '2026-07-02');
    assert.ok(!a.unfinalized.ids || a.unfinalized.ids.includes(older.id));
  }));

test('earlier drafts with no time on them are not leakage', () =>
  withData(async (t, { mk }) => {
    await mk('2026-07-02', 0);
    assert.equal((await alerts(t)).unfinalized.count, 0);
  }));

test('the scan stops at the lookback window', () =>
  withData(async (t, { mk }) => {
    await mk('2026-04-06', 0.5); // 91 days back
    await mk('2026-04-08', 0.5); // 89 days back
    const a = await alerts(t);
    assert.equal(a.unfinalized.count, 1);
    assert.equal(a.unfinalized.oldest, '2026-04-08');
  }));

test('an entry finalized, exported, then unlocked is flagged as reverted', () =>
  withData(async (t, { mk }) => {
    const e = await mk('2026-07-02', 0.6);
    await t.fetchJson('POST', `/api/entries/${e.id}/finalize`);
    await t.fetchJson('POST', '/api/export', { from: '2026-07-02', to: '2026-07-02' });
    assert.equal((await alerts(t)).reverted.count, 0, 'exported and done: quiet');

    await t.fetchJson('POST', `/api/entries/${e.id}/unlock`);
    const a = await alerts(t);
    assert.equal(a.reverted.count, 1, 'the stale exported_at must not hide it');
    assert.equal(a.reverted.hours, 0.6);
    assert.equal(a.unfinalized.count, 0, 'counted once — reverted, not plain unfinalized');
  }));

test('a reverted entry on today is flagged too — it already looked done', () =>
  withData(async (t, { mk }) => {
    const e = await mk(TODAY, 0.3);
    await t.fetchJson('POST', `/api/entries/${e.id}/finalize`);
    await t.fetchJson('POST', `/api/entries/${e.id}/unlock`);
    assert.equal((await alerts(t)).reverted.count, 1);
  }));

test('re-finalizing a reverted entry moves it to the unexported bucket', () =>
  withData(async (t, { mk }) => {
    const e = await mk('2026-07-02', 0.6);
    await t.fetchJson('POST', `/api/entries/${e.id}/finalize`);
    await t.fetchJson('POST', '/api/export', { from: '2026-07-02', to: '2026-07-02' });
    await t.fetchJson('POST', `/api/entries/${e.id}/unlock`);
    await t.fetchJson('PATCH', `/api/entries/${e.id}`, { billable: 0 });
    await t.fetchJson('POST', `/api/entries/${e.id}/finalize`);

    const a = await alerts(t);
    assert.equal(a.reverted.count, 0);
    assert.equal(a.unexported.count, 1, 'the edit invalidated the export — send it again');
    assert.equal(a.unexported.oldest, '2026-07-02');
  }));

test('unexported finalized time is flagged however old it is', () =>
  withData(async (t, { mk }) => {
    const e = await mk('2026-01-05', 0.7); // long outside the 90-day window
    await t.fetchJson('POST', `/api/entries/${e.id}/finalize`);
    const a = await alerts(t);
    assert.equal(a.unexported.count, 1, 'finalized-but-unsent never ages out');
    assert.equal(a.unexported.oldest, '2026-01-05');
  }));

test('export preview filters to exactly what each flag means', () =>
  withData(async (t, { mk }) => {
    const draft = await mk('2026-07-02', 0.4);
    const unsent = await mk('2026-07-03', 0.5);
    await t.fetchJson('POST', `/api/entries/${unsent.id}/finalize`);
    const sent = await mk('2026-07-04', 0.6);
    await t.fetchJson('POST', `/api/entries/${sent.id}/finalize`);
    await t.fetchJson('POST', '/api/export', { from: '2026-07-04', to: '2026-07-04' });

    const q = async (attention) => (await t.fetchJson(
      'GET', `/api/export/preview?from=2026-07-01&to=${TODAY}&attention=${attention}`)).body;

    assert.deepEqual((await q('unfinalized')).entries.map((e) => e.id), [draft.id]);
    assert.deepEqual((await q('unexported')).entries.map((e) => e.id), [unsent.id]);
    assert.deepEqual((await q('either')).entries.map((e) => e.id), [draft.id, unsent.id]);
    // no filter keeps the old default: finalized only
    assert.deepEqual((await q('all')).entries.map((e) => e.id).sort(), [unsent.id, sent.id].sort());
  }));

test('a filtered preview shows matterless drafts but keeps them out of the file', () =>
  withData(async (t, { mk, clock }) => {
    // Matterless time only ever arrives one way: a quick timer that stopped
    // before it was told what it was for.
    const timer = (await t.fetchJson('POST', '/api/timers', { name: 'Mystery call' })).body;
    await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
    clock.advance(1800);
    const orphan = (await t.fetchJson('POST', `/api/timers/${timer.id}/stop`)).body.entry;
    await t.fetchJson('PATCH', `/api/entries/${orphan.id}`, {
      narrative: 'Call with prospective client.',
    });
    await mk('2026-07-02', 0.4);

    const r = (await t.fetchJson(
      'GET', `/api/export/preview?from=2026-07-01&to=${TODAY}&attention=unfinalized`)).body;
    assert.ok(r.entries.some((e) => e.id === orphan.id), 'visible: it is leaking time');
    assert.equal(r.count, 1, 'but not exportable — nothing to key it under');
    assert.equal(r.unassociated, 1);

    const out = (await t.fetchJson('POST', '/api/export', {
      from: '2026-07-01', to: TODAY, attention: 'unfinalized',
    })).body;
    assert.ok(!out.csv.includes('prospective client'), 'the matterless row never reaches the CSV');
  }));

test('exporting a filtered draft range stamps nothing', () =>
  withData(async (t, { mk }) => {
    const draft = await mk('2026-07-02', 0.4);
    await t.fetchJson('POST', '/api/export', { from: '2026-07-01', to: TODAY, attention: 'unfinalized' });
    const after = (await t.fetchJson('GET', `/api/entries/${draft.id}`)).body;
    assert.equal(after.exported_at, null, 'a draft is not "sent" — only finalized entries stamp');
  }));
