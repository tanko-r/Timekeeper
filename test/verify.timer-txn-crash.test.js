// VERIFICATION of the claim: "Multi-step timer mutations are not wrapped in a
// transaction, so a crash mid-write reproduces the double-count"
// (server/routes/timers.js — PATCH /:id, stopAndFile, POST /:id/fresh,
//  PUT /:id/clock, applyRollovers).
//
// The claimant reasoned this from reading the statement sequence and never
// observed it. These tests OBSERVE it, against a real server on a temp
// database, using a REAL process kill (SIGKILL) landing between the two
// writes rather than a simulated one.
//
// How the kill is aimed: the server runs in a child process. A SQLite trigger
// on `entries` (AFTER UPDATE OF cm_id) calls a registered UDF that SIGKILLs
// the process. That fires at the FIRST write inside PATCH's `associate`
// transaction — i.e. after `UPDATE timers …` (line 319, autocommit, already
// durable) and before the associate transaction commits. That is exactly the
// window the claim describes. Nothing in server/ is modified.
//
// ⚠️ THE FIRST TEST IS EXPECTED TO FAIL. It is the proof of the defect, not a
// regression guard. Do not "fix" it by relaxing the assertion.

process.env.TZ = 'America/Los_Angeles';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { startTestServer } from './helpers.js';

const REPO = fileURLToPath(new URL('..', import.meta.url));

// A server that dies, hard, the instant an entry's cm_id is rewritten.
const CRASHING_CHILD = `
process.env.TZ = 'America/Los_Angeles';
const [dbPath, repo, dataDir] = process.argv.slice(2);
const { pathToFileURL } = await import('node:url');
const base = pathToFileURL(repo);
const { openDb } = await import(new URL('server/db.js', base));
const { createApp } = await import(new URL('server/app.js', base));
const db = openDb(dbPath);
db.function('tk_crash_now', () => { process.kill(process.pid, 'SIGKILL'); return 1; });
db.exec(\`CREATE TRIGGER IF NOT EXISTS tk_crash_on_entry_move
  AFTER UPDATE OF cm_id ON entries
  WHEN NEW.cm_id IS NOT OLD.cm_id
  BEGIN SELECT tk_crash_now(); END;\`);
const app = createApp({
  db,
  config: { PORT: 0, HOST: '127.0.0.1', DATA_DIR: dataDir, TRUST_LAN: true },
  clock: () => new Date(),
});
const s = app.listen(0, '127.0.0.1', () => {
  process.stdout.write('PORT ' + s.address().port + '\\n');
});
`;

function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

async function jsonReq(base, method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  return { status: res.status, body: json };
}

async function startCrashingServer(dir, dbPath) {
  const scriptPath = join(dir, 'crashing-server.mjs');
  writeFileSync(scriptPath, CRASHING_CHILD);
  const child = spawn(process.execPath, [scriptPath, dbPath, REPO, dir], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let err = '';
  child.stderr.on('data', (c) => { err += c; });
  const exited = new Promise((resolve) => child.on('exit', (code, sig) => resolve({ code, sig })));
  const port = await new Promise((resolve, reject) => {
    let buf = '';
    child.stdout.on('data', (c) => {
      buf += c;
      const m = buf.match(/PORT (\d+)/);
      if (m) resolve(Number(m[1]));
    });
    child.on('exit', () => reject(new Error(`child exited early: ${err}`)));
    setTimeout(() => reject(new Error(`child never listened: ${err}`)), 15000);
  });
  return { child, port, exited, base: `http://127.0.0.1:${port}` };
}

// ---------------------------------------------------------------------------
// ⚠️ EXPECTED TO FAIL — this is the proof of the defect.
// ---------------------------------------------------------------------------
test('LEAK (expected failure): a crash inside PATCH /api/timers/:id leaves the timer '
  + 'pointing at an entry on the OLD matter, and the next ordinary start files the same '
  + 'hours a second time', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'tk-crash-'));
  const dbPath = join(dir, 'test.db');
  const { child, exited, base } = await startCrashingServer(dir, dbPath);
  let secondServer = null;
  let rawDb = null;

  try {
    const A = (await jsonReq(base, 'POST', '/api/cms', {
      cm_number: '100001-000012', short_name: 'Acme lease', billable: 1,
    })).body;
    const B = (await jsonReq(base, 'POST', '/api/cms', {
      cm_number: '100001-000034', short_name: 'Acme merger', billable: 1,
    })).body;
    assert.ok(A.id && B.id, 'both matters created');

    const timer = (await jsonReq(base, 'POST', '/api/timers', {
      name: 'Acme lease', cm_id: A.id,
    })).body;

    // Put half an hour on the day clock. Paused + linked, so it files
    // straight into entry E on matter A — same shape as a stop.
    const clockRes = await jsonReq(base, 'PUT', `/api/timers/${timer.id}/clock`, { hours: 0.5 });
    const entryE = clockRes.body.entry;
    assert.equal(entryE.total, 0.5);
    assert.equal(entryE.cm_id, A.id);

    // The ordinary action: re-point this timer at the sibling matter. The
    // route MOVES the entry (associate). The process dies at the first write
    // of that move.
    let crashed = false;
    try {
      // move_entry: this test is ABOUT the crash that lands mid-move, so it must
      // ask for the move. Without the flag the entry now stays on its own matter
      // (the owner's "ask me each time" rule) and the crash never happens.
      await jsonReq(base, 'PATCH', `/api/timers/${timer.id}`, { cm_id: B.id, move_entry: true });
    } catch { crashed = true; }
    const { sig } = await exited;
    assert.equal(sig, 'SIGKILL', 'server was killed mid-PATCH');
    assert.ok(crashed, 'the PATCH connection died with the process');

    // --- Read the database directly: what actually survived the crash? ---
    const { openDb } = await import('../server/db.js');
    rawDb = openDb(dbPath);
    const tRow = rawDb.prepare(
      'SELECT id, cm_id, linked_entry_id, accumulated_seconds, running FROM timers WHERE id=?'
    ).get(timer.id);
    const eRow = rawDb.prepare(
      'SELECT id, cm_id, total_override, status, deleted_at FROM entries WHERE id=?'
    ).get(entryE.id);

    assert.equal(tRow.cm_id, B.id, 'timers.cm_id write committed (autocommit, outside any txn)');
    assert.equal(eRow.cm_id, A.id, 'entries.cm_id move rolled back with the uncommitted txn');
    assert.equal(tRow.linked_entry_id, entryE.id,
      'the timer still points at an entry that belongs to a DIFFERENT matter');
    assert.equal(tRow.accumulated_seconds, 1800, 'the day clock still holds the whole 0.5 h');

    // Drop the crash trigger so the recovered app behaves normally.
    rawDb.exec('DROP TRIGGER IF EXISTS tk_crash_on_entry_move');
    rawDb.close();
    rawDb = null;

    // --- Recovery: the user reopens the app and presses start, as they would ---
    const { createApp } = await import('../server/app.js');
    const db2 = openDb(dbPath);
    const app2 = createApp({
      db: db2,
      config: { PORT: 0, HOST: '127.0.0.1', DATA_DIR: dir, TRUST_LAN: true },
      clock: () => new Date(),
    });
    const srv = await new Promise((r) => { const s = app2.listen(0, '127.0.0.1', () => r(s)); });
    secondServer = { srv, db: db2 };
    const base2 = `http://127.0.0.1:${srv.address().port}`;

    await jsonReq(base2, 'POST', `/api/timers/${timer.id}/start`);

    const rows = db2.prepare(
      `SELECT e.id, e.cm_id, e.total_override, m.cm_number
         FROM entries e LEFT JOIN matters m ON m.id = e.cm_id
        WHERE e.date=? AND e.deleted_at IS NULL ORDER BY e.id`
    ).all(todayStr());
    const banked = rows.reduce((a, r) => a + (r.total_override || 0), 0);

    assert.equal(banked, 0.5,
      `DOUBLE COUNT: 0.5 h of clock produced ${banked} h of entries — `
      + JSON.stringify(rows));
  } finally {
    try { child.kill('SIGKILL'); } catch { /* already dead */ }
    if (rawDb) rawDb.close();
    if (secondServer) {
      await new Promise((r) => secondServer.srv.close(r));
      secondServer.db.close();
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The rest of the claim: are stopAndFile / fresh / clock really "not safe on
// replay"? These should PASS — the day-accumulator design makes them
// self-healing, because syncToEntry OVERWRITES total_override rather than
// adding to it. Keep them; they are the counter-evidence.
// ---------------------------------------------------------------------------

function makeClock(startIso) {
  let now = new Date(startIso).getTime();
  const clock = () => new Date(now);
  clock.advance = (s) => { now += s * 1000; };
  return clock;
}

test('replay-safety: an interrupted stop (clock stopped, hours never filed) does not '
  + 'double-count or lose time on the next stop', async () => {
  const clock = makeClock('2026-07-06T09:00:00-07:00');
  const t = await startTestServer({ clock });
  try {
    const cm = (await t.fetchJson('POST', '/api/cms', {
      cm_number: '100001-000012', short_name: 'Acme lease', billable: 1,
    })).body;
    const timer = (await t.fetchJson('POST', '/api/timers', { name: 'T', cm_id: cm.id })).body;
    await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
    clock.advance(1800);

    // Simulate the crash window inside stopAndFile: the clock-stopping UPDATE
    // committed, syncToEntry never ran.
    t.db.prepare(
      'UPDATE timers SET running=0, accumulated_seconds=1800, last_started_at=NULL WHERE id=?'
    ).run(timer.id);

    const before = t.db.prepare(
      'SELECT COALESCE(SUM(total_override),0) s FROM entries WHERE date=? AND deleted_at IS NULL'
    ).get('2026-07-06').s;
    assert.equal(before, 0, 'hours were not filed — the entry is stale after the crash');

    // The user starts and stops again. The day accumulator overwrites.
    await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
    clock.advance(600);
    const stop = (await t.fetchJson('POST', `/api/timers/${timer.id}/stop`)).body;
    assert.equal(stop.hours, 0.7, '1800 + 600 s = 0.7 h, filed once');

    const rows = t.db.prepare(
      'SELECT id, total_override FROM entries WHERE date=? AND deleted_at IS NULL'
    ).all('2026-07-06');
    assert.equal(rows.length, 1, 'still exactly one entry — no duplicate');
    assert.equal(rows[0].total_override, 0.7, 'total overwritten, not added');
  } finally { await t.close(); }
});

test('replay-safety: an interrupted PUT /clock (clock set, entry never synced) is '
  + 'corrected by the next stop', async () => {
  const clock = makeClock('2026-07-06T09:00:00-07:00');
  const t = await startTestServer({ clock });
  try {
    const cm = (await t.fetchJson('POST', '/api/cms', {
      cm_number: '100001-000012', short_name: 'Acme lease', billable: 1,
    })).body;
    const timer = (await t.fetchJson('POST', '/api/timers', { name: 'T', cm_id: cm.id })).body;
    await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
    clock.advance(1800);
    await t.fetchJson('POST', `/api/timers/${timer.id}/stop`); // entry at 0.5

    // Crash window inside PUT /clock: accumulated_seconds raised, syncToEntry
    // never ran.
    t.db.prepare('UPDATE timers SET accumulated_seconds=3600 WHERE id=?').run(timer.id);
    assert.equal(t.db.prepare(
      'SELECT total_override FROM entries WHERE date=?').get('2026-07-06').total_override, 0.5,
    'entry is stale after the interrupted clock edit');

    await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
    clock.advance(360); // past the 2 s misclick grace
    const stop = (await t.fetchJson('POST', `/api/timers/${timer.id}/stop`)).body;
    assert.equal(stop.hours, 1.1, '3600 + 360 s = 1.1 h');

    const rows = t.db.prepare(
      'SELECT id, total_override FROM entries WHERE date=? AND deleted_at IS NULL'
    ).all('2026-07-06');
    assert.equal(rows.length, 1, 'no duplicate entry');
    assert.equal(rows[0].total_override, 1.1, 'the same entry absorbed the edited clock');
  } finally { await t.close(); }
});

// Control: the SAME user action, completed without interruption, is correct.
// This is what makes the crash window (not the route) the defect.
test('control: an uninterrupted PATCH /api/timers/:id re-point MOVES the entry — '
  + 'one entry, one matter, no double count', async () => {
  const clock = makeClock('2026-07-06T09:00:00-07:00');
  const t = await startTestServer({ clock });
  try {
    const A = (await t.fetchJson('POST', '/api/cms', {
      cm_number: '100001-000012', short_name: 'Acme lease', billable: 1,
    })).body;
    const B = (await t.fetchJson('POST', '/api/cms', {
      cm_number: '100001-000034', short_name: 'Acme merger', billable: 1,
    })).body;
    const timer = (await t.fetchJson('POST', '/api/timers', { name: 'T', cm_id: A.id })).body;
    await t.fetchJson('PUT', `/api/timers/${timer.id}/clock`, { hours: 0.5 });
    await t.fetchJson('PATCH', `/api/timers/${timer.id}`, { cm_id: B.id, move_entry: true });
    await t.fetchJson('POST', `/api/timers/${timer.id}/start`);

    const rows = t.db.prepare(
      'SELECT id, cm_id, total_override FROM entries WHERE date=? AND deleted_at IS NULL'
    ).all('2026-07-06');
    assert.equal(rows.length, 1, 'the entry moved, it was not duplicated');
    assert.equal(rows[0].cm_id, B.id);
    assert.equal(rows[0].total_override, 0.5, '0.5 h of clock is still 0.5 h of entries');
  } finally { await t.close(); }
});
