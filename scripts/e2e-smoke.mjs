// End-to-end smoke test: boots the real server on a scratch database, drives
// the SPA in headless Chromium, and fails on any console/page error.
// Usage: node scripts/e2e-smoke.mjs [--screenshots DIR]
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
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
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log(`E2E against ${base}`);

await step('app shell renders (dashboard, SVG icons)', async () => {
  await page.goto(base, { waitUntil: 'networkidle0' });
  await waitFor('.sidebar .brand svg');
  await waitFor('.timer-new');
});

await step('create client+matter through picker (client→matter path, prefilled)', async () => {
  await page.keyboard.press('n');
  await waitFor('.modal .cmpicker input');
  await type('.modal .cmpicker input', '100001-000012');
  await clickText('.cmpicker-item .name', 'New client/matter');
  await waitFor('[data-nc-matter]');
  // typed CM number pre-splits into client + matter numbers
  const cpre = await page.$eval('[data-nc-client]', (el) => el.value);
  if (cpre !== '100001') throw new Error(`client prefill wrong: ${cpre}`);
  const mpre = await page.$eval('[data-nc-matter]', (el) => el.value);
  if (mpre !== '000012') throw new Error(`matter prefill wrong: ${mpre}`);
  // deliberately leave the client UNNAMED (blank names must render as the number)
  await type('[data-nc-name]', 'Acme lease dispute');
  await clickText('.modal button', 'Create matter');
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
  await page.evaluate(() => {
    const modal = document.querySelector('.modal-wide');
    const select = modal.querySelector('.task-line select');
    select.value = 'Review';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.type('.modal-wide textarea', 'Reviewed lease agreement and drafted renewal-terms summary for client.');
  await page.waitForFunction(
    () => document.querySelector('.saving-dot')?.textContent.includes('Saved'),
    { timeout: 6000 });
  // second line defaults to the remainder → allocation stays clean
  await clickText('.modal-wide button', 'Add task line');
  await page.waitForFunction(() => document.querySelectorAll('.modal-wide .task-line').length === 2);
  const lineVal = await page.$eval('.modal-wide .task-line:nth-of-type(2) input[type="number"]',
    (el) => el.value);
  if (Number(lineVal) !== 0) throw new Error(`remainder default wrong: ${lineVal}`);
  await page.evaluate(() => { // remove it again
    [...document.querySelectorAll('.modal-wide .task-line')][1]
      .querySelector('button[title="Remove line"]').click();
  });
  await shot('editor');
});

await step('finalize entry from editor', async () => {
  await clickText('.modal-wide button', 'Finalize');
  await page.waitForFunction(() => !document.querySelector('.modal-wide'), { timeout: 5000 });
});

await step('dashboard shows the entry and meter', async () => {
  await page.waitForFunction(
    () => document.body.textContent.includes('Acme lease dispute'), { timeout: 5000 });
  await waitFor('.meter-bar');
});

await step('create timer; a sub-2s stop reverts as if nothing happened', async () => {
  await page.click('.timer-new');
  await type('.modal input[placeholder="e.g. Acme — research"]', 'Acme research');
  await page.click('.modal .cmpicker input');
  await sleep(250);
  await clickText('.cmpicker-item .name', 'Acme');
  await clickText('.modal button', 'Create');
  await waitFor('.timer-card');
  await page.click('.timer-card button[title="Start"]');
  await sleep(1200);
  await page.click('.timer-card button[title="Stop & file time"]');
  await sleep(500);
  const clock = await page.$eval('.timer-clock', (el) => el.textContent.trim());
  if (clock !== '0.0') throw new Error(`expected 0.0 tenths after misclick, got ${clock}`);
  const title = await page.$eval('.timer-clock', (el) => el.title);
  if (!title.startsWith('00:00')) throw new Error(`misclick must fully revert, got ${title}`);
});

await step('context menu: backdated start (10m ago) → stop → narrative popup', async () => {
  await page.click('.timer-card button[title="Timer menu"]');
  await waitFor('.ctx-menu');
  await clickText('.ctx-menu .ctx-inline button', '10m');
  await page.waitForFunction(() => document.querySelector('.timer-card.running'), { timeout: 4000 });
  await page.click('.timer-card button[title="Stop & file time"]');
  await page.waitForFunction(
    () => [...document.querySelectorAll('.modal')].some((m) => m.textContent.includes('filed')),
    { timeout: 5000 });
  await page.type('.modal textarea', 'Legal research regarding lease renewal options and notice deadlines.');
  await shot('stop-popup');
  await clickText('.modal button', 'Done');
  await sleep(500);
  const entries = await page.$$eval('.entry-card', (els) => els.length);
  if (entries < 2) throw new Error(`expected 2 entries on dashboard, got ${entries}`);
});

await step('timer clock is editable in place', async () => {
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

await step('groups: create, assign via menu, collapse; A-Z present', async () => {
  await clickText('button', 'New group');
  await type('.modal input[placeholder="e.g. Litigation"]', 'Litigation');
  await clickText('.modal button', 'Create');
  await page.waitForFunction(() => document.body.textContent.includes('Litigation'), { timeout: 4000 });

  await page.click('.timer-card button[title="Timer menu"]');
  await waitFor('.ctx-menu select');
  await page.evaluate(() => {
    const sel = document.querySelector('.ctx-menu select');
    sel.value = sel.querySelector('option:not([value=""])').value;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForFunction(() => {
    const sections = [...document.querySelectorAll('.timer-section')];
    const lit = sections.find((s) => s.textContent.includes('Litigation'));
    return lit && lit.querySelector('.timer-card');
  }, { timeout: 4000 });

  // collapse hides the cards
  await page.evaluate(() => {
    const head = [...document.querySelectorAll('.group-head')].find((h) => h.textContent.includes('Litigation'));
    head.querySelector('button').click();
  });
  await page.waitForFunction(() => {
    const sections = [...document.querySelectorAll('.timer-section')];
    const lit = sections.find((s) => s.textContent.includes('Litigation'));
    return lit && !lit.querySelector('.timer-card');
  }, { timeout: 4000 });
  await shot('groups');

  const az = await page.$$eval('button', (els) => els.some((b) => b.textContent.includes('A–Z')));
  if (!az) throw new Error('A–Z button missing');
});

await step('grouping selector: by client / flat / persists across reload', async () => {
  await clickText('.seg button', 'By client');
  // Acme's client is unnamed → its section is labeled by the 6-digit number
  await page.waitForFunction(() => [...document.querySelectorAll('.group-head .group-name')]
    .some((el) => el.textContent.trim() === '100001'), { timeout: 4000 });
  await clickText('.seg button', 'Flat');
  await page.waitForFunction(() => document.querySelectorAll('.group-head').length === 0
    && document.querySelectorAll('.timer-card').length >= 1, { timeout: 4000 });
  await page.reload({ waitUntil: 'networkidle0' });
  await waitFor('.timer-card');
  const on = await page.$eval('.seg button.on', (el) => el.textContent.trim());
  if (on !== 'Flat') throw new Error(`grouping did not persist: ${on}`);
  await clickText('.seg button', 'By group');
  await page.waitForFunction(() => [...document.querySelectorAll('.group-name')]
    .some((el) => el.textContent.includes('Litigation')), { timeout: 4000 });
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

await step('export view offers CSV, .TIM, and text', async () => {
  await page.goto(`${base}/#/export`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => document.body.textContent.includes('.TIM'));
  await page.waitForFunction(() => document.body.textContent.includes('CSV'));
  await shot('export');
});

await step('settings shows AI + .TIM cards', async () => {
  await page.goto(`${base}/#/settings`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => document.body.textContent.includes('AI narrative assist'));
  await page.waitForFunction(() => document.body.textContent.includes('.TIM export'));
  await page.waitForFunction(() => document.body.textContent.includes('Task codes'));
  await shot('settings');
});

await step('dark mode applies', async () => {
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
  await page.goto(`${base}/#/`, { waitUntil: 'networkidle0' });
  await waitFor('.meter-bar');
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  if (bg !== 'rgb(18, 18, 17)') throw new Error(`dark surface not applied: ${bg}`);
  await shot('dashboard-dark');
});

await browser.close();
server.close();
db.close();
rmSync(dir, { recursive: true, force: true });

const real = problems.filter((p) => !p.includes('favicon'));
if (real.length) {
  console.error(`\nE2E PROBLEMS (${real.length}):`);
  for (const p of real) console.error('  - ' + p);
  process.exit(1);
}
console.log('\nE2E SMOKE: ALL CLEAR');
