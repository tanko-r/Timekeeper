// ===========================================================================
// DATA-INTEGRITY PROOFS — client state that outlives the record it belongs to.
//
// READ THIS BEFORE "FIXING" A RED RUN.
//
// Both tests here are PROOFS OF A DEFECT. They are written to FAIL while the
// defect is present and to pass once it is fixed. A red result is the finding,
// not a broken test — do not delete the assertion, do not relax it, and do not
// make it pass by changing the test.
//
// Findings write-up: docs/ui/integrity-stalestate.md
//
// The standard is docs/ui/BRIEF.md, "Data integrity: non-negotiable":
//
//   "A narrative written for matter A may never be shown as belonging to,
//    suggested for, pre-filled into, or written onto an entry for matter B.
//    Not across clients, and not between two matters of the SAME client."
//   "No entry dropped, skipped, or double-counted… Nothing that could cause
//    the owner to leak billable time."
//
// Both defects are React-lifecycle defects, so both have to be driven through
// the real UI: they boot the server on a temp database the way
// scripts/uishots.mjs does and drive the shipped app in headless Chromium.
// ONE browser and ONE server are shared by both tests (~12s in total).
//
// Set TK_SKIP_UI_PROOF=1 to skip them — e.g. while a screenshot run already
// owns the cores. They are NOT skipped by default: a proof nobody runs is not
// a proof.
//
// Two sibling findings this file deliberately does NOT duplicate, because
// test/integrity.suggestions.test.js already proves them (S7/S8 there):
// timers.draft_narrative and timers.narrative_template surviving a matter
// re-point and seeding the next matter's entry.
// ===========================================================================
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SKIP = process.env.TK_SKIP_UI_PROOF === '1';

const ACME_NARRATIVE = 'Reviewed the landlord termination notice and the underlying lease.';
const NORTHGATE_NARRATIVE = 'Reviewed the data room index and flagged three missing consents.';

const todayLocal = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1)
  .padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// One server + one browser for the whole file, booted on first use.
// ---------------------------------------------------------------------------
let ui = null;

async function bootUi() {
  if (ui) return ui;
  process.env.TZ = process.env.TZ || 'America/Los_Angeles';
  const { openDb } = await import('../server/db.js');
  const { createApp } = await import('../server/app.js');
  const puppeteer = (await import('puppeteer-core')).default;

  const dir = mkdtempSync(join(tmpdir(), 'tk-stale-'));
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
    const text = await res.text();
    assert.ok(res.ok, `${method} ${path} -> ${res.status} ${text}`);
    return text ? JSON.parse(text) : null;
  };

  const browser = await puppeteer.launch({
    executablePath: '/usr/bin/chromium',
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  // Two matters under two DIFFERENT clients — the widest possible boundary —
  // each with one entry today carrying its own billing sentence.
  const acme = await api('POST', '/api/cms', {
    cm_number: '100001-000012', short_name: 'Acme lease dispute', client_name: 'Acme Holdings', billable: 1,
  });
  const northgate = await api('POST', '/api/cms', {
    cm_number: '100244-000002', short_name: 'Northgate diligence', client_name: 'Northgate Partners', billable: 1,
  });
  const today = todayLocal();
  const acmeEntry = await api('POST', '/api/entries', {
    date: today, cm_id: acme.id, narrative: ACME_NARRATIVE,
    tasks: [{ task_code: 'Review', duration: 0.7, fragment: '' }],
  });
  const northgateEntry = await api('POST', '/api/entries', {
    date: today, cm_id: northgate.id, narrative: NORTHGATE_NARRATIVE,
    tasks: [{ task_code: 'Review', duration: 0.4, fragment: '' }],
  });

  ui = {
    base,
    api,
    browser,
    today,
    acme,
    northgate,
    acmeEntry,
    northgateEntry,
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

// A launch failure is an environment problem, not a finding — say so rather
// than reporting a leak that was never measured.
async function bootOrSkip(t) {
  try {
    return await bootUi();
  } catch (e) {
    t.skip(`could not boot headless Chromium (/usr/bin/chromium): ${e.message}`);
    return null;
  }
}

// ===========================================================================
// LEAK 1 — the entry editor keeps entry A while the app re-targets it at B.
//
// public/js/components/entryeditor.js loads its record in an effect with an
// EMPTY dependency list, and app.js mounts the component with no key:
//
//   useEffect(() => { … api.get(`/api/entries/${spec.id}`) … }, []);   // eslint-disable-line
//   ${editor ? html`<${EntryEditor} spec=${editor} settings=… />` : null}
//
// so a second `setEditor({ id })` while the dialog is up re-renders the SAME
// instance and the load never runs again. `entry`, `local` (matter, narrative,
// hours, task lines, custom values), `aiUndo` and `entryRef` all stay on the
// first record, and the autosave PATCHes `entryRef.current.id`.
//
// The float window's "Open entry" button does exactly that: pip.js dispatches
// `tk:open-entry` on the MAIN window and app.js answers it with
// setEditor({ id: e.detail.id }), with no check for a dialog already open.
//
// Measured: the dialog opened for the Northgate entry shows Acme's narrative
// and "Acme lease dispute" in the Matter row, and every keystroke autosaves
// onto ACME's entry.
// ===========================================================================
test('LEAK (expected to fail until fixed): the open entry editor ignores the record it is re-opened for',
  { skip: SKIP }, async (t) => {
    const u = await bootOrSkip(t);
    if (!u) return;

    const page = await u.browser.newPage();
    t.after(() => page.close());
    await page.setViewport({ width: 1440, height: 900 });
    await page.goto(`${u.base}/#/day/${u.today}`, { waitUntil: 'networkidle0' });
    await page.evaluate((h) => { window.location.hash = h; }, `#/day/${u.today}`);
    await sleep(600);

    // Open the editor on the ACME entry, the ordinary way (the row's matter
    // name is the open affordance).
    await page.waitForSelector('.entry-card .entry-open', { timeout: 10_000 });
    await page.evaluate(() => {
      [...document.querySelectorAll('.entry-card .entry-open')]
        .find((b) => b.textContent.includes('Acme')).click();
    });
    await page.waitForSelector('.narrative-preview textarea', { timeout: 10_000 });
    await sleep(400);
    const opened = await page.evaluate(() => ({
      narrative: document.querySelector('.narrative-preview textarea')?.value,
      matter: document.querySelector('.ed-row-matter .cm-value-name')?.textContent,
    }));
    assert.equal(opened.matter, 'Acme lease dispute', 'sanity: the editor opened on Acme');
    assert.equal(opened.narrative, ACME_NARRATIVE, 'sanity: showing Acme\'s narrative');

    // Now the float's "Open entry", for the NORTHGATE entry — pip.js verbatim.
    await page.evaluate((id) => {
      window.dispatchEvent(new CustomEvent('tk:open-entry', { detail: { id } }));
    }, u.northgateEntry.id);
    await sleep(700);
    const shown = await page.evaluate(() => ({
      narrative: document.querySelector('.narrative-preview textarea')?.value,
      matter: document.querySelector('.ed-row-matter .cm-value-name')?.textContent,
      panels: document.querySelectorAll('.ovl-panel').length,
    }));

    // Whatever it shows, the lawyer types into the field he believes is
    // Northgate's. The editor autosaves on a 600ms debounce.
    await page.focus('.narrative-preview textarea');
    await page.keyboard.type(' Call with opposing counsel re the notice.');
    await sleep(2000);
    const acmeAfter = await u.api('GET', `/api/entries/${u.acmeEntry.id}`);
    const northAfter = await u.api('GET', `/api/entries/${u.northgateEntry.id}`);

    assert.equal(shown.panels, 1, 'sanity: still exactly one dialog');
    assert.equal(
      shown.matter, 'Northgate diligence',
      `LEAK: the editor re-opened for the Northgate entry still names "${shown.matter}" as its matter`,
    );
    assert.equal(
      shown.narrative, NORTHGATE_NARRATIVE,
      `LEAK: the editor re-opened for the Northgate entry shows ${JSON.stringify(shown.narrative)} `
      + '— Acme Holdings\' billing sentence, under Northgate Partners\' record',
    );
    assert.equal(
      acmeAfter.narrative, ACME_NARRATIVE,
      'LEAK: typing in the dialog opened for Northgate silently rewrote the ACME entry',
    );
    assert.notEqual(
      northAfter.narrative, NORTHGATE_NARRATIVE,
      'LEAK: the narrative the lawyer typed never reached the entry he opened',
    );
  });

// ===========================================================================
// LEAK 2 — quick capture files the sentence you replaced.
//
// public/js/components/quickcapture.js keeps the server's parse in `parsed`
// and refreshes it on a 200ms debounce. Enter commits `parsed` — both
// `parsed.matches[matterIdx]` (the matter) and `parsed.narrative` (the
// sentence) — so a line corrected in place and committed inside that window
// files a sentence that is no longer on screen against the client that
// sentence named.
//
//   const matter = pickMatter || (parsed && parsed.matches[matterIdx]) || null;
//   …
//   await api.post('/api/entries', { … cm_id: matter.id, narrative: parsed.narrative … });
//
// `onInput` drops the stale parse only when the line falls under three
// characters (`setParsed(null)`), which covers a select-all retype and nothing
// else — so correcting the matter IN PLACE is the dangerous edit, and it is
// the natural one.
// ===========================================================================
test('LEAK (expected to fail until fixed): quick capture files the sentence you replaced',
  { skip: SKIP }, async (t) => {
    const u = await bootOrSkip(t);
    if (!u) return;

    const page = await u.browser.newPage();
    t.after(() => page.close());
    await page.setViewport({ width: 1440, height: 900 });
    await page.goto(`${u.base}/#/`, { waitUntil: 'networkidle0' });
    await sleep(600);
    await page.keyboard.press('q');
    await page.waitForSelector('.qc-card input[type=text]', { timeout: 10_000 });
    await page.focus('.qc-card input[type=text]');

    // Sentence one, parsed and confirmed on screen.
    await page.keyboard.type('acme lease dispute review notice .3', { delay: 10 });
    await page.waitForSelector('.qc-chip.on', { timeout: 10_000 });
    await sleep(400);

    // Wrong matter at the head of the line. Fix it in place and commit with
    // Enter — the key this dialog is built around. The line never falls under
    // three characters, so the Acme parse is never dropped, and Enter lands
    // inside the 200ms re-parse debounce.
    await page.keyboard.press('Home');
    for (let i = 0; i < 'acme lease dispute'.length; i += 1) {
      await page.keyboard.press('Delete'); // eslint-disable-line no-await-in-loop
    }
    await page.keyboard.type('northgate diligence', { delay: 0 });
    const onScreen = await page.evaluate(() => document.querySelector('.qc-card input[type=text]').value);
    await page.keyboard.press('Enter');
    await sleep(1500);

    assert.equal(onScreen, 'northgate diligence review notice .3', 'sanity: the corrected line');
    const entries = await u.api('GET', `/api/entries?from=${u.today}&to=${u.today}`);
    const filed = entries.filter((e) => (e.narrative || '').includes('review notice'));
    assert.equal(filed.length, 1, 'sanity: exactly one entry was filed');
    assert.equal(
      filed[0].cm.short_name, 'Northgate diligence',
      'LEAK: the line on screen named Northgate; quick capture filed the previous sentence\'s parse '
      + `— ${filed[0].total}h against ${filed[0].cm.short_name}, narrative ${JSON.stringify(filed[0].narrative)}`,
    );
  });
