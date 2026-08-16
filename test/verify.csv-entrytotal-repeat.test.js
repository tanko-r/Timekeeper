// ===========================================================================
// ADVERSARIAL VERIFICATION of the claim:
//
//   "entry_total is repeated on every task row, so a naive column sum
//    multiplies a multi-line entry."
//   (docs/ui/integrity-export.md E8, server/routes/export.js:61-66)
//
// Written by a VERIFIER, independently of the claimant. Every number asserted
// here was read either out of the live export payload or straight out of the
// SQLite rows on a temp database.
//
// VERDICT: REFUTED as a defect. The repetition is real and reproduces exactly
// as described, but it is the documented, deliberate export shape (one row per
// task line; `narrative`, `entry_total` and `entry_id` are per-entry helper
// columns repeated on each of that entry's rows -- README.md "CSV format" and
// docs/superpowers/specs/2026-07-06-timekeeper-design.md assumption #3, which
// CLAUDE.md flags as deliberate and not to be "fixed"). No time is lost,
// dropped, double-counted or mis-stamped by it: the entry is one row in the
// machine-readable .TIM, one paragraph in the text summary, and one entry_id
// group in the CSV.
//
// Every test in this file PASSES today. There is no PROVES: test here because
// nothing was proven. Tests named FACT: record what the export actually does.
// ===========================================================================
process.env.TZ = 'America/Los_Angeles';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';
import { parseCsv } from '../server/lib/csv.js';
import { CSV_HEADER } from '../server/routes/export.js';

const TODAY = '2026-07-06';
const clock = () => new Date('2026-07-06T15:00:00-07:00');

async function withServer(fn) {
  const t = await startTestServer({ clock });
  try { return await fn(t); } finally { await t.close(); }
}

const mkCm = (t, cm_number, short_name) =>
  t.fetchJson('POST', '/api/cms', { cm_number, short_name, billable: 1 }).then((r) => r.body);

async function finalized(t, body) {
  const e = (await t.fetchJson('POST', '/api/entries', body)).body;
  const f = await t.fetchJson('POST', `/api/entries/${e.id}/finalize`, { ack: true });
  assert.equal(f.status, 200, `finalize failed: ${JSON.stringify(f.body)}`);
  return f.body;
}

// The CSV exactly as a spreadsheet reader sees it.
function csv(text) {
  const rows = parseCsv(text);
  const head = rows[0];
  const i = (n) => head.indexOf(n);
  const body = rows.slice(1);
  const num = (r, n) => Number(r[i(n)]) || 0;
  return {
    head,
    body,
    for: (id) => body.filter((r) => String(r[i('entry_id')]) === String(id)),
    // The naive spreadsheet gestures, spelled out.
    sumCol: (n) => Math.round(body.reduce((a, r) => a + num(r, n), 0) * 1e4) / 1e4,
    // The regrouped read: one value per entry_id, then summed.
    sumByEntry: (n) => {
      const m = new Map();
      for (const r of body) m.set(r[i('entry_id')], num(r, n));
      return Math.round([...m.values()].reduce((a, b) => a + b, 0) * 1e4) / 1e4;
    },
    cell: (r, n) => r[i(n)],
  };
}

// .TIM carries hours as seconds in `am=`, one line per ENTRY.
const timLines = (tim) => tim.split('\n').filter(Boolean);
const timSeconds = (tim) => timLines(tim).map((l) => Number(/(?:^|\|)am=(\d+)(?:\||$)/.exec(l)[1]));

const storedEntry = (t, id) => t.db.prepare(
  'SELECT id, cm_id, date, status, total_override, narrative, exported_at FROM entries WHERE id=?').get(id);
const storedLines = (t, id) => t.db.prepare(
  'SELECT task_code, duration FROM entry_tasks WHERE entry_id=? ORDER BY sort_order, id').all(id);

// ===========================================================================
// FACT 1 — the claimed reproduction, verbatim. A 1.5 h entry with two task
// lines really does emit two rows each carrying entry_total 1.5.
// ===========================================================================
test('FACT: a two-line 1.5h entry emits two CSV rows, each carrying the full entry_total', () =>
  withServer(async (t) => {
    const acme = await mkCm(t, '100001-000012', 'Acme lease');
    const e = await finalized(t, {
      date: TODAY,
      cm_id: acme.id,
      tasks: [
        { task_code: 'Review', duration: 1.0, fragment: 'reviewed lease amendment' },
        { task_code: 'Draft', duration: 0.5, fragment: 'drafted email to landlord' },
      ],
    });

    const exp = (await t.fetchJson('POST', '/api/export', { from: TODAY, to: TODAY })).body;
    const c = csv(exp.csv);
    const mine = c.for(e.id);

    assert.equal(mine.length, 2, 'one CSV row per task line');
    assert.deepEqual(mine.map((r) => c.cell(r, 'task')), ['Review', 'Draft']);
    assert.deepEqual(mine.map((r) => c.cell(r, 'duration')), ['1', '0.5']);
    // The claim's exact shape: entry_total 1.5 on BOTH rows.
    assert.deepEqual(mine.map((r) => c.cell(r, 'entry_total')), ['1.5', '1.5'],
      `entry_total repeats on every row of the entry:\n  ${mine.map((r) => r.join(',')).join('\n  ')}`);
    assert.deepEqual(mine.map((r) => c.cell(r, 'entry_id')), [String(e.id), String(e.id)]);

    // And the stored truth behind it: ONE entry, 1.5 h.
    const row = storedEntry(t, e.id);
    const lines = storedLines(t, e.id);
    assert.equal(lines.length, 2);
    assert.equal(Math.round((lines[0].duration + lines[1].duration) * 1e4) / 1e4, 1.5,
      `SQLite entry_tasks: ${JSON.stringify(lines)}`);
    assert.equal(row.status, 'finalized');
  }));

// ===========================================================================
// FACT 2 — the claimed arithmetic, verified: a THREE-line entry triples under
// SUM(entry_total). It also shows the two reads that are correct.
// ===========================================================================
test('FACT: SUM(entry_total) triples a three-line entry; SUM(duration) and per-entry_id regrouping do not', () =>
  withServer(async (t) => {
    const acme = await mkCm(t, '100001-000012', 'Acme lease');
    const e = await finalized(t, {
      date: TODAY,
      cm_id: acme.id,
      tasks: [
        { task_code: 'Review', duration: 0.5, fragment: 'reviewed lease amendment' },
        { task_code: 'Draft', duration: 0.5, fragment: 'drafted email to landlord' },
        { task_code: 'Confer', duration: 0.5, fragment: 'conferred with client' },
      ],
    });

    const exp = (await t.fetchJson('POST', '/api/export', { from: TODAY, to: TODAY })).body;
    const c = csv(exp.csv);
    assert.equal(c.for(e.id).length, 3);

    // The naive gesture the claim describes.
    assert.equal(c.sumCol('entry_total'), 4.5,
      'SUM over the whole entry_total column triple-counts a three-line entry');
    // The two reads that give the truth.
    assert.equal(c.sumCol('duration'), 1.5, 'SUM(duration) is the honest total');
    assert.equal(c.sumByEntry('entry_total'), 1.5,
      'one entry_total per entry_id also gives the honest total');
    assert.equal(timSeconds(exp.tim)[0], 5400, '.TIM bills 1.5 h');
    assert.equal(timLines(exp.tim).length, 1, 'and .TIM emits exactly ONE line for the entry');
  }));

// ===========================================================================
// FACT 3 — the shape is the CONTRACT, not an accident. Every per-entry helper
// column repeats identically across the entry's rows; every per-line column
// varies. That is what "one row per task line" means, and it is what
// README.md and the design spec describe.
// ===========================================================================
test('FACT: every per-entry column repeats across an entry\'s rows, not just entry_total', () =>
  withServer(async (t) => {
    const acme = await mkCm(t, '100001-000012', 'Acme lease');
    const e = await finalized(t, {
      date: TODAY,
      cm_id: acme.id,
      tasks: [
        { task_code: 'Review', duration: 1.0, fragment: 'reviewed lease amendment' },
        { task_code: 'Draft', duration: 0.5, fragment: 'drafted email to landlord' },
      ],
    });
    const exp = (await t.fetchJson('POST', '/api/export', { from: TODAY, to: TODAY })).body;
    const c = csv(exp.csv);
    const mine = c.for(e.id);

    assert.deepEqual(c.head, CSV_HEADER, 'header is the documented one');
    for (const col of ['date', 'cm_number', 'cm_short_name', 'billable', 'narrative', 'entry_total', 'entry_id']) {
      assert.equal(c.cell(mine[0], col), c.cell(mine[1], col),
        `${col} is a per-ENTRY column and repeats by design`);
    }
    for (const col of ['task', 'duration']) {
      assert.notEqual(c.cell(mine[0], col), c.cell(mine[1], col),
        `${col} is the per-LINE column and varies`);
    }
    // narrative repeats too -- a "naive concatenation" of it would duplicate
    // the billing sentence just as a naive SUM duplicates the hours. Neither
    // is a defect in the file; both are the documented denormalised shape.
    assert.ok(c.cell(mine[0], 'narrative').length > 0);
  }));

// ===========================================================================
// FACT 4 — nothing is LOST. The brief's actual rule is "no entry dropped,
// skipped or double-counted; nothing marked exported that did not reach the
// file". Across a mixed day of one-line and multi-line entries on two matters,
// every entry appears exactly once per task line, once in .TIM, once in the
// text summary, and the honest reads all agree with SQLite.
// ===========================================================================
test('FACT: across a mixed day nothing is dropped, and the honest reads agree with SQLite', () =>
  withServer(async (t) => {
    const acme = await mkCm(t, '100001-000012', 'Acme lease');
    const north = await mkCm(t, '200002-000001', 'Northgate merger');

    const a = await finalized(t, {
      date: TODAY, cm_id: acme.id, narrative: 'Reviewed the lease amendment.',
      tasks: [{ task_code: 'Review', duration: 0.7, fragment: 'reviewed lease amendment' }],
    });
    const b = await finalized(t, {
      date: TODAY, cm_id: acme.id,
      tasks: [
        { task_code: 'Draft', duration: 0.4, fragment: 'drafted email to landlord' },
        { task_code: 'Confer', duration: 0.6, fragment: 'conferred with client' },
      ],
    });
    const d = await finalized(t, {
      date: TODAY, cm_id: north.id,
      tasks: [
        { task_code: 'Research', duration: 1.2, fragment: 'researched antitrust filing' },
        { task_code: 'Draft', duration: 0.3, fragment: 'drafted memo outline' },
        { task_code: 'Review', duration: 0.5, fragment: 'reviewed diligence index' },
      ],
    });

    const exp = (await t.fetchJson('POST', '/api/export', { from: TODAY, to: TODAY })).body;
    const c = csv(exp.csv);

    assert.equal(exp.count, 3, 'three entries in the payload');
    assert.equal(c.body.length, 6, '1 + 2 + 3 task lines = 6 CSV rows');
    assert.equal(c.for(a.id).length, 1);
    assert.equal(c.for(b.id).length, 2);
    assert.equal(c.for(d.id).length, 3);

    const dbTotal = t.db.prepare(
      'SELECT ROUND(SUM(duration),4) s FROM entry_tasks WHERE entry_id IN (?,?,?)').get(a.id, b.id, d.id).s;
    assert.equal(dbTotal, 3.7, 'SQLite says 3.7 h for the day');
    assert.equal(c.sumCol('duration'), 3.7, 'SUM(duration) matches SQLite exactly');
    assert.equal(c.sumByEntry('entry_total'), 3.7, 'per-entry_id entry_total matches SQLite exactly');
    // The naive read, for the record.
    assert.equal(c.sumCol('entry_total'), 0.7 + 1.0 + 1.0 + 2.0 + 2.0 + 2.0,
      'and the naive whole-column read inflates to 8.7 -- the claimed mechanism');

    // .TIM: one line per entry, no inflation.
    assert.equal(timLines(exp.tim).length, 3);
    assert.equal(timSeconds(exp.tim).reduce((x, y) => x + y, 0), Math.round(3.7 * 3600),
      '.TIM totals 3.7 h -- the machine-readable file never repeats a total');

    // Text summary: one paragraph per entry.
    assert.equal(exp.text.split('\n\n').length, 3, 'text summary is one block per entry');

    // Every entry actually reached the file and every entry got stamped.
    for (const id of [a.id, b.id, d.id]) {
      assert.ok(c.for(id).length > 0, `entry ${id} reached the CSV`);
      assert.ok(storedEntry(t, id).exported_at, `entry ${id} stamped exported_at`);
    }
  }));

// ===========================================================================
// FACT 5 — no consumer inside this app sums the entry_total column. The
// multiplication exists only in a spreadsheet a human would have to build by
// hand, against a column the README calls a regrouping helper.
// ===========================================================================
test('FACT: the app itself never sums the entry_total column anywhere', async () => {
  const { execFileSync } = await import('node:child_process');
  const root = new URL('..', import.meta.url).pathname;
  const hits = execFileSync('grep', [
    '-rn', 'entry_total', `${root}server`, `${root}public`, `${root}scripts`,
  ], { encoding: 'utf8' }).trim().split('\n');
  assert.deepEqual(hits.map((h) => h.replace(root, '')), [
    'server/routes/export.js:12:  \'narrative\', \'entry_total\', \'entry_id\',',
  ], `the only mention of entry_total in shipped code is the header name:\n${hits.join('\n')}`);
});

// ===========================================================================
// SCOPE — this is a CSV-shape question, not a leak. Confirm no narrative
// crosses a matter boundary anywhere in the multi-matter sequence above.
// ===========================================================================
test('SCOPE: every CSV narrative belongs to the matter on its own row', () =>
  withServer(async (t) => {
    const acme = await mkCm(t, '100001-000012', 'Acme lease');
    const north = await mkCm(t, '200002-000001', 'Northgate merger');
    await finalized(t, {
      date: TODAY, cm_id: acme.id, narrative: 'Reviewed the Acme lease amendment.',
      tasks: [{ task_code: 'Review', duration: 0.7, fragment: 'reviewed lease amendment' }],
    });
    await finalized(t, {
      date: TODAY, cm_id: north.id, narrative: 'Researched the Northgate antitrust filing.',
      tasks: [{ task_code: 'Research', duration: 1.2, fragment: 'researched antitrust filing' }],
    });

    const exp = (await t.fetchJson('POST', '/api/export', { from: TODAY, to: TODAY })).body;
    const c = csv(exp.csv);
    for (const r of c.body) {
      const id = Number(c.cell(r, 'entry_id'));
      const row = t.db.prepare('SELECT cm_id, narrative FROM entries WHERE id=?').get(id);
      const cm = t.db.prepare('SELECT cm_number, short_name FROM cms WHERE id=?').get(row.cm_id);
      assert.equal(c.cell(r, 'cm_number'), cm.cm_number, 'row is keyed to its own matter');
      assert.equal(c.cell(r, 'narrative'), row.narrative,
        'the narrative on the row is the narrative stored on that entry, not another matter\'s');
    }
  }));
