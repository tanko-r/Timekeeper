// ===========================================================================
// ADVERSARIAL VERIFICATION — "screen hours vs file hours" (claimed LEAK 6).
//
// THIS FILE IS EXPECTED TO FAIL. Every test named "PROVES" below asserts the
// behaviour the brief requires and fails against the code on
// ui-overhaul-2026-08. Do not relax the assertions to make it pass.
//
// The original claim reproduced only by POSTing an off-increment duration
// straight at the API — which proves the arithmetic but not that a lawyer can
// reach it. These tests reach the same divergence through TWO paths a lawyer
// actually walks, with the app's DEFAULT settings for the first one:
//
//   1. Quick capture ("call sam re lease 45m"). server/lib/quickcapture.js
//      parseDuration() converts 45m to 0.75 h, and nothing between the parser
//      and the row in `entry_tasks` applies the rounding setting. Every hours
//      figure the lawyer sees for that entry — the qc chip, the "Filed ✓ —
//      0.8h" toast, the ledger row, the day total, the export dialog's
//      "N entries · X h" — goes through fmtHours() in public/js/ui.js, which
//      only fixes the DECIMAL COUNT and never snaps to the increment.
//
//   2. Settings → Rounding → "No rounding (raw hours)" (one dropdown pick,
//      public/js/views/settings.js). secondsToHours() then stores two
//      decimals, so any timer that is not an exact tenth diverges.
//
// The control test at the bottom shows the divergence is specific: with the
// default rounding ON, a timer stop agrees to the cent.
//
// Every assertion is checked against the DATABASE ROW as well as the API
// payload, so nothing here rests on a re-implementation of the server.
// ===========================================================================
process.env.TZ = 'America/Los_Angeles';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';
import { parseCsv } from '../server/lib/csv.js';

// VERBATIM copy of public/js/ui.js fmtHours (checked byte-for-byte against the
// real module in the puppeteer run recorded in the findings). This is what
// every hours figure in the app is rendered through.
function fmtHours(h, increment = 0.1) {
  const s = String(increment);
  const decimals = s.includes('.') ? Math.max(1, s.length - s.indexOf('.') - 1) : 1;
  return Number(h || 0).toFixed(decimals);
}

const timSeconds = (line) => Number(/(?:^|\|)am=(\d+)(?:\||$)/.exec(line)[1]);

function csvDurations(csv) {
  const rows = parseCsv(csv);
  const head = rows[0];
  const iDur = head.indexOf('duration');
  const iTot = head.indexOf('entry_total');
  return rows.slice(1).map((r) => ({ duration: Number(r[iDur]), entry_total: Number(r[iTot]) }));
}

async function boot(clock) {
  const t = await startTestServer(clock ? { clock } : {});
  const acme = (await t.fetchJson('POST', '/api/cms', {
    cm_number: '100001-000012', short_name: 'Acme lease', billable: 1,
  })).body;
  return { t, acme };
}

// ---------------------------------------------------------------------------
// PATH 1 — quick capture, DEFAULT settings, nothing switched off.
// ---------------------------------------------------------------------------
test('PROVES: a "45m" quick capture is shown as 0.8 h and filed/exported as 0.75 h', async () => {
  const { t, acme } = await boot();
  try {
    // Settings are untouched: this is the shipped default.
    const settings = (await t.fetchJson('GET', '/api/settings')).body;
    assert.deepEqual(settings.rounding, { enabled: true, increment: 0.1, mode: 'up' },
      'precondition: default rounding is on, tenths, round up');
    const increment = settings.rounding.increment;

    // The lawyer types one line into quick capture (public/js/components/quickcapture.js).
    const parsed = (await t.fetchJson('POST', '/api/quickcapture', {
      line: 'call sam re acme lease 45m',
    })).body;
    assert.equal(parsed.hours, 0.75, 'precondition: the parser turns "45m" into 0.75 h');
    assert.equal(parsed.task_code, 'Call/Conference');

    // …and presses Enter. This is quickcapture.js file(), field for field.
    const e = (await t.fetchJson('POST', '/api/entries', {
      date: '2026-07-06', cm_id: acme.id, narrative: parsed.narrative,
      source_cm_id: acme.id,
      tasks: [{ task_code: parsed.task_code, duration: parsed.hours, fragment: '' }],
    })).body;

    // WHAT THE DATABASE ACTUALLY HOLDS.
    const stored = t.db.prepare('SELECT duration FROM entry_tasks WHERE entry_id=?').get(e.id);
    assert.equal(stored.duration, 0.75, 'the row in entry_tasks holds 0.75');

    // WHAT THE LAWYER IS TOLD. Toast: `Filed ✓ — ${fmtHours(hours)}h`.
    // Ledger row / Today row / day total: fmtHours(e.total, increment).
    const toast = fmtHours(parsed.hours);
    const ledgerRow = fmtHours(e.total, increment);
    assert.equal(toast, '0.8', 'precondition: quick capture says "Filed ✓ — 0.8h"');
    assert.equal(ledgerRow, '0.8', 'precondition: every hours figure in the app says 0.8');

    await t.fetchJson('POST', `/api/entries/${e.id}/finalize`, { ack: true });

    // The export dialog's own confirmation figure, computed exactly as
    // public/js/views/search.js ExportDialog does it.
    const preview = (await t.fetchJson('GET',
      '/api/export/preview?from=2026-07-06&to=2026-07-06')).body;
    const dialogHours = fmtHours(
      preview.entries.filter((x) => x.cm).reduce((a, x) => a + (Number(x.total) || 0), 0),
      increment,
    );

    // WHAT THE FILES CARRY.
    const r = (await t.fetchJson('POST', '/api/export',
      { from: '2026-07-06', to: '2026-07-06' })).body;
    const csv = csvDurations(r.csv);
    const timAm = timSeconds(r.tim);

    assert.equal(csv.length, 1);
    assert.equal(csv[0].duration, 0.75, 'the CSV duration column carries 0.75');
    assert.equal(timAm, 2700, 'the .TIM carries am=2700 seconds = 0.75 h');

    assert.equal(
      Number(dialogHours), csv[0].duration,
      `PROVES: the export dialog confirms "${dialogHours} h" and the CSV it writes carries `
      + `${csv[0].duration} h (.TIM am=${timAm}s). The lawyer approved 0.8; the assistant keys 0.75. `
      + 'Reached with default settings by typing one quick-capture line.',
    );
  } finally { await t.close(); }
});

test('PROVES: a day of quick-capture entries shows a day total the CSV cannot add up to', async () => {
  const { t, acme } = await boot();
  try {
    const increment = 0.1;
    // Four ordinary shorthand lines, all through the documented grammar.
    const lines = [
      'call sam re acme lease 45m',   // 0.75
      'email sam re acme lease 20m',  // 0.33
      'review acme lease 1.25',       // 1.25
      'draft acme lease 25m',         // 0.42
    ];
    // NOTE: the day figure is ONE fmtHours over the raw sum, so the aggregate
    // error is bounded at half a display increment (0.05 h) and can land on
    // zero by luck — 45m+20m+1.25+10m sums to exactly 2.50 and agrees. The set
    // below sums to 2.75 and does not. Both facts belong in the record.
    const totals = [];
    for (const line of lines) {
      const p = (await t.fetchJson('POST', '/api/quickcapture', { line })).body;
      assert.ok(p.hours > 0, `precondition: "${line}" parses an hours figure`);
      const e = (await t.fetchJson('POST', '/api/entries', {
        date: '2026-07-06', cm_id: acme.id, narrative: p.narrative || 'Attended to the lease.',
        source_cm_id: acme.id,
        tasks: [{ task_code: p.task_code || 'Review', duration: p.hours, fragment: '' }],
      })).body;
      await t.fetchJson('POST', `/api/entries/${e.id}/finalize`, { ack: true });
      totals.push(e.total);
    }

    // The day header / ledger day-break figure: one fmtHours over the raw sum.
    const dayOnScreen = fmtHours(totals.reduce((a, b) => a + b, 0), increment);

    const r = (await t.fetchJson('POST', '/api/export',
      { from: '2026-07-06', to: '2026-07-06' })).body;
    const inCsv = csvDurations(r.csv).reduce((a, x) => a + x.duration, 0);
    const inTim = r.tim.split('\n').reduce((a, l) => a + timSeconds(l), 0) / 3600;

    assert.equal(
      Number(dayOnScreen), Math.round(inCsv * 10000) / 10000,
      `PROVES: the day reads ${dayOnScreen} h on screen; the CSV adds to ${inCsv} h and the .TIM to `
      + `${inTim} h. Four ordinary shorthand lines, default settings.`,
    );
  } finally { await t.close(); }
});

// ---------------------------------------------------------------------------
// PATH 2 — Settings → Rounding → "No rounding (raw hours)". One dropdown pick,
// then every timer that is not an exact tenth diverges.
// ---------------------------------------------------------------------------
test('PROVES: with rounding off, a 45-minute timer reads 0.8 h and exports 0.75 h', async () => {
  let nowMs = new Date('2026-07-06T09:00:00-07:00').getTime();
  const t = await startTestServer({ clock: () => new Date(nowMs) });
  try {
    const acme = (await t.fetchJson('POST', '/api/cms', {
      cm_number: '100001-000012', short_name: 'Acme lease', billable: 1,
    })).body;
    // Exactly what public/js/views/settings.js sends for "No rounding (raw hours)".
    const s = (await t.fetchJson('PATCH', '/api/settings', { rounding: { enabled: false } })).body;
    assert.equal(s.rounding.enabled, false);
    const increment = s.rounding.increment; // 0.1 — the increment field is untouched

    const timer = (await t.fetchJson('POST', '/api/timers',
      { name: 'Acme lease', cm_id: acme.id })).body;
    await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
    nowMs += 45 * 60 * 1000; // 45 minutes on the clock
    const stopped = (await t.fetchJson('POST', `/api/timers/${timer.id}/stop`)).body;
    const id = stopped.entry.id;

    // THE DATABASE ROW.
    const row = t.db.prepare('SELECT total_override FROM entries WHERE id=?').get(id);
    assert.equal(row.total_override, 0.75, 'the server banked 0.75 h');

    // THE SCREEN — the Today row, the run-bar day total, the stop toast.
    assert.equal(fmtHours(stopped.entry.total, increment), '0.8',
      'precondition: every hours figure for this timer reads 0.8');

    await t.fetchJson('PATCH', `/api/entries/${id}`,
      { narrative: 'Telephone conference with opposing counsel regarding the lease amendment.' });
    await t.fetchJson('POST', `/api/entries/${id}/finalize`, { ack: true });

    const r = (await t.fetchJson('POST', '/api/export',
      { from: '2026-07-06', to: '2026-07-06' })).body;
    const csv = csvDurations(r.csv);

    assert.equal(
      csv[0].entry_total, Number(fmtHours(stopped.entry.total, increment)),
      `PROVES: the app recorded and displayed 0.8 h for a 45-minute timer and wrote `
      + `${csv[0].entry_total} h to the CSV (.TIM am=${timSeconds(r.tim)}s). `
      + 'Reached by one dropdown pick in Settings.',
    );
  } finally { await t.close(); }
});

// ---------------------------------------------------------------------------
// CONTROL — the divergence is specific, not universal. With the shipped
// default rounding ON, the same 45-minute timer agrees everywhere. This test
// PASSES today and must keep passing after any fix.
// ---------------------------------------------------------------------------
test('OK (control): with default rounding on, a 45-minute timer agrees screen-to-file', async () => {
  let nowMs = new Date('2026-07-06T09:00:00-07:00').getTime();
  const t = await startTestServer({ clock: () => new Date(nowMs) });
  try {
    const acme = (await t.fetchJson('POST', '/api/cms', {
      cm_number: '100001-000012', short_name: 'Acme lease', billable: 1,
    })).body;
    const timer = (await t.fetchJson('POST', '/api/timers',
      { name: 'Acme lease', cm_id: acme.id })).body;
    await t.fetchJson('POST', `/api/timers/${timer.id}/start`);
    nowMs += 45 * 60 * 1000;
    const stopped = (await t.fetchJson('POST', `/api/timers/${timer.id}/stop`)).body;
    const id = stopped.entry.id;

    assert.equal(t.db.prepare('SELECT total_override FROM entries WHERE id=?').get(id).total_override,
      0.8, 'rounding up to the tenth stores 0.8');
    assert.equal(fmtHours(stopped.entry.total, 0.1), '0.8');

    await t.fetchJson('PATCH', `/api/entries/${id}`,
      { narrative: 'Telephone conference with opposing counsel regarding the lease amendment.' });
    await t.fetchJson('POST', `/api/entries/${id}/finalize`, { ack: true });
    const r = (await t.fetchJson('POST', '/api/export',
      { from: '2026-07-06', to: '2026-07-06' })).body;
    assert.equal(csvDurations(r.csv)[0].entry_total, 0.8, 'the CSV agrees with the screen');
    assert.equal(timSeconds(r.tim), 2880, 'the .TIM agrees with the screen (0.8 h = 2880 s)');
  } finally { await t.close(); }
});
