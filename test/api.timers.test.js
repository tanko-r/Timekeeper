import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

// Mutable fake clock so tests can move time.
function makeClock(startIso) {
  let now = new Date(startIso).getTime();
  const clock = () => new Date(now);
  clock.set = (iso) => { now = new Date(iso).getTime(); };
  clock.advance = (seconds) => { now += seconds * 1000; };
  return clock;
}

async function withServer(startIso, fn) {
  const clock = makeClock(startIso);
  const t = await startTestServer({ clock });
  try {
    const cm = (await t.fetchJson('POST', '/api/cms', {
      cm_number: '100001-000012', short_name: 'Acme lease', billable: 1,
    })).body;
    await fn(t, cm, clock);
  } finally { await t.close(); }
}

test('timer lifecycle: start, pause, resume, stop → rounded entry', () =>
  withServer('2026-07-06T09:00:00-07:00', async (t, cm, clock) => {
    const timer = (await t.fetchJson('POST', '/api/timers', {
      name: 'Acme research', cm_id: cm.id, task_code: 'Research',
    })).body;
    assert.equal(timer.running, 0);
    assert.equal(timer.elapsed_seconds, 0);

    await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
    clock.advance(1200); // 20 min
    let list = (await t.fetchJson('GET', '/api/timers')).body;
    assert.equal(list[0].elapsed_seconds, 1200);
    assert.equal(list[0].running, 1);

    await t.fetchJson('POST', `/api/timers/${timer.id}/pause`);
    clock.advance(600); // paused 10 min — must not count
    list = (await t.fetchJson('GET', '/api/timers')).body;
    assert.equal(list[0].elapsed_seconds, 1200);
    assert.equal(list[0].running, 0);

    await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
    clock.advance(1320); // +22 min → 2520s total
    const stopped = (await t.fetchJson('POST', `/api/timers/${timer.id}/stop`, { action: 'new' })).body;
    assert.equal(stopped.hours, 0.7); // 2520s = 0.7h
    assert.ok(stopped.entry);
    assert.equal(stopped.entry.date, '2026-07-06');
    assert.equal(stopped.entry.source, 'timer');
    assert.equal(stopped.entry.tasks.length, 1);
    assert.equal(stopped.entry.tasks[0].task_code, 'Research');
    assert.equal(stopped.entry.tasks[0].duration, 0.7);

    // clock zeroed after stop
    list = (await t.fetchJson('GET', '/api/timers')).body;
    assert.equal(list[0].elapsed_seconds, 0);
    assert.equal(list[0].running, 0);
  }));

test('stop with append adds a task line to an existing draft and regenerates narrative', () =>
  withServer('2026-07-06T09:00:00-07:00', async (t, cm, clock) => {
    const entry = (await t.fetchJson('POST', '/api/entries', {
      date: '2026-07-06', cm_id: cm.id, narrative: 'review lease',
      tasks: [{ task_code: 'Review', duration: 0.5, fragment: 'review lease' }],
    })).body;

    const timer = (await t.fetchJson('POST', '/api/timers', {
      name: 'Acme research', cm_id: cm.id, task_code: 'Research',
    })).body;
    await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
    clock.advance(2520);

    const ctx = (await t.fetchJson('GET', `/api/timers/${timer.id}/stop-context`)).body;
    assert.equal(ctx.todayDrafts.length, 1);
    assert.equal(ctx.hours_preview, 0.7);

    const stopped = (await t.fetchJson('POST', `/api/timers/${timer.id}/stop`, {
      action: 'append', entry_id: entry.id,
    })).body;
    assert.equal(stopped.entry.id, entry.id);
    assert.equal(stopped.entry.tasks.length, 2);
    assert.equal(stopped.entry.narrative, 'Review lease (0.5); Research (0.7).');
  }));

test('starting a second timer warns but does not block', () =>
  withServer('2026-07-06T09:00:00-07:00', async (t, cm) => {
    const a = (await t.fetchJson('POST', '/api/timers', { name: 'Timer A', cm_id: cm.id })).body;
    const b = (await t.fetchJson('POST', '/api/timers', { name: 'Timer B', cm_id: cm.id })).body;
    const r1 = await t.fetchJson('POST', `/api/timers/${a.id}/start`);
    assert.equal(r1.body.warning, undefined);
    const r2 = await t.fetchJson('POST', `/api/timers/${b.id}/start`);
    assert.match(r2.body.warning, /Timer A/);
    const list = (await t.fetchJson('GET', '/api/timers')).body;
    assert.deepEqual(list.map((x) => x.running), [1, 1]);
  }));

test('stopping a timer with under half an increment discards the time', () =>
  withServer('2026-07-06T09:00:00-07:00', async (t, cm, clock) => {
    const timer = (await t.fetchJson('POST', '/api/timers', { name: 'Tiny', cm_id: cm.id })).body;
    await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
    clock.advance(60); // 1 min → rounds to 0.0
    const stopped = (await t.fetchJson('POST', `/api/timers/${timer.id}/stop`, { action: 'new' })).body;
    assert.equal(stopped.hours, 0);
    assert.equal(stopped.entry, null);
    assert.equal((await t.fetchJson('GET', '/api/entries?date=2026-07-06')).body.length, 0);
  }));

test('midnight rollover banks a running timer to yesterday and keeps it running', () =>
  withServer('2026-07-06T22:00:00-07:00', async (t, cm, clock) => {
    const timer = (await t.fetchJson('POST', '/api/timers', {
      name: 'Late night', cm_id: cm.id, task_code: 'Draft',
    })).body;
    clock.advance(3600); // 23:00
    await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
    clock.set('2026-07-07T09:00:00-07:00'); // next morning

    const list = (await t.fetchJson('GET', '/api/timers')).body;
    // 23:00 → 00:00 = 3600s banked to 2026-07-06 as a 1.0h draft
    const banked = (await t.fetchJson('GET', '/api/entries?date=2026-07-06')).body;
    assert.equal(banked.length, 1);
    assert.equal(banked[0].source, 'timer');
    assert.equal(banked[0].total, 1.0);
    assert.equal(banked[0].status, 'draft');
    // clock reset at midnight, still running: 00:00 → 09:00 = 9h on today's clock
    assert.equal(list[0].running, 1);
    assert.equal(list[0].elapsed_seconds, 9 * 3600);
  }));

test('midnight rollover banks a paused timer and leaves it paused', () =>
  withServer('2026-07-06T14:00:00-07:00', async (t, cm, clock) => {
    const timer = (await t.fetchJson('POST', '/api/timers', { name: 'Paused', cm_id: cm.id })).body;
    await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
    clock.advance(1800); // 30 min
    await t.fetchJson('POST', `/api/timers/${timer.id}/pause`);
    clock.set('2026-07-07T08:00:00-07:00');

    const list = (await t.fetchJson('GET', '/api/timers')).body;
    assert.equal(list[0].running, 0);
    assert.equal(list[0].elapsed_seconds, 0);
    const banked = (await t.fetchJson('GET', '/api/entries?date=2026-07-06')).body;
    assert.equal(banked.length, 1);
    assert.equal(banked[0].total, 0.5);
  }));

test('timers reorder and delete; deleting timer keeps its entries', () =>
  withServer('2026-07-06T09:00:00-07:00', async (t, cm, clock) => {
    const a = (await t.fetchJson('POST', '/api/timers', { name: 'A', cm_id: cm.id })).body;
    const b = (await t.fetchJson('POST', '/api/timers', { name: 'B', cm_id: cm.id })).body;
    await t.fetchJson('PUT', '/api/timers/order', { ids: [b.id, a.id] });
    let list = (await t.fetchJson('GET', '/api/timers')).body;
    assert.deepEqual(list.map((x) => x.id), [b.id, a.id]);

    await t.fetchJson('POST', `/api/timers/${a.id}/start`);
    clock.advance(3600);
    await t.fetchJson('POST', `/api/timers/${a.id}/stop`, { action: 'new' });
    await t.fetchJson('DELETE', `/api/timers/${a.id}`);
    list = (await t.fetchJson('GET', '/api/timers')).body;
    assert.equal(list.length, 1);
    assert.equal((await t.fetchJson('GET', '/api/entries?date=2026-07-06')).body.length, 1);
  }));
