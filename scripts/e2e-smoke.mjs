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
//
// The board came back in e6bccee and that ⋯ came back with it, on the board's
// own head as `.board-menu-btn`; it kept the `.today-menu-btn` class precisely
// so the menu it opens is still reached the same way. Same menu, same items.
const openListMenu = async () => {
  await waitFor('.today-menu-btn');
  await page.click('.today-menu-btn');
  await waitFor('.ctx-menu');
};
const closeMenu = async () => {
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('.ctx-menu'), { timeout: 8000 });
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
// ---------------------------------------------------------------------------
// GROUP MEMBERSHIP, WHERE IT IS NOW VISIBLE.
//
// RETIRED with the merged list (e6bccee): `.timer-section` + `.group-head` —
// the labelled band per group, its live row count, its "Drop timers here"
// empty state, and the section as a drop target. The board is a grid of tiles
// with three bands of its own (front / Recent / the rest), and a second set of
// bands cut through it by group would fight the fixed positions the front row
// exists to give him.
//
// The membership those heads reported is still stated, and still live: the
// board ⋯ menu's "Only" control names every group and prints its COUNT. These
// helpers read it, so an assertion that used to count rows under a head counts
// the same timers where the app now says so.
const groupCounts = async () => {
  await openListMenu();
  const opts = await page.evaluate(() => {
    const sel = document.querySelector('.ctx-menu select');
    return sel ? [...sel.options].map((o) => o.textContent.trim()) : null;
  });
  await closeMenu();
  if (!opts) throw new Error('no "Only" control in the board menu — group membership has nowhere to be read');
  const counts = {};
  for (const text of opts) {
    const m = text.match(/^(.*)\s\((\d+)\)$/);
    if (m) counts[m[1]] = Number(m[2]);
  }
  return counts;
};
// What the "Only" control currently says it is showing — the pill beside the
// list title used to say this, and it went with the sections.
const onlyLabel = async () => {
  await openListMenu();
  const label = await page.evaluate(() => {
    const sel = document.querySelector('.ctx-menu select');
    if (!sel) return null;
    const opt = sel.selectedOptions[0] || sel.options[0];
    return (opt?.textContent || '').replace(/\s\(\d+\)$/, '').trim();
  });
  await closeMenu();
  return label;
};
const groupCountIs = async (label, want) => {
  for (let i = 0; i < 20; i += 1) {
    const counts = await groupCounts();
    if (counts[label] === want) return;
    await sleep(150);
  }
  throw new Error(`"${label}" never reached ${want} timers: ${JSON.stringify(await groupCounts())}`);
};
// The drop target that REPLACED the section: dropping one tile on another moves
// the dragged timer into the target tile's group as well as its position
// (`dropOn` in timergrid.js does both), which is the whole of what dropping on
// a section head used to do — minus the head.
const dndTileToTile = (fromName, toName) => page.evaluate((from, to) => {
  const tile = (n) => [...document.querySelectorAll('.timer-board .timer-tile')]
    .find((t) => t.querySelector('.timer-name')?.textContent === n);
  const src = tile(from); const tgt = tile(to);
  if (!src || !tgt) throw new Error(`dndTileToTile: missing tile (${from}=${!!src}, ${to}=${!!tgt})`);
  const dt = new DataTransfer();
  src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
  tgt.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
  tgt.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
}, fromName, toName);

// ---------------------------------------------------------------------------
// A TIMER IS A TILE ON THE BOARD (e6bccee), not a row in the day's list. It
// keeps the `.timer-row` class, so a selector that only ever meant "the timer"
// still lands; what moved is everything that used to be true of it as a ROW —
// its running class is `is-running`, its name is a label rather than a rename
// field, and its clock reads HH:MM:SS rather than tenths. These helpers act on
// a tile BY NAME, which is how every one of these steps meant to address it.
// THE BOARD HIDES SEVENTY-FIVE OF EIGHTY-FOUR, AND THAT MADE THIS SUITE
// ORDER-DEPENDENT. The fixture starts with a handful of timers, so the board
// renders flat and everything is on screen. As later steps create their own
// scratch timers it crosses nine, banding kicks in, and a step looking for a
// timer by name finds it or does not depending on how many timers happen to
// exist at that moment. Three consecutive runs produced three different
// failure sets, which is worse than a failing suite: nobody can tell signal
// from noise.
//
// So every tile lookup reveals the whole board first. This is not a workaround
// for a bug — hiding the tail is the feature — it is the suite saying "I am
// asking about a specific timer, not about what is on screen". The step that
// asserts what IS on screen by default builds its own crowd and does not call
// this.
const revealAllTimers = async () => {
  await page.evaluate(() => {
    const b = document.querySelector('.board-more');
    if (b && /Show all/.test(b.textContent)) b.click();
  });
  await sleep(250);
};

const tileAct = async (name, title) => {
  await revealAllTimers();
  await page.waitForFunction((nm, t) => [...document.querySelectorAll('.timer-board .timer-tile')]
    .some((x) => x.querySelector('.timer-name')?.textContent === nm && x.querySelector(`button[title="${t}"]`)),
  { timeout: 6000 }, name, title);
  await page.evaluate((nm, t) => {
    const tile = [...document.querySelectorAll('.timer-board .timer-tile')]
      .find((x) => x.querySelector('.timer-name')?.textContent === nm);
    tile.scrollIntoView({ block: 'center' });
    tile.querySelector(`button[title="${t}"]`).click();
  }, name, title);
};
const tileRunning = async (name) => { await revealAllTimers(); return page.waitForFunction((nm) =>
  [...document.querySelectorAll('.timer-board .timer-tile.is-running')]
    .some((x) => x.querySelector('.timer-name')?.textContent === nm), { timeout: 6000 }, name); };
// The tile's own reading of a timer: the ticking clock (only rendered while it
// runs or holds unfiled time) and the day's filed record.
const tileState = async (name) => { await revealAllTimers(); return page.evaluate((nm) => {
  const tile = [...document.querySelectorAll('.timer-board .timer-tile')]
    .find((x) => x.querySelector('.timer-name')?.textContent === nm);
  if (!tile) return null;
  return {
    clock: tile.querySelector('.timer-clock')?.textContent.trim() ?? null,
    hours: tile.querySelector('.timer-hours')?.textContent.trim() ?? null,
    zero: !!tile.querySelector('.timer-hours.is-zero'),
    running: tile.classList.contains('is-running'),
  };
}, name); };
// Open a tile's row menu and click one of its items.
const tileMenu = async (name, itemText) => {
  await tileAct(name, 'Row menu');
  await waitFor('.ctx-menu');
  await clickText('.ctx-menu .ctx-item', itemText);
};
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
  // A brand-new account has no timers and no entries, so the dashboard shows
  // its designed empty state rather than the bare "+ New timer" row.
  //
  // MIGRATED: the empty state used to live INSIDE `.today-list`, because Today
  // was one merged list. The board split (e6bccee) means a page with nothing on
  // it has neither a board nor an entries list to put an empty state in — the
  // whole view is the one blankslate, and `.today-list` does not render at all.
  // So this asserts the same designed empty state where it now stands, and
  // names it, which the bare selector never did.
  await waitFor('.dashboard-view .blankslate');
  const heading = await page.$eval('.dashboard-view .blankslate .blankslate-heading',
    (el) => el.textContent.trim());
  if (heading !== 'Nothing tracked today') {
    throw new Error(`the empty dashboard is not the designed blank slate: "${heading}"`);
  }
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
  const entriesBefore = await (await fetch(`${base}/api/entries?date=${todayLocal()}`)).json();
  const before = await tileState('Acme research');
  await page.click('.timer-row button[title="Start"]');
  await sleep(1200);
  await page.click('.timer-row button[title="Stop & file time"]');
  await sleep(500);
  // MIGRATED, and it proves more than it did. The old form read the row's
  // decimal clock and demanded "0.0" with a "00:00…" title. A tile only prints
  // `.timer-clock` while the timer runs or is holding unfiled time (timertile.js
  // — a board of eighty-four idle tiles may not carry eighty-four 00:00:00s), so
  // on the new surface the ABSENCE of that clock is the statement "there is
  // nothing on this timer", which is exactly what a full revert means. The day's
  // record must be untouched too — the figure beside the clock is the matter's
  // filed hours, which this matter already carries from the first step, so it
  // is asserted UNCHANGED rather than zero — and the entry count is checked at
  // the server rather than inferred from a title string.
  const after = await tileState('Acme research');
  if (!after || after.running) throw new Error(`the misclicked timer is still running: ${JSON.stringify(after)}`);
  if (after.clock !== null) throw new Error(`a sub-2s stop left time on the clock: ${after.clock}`);
  if (after.hours !== before.hours) {
    throw new Error(`the day's record moved on a misclick: ${before.hours} → ${after.hours}`);
  }
  const entriesAfter = await (await fetch(`${base}/api/entries?date=${todayLocal()}`)).json();
  if (entriesAfter.length !== entriesBefore.length) {
    throw new Error(`a sub-2s stop filed an entry: ${entriesBefore.length} → ${entriesAfter.length}`);
  }
});

await step('backdated start (10m ago) → stop → the entry FINISHES ITSELF, inline, no dialog', async () => {
  await page.click('.timer-row button[title="Row menu"]');
  await waitFor('.ctx-menu');
  await clickText('.ctx-menu .ctx-inline button', '10m');
  // `.running` → `.is-running`: a tile states its state in the `is-` prefix the
  // rest of the board uses (`is-front`, `is-selected`), not in the bare class
  // the row list used.
  await page.waitForFunction(() => document.querySelector('.timer-row.is-running'), { timeout: 4000 });
  await page.click('.timer-row button[title="Stop & file time"]');
  await waitFor('.stop-chips'); // lightweight affordance…
  if (await page.$('.modal')) throw new Error('stop must not open a modal'); // …not a blocking one
  await shot('stop-chips');
  // teardown §17 / E2: the offer is a state of the row that stopped, not a
  // fixed slab floating over the middle of the page.
  const anchored = await page.$eval('.stop-chips', (el) => ({
    // MIGRATED, not weakened. The board split means "the stopped row" is two
    // objects: a `.timer-tile` on the board, or a `.work-row` in today's
    // entries. The old form checked only `.work-row`, which the offer still
    // satisfied AFTER it wrongly relocated into the entries panel — so it
    // could not catch the very regression it was there for.
    inRow: !!el.closest('.timer-tile, .work-row'), position: getComputedStyle(el).position,
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
  // ONE ROW PER ENTRY — the merge, DELIBERATELY REVERSED (e6bccee).
  //
  // RETIRED: "the matter's entries merge onto one row", which this step used to
  // prove by finding a row carrying two `.work-entry` lines. The two-section
  // split undoes it on purpose: the board is the buttons and this list is the
  // RECORD, and a merged row hid a matter's second entry behind its first —
  // one hours figure, one narrative, the other entry reachable only through the
  // ⋯ menu.
  //
  // The capability that replaced it is the one the merge cost: EVERY entry the
  // day holds has its own row, its own hours and its own narrative. So this
  // asserts what the merged row could not — that the Acme matter's two entries
  // (the one step 1 finalized and the one this timer just filed) are two rows,
  // not one — and that the list hides nothing, by counting it against the
  // server's own answer for the day.
  const dayNow = await (await fetch(`${base}/api/entries?date=${todayLocal()}`)).json();
  await page.waitForFunction((n) => document.querySelectorAll('.today-list .work-row').length === n,
    { timeout: 6000 }, dayNow.length).catch(async () => {
    const rows = await page.$$eval('.today-list .work-row', (els) => els.length);
    throw new Error(`the day's record is not one row per entry: ${rows} rows for ${dayNow.length} entries`);
  });
  const acmeRows = await page.$$eval('.today-list .work-row', (els) => els
    .filter((el) => el.textContent.includes('100001-000012'))
    .map((el) => el.querySelector('.work-hours, .timer-clock')?.textContent.trim()));
  if (acmeRows.length < 2) {
    throw new Error(`the matter's second entry is hidden behind its first: ${JSON.stringify(acmeRows)}`);
  }
  if (new Set(acmeRows).size < 2) {
    throw new Error(`two rows for one matter must each state their OWN hours: ${JSON.stringify(acmeRows)}`);
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

  // MIGRATED: a timer is addressed on the BOARD now, by name. It used to be
  // addressed in `.today-list` because that list held the timers too; the
  // entries list that replaced it is keyed by MATTER ("Stale-check B") and
  // never carries a timer's name at all — so a by-name search there matches
  // nothing and neither of the two starts this step turns on ever happens.
  const rowAct = (name, title) => tileAct(name, title);
  // Backdated 30m through the row menu, the same UI path the step above uses —
  // an API start would not tell the running page, and reloading would destroy
  // the very surface this step is about.
  const startBackdated = async (name) => {
    await rowAct(name, 'Row menu');
    await waitFor('.ctx-menu');
    await clickText('.ctx-menu .ctx-inline button', '30m');
    await tileRunning(name);
  };
  // Everything the offer is currently claiming, read straight off the DOM.
  const readOffer = () => page.evaluate(() => {
    const el = document.querySelector('.stop-chips');
    if (!el) return null;
    const settledEl = el.querySelector('[data-stop-settled]');
    return {
      head: el.querySelector('.stop-chips-head')?.textContent.replace(/\s+/g, ' ').trim() || '',
      // WHICH OBJECT THE OFFER IS SITTING ON. It mounts on the thing he
      // pressed, and that is the TILE now (stopchips.js looks for
      // `.timer-board .timer-tile[data-timer-id]` first), so the anchor's
      // identity is the timer's id — the entry's id was only ever a proxy for
      // "the row that stopped". Both are read, so this says what it found
      // whichever surface the offer chose.
      timerId: el.closest('.timer-tile')?.dataset.timerId || null,
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
  // The offer must have re-derived itself for B: B's tile, B's pre-fill. When
  // it has not, say what it is showing instead — a bare timeout here reads as
  // flake, and this exact failure is a cross-client narrative on screen.
  //
  // MIGRATED: the anchor identity is B's TIMER now rather than B's entry,
  // because the offer mounts on the tile he pressed Stop on. It is the same
  // claim — "this surface belongs to the stop that just happened, not to the
  // previous one" — read off the object that surface now hangs from.
  await page.waitForFunction((tid, want) => {
    const el = document.querySelector('.stop-chips');
    if (!el) return false;
    if (el.closest('.timer-tile')?.dataset.timerId !== String(tid)) return false;
    return el.querySelector('[data-stop-settled]')?.getAttribute('data-stop-settled') === want;
  }, { timeout: 10000 }, tB.id, B_TOP).catch(async () => {
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

// SETTING A TIMER'S CLOCK BY HAND.
//
// RETIRED (e6bccee): the tap-to-edit decimal clock ON the row, with its ±0.1
// pills. A timer is a BUTTON now and a button carries two controls — one
// transport and one overflow — because the same row at his real density put
// 445 controls on the page. The tile's `.timer-clock` is a reading, not a
// field, and it is HH:MM:SS (a decimal beside a decimal was the "1.7 clock 0.0"
// defect in another costume).
//
// The capability moved one tap, into the dialog that already owned the timer's
// name, matter, task code, group and template: Edit timer → "Clock now
// (decimal hours)". This drives it there, and asserts the board shows the
// result — which is the half that actually matters to him.
const setClockVia = async (timerName, hours) => {
  await tileMenu(timerName, 'Edit timer');
  await waitFor('.modal .timer-lifecycle-clock input');
  await page.evaluate((h) => {
    const inp = document.querySelector('.modal .timer-lifecycle-clock input');
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    set.call(inp, h);
    inp.dispatchEvent(new Event('input', { bubbles: true }));
  }, String(hours));
  await clickText('.modal button', 'Save');
  await page.waitForFunction(() => !document.querySelector('.modal'), { timeout: 5000 });
};

await step('timer clock is settable by hand, and the board shows it', async () => {
  // MIGRATED, and the old premise no longer holds twice over. It waited for the
  // tile to print `01:24:00` and asserted the clock and the record were two
  // different numbers. But `PUT /api/timers/:id/clock` calls syncToEntry on a
  // PAUSED timer, so setting the clock FILES it the same instant — there is no
  // unfiled remainder for the tile to print — and the tile's figure is TODAY'S
  // RECORD ON THE MATTER, which includes every entry on it, not this one
  // timer's clock.
  //
  // So what "the board shows it" can honestly mean is: the hand-set figure
  // reached the record, and the board's number moved to include it. That is
  // asserted as a DELTA rather than a hardcoded total, so the step does not
  // silently encode whatever else the fixture happens to have filed on that
  // matter by the time it runs.
  await revealAllTimers();
  const before = Number((await tileState('Acme research'))?.hours ?? 0);
  await setClockVia('Acme research', '1.4');
  await revealAllTimers();
  await page.waitForFunction((was) => {
    const tile = [...document.querySelectorAll('.timer-board .timer-tile')]
      .find((t) => t.querySelector('.timer-name')?.textContent === 'Acme research');
    const now = Number(tile?.querySelector('.timer-hours')?.textContent.trim());
    return Number.isFinite(now) && now > was;
  }, { timeout: 8000 }, before);

  const state = await tileState('Acme research');
  // …and it is NOT also printed as a clock. A fully filed clock beside the
  // record would be the same quantity twice in two notations — the thing the
  // old assertion was really protecting, now true by construction rather than
  // by inspection.
  if (state.clock) {
    throw new Error(`a fully filed clock must not be printed twice: ${JSON.stringify(state)}`);
  }
  if (!(Number(state.hours) > before)) {
    throw new Error(`setting the clock by hand never reached the board: ${before} -> ${JSON.stringify(state)}`);
  }
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
  // Same proof, on the board: `.running` is `.is-running` on a tile, and the
  // timers live there rather than in the day's list.
  await tileRunning('__excl-A__');

  // clicking Start on B must stop A server-side and pop A's stop chips
  await tileAct('__excl-B__', 'Start');
  await waitFor('.stop-chips');
  const filedHead = await page.$eval('.stop-chips-head', (el) => el.textContent);
  if (!filedHead.includes('Exclusive scratch')) throw new Error(`chips are not for the auto-stopped timer: "${filedHead}"`);
  await page.waitForFunction(() => {
    const running = [...document.querySelectorAll('.timer-board .timer-tile.is-running')];
    return running.length === 1 && running[0].querySelector('.timer-name')?.textContent === '__excl-B__';
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
  // MIGRATED, with one signal RETIRED. The row used to carry `.unassigned` as
  // well as `.running`; a tile carries neither the class nor the "Assign
  // matter" button, because it is a button that starts a clock and the missing
  // matter is a defect of the ENTRY, not of the button — which is where the
  // rest of this step already proves it (the chips head says "no matter yet",
  // and the filed row carries `.unassigned` and the Assign control). What the
  // board owes is the running state, and it is asserted here.
  await tileRunning('Quick timer');
  // running state reaches the OS chrome: tab title carries ▶ clock + name
  // (5s poll + 1s tick), favicon swaps to the recording-dot variant
  await page.waitForFunction(() => document.title.startsWith('▶')
    && document.title.includes('Quick timer'), { timeout: 10000 });
  const favRunning = await page.evaluate(() =>
    document.querySelector('link[rel="icon"]').getAttribute('href').includes('circle'));
  if (!favRunning) throw new Error('favicon did not switch to the running variant');
  await sleep(2200); // past the misclick grace so the stop files for real
  await tileAct('Quick timer', 'Stop & file time');
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

// RETIRED (e6bccee): click-the-name-to-rename ON the row. The tile's
// `.timer-name` is a label, not a button — a tile has one transport and one
// overflow, and a name that turns into a text field under a thumb is a
// mis-tap waiting to happen on a board he scans by name. (It is also what made
// the ctrl-click multi-select below need a "and it must NOT open the rename
// input" guard, which now has nothing to guard against.)
//
// Renaming lives one tap in, in the Edit-timer dialog that already owns the
// timer's name — and it is the same rename: this proves it round-trips and
// that the BOARD shows the new name, which is the half a reader cares about.
await step('timer name is editable, and the board follows the rename', async () => {
  const rename = async (from, to) => {
    await tileMenu(from, 'Edit timer');
    await waitFor('.modal input[placeholder="e.g. Acme — research"]');
    await page.evaluate((val) => {
      const inp = document.querySelector('.modal input[placeholder="e.g. Acme — research"]');
      const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      set.call(inp, val);
      inp.dispatchEvent(new Event('input', { bubbles: true }));
    }, to);
    await clickText('.modal button', 'Save');
    await page.waitForFunction(() => !document.querySelector('.modal'), { timeout: 5000 });
    await page.waitForFunction((want) => [...document.querySelectorAll('.timer-board .timer-name')]
      .some((el) => el.textContent === want), { timeout: 5000 }, to);
  };
  await rename('Acme research', 'Acme research (renamed)');
  // rename back so later steps' name references hold
  await rename('Acme research (renamed)', 'Acme research');
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
  // the entry is reopened from the row's ⋯ menu.
  //
  // RETIRED here: "that menu names each of the day's entries on that matter by
  // its narrative". It named them because the row was keyed by MATTER and had
  // folded several entries into one; the entries panel is one row per entry
  // now, so the menu has exactly one entry to speak for and says "Open entry…".
  // The fallback below already accepted that wording, and it is what the step
  // uses; nothing about reopening the SAME entry changed.
  await page.evaluate(() => {
    const row = [...document.querySelectorAll('.today-list .work-row')]
      .find((c) => c.textContent.includes('Review lease terms'));
    if (!row) throw new Error('the entry is not in today’s record');
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

await step('groups: create from the board menu, assign from the row menu, membership counts, move by drag, persist; A–Z present', async () => {
  // The ten-tab strip is gone (teardown §5: role="tab" over one filtered panel
  // was the wrong component, and it sat above the timers on a phone). Every
  // capability it carried lives in the board's ⋯ menu or the row's ⋯ menu, and
  // each now has a touch path it did not have before.
  //
  // RETIRED (e6bccee): the group SECTION — `.timer-section` with its
  // `.group-head`, its live row count and its "Drop timers here" empty state.
  // The board is three bands of its own (a front row he owns, Recent, and the
  // rest behind one disclosure) and a second banding cut through it by group
  // would fight the fixed positions the front row exists to give him.
  //
  // The membership those heads reported is still stated, and still live: the
  // board ⋯ menu's "Only" control names every group and prints its COUNT. So
  // every "N rows under this head" assertion below is now "N timers in this
  // group", read where the app says it. See the `groupCounts` helper.
  await openListMenu();
  await clickText('.ctx-menu .ctx-item', 'New group');
  await type('.modal input[placeholder="e.g. Litigation"]', 'Litigation');
  await clickText('.modal button', 'Create');
  await page.waitForFunction(() => !document.querySelector('.modal'), { timeout: 4000 });

  await setListSeg('Group', 'By group');
  // the new group exists, starts empty, and the lone existing timer is still
  // Ungrouped
  await groupCountIs('Litigation', 0);
  await groupCountIs('Ungrouped', 1);

  // "ONLY THIS GROUP" — the tab strip's job, as a filter. It is still chosen
  // here, still stored per grouping mode, and still the thing the Rename and
  // Delete items below act on. RETIRED with the sections: the pill beside the
  // list title that showed the choice and cleared it in one tap. The choice is
  // shown and cleared in the same control that sets it now, so this asserts it
  // round-trips there — set, read back, cleared, read back.
  await setOnly('Litigation');
  if (await onlyLabel() !== 'Litigation') throw new Error(`the "Only" choice is not shown back: ${await onlyLabel()}`);
  await setOnly('');
  if (!/^Every /.test(await onlyLabel())) throw new Error(`the "Only" choice is not clearable in place: ${await onlyLabel()}`);

  // Assign the existing timer to Litigation. The row menu was seventeen items
  // and 57% of a phone screen (teardown §5, "the tell"), so timer maintenance
  // — duplicate, group, reorder, pin, zero, delete — moved into the Edit-timer
  // dialog the menu still opens in one row (wave-2). The group select lives
  // there beside the timer's name and matter, where it always belonged.
  await tileMenu('Acme research', 'Edit timer');
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
  // …and the move really happened: one in, one out.
  await groupCountIs('Litigation', 1);
  await groupCountIs('Ungrouped', 0);

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

  // MOVING A TIMER BETWEEN GROUPS BY DRAG. The section that used to be the drop
  // target is gone, but the drop is not: dropping one TILE on another moves the
  // dragged timer into the target tile's group as well as to its position
  // (`dropOn` in timergrid.js does both), which is everything dropping on a
  // section head did minus the head. Real dragstart/dragover/drop handlers, in
  // both directions, as before — a second group and a second timer to carry it.
  await openListMenu();
  await clickText('.ctx-menu .ctx-item', 'New group');
  await type('.modal input[placeholder="e.g. Litigation"]', 'General');
  await clickText('.modal button', 'Create');
  await page.waitForFunction(() => !document.querySelector('.modal'), { timeout: 4000 });
  await groupCountIs('General', 0);

  await clickText('button', 'New timer');
  await type('.modal input[placeholder="e.g. Acme — research"]', 'Group probe');
  await page.click('.modal .cmpicker input');
  await sleep(250);
  await clickText('.cmpicker-item .name', 'Acme');
  await page.evaluate(() => {
    const sel = [...document.querySelectorAll('.modal select')]
      .find((s) => [...s.options].some((o) => o.textContent.trim() === 'General'));
    if (!sel) throw new Error('no Group control in the New timer dialog');
    sel.value = [...sel.options].find((o) => o.textContent.trim() === 'General').value;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await clickText('.modal button', 'Create');
  await page.waitForFunction(() => !document.querySelector('.modal'), { timeout: 4000 });
  await groupCountIs('General', 1);

  await dndTileToTile('Acme research', 'Group probe');   // into General
  await groupCountIs('General', 2);
  await groupCountIs('Litigation', 0);
  await shot('groups');

  // and back again — the drag is not one-way
  await tileMenu('Group probe', 'Edit timer');
  await waitFor('.modal select');
  await page.evaluate(() => {
    const sel = [...document.querySelectorAll('.modal select')]
      .find((s) => [...s.options].some((o) => o.textContent.trim() === 'Litigation'));
    sel.value = [...sel.options].find((o) => o.textContent.trim() === 'Litigation').value;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await clickText('.modal button', 'Save');
  await page.waitForFunction(() => !document.querySelector('.modal'), { timeout: 4000 });
  await dndTileToTile('Acme research', 'Group probe');   // back into Litigation
  await groupCountIs('Litigation', 2);
  await groupCountIs('General', 0);

  // the probe has done its job; later steps count timers, so take it away
  await tileMenu('Group probe', 'Edit timer');
  await clickText('.modal .timer-lifecycle button', 'Delete timer');
  await clickText('.modal:not(.modal-wide) button', 'Delete');
  await page.waitForFunction(() => ![...document.querySelectorAll('.timer-board .timer-name')]
    .some((el) => el.textContent === 'Group probe'), { timeout: 5000 });

  // the isolation persists across reload (tk:timerOnly:<mode>), per mode — the
  // pill that used to report it went with the sections, so it is read back out
  // of the control that sets it
  await setOnly('Litigation');
  await page.reload({ waitUntil: 'networkidle0' });
  await waitFor('.timer-row');
  if (await onlyLabel() !== 'Litigation') {
    throw new Error(`the "Only" choice did not survive a reload: ${await onlyLabel()}`);
  }
  await setOnly('');
});

await step('grouping: by client / flat / persists across reload (board ⋯ menu)', async () => {
  await setListSeg('Group', 'By client');
  // Acme's client is deliberately left unnamed, and a client with no name is
  // named by its 6-digit NUMBER rather than dropping out of the list — the
  // substance of the old by-client head, read where sections now report
  // themselves (the ⋯ menu's "Only" control).
  //
  // RETIRED with the heads: the "· unnamed" hint that sat beside that number.
  // It was a caption on a band that no longer exists; the number standing in
  // for a name is the fact it was captioning, and that is asserted.
  const clients = await groupCounts();
  if (!(clients['100001'] >= 1)) {
    throw new Error(`an unnamed client is not labelled by its number: ${JSON.stringify(clients)}`);
  }

  await setListSeg('Group', 'Flat');
  // Flat is the mode with nothing to isolate, so the ⋯ drops the "Only" control
  // altogether — the same statement the vanishing `.group-head`s used to make.
  await openListMenu();
  const stillOffersOnly = await page.evaluate(() => !!document.querySelector('.ctx-menu select'));
  await closeMenu();
  if (stillOffersOnly) throw new Error('Flat grouping still offers an "Only this section" control');
  await page.waitForFunction(() => document.querySelectorAll('.timer-row').length >= 1, { timeout: 4000 });
  await page.reload({ waitUntil: 'networkidle0' });
  await waitFor('.timer-row');
  const on = await listSegOn('Group');
  if (on !== 'Flat') throw new Error(`grouping did not persist: ${on}`);
  await setListSeg('Group', 'By group');
  await groupCountIs('Litigation', 1);
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
  // the by-client grouping now shows the name instead of the number — read off
  // the ⋯ menu's "Only" control, which is where a client section states itself
  // since the `.group-head`s went with the merged list
  await page.goto(`${base}/#/`, { waitUntil: 'networkidle0' });
  await setListSeg('Group', 'By client');
  await groupCountIs('Acme Holdings', 1);
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

  // the by-client section picks up the rename after a reload (real /api/timers
  // refetch) — same assertion, read off the "Only" control that replaced the
  // `.group-head` as the place a client section names itself
  await page.goto(`${base}/#/`, { waitUntil: 'networkidle0' });
  await setListSeg('Group', 'By client');
  await page.reload({ waitUntil: 'networkidle0' });
  await waitFor('.timer-row');
  await groupCountIs('Acme Holdings LLC', 1);
  await setListSeg('Group', 'By group'); // restore for later steps
});

await step('grid keyboard: focus, Alt-nudge, Enter start/stop; worked-today highlight', async () => {
  // The dashboard is still in by-group mode; drop any "Only this group"
  // isolation so every group's timers render together — this step needs to see
  // Acme research alongside the fresh ungrouped timers it creates below.
  await setOnly('');
  await revealAllTimers();
  await page.waitForFunction(() => [...document.querySelectorAll('.timer-row')]
    .some((c) => c.textContent.includes('Acme research')), { timeout: 8000 });

  // a second, untouched timer proves the worked/zero distinction
  await clickText('button', 'New timer');
  await type('.modal input[placeholder="e.g. Acme — research"]', 'Harbor drafting');
  await page.click('.modal .cmpicker input');
  await sleep(250);
  await clickText('.cmpicker-item .name', 'Harbor Lease');
  await clickText('.modal button', 'Create');
  await revealAllTimers();
  await page.waitForFunction(() => document.querySelectorAll('.timer-row').length >= 2, { timeout: 8000 });

  // WORKED TODAY vs UNTOUCHED. RETIRED: the row's `.worked` tint. A tile spends
  // its colour on one thing — the running clock — and a second background state
  // across eighty-four tiles is a wash, not a signal. What replaced it is a
  // FIGURE: every tile prints the day's filed hours on its matter, and the one
  // with nothing on the books prints 0.0 marked `.is-zero`. Same distinction,
  // stated in a number a lawyer can read rather than a tint he has to learn.
  const acme = await tileState('Acme research');
  const harbor = await tileState('Harbor drafting');
  if (!acme || acme.zero) throw new Error(`Acme reads as untouched: ${JSON.stringify(acme)}`);
  if (!harbor || !harbor.zero) throw new Error(`a zero timer must read as zero: ${JSON.stringify(harbor)}`);

  const focusAcme = () => page.evaluate(() => {
    [...document.querySelectorAll('.timer-board .timer-tile')]
      .find((c) => c.querySelector('.timer-name')?.textContent === 'Acme research').focus();
  });
  // MIGRATED to the figure the tile actually prints. This read `.timer-clock`
  // in HH:MM:SS, but `PUT /api/timers/:id/clock` files a paused timer's clock
  // the same instant it sets it, and a stopped tile only prints a clock when it
  // holds time that is NOT yet filed — otherwise it would print one quantity
  // twice in two notations. So the nudge is asserted on the hours figure, which
  // is the same number: 1.4 + 0.1 = 1.5, then −0.2 = 1.3.
  // Asserted as a DELTA. The tile's figure is today's record on the MATTER, so
  // its absolute value depends on whatever else the fixture has filed there by
  // the time this step runs; the nudge is what is under test, and a nudge is a
  // difference. `Alt+↑` adds a tenth, `Alt+↓` takes one away.
  const acmeHours = async () => Number((await tileState('Acme research'))?.hours);
  const acmeHoursMoved = (from, delta) => page.waitForFunction((f, d) => {
    const card = [...document.querySelectorAll('.timer-board .timer-tile')]
      .find((c) => c.querySelector('.timer-name')?.textContent === 'Acme research');
    const now = Number(card?.querySelector('.timer-hours')?.textContent.trim());
    return Number.isFinite(now) && Math.abs(now - (f + d)) < 0.001;
  }, { timeout: 8000 }, from, delta);

  const h0 = await acmeHours();
  await focusAcme();
  await page.keyboard.down('Alt');
  await page.keyboard.press('ArrowUp');           // +0.1
  await page.keyboard.up('Alt');
  await acmeHoursMoved(h0, 0.1);
  await page.keyboard.down('Alt');
  await page.keyboard.down('Shift');
  await page.keyboard.press('ArrowDown');          // −0.2 → 1.3
  await page.keyboard.up('Shift');
  await page.keyboard.up('Alt');
  await acmeHoursMoved(h0, -0.1);

  await page.keyboard.press('Enter');              // start
  await page.waitForFunction(() => document.querySelector('.timer-row.is-running'), { timeout: 4000 });
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
  await page.waitForFunction(() => document.querySelectorAll('.timer-row').length >= 5, { timeout: 4000 });

  // A4: the board is ONE COLUMN now (teardown E1), which deletes the
  // getBoundingClientRect column geometry onBoardKey used to need. Down/Right
  // step forward through the list, Up/Left step back — the arrow keys still
  // walk every row, and they can no longer desync from what is on screen.
  //
  // MIGRATED: the walk is asserted by the row KEY the focus lands on rather
  // than by an index into `.today-list .work-row`. The roving tabindex spans
  // both surfaces now (a tile on the board, a row in the day's record), so an
  // index into one of the two lists names the wrong element the moment the walk
  // crosses over — and the claim was never about indices. It is that Right
  // repeats Down, Left repeats Up, and that stepping back lands you exactly
  // where you were.
  const focusedKey = () => page.evaluate(() =>
    document.activeElement?.getAttribute('data-row-key') || null);
  const stepTo = async (key, want) => {
    await page.keyboard.press(key);
    await page.waitForFunction((k) => document.activeElement?.getAttribute('data-row-key') === k,
      { timeout: 4000 }, want);
  };
  await page.evaluate(() => document.querySelector('.timer-board .timer-tile').focus());
  const k0 = await focusedKey();
  if (!k0) throw new Error('focusing a tile did not give the roving tabindex a row key');
  await page.keyboard.press('ArrowDown');
  await page.waitForFunction((prev) => {
    const k = document.activeElement?.getAttribute('data-row-key');
    return k && k !== prev;
  }, { timeout: 4000 }, k0);
  const k1 = await focusedKey();
  await page.keyboard.press('ArrowRight');            // Right repeats Down
  await page.waitForFunction((prev) => {
    const k = document.activeElement?.getAttribute('data-row-key');
    return k && k !== prev;
  }, { timeout: 4000 }, k1);
  const k2 = await focusedKey();
  if (k2 === k0) throw new Error('ArrowRight walked backwards');
  await stepTo('ArrowUp', k1);
  await stepTo('ArrowLeft', k0);                      // Left repeats Up

  // Shift+Enter still edits the focused row's TIMER, and Ctrl+Enter still
  // opens its entry — the two chords the merge could most easily have lost.
  await page.evaluate(() => document.querySelector('.timer-board .timer-tile').focus());
  await page.keyboard.down('Shift');
  await page.keyboard.press('Enter');
  await page.keyboard.up('Shift');
  await waitFor('.modal input[placeholder="e.g. Acme — research"]');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('.modal'), { timeout: 4000 });

  await page.evaluate(() => {
    [...document.querySelectorAll('.timer-board .timer-tile')]
      .find((c) => c.querySelector('.timer-name')?.textContent === 'Acme research').focus();
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
await step('drag: the dragged tile says so; a drop reorders the board', async () => {
  await setOnly('');
  // Drag-and-drop reorders the MANUAL order, so put the list in it first —
  // otherwise the reorder would be written to the server and be invisible on
  // screen, which is worse than not having the feature. (A drop switches the
  // list to manual on its own too; this just makes the assertion legible.)
  await setListSeg('Order', 'Manual');
  await page.waitForFunction(() => document.querySelectorAll('.timer-board .timer-tile').length >= 2,
    { timeout: 4000 });

  // (a) RETIRED with the row: "an open rename input takes the card out of the
  // drag system". The gesture it protected was mouse-selecting text inside an
  // inline edit ON the timer (a draggable ancestor eats the selection), and a
  // tile has no inline edit to select in — its name is a label, and renaming
  // moved into the Edit-timer dialog, which is a modal and cannot be dragged at
  // all. What survives, and is asserted, is the OTHER half of that feedback: a
  // relocation must say what is moving.
  //
  // (b) drag the SECOND tile over the first and confirm the board says a drag
  // is under way; then drop, confirm the reorder, and drag it back so later
  // steps see the original order.
  //
  // RETIRED: `.timer-drop-slot`, the gap that opened where the timer would
  // land. A one-column list could open a full-width gap without moving anything
  // else; on a wrapping tile grid the same gap reflows every tile after it, so
  // the hint would move the very positions the board exists to keep still. The
  // dragged tile carries `.is-dragging` (it fades) and the drop is proved by
  // the ORDER it produces, which is what the slot was predicting.
  const names = () => page.$$eval('.timer-board .timer-tile .timer-name', (els) => els.map((e) => e.textContent));
  const before = await names();
  const dragCardToCard = (fromName, toName, drop) => page.evaluate((from, to, doDrop) => {
    const card = (n) => [...document.querySelectorAll('.timer-board .timer-tile')]
      .find((c) => c.querySelector('.timer-name')?.textContent === n);
    const src = card(from); const tgt = card(to);
    if (!src || !tgt) throw new Error(`drag: missing card (${from}=${!!src}, ${to}=${!!tgt})`);
    const dt = new DataTransfer();
    src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
    tgt.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
    if (doDrop) tgt.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  }, fromName, toName, drop);

  await dragCardToCard(before[1], before[0], false);
  await page.waitForFunction((movingName) => {
    const dragging = [...document.querySelectorAll('.timer-board .timer-tile.is-dragging')];
    return dragging.length === 1
      && dragging[0].querySelector('.timer-name')?.textContent === movingName;
  }, { timeout: 4000 }, before[1]);
  await shot('drop-slot');

  await dragCardToCard(before[1], before[0], true);
  await page.waitForFunction((want) => {
    const now = [...document.querySelectorAll('.timer-board .timer-tile .timer-name')].map((e) => e.textContent);
    return now[0] === want && !document.querySelector('.timer-board .timer-tile.is-dragging');
  }, { timeout: 4000 }, before[1]);

  await dragCardToCard(before[0], before[1], true);   // put it back
  await page.waitForFunction((want) => [...document.querySelectorAll('.timer-board .timer-tile .timer-name')]
    .map((e) => e.textContent).join('|') === want, { timeout: 4000 }, before.join('|'));

  // "Move to group…" and "Move up/down in the list" are the TOUCH equivalents
  // of the drag — dragging is not a touch path (teardown E1). They live in the
  // Edit-timer dialog now (wave-2: the row menu was seventeen items on a
  // phone), one row deep from the same ⋯, as real controls rather than 28px
  // popover rows.
  await page.click('.timer-board .timer-tile button[title="Row menu"]');
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
  await waitFor('.timer-board .timer-tile');
  const before = await page.$$eval('.timer-board .timer-tile', (els) => els.length);

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
  await page.waitForFunction((want) => document.querySelectorAll('.timer-board .timer-tile').length === want,
    { timeout: 4000 }, before + 3);

  // SELECTING IS A MODE NOW. A bare click on a tile used to be free, so
  // ctrl-click could be layered onto it; a tile is a button whose whole job is
  // to be pressed, so multi-select is entered deliberately — board ⋯ → "Select
  // several…" — and every tile then carries a real checkbox, which is also the
  // touch path the ctrl-click never was. Inside the mode the two chords are
  // unchanged: ctrl-click toggles one, shift-click extends the range.
  //
  // RETIRED with the inline rename: "and the ctrl-click must NOT open the
  // rename input". The tile's name is a label; there is no rename input to open.
  await openListMenu();
  await clickText('.ctx-menu .ctx-item', 'Select several');
  await waitFor('.timer-board .timer-check');

  const ctrlClick = (name, shift = false) => page.evaluate((n, sh) => {
    const card = [...document.querySelectorAll('.timer-board .timer-tile')]
      .find((c) => c.querySelector('.timer-name')?.textContent === n);
    if (!card) throw new Error(`no card named ${n}`);
    card.querySelector('.timer-name').dispatchEvent(new MouseEvent('click', {
      bubbles: true, cancelable: true, ctrlKey: !sh, shiftKey: sh,
    }));
  }, name, shift);

  await ctrlClick(probes[0]);
  await ctrlClick(probes[1]);
  await page.waitForFunction(() => document.querySelectorAll('.timer-tile.is-selected').length === 2
    && document.querySelector('.timer-selbar')?.textContent.includes('2 selected'), { timeout: 4000 });

  // shift-click extends the range to the third card
  await ctrlClick(probes[2], true);
  await page.waitForFunction(() => document.querySelectorAll('.timer-tile.is-selected').length === 3,
    { timeout: 4000 });
  await shot('multi-select');

  // RETIRED: right-click inside the selection. A tile has no contextmenu
  // handler — a long-press context menu is not a gesture a phone offers on a
  // grid of buttons, and the board is a phone surface first. The batch menu is
  // reached the two ways a thumb can reach it: the selection bar's "Actions…",
  // and the ⋯ of any tile inside the selection, which is the direct heir of the
  // right-click. This drives the heir.
  await page.evaluate((n) => {
    const card = [...document.querySelectorAll('.timer-board .timer-tile')]
      .find((c) => c.querySelector('.timer-name')?.textContent === n);
    card.querySelector('button[title="Row menu"]').click();
  }, probes[0]);
  await waitFor('.ctx-menu');
  const menuText = await page.$eval('.ctx-menu', (el) => el.textContent);
  if (!menuText.includes('3 timers selected')) throw new Error(`batch menu missing its header: ${menuText}`);
  if (!menuText.includes('Delete 3 timers')) throw new Error(`batch menu missing batch delete: ${menuText}`);

  await clickText('.ctx-menu .ctx-item', 'Delete 3 timers');
  await waitFor('.modal');
  await clickText('.modal button', 'Delete');
  await page.waitForFunction((want) => document.querySelectorAll('.timer-board .timer-tile').length === want
    && !document.querySelector('.timer-selbar')
    && ![...document.querySelectorAll('.timer-name')].some((el) => el.textContent.startsWith('Batch probe')),
  { timeout: 4000 }, before);

  // the ⋯ of a tile that is NOT in a selection still opens the ordinary
  // single-timer menu — which is the eight-item row menu now, with timer
  // maintenance (and the delete) one row deep in the Edit-timer dialog it
  // opens (wave-2)
  await page.evaluate(() => document.querySelector('.timer-board .timer-tile button[title="Row menu"]').click());
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
  await page.waitForFunction(() => !document.querySelector('.ctx-menu'), { timeout: 8000 });
});

await step('board: Show all APPENDS — the first nine tiles never move; grouping sections the tail', async () => {
  // THE PROPERTY THE WHOLE BOARD RESTS ON. The owner has 84 timers and sees
  // nine: his three, then Recent. Digit caps 1-9 are printed ON the tiles, so
  // if `Show all` re-sorted or re-flowed anything, pressing `7` would mean one
  // thing before it and another after, and the caps would be a lie. Show all
  // may only APPEND.
  //
  // This step BUILDS ITS OWN CROWD and takes it down again. The rest of this
  // harness works with a handful of timers, and a board of nine or fewer
  // deliberately does not band at all — so the one property worth proving here
  // is invisible at the fixture's normal size.
  const mkJson = (url, body) => fetch(`${base}${url}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then((r) => r.json());
  const made = [];
  for (let i = 0; i < 14; i += 1) {
    const cm = await mkJson('/api/cms', {
      cm_number: `9911${String(i).padStart(2, '0')}-000001`,
      short_name: `__crowd ${i}__`, client_name: i % 2 ? '__Crowd A__' : '__Crowd B__', billable: 1,
    });
    made.push(await mkJson('/api/timers', { name: `__crowd ${i}__`, cm_id: cm.id }));
  }
  try {
    const prefix = () => page.evaluate(() => [...document.querySelectorAll('.timer-tile')]
      .slice(0, 9).map((t) => t.dataset.timerId));
    await page.goto(`${base}/#/`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('.board-more', { timeout: 10_000 });

    const before = await prefix();
    if (before.length !== 9) throw new Error(`expected nine tiles on a crowded board, got ${before.length}`);
    const label = await page.$eval('.board-more', (el) => el.textContent);
    if (!/Show all \d+ timers/.test(label)) throw new Error(`the disclosure must say how many are behind it: ${label}`);

    await page.click('.board-more');
    await sleep(500);
    const after = await prefix();
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      throw new Error(`Show all moved the first nine tiles:\n  before ${before}\n  after  ${after}`);
    }
    const shown = await page.$$eval('.timer-tile', (els) => els.length);
    if (shown <= 9) throw new Error(`Show all revealed nothing: ${shown} tiles`);

    // …and the grouping controls apply to the TAIL, never to the working set.
    // They shipped inert once — storing their state and changing nothing on
    // screen — which is worse than not having them at all.
    await page.evaluate(() => [...document.querySelectorAll('.board-controls .seg button')]
      .find((b) => b.textContent.includes('By client')).click());
    await sleep(600);
    const bands = await page.$$eval('.band-rest', (els) => els.length);
    if (bands < 2) throw new Error(`"By client" produced ${bands} section(s) — the control does nothing`);
    const stillNine = await prefix();
    if (JSON.stringify(before) !== JSON.stringify(stillNine)) {
      throw new Error(`grouping re-sorted the working set: ${stillNine}`);
    }
    await page.evaluate(() => [...document.querySelectorAll('.board-controls .seg button')]
      .find((b) => b.textContent.trim() === 'Flat').click());
    await sleep(300);
  } finally {
    for (const t of made) {
      await fetch(`${base}/api/timers/${t.id}`, { method: 'DELETE' }).catch(() => {});
    }
    await page.goto(`${base}/#/`, { waitUntil: 'networkidle0' });
    await sleep(300);
  }
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
  // THE MATCH COUNT. `.timer-search-wrap .muted` printed "1/6" beside the field;
  // the board heads the matches with a labelled band instead — "1 match of 6" —
  // which says the same two numbers in words, over the tiles they describe. The
  // total is still the whole board, so it is asserted as a shape rather than a
  // fixed number.
  const matchLabel = () => page.$eval('.timer-board .band-matches .band-label', (el) => el.textContent.trim());
  const narrowedCount = await matchLabel();
  if (!/^1 match of \d+$/.test(narrowedCount)) throw new Error(`match count wrong: ${narrowedCount}`);

  // zero matches must not trap the keyboard: over-type past any match, then
  // Backspace back down to a matching query — all via native input editing
  await page.keyboard.type('zzz', { delay: 20 });
  await page.waitForFunction(() => document.querySelectorAll('.work-row').length === 0
    && document.querySelectorAll('.timer-board .timer-tile').length === 0, { timeout: 4000 });
  const zeroCount = await matchLabel();
  if (!/^0 matches of \d+$/.test(zeroCount)) throw new Error(`match count wrong: ${zeroCount}`);
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

  // Escape clears the filter and puts focus back on a tile.
  //
  // RETIRED: "the bar CLOSES". The field was a disclosure over the list, so `/`
  // opened it and Escape took it away; it is one of the board's three permanent
  // head controls now (grouping, filter, ⋯), because a board of eighty-four
  // timers is unusable without a filter and hiding it behind a keystroke is a
  // desktop assumption. So Escape empties it — same escape, same restored board
  // — and the field stays where he can see it.
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.querySelector('.timer-search')?.value === ''
    && document.querySelectorAll('.timer-row').length >= 5, { timeout: 4000 });
  await page.waitForFunction(() =>
    document.activeElement && document.activeElement.classList.contains('timer-tile'), { timeout: 4000 });
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
  // RETIRED with the list header (e6bccee): the removable `.filter-pill` beside
  // the list title. The board's head carries three controls and a count and has
  // no title row to hang a pill from. The segmented control is the state now —
  // it reports the chosen window as the pressed segment and clears it back to
  // "All" in the same place, one tap deep, which is where the choice was made.
  if (await listSegOn('Show') !== 'Yesterday') {
    throw new Error(`the chosen activity window is not shown back: ${await listSegOn('Show')}`);
  }
  await setListSeg('Show', 'All');
  if (await listSegOn('Show') !== 'All') {
    throw new Error(`the activity filter cannot be cleared: ${await listSegOn('Show')}`);
  }
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
