// ===========================================================================
// ADVERSARIAL VERIFICATION — "NarrativeHistory keeps its rows and its checked
// selections across a cmId change" (public/js/components/narrativehistory.js,
// the fetch effect at lines 33-42).
//
// WHAT THIS FILE IS. A claim was made by reasoning from source, without
// observation. This file observes. Every test here is written to PASS on the
// current code; a red run is a real finding, not a broken test.
//
// The standard is docs/ui/BRIEF.md, "Data integrity: non-negotiable":
//
//   "A narrative written for matter A may never be shown as belonging to,
//    suggested for, pre-filled into, or written onto an entry for matter B.
//    Not across clients, and not between two matters of the SAME client."
//
// THREE SEPARATE QUESTIONS, THREE TESTS:
//
//   1. IS THE SERVER FEED CLEAN?  /api/matters/:id/recent-narratives, checked
//      against the SQLite rows themselves. If the feed blends, nothing the
//      client does matters.
//   2. IS THE MECHANISM REAL?  The component is mounted directly and handed a
//      second cmId while it lives — the exact thing the claim describes, which
//      no call site does. This is a LABORATORY probe, not a user path.
//   3. CAN A USER GET THERE?  Both real call sites are driven in the shipped
//      app: the stop-timer offer's "More from this matter", and the entry
//      editor's "Reuse". These are the tests that decide whether the claim is
//      a defect or a note in the margin.
//
// WHAT THIS FILE MEASURED (2026-08-15, branch ui-overhaul-2026-08):
//
//   1. GREEN. Every row /api/matters/:id/recent-narratives returns has
//      entries.cm_id equal to the matter asked for, verified in SQLite. No
//      blend, no sibling fallback.
//   2. RED, BY DESIGN, AND LATENT. Handed a second cmId while mounted, the
//      component shows the PREVIOUS matter's sentences, still ticked, joined
//      into the "Inserts:" preview, under the NEW matter's title, for the
//      length of one fetch. Measured:
//        title   "Reuse a narrative — Northgate diligence"
//        rows    "Reviewed the landlord termination notice…"  (Acme Holdings)
//        preview "Reviewed the landlord termination notice…"  ← what "Use it"
//                                                                would write
//      Once the new fetch lands it self-corrects completely: Northgate's rows,
//      nothing ticked, empty preview. The carried-over `picked` ids cannot
//      re-tick anything, because entry ids are global and no Northgate row can
//      share an Acme row's id.
//   3. GREEN, AND THIS IS THE POINT. No shipped call site can do what test 2
//      does:
//        - stop-chips: while the dialog is open `.shell` is inert (measured
//          inert:true, aria-hidden:"true"), so no other timer's Stop button is
//          reachable at all; and firing `tk:stop-timer` straight past the
//          inert shell — timergrid.js's own integration point, well beyond
//          what a user can reach — DESTROYS the dialog (measured: null)
//          because StopChips keys StopOffer by `${entryId}#${n}`.
//        - entry editor: the float window's `tk:open-entry` re-target leaves
//          `local.cm` on Acme (the load effect's deps are `[]`), so the dialog
//          stays titled Acme with Acme's rows.
//        - the matter picker, the one gesture that CAN change this editor's
//          cmId, sits under the dialog's scrim: a real pointer click at its
//          coordinates lands on DIV.ovl and DISMISSES the reuse dialog
//          (measured historyStillUp:false, listboxes:0, matter unchanged).
//          The dialog cannot be alive at the moment the matter changes.
//
// So test 2 is a guard against a THIRD caller, not a report of a live leak.
// It is one line to close: `setRows(null); setPicked([]);` at the top of the
// effect. Do not delete the test to make the suite green.
//
// Set TK_SKIP_UI_PROOF=1 to skip the browser tests (test 1 still runs).
// ===========================================================================
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTestServer } from './helpers.js';

const SKIP = process.env.TK_SKIP_UI_PROOF === '1';

// Two clients, two matters — the widest possible boundary — with sentences
// that could not be mistaken for each other or for generic phrasing.
const ACME_1 = 'Reviewed the landlord termination notice and the underlying lease.';
const ACME_2 = 'Call with W. Hammond regarding the easement and the recorded plat.';
const NORTH_1 = 'Reviewed the data room index and flagged three missing consents.';
const NORTH_2 = 'Prepared the diligence responses and circulated the open issues list.';

const pad = (n) => String(n).padStart(2, '0');
const todayLocal = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const dayBefore = (n) => {
  const d = new Date(`${todayLocal()}T12:00:00`);
  d.setDate(d.getDate() - n);
  return todayLocal(d);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// TEST 1 — the feed itself, verified against the database rows.
// No browser: this is the thing everything downstream is built on.
// ---------------------------------------------------------------------------
test('recent-narratives returns only rows whose entries.cm_id IS that matter (checked in SQLite)', async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());

  const cm = async (n, sn, client) => (await s.fetchJson('POST', '/api/cms', {
    cm_number: n, short_name: sn, client_name: client, billable: 1,
  })).body;
  // Same client, two matters — the case the brief calls out explicitly.
  const acme = await cm('900100-000001', 'Acme lease dispute', 'Acme Holdings');
  const acme2 = await cm('900100-000002', 'Acme trademark', 'Acme Holdings');
  const north = await cm('900200-000001', 'Northgate diligence', 'Northgate Partners');

  const entry = (cmId, date, narrative) => s.fetchJson('POST', '/api/entries', {
    date, cm_id: cmId, narrative, tasks: [{ task_code: 'Review', duration: 0.5, fragment: '' }],
  });
  await entry(acme.id, dayBefore(1), ACME_1);
  await entry(acme.id, dayBefore(2), ACME_2);
  await entry(acme2.id, dayBefore(1), 'Filed the statement of use for the ACME word mark.');
  await entry(north.id, dayBefore(1), NORTH_1);
  await entry(north.id, dayBefore(2), NORTH_2);

  for (const m of [acme, acme2, north]) {
    const r = await s.fetchJson('GET', `/api/matters/${m.id}/recent-narratives?limit=20`);
    assert.equal(r.status, 200);
    assert.ok(r.body.entries.length > 0, `sanity: matter ${m.short_name} has narratives`);
    for (const row of r.body.entries) {
      // Straight to the file on disk — not the API's own view of itself.
      const stored = s.db.prepare('SELECT cm_id, narrative FROM entries WHERE id = ?').get(row.id);
      assert.equal(
        stored.cm_id, m.id,
        `LEAK: recent-narratives for matter ${m.id} returned entry ${row.id}, `
        + `whose entries.cm_id is ${stored.cm_id} — narrative ${JSON.stringify(stored.narrative)}`,
      );
      assert.equal(row.narrative, stored.narrative, 'the row carries the stored text unmodified');
    }
  }

  // And nothing of Acme's is reachable through Northgate's feed, by text.
  const nf = await s.fetchJson('GET', `/api/matters/${north.id}/recent-narratives`);
  const text = nf.body.entries.map((e) => e.narrative).join(' | ');
  assert.ok(!text.includes('landlord termination'), `LEAK: Acme's sentence in Northgate's feed — ${text}`);
  assert.ok(!text.includes('W. Hammond'), `LEAK: Acme's sentence in Northgate's feed — ${text}`);
});

// ---------------------------------------------------------------------------
// One server + one browser for the two UI tests.
// ---------------------------------------------------------------------------
let ui = null;

async function bootUi() {
  if (ui) return ui;
  process.env.TZ = process.env.TZ || 'America/Los_Angeles';
  const { openDb } = await import('../server/db.js');
  const { createApp } = await import('../server/app.js');
  const puppeteer = (await import('puppeteer-core')).default;

  const dir = mkdtempSync(join(tmpdir(), 'tk-nhcm-'));
  const db = openDb(join(dir, 'ui.db'));
  const app = createApp({ db, config: { DATA_DIR: dir, TRUST_LAN: true }, clock: () => new Date() });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;

  const api = async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const txt = await res.text();
    assert.ok(res.ok, `${method} ${path} -> ${res.status} ${txt}`);
    return txt ? JSON.parse(txt) : null;
  };

  const browser = await puppeteer.launch({
    executablePath: '/usr/bin/chromium',
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  const acme = await api('POST', '/api/cms', {
    cm_number: '900301-000001', short_name: 'Acme lease dispute', client_name: 'Acme Holdings', billable: 1,
  });
  const north = await api('POST', '/api/cms', {
    cm_number: '900302-000001', short_name: 'Northgate diligence', client_name: 'Northgate Partners', billable: 1,
  });
  // Enough history on each side that both dialogs have real rows to show.
  const seeded = [];
  for (let i = 1; i <= 3; i += 1) {
    seeded.push(await api('POST', '/api/entries', {
      date: dayBefore(i), cm_id: acme.id, narrative: i === 1 ? ACME_1 : ACME_2,
      tasks: [{ task_code: 'Review', duration: 1.1, fragment: '' }],
    }));
    seeded.push(await api('POST', '/api/entries', {
      date: dayBefore(i), cm_id: north.id, narrative: i === 1 ? NORTH_1 : NORTH_2,
      tasks: [{ task_code: 'Due Diligence', duration: 0.9, fragment: '' }],
    }));
  }
  const today = todayLocal();
  const acmeEntry = await api('POST', '/api/entries', {
    date: today, cm_id: acme.id, narrative: ACME_1,
    tasks: [{ task_code: 'Review', duration: 0.7, fragment: '' }],
  });
  const northEntry = await api('POST', '/api/entries', {
    date: today, cm_id: north.id, narrative: NORTH_1,
    tasks: [{ task_code: 'Review', duration: 0.4, fragment: '' }],
  });

  ui = {
    base, api, browser, db, today, acme, north, acmeEntry, northEntry, seeded,
    close: async () => {
      await browser.close();
      await new Promise((r) => server.close(r));
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return ui;
}

after(async () => { if (ui) await ui.close(); });

async function bootOrSkip(t) {
  try {
    return await bootUi();
  } catch (e) {
    t.skip(`could not boot headless Chromium (/usr/bin/chromium): ${e.message}`);
    return null;
  }
}

const readDialog = (page) => page.evaluate(() => {
  const panel = [...document.querySelectorAll('.ovl-panel')]
    .find((p) => p.querySelector('.narrative-history, .narrative-history-preview')
      || (p.querySelector('.ovl-title')?.textContent || '').includes('Reuse a narrative'));
  if (!panel) return null;
  return {
    title: (panel.querySelector('.ovl-title, h2, [id$="-title"]')?.textContent || panel.textContent.slice(0, 80))
      .replace(/\s+/g, ' ').trim(),
    rows: [...panel.querySelectorAll('.narrative-history-row .narrative')]
      .map((n) => n.textContent.replace(/\s+/g, ' ').trim()),
    checked: [...panel.querySelectorAll('.narrative-history-row input[type=checkbox]')]
      .map((c, i) => (c.checked ? i : -1)).filter((i) => i >= 0).length,
    checkedText: [...panel.querySelectorAll('.narrative-history-row')]
      .filter((r) => r.querySelector('input[type=checkbox]')?.checked)
      .map((r) => r.querySelector('.narrative')?.textContent.replace(/\s+/g, ' ').trim()),
    preview: panel.querySelector('.narrative-history-preview .narrative')?.textContent
      .replace(/\s+/g, ' ').trim() || '',
  };
});

// ---------------------------------------------------------------------------
// TEST 2 — THE LABORATORY PROBE.  Does the mechanism the claim describes exist?
//
// NarrativeHistory is mounted on its own, with the real app's React, the real
// module, the real server, and then handed a SECOND cmId while it stays
// mounted. Nothing in the shipped app does this (test 3 checks that); this
// exists only to say whether the described mechanism is real, and to measure
// what it would cost if a third call site ever re-used one instance.
//
// The recent-narratives response for the SECOND matter is delayed 1200ms.
// That does not manufacture the window — every fetch has one — it makes the
// window big enough to photograph.
// ---------------------------------------------------------------------------
test('LATENT (RED BY DESIGN — no shipped call site can trigger it; see the REACHABILITY test below): '
  + 'a live NarrativeHistory handed a second cmId shows the previous matter until the fetch lands',
{ skip: SKIP }, async (t) => {
    const u = await bootOrSkip(t);
    if (!u) return;

    const page = await u.browser.newPage();
    t.after(() => page.close());
    await page.setViewport({ width: 1440, height: 900 });

    // Delay only the SECOND matter's feed, so the gap is observable.
    await page.setRequestInterception(true);
    page.on('request', async (req) => {
      if (req.url().includes(`/api/matters/${u.north.id}/recent-narratives`)) {
        await sleep(1200);
        req.continue();
        return;
      }
      req.continue();
    });

    await page.goto(`${u.base}/#/`, { waitUntil: 'networkidle0' });
    await sleep(500);

    await page.evaluate(async (acmeId) => {
      const { NarrativeHistory } = await import('/js/components/narrativehistory.js');
      const { html } = await import('/js/ui.js');
      const React = window.React;
      const { createRoot } = window.ReactDOM;
      const host = document.createElement('div');
      host.id = 'nh-probe';
      document.body.appendChild(host);
      window.__probe = { inserted: null, closed: false };
      function Harness() {
        const [cm, setCm] = React.useState({ id: acmeId, label: 'Acme lease dispute' });
        React.useEffect(() => { window.__probe.setCm = setCm; }, []);
        return html`<${NarrativeHistory} cmId=${cm.id} cmLabel=${cm.label}
          insertLabel="Use it" announce=${false}
          onInsert=${(txt) => { window.__probe.inserted = txt; }}
          onClose=${() => { window.__probe.closed = true; }} />`;
      }
      createRoot(host).render(html`<${Harness} />`);
    }, u.acme.id);

    await page.waitForSelector('.narrative-history-row', { timeout: 10_000 });
    const before = await readDialog(page);
    assert.ok(before.rows.some((r) => r.includes('landlord termination')),
      `sanity: the probe opened on Acme's list — got ${JSON.stringify(before.rows)}`);

    // Tick Acme's sentence, exactly as a lawyer would.
    await page.evaluate((needle) => {
      const row = [...document.querySelectorAll('.narrative-history-row')]
        .find((el) => el.textContent.includes(needle));
      row.querySelector('input[type=checkbox]').click();
    }, 'landlord termination');
    await page.waitForFunction(() => (document.querySelector('.narrative-history-preview .narrative')
      ?.textContent || '').includes('landlord termination'), { timeout: 5000 });

    // Hand the SAME instance the other client's matter.
    await page.evaluate((northId) => {
      window.__probe.setCm({ id: northId, label: 'Northgate diligence' });
    }, u.north.id);
    await sleep(250); // inside the 1200ms fetch, well before it lands
    const during = await readDialog(page);

    // Then let the fetch land and look again.
    await page.waitForFunction(() => [...document.querySelectorAll('.narrative-history-row .narrative')]
      .some((n) => n.textContent.includes('data room index')), { timeout: 10_000 });
    await sleep(200);
    const settled = await readDialog(page);

    // Whatever the screen said, ask what the "Use it" button would have
    // written during the gap — that is the only thing that could reach an
    // entry. (The harness catches it; nothing is written to the database.)
    const gapPayload = during.preview;

    // Record the measurement in the failure message either way.
    const shot = JSON.stringify({ during, settled, gapPayload }, null, 1);

    assert.ok(
      !during.title.includes('Northgate') || !during.rows.some((r) => r.includes('landlord termination')),
      `LEAK: an instance handed a new cmId showed Acme Holdings' sentences under `
      + `"${during.title}" for the length of one fetch.\n${shot}`,
    );
    assert.equal(
      gapPayload, '',
      `LEAK: during the gap the insert preview still offered Acme's sentence under Northgate's title `
      + `— "Use it" would have written ${JSON.stringify(gapPayload)}.\n${shot}`,
    );
    assert.deepEqual(
      settled.checkedText, [],
      `LEAK: after the new matter's list landed, ticks survived from the previous matter.\n${shot}`,
    );
    assert.ok(
      !settled.rows.some((r) => r.includes('landlord termination') || r.includes('W. Hammond')),
      `LEAK: Acme's sentences still listed after Northgate's fetch landed.\n${shot}`,
    );
  });

// ---------------------------------------------------------------------------
// TEST 3 — REACHABILITY.  Both shipped call sites, driven for real.
//
// (a) The stop-timer offer: stop Acme's timer, open "More from this matter",
//     then stop Northgate's timer with that dialog still on screen — the
//     rhythm that produced the wave-2b3 leak (commit d2b46c9).
// (b) The entry editor: open "Reuse" on the Acme entry, then fire
//     `tk:open-entry` for the Northgate entry — the float window's own path,
//     which app.js answers with setEditor({id}) on the SAME editor instance
//     (see test/integrity.stalestate.test.js LEAK 1).
//
// In both, the assertion is the brief's line: no Acme sentence may be on
// screen under a Northgate heading, and nothing may be ticked that belongs to
// a matter other than the one named.
// ---------------------------------------------------------------------------
test('REACHABILITY: neither call site can hand a live NarrativeHistory a second matter',
  { skip: SKIP }, async (t) => {
    const u = await bootOrSkip(t);
    if (!u) return;

    const page = await u.browser.newPage();
    t.after(() => page.close());
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.setViewport({ width: 1440, height: 900 });

    const tA = await u.api('POST', '/api/timers', { name: '__nh-acme__', cm_id: u.acme.id, task_code: 'Review' });
    const tB = await u.api('POST', '/api/timers', { name: '__nh-north__', cm_id: u.north.id, task_code: 'Review' });

    // Backdated 30 minutes so the stop has real time to file. Started before
    // the page loads, so the running row is there when it renders.
    await u.api('POST', `/api/timers/${tA.id}/start`, { minutesAgo: 30 });

    await page.goto(`${u.base}/#/`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('.timer-board .timer-tile, .today-list .work-row', { timeout: 10_000 });

    const rowAct = async (name, title) => {
      await page.waitForFunction((nm, ti) => [...document.querySelectorAll('.timer-board .timer-tile, .today-list .work-row')]
        .some((r) => r.textContent.includes(nm) && r.querySelector(`button[title="${ti}"]`)),
      { timeout: 8000 }, name, title);
      await page.evaluate((nm, ti) => {
        const row = [...document.querySelectorAll('.timer-board .timer-tile, .today-list .work-row')].find((r) => r.textContent.includes(nm));
        row.scrollIntoView({ block: 'center' });
        row.querySelector(`button[title="${ti}"]`).click();
      }, name, title);
    };

    // ---- (a) the stop-timer offer ----
    await rowAct('__nh-acme__', 'Stop & file time');
    await page.waitForSelector('.stop-chips', { timeout: 10_000 });
    await page.evaluate(() => {
      const b = [...document.querySelectorAll('.stop-chips button')]
        .find((x) => x.textContent.includes('More from this matter'));
      if (!b) throw new Error('no "More from this matter" button on the offer');
      b.click();
    });
    await page.waitForSelector('.narrative-history-row', { timeout: 10_000 });
    const chipsOpen = await readDialog(page);
    assert.ok(chipsOpen.rows.some((r) => r.includes('landlord termination')),
      `sanity: the offer's history opened on Acme — ${JSON.stringify(chipsOpen)}`);
    await page.evaluate((needle) => {
      const row = [...document.querySelectorAll('.narrative-history-row')]
        .find((el) => el.textContent.includes(needle));
      row.querySelector('input[type=checkbox]').click();
    }, 'landlord termination');
    await sleep(200);

    // FIRST, the honest question: with the reuse dialog up, can the lawyer
    // reach the other timer's Stop button at all? The overlay primitive makes
    // `.shell` inert, so this records what the UI actually permits.
    const shellInert = await page.evaluate(() => {
      const shell = document.querySelector('.shell');
      return { inert: !!shell?.inert, ariaHidden: shell?.getAttribute('aria-hidden') };
    });

    // Now the most generous possible attempt, well beyond what a user can do:
    // start the other client's timer server-side and fire `tk:stop-timer` —
    // timergrid.js's own documented integration point for "stop the timer
    // without owning the chip flow" — straight past the inert shell.
    await u.api('POST', `/api/timers/${tB.id}/start`, { minutesAgo: 30 });
    await page.evaluate((id) => {
      window.dispatchEvent(new CustomEvent('tk:stop-timer', { detail: { id } }));
    }, tB.id);
    await sleep(2000);
    const afterStop = await readDialog(page);
    const offerHead = await page.evaluate(() => document.querySelector('.stop-chips-head')
      ?.textContent.replace(/\s+/g, ' ').trim() || null);

    if (afterStop) {
      assert.ok(
        !/Northgate/.test(afterStop.title) || !afterStop.rows.some((r) => r.includes('landlord termination')),
        `LEAK: after stopping the Northgate timer the reuse dialog reads "${afterStop.title}" `
        + `and lists Acme's sentences — ${JSON.stringify(afterStop)}`,
      );
      assert.ok(
        !afterStop.checkedText.some((x) => x && x.includes('landlord termination'))
          || !/Northgate/.test(afterStop.title),
        `LEAK: Acme's sentence is still ticked under "${afterStop.title}" — ${JSON.stringify(afterStop)}`,
      );
    }
    // The measurement itself, printed so a reader of a green run still sees it.
    console.log('  [stop-chips path] shell while dialog open:', JSON.stringify(shellInert),
      '| dialog after the second stop:', JSON.stringify(afterStop),
      '| new offer head:', JSON.stringify(offerHead));

    // Whatever happened on screen, no Acme text may have reached Northgate's
    // entry. Read the database, not the API.
    const northRow = u.db.prepare(
      'SELECT id, cm_id, narrative FROM entries WHERE cm_id = ? AND date = ? ORDER BY id DESC LIMIT 1',
    ).get(u.north.id, u.today);
    assert.ok(
      !String(northRow?.narrative || '').includes('landlord termination'),
      `LEAK: entry ${northRow?.id} (cm_id ${northRow?.cm_id}, Northgate) holds Acme's sentence `
      + `${JSON.stringify(northRow?.narrative)}`,
    );

    // ---- (b) the entry editor ----
    // Opened by the same event the float window uses, so both halves of this
    // step travel the identical code path in app.js (setEditor({id})).
    await page.goto(`${u.base}/#/day/${u.today}`, { waitUntil: 'networkidle0' });
    await sleep(800);
    await page.evaluate((id) => {
      window.dispatchEvent(new CustomEvent('tk:open-entry', { detail: { id } }));
    }, u.acmeEntry.id);
    await page.waitForSelector('.modal-wide', { timeout: 10_000 });
    await sleep(600);
    const edMatter = await page.evaluate(() => document.querySelector('.ed-row-matter .cm-value-name')
      ?.textContent.trim() || null);
    assert.equal(edMatter, 'Acme lease dispute', 'sanity: the editor opened on the Acme entry');
    await page.evaluate(() => {
      const b = [...document.querySelectorAll('.modal-wide button')].find((x) => x.textContent.includes('Reuse'));
      if (!b) throw new Error('no Reuse button in the editor');
      b.click();
    });
    await page.waitForSelector('.narrative-history-row', { timeout: 10_000 });
    const edOpen = await readDialog(page);
    assert.ok(edOpen.rows.some((r) => r.includes('landlord termination')),
      `sanity: the editor's Reuse opened on Acme — ${JSON.stringify(edOpen)}`);
    await page.evaluate((needle) => {
      const row = [...document.querySelectorAll('.narrative-history-row')]
        .find((el) => el.textContent.includes(needle));
      row.querySelector('input[type=checkbox]').click();
    }, 'landlord termination');
    await sleep(200);

    // The float window's re-target, verbatim from pip.js, with the reuse
    // dialog still up.
    await page.evaluate((id) => {
      window.dispatchEvent(new CustomEvent('tk:open-entry', { detail: { id } }));
    }, u.northEntry.id);
    await sleep(1500);
    const edAfter = await readDialog(page);
    const edMatterAfter = await page.evaluate(() => document.querySelector('.ed-row-matter .cm-value-name')
      ?.textContent.trim() || null);
    console.log('  [entry-editor path] editor matter after tk:open-entry(Northgate):',
      JSON.stringify(edMatterAfter), '| dialog:', JSON.stringify(edAfter));

    if (edAfter) {
      assert.ok(
        !/Northgate/.test(edAfter.title) || !edAfter.rows.some((r) => r.includes('landlord termination')),
        `LEAK: the reuse dialog reads "${edAfter.title}" while listing Acme's sentences `
        + `— ${JSON.stringify(edAfter)}`,
      );
    }

    // ---- (c) the only user gesture that CAN change this editor's matter:
    // the matter picker in the row beneath the dialog. Tried by real pointer
    // (what a lawyer has) and then programmatically (what a lawyer does not),
    // with the dialog still up.
    const pointer = await page.evaluate(() => {
      const btn = document.querySelector('.ed-row-matter .cm-value');
      if (!btn) return null;
      const r = btn.getBoundingClientRect();
      const x = Math.round(r.x + r.width / 2);
      const y = Math.round(r.y + r.height / 2);
      const hit = document.elementFromPoint(x, y);
      return { x, y, hit: hit ? `${hit.tagName}.${hit.className}` : null, inertPanel: !!btn.closest('.ovl-panel')?.inert };
    });
    let pickerOpened = null;
    if (pointer) {
      await page.mouse.click(pointer.x, pointer.y);
      await sleep(600);
      pickerOpened = await page.evaluate(() => ({
        listboxes: document.querySelectorAll('.cmpicker-menu').length,
        historyStillUp: !!document.querySelector('.narrative-history-row'),
        matter: document.querySelector('.ed-row-matter .cm-value-name')?.textContent.trim() || null,
      }));
    }
    console.log('  [entry-editor path] matter row under the dialog:', JSON.stringify(pointer),
      '| after a real click:', JSON.stringify(pickerOpened));

    const edFinal = await readDialog(page);
    if (edFinal) {
      assert.ok(
        !/Northgate/.test(edFinal.title),
        `LEAK: the reuse dialog re-titled to "${edFinal.title}" — ${JSON.stringify(edFinal)}`,
      );
      assert.ok(
        edFinal.rows.every((r) => r.includes('landlord termination') || r.includes('W. Hammond')),
        `LEAK: rows from a matter other than the one in the title — ${JSON.stringify(edFinal)}`,
      );
    }
    assert.deepEqual(errors, [], `page errors while driving the two call sites: ${errors.join(' | ')}`);
  });
