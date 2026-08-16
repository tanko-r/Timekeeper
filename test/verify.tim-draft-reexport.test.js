// ===========================================================================
// ADVERSARIAL VERIFICATION — THESE "LEAK" TESTS ARE EXPECTED TO FAIL.
//
// Claim under test: "A draft written into the .TIM is not stamped and ships
// again after finalization, with a fresh ref UUID each time."
//   server/routes/export.js:97-103  — markExported only touches status='finalized'
//   server/lib/tim.js:60            — ref = randomUUID() per render
//
// These are PROVING tests. Each failure message names the defect. Do not
// relax an assertion to make one pass; fix the export instead.
//
// Regression guards named "OK" pass today and must never start failing.
// ===========================================================================
process.env.TZ = 'America/Los_Angeles';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

const clock = () => new Date('2026-07-06T15:00:00-07:00');

async function boot(overrides = {}) {
  const t = await startTestServer({ clock, ...overrides });
  const acme = (await t.fetchJson('POST', '/api/cms', {
    cm_number: '100001-000012', short_name: 'Acme lease', billable: 1,
  })).body;
  return { t, acme };
}

// A .TIM line is `k=v|k=v|…`. Parse one back into an object so we can ask which
// fields would let a receiving system recognise a second copy of one entry.
function parseTimLine(line) {
  const out = {};
  for (const pair of line.split('|')) {
    const i = pair.indexOf('=');
    out[pair.slice(0, i)] = pair.slice(i + 1);
  }
  return out;
}

const timLines = (tim) => String(tim || '').split('\n').filter(Boolean);

// ---------------------------------------------------------------------------
// LEAK — the path the app's own dashboard links to.
//
// The dashboard's stalled-time banner links to `#/export/unfinalized/<oldest>`
// (public/js/views/dashboard.js:116), which opens the ledger filtered to
// drafts; scopeFor() → attentionOf() turns that into {attention:'unfinalized'}
// (public/js/views/search.js:742-776) and the Export dialog's "Download .TIM"
// button POSTs it (search.js:590-599). The dashboard's own CSV toast even says
// "use the Export page for drafts" (dashboard.js:147).
//
// The .TIM is not a human summary: it is a machine import into DTE Axiom /
// TimeSaver. A draft imported today is a real billing entry. The stamp is
// deliberately skipped for drafts (export.js:99-101), so the same entry ships
// again the moment it is finalized and exported normally — and every
// identifying field in the file (ref, shortref, ss, ar) is freshly random, so
// nothing in the second file lets the billing system spot the duplicate.
// ---------------------------------------------------------------------------
test('LEAK: the drafts-only .TIM ships unstamped, then ships the same hour again once finalized',
  async () => {
    const { t, acme } = await boot();
    try {
      const e = (await t.fetchJson('POST', '/api/entries', {
        date: '2026-07-06',
        cm_id: acme.id,
        narrative: 'Prepared the deposition outline for the witness.',
        tasks: [{ task_code: 'Draft', duration: 1.0, fragment: 'outline' }],
      })).body;

      // 1. Export exactly what the dashboard banner's deep link produces.
      const first = await t.fetchJson('POST', '/api/export', {
        from: '2026-07-06', to: '2026-07-06', attention: 'unfinalized',
      });
      assert.equal(first.status, 200, JSON.stringify(first.body));
      const lineA = timLines(first.body.tim);
      assert.equal(lineA.length, 1, 'precondition: the draft is a real .TIM import line');
      const A = parseTimLine(lineA[0]);
      assert.equal(A.na, 'Prepared the deposition outline for the witness.');
      assert.equal(A.am, '3600', 'precondition: the file bills 1.0 h');

      // 1b. The file downloaded, so the client confirms it. Since the
      // 2026-08-16 two-phase handshake this is the ONLY writer of exported_at:
      // the server cannot tell a delivered file from a dropped connection.
      const conf = await t.fetchJson('POST', `/api/export/${first.body.batch}/confirm`, {});
      assert.equal(conf.status, 200, `confirm failed: ${JSON.stringify(conf.body)}`);

      // 2. Read the database directly. This is the whole mechanism.
      const afterFirst = t.db.prepare(
        'SELECT status, exported_at, ever_finalized FROM entries WHERE id=?',
      ).get(e.id);
      assert.equal(afterFirst.status, 'draft');
      // SCAFFOLD REPAIR (2026-08-16): the expected value was the literal
      // placeholder 'ROW WAS STAMPED', which no implementation can produce —
      // exported_at is an ISO timestamp. The specification the auditor was
      // writing down is "the row IS stamped", asserted here; the failure
      // message is the auditor's, verbatim.
      assert.ok(
        afterFirst.exported_at,
        `LEAK: 1.0 h reached a machine-import .TIM and the row is unstamped `
        + `(exported_at=${JSON.stringify(afterFirst.exported_at)}). Nothing in the app now `
        + 'knows this time has already been sent to the billing system.',
      );
    } finally { await t.close(); }
  });

test('LEAK: the same hour lands in two .TIM files with no field that ties them together', async () => {
  const { t, acme } = await boot();
  try {
    const e = (await t.fetchJson('POST', '/api/entries', {
      date: '2026-07-06',
      cm_id: acme.id,
      narrative: 'Prepared the deposition outline for the witness.',
      tasks: [{ task_code: 'Draft', duration: 1.0, fragment: 'outline' }],
    })).body;

    const first = await t.fetchJson('POST', '/api/export', {
      from: '2026-07-06', to: '2026-07-06', attention: 'unfinalized',
    });
    const A = parseTimLine(timLines(first.body.tim)[0]);

    // The ordinary next step: finalize the day, then export the range normally.
    const f = await t.fetchJson('POST', `/api/entries/${e.id}/finalize`, { ack: true });
    assert.equal(f.status, 200, JSON.stringify(f.body));
    const second = await t.fetchJson('POST', '/api/export', { from: '2026-07-06', to: '2026-07-06' });
    const linesB = timLines(second.body.tim);
    assert.equal(linesB.length, 1, 'precondition: the finalized entry ships normally');
    const B = parseTimLine(linesB[0]);

    // Same client, same work date, same hours, same narrative — one entry,
    // two import lines.
    assert.equal(B.na, A.na);
    assert.equal(B.am, A.am);
    assert.equal(B.wd, A.wd);
    assert.equal(B.ma, A.ma);

    // Is there ANY identifying field that repeats, so the receiving system
    // could dedupe? Constants (f=TIME, billed=N, version=…) identify nothing.
    const CONSTANT = new Set(['billed', 'billing', 'closed', 'co', 'createdintimesaver', 'del',
      'ex', 'f', 'lmb', 'op', 'originapplication', 're', 'releasable', 'st', 'tk', 'u2',
      'unconver', 'version', 'cl', 'ma', 'wd', 'am', 'na', 'ed', 'md']);
    const identifiers = Object.keys(A).filter((k) => !CONSTANT.has(k));
    assert.deepEqual(identifiers.sort(), ['ar', 'ref', 'shortref', 'ss'],
      'precondition: these are the only per-line identifiers the .TIM carries');
    const stable = identifiers.filter((k) => A[k] === B[k]);

    assert.notDeepEqual(
      stable, [],
      `LEAK: the same 1.0 h ships in two .TIM files and every identifier differs — `
      + `ref ${A.ref} → ${B.ref}, shortref ${A.shortref} → ${B.shortref}. `
      + 'Both import as separate billable entries; the client is billed twice and no field '
      + 'in either file lets DTE Axiom spot the duplicate.',
    );
  } finally { await t.close(); }
});

// ---------------------------------------------------------------------------
// LEAK — the second half of the claim, on the path the dialog itself invites.
// public/js/views/search.js:701 tells the user "you can re-export any time."
// Re-exporting a finalized entry re-renders it with a brand-new ref, so a
// second import of the same file range double-bills too.
// ---------------------------------------------------------------------------
test('LEAK: re-exporting one unchanged finalized entry produces a second, unrecognisable .TIM line',
  async () => {
    const { t, acme } = await boot();
    try {
      const e = (await t.fetchJson('POST', '/api/entries', {
        date: '2026-07-06', cm_id: acme.id, narrative: 'Telephone conference with opposing counsel.',
        tasks: [{ task_code: 'Call', duration: 0.5, fragment: 'call' }],
      })).body;
      await t.fetchJson('POST', `/api/entries/${e.id}/finalize`, { ack: true });

      const one = await t.fetchJson('POST', '/api/export', { from: '2026-07-06', to: '2026-07-06' });
      const two = await t.fetchJson('POST', '/api/export', { from: '2026-07-06', to: '2026-07-06' });
      const A = parseTimLine(timLines(one.body.tim)[0]);
      const B = parseTimLine(timLines(two.body.tim)[0]);

      assert.equal(A.na, B.na, 'precondition: the same entry, unchanged');
      assert.equal(
        A.ref, B.ref,
        `LEAK: the same finalized entry renders as ref ${A.ref} then ref ${B.ref}. A .TIM is `
        + 'idempotent only if the ref is stable per entry; here a re-export is indistinguishable '
        + 'from a genuine second entry.',
      );
    } finally { await t.close(); }
  });

// ===========================================================================
// REGRESSION GUARDS — these pass today and describe the parts that are right.
// ===========================================================================

test('OK: finalizing clears a stale exported_at, so an unlocked entry re-alerts', async () => {
  const { t, acme } = await boot();
  try {
    const e = (await t.fetchJson('POST', '/api/entries', {
      date: '2026-07-06', cm_id: acme.id, narrative: 'Reviewed the lease.',
      tasks: [{ task_code: 'Review', duration: 0.5, fragment: 'work' }],
    })).body;
    await t.fetchJson('POST', `/api/entries/${e.id}/finalize`, { ack: true });
    const sent = await t.fetchJson('POST', '/api/export', { from: '2026-07-06', to: '2026-07-06' });
    // The file downloaded, so the client confirms it (2026-08-16 handshake).
    await t.fetchJson('POST', `/api/export/${sent.body.batch}/confirm`, {});
    assert.ok(t.db.prepare('SELECT exported_at FROM entries WHERE id=?').get(e.id).exported_at,
      'precondition: a finalized export stamps');

    await t.fetchJson('POST', `/api/entries/${e.id}/unlock`, {});
    await t.fetchJson('POST', `/api/entries/${e.id}/finalize`, { ack: true });
    assert.equal(t.db.prepare('SELECT exported_at FROM entries WHERE id=?').get(e.id).exported_at, null,
      'finalizeOne() must clear the stale stamp so the entry alerts as unexported again');
  } finally { await t.close(); }
});

test('OK: an ordinary finalized export stamps every id it wrote, and only those', async () => {
  const { t, acme } = await boot();
  try {
    const draft = (await t.fetchJson('POST', '/api/entries', {
      date: '2026-07-06', cm_id: acme.id, narrative: 'Still working on this one.',
      tasks: [{ task_code: 'Draft', duration: 0.3, fragment: 'wip' }],
    })).body;
    const done = (await t.fetchJson('POST', '/api/entries', {
      date: '2026-07-06', cm_id: acme.id, narrative: 'Reviewed the lease.',
      tasks: [{ task_code: 'Review', duration: 0.5, fragment: 'work' }],
    })).body;
    await t.fetchJson('POST', `/api/entries/${done.id}/finalize`, { ack: true });

    const r = await t.fetchJson('POST', '/api/export', { from: '2026-07-06', to: '2026-07-06' });
    // The file downloaded, so the client confirms it (2026-08-16 handshake).
    await t.fetchJson('POST', `/api/export/${r.body.batch}/confirm`, {});
    assert.deepEqual(r.body.entry_ids, [done.id], 'the default export is finalized-only');
    assert.equal(timLines(r.body.tim).length, 1);
    assert.ok(t.db.prepare('SELECT exported_at FROM entries WHERE id=?').get(done.id).exported_at);
    assert.equal(t.db.prepare('SELECT exported_at FROM entries WHERE id=?').get(draft.id).exported_at, null);
  } finally { await t.close(); }
});
