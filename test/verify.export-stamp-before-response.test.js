// VERIFICATION of the claim: "POST /api/export stamps exported_at before the
// response leaves the server" (server/routes/export.js:101-106).
//
// These tests are written as the INVARIANT the brief demands:
//
//   "No entry marked exported that did not actually reach the file."
//
// The LEAK-marked tests below FAIL against the code as it stands today. That
// failure IS the evidence — do not "fix" them by relaxing the assertion.
//
// The reproduction is a TCP proxy in front of the real server that forwards the
// request upstream and then cuts BOTH sockets the instant the first response
// byte comes back. The client end is destroyed before a single byte is ever
// written to it, so there is no doubt about what the client received: nothing.
// That is a dropped connection (mobile signal, cloudflared blip, closed tab)
// modelled exactly, with no timing race in the test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { startTestServer } from './helpers.js';

const DAY = '2026-07-06';

async function withData(fn) {
  const clock = () => new Date('2026-07-06T15:00:00-07:00');
  const t = await startTestServer({ clock });
  try {
    const cm = (await t.fetchJson('POST', '/api/cms', {
      cm_number: '100001-000012', short_name: 'Acme lease', billable: 1,
    })).body;
    const fin = (await t.fetchJson('POST', '/api/entries', {
      date: DAY,
      cm_id: cm.id,
      narrative: 'Reviewed the lease amendment and circulated comments to the landlord.',
      tasks: [{ task_code: 'Review', duration: 1.2, fragment: 'review lease' }],
    })).body;
    await t.fetchJson('POST', `/api/entries/${fin.id}/finalize`);
    await fn(t, { cm, fin });
  } finally { await t.close(); }
}

// A proxy that lets the request through and kills the connection before the
// response can reach the client. Returns { port, close, sawResponse }.
async function cuttingProxy(upstreamPort) {
  const state = { sawResponse: false };
  const sockets = new Set();
  const srv = net.createServer((client) => {
    sockets.add(client);
    const up = net.connect(upstreamPort, '127.0.0.1');
    sockets.add(up);
    client.on('error', () => {});
    up.on('error', () => {});
    client.on('data', (chunk) => up.write(chunk));
    // NOT piped back: the client is destroyed at the first upstream byte, so
    // the response body never crosses to it.
    up.once('data', () => {
      state.sawResponse = true;
      client.destroy();
      up.destroy();
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return {
    port: srv.address().port,
    state,
    close: () => new Promise((r) => { for (const s of sockets) s.destroy(); srv.close(r); }),
  };
}

function postThroughProxy(port, path, bodyObj) {
  const body = JSON.stringify(bodyObj);
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1', () => {
      s.write(
        `POST ${path} HTTP/1.1\r\n`
        + 'Host: 127.0.0.1\r\n'
        + 'Content-Type: application/json\r\n'
        + `Content-Length: ${Buffer.byteLength(body)}\r\n`
        + 'Connection: close\r\n\r\n'
        + body,
      );
    });
    let received = 0;
    s.on('data', (c) => { received += c.length; });
    s.on('error', () => {});
    s.on('close', () => resolve({ received }));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// LEAK 1 — the claim itself, reproduced.
// ---------------------------------------------------------------------------
test('LEAK: a dropped connection leaves exported_at stamped though no byte of the file reached the client', () =>
  withData(async (t, { fin }) => {
    const before = t.db.prepare('SELECT exported_at FROM entries WHERE id=?').get(fin.id);
    assert.equal(before.exported_at, null, 'precondition: entry is finalized and unsent');

    const proxy = await cuttingProxy(Number(new URL(t.base).port));
    const { received } = await postThroughProxy(proxy.port, '/api/export', { from: DAY, to: DAY });
    await sleep(100);
    await proxy.close();

    // The client got NOTHING. There is no CSV, no .TIM, no file.
    assert.equal(received, 0, 'the client received zero response bytes');
    assert.equal(proxy.state.sawResponse, true, 'the server did produce a response upstream');

    const row = t.db.prepare('SELECT exported_at FROM entries WHERE id=?').get(fin.id);
    // THE INVARIANT: nothing reached a file, so nothing may be marked sent.
    assert.equal(
      row.exported_at, null,
      `entry ${fin.id} is stamped exported_at=${row.exported_at} but the payload never left the box`,
    );
  }));

// ---------------------------------------------------------------------------
// LEAK 2 — the consequence that actually costs money: the entry stops asking
// to be sent. This is what turns a stamp into unbilled time.
// ---------------------------------------------------------------------------
test('LEAK: after the dropped export the entry disappears from every "never sent" alert', () =>
  withData(async (t, { fin }) => {
    const proxy = await cuttingProxy(Number(new URL(t.base).port));
    await postThroughProxy(proxy.port, '/api/export', { from: DAY, to: DAY });
    await sleep(100);
    await proxy.close();

    const dash = (await t.fetchJson('GET', '/api/dashboard')).body;
    const owed = (await t.fetchJson(
      'GET', `/api/export/preview?from=${DAY}&to=${DAY}&attention=unexported`)).body;

    assert.equal(
      dash.alerts.unexported.count, 1,
      'the dashboard must still say this finalized entry has never been sent',
    );
    assert.equal(
      owed.count, 1,
      'the unexported filter must still offer the entry that never reached a file',
    );
    assert.ok(fin.id);
  }));

// ---------------------------------------------------------------------------
// VARIATION A — the claimant's literal steps: a client that hangs up right
// after writing the request, with no proxy in the middle. Recorded either way;
// this one is not an assertion about the bug, it maps how wide the window is.
// ---------------------------------------------------------------------------
test('VARIATION: hard abort immediately after the request is written', () =>
  withData(async (t, { fin }) => {
    const body = JSON.stringify({ from: DAY, to: DAY });
    const port = Number(new URL(t.base).port);
    await new Promise((resolve) => {
      const s = net.connect(port, '127.0.0.1', () => {
        s.write(
          'POST /api/export HTTP/1.1\r\nHost: 127.0.0.1\r\n'
          + 'Content-Type: application/json\r\n'
          + `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
          () => { s.destroy(); resolve(); },
        );
      });
      s.on('error', () => {});
    });
    await sleep(150);
    const row = t.db.prepare('SELECT exported_at FROM entries WHERE id=?').get(fin.id);
    // Recorded, not asserted as the invariant: whether this window is open
    // depends on whether the kernel handed the body up before the RST.
    console.log(`  [variation A] exported_at after hard abort = ${JSON.stringify(row.exported_at)}`);
    assert.ok(row);
  }));

// ---------------------------------------------------------------------------
// VARIATION B — recoverability. Is the TIME lost, or only the reminder?
// A second export of the same range still contains the entry, so the file can
// be regenerated by hand; nothing but the alert is destroyed. This test PASSES
// and is the reason the severity is not "critical".
// ---------------------------------------------------------------------------
test('VARIATION: a re-export of the same range still contains the entry (time itself is recoverable)', () =>
  withData(async (t, { fin }) => {
    const proxy = await cuttingProxy(Number(new URL(t.base).port));
    await postThroughProxy(proxy.port, '/api/export', { from: DAY, to: DAY });
    await sleep(100);
    await proxy.close();

    const again = (await t.fetchJson('POST', '/api/export', { from: DAY, to: DAY })).body;
    assert.equal(again.count, 1, 'the same date range re-exports the already-stamped entry');
    assert.ok(again.csv.includes(String(fin.id)));
    assert.ok(again.csv.includes('Acme lease'));
  }));

// ---------------------------------------------------------------------------
// CONTROL — the same request over a healthy connection. Confirms the harness
// is not manufacturing the stamp: an intact client gets the CSV it paid for.
// ---------------------------------------------------------------------------
test('CONTROL: an intact request returns the CSV and stamps it', () =>
  withData(async (t, { fin }) => {
    const r = await t.fetchJson('POST', '/api/export', { from: DAY, to: DAY });
    assert.equal(r.status, 200);
    assert.ok(r.body.csv.includes('Acme lease'));
    // The client read the whole payload and wrote the file, so it confirms the
    // batch — the only writer of exported_at since the 2026-08-16 handshake.
    // This is the step the cut connections above can never reach.
    const conf = await t.fetchJson('POST', `/api/export/${r.body.batch}/confirm`, {});
    assert.equal(conf.status, 200, `confirm failed: ${JSON.stringify(conf.body)}`);
    const row = t.db.prepare('SELECT exported_at FROM entries WHERE id=?').get(fin.id);
    assert.ok(row.exported_at, 'a delivered export is stamped — this is correct behaviour');
  }));
