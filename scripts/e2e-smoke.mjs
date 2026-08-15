// End-to-end smoke test: boots the real server on a scratch database, drives
// the SPA in headless Chromium, and fails on any console/page error.
// Usage: node scripts/e2e-smoke.mjs [--screenshots DIR]
import { mkdtempSync, rmSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';

process.env.TZ = process.env.TZ || 'America/Los_Angeles';

const shotDirArg = process.argv.indexOf('--screenshots');
const SHOT_DIR = shotDirArg > -1 ? process.argv[shotDirArg + 1] : null;
if (SHOT_DIR) mkdirSync(SHOT_DIR, { recursive: true });

const { openDb } = await import('../server/db.js');
const { createApp } = await import('../server/app.js');
const { startJobs } = await import('../server/jobs.js');

const dir = mkdtempSync(join(tmpdir(), 'tk-e2e-'));
const db = openDb(join(dir, 'e2e.db'));
const config = { DATA_DIR: dir, PUBLIC_HOSTNAME: 'time.example.test' };
const deps = { db, config, clock: () => new Date() };
const app = createApp(deps);
const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const base = `http://127.0.0.1:${server.address().port}`;
startJobs(deps);

const problems = [];
const browser = await puppeteer.launch({
  executablePath: '/usr/bin/chromium',
  headless: 'new',
  // auto-accept-this-tab-capture: getDisplayMedia({preferCurrentTab}) resolves
  // without the share-tab picker, so the Alt+drag feedback step exercises the
  // real screenshot path.
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--auto-accept-this-tab-capture'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 900 });
page.on('console', (msg) => {
  if (msg.type() === 'error') problems.push(`console.error: ${msg.text()}`);
});
page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));
page.on('requestfailed', (req) => problems.push(`requestfailed: ${req.url()} ${req.failure()?.errorText}`));

const step = async (name, fn) => {
  try {
    await fn();
    console.log(`  ✔ ${name}`);
  } catch (e) {
    problems.push(`step "${name}": ${e.message}`);
    console.log(`  ✖ ${name}: ${e.message}`);
  }
};

const shot = async (name) => {
  if (SHOT_DIR) await page.screenshot({ path: join(SHOT_DIR, `${name}.png`), fullPage: false });
};

const waitFor = (sel, t = 5000) => page.waitForSelector(sel, { timeout: t });
const type = async (sel, text) => { await waitFor(sel); await page.type(sel, text, { delay: 5 }); };
const clickText = async (selector, text) => {
  await page.waitForFunction((sel, t) =>
    [...document.querySelectorAll(sel)].some((el) => el.textContent.trim().includes(t)),
  { timeout: 5000 }, selector, text);
  const box = await page.evaluate((sel, t) => {
    const el = [...document.querySelectorAll(sel)].find((x) => x.textContent.trim().includes(t));
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, selector, text);
  await page.mouse.click(box.x, box.y);
};
// The entry editor's RARE actions — Finalize, Delete, Unlock, the AI trio and
// their undo, the even split, the audit log — moved off the face of the form
// into one "More" disclosure inside the panel (teardown §16, wave-2 F1: the
// dialog is allowed ten controls before that disclosure, and it had eighteen).
// Nothing was removed; each is one tap deeper, inside the focus trap, on a
// full-width row at the touch floor. These helpers drive them where they live.
const openEditorMore = async () => {
  await waitFor('.modal-wide [data-ed-more]');
  const already = await page.$eval('.modal-wide [data-ed-more]',
    (el) => el.getAttribute('aria-expanded') === 'true');
  if (!already) await page.click('.modal-wide [data-ed-more]');
  await waitFor('.modal-wide .ed-more-panel');
};
const editorMore = async (text) => {
  await openEditorMore();
  await clickText('.modal-wide .ed-more-item', text);
};
// One undivided task line collapses to its task code alone, because its hours
// ARE the entry total already on screen (teardown §16: "a one-line entry
// should show hours and nothing else"). This opens the real line editor.
const splitIntoTasks = async () => {
  await clickText('.modal-wide button', 'Split into tasks');
  await waitFor('.modal-wide .task-line');
};
// The timer BOARD's header (three grouping modes, a ten-tab strip, A-Z, New
// group, Import, search) collapsed into one "⋯" menu on the merged list
// (teardown E1). Nothing was removed — these helpers drive the same
// capabilities where they live now.
const openListMenu = async () => {
  await waitFor('.today-menu-btn');
  await page.click('.today-menu-btn');
  await waitFor('.ctx-menu');
};
const closeMenu = async () => {
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('.ctx-menu'), { timeout: 4000 });
};
// One of the menu's segmented controls (Show / Group / Order), by its label.
const setListSeg = async (label, text) => {
  await openListMenu();
  await page.evaluate((l, t) => {
    const seg = document.querySelector(`.ctx-menu .seg[aria-label="${l}"]`);
    const btn = [...seg.querySelectorAll('button')].find((b) => b.textContent.trim() === t);
    if (!btn) throw new Error(`no "${t}" in the ${l} control`);
    btn.click();
  }, label, text);
  await closeMenu();
};
const listSegOn = async (label) => {
  await openListMenu();
  const on = await page.evaluate((l) => document.querySelector(`.ctx-menu .seg[aria-label="${l}"] button.on`)?.textContent.trim(), label);
  await closeMenu();
  return on;
};
// "Only this group/client" — the isolation the tab strip used to do.
const setOnly = async (labelOrEmpty) => {
  await openListMenu();
  // Flat grouping has no sections to isolate, so the control is not there —
  // clearing an isolation that cannot exist is a no-op, not a failure.
  if (!await page.$('.ctx-menu select')) { await closeMenu(); return; }
  await page.evaluate((want) => {
    const sel = document.querySelector('.ctx-menu select');
    const opt = want
      ? [...sel.options].find((o) => o.textContent.includes(want))
      : sel.options[0];
    if (!opt) throw new Error(`no "${want}" in the Only control`);
    sel.value = opt.value;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  }, labelOrEmpty);
  await closeMenu();
};
// Drop a row onto a group SECTION (the tabs it used to be dropped on are gone;
// the section itself is the drop target, and the row menu's "Group" select is
// the touch equivalent).
const dndToSection = (sourceSel, headText) => page.evaluate((srcSel, text) => {
  const src = document.querySelector(srcSel);
  const tgt = [...document.querySelectorAll('.timer-section')]
    .find((sec) => sec.querySelector('.group-head')?.textContent.includes(text));
  if (!src || !tgt) throw new Error(`dndToSection: missing element (row=${!!src}, section "${text}"=${!!tgt})`);
  const dt = new DataTransfer();
  src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
  tgt.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
  tgt.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
}, sourceSel, headText);
const sectionCount = (headText) => page.evaluate((text) => {
  const sec = [...document.querySelectorAll('.timer-section')]
    .find((x) => x.querySelector('.group-head')?.textContent.includes(text));
  return sec ? sec.querySelectorAll('.work-row').length : -1;
}, headText);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Global shortcuts are deliberately dead while the caret sits in a field, and
// the dashboard now carries an always-visible quick-capture input — so a step
// that means "press n as a global shortcut" has to leave the field first.
const pressGlobal = async (key) => {
  await page.evaluate(() => document.activeElement?.blur?.());
  await page.keyboard.press(key);
};
const todayLocal = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

console.log(`E2E against ${base}`);

await step('app shell renders (dashboard, SVG icons)', async () => {
  await page.goto(base, { waitUntil: 'networkidle0' });
  await waitFor('.sidebar .brand svg');
  // A brand-new account has no timers and no entries, so the list shows its
  // designed empty state rather than the bare "+ New timer" row.
  await waitFor('.today-list .blankslate');
});

await step('PWA shell files are reachable (manifest.json, sw.js) — cheap reachability check, not a full SW-lifecycle test (headless SW registration is flaky)', async () => {
  const manifestRes = await fetch(`${base}/manifest.json`);
  if (!manifestRes.ok) throw new Error(`manifest.json fetch failed: ${manifestRes.status}`);
  const manifest = await manifestRes.json();
  if (manifest.name !== 'Timekeeper') throw new Error(`manifest.json missing expected name: ${JSON.stringify(manifest)}`);
  if (!Array.isArray(manifest.icons) || manifest.icons.length < 2) throw new Error('manifest.json missing icons');

  const swRes = await fetch(`${base}/sw.js`);
  if (!swRes.ok) throw new Error(`sw.js fetch failed: ${swRes.status}`);
  const swBody = await swRes.text();
  if (!swBody.includes('/api/')) throw new Error('sw.js does not appear to guard /api/ requests');
});

await step('spike page is reachable (public/spike-webllm.html) — cheap static-file check; actual WebGPU/WebLLM cannot run in this headless harness (no GPU, and it CDN-loads a multi-GB model)', async () => {
  const res = await fetch(`${base}/spike-webllm.html`);
  if (!res.ok) throw new Error(`spike-webllm.html fetch failed: ${res.status}`);
  const body = await res.text();
  if (!body.includes('SPIKE')) throw new Error('spike-webllm.html missing "SPIKE" banner text');
});

await step('create client+matter through picker (client→matter path, prefilled)', async () => {
  await pressGlobal('n');
  await waitFor('.modal .cmpicker input');
  await type('.modal .cmpicker input', '100001-000012');
  await clickText('.cmpicker-item .name', 'New client/matter');
  await waitFor('[data-nc-matter]');
  // typed CM number pre-splits into client + matter numbers
  const cpre = await page.$eval('[data-nc-client]', (el) => el.value);
  if (cpre !== '100001') throw new Error(`client prefill wrong: ${cpre}`);
  const mpre = await page.$eval('[data-nc-matter]', (el) => el.value);
  if (mpre !== '000012') throw new Error(`matter prefill wrong: ${mpre}`);
  // Client name is REQUIRED for brand-new clients created via the modal
  // (feedback 2026-07-10). This scenario needs 100001 to stay UNNAMED (later
  // steps cover number-as-label and "+ Name this client", still reachable via
  // CSV import) — so verify the prefill, cancel, and seed via the API instead.
  await clickText('.modal button', 'Cancel');
  const seed = await fetch(`${base}/api/cms`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cm_number: '100001-000012', short_name: 'Acme lease dispute', billable: 1 }),
  });
  if (seed.status !== 201) throw new Error(`API seed of 100001-000012 failed: ${seed.status}`);
  // back in the still-open entry editor: pick the seeded matter via the picker
  // (clear the leftover typed number through React's controlled-input path)
  await page.evaluate(() => {
    const input = document.querySelector('.modal .cmpicker input');
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    set.call(input, '');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.click('.modal .cmpicker input');
  await page.type('.modal .cmpicker input', 'Acme lease', { delay: 5 });
  await clickText('.cmpicker-item .name', 'Acme lease dispute');
  await sleep(400);
});

await step('entry: total + task line + narrative autosave, allocation chip', async () => {
  // total drives the single line
  await page.evaluate(() => {
    const modal = document.querySelector('.modal-wide');
    const total = modal.querySelector('.total-input');
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    set.call(total, '1.2');
    total.dispatchEvent(new Event('input', { bubbles: true }));
  });
  // task code is hidden behind a "+ code" affordance by default (no <select>
  // until it's clicked) — click it, choose a code, and it collapses to a chip.
  // On an undivided entry that affordance is the collapsed task-code ROW; the
  // markup is the same either way (entryeditor.js renders one taskCodeCell).
  if (await page.$('.modal-wide .task-code-cell select')) throw new Error('task-code <select> must be hidden by default');
  await page.click('.modal-wide .task-code-add');
  await waitFor('.modal-wide .task-code-cell select');
  await page.evaluate(() => {
    const modal = document.querySelector('.modal-wide');
    const select = modal.querySelector('.task-code-cell select');
    select.value = 'Review';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await waitFor('.modal-wide .task-code-chip');
  await page.type('.modal-wide textarea', 'Reviewed lease agreement and drafted renewal-terms summary for client.');
  await page.waitForFunction(
    () => document.querySelector('.saving-dot')?.textContent.includes('Saved'),
    { timeout: 6000 });
  // "Split into tasks" divides an undivided entry. This narrative has no
  // semicolons to split at, so it opens the line editor with a second line —
  // whose hours default to the remainder, keeping the allocation clean.
  await splitIntoTasks();
  await page.waitForFunction(() => document.querySelectorAll('.modal-wide .task-line').length === 2);
  const lineVal = await page.$eval('.modal-wide .task-line:nth-of-type(2) input[type="number"]',
    (el) => el.value);
  if (Number(lineVal) !== 0) throw new Error(`remainder default wrong: ${lineVal}`);
  // …and "Add task line" still adds one on top of that
  await clickText('.modal-wide button', 'Add task line');
  await page.waitForFunction(() => document.querySelectorAll('.modal-wide .task-line').length === 3);
  const removeLine = async (i) => {
    await page.evaluate((idx) => {
      [...document.querySelectorAll('.modal-wide .task-line')][idx]
        .querySelector('button[title="Remove line"]').click();
    }, i);
    await sleep(150);
  };
  await removeLine(2); // remove them again, one render apart
  await removeLine(1);
  await page.waitForFunction(() => document.querySelectorAll('.modal-wide .task-line').length === 1);
  await shot('editor');
});

await step('finalize entry from editor (via the More disclosure)', async () => {
  await editorMore('Finalize');
  await page.waitForFunction(() => !document.querySelector('.modal-wide'), { timeout: 5000 });
});

await step('dashboard shows the entry and meter', async () => {
  await page.waitForFunction(
    () => document.body.textContent.includes('Acme lease dispute'), { timeout: 5000 });
  await waitFor('.meter-bar');
});

await step('persistent run bar: live total, ticking clock, close-the-day button', async () => {
  // The day footer is gone (two fixed bars on desktop Today, both saying the
  // same filed total the stat strip already said). Both of its jobs are on the
  // persistent run bar now, so this step asserts them there instead — the
  // capability is unchanged and reachable on every viewport.
  await waitFor('.runbar');
  const hasCloseBtn = await page.evaluate(() =>
    [...document.querySelectorAll('.runbar button')]
      .some((b) => /close the day/i.test(b.getAttribute('aria-label') || b.textContent || '')));
  if (!hasCloseBtn) throw new Error('run bar missing the "Close the day" button on Today');

  // The filed total is stated once per screen: on Today the day's stat strip
  // carries it (with the billable split and the target), and the run bar
  // carries it on every other screen — which is where it did not exist at all
  // before the bar (teardown D1).
  await page.waitForFunction(
    () => /\d+(\.\d+)?h/.test(document.querySelector('.daystat-hero')?.textContent || ''),
    { timeout: 4000 });
  await page.goto(`${base}/#/calendar`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(
    () => /\d+(\.\d+)?h/.test(document.querySelector('.runbar .runbar-total')?.textContent || ''),
    { timeout: 5000 });
  await page.goto(`${base}/#/`, { waitUntil: 'networkidle0' });

  // the running clock actually ticks: start a scratch timer via the API,
  // reload so the dashboard payload sees it running, watch the clock move,
  // then delete the timer so later steps see the same timer counts.
  const cms = await (await fetch(`${base}/api/cms`)).json();
  const scratch = await (await fetch(`${base}/api/timers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '__footer-tick__', cm_id: cms[0].id }),
  })).json();
  await fetch(`${base}/api/timers/${scratch.id}/start`, { method: 'POST' });
  await page.reload({ waitUntil: 'networkidle0' });
  // The live clock lives on the persistent run bar (it is visible on every
  // screen, not just this one — teardown D1).
  await waitFor('.runbar .runbar-clock');
  const before = await page.$eval('.runbar .runbar-clock', (el) => el.textContent.trim());
  await page.waitForFunction((prev) =>
    document.querySelector('.runbar .runbar-clock')?.textContent.trim() !== prev,
  { timeout: 4000 }, before);
  const del = await fetch(`${base}/api/timers/${scratch.id}`, { method: 'DELETE' });
  if (!del.ok) throw new Error(`scratch timer cleanup failed: ${del.status}`);
  await page.reload({ waitUntil: 'networkidle0' });
  await waitFor('.runbar');
});

await step('create timer; a sub-2s stop reverts as if nothing happened', async () => {
  await clickText('button', 'New timer');
  await type('.modal input[placeholder="e.g. Acme — research"]', 'Acme research');
  await page.click('.modal .cmpicker input');
  await sleep(250);
  await clickText('.cmpicker-item .name', 'Acme');
  await clickText('.modal button', 'Create');
  await waitFor('.timer-row');
  await page.click('.timer-row button[title="Start"]');
  await sleep(1200);
  await page.click('.timer-row button[title="Stop & file time"]');
  await sleep(500);
  const clock = await page.$eval('.timer-clock', (el) => el.textContent.trim());
  if (clock !== '0.0') throw new Error(`expected 0.0 tenths after misclick, got ${clock}`);
  const title = await page.$eval('.timer-clock', (el) => el.title);
  if (!title.startsWith('00:00')) throw new Error(`misclick must fully revert, got ${title}`);
});

await step('backdated start (10m ago) → stop → the entry FINISHES ITSELF, inline, no dialog', async () => {
  await page.click('.timer-row button[title="Row menu"]');
  await waitFor('.ctx-menu');
  await clickText('.ctx-menu .ctx-inline button', '10m');
  await page.waitForFunction(() => document.querySelector('.timer-row.running'), { timeout: 4000 });
  await page.click('.timer-row button[title="Stop & file time"]');
  await waitFor('.stop-chips'); // lightweight affordance…
  if (await page.$('.modal')) throw new Error('stop must not open a modal'); // …not a blocking one
  await shot('stop-chips');
  // teardown §17 / E2: the offer is a state of the row that stopped, not a
  // fixed slab floating over the middle of the page.
  const anchored = await page.$eval('.stop-chips', (el) => ({
    inRow: !!el.closest('.work-row'), position: getComputedStyle(el).position,
  }));
  if (!anchored.inRow) throw new Error(`chips are not on the stopped row: ${JSON.stringify(anchored)}`);
  // ZERO TAPS FINISH IT. This step used to click the offer's ticked chip and
  // assert that the click finished the entry. Measured across a five-entry
  // day, that tap was the whole cost of the feature — 17 interactions against
  // 12 for leaving every stop alone — because the offer had ALREADY written
  // his own top phrase and was re-offering the same sentence in chip shape.
  // The pre-fill is the capability; the chip was the tax. So the settled
  // narrative is text now, and the one-tap commit (which still exists, on
  // chips that would genuinely change the entry) is asserted in the
  // stale-surface step below, where the matter has a real alternative.
  await page.waitForFunction(() => {
    const el = document.querySelector('.stop-chips [data-stop-settled]');
    return !!el && el.getAttribute('data-stop-settled').includes('Reviewed lease agreement');
  }, { timeout: 8000 });
  if (await page.$('.ovl-panel')) throw new Error('the stop offer must not open a dialog');
  // NOTHING CHIP-SHAPED RE-OFFERS WHAT IS ALREADY ON THE ENTRY, and nothing
  // is drawn as taken unless the entry really holds it.
  const settledText = await page.$eval('.stop-chips [data-stop-settled]',
    (el) => el.getAttribute('data-stop-settled'));
  const chipTexts = await page.$$eval('.stop-chips .chip-btn',
    (els) => els.map((el) => el.textContent.replace(/\s+/g, ' ').trim()));
  if (chipTexts.some((t) => t.includes(settledText))) {
    throw new Error(`the settled narrative is re-offered as a chip: ${JSON.stringify(chipTexts)}`);
  }
  if (await page.$('.stop-chips .chip-btn[aria-pressed="true"]')) {
    throw new Error('a chip is drawn as already applied');
  }
  const rowText = await page.$eval('.today-list .work-row', (el) => el.textContent.replace(/\s+/g, ' '));
  if (!rowText.includes('Reviewed lease agreement')) {
    throw new Error(`the pre-filled narrative did not land on the row: "${rowText}"`);
  }
  // …and it really is saved, not just painted — exactly what the offer says
  // it saved, character for character.
  const dayEntries = await (await fetch(`${base}/api/entries?date=${todayLocal()}`)).json();
  if (!dayEntries.some((e) => String(e.narrative || '') === settledText)) {
    throw new Error(`nothing on the server carries the settled narrative: ${JSON.stringify(settledText)}`);
  }
  // an unasked write is reversible, through the app's own toast-with-Undo
  // pattern (up to three toasts can be on screen; earlier steps leave theirs)
  const toasts = await page.$$eval('.toast', (els) => els.map((el) => ({
    text: el.textContent, action: el.querySelector('button')?.textContent.trim(),
  })));
  if (!toasts.some((t) => t.action === 'Undo')) {
    throw new Error(`an unasked write must offer Undo, got ${JSON.stringify(toasts)}`);
  }
  // there is still a way to overrule it without opening anything
  const canChange = await page.evaluate(() => [...document.querySelectorAll('.stop-chips button')]
    .some((b) => /change the wording|write your own/i.test(b.textContent)));
  if (!canChange) throw new Error('the settled narrative has no change affordance');
  // ONE MERGED LIST, KEYED BY MATTER (wave-1b). The timer, the entry it just
  // filled and the earlier entry recorded by hand on the SAME matter are one
  // row — a timer and a record are the same work at two moments. (Before this
  // the list showed the matter twice with two different numbers.) The row
  // carries an entry line per entry, so nothing the merge folded together is
  // hidden.
  const rows = await page.$$eval('.today-list .work-row', (els) => els.length);
  if (rows < 1) throw new Error(`expected at least 1 row of today's work, got ${rows}`);
  const perRow = await page.$$eval('.today-list .work-row',
    (els) => els.map((el) => el.querySelectorAll('.work-entry').length));
  if (!perRow.some((n) => n >= 2)) {
    throw new Error(`the matter's entries did not merge onto one row: ${JSON.stringify(perRow)}`);
  }
  // leave the board clean for the next step
  await page.click('.stop-chips button[title^="Dismiss"]');
  await page.waitForFunction(() => !document.querySelector('.stop-chips'), { timeout: 4000 });
});

// ---------------------------------------------------------------------------
// THE STOP OFFER BELONGS TO ONE ENTRY  (wave-2b3 regression)
//
// The mount site renders one `<StopChips popup=…>` for whichever stop is
// current. With no key on it, React reused the SAME instance across two
// different stops: the offer re-anchored into the new entry's row and headed
// with the new entry's hours and matter, while its chips, its "already saved"
// tick and its caption were still the PREVIOUS entry's. Reproduced in the
// app's own rhythm — stop A, start B, stop B — the surface sat in Northgate's
// row, over a row reading "no narrative", offering Acme's billing narrative
// with `chip-applied` and `aria-pressed="true"` under "Written in from your
// own wording on this matter — already saved". Tapping it (or pressing the `1`
// its stale key cap advertised) wrote one client's narrative onto another
// client's entry; verified in SQLite. Leaving it alone was no better: the
// second entry stayed blank behind a screen that said it was done.
//
// Two matters with two different clients and two different phrasebooks, so a
// leak is unmistakable in the assertions rather than inferred.
// ---------------------------------------------------------------------------
await step('stop A → start B → stop B: the offer is B\'s, never A\'s (chips, tick, caption, one-tap commit)', async () => {
  const mkJson = (url, body) => fetch(`${base}${url}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then((r) => r.json());
  const dayBefore = (n) => {
    const d = new Date(`${todayLocal()}T12:00:00`);
    d.setDate(d.getDate() - n);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const A_PHRASE = 'Reviewed the landlord termination notice and the underlying lease.';
  const B_TOP = 'Reviewed the diligence responses and updated the open issues list.';
  const B_ALT = 'Prepared the data room index and circulated it to the deal team.';

  const cmA = await mkJson('/api/cms', { cm_number: '999301-000001', short_name: 'Stale-check A', client_name: 'Stale Client A', billable: 1 });
  const cmB = await mkJson('/api/cms', { cm_number: '999302-000001', short_name: 'Stale-check B', client_name: 'Stale Client B', billable: 1 });
  const seeded = [];
  // A's phrasebook holds exactly one phrase; B's holds two, so B has a real
  // alternative to tap and A's sentence has no business appearing at all.
  for (let i = 1; i <= 4; i += 1) {
    seeded.push(await mkJson('/api/entries', { date: dayBefore(i), cm_id: cmA.id, narrative: A_PHRASE, tasks: [{ task_code: 'Review', duration: 1.1 }] }));
    seeded.push(await mkJson('/api/entries', { date: dayBefore(i), cm_id: cmB.id, narrative: B_TOP, tasks: [{ task_code: 'Due Diligence', duration: 0.9 }] }));
  }
  for (let i = 5; i <= 6; i += 1) {
    seeded.push(await mkJson('/api/entries', { date: dayBefore(i), cm_id: cmB.id, narrative: B_ALT, tasks: [{ task_code: 'Due Diligence', duration: 0.6 }] }));
  }
  const tA = await mkJson('/api/timers', { name: '__stale-A__', cm_id: cmA.id, task_code: 'Review' });
  const tB = await mkJson('/api/timers', { name: '__stale-B__', cm_id: cmB.id, task_code: 'Due Diligence' });
  await page.reload({ waitUntil: 'networkidle0' });
  await waitFor('.today-list .work-row');

  const rowAct = async (name, title) => {
    await page.waitForFunction((nm, t) => [...document.querySelectorAll('.today-list .work-row')]
      .some((r) => r.textContent.includes(nm) && r.querySelector(`button[title="${t}"]`)), { timeout: 6000 }, name, title);
    await page.evaluate((nm, t) => {
      const row = [...document.querySelectorAll('.today-list .work-row')].find((r) => r.textContent.includes(nm));
      row.scrollIntoView({ block: 'center' });
      row.querySelector(`button[title="${t}"]`).click();
    }, name, title);
  };
  // Backdated 30m through the row menu, the same UI path the step above uses —
  // an API start would not tell the running page, and reloading would destroy
  // the very surface this step is about.
  const startBackdated = async (name) => {
    await rowAct(name, 'Row menu');
    await waitFor('.ctx-menu');
    await clickText('.ctx-menu .ctx-inline button', '30m');
    await page.waitForFunction((nm) => [...document.querySelectorAll('.today-list .work-row.running')]
      .some((r) => r.textContent.includes(nm)), { timeout: 6000 }, name);
  };
  // Everything the offer is currently claiming, read straight off the DOM.
  const readOffer = () => page.evaluate(() => {
    const el = document.querySelector('.stop-chips');
    if (!el) return null;
    const settledEl = el.querySelector('[data-stop-settled]');
    return {
      head: el.querySelector('.stop-chips-head')?.textContent.replace(/\s+/g, ' ').trim() || '',
      entryId: el.closest('.work-row')?.dataset.entryId || null,
      settled: settledEl ? settledEl.getAttribute('data-stop-settled') : null,
      notes: [...el.querySelectorAll('.stop-chips-note')].map((n) => n.textContent.replace(/\s+/g, ' ').trim()),
      chips: [...el.querySelectorAll('.chip-btn')].map((b) => ({
        text: b.querySelector('span')?.textContent.trim() || '',
        applied: b.classList.contains('chip-applied') || b.getAttribute('aria-pressed') === 'true',
        kbd: b.querySelector('kbd')?.textContent.trim() || null,
      })),
    };
  });
  const entryFor = async (cmNumber) => {
    const all = await (await fetch(`${base}/api/entries?date=${todayLocal()}`)).json();
    return all.find((e) => e.cm && e.cm.cm_number === cmNumber) || null;
  };

  // ---- stop A: it pre-fills from A's own phrasebook and stands there ----
  await startBackdated('__stale-A__');
  await rowAct('__stale-A__', 'Stop & file time');
  await waitFor('.stop-chips');
  await page.waitForFunction((want) => document.querySelector('.stop-chips [data-stop-settled]')
    ?.getAttribute('data-stop-settled') === want, { timeout: 8000 }, A_PHRASE);

  // ---- start B while A's offer is still up, then stop B ----
  await startBackdated('__stale-B__');
  if (!(await page.$('.stop-chips'))) {
    throw new Error("A's offer closed itself before B stopped — the regression this step exists for cannot happen");
  }
  await rowAct('__stale-B__', 'Stop & file time');
  const entryB = await (async () => {
    for (let i = 0; i < 40; i += 1) {
      const e = await entryFor('999302-000001');
      if (e) return e;
      await sleep(200);
    }
    throw new Error('stopping __stale-B__ never filed an entry');
  })();
  // The offer must have re-derived itself for B: B's row, B's pre-fill. When
  // it has not, say what it is showing instead — a bare timeout here reads as
  // flake, and this exact failure is a cross-client narrative on screen.
  await page.waitForFunction((id, want) => {
    const el = document.querySelector('.stop-chips');
    if (!el) return false;
    if (el.closest('.work-row')?.dataset.entryId !== String(id)) return false;
    return el.querySelector('[data-stop-settled]')?.getAttribute('data-stop-settled') === want;
  }, { timeout: 10000 }, entryB.id, B_TOP).catch(async () => {
    throw new Error(`the offer never became B's — it is showing ${JSON.stringify(await readOffer())}`);
  });
  await sleep(400);
  const offer = await readOffer();
  if (!offer) throw new Error('the offer vanished on B');

  // 1. IT IS B'S SURFACE, HEAD TO FOOT.
  if (!offer.head.includes('Stale-check B')) {
    throw new Error(`the offer still heads with the previous entry: ${JSON.stringify(offer.head)}`);
  }
  const leak = JSON.stringify([offer.settled, offer.chips.map((c) => c.text), offer.notes]);
  if (leak.includes('termination notice')) {
    throw new Error(`A's narrative leaked into B's offer: ${leak}`);
  }
  // 2. IT SHOWS B'S PHRASEBOOK — and only B's.
  if (offer.chips.length === 0) throw new Error("B's alternative phrase is not on offer");
  for (const c of offer.chips) {
    if (![B_TOP, B_ALT].includes(c.text)) {
      throw new Error(`a chip is not from B's phrasebook: ${JSON.stringify(c.text)}`);
    }
  }
  // the key caps index the chips actually on screen, so `1` can never commit
  // a sentence that is not the first chip
  offer.chips.forEach((c, i) => {
    if (c.kbd !== null && c.kbd !== String(i + 1)) {
      throw new Error(`chip ${i} advertises key ${c.kbd}: ${JSON.stringify(offer.chips)}`);
    }
  });
  // 3. NOTHING IS DRAWN AS APPLIED UNLESS THIS ENTRY REALLY HOLDS IT.
  const liveB = await (await fetch(`${base}/api/entries/${entryB.id}`)).json();
  if (offer.settled !== null && String(liveB.narrative || '') !== offer.settled) {
    throw new Error(`the offer says "${offer.settled}" is saved; the entry holds "${liveB.narrative}"`);
  }
  for (const c of offer.chips) {
    if (c.applied && String(liveB.narrative || '') !== c.text) {
      throw new Error(`chip "${c.text}" is marked applied but the entry holds "${liveB.narrative}"`);
    }
  }

  // 4. TAPPING THE FIRST CHIP WRITES B'S OWN TEXT — and leaves A alone.
  const firstChip = offer.chips[0].text;
  await page.evaluate(() => {
    const b = document.querySelector('.stop-chips .chip-btn');
    b.scrollIntoView({ block: 'center' });
    b.click();
  });
  await page.waitForFunction(() => !document.querySelector('.stop-chips'), { timeout: 6000 });
  const afterB = await (await fetch(`${base}/api/entries/${entryB.id}`)).json();
  if (String(afterB.narrative || '') !== firstChip) {
    throw new Error(`the chip wrote "${afterB.narrative}", not the "${firstChip}" it showed`);
  }
  const afterA = await entryFor('999301-000001');
  if (String(afterA.narrative || '') !== A_PHRASE) {
    throw new Error(`A's entry changed while B was being finished: "${afterA.narrative}"`);
  }

  // cleanup: today's two filed entries, the seeded history, both timers
  for (const e of [afterA, afterB, ...seeded]) {
    const del = await fetch(`${base}/api/entries/${e.id}`, { method: 'DELETE' });
    if (!del.ok) throw new Error(`stale-check entry cleanup failed: ${del.status}`);
  }
  for (const t of [tA, tB]) {
    const del = await fetch(`${base}/api/timers/${t.id}`, { method: 'DELETE' });
    if (!del.ok) throw new Error(`stale-check timer cleanup failed: ${del.status}`);
  }
  await page.reload({ waitUntil: 'networkidle0' });
  await waitFor('.timer-row');
});

await step('quick-capture palette (q): "call re acme .3" parses clean and files', async () => {
  await page.evaluate(() => { document.activeElement?.blur(); });
  const d = new Date();
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const before = await (await fetch(`${base}/api/entries?date=${today}`)).json();

  await pressGlobal('q');
  await waitFor('.qc-card input');
  await page.type('.qc-card input', 'call re acme .3', { delay: 20 });
  await page.waitForFunction(() => !document.querySelector('.qc-chip.miss')
    && !!document.querySelector('button.qc-chip.on'), { timeout: 4000 });
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.body.textContent.includes('Filed'), { timeout: 4000 });
  await page.waitForFunction(() => !document.querySelector('.qc-card'), { timeout: 4000 });

  const after = await (await fetch(`${base}/api/entries?date=${today}`)).json();
  if (after.length !== before.length + 1) {
    throw new Error(`quick-capture did not file exactly one entry: before=${before.length} after=${after.length}`);
  }
  const filed = after.find((e) => !before.some((b) => b.id === e.id));
  if (!filed) throw new Error('could not identify the filed quick-capture entry');
  // clean up so the day's data matches what later steps expect
  const del = await fetch(`${base}/api/entries/${filed.id}`, { method: 'DELETE' });
  if (!del.ok) throw new Error(`quick-capture cleanup delete failed: ${del.status}`);
});

// The row's decimal clock is a 44px control where the clock IS the row's own
// figure (the ordinary case: the timer filed the entry, so the clock and the
// day's record are the same number). Where they have parted company — this
// matter carries a hand-keyed entry beside the timer's — the row states the
// RECORD, which is the number the ledger holds and the number a lawyer bills,
// and the clock moves into the row's expanded half rather than standing beside
// it as a second unexplained decimal (wave-2 §4: "1.7 clock 0.0 is two numbers
// where one is always zero"). It is still edited in place, one disclosure in.
const openRowOfClock = async () => {
  await page.evaluate(() => {
    const clock = document.querySelector('.timer-clock');
    if (!clock) throw new Error('no .timer-clock on any row');
    if (clock.offsetParent === null) clock.closest('.work-row').querySelector('.work-expand').click();
  });
  await page.waitForFunction(() => document.querySelector('.timer-clock')?.offsetParent !== null,
    { timeout: 4000 });
};

await step('timer clock is editable in place', async () => {
  await openRowOfClock();
  await page.click('.timer-clock');
  await waitFor('.clock-input');
  await page.evaluate(() => {
    const inp = document.querySelector('.clock-input');
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    set.call(inp, '1.4');
    inp.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.keyboard.press('Enter');
  await page.waitForFunction(
    () => document.querySelector('.timer-clock')?.textContent.trim() === '1.4',
    { timeout: 4000 });
  // ONE NUMBER PER ROW (wave-2). The HH:MM:SS reading used to sit beside the
  // editable tenths on every row, saying the same thing twice — "00:00:00 0.0"
  // on a timer that was not running. It renders only while the clock is
  // actually ticking now; on a stopped row the elapsed time is the tenths
  // figure itself, and its exact HH:MM:SS is the figure's title. Where the
  // clock and the day's record HAVE parted company the row shows both, and
  // the smaller one is labelled "clock" so the pair cannot be misread.
  await page.waitForFunction(() => {
    const clock = document.querySelector('.timer-clock');
    if (!clock) return false;
    const row = clock.closest('.work-row');
    return clock.textContent.trim() === '1.4'
      && clock.title.startsWith('01:24:00')
      && !row.querySelector('.timer-clock-raw');
  }, { timeout: 4000 });
});

await step('exclusive timers: starting a second timer stops & files the first (chips pop, one running)', async () => {
  // scratch matter + two scratch timers, all cleaned up below so later steps
  // see the same timers/entries they always did
  const mkJson = (url, body) => fetch(`${base}${url}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then((r) => r.json());
  const cm = await mkJson('/api/cms', { cm_number: '999001-000001', short_name: 'Exclusive scratch', billable: 1 });
  const ta = await mkJson('/api/timers', { name: '__excl-A__', cm_id: cm.id });
  const tb = await mkJson('/api/timers', { name: '__excl-B__', cm_id: cm.id });
  await mkJson(`/api/timers/${ta.id}/start`, { minutesAgo: 10 }); // enough to file ≥0.1h on auto-stop
  await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForFunction(() => [...document.querySelectorAll('.timer-row')]
    .some((c) => c.textContent.includes('__excl-A__') && c.classList.contains('running')), { timeout: 4000 });

  // clicking Start on B must stop A server-side and pop A's stop chips
  await page.evaluate(() => {
    const card = [...document.querySelectorAll('.timer-row')].find((c) => c.textContent.includes('__excl-B__'));
    card.querySelector('button[title="Start"]').click();
  });
  await waitFor('.stop-chips');
  const filedHead = await page.$eval('.stop-chips-head', (el) => el.textContent);
  if (!filedHead.includes('Exclusive scratch')) throw new Error(`chips are not for the auto-stopped timer: "${filedHead}"`);
  await page.waitForFunction(() => {
    const running = [...document.querySelectorAll('.timer-row.running')];
    return running.length === 1 && running[0].textContent.includes('__excl-B__');
  }, { timeout: 4000 });
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('.stop-chips'), { timeout: 4000 });

  // cleanup: the filed scratch entry, both timers (leave the scratch matter —
  // inert, and entries reference cms by id anyway)
  const entries = await (await fetch(`${base}/api/entries?date=${todayLocal()}`)).json();
  for (const e of entries.filter((x) => x.cm && x.cm.cm_number === '999001-000001')) {
    const del = await fetch(`${base}/api/entries/${e.id}`, { method: 'DELETE' });
    if (!del.ok) throw new Error(`scratch entry cleanup failed: ${del.status}`);
  }
  for (const t of [ta, tb]) {
    const del = await fetch(`${base}/api/timers/${t.id}`, { method: 'DELETE' });
    if (!del.ok) throw new Error(`scratch timer cleanup failed: ${del.status}`);
  }
  await page.reload({ waitUntil: 'networkidle0' });
  await waitFor('.timer-row');
});

await step('quick timer: stop files a matterless entry → assign from the entry card', async () => {
  const entriesBefore = await (await fetch(`${base}/api/entries?date=${todayLocal()}`)).json();
  await clickText('button', 'Quick');
  await page.waitForFunction(() => [...document.querySelectorAll('.timer-row')]
    .some((c) => c.textContent.includes('Quick timer') && c.classList.contains('running')
      && c.classList.contains('unassigned')), { timeout: 4000 });
  // running state reaches the OS chrome: tab title carries ▶ clock + name
  // (5s poll + 1s tick), favicon swaps to the recording-dot variant
  await page.waitForFunction(() => document.title.startsWith('▶')
    && document.title.includes('Quick timer'), { timeout: 10000 });
  const favRunning = await page.evaluate(() =>
    document.querySelector('link[rel="icon"]').getAttribute('href').includes('circle'));
  if (!favRunning) throw new Error('favicon did not switch to the running variant');
  await sleep(2200); // past the misclick grace so the stop files for real
  await page.evaluate(() => {
    const card = [...document.querySelectorAll('.timer-row')].find((c) => c.textContent.includes('Quick timer'));
    card.querySelector('button[title="Stop & file time"]').click();
  });
  // 2026-07-13 model: the stop FILES a matterless entry — chips pop like any
  // other stop, with the "no matter yet" label instead of a matter name
  await waitFor('.stop-chips');
  const chipsHead = await page.$eval('.stop-chips-head', (el) => el.textContent);
  if (!chipsHead.includes('no matter yet')) throw new Error(`chips head missing no-matter label: "${chipsHead}"`);
  await page.click('.stop-chips button[title^="Dismiss"]');
  await page.waitForFunction(() => !document.querySelector('.stop-chips'), { timeout: 4000 });
  // stopped → title and favicon revert
  await page.waitForFunction(() => document.title === 'Timekeeper', { timeout: 10000 });
  await page.waitForFunction(() =>
    !document.querySelector('link[rel="icon"]').getAttribute('href').includes('circle'),
  { timeout: 10000 }).catch(() => { throw new Error('favicon did not revert after stop'); });

  // the entry is real but blocked — and it is the quick TIMER's own row now,
  // which carries the Assign matter button inline
  await page.waitForFunction(() => [...document.querySelectorAll('.today-list .work-row')]
    .some((c) => c.classList.contains('unassigned') && c.textContent.includes('Assign matter')),
  { timeout: 5000 });
  await clickText('.today-list .work-row button', 'Assign matter');
  await waitFor('.modal-wide .cmpicker input');
  await page.click('.modal-wide .cmpicker input');
  await sleep(250);
  await clickText('.cmpicker-item .name', 'Acme');
  await sleep(600); // autosave associates the entry in place
  await clickText('.modal-wide button', 'Done');
  await page.waitForFunction(() => !document.querySelector('.modal-wide'), { timeout: 5000 });

  // association reached the entry AND the timer followed it (server glue)
  const entriesAfter = await (await fetch(`${base}/api/entries?date=${todayLocal()}`)).json();
  const scratch = entriesAfter.filter((x) => !entriesBefore.some((b) => b.id === x.id));
  if (!scratch.some((e) => e.cm && e.cm.short_name.includes('Acme'))) {
    throw new Error('assignment did not associate the matterless entry');
  }
  const timersNow = await (await fetch(`${base}/api/timers`)).json();
  const qt = timersNow.find((x) => x.name === 'Quick timer');
  if (!qt || !qt.cm_id) throw new Error('timer did not follow its entry’s association');

  // cleanup: the scratch entries + the quick timer itself
  for (const e of scratch) {
    const del = await fetch(`${base}/api/entries/${e.id}`, { method: 'DELETE' });
    if (!del.ok) throw new Error(`scratch entry cleanup failed: ${del.status}`);
  }
  for (const t of timersNow.filter((x) => x.name === 'Quick timer')) {
    const del = await fetch(`${base}/api/timers/${t.id}`, { method: 'DELETE' });
    if (!del.ok) throw new Error(`quick timer cleanup failed: ${del.status}`);
  }
  await page.reload({ waitUntil: 'networkidle0' });
  await waitFor('.timer-row');
});

await step('timer name is editable in place', async () => {
  await page.click('.timer-row .timer-name');
  await waitFor('.name-input');
  const setName = (v) => page.evaluate((val) => {
    const inp = document.querySelector('.name-input');
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    set.call(inp, val);
    inp.dispatchEvent(new Event('input', { bubbles: true }));
  }, v);
  await setName('Acme research (renamed)');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => [...document.querySelectorAll('.timer-name')]
    .some((el) => el.textContent === 'Acme research (renamed)'), { timeout: 4000 });
  // rename back so later steps' name references hold
  await page.click('.timer-row .timer-name');
  await waitFor('.name-input');
  await setName('Acme research');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => [...document.querySelectorAll('.timer-name')]
    .some((el) => el.textContent === 'Acme research'), { timeout: 4000 });
});

await step('ghost-text: phrasebook completion in the entry editor, Tab accepts', async () => {
  await pressGlobal('n');
  await waitFor('.modal .cmpicker input');
  await page.click('.modal .cmpicker input');
  await clickText('.cmpicker-item .name', 'Acme');
  await waitFor('.modal-wide .narrative-preview textarea');
  await page.click('.modal-wide .narrative-preview textarea');
  await page.type('.modal-wide .narrative-preview textarea', 'Rev', { delay: 30 });
  await page.waitForFunction(() => {
    const hint = document.querySelector('.modal-wide .ghost-hint');
    return hint && hint.textContent.startsWith('iewed lease agreement');
  }, { timeout: 4000 });
  await page.keyboard.press('Tab');
  const val = await page.$eval('.modal-wide .narrative-preview textarea', (el) => el.value);
  if (val !== 'Reviewed lease agreement and drafted renewal-terms summary for client') {
    throw new Error(`Tab did not accept the ghost: "${val}"`);
  }
  await shot('ghost-text');
  // the editor autosaved an entry while we typed — delete it to leave the day clean
  await page.waitForFunction(() => document.querySelector('.saving-dot')?.textContent.includes('Saved'), { timeout: 6000 });
  await editorMore('Delete entry');
  await clickText('.modal:not(.modal-wide) button', 'Delete');
  await page.waitForFunction(() => !document.querySelector('.modal-wide'), { timeout: 5000 });
});

await step('Reuse: pick past narratives for this matter and insert them', async () => {
  // Seed two dated narratives on the Acme matter so the list has something to
  // offer regardless of what earlier steps left behind.
  const cms = await (await fetch(`${base}/api/cms`)).json();
  const acme = cms.find((c) => (c.short_name || '').includes('Acme'));
  const seedEntry = (date, narrative) => fetch(`${base}/api/entries`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      date, cm_id: acme.id, narrative,
      tasks: [{ task_code: 'Review', duration: 0.5, fragment: '' }],
    }),
  }).then((r) => r.json());
  const first = await seedEntry('2026-06-01', 'Call with W. Hammond regarding the easement.');
  const second = await seedEntry('2026-06-02', 'Draft response to the landlord.');

  await page.reload({ waitUntil: 'networkidle0' });
  await pressGlobal('n');
  await waitFor('.modal .cmpicker input');
  await page.click('.modal .cmpicker input');
  await clickText('.cmpicker-item .name', 'Acme');
  await clickText('.modal-wide button', 'Reuse');
  await waitFor('.narrative-history-row');
  // pick by text, not position — earlier steps leave their own entries on
  // this matter, and today's beat June's in the newest-first list
  const pick = (text) => page.evaluate((t) => {
    const row = [...document.querySelectorAll('.narrative-history-row')]
      .find((el) => el.textContent.includes(t));
    if (!row) throw new Error(`no history row for "${t}"`);
    row.querySelector('input[type="checkbox"]').click();
  }, text);
  await pick('Draft response to the landlord.');
  await pick('Call with W. Hammond regarding the easement.');
  await page.waitForFunction(() => {
    const p = document.querySelector('.narrative-history-preview .narrative');
    return p && p.textContent.includes('Draft response') && p.textContent.includes('W. Hammond');
  }, { timeout: 4000 });
  await shot('narrative-history');
  await clickText('.modal .row-end button', 'Insert');
  await page.waitForFunction(() => !document.querySelector('.narrative-history-row'), { timeout: 4000 });
  const val = await page.$eval('.modal-wide .narrative-preview textarea', (el) => el.value);
  if (val !== 'Draft response to the landlord; Call with W. Hammond regarding the easement.') {
    throw new Error(`Reuse inserted the wrong text: "${val}"`);
  }

  // leave the day as we found it
  await page.waitForFunction(() => document.querySelector('.saving-dot')?.textContent.includes('Saved'), { timeout: 6000 });
  await editorMore('Delete entry');
  await clickText('.modal:not(.modal-wide) button', 'Delete');
  await page.waitForFunction(() => !document.querySelector('.modal-wide'), { timeout: 5000 });
  for (const e of [first, second]) await fetch(`${base}/api/entries/${e.id}`, { method: 'DELETE' });
});

await step('shortcuts: save-from-selection, inline expansion, settings list', async () => {
  await pressGlobal('n');
  await waitFor('.modal .cmpicker input');
  await page.click('.modal .cmpicker input');
  await clickText('.cmpicker-item .name', 'Acme');
  await waitFor('.modal-wide .narrative-preview textarea');
  await page.type('.modal-wide .narrative-preview textarea', 'Interconnect Agreement');
  await page.evaluate(() => {
    const ta = document.querySelector('.modal-wide .narrative-preview textarea');
    ta.focus();
    ta.setSelectionRange(0, ta.value.length);
    ta.dispatchEvent(new Event('select', { bubbles: true }));
  });
  await waitFor('[data-shortcut-save]');
  await clickText('[data-shortcut-save] button', 'shortcut');
  await type('[data-shortcut-save] input', 'IA');
  await clickText('[data-shortcut-save] button', 'Save');
  await page.waitForFunction(() => document.body.textContent.includes('Shortcut saved'), { timeout: 4000 });
  // expansion: clear the field, then type the abbreviation + space
  await page.evaluate(() => {
    const ta = document.querySelector('.modal-wide .narrative-preview textarea');
    const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    set.call(ta, '');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.type('.modal-wide .narrative-preview textarea', 'review IA ', { delay: 20 });
  const val = await page.$eval('.modal-wide .narrative-preview textarea', (el) => el.value);
  if (val !== 'review Interconnect Agreement ') throw new Error(`expansion failed: "${val}"`);
  await editorMore('Delete entry');
  await clickText('.modal:not(.modal-wide) button', 'Delete');
  await page.waitForFunction(() => !document.querySelector('.modal-wide'), { timeout: 5000 });
  // settings shows the minimal list (no management screen beyond list/delete)
  await page.goto(`${base}/#/settings/codes`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => document.body.textContent.includes('Text-expansion shortcuts')
    && document.body.textContent.includes('Interconnect Agreement'), { timeout: 4000 });
  await page.goto(`${base}/#/`, { waitUntil: 'networkidle0' });
});

await step('AUTO narrative: two-way edit-through, structural-break detach, client label', async () => {
  await pressGlobal('n');
  await waitFor('.modal .cmpicker input');
  await page.click('.modal .cmpicker input');
  await clickText('.cmpicker-item .name', 'Acme');
  // An undivided entry shows its task code and nothing else of the line, so
  // reaching the line editor is one deliberate press — which, with no
  // semicolons in the (empty) narrative to split at, opens it with the two
  // lines this scenario needs.
  await splitIntoTasks();
  await page.waitForFunction(() => document.querySelectorAll('.modal-wide .task-line').length === 2);

  // client label visible (Acme's client was deliberately left unnamed → renders as the 6-digit number)
  await page.waitForFunction(() =>
    document.querySelector('.modal-wide .cm-client-label')?.textContent.includes('100001'), { timeout: 4000 });

  // fill line 1's fragment + hours (task code already covered by the earlier +code step)
  await page.evaluate(() => {
    const line1 = document.querySelector('.modal-wide .task-line');
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    const frag = line1.querySelector('input[type="text"]');
    set.call(frag, 'review lease terms');
    frag.dispatchEvent(new Event('input', { bubbles: true }));
    const hours = line1.querySelector('input[type="number"]');
    set.call(hours, '1.2');
    hours.dispatchEvent(new Event('input', { bubbles: true }));
  });

  // fill the second line too → AUTO becomes available (≥2 substantive lines)
  await page.evaluate(() => {
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    const line2 = [...document.querySelectorAll('.modal-wide .task-line')][1];
    const frag = line2.querySelector('input[type="text"]');
    set.call(frag, 'draft renewal email');
    frag.dispatchEvent(new Event('input', { bubbles: true }));
    const hours = line2.querySelector('input[type="number"]');
    set.call(hours, '0.5');
    hours.dispatchEvent(new Event('input', { bubbles: true }));
  });

  // AUTO box appears, formatted per line (line 1's hours rebalanced down to
  // 0.7 by the hours auto-rebalance: line2 grew from 0→0.5, and the two
  // lines' sum holds steady at 1.2 — the sum before this edit)
  await waitFor('.modal-wide .auto-badge');
  await page.waitForFunction(() => {
    const ta = document.querySelector('.modal-wide .narrative-preview textarea');
    return ta && ta.value === 'Review lease terms (0.7); draft renewal email (0.5).';
  }, { timeout: 4000 });

  // edit-through: rewrite the second fragment inside the AUTO box → task line 2 updates
  await page.evaluate(() => {
    const ta = document.querySelector('.modal-wide .narrative-preview textarea');
    const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    set.call(ta, 'Review lease terms (0.7); send renewal email to landlord (0.5).');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForFunction(() => {
    const line2 = [...document.querySelectorAll('.modal-wide .task-line')][1];
    return line2.querySelector('input[type="text"]').value === 'send renewal email to landlord';
  }, { timeout: 4000 });
  // …and the edit-through must NOT rewrite line 1's fragment with the AUTO
  // box's display-only capitalization ("Review …" is a render transform of
  // segment 0, not a user edit) — the stored lowercase text stays untouched.
  const line1Frag = await page.evaluate(() =>
    document.querySelector('.modal-wide .task-line input[type="text"]').value);
  if (line1Frag !== 'review lease terms') {
    throw new Error(`display-only casing leaked into line 1's fragment: "${line1Frag}"`);
  }

  // structural break: delete a parenthetical → AUTO turns off, typed text stands as manual
  const detachedText = 'Review lease terms 0.7; send renewal email to landlord (0.5).';
  await page.evaluate((text) => {
    const ta = document.querySelector('.modal-wide .narrative-preview textarea');
    const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    set.call(ta, text);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }, detachedText);
  await page.waitForFunction(() => !document.querySelector('.modal-wide .auto-badge'), { timeout: 4000 });
  const manualText = await page.$eval('.modal-wide .narrative-preview textarea', (el) => el.value);
  if (manualText !== detachedText) {
    throw new Error(`manual text did not survive the detach: "${manualText}"`);
  }

  await shot('auto-narrative-sync');
  await page.waitForFunction(() => document.querySelector('.saving-dot')?.textContent.includes('Saved'), { timeout: 6000 });

  // durability (Task 4): close the editor (flushes narrative_manual=1 on the
  // task-touching save that already went out) and reopen the SAME entry from
  // the dashboard list — the manual text must survive, and AUTO must stay off.
  await clickText('.modal-wide button', 'Done');
  await page.waitForFunction(() => !document.querySelector('.modal-wide'), { timeout: 5000 });
  await page.waitForFunction(() =>
    [...document.querySelectorAll('.today-list .work-row')].some((c) => c.textContent.includes('Review lease terms')),
  { timeout: 5000 });
  // The pencil is gone (teardown E8: one primary action plus an overflow), so
  // the entry is reopened from the row's ⋯ menu. On a row keyed by MATTER
  // (wave-1b) that menu names each of the day's entries on that matter by its
  // narrative, so the reopen can name the one it means.
  await page.evaluate(() => {
    const row = [...document.querySelectorAll('.today-list .work-row')]
      .find((c) => c.textContent.includes('Review lease terms'));
    row.querySelector('.timer-more, .entry-more').click();
  });
  await waitFor('.ctx-menu');
  await page.evaluate(() => {
    const items = [...document.querySelectorAll('.ctx-menu .ctx-item')];
    const it = items.find((b) => b.textContent.includes('Review lease terms'))
      || items.find((b) => b.textContent.trim().startsWith('Open'));
    if (!it) throw new Error('no "Open entry" item in the row menu');
    it.click();
  });
  await waitFor('.modal-wide .narrative-preview textarea');
  await page.waitForFunction(() => !document.querySelector('.modal-wide .auto-badge'), { timeout: 4000 });
  const reopenedText = await page.$eval('.modal-wide .narrative-preview textarea', (el) => el.value);
  if (reopenedText !== detachedText) {
    throw new Error(`manual text did not survive close/reopen: "${reopenedText}"`);
  }

  await editorMore('Delete entry');
  await clickText('.modal:not(.modal-wide) button', 'Delete');
  await page.waitForFunction(() => !document.querySelector('.modal-wide'), { timeout: 5000 });
});

await step('picker: client→matter create + fuzzy client-name search', async () => {
  await clickText('button', 'New timer');
  await waitFor('.modal .cmpicker input');
  await page.click('.modal .cmpicker input');
  await clickText('.cmpicker-item .name', 'New client/matter');
  await waitFor('[data-nc-client]');
  await type('[data-nc-client]', '100004');
  await type('[data-nc-client-name]', 'Meridian'); // appears for new clients
  await type('[data-nc-matter]', '000001');
  await type('[data-nc-name]', 'Harbor Lease');
  await clickText('.modal button', 'Create matter');
  // back in the timer modal with the matter picked — reopen and fuzzy-search
  await waitFor('.modal .cmpicker button[title="Change CM"]');
  await page.click('.modal .cmpicker button[title="Change CM"]');
  await type('.modal .cmpicker input', 'meri harbor');
  await page.waitForFunction(() => [...document.querySelectorAll('.cmpicker-item')]
    .some((el) => el.textContent.includes('Meridian') && el.textContent.includes('Harbor Lease')),
  { timeout: 4000 });
  await clickText('.modal button', 'Cancel'); // no timer created
});

await step('picker: NEW CLIENT by name first (feedback 2026-07-10)', async () => {
  await clickText('button', 'New timer');
  await waitFor('.modal .cmpicker input');
  await page.click('.modal .cmpicker input');
  await clickText('.cmpicker-item .name', 'New client/matter');
  await waitFor('[data-nc-client]');
  await type('[data-nc-client]', 'Globex'); // a NAME, not a number — the old dead-end
  // match the quoted variant so the stale outer "New client/matter" row can't be hit
  await page.waitForFunction(() => [...document.querySelectorAll('.cmpicker-item .name')]
    .some((el) => el.textContent.includes('New client “Globex”')), { timeout: 4000 });
  await clickText('.cmpicker-item .name', 'New client “Globex”');
  // name moved into the (now required) client-name field; number goes in the search box
  const pre = await page.$eval('[data-nc-client-name]', (el) => el.value);
  if (pre !== 'Globex') throw new Error(`client name not carried over: "${pre}"`);
  await type('[data-nc-client]', '414141');
  await type('[data-nc-matter]', '000001');
  await type('[data-nc-name]', 'Globex retainer');
  await clickText('.modal button', 'Create matter');
  await waitFor('.modal .cmpicker button[title="Change CM"]');
  await clickText('.modal button', 'Cancel'); // no timer created
});

await step('groups: create from the list menu, assign from the row menu, isolate, drop on a section, persist; A–Z present', async () => {
  // The ten-tab strip is gone (teardown §5: role="tab" over one filtered panel
  // was the wrong component, and it sat above the timers on a phone). Every
  // capability it carried lives in the list's ⋯ menu or the row's ⋯ menu, and
  // each now has a touch path it did not have before.
  await openListMenu();
  await clickText('.ctx-menu .ctx-item', 'New group');
  await type('.modal input[placeholder="e.g. Litigation"]', 'Litigation');
  await clickText('.modal button', 'Create');
  await page.waitForFunction(() => !document.querySelector('.modal'), { timeout: 4000 });

  await setListSeg('Group', 'By group');
  await page.waitForFunction(() => [...document.querySelectorAll('.group-head .group-name')]
    .some((el) => el.textContent.trim() === 'Litigation'), { timeout: 4000 });

  // the lone existing timer is still ungrouped, so the empty group section
  // stands there as its own drop target
  if (await sectionCount('Litigation') !== 0) throw new Error('new group should start empty');
  if (await sectionCount('Ungrouped') < 1) throw new Error('the existing timer should be Ungrouped');

  // "Only this group" isolates it — the tab strip's job, as a filter
  await setOnly('Litigation');
  await page.waitForFunction(() => document.querySelectorAll('.today-list .timer-row').length === 0
    && document.querySelector('.today-list').textContent.includes('Drop timers here'), { timeout: 4000 });
  // …and the filter is visible and removable in place, which is what makes it
  // safe for it to live one tap deep
  await page.waitForFunction(() => [...document.querySelectorAll('.filter-pill')]
    .some((p) => p.textContent.includes('Litigation')), { timeout: 4000 });
  await setOnly('');
  await page.waitForFunction(() => document.querySelectorAll('.today-list .timer-row').length === 1, { timeout: 4000 });

  // Assign the existing timer to Litigation. The row menu was seventeen items
  // and 57% of a phone screen (teardown §5, "the tell"), so timer maintenance
  // — duplicate, group, reorder, pin, zero, delete — moved into the Edit-timer
  // dialog the menu still opens in one row (wave-2). The group select lives
  // there beside the timer's name and matter, where it always belonged.
  await page.click('.timer-row button[title="Row menu"]');
  await clickText('.ctx-menu .ctx-item', 'Edit timer');
  await waitFor('.modal select');
  await page.evaluate(() => {
    const sel = [...document.querySelectorAll('.modal select')]
      .find((s) => [...s.options].some((o) => o.textContent.trim() === 'Ungrouped'));
    if (!sel) throw new Error('no Group control in the Edit timer dialog');
    sel.value = [...sel.options].find((o) => o.value !== '').value;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await clickText('.modal button', 'Save');
  await page.waitForFunction(() => !document.querySelector('.modal'), { timeout: 4000 });
  await page.waitForFunction(() => {
    const sec = [...document.querySelectorAll('.timer-section')]
      .find((x) => x.querySelector('.group-head')?.textContent.includes('Litigation'));
    return sec && sec.querySelectorAll('.timer-row').length === 1;
  }, { timeout: 5000 });

  // rename/delete live in the list menu while that group is the isolated one —
  // one labelled menu instead of a kebab hidden on an active tab
  await setOnly('Litigation');
  await openListMenu();
  const menuLabels = await page.$$eval('.ctx-menu .ctx-item', (els) => els.map((el) => el.textContent.trim()));
  if (!menuLabels.some((l) => l.includes('Rename'))) throw new Error(`list menu missing Rename: ${JSON.stringify(menuLabels)}`);
  if (!menuLabels.some((l) => l.includes('Delete'))) throw new Error(`list menu missing Delete: ${JSON.stringify(menuLabels)}`);
  if (!menuLabels.some((l) => l.includes('A–Z'))) throw new Error(`list menu missing A–Z: ${JSON.stringify(menuLabels)}`);
  if (!menuLabels.some((l) => l.includes('Import'))) throw new Error(`list menu missing CSV import: ${JSON.stringify(menuLabels)}`);
  await clickText('.ctx-menu .ctx-item', 'Rename');
  await waitFor('.modal input[placeholder="e.g. Litigation"]');
  await clickText('.modal button', 'Cancel');
  await page.waitForFunction(() => !document.querySelector('.modal'), { timeout: 4000 });
  await setOnly('');

  // drop-on-section: a second group, drag the row into it and back — the real
  // dragstart/dragover/drop handlers, in both directions
  await openListMenu();
  await clickText('.ctx-menu .ctx-item', 'New group');
  await type('.modal input[placeholder="e.g. Litigation"]', 'General');
  await clickText('.modal button', 'Create');
  await page.waitForFunction(() => [...document.querySelectorAll('.group-head .group-name')]
    .some((el) => el.textContent.trim() === 'General'), { timeout: 4000 });

  await dndToSection('.today-list .timer-row', 'General');
  await page.waitForFunction(() => {
    const sec = [...document.querySelectorAll('.timer-section')]
      .find((x) => x.querySelector('.group-head')?.textContent.includes('General'));
    return sec && sec.querySelectorAll('.timer-row').length === 1;
  }, { timeout: 5000 });
  await dndToSection('.today-list .timer-row', 'Litigation');
  await page.waitForFunction(() => {
    const sec = [...document.querySelectorAll('.timer-section')]
      .find((x) => x.querySelector('.group-head')?.textContent.includes('Litigation'));
    return sec && sec.querySelectorAll('.timer-row').length === 1;
  }, { timeout: 5000 });
  await shot('groups');

  // the isolation persists across reload (tk:timerOnly:<mode>), per mode
  await setOnly('Litigation');
  await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForFunction(() => [...document.querySelectorAll('.filter-pill')]
    .some((p) => p.textContent.includes('Litigation')), { timeout: 5000 });
  await page.waitForFunction(() => {
    const rows = [...document.querySelectorAll('.today-list .timer-row .timer-name')];
    return rows.length === 1 && rows[0].textContent.includes('Acme research');
  }, { timeout: 5000 });
  await setOnly('');
});

await step('grouping: by client / flat / persists across reload (list ⋯ menu)', async () => {
  await setListSeg('Group', 'By client');
  // Acme's client is unnamed → its section is labeled by the 6-digit number,
  // with a "· unnamed" hint alongside the group-name span (not inside it).
  await page.waitForFunction(() => [...document.querySelectorAll('.group-head .group-name')]
    .some((el) => el.textContent.trim() === '100001'), { timeout: 4000 });
  const unnamedHint = await page.evaluate(() => {
    const head = [...document.querySelectorAll('.group-head')]
      .find((h) => h.querySelector('.group-name')?.textContent.trim() === '100001');
    return head?.textContent.includes('unnamed');
  });
  if (!unnamedHint) throw new Error('by-client head missing the "unnamed" hint for an unnamed client');

  await setListSeg('Group', 'Flat');
  await page.waitForFunction(() => document.querySelectorAll('.group-head').length === 0
    && document.querySelectorAll('.timer-row').length >= 1, { timeout: 4000 });
  await page.reload({ waitUntil: 'networkidle0' });
  await waitFor('.timer-row');
  const on = await listSegOn('Group');
  if (on !== 'Flat') throw new Error(`grouping did not persist: ${on}`);
  await setListSeg('Group', 'By group');
  await page.waitForFunction(() => [...document.querySelectorAll('.group-head .group-name')]
    .some((el) => el.textContent.trim() === 'Litigation'), { timeout: 4000 });
});

await step('client rename: inline on CMs view, reflected in by-client grouping', async () => {
  await page.goto(`${base}/#/cms`, { waitUntil: 'networkidle0' });
  await waitFor('.client-row');
  // client is still unnamed → the affordance is the dashed "+ Name this
  // client" button (B1), not a plain pencil.
  await page.evaluate(() => {
    const row = [...document.querySelectorAll('.client-row')].find((r) => r.textContent.includes('100001'));
    row.querySelector('.client-name-add').click();
  });
  await type('.client-row input', 'Acme Holdings');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => [...document.querySelectorAll('.client-row')]
    .some((r) => r.textContent.includes('Acme Holdings')), { timeout: 4000 });
  // the by-client grouping now shows the name instead of the number
  await page.goto(`${base}/#/`, { waitUntil: 'networkidle0' });
  await setListSeg('Group', 'By client');
  await page.waitForFunction(() => [...document.querySelectorAll('.group-head .group-name')]
    .some((el) => el.textContent.trim() === 'Acme Holdings'), { timeout: 4000 });
  await setListSeg('Group', 'By group'); // restore for later steps
});

await step('client name editable from the matter Edit modal, reflected in C&M row + by-client head', async () => {
  await page.goto(`${base}/#/cms`, { waitUntil: 'networkidle0' });
  await waitFor('.client-row');
  // open the matter's Edit modal (not the client-row inline affordance)
  await page.evaluate(() => {
    const rows = [...document.querySelectorAll('table.tk tbody tr')];
    const row = rows.find((r) => r.textContent.includes('Acme lease dispute'));
    row.querySelector('button[title="Edit"]').click();
  });
  await page.waitForFunction(() => [...document.querySelectorAll('.modal .field-label')]
    .some((el) => el.textContent.trim() === 'Client name'), { timeout: 4000 });
  // pre-filled from existing.client_name, hinted with the client number
  const { initial, hint } = await page.evaluate(() => {
    const f = [...document.querySelectorAll('.modal .field')]
      .find((x) => x.querySelector('.field-label')?.textContent.trim() === 'Client name');
    return { initial: f.querySelector('input').value, hint: f.querySelector('.field-hint')?.textContent || '' };
  });
  if (initial !== 'Acme Holdings') throw new Error(`client-name field not pre-filled: ${initial}`);
  if (!hint.includes('100001')) throw new Error(`client-name hint missing client number: ${hint}`);
  await page.evaluate(() => {
    const f = [...document.querySelectorAll('.modal .field')]
      .find((x) => x.querySelector('.field-label')?.textContent.trim() === 'Client name');
    const input = f.querySelector('input');
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    set.call(input, 'Acme Holdings LLC');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await clickText('.modal button', 'Save');
  await page.waitForFunction(() => !document.querySelector('.modal'), { timeout: 4000 });
  await page.waitForFunction(() => [...document.querySelectorAll('.client-row')]
    .some((r) => r.textContent.includes('Acme Holdings LLC')), { timeout: 4000 });

  // by-client head picks up the rename after a reload (real /api/timers refetch)
  await page.goto(`${base}/#/`, { waitUntil: 'networkidle0' });
  await setListSeg('Group', 'By client');
  await page.reload({ waitUntil: 'networkidle0' });
  await waitFor('.timer-row');
  await page.waitForFunction(() => [...document.querySelectorAll('.group-head .group-name')]
    .some((el) => el.textContent.trim() === 'Acme Holdings LLC'), { timeout: 4000 });
  await setListSeg('Group', 'By group'); // restore for later steps
});

await step('grid keyboard: focus, Alt-nudge, Enter start/stop; worked-today highlight', async () => {
  // The dashboard is still in by-group mode; drop any "Only this group"
  // isolation so every group's timers render together — this step needs to see
  // Acme research alongside the fresh ungrouped timers it creates below.
  await setOnly('');
  await page.waitForFunction(() => [...document.querySelectorAll('.timer-row')]
    .some((c) => c.textContent.includes('Acme research')), { timeout: 4000 });

  // a second, untouched timer proves the worked/zero distinction
  await clickText('button', 'New timer');
  await type('.modal input[placeholder="e.g. Acme — research"]', 'Harbor drafting');
  await page.click('.modal .cmpicker input');
  await sleep(250);
  await clickText('.cmpicker-item .name', 'Harbor Lease');
  await clickText('.modal button', 'Create');
  await page.waitForFunction(() => document.querySelectorAll('.timer-row').length >= 2, { timeout: 4000 });

  const workedNames = await page.$$eval('.timer-row.worked .timer-name', (els) => els.map((e) => e.textContent));
  if (!workedNames.includes('Acme research')) throw new Error(`Acme not highlighted: ${workedNames}`);
  if (workedNames.includes('Harbor drafting')) throw new Error('zero timer must not be highlighted');

  const focusAcme = () => page.evaluate(() => {
    [...document.querySelectorAll('.timer-row')]
      .find((c) => c.textContent.includes('Acme research')).focus();
  });
  const acmeClockIs = (want) => page.waitForFunction((w) => {
    const card = [...document.querySelectorAll('.timer-row')]
      .find((c) => c.textContent.includes('Acme research'));
    return card && card.querySelector('.timer-clock')?.textContent.trim() === w;
  }, { timeout: 4000 }, want);

  await openRowOfClock();
  await focusAcme();
  await page.keyboard.down('Alt');
  await page.keyboard.press('ArrowUp');           // +0.1 → 1.5
  await page.keyboard.up('Alt');
  await acmeClockIs('1.5');
  await page.keyboard.down('Alt');
  await page.keyboard.down('Shift');
  await page.keyboard.press('ArrowDown');          // −0.2 → 1.3
  await page.keyboard.up('Shift');
  await page.keyboard.up('Alt');
  await acmeClockIs('1.3');

  await page.keyboard.press('Enter');              // start
  await page.waitForFunction(() => document.querySelector('.timer-row.running'), { timeout: 4000 });
  await sleep(2500);                               // outlive the 2s misclick grace
  await focusAcme();
  await page.keyboard.press('Enter');              // stop → chips
  await waitFor('.stop-chips');
  await page.keyboard.press('Escape');             // dismiss — the draft is already filed
  await page.waitForFunction(() => !document.querySelector('.stop-chips'), { timeout: 4000 });

  // A4: column-major arrows (2026-07-13 feedback: the grid flows top-to-
  // bottom in columns). ArrowDown walks DOM order — the next card DOWN the
  // same column — and ArrowRight jumps geometrically to the adjacent
  // column. Force multiple columns (flat view, several cards), then confirm.
  for (const name of ['Acme filing', 'Acme calls', 'Acme review']) {
    await clickText('button', 'New timer');
    await type('.modal input[placeholder="e.g. Acme — research"]', name);
    await page.click('.modal .cmpicker input');
    await sleep(250);
    await clickText('.cmpicker-item .name', 'Acme');
    await clickText('.modal button', 'Create');
    await page.waitForFunction(() => !document.querySelector('.modal'), { timeout: 4000 });
  }
  await page.waitForFunction(() => document.querySelectorAll('.timer-row').length >= 5, { timeout: 4000 });

  await setListSeg('Group', 'Flat');
  await page.waitForFunction(() => document.querySelectorAll('.group-head').length === 0
    && document.querySelectorAll('.timer-row').length >= 5, { timeout: 4000 });

  // A4: the board is ONE COLUMN now (teardown E1), which deletes the
  // getBoundingClientRect column geometry onBoardKey used to need. Down/Right
  // step forward through the list, Up/Left step back — the arrow keys still
  // walk every row, and they can no longer desync from what is on screen.
  const rowFocused = (n) => page.waitForFunction((i) => {
    const rows = [...document.querySelectorAll('.today-list .work-row')];
    return document.activeElement === rows[i];
  }, { timeout: 4000 }, n);
  await page.evaluate(() => document.querySelector('.today-list .work-row').focus());
  await page.keyboard.press('ArrowDown');
  await rowFocused(1);
  await page.keyboard.press('ArrowRight');
  await rowFocused(2);
  await page.keyboard.press('ArrowUp');
  await rowFocused(1);
  await page.keyboard.press('ArrowLeft');
  await rowFocused(0);

  // Shift+Enter still edits the focused row's TIMER, and Ctrl+Enter still
  // opens its entry — the two chords the merge could most easily have lost.
  await page.evaluate(() => document.querySelector('.today-list .timer-row').focus());
  await page.keyboard.down('Shift');
  await page.keyboard.press('Enter');
  await page.keyboard.up('Shift');
  await waitFor('.modal input[placeholder="e.g. Acme — research"]');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('.modal'), { timeout: 4000 });

  await page.evaluate(() => {
    const row = [...document.querySelectorAll('.today-list .timer-row')]
      .find((c) => c.textContent.includes('Acme research'));
    row.focus();
  });
  await page.keyboard.down('Control');
  await page.keyboard.press('Enter');
  await page.keyboard.up('Control');
  await waitFor('.modal-wide');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('.modal-wide'), { timeout: 5000 });

  await setListSeg('Group', 'By group'); // restore for later steps
});

// The teardown's §6/E9 finding: the inline narrative editor — the fastest path
// in the app — had NO discoverable affordance (cursor:text plus a :hover tint,
// both pointer-only). It is a real control on the row now, and this proves the
// control exists and still edits in place.
await step('narrative is editable in place from the row, with a visible control', async () => {
  await page.goto(`${base}/#/`, { waitUntil: 'networkidle0' });
  await waitFor('.today-list');
  const has = await page.evaluate(() =>
    !!document.querySelector('.today-list .narrative-editable, .today-list .narrative-write'));
  if (!has) throw new Error('no visible narrative control on any row of today\'s work');
  // COMPACT IS THE DEFAULT DENSITY (BRIEF, owner constraint 5: "denser than
  // today is better — provided it expands"), so the narrative lives in the
  // row's expandable half. The control is the same control and edits in the
  // same place; reaching it costs one disclosure, which is what the row's
  // chevron, a click on the row and `x` all do.
  await page.evaluate(() => {
    const el = document.querySelector('.today-list .narrative-editable, .today-list .narrative-write');
    const row = el.closest('.work-row');
    if (el.offsetParent === null) row.querySelector('.work-expand').click();
  });
  await page.waitForFunction(() =>
    document.querySelector('.today-list .narrative-editable, .today-list .narrative-write')?.offsetParent !== null,
    { timeout: 4000 });
  await page.evaluate(() => {
    const el = document.querySelector('.today-list .narrative-editable, .today-list .narrative-write');
    el.scrollIntoView({ block: 'center' });
    el.click();
  });
  await waitFor('.today-list .narrative-inline-input');
  const focused = await page.evaluate(() =>
    document.activeElement === document.querySelector('.today-list .narrative-inline-input'));
  if (!focused) throw new Error('the inline narrative editor did not take focus');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('.today-list .narrative-inline-input'), { timeout: 4000 });
});

// 2026-08-05 feedback, both halves: mouse-selecting text in an inline edit
// used to start a drag (a draggable ancestor eats the selection gesture), and
// a relocation gave no hint where the timer would land.
await step('drag: an open inline edit suspends it; hovering a row opens a drop slot', async () => {
  await setOnly('');
  // Drag-and-drop reorders the MANUAL order, so put the list in it first —
  // otherwise the reorder would be written to the server and be invisible on
  // screen, which is worse than not having the feature. (A drop switches the
  // list to manual on its own too; this just makes the assertion legible.)
  await setListSeg('Order', 'Manual');
  await page.waitForFunction(() => document.querySelectorAll('.today-list .timer-row').length >= 2,
    { timeout: 4000 });

  // (a) an open rename input takes the card out of the drag system entirely
  await page.click('.today-list .timer-row .timer-name');
  await waitFor('.today-list .timer-row .name-input');
  const whileEditing = await page.$eval('.today-list .timer-row',
    (el) => ({ draggable: el.getAttribute('draggable'), editing: el.classList.contains('editing') }));
  if (whileEditing.draggable !== 'false' || !whileEditing.editing) {
    throw new Error(`card still draggable while renaming: ${JSON.stringify(whileEditing)}`);
  }
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('.today-list .name-input'), { timeout: 4000 });
  await page.waitForFunction(() =>
    document.querySelector('.today-list .timer-row').getAttribute('draggable') === 'true',
    { timeout: 4000 });

  // (b) drag the SECOND card over the first: a slot opens immediately before
  // the first card (dropOn inserts before its target), and the dragged card
  // fades. Then drop, confirm the reorder, and drag it back so later steps
  // see the original order.
  const names = () => page.$$eval('.today-list .timer-row .timer-name', (els) => els.map((e) => e.textContent));
  const before = await names();
  const dragCardToCard = (fromName, toName, drop) => page.evaluate((from, to, doDrop) => {
    const card = (n) => [...document.querySelectorAll('.today-list .timer-row')]
      .find((c) => c.querySelector('.timer-name')?.textContent === n);
    const src = card(from); const tgt = card(to);
    if (!src || !tgt) throw new Error(`drag: missing card (${from}=${!!src}, ${to}=${!!tgt})`);
    const dt = new DataTransfer();
    src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
    tgt.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
    if (doDrop) tgt.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  }, fromName, toName, drop);

  await dragCardToCard(before[1], before[0], false);
  await page.waitForFunction((firstName) => {
    const slot = document.querySelector('.today-list .timer-drop-slot');
    const next = slot && slot.nextElementSibling;
    return !!slot
      && next?.classList.contains('work-row')
      && next.querySelector('.timer-name')?.textContent === firstName
      && document.querySelectorAll('.today-list .timer-row.dragging').length === 1;
  }, { timeout: 4000 }, before[0]);
  await shot('drop-slot');

  await dragCardToCard(before[1], before[0], true);
  await page.waitForFunction((want) => {
    const now = [...document.querySelectorAll('.today-list .timer-row .timer-name')].map((e) => e.textContent);
    return now[0] === want && !document.querySelector('.timer-drop-slot');
  }, { timeout: 4000 }, before[1]);

  await dragCardToCard(before[0], before[1], true);   // put it back
  await page.waitForFunction((want) => [...document.querySelectorAll('.today-list .timer-row .timer-name')]
    .map((e) => e.textContent).join('|') === want, { timeout: 4000 }, before.join('|'));

  // "Move to group…" and "Move up/down in the list" are the TOUCH equivalents
  // of the drag — dragging is not a touch path (teardown E1). They live in the
  // Edit-timer dialog now (wave-2: the row menu was seventeen items on a
  // phone), one row deep from the same ⋯, as real controls rather than 28px
  // popover rows.
  await page.click('.today-list .timer-row button[title="Row menu"]');
  await waitFor('.ctx-menu');
  await clickText('.ctx-menu .ctx-item', 'Edit timer');
  await waitFor('.modal .timer-lifecycle');
  const hasMove = await page.evaluate(() => [...document.querySelectorAll('.modal .timer-lifecycle button')]
    .some((b) => (b.getAttribute('title') || '').includes('Move down in the list')));
  if (!hasMove) throw new Error('Edit timer dialog missing the touch reorder (Move up/down)');
  const hasGroup = await page.evaluate(() => [...document.querySelectorAll('.modal select')]
    .some((s) => [...s.options].some((o) => o.textContent.trim() === 'Ungrouped')));
  if (!hasGroup) throw new Error('Edit timer dialog missing the "Group" move-to control');
  for (const label of ['Duplicate', 'Pin to float window', 'New entry (zero clock)', 'Delete timer']) {
    const there = await page.evaluate((t) => [...document.querySelectorAll('.modal .timer-lifecycle button')]
      .some((b) => b.textContent.trim().includes(t)), label);
    if (!there) throw new Error(`Edit timer dialog missing "${label}" — it left the row menu, it must land here`);
  }
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('.modal'), { timeout: 4000 });
  await setListSeg('Order', 'Recent activity');
});

// 2026-08-06 feedback: multi-select timers, right-click for a batch menu with
// a batch delete. Right-click on a single card already opened its menu.
await step('multi-select: ctrl/shift click, batch menu, batch delete, Esc clears', async () => {
  await setOnly('');
  await waitFor('.today-list .timer-row');
  const before = await page.$$eval('.today-list .timer-row', (els) => els.length);

  // Throwaway timers, so the batch delete can't disturb the fixtures later
  // steps count and search on. They land at the end of Ungrouped, in order,
  // which is what makes the shift-click range below meaningful.
  const probes = ['Batch probe A', 'Batch probe B', 'Batch probe C'];
  for (const name of probes) {
    await clickText('button', 'New timer');
    await type('.modal input[placeholder="e.g. Acme — research"]', name);
    await page.click('.modal .cmpicker input');
    await sleep(250);
    await clickText('.cmpicker-item .name', 'Acme');
    await clickText('.modal button', 'Create');
    await page.waitForFunction(() => !document.querySelector('.modal'), { timeout: 4000 });
  }
  await page.waitForFunction((want) => document.querySelectorAll('.today-list .timer-row').length === want,
    { timeout: 4000 }, before + 3);

  // ctrl-click two cards — and the ctrl-click must NOT open the rename input
  const ctrlClick = (name, shift = false) => page.evaluate((n, sh) => {
    const card = [...document.querySelectorAll('.today-list .timer-row')]
      .find((c) => c.querySelector('.timer-name')?.textContent === n);
    if (!card) throw new Error(`no card named ${n}`);
    card.querySelector('.timer-name').dispatchEvent(new MouseEvent('click', {
      bubbles: true, cancelable: true, ctrlKey: !sh, shiftKey: sh,
    }));
  }, name, shift);

  await ctrlClick(probes[0]);
  await ctrlClick(probes[1]);
  await page.waitForFunction(() => document.querySelectorAll('.timer-row.selected').length === 2
    && !document.querySelector('.name-input')
    && document.querySelector('.timer-selbar')?.textContent.includes('2 selected'), { timeout: 4000 });

  // shift-click extends the range to the third card
  await ctrlClick(probes[2], true);
  await page.waitForFunction(() => document.querySelectorAll('.timer-row.selected').length === 3,
    { timeout: 4000 });
  await shot('multi-select');

  // right-click inside the selection → BATCH menu, not the single-timer one
  await page.evaluate((n) => {
    const card = [...document.querySelectorAll('.today-list .timer-row')]
      .find((c) => c.querySelector('.timer-name')?.textContent === n);
    card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 200, clientY: 200 }));
  }, probes[0]);
  await waitFor('.ctx-menu');
  const menuText = await page.$eval('.ctx-menu', (el) => el.textContent);
  if (!menuText.includes('3 timers selected')) throw new Error(`batch menu missing its header: ${menuText}`);
  if (!menuText.includes('Delete 3 timers')) throw new Error(`batch menu missing batch delete: ${menuText}`);

  await clickText('.ctx-menu .ctx-item', 'Delete 3 timers');
  await waitFor('.modal');
  await clickText('.modal button', 'Delete');
  await page.waitForFunction((want) => document.querySelectorAll('.today-list .timer-row').length === want
    && !document.querySelector('.timer-selbar')
    && ![...document.querySelectorAll('.timer-name')].some((el) => el.textContent.startsWith('Batch probe')),
  { timeout: 4000 }, before);

  // right-click on a lone card still opens the ordinary single-timer menu —
  // which is the eight-item row menu now, with timer maintenance (and the
  // delete) one row deep in the Edit-timer dialog it opens (wave-2)
  await page.evaluate(() => document.querySelector('.today-list .timer-row')
    .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 200, clientY: 200 })));
  await waitFor('.ctx-menu');
  const single = await page.$eval('.ctx-menu', (el) => el.textContent);
  if (single.includes('timers selected')) throw new Error(`lone card opened the BATCH menu: ${single}`);
  if (!single.includes('Edit timer')) throw new Error(`single menu missing: ${single}`);
  // The fence counts the menu's VERBS. `data-kind="entry"` rows are the day's
  // own entries on this matter listed one per row — the only place the merged
  // row shows its parts — so their count is the day's data, not the menu's
  // design, and a matter billed four times must not read as a menu that grew
  // back. Every action row is still counted, which is what §5 was about.
  const rowItems = await page.$$eval(
    '.ctx-menu .ctx-item:not([data-kind="entry"]), .ctx-menu .ctx-custom', (els) => els.length);
  if (rowItems > 8) throw new Error(`the row menu is back over eight action items (${rowItems}) — teardown §5 named this object as the app's tell`);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('.ctx-menu'), { timeout: 4000 });
});

await step('/ opens the timer search bar; narrows in place; Esc restores', async () => {
  // dashboard route, body focus (not a card, not a form field) — `/` must
  // open the search bar rather than jumping to the Search view.
  await page.evaluate(() => { document.activeElement?.blur(); });
  await page.keyboard.press('/');
  await waitFor('.timer-search');
  await page.waitForFunction(() =>
    document.activeElement === document.querySelector('.timer-search'), { timeout: 4000 });

  await page.keyboard.type('meridian', { delay: 20 });
  await page.waitForFunction(() => {
    const names = [...document.querySelectorAll('.timer-row .timer-name')].map((e) => e.textContent);
    return names.length === 1 && names[0] === 'Harbor drafting'; // matched via CLIENT name
  }, { timeout: 4000 });
  // the count covers every row of today's work now (timers AND entries that no
  // timer owns), so it is asserted as a shape rather than a fixed total
  const narrowedCount = await page.$eval('.timer-search-wrap .muted', (el) => el.textContent);
  if (!/^1\/\d+$/.test(narrowedCount)) throw new Error(`match count wrong: ${narrowedCount}`);

  // zero matches must not trap the keyboard: over-type past any match, then
  // Backspace back down to a matching query — all via native input editing
  await page.keyboard.type('zzz', { delay: 20 });
  await page.waitForFunction(() => document.querySelectorAll('.work-row').length === 0, { timeout: 4000 });
  const zeroCount = await page.$eval('.timer-search-wrap .muted', (el) => el.textContent);
  if (!/^0\/\d+$/.test(zeroCount)) throw new Error(`match count wrong: ${zeroCount}`);
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  await page.waitForFunction(() => {
    const names = [...document.querySelectorAll('.timer-row .timer-name')].map((e) => e.textContent);
    return names.length === 1 && names[0] === 'Harbor drafting';
  }, { timeout: 4000 });

  // repeat `/` while the bar is already open: click a card (focus leaves the
  // input; the bar stays up because the filter is set), press `/` again — it
  // must refocus the input rather than no-op on unchanged searchOpen state.
  // focus a row directly — every painted thing on it (name, tenths, start,
  // the ⋯) is interactive, and the HH:MM:SS reading that used to be the one
  // inert spot only exists while a timer is running now
  await page.evaluate(() => document.querySelector('.timer-row').focus());
  await page.waitForFunction(() =>
    document.activeElement !== document.querySelector('.timer-search'), { timeout: 4000 });
  await page.keyboard.press('/');
  await page.waitForFunction(() =>
    document.activeElement === document.querySelector('.timer-search'), { timeout: 4000 });

  await page.keyboard.press('Escape'); // bar closes, filter clears, focus lands on a card
  await page.waitForFunction(() => !document.querySelector('.timer-search')
    && document.querySelectorAll('.timer-row').length >= 5, { timeout: 4000 });
  await page.waitForFunction(() =>
    document.activeElement && document.activeElement.classList.contains('work-row'), { timeout: 4000 });
});

await step('calendar renders month grid with data', async () => {
  await page.goto(`${base}/#/calendar`, { waitUntil: 'networkidle0' });
  await waitFor('.cal-grid');
  await page.waitForFunction(() => document.querySelectorAll('.cal-day').length === 42);
});

await step('search finds the entry', async () => {
  await page.goto(`${base}/#/search`, { waitUntil: 'networkidle0' });
  await type('[data-search-q]', 'lease');
  await page.waitForFunction(
    () => document.querySelectorAll('table.tk tbody tr').length >= 1
      && document.body.textContent.includes('Acme'),
    { timeout: 5000 });
});

await step('stats renders bars', async () => {
  await page.goto(`${base}/#/stats`, { waitUntil: 'networkidle0' });
  await waitFor('.stat-tiles');
  await waitFor('.bar-row');
});

await step('custom fields: define on client, entry enforces + carries value', async () => {
  // dedicated client/matter so the required field can't gate the later
  // close-out sweeps (they finalize whole days on the Acme matters)
  await page.evaluate(async () => {
    await fetch('/api/cms', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cm_number: '777888-000001', short_name: 'CF Smoke', billable: 1 }),
    });
  });

  // define a required dropdown "Phase" on the client, through the C&M UI
  await page.goto(`${base}/#/cms`, { waitUntil: 'networkidle0' });
  await waitFor('.client-row');
  await page.evaluate(() => {
    const row = [...document.querySelectorAll('.client-row')].find((r) => r.textContent.includes('777888'));
    [...row.querySelectorAll('button')].find((b) => b.textContent.includes('Fields')).click();
  });
  await waitFor('.modal form input[placeholder="New field name, e.g. Phase"]');
  await page.type('.modal form input[placeholder="New field name, e.g. Phase"]', 'Phase');
  await page.select('.modal form select', 'select');
  await waitFor('.modal form input[placeholder="options, comma-separated"]');
  await page.type('.modal form input[placeholder="options, comma-separated"]', 'P100, P200');
  await page.click('.modal form .checkbox-row input');
  await clickText('.modal form button', 'Add');
  await page.waitForFunction(() => document.querySelectorAll('.modal .custom-field-row').length >= 1, { timeout: 4000 });
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('.modal'), { timeout: 4000 });

  // a new entry on the matter renders the field and gates finalize
  await page.goto(`${base}/#/`, { waitUntil: 'networkidle0' });
  await waitFor('.today-list');
  await pressGlobal('n');
  await waitFor('.modal .cmpicker input');
  await page.click('.modal .cmpicker input');
  await page.type('.modal .cmpicker input', '777888', { delay: 5 });
  await clickText('.cmpicker-item .name', 'CF Smoke');
  await waitFor('.custom-fields-row select');
  await page.evaluate(() => {
    const total = document.querySelector('.modal-wide .total-input');
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    set.call(total, '0.5');
    total.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.type('.modal-wide textarea', 'Reviewed the phase-coded workstream in detail today.');
  await page.waitForFunction(
    () => document.querySelector('.saving-dot')?.textContent.includes('Saved'), { timeout: 6000 });
  await editorMore('Finalize');
  await page.waitForFunction(() => document.body.textContent.includes('"Phase" is required'), { timeout: 4000 });
  await page.select('.custom-fields-row select', 'P100');
  await editorMore('Finalize');
  await page.waitForFunction(() => !document.querySelector('.modal-wide'), { timeout: 5000 });
});

// Export is a DIALOG over the entries ledger now, not a page of its own
// (teardown §12, and the standing critic's re-measure: "28 visible interactive
// controls, all 28 above the fold, first and only table row at y=486"). Same
// three formats, same deep links, same file contents — one screen fewer.
await step('export offers CSV, .TIM and text, as a dialog over the ledger', async () => {
  await page.goto(`${base}/#/export`, { waitUntil: 'networkidle0' });
  await waitFor('.export-modal');
  await page.waitForFunction(() => {
    const names = [...document.querySelectorAll('.export-format .export-format-name')]
      .map((n) => n.textContent);
    return names.some((t) => t.includes('Copy as text'))
      && names.some((t) => t.includes('Download CSV'))
      && names.some((t) => t.includes('Download .TIM'));
  }, { timeout: 5000 });
  // …and the ledger is still underneath it: this is a mode of Entries, not a
  // second copy of the entry table.
  await page.waitForFunction(() => document.querySelectorAll('table.tk tbody tr').length > 0);
  await shot('export');
});

await step('export view: row actions edit and finalize a not-finalized entry', async () => {
  const cms = await (await fetch(`${base}/api/cms`)).json();
  const created = await (await fetch(`${base}/api/entries`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      date: todayLocal(), cm_id: cms[0].id, narrative: 'Reviewed export action wiring correspondence.',
      tasks: [{ task_code: 'Review', duration: 0.6, fragment: '' }],
    }),
  })).json();

  await page.goto(`${base}/#/export/unfinalized`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() =>
    [...document.querySelectorAll('table.tk tbody tr')].some((r) => r.textContent.includes('export action wiring')));

  // Same two capabilities, where they live now (teardown E8: one primary
  // action plus one labelled overflow, never five unlabelled ghost icons).
  // "Edit" is the row's own open affordance — the matter name, exactly as on
  // the dashboard's entry row; "Finalize" is an item in the row's "⋯" menu.
  await page.evaluate(() => {
    const row = [...document.querySelectorAll('table.tk tbody tr')].find((r) => r.textContent.includes('export action wiring'));
    row.querySelector('.ledger-open').click();
  });
  await waitFor('.modal-wide');
  await page.waitForFunction(() => document.body.textContent.includes('export action wiring'));
  await shot('export-row-edit');
  await clickText('.modal-wide button', 'Done');
  await page.waitForFunction(() => !document.querySelector('.modal-wide'), { timeout: 5000 });

  await page.evaluate(() => {
    const row = [...document.querySelectorAll('table.tk tbody tr')].find((r) => r.textContent.includes('export action wiring'));
    row.querySelector('.ledger-more').click();
  });
  await waitFor('.ctx-menu');
  await clickText('.ctx-item', 'Finalize this entry');
  await page.waitForFunction(() =>
    ![...document.querySelectorAll('table.tk tbody tr')].some((r) => r.textContent.includes('export action wiring')),
  { timeout: 5000 });

  await fetch(`${base}/api/entries/${created.id}`, { method: 'DELETE' });
});

// The range presets used to live on the Export page. There is one range
// vocabulary now and it belongs to the ledger, behind "Filters" — the same
// five presets and the same two date inputs, feeding the same export.
await step('ledger range presets: This month sets from=1st, to=today', async () => {
  await page.goto(`${base}/#/entries`, { waitUntil: 'networkidle0' });
  await waitFor('.ledger-filter-btn');
  await page.click('.ledger-filter-btn');
  await waitFor('.ledger-filters');
  await clickText('.ledger-filters .filter-presets button', 'This month');
  const { fromVal, toVal, today } = await page.evaluate(() => {
    const inputs = document.querySelectorAll('.ledger-filters input[type="date"]');
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    return { fromVal: inputs[0].value, toVal: inputs[1].value, today: `${y}-${m}-${d}` };
  });
  if (!fromVal.endsWith('-01')) throw new Error(`This month "from" should be the 1st, got ${fromVal}`);
  if (toVal !== today) throw new Error(`This month "to" should be today (${today}), got ${toVal}`);
});

// THE EXPORT DIALOG'S THREE PROMISES, in one pass:
//   1. the ledger's header opens it scoped to what the ledger is showing;
//   2. the bulk bar opens it scoped to the entries you picked (the standing
//      critic: "there is no way to export the entries you just picked out");
//   3. it refuses to write a blank billing line. `narrative_empty` is a BLOCK
//      in lib/validation.js, so only an included DRAFT can be blank — and the
//      page this replaced wrote three of them into a .TIM with an empty na=.
await step('export dialog: header scope, selection scope, blank-narrative fence', async () => {
  const cms = await (await fetch(`${base}/api/cms`)).json();
  const blank = await (await fetch(`${base}/api/entries`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      date: todayLocal(), cm_id: cms[0].id, narrative: '',
      tasks: [{ task_code: 'Review', duration: 0.3, fragment: '' }],
    }),
  })).json();

  await page.goto(`${base}/#/entries`, { waitUntil: 'networkidle0' });
  // A hash-only goto is a same-document navigation, so the ledger keeps the
  // chips the previous steps applied. This one starts from an unfiltered
  // ledger on purpose — the header's Export is scoped to what is on screen.
  await page.reload({ waitUntil: 'networkidle0' });
  await waitFor('.ledger-export-btn');
  await page.click('.ledger-export-btn');
  await waitFor('.export-modal');
  await page.waitForFunction(() => !!document.querySelector('.export-scope-count'), { timeout: 6000 });
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('.export-modal'), { timeout: 4000 });

  // 2. the selection path
  await page.evaluate(() => {
    document.querySelector('table.tk tbody tr:not(.ledger-daybreak) td[data-col="select"] input').click();
  });
  await waitFor('.ledger-bulk-export');
  await page.click('.ledger-bulk-export');
  await waitFor('.export-modal');
  await page.waitForFunction(() => !!document.querySelector('.export-scope-count'), { timeout: 6000 });
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('.export-modal'), { timeout: 4000 });

  // 3. drafts in scope, one of them blank: CSV and .TIM refuse and say why;
  //    "Copy as text" stays available because it marks nothing as sent.
  await waitFor('.ledger-stat-unfinalized');
  await page.click('.ledger-stat-unfinalized');
  await page.waitForFunction(() =>
    [...document.querySelectorAll('.ledger-chip')].some((c) => c.textContent.includes('Draft')));
  await page.click('.ledger-export-btn');
  await waitFor('.export-formats');
  await page.waitForFunction(() => document.body.textContent.includes('no narrative'), { timeout: 6000 });
  const state = await page.evaluate(() =>
    [...document.querySelectorAll('.export-format')].map((b) => ({ t: b.textContent, off: b.disabled })));
  const row = (t) => state.find((s) => s.t.includes(t));
  if (row('Copy as text').off) throw new Error('Copy as text must stay available — it marks nothing as sent');
  if (!row('Download CSV').off) throw new Error('CSV must refuse while an entry in scope has no narrative');
  if (!row('Download .TIM').off) throw new Error('.TIM must refuse while an entry in scope has no narrative');
  await shot('export-blank-fence');
  await page.keyboard.press('Escape');

  await fetch(`${base}/api/entries/${blank.id}`, { method: 'DELETE' });
});

// Time-leakage chain (TODO 2026-08-03): an unfinalized entry on a day that is
// already over has to be visible on the dashboard, and the pill has to land on
// a list that is actually showing it — right filter, wide enough range.
//
// Where that list lives changed, not what it must contain: #/export/<filter>/
// <from> is the entries ledger with that filter's CHIPS applied (teardown §12:
// "keep the deep-link contract pointing at the ledger with that chip applied").
// The pill says *Review*, so no download dialog opens over the rows it brought
// the reader here to read.
await step('stalled time: banner pill → ledger filtered to exactly those entries', async () => {
  const cms = await (await fetch(`${base}/api/cms`)).json();
  const yesterday = (() => {
    const d = new Date(); d.setDate(d.getDate() - 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  })();
  const stalled = await (await fetch(`${base}/api/entries`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      date: yesterday, cm_id: cms[0].id, narrative: 'Reviewed stalled matter correspondence.',
      tasks: [{ task_code: 'Review', duration: 0.6, fragment: '' }],
    }),
  })).json();

  await page.goto(`${base}/#/`, { waitUntil: 'networkidle0' });
  // The four flat grey chips (whose only affordance was a pointer-only
  // tooltip) are gone: unfinalized time from a day that is already over leads
  // the attention band, carries its amber rail, and is itself the link to the
  // filtered ledger (teardown §3 / D3; wave-2 folded the banner ROW and the
  // backlog link row into one 44px band).
  await page.waitForFunction(() =>
    [...document.querySelectorAll('.attn-link-stale')].some((b) => b.textContent.includes('not finalized')));
  await shot('attention-banner');
  await clickText('.attn-link-stale', 'not finalized');

  await page.waitForFunction(() =>
    [...document.querySelectorAll('.ledger-chip')].some((c) => c.textContent.includes('Draft')));
  if (await page.$('.export-modal')) throw new Error('a Review link must not open a download dialog');
  // The chips flip synchronously on the route change but the filtered rows
  // arrive from a fetch, so reading the table straight away races the render.
  // Swallow the timeout — the assertions below produce the useful message.
  await page.waitForFunction(() =>
    [...document.querySelectorAll('table.tk tbody tr')]
      .some((r) => r.textContent.includes('stalled matter correspondence')),
  { timeout: 5000 }).catch(() => {});
  const { fromVal, rows } = await page.evaluate(() => {
    const chip = [...document.querySelectorAll('.ledger-chip')]
      .find((c) => c.textContent.trim().startsWith('From '));
    return {
      fromVal: chip ? chip.textContent.replace(/[^\d-]/g, '') : '',
      rows: [...document.querySelectorAll('table.tk tbody tr')].map((r) => r.textContent),
    };
  });
  // the pill opens on the oldest stalled entry, so the range must reach back
  // at least to yesterday — a narrower one would show an empty list
  if (fromVal > yesterday) throw new Error(`range should reach ${yesterday}, got from=${fromVal}`);
  if (!rows.some((r) => r.includes('stalled matter correspondence'))) {
    throw new Error('the flagged entry is not in the filtered list');
  }
  if (rows.some((r) => r.includes('✓'))) throw new Error('an exported entry leaked into the "Not finalized" list');
  await shot('export-filtered');

  await fetch(`${base}/api/entries/${stalled.id}`, { method: 'DELETE' });
});

await step('settings pages: bare route = General; submenu reaches AI / .TIM / codes', async () => {
  await page.goto(`${base}/#/settings`, { waitUntil: 'networkidle0' });
  await waitFor('.subnav'); // Settings navlink expanded into category links
  await page.waitForFunction(() => document.body.textContent.includes('Theme')); // default page = General
  await page.click('.subnavlink:nth-child(2)'); // AI assist
  await page.waitForFunction(() => document.body.textContent.includes('AI narrative assist'));
  await page.goto(`${base}/#/settings/export`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => document.body.textContent.includes('.TIM export'));
  await page.goto(`${base}/#/settings/codes`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => document.body.textContent.includes('Task codes'));
  await shot('settings');
});

await step('dark mode applies', async () => {
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
  await page.goto(`${base}/#/`, { waitUntil: 'networkidle0' });
  await waitFor('.meter-bar');
  // Assert the *property* of a dark theme (dark page, light text) rather than
  // one exact hex, so a palette revision in tokens.css does not read as a
  // regression here. The capability under test is "the dark tokens apply".
  const { bg, fg } = await page.evaluate(() => {
    const s = getComputedStyle(document.body);
    return { bg: s.backgroundColor, fg: s.color };
  });
  const lum = (css) => {
    const [r, g, b] = css.match(/\d+(\.\d+)?/g).slice(0, 3).map((n) => Number(n) / 255);
    const f = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  if (lum(bg) > 0.06) throw new Error(`dark surface not applied: body background ${bg}`);
  if (lum(fg) < 0.5) throw new Error(`dark text not applied: body color ${fg}`);
  await shot('dashboard-dark');
});

await step('activity filters (Today / Yesterday / Week / Recent) survive as a list filter', async () => {
  // They used to be a role="tablist" of activity tabs above the timers — the
  // wrong component for filtering one panel, and eleven controls a phone had
  // to scroll past before it could start a timer. Same four windows, now a
  // segmented control in the list's ⋯ menu, with the active one shown as a
  // removable pill next to the list title.
  await page.emulateMediaFeatures([]);
  await page.goto(`${base}/#/`, { waitUntil: 'networkidle0' });
  await openListMenu();
  const labels = await page.$$eval('.ctx-menu .seg[aria-label="Show"] button', (els) => els.map((e) => e.textContent.trim()));
  for (const want of ['All', 'Today', 'Yesterday', 'Week', 'Recent']) {
    if (!labels.includes(want)) throw new Error(`missing activity filter "${want}" — got: ${labels.join(', ')}`);
  }
  await closeMenu();
  await setListSeg('Show', 'Yesterday');
  await page.waitForFunction(() => [...document.querySelectorAll('.filter-pill')]
    .some((p) => p.textContent.includes('Yesterday')), { timeout: 4000 });
  // and it is removable in place, without reopening the menu
  await page.click('.filter-pill');
  await page.waitForFunction(() => !document.querySelector('.filter-pill'), { timeout: 4000 });
});

// Add todo / Run /todo / Float timer left the primary navigation in the
// ui-overhaul wave (a control that launches a full-permission coding agent is
// not a lawyer's navigation item) and live in Settings → Tools. Same buttons,
// same events, same two-click arming — one route further in.
await step('add-todo button: Settings → Tools → note box → TODO entry filed (no screenshot)', async () => {
  await page.goto(`${base}/#/settings/tools`, { waitUntil: 'networkidle0' });
  // Tools is a settings SECTION now, not app.js's own panel: it renders inside
  // the settings shell (one sub-navigation, the section switcher, on a phone)
  // rather than beside it. Same four controls, same events — `.set-tools`
  // replaces `.tools-list` as the list they live in.
  await waitFor('.set-tools');
  await clickText('.set-tools > button', 'Add todo');
  await waitFor('.feedback-note', 4000);
  // No screenshot preview on this path — the note files on its own.
  const hasShot = await page.evaluate(() => !!document.querySelector('.feedback-shot'));
  if (hasShot) throw new Error('add-todo path should not show a screenshot preview');
  await page.type('.feedback-note', 'E2E: quick todo from the button', { delay: 5 });
  await clickText('.modal button', 'Add todo');
  await page.waitForFunction(() => document.body.textContent.includes('Todo added'), { timeout: 4000 });
  await page.waitForFunction(() => !document.querySelector('.feedback-note'), { timeout: 4000 });
  const todo = readFileSync(join(dir, 'TODO.md'), 'utf8');
  if (!todo.includes('## UI feedback (screenshots)')) throw new Error('feedback section missing from TODO.md');
  if (!todo.includes('E2E: quick todo from the button')) throw new Error('todo note not appended to TODO.md');
  const line = todo.split('\n').find((l) => l.includes('E2E: quick todo from the button')) || '';
  if (!line.includes('no screenshot')) throw new Error(`add-todo entry should record "no screenshot": ${line}`);
});

// The float's "Open entry" button (2026-07-15 feedback) rides this event —
// pip.js dispatches it on the main window, which owns the editor modal.
// Document PiP itself can't open in headless Chromium, so exercise the
// main-window half of the contract directly.
await step('tk:open-entry event opens the entry editor (float → main app)', async () => {
  const entries = await (await fetch(`${base}/api/entries?from=2020-01-01&to=2099-12-31`)).json();
  if (!entries.length) throw new Error('no entries to open');
  await page.goto(`${base}/#/`, { waitUntil: 'networkidle0' });
  await page.evaluate((id) =>
    window.dispatchEvent(new CustomEvent('tk:open-entry', { detail: { id } })), entries[0].id);
  await waitFor('.modal-wide');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('.modal-wide'), { timeout: 4000 });
});

// Regression (2026-07-15 feedback): the day view's "Finalize day" button was
// wired as onClick=${finalizeDay}, so the click event landed in the ack
// parameter and JSON.stringify(body) died on the circular DOM structure
// before the request was ever sent. An empty far-past day keeps this
// side-effect-free: the only success signal is the "Nothing to finalize" toast.
// `#/day/<date>` is a deep link into the Calendar now (teardown §8) — the day
// is a panel under the month grid, and its rare actions (summary, finalize,
// download) are the ONE "⋯" menu that screen and the Today screen now share
// instead of two toolbars arranging the same four words two different ways.
// Same capabilities, one tap deeper; the assertions below are unchanged.
await step('day summary: menu item and `s` render the day as plain text', async () => {
  await page.goto(`${base}/#/day/${todayLocal()}`, { waitUntil: 'networkidle0' });
  await waitFor('.day-panel .entry-card, .day-panel .blankslate');
  await page.click('.day-panel-menu');
  await clickText('.ctx-menu .ctx-item', 'Summary');
  await waitFor('.summary-text');
  const text = await page.$eval('.summary-text', (el) => el.textContent);
  for (const needle of ['Acme lease dispute', '100001-000012', '1.2h', 'Reviewed lease agreement']) {
    if (!text.includes(needle)) throw new Error(`summary missing ${JSON.stringify(needle)}:\n${text}`);
  }
  if (!/^.+ — \d+\.\d+h/.test(text)) throw new Error(`summary header malformed:\n${text.split('\n')[0]}`);
  await shot('summary');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('.summary-text'), { timeout: 4000 });
  // same summary from the keyboard alone
  await pressGlobal('s');
  await waitFor('.summary-text');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('.summary-text'), { timeout: 4000 });
});

await step('day view: Finalize day posts cleanly (no circular-JSON crash)', async () => {
  await page.goto(`${base}/#/day/2020-01-01`, { waitUntil: 'networkidle0' });
  await waitFor('.day-panel-menu');
  await page.click('.day-panel-menu');
  await clickText('.ctx-menu .ctx-item', 'Finalize day');
  await page.waitForFunction(() => document.body.textContent.includes('Nothing to finalize'), { timeout: 4000 });
});

// Last data-mutating step (per plan): finalizes and exports today's drafts,
// so it runs after everything else that reads today's entry/timer state.
await step('alt+drag feedback: select region → note box → TODO entry filed', async () => {
  await page.goto(`${base}/#/`, { waitUntil: 'networkidle0' });
  await waitFor('.today-list');
  // Synthetic Alt+drag; the launch flag auto-accepts the tab capture, so
  // this exercises the REAL screenshot path end to end.
  await page.evaluate(() => {
    const opts = (x, y) => ({ bubbles: true, cancelable: true, clientX: x, clientY: y, altKey: true, button: 0 });
    document.querySelector('.main').dispatchEvent(new MouseEvent('mousedown', opts(200, 200)));
    document.dispatchEvent(new MouseEvent('mousemove', opts(420, 330)));
    document.dispatchEvent(new MouseEvent('mouseup', opts(420, 330)));
  });
  // real tab capture (getDisplayMedia → video frame → canvas) can take well
  // over the default 5s on a loaded box — and if this wait gives up early,
  // the note modal opens AFTER the step ends, poisoning the close-out
  // step's entry-editor fence check with a false "n leaked".
  await waitFor('.feedback-note', 30000);
  const hasShot = await page.evaluate(() => !!document.querySelector('.feedback-shot'));
  if (!hasShot) throw new Error('annotated screenshot preview missing from the note box');
  await page.type('.feedback-note', 'E2E: tighten this area', { delay: 5 });
  await clickText('.modal button', 'Save feedback');
  await page.waitForFunction(() => document.body.textContent.includes('Feedback filed'), { timeout: 4000 });
  await page.waitForFunction(() => !document.querySelector('.feedback-note'), { timeout: 4000 });
  const todo = readFileSync(join(dir, 'TODO.md'), 'utf8');
  if (!todo.includes('## UI feedback (screenshots)')) throw new Error('feedback section missing from TODO.md');
  if (!todo.includes('E2E: tighten this area')) throw new Error('feedback note not appended to TODO.md');
  const shots = readdirSync(join(dir, 'feedback'));
  if (shots.length !== 1 || !shots[0].endsWith('.png')) throw new Error(`expected one saved png, got ${JSON.stringify(shots)}`);
  if (!todo.includes(`feedback/${shots[0]}`)) throw new Error('TODO entry does not reference the saved screenshot');
});

// CLOSE THE DAY. The capability under test is unchanged — `c` sweeps the day's
// drafts, finalizes them and exports the CSV in one pass — but the shape it is
// asserted through is the review LIST that replaced the card carousel
// (teardown §18, wave-1 review F2). What changed in the assertions, and why:
//
//   phase   'sweep' → 'review'. There is no card stack to walk, so there is no
//           per-card phase and no `.closeout-dot` pagination to count; the
//           whole day is on screen at once and the panel carries the shape as
//           data-need / data-ready.
//   'summary' is gone. It existed only to show a count between the last card
//           and the commit; the list shows that count the entire time.
//   the end  a day with nothing left over closes with a snackbar instead of a
//           terminal dialog — the last fixed interaction in the flow, and a
//           dialog whose only control is "Done" is not a decision. The panel
//           still stands, and still says what and why, whenever something
//           could NOT be finalized, so both endings are accepted here.
//
// Everything the old step proved, this step still proves: the fence, that the
// seeded draft ends up finalized, and that it ends up exported.
await step('one-sweep close-out: the review list finalizes & exports the day (c)', async () => {
  const cms = await (await fetch(`${base}/api/cms`)).json();
  const acme = cms.find((c) => c.short_name === 'Acme lease dispute') || cms[0];
  const seeded = await (await fetch(`${base}/api/entries`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      date: todayLocal(),
      cm_id: acme.id,
      narrative: 'Reviewed the closing checklist and confirmed signature pages with opposing counsel.',
      tasks: [{ task_code: 'Review', duration: 0.4, fragment: '' }],
    }),
  })).json();

  await page.evaluate(() => { document.activeElement?.blur(); });
  await pressGlobal('c');
  await waitFor('.closeout-card');
  await page.waitForFunction(() => document.querySelector('.closeout-card')?.dataset.phase === 'review',
    { timeout: 6000 });
  // the just-seeded draft is on the list — it already has a narrative, so it
  // is in the Ready band rather than costing a card
  await page.waitForFunction((name) => document.querySelector('.closeout-card')?.textContent.includes(name),
    { timeout: 4000 }, acme.short_name);

  // global-shortcut fence: while the sweep is up, `n` must NOT open the entry
  // editor underneath the overlay (CloseOut's capture listener stops
  // propagation of unhandled keys before app.js's bubble handler sees them)
  await pressGlobal('n');
  await sleep(300);
  // (`.modal` is the entry-editor panel — the dialog shell moved to the shared
  // .ovl primitive, so the panel, not a per-dialog backdrop, is the tell.)
  if (await page.$('.modal')) throw new Error('global `n` leaked under the close-out overlay');
  if (!(await page.$('.closeout-card'))) throw new Error('close-out vanished after the fence check');

  // A LIST, NOT A CAROUSEL. Every draft that still needs words is on screen at
  // once (one .co-item each), the ones that are already written are counted in
  // the Ready band instead of being walked through, and the dot pagination —
  // which could only ever say "card 3 of 5" — is gone.
  const shape = await page.$eval('.closeout-card', (el) => ({
    need: Number(el.dataset.need),
    ready: Number(el.dataset.ready),
    items: el.querySelectorAll('.co-item').length,
    dots: el.querySelectorAll('.closeout-dot').length,
  }));
  await shot('closeout-review');
  if (shape.ready < 1) {
    throw new Error(`the seeded draft has a narrative and should be Ready, not a card: ${JSON.stringify(shape)}`);
  }
  if (shape.items !== shape.need) {
    throw new Error(`every draft needing words must be on screen: ${JSON.stringify(shape)}`);
  }
  if (shape.dots > 0) throw new Error('the carousel pagination is back');

  // EDIT NO LONGER DESTROYS THE SWEEP. It used to call onClose(true), so
  // correcting one entry cost the whole pass and Escape left you on Today with
  // no review at all. The editor opens OVER it (the overlay stack is LIFO) and
  // the review is still standing, still in `review`, when the editor closes.
  if (shape.need > 0) {
    await clickText('.closeout-card .co-item button', 'Edit');
    await waitFor('.ovl-panel.modal', 8000);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.ovl-panel.modal'), { timeout: 6000 });
    await sleep(400);
    const survived = await page.$eval('.closeout-card', (el) => el.dataset.phase).catch(() => null);
    if (survived !== 'review') throw new Error(`Edit destroyed the review (phase=${survived})`);
  }

  // ACCEPT ALL — the ordinary day where every pre-filled suggestion is right.
  // The rows it writes leave the "needs a narrative" band, which is the proof
  // that it wrote them.
  const hasAcceptAll = await page.evaluate(() => [...document.querySelectorAll('.closeout-card button')]
    .some((b) => b.textContent.includes('Accept all')));
  if (hasAcceptAll) {
    await clickText('.closeout-card button', 'Accept all');
    await page.waitForFunction((n) => Number(document.querySelector('.closeout-card')?.dataset.need) < n,
      { timeout: 8000 }, shape.need);
  }

  // One control commits the whole day: it writes anything still standing in a
  // field, finalizes, and downloads the CSV.
  await clickText('.closeout-card button', 'Finalize & export');
  // Two legitimate endings: the panel reports what could not be finalized, or
  // — with nothing left to decide — it closes itself behind a snackbar.
  const settle = async (warnOk) => (await page.waitForFunction((ok) => {
    const p = document.querySelector('.closeout-card');
    if (!p) return 'gone';
    const ph = p.dataset.phase;
    if (ph === 'warn') return ok ? 'warn' : false;
    return ph === 'closed' || ph === 'blocked' ? ph : false;
  }, { timeout: 10000 }, warnOk)).jsonValue();

  let phase = await settle(true);
  if (phase === 'warn') {
    // the harness's entries must be clean to reach here on a warning, not a
    // hard block — assert the warning card, then accept and finalize anyway.
    const hasAccept = await page.evaluate(() => [...document.querySelectorAll('.closeout-card button')]
      .some((b) => b.textContent.includes('Accept warnings & finalize')));
    if (!hasAccept) throw new Error('warn phase reached without an "Accept warnings & finalize" button (hard block?)');
    await clickText('.closeout-card button', 'Accept warnings & finalize');
    phase = await settle(false);
  }
  if (phase === 'blocked') throw new Error('nothing finalized, so nothing was exported');
  // Either way the lawyer is told the day closed — in the panel that explains
  // the leftovers, or in the snackbar when there are none.
  await page.waitForFunction(() => document.body.textContent.includes('Day closed'), { timeout: 4000 });
  if (phase === 'closed') {
    await shot('closeout-closed');
    await clickText('.closeout-card button', 'Done');
  }
  await page.waitForFunction(() => !document.querySelector('.closeout-card'), { timeout: 4000 });

  const after = await (await fetch(`${base}/api/entries/${seeded.id}`)).json();
  if (after.status !== 'finalized') throw new Error(`seeded draft was not finalized: status=${after.status}`);
  if (!after.exported_at) throw new Error('seeded draft was finalized but never marked exported');
});

await browser.close();
server.close();
db.close();
rmSync(dir, { recursive: true, force: true });

// 422 responses are the finalize validation gate saying "not yet" — several
// steps trigger one on purpose (required custom field, warn-ack flow), and
// the browser logs every non-2xx fetch as a console error.
const real = problems.filter((p) => !p.includes('favicon')
  && !(p.startsWith('console.error:') && p.includes('status of 422')));
if (real.length) {
  console.error(`\nE2E PROBLEMS (${real.length}):`);
  for (const p of real) console.error('  - ' + p);
  process.exit(1);
}
console.log('\nE2E SMOKE: ALL CLEAR');
