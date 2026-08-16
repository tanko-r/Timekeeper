// ===========================================================================
// ADVERSARIAL VERIFICATION of the claim:
//   "Entries are stamped exported before any file exists, and stay stamped
//    when none is delivered"  (server/routes/export.js:97-106)
//
// Written independently of test/integrity.export.test.js. Every fact below is
// read straight out of the temp database with better-sqlite3 after driving a
// REAL server, so nothing here depends on the route's own reporting.
//
// The tests named PROVING FAIL are expected to FAIL against the code as it
// stands. Do not relax them to make the suite green — they encode the brief's
// rule "No entry marked exported that did not actually reach the file."
// The tests named EVIDENCE pass today and record exactly how far the damage
// does and does not go (they are also honest regression guards).
// ===========================================================================
process.env.TZ = 'America/Los_Angeles';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { startTestServer } from './helpers.js';

const NOW = new Date('2026-08-14T15:00:00-07:00');
const clock = () => NOW;
const DAY = '2026-08-14';

async function boot() {
  const t = await startTestServer({ clock });
  const acme = (await t.fetchJson('POST', '/api/cms', {
    cm_number: '100001-000012', short_name: 'Acme lease', billable: 1,
  })).body;
  return { t, acme };
}

async function finalized(t, cmId, narrative, hours) {
  const e = (await t.fetchJson('POST', '/api/entries', {
    date: DAY, cm_id: cmId, narrative,
    tasks: [{ task_code: 'Draft', duration: hours, fragment: 'work' }],
  })).body;
  const f = await t.fetchJson('POST', `/api/entries/${e.id}/finalize`, { ack: true });
  assert.equal(f.status, 200, `finalize failed: ${JSON.stringify(f.body)}`);
  return f.body;
}

const stampsOf = (t, ids) => t.db
  .prepare(`SELECT id, exported_at FROM entries WHERE id IN (${ids.join(',')}) ORDER BY id`)
  .all();

// Wait until the server has finished handling a request whose client is gone.
async function settle(t, ids, ms = 1500) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (stampsOf(t, ids).some((r) => r.exported_at)) return;
    await new Promise((r) => setTimeout(r, 20));
  }
}

// ---------------------------------------------------------------------------
// 1. The claimed reproduction, verbatim: a client that writes POST /api/export
//    onto the wire and vanishes without reading one byte of the response. No
//    JSON reaches it, so no csv/tim string exists on its side, so downloadText()
//    is never called and no file is ever created.
// ---------------------------------------------------------------------------
test('PROVING FAIL: a client that never reads the response still leaves entries stamped exported',
  async () => {
    const { t, acme } = await boot();
    try {
      const ids = [];
      for (let i = 0; i < 3; i++) {
        ids.push((await finalized(t, acme.id, `Prepared item ${i} for the closing binder.`, 0.5)).id);
      }
      const before = stampsOf(t, ids);
      assert.deepEqual(before.map((r) => r.exported_at), [null, null, null],
        'precondition: nothing is stamped yet');

      const body = JSON.stringify({ from: DAY, to: DAY });
      await new Promise((resolve) => {
        const sock = net.connect(Number(new URL(t.base).port), '127.0.0.1', () => {
          sock.write(
            'POST /api/export HTTP/1.1\r\nHost: 127.0.0.1\r\n'
            + 'Content-Type: application/json\r\n'
            + `Content-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
            () => { sock.destroy(); resolve(); },
          );
        });
        sock.on('error', () => resolve());
      });
      await settle(t, ids);

      const after = stampsOf(t, ids);
      assert.deepEqual(
        after.map((r) => r.exported_at), [null, null, null],
        'LEAK: 1.5 h across 3 entries carries an exported_at stamp although the response — and '
        + `therefore the file — never reached anyone. Stamps now in the DB: ${JSON.stringify(after)}`,
      );
    } finally { await t.close(); }
  });

// ---------------------------------------------------------------------------
// 2. The same thing through the browser's own primitive, at the exact moment
//    the real client is exposed: the request lands and is handled, and the
//    connection dies between the response headers and the body the payload
//    lives in — a cloudflared tunnel dropping, a phone sleeping, a tab closed
//    on the spinner. public/js/api.js then throws inside res.json(), and
//    ExportDialog run() lands in its catch with an error toast and no file.
//
//    (Aborting BEFORE the request is flushed is the harmless case: the server
//    never handles it and nothing is stamped. That variation is not the bug.)
// ---------------------------------------------------------------------------
test('PROVING FAIL: a connection that dies between headers and payload still stamps the entries',
  async () => {
    const { t, acme } = await boot();
    try {
      const e = await finalized(t, acme.id, 'Reviewed the amended lease and marked up the rider.', 1.2);
      const ac = new AbortController();
      const res = await fetch(`${t.base}/api/export`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ from: DAY, to: DAY }),
        signal: ac.signal,
      });
      assert.equal(res.status, 200, 'the server handled it');
      ac.abort(); // connection gone before the client can read the payload
      let payload = null;
      try { payload = await res.json(); } catch { /* what the real client gets */ }
      assert.equal(payload, null,
        'precondition: the client holds no csv/tim string, so downloadText() can never run');
      await settle(t, [e.id]);

      const row = t.db.prepare('SELECT exported_at FROM entries WHERE id=?').get(e.id);
      assert.equal(
        row.exported_at, null,
        `LEAK: 1.2 h is stamped exported_at=${row.exported_at} although the client never received `
        + 'the payload. It showed an error toast and wrote no file.',
      );
    } finally { await t.close(); }
  });

// ---------------------------------------------------------------------------
// 3. EVIDENCE — how far the damage goes. After the orphaned request above, is
//    the time still findable by the backstops built to find it?
//
//    UPDATED 2026-08-16, with the two-phase handshake landed. This test used to
//    record the damage — alerts 0, chip 0 — because the stamp was written
//    inside the request. That is the very defect the two PROVING FAIL tests
//    above assert against, so once they pass this one MUST read the other way:
//    the same orphaned request now leaves the entry exactly where it was, and
//    every backstop still reports the 2.0 h as owed. The assertions are
//    inverted, not relaxed; the stimulus is byte-for-byte the one the auditor
//    wrote, and the audit_log observation at the end is untouched.
// ---------------------------------------------------------------------------
test('EVIDENCE: after the undelivered export the unexported backstops still report the time owed',
  async () => {
    const { t, acme } = await boot();
    try {
      const e = await finalized(t, acme.id, 'Attended to the closing checklist.', 2.0);

      const alertsBefore = (await t.fetchJson('GET', '/api/dashboard')).body.alerts.unexported;
      assert.equal(alertsBefore.count, 1, 'precondition: the dashboard says 1 finalized, not yet exported');
      const chipBefore = await t.fetchJson('GET',
        `/api/export/preview?from=${DAY}&to=${DAY}&attention=unexported`);
      assert.equal(chipBefore.body.count, 1, 'precondition: "Not exported yet" shows it');

      // request sent, response never read
      const body = JSON.stringify({ from: DAY, to: DAY });
      await new Promise((resolve) => {
        const sock = net.connect(Number(new URL(t.base).port), '127.0.0.1', () => {
          sock.write(
            'POST /api/export HTTP/1.1\r\nHost: 127.0.0.1\r\n'
            + 'Content-Type: application/json\r\n'
            + `Content-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
            () => { sock.destroy(); resolve(); },
          );
        });
        sock.on('error', () => resolve());
      });
      await settle(t, [e.id]);

      const alertsAfter = (await t.fetchJson('GET', '/api/dashboard')).body.alerts.unexported;
      const chipAfter = await t.fetchJson('GET',
        `/api/export/preview?from=${DAY}&to=${DAY}&attention=unexported`);
      assert.equal(alertsAfter.count, 1,
        'the dashboard stalled-time callout must still name the 2.0 h that never reached a file');
      assert.equal(alertsAfter.hours, 2.0);
      assert.equal(chipAfter.body.count, 1,
        'and "Not exported yet" / attention=unexported must still list it');
      assert.equal(t.db.prepare('SELECT exported_at FROM entries WHERE id=?').get(e.id).exported_at,
        null, 'nothing was marked sent, because nothing was delivered');

      // No audit trail of the export at all — the table exists and other
      // destructive actions write to it.
      const audit = t.db.prepare('SELECT COUNT(*) c FROM audit_log WHERE entry_id=?').get(e.id).c;
      assert.equal(audit, 0, 'and nothing was written to audit_log, so there is no record to reconcile against');
    } finally { await t.close(); }
  });

// ---------------------------------------------------------------------------
// 4. EVIDENCE — the counterweight the claim understates. The stamp does not
//    gate the export itself: POST /api/export selects on status='finalized',
//    never on exported_at. Re-running the identical export produces the
//    identical rows. The time is SILENCED, not destroyed.
// ---------------------------------------------------------------------------
test('EVIDENCE: the same range re-exports byte-identically afterwards, so the time is recoverable',
  async () => {
    const { t, acme } = await boot();
    try {
      const e = await finalized(t, acme.id, 'Attended to the closing checklist.', 2.0);
      const first = await t.fetchJson('POST', '/api/export', { from: DAY, to: DAY });
      assert.equal(first.body.count, 1);
      // The file arrived, so the client confirms the batch — the only writer of
      // exported_at since the 2026-08-16 two-phase handshake.
      await t.fetchJson('POST', `/api/export/${first.body.batch}/confirm`, {});
      const stamped = t.db.prepare('SELECT exported_at FROM entries WHERE id=?').get(e.id).exported_at;
      assert.ok(stamped, 'precondition: it is stamped');

      const second = await t.fetchJson('POST', '/api/export', { from: DAY, to: DAY });
      assert.equal(second.body.count, 1,
        'an already-stamped entry still exports — the stamp is an alert flag, not a filter');
      assert.equal(second.body.csv, first.body.csv, 'and the CSV is identical');
      assert.deepEqual(second.body.entry_ids, [e.id]);
    } finally { await t.close(); }
  });

// ---------------------------------------------------------------------------
// 5. EVIDENCE — but the only way to clear a wrong stamp is to unlock the entry
//    back to draft and finalize it again. finalizeOne() short-circuits on an
//    already-finalized entry, so "finalize again" alone does nothing. There is
//    no "mark as not sent" anywhere in the API.
// ---------------------------------------------------------------------------
test('EVIDENCE: a wrong stamp can only be cleared by unlocking and re-finalizing',
  async () => {
    const { t, acme } = await boot();
    try {
      const e = await finalized(t, acme.id, 'Attended to the closing checklist.', 2.0);
      const sent = await t.fetchJson('POST', '/api/export', { from: DAY, to: DAY });
      // The file arrived, so the client confirms it (2026-08-16 handshake).
      await t.fetchJson('POST', `/api/export/${sent.body.batch}/confirm`, {});
      assert.ok(t.db.prepare('SELECT exported_at FROM entries WHERE id=?').get(e.id).exported_at);

      // re-finalizing is a no-op on an already finalized entry
      await t.fetchJson('POST', `/api/entries/${e.id}/finalize`, { ack: true });
      assert.ok(t.db.prepare('SELECT exported_at FROM entries WHERE id=?').get(e.id).exported_at,
        'finalize on an already-finalized entry does not clear the stamp');

      // the two-step the user would have to know about
      const unlock = await t.fetchJson('POST', `/api/entries/${e.id}/unlock`, {});
      assert.equal(unlock.status, 200, `unlock failed: ${JSON.stringify(unlock.body)}`);
      await t.fetchJson('POST', `/api/entries/${e.id}/finalize`, { ack: true });
      assert.equal(
        t.db.prepare('SELECT exported_at FROM entries WHERE id=?').get(e.id).exported_at, null,
        'unlock + finalize is the only undo, and nothing in the export flow points at it',
      );
    } finally { await t.close(); }
  });
