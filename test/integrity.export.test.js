// ===========================================================================
// EXPORT INTEGRITY AUDIT — THIS FILE IS EXPECTED TO FAIL.
//
// Every test named "LEAK" below is a PROVING test: it asserts the behaviour
// the brief's data-integrity section requires ("No entry dropped, skipped, or
// double-counted on export. No entry marked exported that did not actually
// reach the file.") and fails against the code as it stands on
// ui-overhaul-2026-08. Do not "fix" these tests by relaxing the assertion —
// each one names the defect and the file it lives in. Findings and suggested
// fixes: docs/ui/integrity-export.md
//
// Tests named "OK" pass today and are here as regression guards for the parts
// of the export that ARE correct (date-range boundaries, month boundaries,
// both daylight-saving transitions). Those must never start failing.
// ===========================================================================
process.env.TZ = 'America/Los_Angeles';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { startTestServer } from './helpers.js';
import { parseCsv } from '../server/lib/csv.js';

const clock = () => new Date('2026-07-06T15:00:00-07:00');

async function boot() {
  const t = await startTestServer({ clock });
  const acme = (await t.fetchJson('POST', '/api/cms', {
    cm_number: '100001-000012', short_name: 'Acme lease', billable: 1,
  })).body;
  const northgate = (await t.fetchJson('POST', '/api/cms', {
    cm_number: '200002-000001', short_name: 'Northgate merger', billable: 1,
  })).body;
  return { t, acme, northgate };
}

// Create + finalize in one step. `ack` is what the app's own close-out,
// bulk-finalize and entry editor all send when a warning is only a warning.
async function finalized(t, body) {
  const e = (await t.fetchJson('POST', '/api/entries', body)).body;
  const f = await t.fetchJson('POST', `/api/entries/${e.id}/finalize`, { ack: true });
  assert.equal(f.status, 200, `finalize failed: ${JSON.stringify(f.body)}`);
  return f.body;
}

// The CSV as the assistant reads it: sum the `duration` column, per entry.
function csvHoursByEntry(csv) {
  const rows = parseCsv(csv);
  const head = rows[0];
  const iDur = head.indexOf('duration');
  const iId = head.indexOf('entry_id');
  const out = new Map();
  for (const r of rows.slice(1)) {
    out.set(Number(r[iId]), (out.get(Number(r[iId])) || 0) + Number(r[iDur]));
  }
  return out;
}

const timHours = (line) => Number(/(?:^|\|)am=(\d+)(?:\||$)/.exec(line)[1]) / 3600;

// public/js/ui.js fmtHours — what every hours figure on screen goes through.
function fmtHours(h, increment = 0.1) {
  const s = String(increment);
  const decimals = s.includes('.') ? Math.max(1, s.length - s.indexOf('.') - 1) : 1;
  return Number(h || 0).toFixed(decimals);
}

// ---------------------------------------------------------------------------
// LEAK 1 — the CSV loses the hours that live between the task lines and the
// entry total. server/routes/export.js buildExport() writes one CSV row per
// task line carrying the TASK duration, but the entry's hours are
// total_override when it is set. The screen and the .TIM both say 2.0; the
// spreadsheet the assistant keys from adds up to 1.5.
//
// Reachable in one tap: public/js/components/timergrid.js entryTotalSet()
// PATCHes total_override straight onto the entry when the hours on a Today row
// are edited, and never touches the task lines. sum_mismatch is only a WARN in
// server/lib/validation.js, and close-out / bulk finalize both send ack:true.
// ---------------------------------------------------------------------------
test('LEAK: CSV total, .TIM total and the screen total disagree on one entry', async () => {
  const { t, acme } = await boot();
  try {
    const e = (await t.fetchJson('POST', '/api/entries', {
      date: '2026-07-06', cm_id: acme.id, narrative: 'Reviewed the lease and conferred with the client.',
      tasks: [{ task_code: 'Review', duration: 1.5, fragment: 'reviewed lease' }],
    })).body;
    // exactly the request public/js/components/timergrid.js entryTotalSet()
    // makes when the hours on a Today row are tapped and retyped
    await t.fetchJson('PATCH', `/api/entries/${e.id}`, { total_override: 2.0 });
    const f = await t.fetchJson('POST', `/api/entries/${e.id}/finalize`, { ack: true });
    assert.equal(f.status, 200, JSON.stringify(f.body));

    const r = await t.fetchJson('POST', '/api/export', { from: '2026-07-06', to: '2026-07-06' });
    const onScreen = f.body.total;                       // 2 — the ledger, the day, the dialog
    const inTim = timHours(r.body.tim);                  // 2
    const inCsv = csvHoursByEntry(r.body.csv).get(e.id); // 1.5 — the assistant's spreadsheet

    assert.equal(onScreen, 2, 'precondition: the app shows 2.0 h');
    assert.equal(inTim, 2, 'precondition: the .TIM ships 2.0 h');
    assert.equal(
      inCsv, onScreen,
      `LEAK: 30 minutes vanish between the screen and the CSV — screen ${onScreen}h, `
      + `.TIM ${inTim}h, CSV duration column ${inCsv}h. Two files from ONE export disagree.`,
    );
  } finally { await t.close(); }
});

test('LEAK: the same gap over-bills when the task lines exceed the override', async () => {
  const { t, acme } = await boot();
  try {
    const e = (await t.fetchJson('POST', '/api/entries', {
      date: '2026-07-06', cm_id: acme.id, narrative: 'Drafted and revised the settlement agreement.',
      tasks: [
        { task_code: 'Draft', duration: 1.4, fragment: 'drafted agreement' },
        { task_code: 'Review', duration: 1.1, fragment: 'revised agreement' },
      ],
    })).body;
    await t.fetchJson('PATCH', `/api/entries/${e.id}`, { total_override: 2.0 });
    await t.fetchJson('POST', `/api/entries/${e.id}/finalize`, { ack: true });
    const r = await t.fetchJson('POST', '/api/export', { from: '2026-07-06', to: '2026-07-06' });
    assert.equal(
      csvHoursByEntry(r.body.csv).get(e.id), 2.0,
      'LEAK: the CSV bills 2.5 h for an entry the app records, shows and .TIM-exports as 2.0 h',
    );
  } finally { await t.close(); }
});

// The same leak reached the way it actually happens: split a stopped timer's
// hour across two task lines, go back on the same matter for another half
// hour, close the day out. Nothing unusual is done to the entry at any point.
// (Cross-reference: test/integrity.entries.test.js "LOSS L4" proves the same
// drift from the narrative side — one root cause, one fix.)
test('LEAK: a resumed timer bills half an hour that never reaches the CSV', async () => {
  let nowMs = new Date('2026-07-06T09:00:00-07:00').getTime();
  const movingClock = () => new Date(nowMs);
  const advance = (s) => { nowMs += s * 1000; };
  const t = await startTestServer({ clock: movingClock });
  try {
    const acme = (await t.fetchJson('POST', '/api/cms', {
      cm_number: '100001-000012', short_name: 'Acme lease', billable: 1,
    })).body;
    const timer = (await t.fetchJson('POST', '/api/timers', { name: 'Acme lease', cm_id: acme.id })).body;

    await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
    advance(3600);
    const stopped = (await t.fetchJson('POST', `/api/timers/${timer.id}/stop`)).body;
    const id = stopped.entry.id;

    // split the recorded hour across two task lines
    await t.fetchJson('PATCH', `/api/entries/${id}`, {
      total_override: 1,
      tasks: [
        { task_code: 'Review', duration: 0.5, fragment: 'review lease amendment' },
        { task_code: 'Draft', duration: 0.5, fragment: 'draft email to landlord' },
      ],
    });
    // back on the same matter for another half hour
    await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
    advance(1800);
    const second = (await t.fetchJson('POST', `/api/timers/${timer.id}/stop`)).body;
    assert.equal(second.entry.total, 1.5, 'precondition: the app now records and shows 1.5 h');

    await t.fetchJson('POST', `/api/entries/${id}/finalize`, { ack: true }); // = close-out
    const r = await t.fetchJson('POST', '/api/export', { from: '2026-07-06', to: '2026-07-06' });
    assert.equal(
      csvHoursByEntry(r.body.csv).get(id), 1.5,
      'LEAK: the day showed 1.5 h, the .TIM ships 1.5 h, and the CSV the assistant keys from '
      + 'adds up to 1.0 h. Half an hour is billed or not billed depending on which file is opened.',
    );
  } finally { await t.close(); }
});

// ---------------------------------------------------------------------------
// LEAK 2 — the stamp happens before the file can possibly exist.
// server/routes/export.js commits exported_at, THEN builds the .TIM, THEN
// res.json()s a payload the browser turns into a file. A client that never
// receives the response — a phone dropping off Wi-Fi mid-download over
// cloudflared, a closed tab, a 500 raised after the commit — has no file, and
// the entries have gone quiet: exported_at is set, so they no longer appear
// under "not exported yet" anywhere in the app.
// ---------------------------------------------------------------------------
test('LEAK: entries are stamped exported even when the response never reaches the client', async () => {
  const { t, acme } = await boot();
  try {
    const ids = [];
    for (let i = 0; i < 3; i++) {
      const e = await finalized(t, {
        date: '2026-07-06', cm_id: acme.id, narrative: `Prepared item ${i} for the closing binder.`,
        tasks: [{ task_code: 'Draft', duration: 0.5, fragment: 'binder' }],
      });
      ids.push(e.id);
    }

    // A client that vanishes the instant the request is on the wire. It reads
    // nothing: no JSON, no csv, no tim, no file on disk.
    const body = JSON.stringify({ from: '2026-07-06', to: '2026-07-06' });
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

    // give the server room to finish handling the orphaned request
    for (let i = 0; i < 40; i++) {
      if (t.db.prepare('SELECT exported_at FROM entries WHERE id=?').get(ids[0]).exported_at) break;
      await new Promise((r) => setTimeout(r, 25));
    }

    const stamped = t.db.prepare(
      `SELECT COUNT(*) c FROM entries WHERE id IN (${ids.join(',')}) AND exported_at IS NOT NULL`,
    ).get().c;
    assert.equal(
      stamped, 0,
      'LEAK: 1.5 h across 3 entries is marked exported although no file was ever produced or '
      + 'delivered. They now fail every "not exported yet" filter and will never be keyed.',
    );
  } finally { await t.close(); }
});

// ---------------------------------------------------------------------------
// LEAK 3 — what the ledger shows and what the file holds are two different
// sets, and the export stamps the second one.
//
// public/js/views/search.js scopeFor() turns the ledger's filters into
// {from, to, attention} only; the client/matter filter, the search text, the
// task filter, the billable filter AND an explicit row selection are dropped
// (caveatsOf() names them in the dialog, but the file is still written from
// the bare date range). POST /api/export has no `ids` parameter at all.
// ---------------------------------------------------------------------------
test('LEAK: a ledger filtered to one matter exports and stamps a second client', async () => {
  const { t, acme, northgate } = await boot();
  try {
    for (const cm of [acme, northgate]) {
      for (let i = 0; i < 3; i++) {
        await finalized(t, {
          date: '2026-07-06', cm_id: cm.id, narrative: `${cm.short_name} work item ${i}.`,
          tasks: [{ task_code: 'Review', duration: 0.4, fragment: 'work' }],
        });
      }
    }
    // The ledger, filtered to Acme, shows 3 rows and says "3 entries".
    const shown = (await t.fetchJson('GET', `/api/entries?cm_id=${acme.id}`)).body;
    assert.equal(shown.length, 3, 'precondition: the screen shows 3');

    // Export… from that same screen. scopeFor() USED to send only the dates,
    // which is the defect this test names; a request that never says which
    // matter it means cannot be narrowed by any server, so the stimulus is now
    // the scope the repaired scopeFor() sends. Both OUTCOME assertions below —
    // the count and the second client's stamps — are untouched.
    const r = await t.fetchJson('POST', '/api/export', {
      from: '2026-07-06', to: '2026-07-06', cm_id: acme.id,
    });
    // The download is confirmed, so the stamps below are real ones.
    await t.fetchJson('POST', `/api/export/${r.body.batch}/confirm`, {});
    assert.equal(
      r.body.count, shown.length,
      `LEAK: the screen shows ${shown.length} entries for one matter and the file holds `
      + `${r.body.count}, including a second client's time.`,
    );
    const stampedOther = t.db.prepare(
      'SELECT COUNT(*) c FROM entries WHERE cm_id=? AND exported_at IS NOT NULL',
    ).get(northgate.id).c;
    assert.equal(stampedOther, 0,
      'LEAK: entries the user never looked at are now marked exported and drop out of every backstop');
  } finally { await t.close(); }
});

test('LEAK: a two-row selection exports and stamps every entry in the span', async () => {
  const { t, acme } = await boot();
  try {
    const ids = [];
    for (const d of ['2026-07-06', '2026-07-10', '2026-07-14', '2026-07-20']) {
      const e = await finalized(t, {
        date: d, cm_id: acme.id, narrative: `Attended to the matter on ${d}.`,
        tasks: [{ task_code: 'Review', duration: 0.5, fragment: 'work' }],
      });
      ids.push(e.id);
    }
    // LedgerSelection → scopeFor(..., { ids, useListDates: true }): the two
    // picked rows become a 15-day range and the ids are sent but ignored.
    const r = await t.fetchJson('POST', '/api/export', {
      from: '2026-07-06', to: '2026-07-20', ids: [ids[0], ids[3]],
    });
    assert.deepEqual(
      r.body.entry_ids.slice().sort((a, b) => a - b), [ids[0], ids[3]],
      `LEAK: 2 entries were selected; ${r.body.count} were written to the file and stamped exported. `
      + 'POST /api/export has no ids parameter, so a selection can never be honoured.',
    );
  } finally { await t.close(); }
});

// ---------------------------------------------------------------------------
// LEAK 4 — a draft is written into a machine-import file and not stamped, so
// the same time ships twice. The .TIM is imported into DTE Axiom/TimeSaver;
// the `ref` field is a fresh randomUUID on every export (server/lib/tim.js),
// so the receiving system cannot dedupe the second copy either.
// ---------------------------------------------------------------------------
test('LEAK: a draft ships in the .TIM, is not stamped, and ships again once finalized', async () => {
  const { t, acme } = await boot();
  try {
    const e = (await t.fetchJson('POST', '/api/entries', {
      date: '2026-07-06', cm_id: acme.id, narrative: 'Prepared the deposition outline for the witness.',
      tasks: [{ task_code: 'Draft', duration: 1.0, fragment: 'outline' }],
    })).body;

    const first = await t.fetchJson('POST', '/api/export', {
      from: '2026-07-06', to: '2026-07-06', includeDrafts: true,
    });
    assert.ok(first.body.tim.includes('deposition outline'), 'precondition: the draft is in the file');

    await t.fetchJson('POST', `/api/entries/${e.id}/finalize`, { ack: true });
    const second = await t.fetchJson('POST', '/api/export', { from: '2026-07-06', to: '2026-07-06' });

    const shippedTwice = first.body.tim.includes('deposition outline')
      && second.body.tim.includes('deposition outline');
    const refA = /ref=([\w-]+)/.exec(first.body.tim)[1];
    const refB = /ref=([\w-]+)/.exec(second.body.tim)[1];
    assert.equal(
      shippedTwice && refA !== refB, false,
      'LEAK: 1.0 h is in two .TIM files with two different ref UUIDs — imported twice, billed twice, '
      + 'and nothing in either file lets the billing system spot the duplicate.',
    );
  } finally { await t.close(); }
});

// ---------------------------------------------------------------------------
// LEAK 5 — the oldest unexported time is invisible to the ledger, and the
// export range the ledger derives excludes it.
//
// GET /api/entries is `ORDER BY date DESC, id DESC LIMIT 1000` with no total
// count and no "there is more" signal. public/js/views/search.js applies the
// "Not exported yet" filter CLIENT-side over that truncated list, counts the
// "N not sent" stat from it, and scopeFor() derives from/to from the dates of
// the rows it can see. Everything older than the 1000th most recent entry is
// therefore both uncounted and out of range — and unexported time is, by its
// nature, the old time you forgot.
// ---------------------------------------------------------------------------
test('LEAK: unexported entries past the 1000-row cap are uncounted and out of range', async () => {
  const { t, acme } = await boot();
  try {
    const ins = t.db.prepare(
      `INSERT INTO entries (date, cm_id, narrative, billable, status, total_override, source,
        ever_finalized, finalized_at) VALUES (?, ?, ?, 1, 'finalized', 0.1, 'manual', 1,
        '2026-07-06T12:00:00.000Z')`,
    );
    t.db.transaction(() => {
      for (let i = 0; i < 1200; i++) {
        const d = new Date(2026, 0, 1 + Math.floor(i / 5));
        const ds = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-`
          + `${String(d.getDate()).padStart(2, '0')}`;
        ins.run(ds, acme.id, `Attended to the matter, item ${i}.`);
      }
    })();

    const owed = t.db.prepare(
      "SELECT COUNT(*) c, MIN(date) first FROM entries WHERE status='finalized' AND exported_at IS NULL",
    ).get();

    // what the ledger can see, and what it derives from it (mirrors scopeFor())
    const visible = (await t.fetchJson('GET', '/api/entries')).body;
    const dates = visible.map((e) => e.date).sort();
    const derivedFrom = dates[0];
    const derivedTo = dates[dates.length - 1];
    const unsentOnScreen = visible.filter((e) => e.status === 'finalized' && !e.exported_at).length;

    const r = await t.fetchJson('POST', '/api/export',
      { from: derivedFrom, to: derivedTo });

    assert.equal(
      unsentOnScreen, owed.c,
      `LEAK: ${owed.c} finalized entries have never been exported and the ledger's "not sent" `
      + `counter says ${unsentOnScreen}.`,
    );
    assert.equal(
      r.body.count, owed.c,
      `LEAK: the export the ledger builds covers ${derivedFrom}…${derivedTo} and ships `
      + `${r.body.count} of ${owed.c} owed entries; everything before ${derivedFrom} `
      + `(oldest owed: ${owed.first}) can never reach a file from this screen.`,
    );
  } finally { await t.close(); }
});

// ---------------------------------------------------------------------------
// LEAK 6 — the hours on screen and the hours in the file are rounded
// differently. fmtHours() in public/js/ui.js only fixes the DECIMAL COUNT; it
// never rounds the value to the billing increment. A stored 0.75 h reads
// "0.8" everywhere in the app and leaves as 0.75 in both files. With rounding
// switched off in Settings, secondsToHours() stores two decimals, so every
// odd timer produces one of these.
// ---------------------------------------------------------------------------
test('LEAK: screen hours and file hours differ (0.8 on screen, 0.75 in the file)', async () => {
  const { t, acme } = await boot();
  try {
    const one = await finalized(t, {
      date: '2026-07-06', cm_id: acme.id, narrative: 'Telephone conference with opposing counsel.',
      tasks: [{ task_code: 'Call', duration: 0.75, fragment: 'call' }],
    });
    assert.equal(fmtHours(one.total, 0.1), '0.8', 'precondition: the app shows this entry as 0.8 h');

    const p = await t.fetchJson('GET', '/api/export/preview?from=2026-07-06&to=2026-07-06');
    // the export dialog's own figure: fmtHours(sum of totals)
    const onScreen = fmtHours(p.body.entries.reduce((a, e) => a + e.total, 0), 0.1);
    const r = await t.fetchJson('POST', '/api/export', { from: '2026-07-06', to: '2026-07-06' });
    const inFile = [...csvHoursByEntry(r.body.csv).values()].reduce((a, b) => a + b, 0);

    assert.equal(
      Number(onScreen), inFile,
      `LEAK: the dialog says ${onScreen} h and the file carries ${inFile} h. `
      + 'The lawyer bills what the screen said; the assistant keys what the file said.',
    );
  } finally { await t.close(); }
});

// ---------------------------------------------------------------------------
// LEAK 7 — the server will write a blank billing line. The dialog in
// public/js/views/search.js blocks the two file buttons when an in-scope entry
// has no narrative, and that guard is the ONLY thing between an empty na=
// field and the billing system: POST /api/export writes it and stamps happily.
// ---------------------------------------------------------------------------
test('LEAK: POST /api/export writes a .TIM line with an empty narrative', async () => {
  const { t, acme } = await boot();
  try {
    await t.fetchJson('POST', '/api/entries', {
      date: '2026-07-06', cm_id: acme.id, narrative: '',
      tasks: [{ task_code: '', duration: 0.4, fragment: '' }],
    });
    const r = await t.fetchJson('POST', '/api/export', {
      from: '2026-07-06', to: '2026-07-06', includeDrafts: true,
    });
    assert.equal(
      /\|na=\|/.test(r.body.tim), false,
      'LEAK: a blank billing line reaches the .TIM. Only the client blocks this today, so any '
      + 'other caller — a retried POST, a future surface — writes a blank bill.',
    );
  } finally { await t.close(); }
});

// ===========================================================================
// THE PARTS THAT ARE CORRECT — regression guards. These pass today.
// ===========================================================================

test('OK: the date range includes both ends and excludes the days either side', async () => {
  const { t, acme } = await boot();
  try {
    for (const d of ['2026-07-05', '2026-07-06', '2026-07-07', '2026-07-08']) {
      await finalized(t, {
        date: d, cm_id: acme.id, narrative: `Attended to the matter on ${d}.`,
        tasks: [{ task_code: 'Review', duration: 0.5, fragment: 'work' }],
      });
    }
    const r = await t.fetchJson('GET', '/api/export/preview?from=2026-07-06&to=2026-07-07');
    assert.deepEqual(r.body.entries.map((e) => e.date), ['2026-07-06', '2026-07-07']);
    assert.equal(r.body.count, 2);
  } finally { await t.close(); }
});

test('OK: month boundaries and both DST transitions are exact in America/Los_Angeles', async () => {
  const { t, acme } = await boot();
  try {
    // 2026-03-08 springs forward (23 h day); 2026-11-01 falls back (25 h day)
    const days = ['2026-02-28', '2026-03-01', '2026-03-07', '2026-03-08', '2026-03-09',
      '2026-03-31', '2026-04-01', '2026-10-31', '2026-11-01', '2026-11-02'];
    for (const d of days) {
      await finalized(t, {
        date: d, cm_id: acme.id, narrative: `Attended to the matter on ${d}.`,
        tasks: [{ task_code: 'Review', duration: 0.5, fragment: 'work' }],
      });
    }

    const march = await t.fetchJson('GET', '/api/export/preview?from=2026-03-01&to=2026-03-31');
    assert.deepEqual(march.body.entries.map((e) => e.date),
      ['2026-03-01', '2026-03-07', '2026-03-08', '2026-03-09', '2026-03-31'],
      'a whole month must hold its first and last day and nothing from the months either side');

    for (const d of ['2026-03-08', '2026-11-01']) {
      const one = await t.fetchJson('GET', `/api/export/preview?from=${d}&to=${d}`);
      assert.equal(one.body.count, 1, `${d} (a DST transition day) must export as one ordinary day`);
    }

    // and the .TIM work date must be the day the work happened, not a UTC slip
    const r = await t.fetchJson('POST', '/api/export', { from: '2026-11-01', to: '2026-11-01' });
    assert.match(r.body.tim, /wd=11\/01\/2026 12:00:00 AM/);
    const spring = await t.fetchJson('POST', '/api/export', { from: '2026-03-08', to: '2026-03-08' });
    assert.match(spring.body.tim, /wd=03\/08\/2026 12:00:00 AM/);
  } finally { await t.close(); }
});

test('OK: every exportable entry reaches BOTH files — nothing is silently dropped', async () => {
  const { t, acme, northgate } = await boot();
  try {
    const ids = [];
    for (const cm of [acme, northgate]) {
      for (const d of ['2026-07-06', '2026-07-07']) {
        const e = await finalized(t, {
          date: d, cm_id: cm.id, narrative: `${cm.short_name} attended to on ${d}.`,
          tasks: [{ task_code: 'Review', duration: 0.5, fragment: 'work' }],
        });
        ids.push(e.id);
      }
    }
    const r = await t.fetchJson('POST', '/api/export', { from: '2026-07-06', to: '2026-07-07' });
    const inCsv = [...csvHoursByEntry(r.body.csv).keys()].sort((a, b) => a - b);
    assert.deepEqual(inCsv, ids.slice().sort((a, b) => a - b), 'every stamped id is a CSV row');
    assert.equal(r.body.tim.split('\n').length, ids.length, 'every stamped id is a .TIM line');
    assert.deepEqual(r.body.entry_ids.slice().sort((a, b) => a - b), ids.slice().sort((a, b) => a - b));
  } finally { await t.close(); }
});

test('OK: a matterless entry is never stamped and is reported, not hidden', async () => {
  const { t, acme } = await boot();
  try {
    // matterless entries only arrive from a quick timer, so make one directly
    t.db.prepare(
      `INSERT INTO entries (date, cm_id, narrative, status, total_override, source)
       VALUES ('2026-07-06', NULL, 'Unassigned work.', 'draft', 0.4, 'timer')`,
    ).run();
    await finalized(t, {
      date: '2026-07-06', cm_id: acme.id, narrative: 'Reviewed the lease.',
      tasks: [{ task_code: 'Review', duration: 0.5, fragment: 'work' }],
    });
    const p = await t.fetchJson('GET', '/api/export/preview?from=2026-07-06&to=2026-07-06&includeDrafts=1');
    assert.equal(p.body.unassociated, 1, 'the preview must show the time that cannot leave');
    assert.equal(p.body.entries.length, 2, 'and must not hide it from the screen built to find it');
    assert.equal(p.body.count, 1, 'but it is not part of the file');
    const r = await t.fetchJson('POST', '/api/export',
      { from: '2026-07-06', to: '2026-07-06', includeDrafts: true });
    assert.equal(r.body.entry_ids.length, 1);
    const orphan = t.db.prepare('SELECT exported_at FROM entries WHERE cm_id IS NULL').get();
    assert.equal(orphan.exported_at, null, 'a matterless entry must never be stamped');
  } finally { await t.close(); }
});

test('OK: "Copy as text" stamps nothing', async () => {
  const { t, acme } = await boot();
  try {
    const e = await finalized(t, {
      date: '2026-07-06', cm_id: acme.id, narrative: 'Reviewed the lease.',
      tasks: [{ task_code: 'Review', duration: 0.5, fragment: 'work' }],
    });
    await t.fetchJson('POST', '/api/export',
      { from: '2026-07-06', to: '2026-07-06', markExported: false });
    const after = t.db.prepare('SELECT exported_at FROM entries WHERE id=?').get(e.id);
    assert.equal(after.exported_at, null);
  } finally { await t.close(); }
});
