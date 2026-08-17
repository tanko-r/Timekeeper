import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.js';
import { startTestServer } from './helpers.js';

// Archiving is a BOARD decision, not a billing one. Eighty-three timers and
// matters closing every month mean the board only ever grows, so a tile has to
// be able to leave — but a tile leaving must never move an hour, a sentence or
// a matter. Every test below is a fence around that one sentence.

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

// Every draft and finalized hour the app would put on a bill. If this number
// moves when a timer is archived, the feature is wrong.
async function ledgerTotal(t) {
  const entries = (await t.fetchJson('GET', '/api/entries')).body;
  return entries.reduce((sum, e) => sum + Number(e.total || 0), 0);
}

test('v19: timers gain archived_at, and a timer written without it reads NULL', () => {
  const db = openDb(':memory:');
  const cols = db.prepare('PRAGMA table_info(timers)').all().map((c) => c.name);
  assert.ok(cols.includes('archived_at'));
  // A row inserted the way every pre-v19 row was inserted — no archived_at in
  // the statement at all — must read as LIVE, not as archived.
  const id = db.prepare(
    "INSERT INTO timers (name, last_reset_date) VALUES ('Acme lease', '2026-08-17')"
  ).run().lastInsertRowid;
  assert.equal(db.prepare('SELECT archived_at FROM timers WHERE id=?').get(id).archived_at, null);
  db.close();
});

test('archive hides the timer from the board; ?includeArchived=1 shows it', () =>
  withServer('2026-08-17T09:00:00-07:00', async (t, cm) => {
    const keep = (await t.fetchJson('POST', '/api/timers', { name: 'Acme lease', cm_id: cm.id })).body;
    const gone = (await t.fetchJson('POST', '/api/timers', { name: 'Old matter', cm_id: cm.id })).body;
    assert.equal(gone.archived_at, null, 'a new timer is live');

    const res = await t.fetchJson('POST', `/api/timers/${gone.id}/archive`);
    assert.equal(res.status, 200);
    assert.ok(res.body.archived_at, 'the archive stamps a time');

    const board = (await t.fetchJson('GET', '/api/timers')).body;
    assert.deepEqual(board.map((x) => x.id), [keep.id], 'the board no longer carries it');

    const all = (await t.fetchJson('GET', '/api/timers?includeArchived=1')).body;
    assert.deepEqual(all.map((x) => x.id), [keep.id, gone.id], 'still findable when asked for');
    assert.ok(all.find((x) => x.id === gone.id).archived_at);
  }));

test('a RUNNING timer is refused with 409 and is still running afterwards', () =>
  withServer('2026-08-17T09:00:00-07:00', async (t, cm, clock) => {
    const timer = (await t.fetchJson('POST', '/api/timers', { name: 'Acme lease', cm_id: cm.id })).body;
    await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
    clock.advance(900);

    const res = await t.fetchJson('POST', `/api/timers/${timer.id}/archive`);
    assert.equal(res.status, 409);
    assert.match(res.body.error, /stop the timer/i);

    // Archiving a running clock would strand accruing time behind a tile he
    // can no longer see, so the refusal has to leave the clock exactly as it was.
    const board = (await t.fetchJson('GET', '/api/timers')).body;
    assert.equal(board.length, 1, 'still on the board');
    assert.equal(board[0].running, 1);
    assert.equal(board[0].archived_at, null);
    assert.equal(board[0].elapsed_seconds, 900, 'the clock kept counting');
  }));

test('archiving touches NO entry: hours, narrative and the entry itself all survive', () =>
  withServer('2026-08-17T09:00:00-07:00', async (t, cm, clock) => {
    const timer = (await t.fetchJson('POST', '/api/timers', {
      name: 'Acme lease', cm_id: cm.id, task_code: 'Research',
    })).body;
    await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
    clock.advance(3600);
    const entry = (await t.fetchJson('POST', `/api/timers/${timer.id}/stop`)).body.entry;
    await t.fetchJson('PATCH', `/api/entries/${entry.id}`, {
      narrative: 'Reviewed the amended lease and marked up the assignment clause.',
    });
    const before = (await t.fetchJson('GET', `/api/entries/${entry.id}`)).body;
    assert.equal(before.total, 1);

    await t.fetchJson('POST', `/api/timers/${timer.id}/archive`);

    const after = (await t.fetchJson('GET', `/api/entries/${entry.id}`)).body;
    assert.equal(after.deleted_at, null, 'the entry still exists');
    assert.equal(after.total, before.total, 'the same hours');
    assert.equal(after.narrative, before.narrative, 'the same sentence');
    assert.equal(after.cm_id, before.cm_id, 'the same matter');
    assert.equal(after.status, before.status);
  }));

test('archiving clears linked_entry_id, and takes the settled hours off the clock with it', () =>
  withServer('2026-08-17T09:00:00-07:00', async (t, cm, clock) => {
    const timer = (await t.fetchJson('POST', '/api/timers', { name: 'Acme lease', cm_id: cm.id })).body;
    await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
    clock.advance(3600);
    const stop = (await t.fetchJson('POST', `/api/timers/${timer.id}/stop`)).body;
    assert.equal(stop.entry.total, 1);

    const archived = (await t.fetchJson('POST', `/api/timers/${timer.id}/archive`)).body;
    assert.equal(archived.linked_entry_id, null,
      'a tile that is off the board must not keep claiming to serve an entry');
    // The entry KEPT that hour, so the day clock must not still be holding it:
    // dropping the link while keeping the hours is the Acme duplicate, and the
    // next stop after an unarchive would file the same hour a second time.
    assert.equal(archived.elapsed_seconds, 0, 'the settled hour left the clock with the link');
  }));

test('double archive is a no-op: 200, same stamp, nothing else moves', () =>
  withServer('2026-08-17T09:00:00-07:00', async (t, cm, clock) => {
    const timer = (await t.fetchJson('POST', '/api/timers', { name: 'Acme lease', cm_id: cm.id })).body;
    const first = (await t.fetchJson('POST', `/api/timers/${timer.id}/archive`)).body;

    // He double-taps on a slow link; the second tap must not re-stamp the time.
    clock.advance(120);
    const second = await t.fetchJson('POST', `/api/timers/${timer.id}/archive`);
    assert.equal(second.status, 200);
    assert.equal(second.body.archived_at, first.archived_at);
    assert.equal(second.body.sort_order, first.sort_order);
    assert.equal((await t.fetchJson('GET', '/api/timers')).body.length, 0);
  }));

test('unarchive puts the tile back in its old position', () =>
  withServer('2026-08-17T09:00:00-07:00', async (t, cm) => {
    const a = (await t.fetchJson('POST', '/api/timers', { name: 'First', cm_id: cm.id })).body;
    const b = (await t.fetchJson('POST', '/api/timers', { name: 'Second', cm_id: cm.id })).body;
    const c = (await t.fetchJson('POST', '/api/timers', { name: 'Third', cm_id: cm.id })).body;

    await t.fetchJson('POST', `/api/timers/${b.id}/archive`);
    assert.deepEqual((await t.fetchJson('GET', '/api/timers')).body.map((x) => x.name),
      ['First', 'Third']);

    const back = (await t.fetchJson('POST', `/api/timers/${b.id}/unarchive`)).body;
    assert.equal(back.archived_at, null);
    assert.equal(back.sort_order, b.sort_order, 'sort_order was never touched');
    // Between the same two neighbours he left it between.
    assert.deepEqual((await t.fetchJson('GET', '/api/timers')).body.map((x) => x.name),
      ['First', 'Second', 'Third']);
    assert.deepEqual([a.id, b.id, c.id].sort(), [a.id, b.id, c.id].sort());
  }));

test('unarchiving a live timer is a no-op, and an unknown id is a 404', () =>
  withServer('2026-08-17T09:00:00-07:00', async (t, cm) => {
    const timer = (await t.fetchJson('POST', '/api/timers', { name: 'Acme lease', cm_id: cm.id })).body;
    const res = await t.fetchJson('POST', `/api/timers/${timer.id}/unarchive`);
    assert.equal(res.status, 200);
    assert.equal(res.body.archived_at, null);
    assert.equal((await t.fetchJson('POST', '/api/timers/9999/archive')).status, 404);
    assert.equal((await t.fetchJson('POST', '/api/timers/9999/unarchive')).status, 404);
  }));

test('NO TIME IS LOST: the ledger total is identical either side of an archive', () =>
  withServer('2026-08-17T09:00:00-07:00', async (t, cm, clock) => {
    const other = (await t.fetchJson('POST', '/api/cms', {
      cm_number: '100002-000003', short_name: 'Northgate', billable: 1,
    })).body;
    const acme = (await t.fetchJson('POST', '/api/timers', { name: 'Acme lease', cm_id: cm.id })).body;
    const north = (await t.fetchJson('POST', '/api/timers', { name: 'Northgate', cm_id: other.id })).body;

    await t.fetchJson('POST', `/api/timers/${acme.id}/start`);
    clock.advance(5400); // 1.5 h
    await t.fetchJson('POST', `/api/timers/${acme.id}/stop`);
    await t.fetchJson('POST', `/api/timers/${north.id}/start`);
    clock.advance(1800); // 0.5 h
    await t.fetchJson('POST', `/api/timers/${north.id}/stop`);

    const before = await ledgerTotal(t);
    assert.equal(before, 2);

    await t.fetchJson('POST', `/api/timers/${acme.id}/archive`);
    assert.equal(await ledgerTotal(t), before, 'archiving billed nothing and unbilled nothing');

    // …and the round trip does not double-count either: unarchive, run it for
    // another tenth, and the ledger grows by exactly that tenth.
    await t.fetchJson('POST', `/api/timers/${acme.id}/unarchive`);
    await t.fetchJson('POST', `/api/timers/${acme.id}/start`);
    clock.advance(360); // 0.1 h
    await t.fetchJson('POST', `/api/timers/${acme.id}/stop`);
    assert.equal(await ledgerTotal(t), before + 0.1, 'the settled 1.5 h was not filed twice');
  }));
