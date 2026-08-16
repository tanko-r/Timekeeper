// ===========================================================================
// ADVERSARIAL VERIFICATION — "the ledger's filters and row selection do not
// scope the file, but the file's stamps hit every entry in the range".
//
// ONE test in this file is named "PROVES" and is EXPECTED TO FAIL. It is a
// proving test for the confirmed half of the claim. Do not relax it.
//
// The remaining tests PASS today and are the refutation half: they pin down
// what the claim gets WRONG, so a later "fix" cannot quietly regress the
// disclosure and the recovery paths that already exist. If one of them starts
// failing, the defect got worse.
//
// Every request body below is the LITERAL body Chromium was observed sending
// from the real ledger UI, captured with page.on('request'):
//
//   filter-to-Acme path : {"from":"2026-07-06","to":"2026-07-06",
//                          "includeDrafts":false,"attention":null}
//   two-row-selection   : {"from":"2026-07-06","to":"2026-07-20",
//                          "includeDrafts":false,"attention":null}
//
// Neither carries a cm_id and neither carries ids: public/js/views/search.js
// run() sends `{ from, to, includeDrafts, attention }` and nothing else, and
// server/routes/export.js:91-107 reads nothing else.
// ===========================================================================
process.env.TZ = 'America/Los_Angeles';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';
import { parseCsv } from '../server/lib/csv.js';

const clock = () => new Date('2026-07-21T15:00:00-07:00');

async function boot() {
  const t = await startTestServer({ clock });
  const mk = async (cm_number, short_name) => (await t.fetchJson('POST', '/api/cms', {
    cm_number, short_name, billable: 1,
  })).body;
  return { t, acme: await mk('100001-000012', 'Acme lease'), northgate: await mk('200002-000001', 'Northgate merger') };
}

async function finalized(t, body) {
  const e = (await t.fetchJson('POST', '/api/entries', body)).body;
  const f = await t.fetchJson('POST', `/api/entries/${e.id}/finalize`, { ack: true });
  assert.equal(f.status, 200, `finalize failed: ${JSON.stringify(f.body)}`);
  return f.body;
}

// Seed: three Acme and three Northgate entries on one day.
async function seedTwoClients(t, acme, northgate, date = '2026-07-06') {
  const ids = { acme: [], northgate: [] };
  for (const [key, cm] of [['acme', acme], ['northgate', northgate]]) {
    for (let i = 0; i < 3; i++) {
      const e = await finalized(t, {
        date, cm_id: cm.id,
        narrative: `${cm.short_name}: reviewed the draft agreement and noted item ${i}.`,
        tasks: [{ task_code: 'Review', duration: 0.4, fragment: 'work' }],
      });
      ids[key].push(e.id);
    }
  }
  return ids;
}

// ---------------------------------------------------------------------------
// CONFIRMED HALF — EXPECTED TO FAIL.
//
// The ledger's client/matter chip narrows the LIST but not the FILE, and the
// export stamps every finalized entry in the derived date range, including the
// other client's. Verified end to end in headless Chromium against the real
// ledger: with the "Acme lease" chip applied the ledger head read
// "Entries 1.2h · 3 entries · matching these filters", the POST above went out,
// the response carried count=6 / entry_ids=[1,2,3,4,5,6], and all three
// Northgate rows came back with exported_at=2026-07-06T22:00:00.000Z.
// ---------------------------------------------------------------------------
test('PROVES: a ledger chipped to one matter stamps a second client exported', async () => {
  const { t, acme, northgate } = await boot();
  try {
    const ids = await seedTwoClients(t, acme, northgate);

    // What the chipped ledger shows.
    const shown = (await t.fetchJson('GET', `/api/entries?cm_id=${acme.id}`)).body;
    assert.equal(shown.length, 3, 'precondition: the chipped ledger lists 3 rows');

    // The literal body the browser sends when Export… → Download CSV is used
    // from that same chipped ledger.
    const r = await t.fetchJson('POST', '/api/export', {
      from: '2026-07-06', to: '2026-07-06', includeDrafts: false, attention: null,
    });
    assert.equal(r.status, 200);

    const stampedOther = t.db.prepare(
      'SELECT COUNT(*) c FROM entries WHERE cm_id=? AND exported_at IS NOT NULL',
    ).get(northgate.id).c;

    assert.equal(
      stampedOther, 0,
      `PROVES: the ledger was chipped to ${acme.short_name} and listed ${shown.length} rows; the export `
      + `wrote ${r.body.count} and stamped ${stampedOther} of ${ids.northgate.length} ${northgate.short_name} `
      + 'entries exported. Those rows now fail every "not exported yet" backstop even though the owner '
      + 'never pointed at them. POST /api/export (server/routes/export.js:91-107) takes no cm_id and no '
      + 'ids, and scopeFor() (public/js/views/search.js:764) sends neither.',
    );
  } finally { await t.close(); }
});

// ---------------------------------------------------------------------------
// REFUTATION 1 — no time and no narrative is LOST, and nothing is stamped that
// did not reach the file. This is the brief's actual export rule, and it holds.
// Every id the server stamps appears in the CSV it returns in the same call.
// ---------------------------------------------------------------------------
test('REFUTES "marked exported without reaching the file": every stamped id is in the CSV', async () => {
  const { t, acme, northgate } = await boot();
  try {
    await seedTwoClients(t, acme, northgate);
    const r = await t.fetchJson('POST', '/api/export', {
      from: '2026-07-06', to: '2026-07-06', includeDrafts: false, attention: null,
    });

    const rows = parseCsv(r.body.csv);
    const iId = rows[0].indexOf('entry_id');
    const inFile = new Set(rows.slice(1).map((x) => Number(x[iId])));

    const stamped = t.db.prepare(
      'SELECT id FROM entries WHERE exported_at IS NOT NULL ORDER BY id',
    ).all().map((x) => x.id);

    assert.ok(stamped.length > 0, 'precondition: something was stamped');
    for (const id of stamped) {
      assert.ok(inFile.has(id), `entry ${id} was stamped exported but is absent from the CSV`);
    }
    assert.equal(stamped.length, inFile.size,
      'the stamped set and the file set are the same set — the file is wider than the ledger, not different from it');
  } finally { await t.close(); }
});

// ---------------------------------------------------------------------------
// REFUTATION 2 — the widening is NOT a narrative crossing a matter boundary.
// Every narrative in the file sits on the row carrying its own matter's
// cm_number. This is the rule the brief calls non-negotiable, and the widening
// does not touch it.
// ---------------------------------------------------------------------------
test('REFUTES "a narrative crosses a matter": every CSV narrative sits on its own matter', async () => {
  const { t, acme, northgate } = await boot();
  try {
    await seedTwoClients(t, acme, northgate);
    const r = await t.fetchJson('POST', '/api/export', {
      from: '2026-07-06', to: '2026-07-06', includeDrafts: false, attention: null,
    });

    const rows = parseCsv(r.body.csv);
    const h = rows[0];
    const [iCm, iNarr, iId] = ['cm_number', 'narrative', 'entry_id'].map((k) => h.indexOf(k));

    for (const row of rows.slice(1)) {
      const stored = t.db.prepare(
        'SELECT e.narrative, m.cm_number FROM entries e JOIN matters m ON m.id=e.cm_id WHERE e.id=?',
      ).get(Number(row[iId]));
      assert.equal(row[iNarr], stored.narrative,
        `CSV narrative for entry ${row[iId]} is not that entry's own narrative`);
      assert.equal(row[iCm], stored.cm_number,
        `CSV row for entry ${row[iId]} is filed under the wrong matter`);
    }
    // And the .TIM built from the same call agrees.
    assert.ok(r.body.tim.includes('100001-000012') && r.body.tim.includes('200002-000001'),
      'both matters are present in the .TIM, each under its own number');
  } finally { await t.close(); }
});

// ---------------------------------------------------------------------------
// REFUTATION 3 — "unfindable" is false. The over-stamped rows are one filter
// away in the same ledger, and the stamp is reversible from the same selection
// bar that fired the export (Unlock, then Finalize, both bulk actions).
// finalizeOne() clears exported_at on the way back up (server/routes/
// entries.js:558), which is what makes the recovery real rather than notional.
// ---------------------------------------------------------------------------
test('REFUTES "permanently stamped and unfindable": the stamp is reversible from the ledger', async () => {
  const { t, acme, northgate } = await boot();
  try {
    const ids = await seedTwoClients(t, acme, northgate);
    await t.fetchJson('POST', '/api/export', {
      from: '2026-07-06', to: '2026-07-06', includeDrafts: false, attention: null,
    });

    // Findable: the ledger's "Already exported" chip filters on exported_at,
    // which /api/entries returns on every row.
    const listed = (await t.fetchJson('GET', `/api/entries?cm_id=${northgate.id}`)).body;
    assert.equal(listed.length, 3);
    assert.ok(listed.every((e) => !!e.exported_at),
      'the ledger can see the stamp on every over-stamped row');

    // Reversible: the same bulk actions the selection bar offers.
    const unlock = await t.fetchJson('POST', '/api/entries/bulk',
      { action: 'unlock', ids: ids.northgate });
    assert.equal(unlock.status, 200, `bulk unlock failed: ${JSON.stringify(unlock.body)}`);
    const refin = await t.fetchJson('POST', '/api/entries/bulk',
      { action: 'finalize', ids: ids.northgate, ack: true });
    assert.equal(refin.status, 200, `bulk finalize failed: ${JSON.stringify(refin.body)}`);

    const stillStamped = t.db.prepare(
      'SELECT COUNT(*) c FROM entries WHERE cm_id=? AND exported_at IS NOT NULL',
    ).get(northgate.id).c;
    assert.equal(stillStamped, 0,
      'unlock + finalize clears exported_at, so the over-stamped time returns to the "not sent" backstop');
  } finally { await t.close(); }
});

// ---------------------------------------------------------------------------
// REFUTATION 4 — the export dialog does not show the ledger's narrowed count.
// It reads /api/export/preview with the SAME arguments as the download, so the
// number under the download button is the TRUE number of entries the file will
// hold. The claim's "screen shows 3, file holds 6" is true of the list behind
// the dialog and false of the dialog the download is fired from.
//
// Observed in Chromium: .export-scope-count read "6 entries · 2.4 h" while the
// ledger head behind it read "3 entries · matching these filters".
// ---------------------------------------------------------------------------
test('REFUTES "the screen says 3": preview and download agree, so the dialog says 6', async () => {
  const { t, acme, northgate } = await boot();
  try {
    await seedTwoClients(t, acme, northgate);

    const preview = await t.fetchJson(
      'GET', '/api/export/preview?from=2026-07-06&to=2026-07-06&includeDrafts=0');
    const post = await t.fetchJson('POST', '/api/export', {
      from: '2026-07-06', to: '2026-07-06', includeDrafts: false, attention: null,
    });

    assert.equal(preview.body.count, 6,
      'the dialog is told the true count, not the ledger\'s narrowed one');
    assert.equal(preview.body.count, post.body.count,
      'the count the dialog prints and the count the file holds are produced by the same builder');
    assert.deepEqual(preview.body.entry_ids, post.body.entry_ids,
      'the previewed set and the written set are identical — the dialog cannot understate the file');
  } finally { await t.close(); }
});

// ---------------------------------------------------------------------------
// REFUTATION 5 — the same two facts for the row-selection path. Two rows 14
// days apart do widen to the whole span (that is the failing PROVES case above,
// in its second form), but the dialog is told the widened count before the
// download exists, and states it.
//
// Observed in Chromium with rows 1 and 4 ticked:
//   selection bar   "2 selected"
//   dialog count    "4 entries · 2.0 h"
//   dialog note     "You picked 2 entries; a file is written from a date range,
//                    so this one covers 4 — every finalized entry between those
//                    two dates."
// ---------------------------------------------------------------------------
test('REFUTES "the selection widens silently": the widened count is what the dialog is given', async () => {
  const { t, acme, northgate } = await boot();
  try {
    for (const [d, cm] of [
      ['2026-07-06', acme], ['2026-07-10', northgate], ['2026-07-14', northgate], ['2026-07-20', acme],
    ]) {
      await finalized(t, {
        date: d, cm_id: cm.id, narrative: `${cm.short_name}: attended to the matter on ${d}.`,
        tasks: [{ task_code: 'Review', duration: 0.5, fragment: 'work' }],
      });
    }
    // scopeFor(..., { ids, useListDates: true }) derives from/to from the two
    // picked rows; the dialog previews THAT range before any file exists.
    const preview = await t.fetchJson(
      'GET', '/api/export/preview?from=2026-07-06&to=2026-07-20&includeDrafts=0');
    assert.equal(preview.body.count, 4,
      'the dialog is handed 4 while the selection bar says 2 — which is exactly what its note prints');
  } finally { await t.close(); }
});
