// ===========================================================================
// ADVERSARIAL VERIFICATION of the claim:
//   "The server will write a blank billing line into the .TIM; only the client
//    blocks it" (server/routes/export.js vs public/js/views/search.js).
//
// THIS FILE IS EXPECTED TO FAIL on ui-overhaul-2026-08. The tests named
// "PROVES" assert the behaviour the brief requires and fail against the code
// as it stands. Do not relax the assertions to make them pass; the fix belongs
// in server/routes/export.js.
//
// The tests named "BOUNDS" pass today. They exist to pin down exactly how far
// the defect reaches, so nobody over- or under-states it later.
// ===========================================================================
process.env.TZ = 'America/Los_Angeles';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';
import { parseCsv } from '../server/lib/csv.js';

const clock = () => new Date('2026-07-06T15:00:00-07:00');

async function boot() {
  const t = await startTestServer({ clock });
  const acme = (await t.fetchJson('POST', '/api/cms', {
    cm_number: '100001-000012', short_name: 'Acme lease', billable: 1,
  })).body;
  return { t, acme };
}

// Every na= field on every line of a .TIM payload.
function timNarratives(tim) {
  return String(tim || '').split('\n').filter(Boolean).map((line) => {
    const f = line.split('|').find((p) => p.startsWith('na='));
    return f === undefined ? null : f.slice(3);
  });
}

// ---------------------------------------------------------------------------
// PROVES 1 — the endpoint itself has no narrative check. A draft with no
// narrative, included in the range, becomes a .TIM line with an empty na=
// field and a CSV row with an empty narrative column.
// ---------------------------------------------------------------------------
test('PROVES: POST /api/export writes a .TIM line and a CSV row with an empty narrative', async () => {
  const { t, acme } = await boot();
  try {
    const e = (await t.fetchJson('POST', '/api/entries', {
      date: '2026-07-06', cm_id: acme.id, narrative: '',
      tasks: [{ task_code: 'Review', duration: 0.4, fragment: '' }],
    })).body;
    assert.equal(e.status, 'draft', 'setup: the blank entry is a draft');

    const r = await t.fetchJson('POST', '/api/export', {
      from: '2026-07-06', to: '2026-07-06', includeDrafts: true,
    });
    assert.equal(r.status, 200, 'the endpoint accepts it without complaint');

    const csv = parseCsv(r.body.csv);
    const narrCol = csv[0].indexOf('narrative');
    const csvNarratives = csv.slice(1).map((row) => row[narrCol]);

    assert.deepEqual(
      { tim: timNarratives(r.body.tim), csv: csvNarratives },
      { tim: ['SOMETHING'], csv: ['SOMETHING'] },
      'DEFECT: the server emits a blank billing line. Neither POST /api/export nor '
      + 'formatTimEntries checks that an exported entry has a narrative; the only guard in '
      + 'the app is ExportDialog disabling its two file buttons in public/js/views/search.js.',
    );
  } finally { await t.close(); }
});

// ---------------------------------------------------------------------------
// PROVES 2 — the same hole through the OTHER server-side door. `attention`
// selects rows on its own and ignores includeDrafts entirely (export.js:20),
// so an attention-scoped export reaches the blank draft without any caller
// asking for drafts.
// ---------------------------------------------------------------------------
test('PROVES: an attention-scoped export reaches the same blank draft with no includeDrafts flag', async () => {
  const { t, acme } = await boot();
  try {
    await t.fetchJson('POST', '/api/entries', {
      date: '2026-07-06', cm_id: acme.id, narrative: '',
      tasks: [{ task_code: 'Review', duration: 0.4, fragment: '' }],
    });
    const r = await t.fetchJson('POST', '/api/export', {
      from: '2026-07-06', to: '2026-07-06', attention: 'either',
    });
    assert.deepEqual(
      timNarratives(r.body.tim), ['SOMETHING'],
      'DEFECT: attention=either exports drafts without includeDrafts, so the blank line '
      + 'reaches the file down a second server path.',
    );
  } finally { await t.close(); }
});

// ===========================================================================
// BOUNDS — these PASS today and fix the limits of the defect.
// ===========================================================================

// A finalized entry can never be blank: narrative_empty is a `block` in
// lib/validation.js and finalizeOne is the only writer of status='finalized'.
// ack does not override a block, and a finalized entry cannot be patched.
test('BOUNDS: no path finalizes a blank narrative, so the default export is safe', async () => {
  const { t, acme } = await boot();
  try {
    const blank = (await t.fetchJson('POST', '/api/entries', {
      date: '2026-07-06', cm_id: acme.id, narrative: '',
      tasks: [{ task_code: 'Review', duration: 0.4, fragment: '' }],
    })).body;
    const ws = (await t.fetchJson('POST', '/api/entries', {
      date: '2026-07-06', cm_id: acme.id, narrative: '   \n  ',
      tasks: [{ task_code: 'Review', duration: 0.3, fragment: '' }],
    })).body;

    // finalize with ack:true — the strongest thing any surface in the app sends
    for (const id of [blank.id, ws.id]) {
      const f = await t.fetchJson('POST', `/api/entries/${id}/finalize`, { ack: true });
      assert.equal(f.status, 422, 'finalize rejects a blank narrative even with ack');
      assert.ok(f.body.blocks.some((b) => b.code === 'narrative_empty'), 'blocked as narrative_empty');
    }
    // bulk finalize, and finalize-day — both route through finalizeOne
    const bulk = await t.fetchJson('POST', '/api/entries/bulk', {
      ids: [blank.id, ws.id], action: 'finalize', ack: true,
    });
    assert.deepEqual(bulk.body.done, [], 'bulk finalize refuses them too');
    assert.ok(bulk.body.failed.every((f) => f.blocks.some((b) => b.code === 'narrative_empty')));
    const day = await t.fetchJson('POST', '/api/finalize-day', { date: '2026-07-06', ack: true });
    assert.equal(day.body.finalized.length, 0, 'finalize-day refuses them too');

    // A finalized entry cannot then be emptied.
    const good = (await t.fetchJson('POST', '/api/entries', {
      date: '2026-07-06', cm_id: acme.id, narrative: 'Reviewed the executed lease amendment.',
      tasks: [{ task_code: 'Review', duration: 0.5, fragment: 'lease' }],
    })).body;
    await t.fetchJson('POST', `/api/entries/${good.id}/finalize`, { ack: true });
    const p = await t.fetchJson('PATCH', `/api/entries/${good.id}`, { narrative: '' });
    assert.equal(p.status, 409, 'a finalized entry cannot be emptied without unlocking');

    // So the default export — what dashboard.js, calendar.js and closeout.js
    // all send — carries no blank line.
    const r = await t.fetchJson('POST', '/api/export', { from: '2026-07-06', to: '2026-07-06' });
    assert.deepEqual(timNarratives(r.body.tim), ['Reviewed the executed lease amendment.']);
    assert.equal(r.body.count, 1, 'the two blank drafts are not in the default file');
  } finally { await t.close(); }
});

// The claim says the endpoint "writes na=| happily AND STAMPS". Half of that
// is wrong: export.js:101 stamps only status='finalized', so the blank draft
// goes into the file un-stamped. No time is marked sent that was not sent.
test('BOUNDS: the blank draft is NOT stamped exported — the claim overstates this half', async () => {
  const { t, acme } = await boot();
  try {
    const e = (await t.fetchJson('POST', '/api/entries', {
      date: '2026-07-06', cm_id: acme.id, narrative: '',
      tasks: [{ task_code: 'Review', duration: 0.4, fragment: '' }],
    })).body;
    await t.fetchJson('POST', '/api/export', {
      from: '2026-07-06', to: '2026-07-06', includeDrafts: true,
    });
    const row = t.db.prepare('SELECT status, exported_at, narrative FROM entries WHERE id=?').get(e.id);
    assert.deepEqual(
      { status: row.status, exported_at: row.exported_at, narrative: row.narrative },
      { status: 'draft', exported_at: null, narrative: '' },
      'the draft is written into the file but left unstamped',
    );
  } finally { await t.close(); }
});

// No narrative belonging to another matter appears anywhere in this path. The
// blank line is a MISSING narrative, not a BORROWED one.
test('BOUNDS: the blank line borrows nothing from another matter', async () => {
  const { t, acme } = await boot();
  try {
    const northgate = (await t.fetchJson('POST', '/api/cms', {
      cm_number: '200002-000001', short_name: 'Northgate merger', billable: 1,
    })).body;
    const ng = (await t.fetchJson('POST', '/api/entries', {
      date: '2026-07-06', cm_id: northgate.id,
      narrative: 'Drafted the Northgate share purchase agreement schedules.',
      tasks: [{ task_code: 'Draft', duration: 1.0, fragment: 'SPA' }],
    })).body;
    await t.fetchJson('POST', `/api/entries/${ng.id}/finalize`, { ack: true });
    const blank = (await t.fetchJson('POST', '/api/entries', {
      date: '2026-07-06', cm_id: acme.id, narrative: '',
      tasks: [{ task_code: 'Review', duration: 0.4, fragment: '' }],
    })).body;

    await t.fetchJson('POST', '/api/export', {
      from: '2026-07-06', to: '2026-07-06', includeDrafts: true,
    });
    const row = t.db.prepare('SELECT cm_id, narrative FROM entries WHERE id=?').get(blank.id);
    assert.equal(row.cm_id, acme.id);
    assert.equal(row.narrative, '', 'the Acme draft is still empty — nothing was copied into it');
    assert.ok(
      !String(row.narrative || '').includes('Northgate'),
      'no other matter\'s sentence was written onto this entry',
    );
  } finally { await t.close(); }
});
