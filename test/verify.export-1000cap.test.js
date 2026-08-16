// ===========================================================================
// ADVERSARIAL VERIFICATION of the claim:
//
//   "Unexported time older than the 1000 most recent entries is uncounted and
//    outside the export range the ledger builds"
//   (server/routes/entries.js:274 `ORDER BY date DESC, id DESC LIMIT 1000`
//    + public/js/views/search.js scopeFor():764-776, the client-side
//    `exported` filter :814-816 and the "N not sent" counter :875-891)
//
// Written from scratch, independently of test/integrity.export.test.js. Every
// number below is produced by driving a REAL server on a temp database and
// then reading the rows back out with better-sqlite3, so nothing depends on
// the route's own reporting.
//
// The entries are created through the app's OWN endpoints (POST /api/entries,
// POST /api/entries/bulk finalize) rather than INSERTed, so the fixture is a
// database the app could actually have produced.
//
// Naming:
//   CONFIRMED — the claimed behaviour, reproduced, with the exact numbers.
//   REFUTED   — a load-bearing part of the claim that is NOT true. These pass
//               today and must keep passing: they are the backstop that keeps
//               the truncation from becoming lost time.
// All tests in this file PASS. None of them is a proving-by-failing test,
// because what the claim describes is a truncated VIEW, not lost time: the
// entries past the cap are never stamped exported, and the app's own
// home-screen alert still counts every one of them and links to a range that
// exports them all.
// ===========================================================================
process.env.TZ = 'America/Los_Angeles';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';
import { parseCsv } from '../server/lib/csv.js';

const NOW = new Date('2026-08-14T15:00:00-07:00');
const clock = () => NOW;
const TODAY = '2026-08-14';

// 200 working days, 6 entries a day = 1200 finalized, never-exported entries.
// 6/day is deliberate: 1000 does not divide by 6, so the cap falls in the
// MIDDLE of a day — the realistic case, and the one the claimant's fixture
// (a clean 5/day) cannot see.
const DAYS = 200;
const PER_DAY = 6;
const TOTAL = DAYS * PER_DAY;
const CAP = 1000;

function dayBack(n) {
  const d = new Date(2026, 7, 14);
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function bootWithBacklog() {
  const t = await startTestServer({ clock });
  const acme = (await t.fetchJson('POST', '/api/cms', {
    cm_number: '100001-000012', short_name: 'Acme lease', billable: 1,
  })).body;
  const ids = [];
  for (let d = 0; d < DAYS; d++) {
    for (let k = 0; k < PER_DAY; k++) {
      const r = await t.fetchJson('POST', '/api/entries', {
        date: dayBack(d), cm_id: acme.id,
        narrative: `Reviewed the lease abstract and revised section ${d}.${k}.`,
        tasks: [{ task_code: 'A103', duration: 0.2, fragment: 'revised section' }],
      });
      assert.ok(r.status < 300, `create failed: ${r.status} ${JSON.stringify(r.body)}`);
      ids.push(r.body.id);
    }
  }
  // Finalize them all through the app's own bulk action, in chunks, exactly as
  // the ledger's selection bar does.
  for (let i = 0; i < ids.length; i += 200) {
    const b = await t.fetchJson('POST', '/api/entries/bulk',
      { ids: ids.slice(i, i + 200), action: 'finalize', ack: true });
    assert.equal(b.status, 200, `bulk finalize failed: ${JSON.stringify(b.body)}`);
    assert.equal(b.body.failed.length, 0, `bulk finalize rejected rows: ${JSON.stringify(b.body.failed)}`);
  }
  const owed = t.db.prepare(
    "SELECT COUNT(*) c, MIN(date) oldest FROM entries WHERE status='finalized' AND exported_at IS NULL AND deleted_at IS NULL",
  ).get();
  assert.equal(owed.c, TOTAL, 'fixture: every seeded entry should be finalized and unexported');
  return { t, acme, owed };
}

// ---------------------------------------------------------------------------
// The two pieces of public/js/views/search.js this claim turns on, transcribed
// verbatim so the test asks the same question the screen does.
//   :814-816  the client-side "Not exported yet" filter
//   :764-776  scopeFor(), which derives the export range from the VISIBLE rows
//   :875-891  the "N not sent" stat
// ---------------------------------------------------------------------------
const clientExportedFilter = (fetched, exported) => (exported === ''
  ? fetched
  : fetched.filter((e) => (exported === 'yes' ? !!e.exported_at : !e.exported_at)));

function scopeFor(filters, list) {
  const dates = list.map((e) => e.date).filter(Boolean).sort();
  const first = dates[0] || TODAY;
  const last = dates[dates.length - 1] || TODAY;
  const attention = filters.status === 'draft' ? 'unfinalized'
    : (filters.status === 'finalized' && filters.exported === 'no') ? 'unexported'
      : (!filters.status && filters.exported === 'no') ? 'either' : null;
  return { from: filters.from || first, to: filters.to || last, attention };
}

const unsentCount = (entries) => entries.filter((e) => e.status === 'finalized' && !e.exported_at).length;

// ---------------------------------------------------------------------------
// 1. CONFIRMED — the cap is real, silent, and the range the default ledger
//    builds starts at the 1000th newest row's date.
// ---------------------------------------------------------------------------
test('CONFIRMED: GET /api/entries truncates at 1000 with no count and no "there is more" signal', async () => {
  const { t, owed } = await bootWithBacklog();
  try {
    const res = await t.fetchJson('GET', '/api/entries?');
    const fetched = res.body;

    assert.ok(Array.isArray(fetched), 'the endpoint answers with a bare array');
    assert.equal(fetched.length, CAP,
      `EVIDENCE: ${owed.c} live entries exist, GET /api/entries returned ${fetched.length}`);
    // A bare array carries no total, no next cursor, no truncation flag: there
    // is nothing in this response a client could show a "showing 1000 of 1200"
    // banner from.
    assert.equal(res.headers.get('x-total-count'), null);
    assert.equal(typeof fetched.total, 'undefined');

    const dbCount = t.db.prepare('SELECT COUNT(*) c FROM entries WHERE deleted_at IS NULL').get().c;
    assert.equal(dbCount, TOTAL, `the database really holds ${TOTAL} rows`);

    // …and the 200 that did not come back are exactly the oldest 200.
    const visibleIds = new Set(fetched.map((e) => e.id));
    const missing = t.db.prepare('SELECT id, date FROM entries WHERE deleted_at IS NULL ORDER BY date DESC, id DESC')
      .all().filter((r) => !visibleIds.has(r.id));
    assert.equal(missing.length, TOTAL - CAP);
    const newestMissing = missing.map((r) => r.date).sort().pop();
    const oldestVisible = fetched.map((e) => e.date).sort()[0];
    assert.ok(newestMissing <= oldestVisible,
      `the hidden rows are the oldest: newest hidden ${newestMissing} <= oldest visible ${oldestVisible}`);
  } finally { await t.close(); }
});

test('CONFIRMED: the ledger\'s "not sent" counter undercounts by exactly the rows past the cap', async () => {
  const { t, owed } = await bootWithBacklog();
  try {
    // The default ledger: EMPTY_FILTERS, so no querystring at all.
    const fetched = (await t.fetchJson('GET', '/api/entries?')).body;
    const onScreen = unsentCount(clientExportedFilter(fetched, ''));

    assert.equal(owed.c, TOTAL);
    assert.equal(onScreen, CAP,
      `EVIDENCE: ${owed.c} finalized entries have never been exported; the ledger's `
      + `"not sent" chip counts ${onScreen} of them`);

    // Clicking that chip (status=finalized, exported=no) does not recover the
    // missing ones: the status filter is applied server-side BEFORE the cap.
    const chipFetched = (await t.fetchJson('GET', '/api/entries?status=finalized')).body;
    const chipCount = unsentCount(clientExportedFilter(chipFetched, 'no'));
    assert.equal(chipCount, CAP,
      `EVIDENCE: applying the chip still shows ${chipCount}, not ${owed.c} — the cap is applied after the filter`);
  } finally { await t.close(); }
});

test('CONFIRMED: the default Export… range starts at the 1000th row\'s date, so the oldest owed time is out of range', async () => {
  const { t, owed } = await bootWithBacklog();
  try {
    const fetched = (await t.fetchJson('GET', '/api/entries?')).body;
    const entries = clientExportedFilter(fetched, '');           // default: no exported filter
    const scope = scopeFor({ q: '', cm: null, from: '', to: '', task: '', billable: '', status: '', exported: '' }, entries);

    assert.equal(scope.attention, null, 'the default ledger sends no attention rule');
    assert.ok(scope.from > owed.oldest,
      `EVIDENCE: the range the header's Export… builds is ${scope.from}…${scope.to}; `
      + `the oldest owed entry is dated ${owed.oldest}, before the range starts`);
    assert.equal(scope.to, TODAY);

    // Drive the real download, exactly as ExportDialog.run('csv') does.
    const r = await t.fetchJson('POST', '/api/export',
      { from: scope.from, to: scope.to, includeDrafts: false, attention: scope.attention });
    assert.equal(r.status, 200);

    // Read the DATABASE, not the response.
    const after = t.db.prepare(
      "SELECT COUNT(*) c, MIN(date) oldest FROM entries WHERE status='finalized' AND exported_at IS NULL AND deleted_at IS NULL",
    ).get();
    assert.ok(after.c > 0,
      `EVIDENCE: after "export everything" from the default ledger, ${after.c} finalized entries `
      + `(oldest ${after.oldest}) are still unexported`);
    assert.equal(after.c, TOTAL - r.body.count,
      'every entry that was not written is still unexported — none was quietly stamped');

    // The boundary day is only PARTLY visible (6 entries/day, cap 1000), and a
    // date range cannot slice a day: the file therefore holds MORE than the
    // 1000 rows on screen. The claim's "ships 1000" is fixture-specific.
    assert.ok(r.body.count > CAP,
      `EVIDENCE: the file holds ${r.body.count} rows, not the ${CAP} the ledger showed — `
      + 'a date range takes whole days');
  } finally { await t.close(); }
});

// ---------------------------------------------------------------------------
// 2. REFUTED — the load-bearing half of the claim. "Uncounted and out of
//    range" is true of the LEDGER; it is not true of the app.
// ---------------------------------------------------------------------------
test('REFUTED: the dashboard\'s unexported alert is uncapped and unwindowed — it counts all 1200', async () => {
  const { t, owed } = await bootWithBacklog();
  try {
    const dash = (await t.fetchJson('GET', '/api/dashboard')).body;
    const bucket = dash.alerts.unexported;

    assert.equal(bucket.count, TOTAL,
      `EVIDENCE: the home screen says "${bucket.count} finalized, not yet exported" — the true number`);
    assert.equal(bucket.oldest, owed.oldest,
      'and it names the true oldest date, 200 days back');
    assert.ok(bucket.hours > 0, 'with the hours attached');

    // ATTENTION_WINDOW_DAYS (90) bounds the unfinalized and reverted buckets
    // ONLY. The claim's "the dashboard is no backstop: ATTENTION_WINDOW_DAYS
    // is 90" does not apply to this bucket: the oldest entry here is 199 days
    // old and it is counted.
    const ageDays = Math.round((new Date(TODAY) - new Date(bucket.oldest)) / 86400000);
    assert.ok(ageDays > 90,
      `EVIDENCE: the oldest counted entry is ${ageDays} days old, well past the 90-day window`);
  } finally { await t.close(); }
});

test('REFUTED: the dashboard\'s own Review link builds a range that exports every one of the 1200', async () => {
  const { t, owed } = await bootWithBacklog();
  try {
    // public/js/views/dashboard.js:116 — attentionLink('unexported', b) is
    // `#/export/unexported/${b.oldest}`. search.js turns that into chips:
    // FILTER_CHIPS.unexported = {status:'finalized', exported:'no'} plus
    // from = <oldest>, to = today.
    const dash = (await t.fetchJson('GET', '/api/dashboard')).body;
    const oldest = dash.alerts.unexported.oldest;
    const filters = { q: '', cm: null, from: oldest, to: TODAY, task: '', billable: '', status: 'finalized', exported: 'no' };

    const fetched = (await t.fetchJson('GET', `/api/entries?from=${oldest}&to=${TODAY}&status=finalized`)).body;
    const entries = clientExportedFilter(fetched, 'no');
    assert.equal(entries.length, CAP, 'the ledger still only SHOWS 1000 rows on this route');

    const scope = scopeFor(filters, entries);
    assert.equal(scope.from, owed.oldest, 'but the range came from the link, not from the visible rows');
    assert.equal(scope.attention, 'unexported');

    const r = await t.fetchJson('POST', '/api/export',
      { from: scope.from, to: scope.to, includeDrafts: false, attention: scope.attention });
    assert.equal(r.status, 200);
    assert.equal(r.body.count, TOTAL,
      `EVIDENCE: the file the dashboard's own link builds holds all ${TOTAL} owed entries`);

    const after = t.db.prepare(
      "SELECT COUNT(*) c FROM entries WHERE status='finalized' AND exported_at IS NULL AND deleted_at IS NULL",
    ).get().c;
    assert.equal(after, 0, 'and the database has nothing owed left');

    // Every stamped row really reached the file: entry_id column of the CSV.
    const rows = parseCsv(r.body.csv);
    const iId = rows[0].indexOf('entry_id');
    const inFile = new Set(rows.slice(1).map((x) => Number(x[iId])));
    const stamped = t.db.prepare('SELECT id FROM entries WHERE exported_at IS NOT NULL').all().map((x) => x.id);
    assert.equal(stamped.length, TOTAL);
    for (const id of stamped) assert.ok(inFile.has(id), `entry ${id} was stamped but is not in the CSV`);
  } finally { await t.close(); }
});

test('REFUTED: nothing is lost — the truncated export stamps only what it wrote, and the rest re-alerts', async () => {
  const { t } = await bootWithBacklog();
  try {
    const fetched = (await t.fetchJson('GET', '/api/entries?')).body;
    const scope = scopeFor({ from: '', to: '', status: '', exported: '' }, fetched);
    const r = await t.fetchJson('POST', '/api/export', { from: scope.from, to: scope.to, includeDrafts: false });

    // (a) every stamped row is in the CSV — no phantom stamp.
    const rows = parseCsv(r.body.csv);
    const iId = rows[0].indexOf('entry_id');
    const inFile = new Set(rows.slice(1).map((x) => Number(x[iId])));
    const stamped = t.db.prepare('SELECT id FROM entries WHERE exported_at IS NOT NULL').all().map((x) => x.id);
    assert.equal(stamped.length, r.body.count);
    for (const id of stamped) assert.ok(inFile.has(id), `entry ${id} stamped but absent from the file`);

    // (b) the ones left behind still carry their hours and their narrative —
    //     nothing was dropped, deleted, blanked or double-counted.
    const left = t.db.prepare(
      "SELECT id, date, narrative, exported_at FROM entries WHERE status='finalized' AND exported_at IS NULL AND deleted_at IS NULL ORDER BY date",
    ).all();
    assert.ok(left.length > 0);
    for (const row of left) {
      assert.ok(row.narrative.length > 0, `entry ${row.id} kept its narrative`);
      assert.equal(row.exported_at, null);
      const hrs = t.db.prepare('SELECT COALESCE(SUM(duration),0) h FROM entry_tasks WHERE entry_id=?').get(row.id).h;
      assert.equal(hrs, 0.2, `entry ${row.id} kept its 0.2h`);
    }

    // (c) and the home screen goes on saying so, at the exact leftover count.
    const dash = (await t.fetchJson('GET', '/api/dashboard')).body;
    assert.equal(dash.alerts.unexported.count, left.length,
      `EVIDENCE: after the truncated export the dashboard still reports ${left.length} owed`);
    assert.equal(dash.alerts.unexported.oldest, left[0].date);
  } finally { await t.close(); }
});

test('REFUTED: a From date typed into the ledger\'s own filters exports the full backlog too', async () => {
  const { t, owed } = await bootWithBacklog();
  try {
    // Variation: the user never touches the dashboard, just sets From in the
    // ledger's Filters panel. The visible list is STILL capped at 1000 (the
    // filter is applied before the LIMIT), but scopeFor prefers filters.from.
    const from = '2020-01-01';
    const fetched = (await t.fetchJson('GET', `/api/entries?from=${from}`)).body;
    assert.equal(fetched.length, CAP, 'still only 1000 rows on screen');

    const scope = scopeFor({ from, to: '', status: '', exported: '' }, fetched);
    assert.equal(scope.from, from, 'the typed From wins over the visible rows');

    const r = await t.fetchJson('POST', '/api/export', { from: scope.from, to: scope.to, includeDrafts: false });
    assert.equal(r.body.count, TOTAL,
      `EVIDENCE: ${r.body.count} of ${owed.c} owed entries reach the file when From is typed`);
    assert.equal(
      t.db.prepare("SELECT COUNT(*) c FROM entries WHERE status='finalized' AND exported_at IS NULL").get().c, 0);
  } finally { await t.close(); }
});
