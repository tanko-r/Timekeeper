// ===========================================================================
// MATTER FENCE — REGRESSION TESTS for the client surfaces that suggest, offer
// or write a NARRATIVE.
//
// The standard is docs/ui/BRIEF.md, "Data integrity: non-negotiable, and above
// every other rule here":
//
//   "A narrative written for matter A may never be shown as belonging to,
//    suggested for, pre-filled into, or written onto an entry for matter B.
//    Not across clients, and not between two matters of the SAME client."
//   "…generic language… the phrasebook, ghost text, and text expansions… are
//    SUPPOSED to be shared across every matter."
//
// So the line these tests draw is between a whole client-facing SENTENCE (never
// shared) and reusable WORDING (shared, and deliberately left alone here).
//
// Four defects were proved against a real database before these were written.
// Each test below FAILED on the code as it stood and passes on the fix:
//
//   F1  the stop offer outlived the matter it was built for — the entry was
//       re-pointed at another client and the offer kept its heading, its
//       "already saved" caption and the OLD matter's sentence under key cap 1
//   F2  a sibling matter's real billing narratives were rendered as chips,
//       each wearing the ⟲ icon and "You wrote this on this matter before"
//   F3  close-out pre-filled a cold matter's box with a sibling's sentence,
//       and Finalize & export saves every box that has text
//   F4  quick capture filed the PREVIOUS sentence's parse when Enter landed
//       inside the 200ms re-parse debounce — the line on screen said one
//       client, the entry was written against another
//
// All four are React-lifecycle/browser defects, so all four are driven through
// the real UI: the real server on a temp database, the shipped app in headless
// Chromium, and SQLite read directly afterwards. One server and one browser are
// shared by the whole file.
//
// Set TK_SKIP_UI_PROOF=1 to skip (e.g. while a screenshot run owns the cores).
// ===========================================================================
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SKIP = process.env.TK_SKIP_UI_PROOF === '1';

// House fictional names only (BRIEF: no real client, matter or firm data).
// Two matters of the SAME client plus a second client, because the brief bans
// the crossing at both widths.
const LEASE = 'Acme lease dispute';   // Acme Holdings — worked
const PERMIT = 'Acme permit renewal'; // Acme Holdings — cold SIBLING of LEASE
const NORTH = 'Northgate diligence';  // Northgate Partners — a different client

// Whole client-facing sentences, unmistakably about one matter each.
const LEASE_1 = 'Reviewed the landlord termination notice and the underlying lease';
const LEASE_2 = 'Telephone conference with W. Hammond regarding the estoppel certificate';
const NORTH_1 = 'Reviewed the data room index and flagged three missing consents';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const todayLocal = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1)
  .padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const daysAgo = (n) => todayLocal(new Date(Date.now() - n * 86_400_000));

let ui = null;

async function bootUi() {
  if (ui) return ui;
  process.env.TZ = process.env.TZ || 'America/Los_Angeles';
  const { openDb } = await import('../server/db.js');
  const { createApp } = await import('../server/app.js');
  const puppeteer = (await import('puppeteer-core')).default;

  const dir = mkdtempSync(join(tmpdir(), 'tk-fence-'));
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

  const lease = await api('POST', '/api/cms', {
    cm_number: '100001-000010', short_name: LEASE, client_name: 'Acme Holdings', billable: 1,
  });
  const permit = await api('POST', '/api/cms', {
    cm_number: '100001-000020', short_name: PERMIT, client_name: 'Acme Holdings', billable: 1,
  });
  const north = await api('POST', '/api/cms', {
    cm_number: '100244-000002', short_name: NORTH, client_name: 'Northgate Partners', billable: 1,
  });

  // LEASE gets a worked history: one substantive task line each, so the
  // narrative itself enters the phrasebook (routes/matters.js FREE_NARRATIVE).
  // PERMIT gets nothing — it is the cold sibling the blend fires on.
  for (const [n, ago] of [[LEASE_1, 2], [LEASE_2, 5]]) {
    await api('POST', '/api/entries', {
      date: daysAgo(ago), cm_id: lease.id, narrative: n,
      tasks: [{ task_code: 'Review', duration: 0.6, fragment: '' }],
    });
  }
  await api('POST', '/api/entries', {
    date: daysAgo(3), cm_id: north.id, narrative: NORTH_1,
    tasks: [{ task_code: 'Review', duration: 0.4, fragment: '' }],
  });

  ui = {
    base,
    api,
    browser,
    db,
    today: todayLocal(),
    lease,
    permit,
    north,
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
  if (SKIP) { t.skip('TK_SKIP_UI_PROOF=1'); return null; }
  try {
    return await bootUi();
  } catch (e) {
    t.skip(`browser/server unavailable: ${e.message}`);
    return null;
  }
}

// A page that records every write it makes, so a test can assert not only what
// reached the database but what the client actually PUT ON THE WIRE.
async function newPage(u, { width = 1440, height = 900 } = {}) {
  const page = await u.browser.newPage();
  await page.setViewport({ width, height });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.evaluateOnNewDocument(() => {
    window.__writes = [];
    const real = window.fetch;
    window.fetch = (input, init) => {
      const method = (init && init.method) || 'GET';
      if (method !== 'GET' && init && init.body) {
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        try { window.__writes.push({ method, url, body: JSON.parse(init.body) }); } catch { /* not json */ }
      }
      return real(input, init);
    };
  });
  await page.goto(`${u.base}/#/`, { waitUntil: 'networkidle0' });
  await sleep(500);
  page.__errors = errors;
  return page;
}

const writes = (page) => page.evaluate(() => window.__writes.slice());

// The stopped row's offer, exactly as a lawyer sees it.
const readOffer = (page) => page.evaluate(() => {
  const el = document.querySelector('.stop-chips');
  if (!el) return null;
  return {
    head: el.querySelector('.stop-chips-head')?.textContent.replace(/\s+/g, ' ').trim() || '',
    settled: el.querySelector('[data-stop-settled]')?.getAttribute('data-stop-settled') || null,
    notes: [...el.querySelectorAll('.stop-chips-note')].map((n) => n.textContent.replace(/\s+/g, ' ').trim()),
    chips: [...el.querySelectorAll('.chip-btn')].map((b) => ({
      text: b.querySelector('span')?.textContent.trim() || '',
      title: b.getAttribute('title') || '',
      icons: [...b.querySelectorAll('svg')].map((s) => s.getAttribute('data-icon') || s.classList.value),
    })),
    hasField: !!el.querySelector('.stop-chips-write textarea'),
  };
});

async function startAndStop(page, u, cmId, name) {
  const timer = await u.api('POST', '/api/timers', { name, cm_id: cmId });
  await u.api('POST', `/api/timers/${timer.id}/start`, { minutesAgo: 10 });
  await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForSelector(`.today-list .work-row[data-timer-id="${timer.id}"]`, { timeout: 10_000 });
  await page.click(`.work-row[data-timer-id="${timer.id}"] .timer-stop-btn`);
  await page.waitForSelector('.stop-chips', { timeout: 10_000 });
  await sleep(900); // the suggestions fetch and the unasked pre-fill both land
  const entry = u.db.prepare(
    'SELECT id, cm_id, narrative FROM entries WHERE id = (SELECT linked_entry_id FROM timers WHERE id=?)',
  ).get(timer.id);
  return { timer, entry };
}

// ---------------------------------------------------------------------------
// F2 — A BORROWED SENTENCE IS NEVER A CHIP, AND NEVER CLAIMS PROVENANCE.
//
// PERMIT has no history of its own, so /api/matters/:id/suggestions blends in
// its SIBLING's (source: 'client') and routes/timers.js stamps the same
// borrowed sentence onto the timer as `suggested_narrative`. Both routes into
// the offer are fenced: nothing borrowed may be a chip at all, so nothing
// borrowed can carry the ⟲ "You wrote this on this matter before" title, and
// nothing borrowed can be one tap from the database.
// ---------------------------------------------------------------------------
test('F2: a cold matter is offered no sentence from its sibling, under any label',
  { skip: SKIP }, async (t) => {
    const u = await bootOrSkip(t);
    if (!u) return;
    const page = await newPage(u);
    t.after(() => page.close());

    const { entry } = await startAndStop(page, u, u.permit.id, 'Permit work');
    const offer = await readOffer(page);
    assert.ok(offer, 'the stop offer should be on the stopped row');
    const shot = JSON.stringify(offer, null, 1);

    for (const borrowed of [LEASE_1, LEASE_2, NORTH_1]) {
      assert.ok(!offer.chips.some((c) => c.text.includes(borrowed.slice(0, 40))),
        `LEAK: ${PERMIT}'s stop offer put another matter's sentence one tap from its entry.\n${shot}`);
      assert.ok(!offer.chips.some((c) => c.title.includes(borrowed.slice(0, 40))),
        `LEAK: another matter's sentence is in a chip title.\n${shot}`);
      assert.ok(!(offer.settled || '').includes(borrowed.slice(0, 40)),
        `LEAK: another matter's sentence is shown as this entry's saved narrative.\n${shot}`);
    }
    assert.deepEqual(
      offer.chips.filter((c) => c.title.startsWith('You wrote this on this matter before')
        && [LEASE_1, LEASE_2, NORTH_1].some((n) => c.title.includes(n.slice(0, 40)))).map((c) => c.text),
      [],
      `LEAK: the offer claims another matter's work as this matter's own history.\n${shot}`,
    );

    // …and the brief's positive half: with nothing of its own to offer, the
    // offer asks rather than borrows.
    assert.ok(offer.hasField,
      `a matter with no wording of its own must be given the narrative field.\n${shot}`);

    // Nothing was written unasked, either.
    const row = u.db.prepare('SELECT narrative, cm_id FROM entries WHERE id=?').get(entry.id);
    assert.equal(String(row.narrative || '').trim(), '',
      `LEAK: a sentence was written to ${PERMIT}'s entry with no tap: ${JSON.stringify(row)}`);
  });

// ---------------------------------------------------------------------------
// F1 — THE OFFER MAY NOT OUTLIVE THE MATTER IT WAS BUILT FOR.
//
// The proved sequence, entirely in-app: stop the LEASE timer (the offer writes
// LEASE's own top sentence unasked and says "already saved"), open the row menu
// → "Open entry…", change the matter to a DIFFERENT CLIENT's, press Done. The
// offer is still mounted, its heading still names the old matter, its caption
// still says "already saved", and the old matter's SECOND sentence is still on
// offer under key cap 1 — one tap, or one keystroke, from that client's bill.
// ---------------------------------------------------------------------------
test('F1: an entry re-pointed at another matter takes its stop offer down with it',
  { skip: SKIP }, async (t) => {
    const u = await bootOrSkip(t);
    if (!u) return;
    const page = await newPage(u);
    t.after(() => page.close());

    const { timer, entry } = await startAndStop(page, u, u.lease.id, 'Lease work');
    const before = await readOffer(page);
    assert.ok(before && before.settled, `precondition: the offer pre-fills LEASE's own sentence — ${JSON.stringify(before)}`);
    assert.ok(before.chips.length > 0,
      `precondition: LEASE's second sentence is on offer as an alternative — ${JSON.stringify(before)}`);
    const alternative = before.chips[0].text;

    // Every write this surface makes names the matter it was built for.
    const prefill = (await writes(page)).find((w) => w.method === 'PATCH' && w.url.includes(`/api/entries/${entry.id}`));
    assert.ok(prefill, 'precondition: the unasked pre-fill PATCHes the entry');
    assert.equal(prefill.body.source_cm_id, u.lease.id,
      `the pre-fill must name the matter it drew from — ${JSON.stringify(prefill.body)}`);

    // ---- the row menu → Open entry… → change the matter → Done ----
    await page.click(`.work-row[data-timer-id="${timer.id}"] button[title="Row menu"]`);
    await page.waitForSelector('.ctx-menu', { timeout: 5000 });
    await page.evaluate(() => {
      const el = [...document.querySelectorAll('.ctx-menu button')]
        .find((b) => /Open (entry|0)/.test(b.textContent));
      el.click();
    });
    await page.waitForSelector('.ed-panel .ed-row-matter', { timeout: 10_000 });
    // The row variant shows the picked matter as a button until it is opened.
    await page.click('.ed-row-matter .cm-value');
    await page.waitForSelector('.ed-row-matter .cmpicker input', { timeout: 8000 });
    await page.type('.ed-row-matter .cmpicker input', 'Northgate', { delay: 10 });
    await page.waitForFunction((name) => [...document.querySelectorAll('.cmpicker-item .name')]
      .some((n) => n.textContent.includes(name)), { timeout: 8000 }, NORTH);
    // A real mouse press: the picker commits on mousedown, the way a listbox
    // should, so a synthesized element.click() never reaches it.
    const box = await page.evaluate((name) => {
      const el = [...document.querySelectorAll('.cmpicker-item')]
        .find((x) => x.textContent.includes(name));
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }, NORTH);
    await page.mouse.click(box.x, box.y);
    await sleep(500);
    await page.click('.ed-done');
    await sleep(1500);

    // The entry really did move — otherwise the rest proves nothing.
    const moved = u.db.prepare('SELECT cm_id, narrative FROM entries WHERE id=?').get(entry.id);
    assert.equal(moved.cm_id, u.north.id, 'precondition: the entry is on the other client now');

    // 1. THE SURFACE IS GONE. Not re-dressed, not re-captioned: gone, because
    //    every part of it described a matter this entry no longer has.
    const after = await readOffer(page);
    assert.equal(after, null,
      'LEAK: the stop offer is still mounted on an entry that moved to another matter — '
      + `it still reads ${JSON.stringify(after)}`);

    // 2. AND ITS HOT KEYS ARE DEAD. `1` picked the old matter's alternative
    //    from anywhere on the page for 90 seconds after a stop.
    const narrativeBefore = String(moved.narrative || '');
    await page.keyboard.press('1');
    await sleep(1200);
    const now = u.db.prepare('SELECT narrative FROM entries WHERE id=?').get(entry.id);
    assert.equal(String(now.narrative || ''), narrativeBefore,
      `LEAK: the retired offer's key cap 1 still wrote ${JSON.stringify(now.narrative)} onto `
      + `${NORTH}'s entry`);
    assert.ok(!String(now.narrative || '').includes(alternative.slice(0, 40)),
      `LEAK: ${LEASE}'s alternative sentence reached ${NORTH}'s entry`);
  });

// ---------------------------------------------------------------------------
// F3 — CLOSE-OUT MAY NOT PRE-FILL A BORROWED SENTENCE.
//
// The panel maps the suggestions endpoint into the row's textarea and
// "Finalize & export" saves every box that has text, so a pre-fill IS a write.
// A cold matter's box must therefore be EMPTY rather than borrowed: the entry
// stays a draft, which is what the panel already promises, and nothing is lost.
// ---------------------------------------------------------------------------
test('F3: close-out leaves a cold matter\'s box empty rather than borrowing a sentence',
  { skip: SKIP }, async (t) => {
    const u = await bootOrSkip(t);
    if (!u) return;
    const page = await newPage(u);
    t.after(() => page.close());

    // A draft on the cold sibling, with no narrative, exactly as a stop leaves it.
    const draft = await u.api('POST', '/api/entries', {
      date: u.today, cm_id: u.permit.id, narrative: '',
      tasks: [{ task_code: 'Review', duration: 0.5, fragment: '' }],
    });
    await page.reload({ waitUntil: 'networkidle0' });
    await sleep(400);
    await page.keyboard.press('c');
    await page.waitForSelector('.closeout-card .co-item textarea', { timeout: 10_000 });
    await sleep(900); // the per-matter suggestion fetches land

    const boxes = await page.evaluate(() => [...document.querySelectorAll('.closeout-card .co-item')]
      .map((li) => ({
        matter: li.querySelector('.co-item-head strong')?.textContent.trim() || '',
        value: li.querySelector('textarea')?.value || '',
      })));
    const box = boxes.find((b) => b.matter.includes(PERMIT));
    assert.ok(box, `precondition: ${PERMIT} has a row in the sweep — ${JSON.stringify(boxes)}`);
    for (const borrowed of [LEASE_1, LEASE_2, NORTH_1]) {
      assert.ok(!box.value.includes(borrowed.slice(0, 40)),
        `LEAK: close-out pre-filled ${PERMIT} with another matter's sentence — ${JSON.stringify(box)}`);
    }
    assert.equal(box.value, '',
      `a cold matter's box must fall back to empty, not to borrowed words — ${JSON.stringify(box)}`);

    // …and the panel's own arithmetic agrees: an empty box stays a draft.
    const will = await page.$eval(`.co-item[data-entry-id="${draft.id}"]`, (el) => el.dataset.will);
    assert.equal(will, 'stay', 'an empty box must be counted as staying a draft');

    await page.keyboard.press('Escape');
    await sleep(300);
    const row = u.db.prepare('SELECT narrative FROM entries WHERE id=?').get(draft.id);
    assert.equal(String(row.narrative || '').trim(), '',
      `LEAK: close-out wrote ${JSON.stringify(row.narrative)} onto ${PERMIT}'s entry`);
    await u.api('DELETE', `/api/entries/${draft.id}`);
  });

// ---------------------------------------------------------------------------
// F4 — QUICK CAPTURE FILES THE LINE ON SCREEN, NEVER THE ONE BEFORE IT.
//
// The parse is debounced 200ms and the last one stays visible while the next is
// in flight. Enter inside that window filed the PREVIOUS sentence's parse —
// its matter ranking included — so a corrected client name on screen went to
// the database as the client it replaced. Time and a billing sentence filed
// against the wrong client, from the app's fastest path.
// ---------------------------------------------------------------------------
test('F4: quick capture never files the matter of the sentence you replaced',
  { skip: SKIP }, async (t) => {
    const u = await bootOrSkip(t);
    if (!u) return;
    const page = await newPage(u);
    t.after(() => page.close());

    await page.keyboard.press('q');
    await page.waitForSelector('.qc-card input[type=text]', { timeout: 10_000 });
    await page.focus('.qc-card input[type=text]');
    await page.keyboard.type('acme lease dispute review notice .3', { delay: 10 });
    await page.waitForSelector('.qc-chip.on', { timeout: 10_000 });
    await sleep(400);

    // Correct the matter at the head of the line and commit with Enter — the
    // key this dialog is built around — inside the re-parse window.
    await page.keyboard.press('Home');
    for (let i = 0; i < 'acme lease dispute'.length; i += 1) {
      await page.keyboard.press('Delete'); // eslint-disable-line no-await-in-loop
    }
    await page.keyboard.type('northgate diligence', { delay: 0 });
    const onScreen = await page.$eval('.qc-card input[type=text]', (el) => el.value);
    await page.keyboard.press('Enter');
    await sleep(2000);

    assert.equal(onScreen, 'northgate diligence review notice .3', 'sanity: the corrected line');
    const filed = u.db.prepare(
      "SELECT id, cm_id, narrative FROM entries WHERE narrative LIKE '%review notice%' AND deleted_at IS NULL",
    ).all();
    assert.equal(filed.length, 1, `sanity: exactly one entry was filed — ${JSON.stringify(filed)}`);
    assert.equal(filed[0].cm_id, u.north.id,
      `LEAK: the line on screen named ${NORTH}; quick capture filed the previous parse — `
      + JSON.stringify(filed[0]));
    await u.api('DELETE', `/api/entries/${filed[0].id}`);
  });

// ---------------------------------------------------------------------------
// THE WHOLE DATABASE, AFTER EVERYTHING ABOVE.
//
// The tests above each check the entry they touched. This one asks the question
// the brief actually asks — of every row that exists: does any entry hold a
// sentence that belongs to a different matter? It runs last, and it is the
// assertion that would catch a leak through a path nobody thought to drive.
// ---------------------------------------------------------------------------
test('NO ENTRY HOLDS ANOTHER MATTER\'S SENTENCE', { skip: SKIP }, async (t) => {
  const u = await bootOrSkip(t);
  if (!u) return;
  const owner = { [LEASE_1]: u.lease.id, [LEASE_2]: u.lease.id, [NORTH_1]: u.north.id };
  const rows = u.db.prepare(`
    SELECT e.id, e.cm_id, e.narrative, m.short_name FROM entries e
    LEFT JOIN matters m ON m.id = e.cm_id WHERE e.deleted_at IS NULL`).all();
  for (const row of rows) {
    const text = String(row.narrative || '');
    for (const [sentence, cmId] of Object.entries(owner)) {
      if (!text.includes(sentence.slice(0, 40))) continue;
      assert.equal(row.cm_id, cmId,
        `LEAK: entry ${row.id} on "${row.short_name}" holds a sentence written for another matter: `
        + JSON.stringify(text));
    }
  }
  assert.ok(rows.length >= 3, 'sanity: the fixtures are still here');
});
