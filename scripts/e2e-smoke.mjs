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
  // Real mouse events — components may listen on mousedown, not click.
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

await step('app shell renders (dashboard)', async () => {
  await page.goto(base, { waitUntil: 'networkidle0' });
  await waitFor('.sidebar .brand');
  await waitFor('.timer-new');
});

await step('create CM through picker in new-entry editor', async () => {
  await page.keyboard.press('n');
  await waitFor('.modal .cmpicker input');
  await type('.modal .cmpicker input', '100001-000012');
  await clickText('.cmpicker-item .name', 'New client/matter');
  await waitFor('.modal .modal input[placeholder="000000-000000"]', 3000).catch(() => {});
  // NewCmModal fields
  const nameInput = await page.$$eval('.modal', (ms) => ms.length);
  if (nameInput < 2) throw new Error('CM modal did not open');
  await page.evaluate(() => {
    const modal = [...document.querySelectorAll('.modal')].pop();
    const inputs = modal.querySelectorAll('input[type="text"]');
    inputs[1].focus();
  });
  await page.keyboard.type('Acme lease dispute', { delay: 5 });
  await clickText('.modal button', 'Create');
  await sleep(400);
});

await step('fill entry: task line + narrative autosaves', async () => {
  await page.evaluate(() => {
    const modal = document.querySelector('.modal-wide');
    const select = modal.querySelector('.task-line select');
    select.value = 'Review';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.evaluate(() => {
    const modal = document.querySelector('.modal-wide');
    const num = modal.querySelector('.task-line input[type="number"]');
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    set.call(num, '1.2');
    num.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.type('.modal-wide textarea', 'Reviewed lease agreement and drafted renewal-terms summary for client.');
  await page.waitForFunction(
    () => document.querySelector('.saving-dot')?.textContent.includes('Saved'),
    { timeout: 6000 });
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
  await shot('dashboard');
});

await step('create + start + stop a timer (new entry)', async () => {
  await page.click('.timer-new');
  await type('.modal input[placeholder="e.g. Acme — research"]', 'Acme research');
  await page.click('.modal .cmpicker input');
  await sleep(250);
  await clickText('.cmpicker-item .name', 'Acme');
  await clickText('.modal button', 'Create');
  await sleep(300);
  await clickText('.timer-card button', 'Start');
  await sleep(1500);
  await clickText('.timer-card button', 'Stop');
  await sleep(600); // under increment → discard toast, clock reset
  const clock = await page.$eval('.timer-clock', (el) => el.textContent);
  if (!/00:0[01]/.test(clock)) throw new Error(`clock not reset: ${clock}`);
});

await step('calendar renders month grid with data', async () => {
  await page.goto(`${base}/#/calendar`, { waitUntil: 'networkidle0' });
  await waitFor('.cal-grid');
  await page.waitForFunction(() => document.querySelectorAll('.cal-day').length === 42);
  await shot('calendar');
});

await step('search finds the entry', async () => {
  await page.goto(`${base}/#/search`, { waitUntil: 'networkidle0' });
  await type('[data-search-q]', 'lease');
  await page.waitForFunction(
    () => document.querySelectorAll('table.tk tbody tr').length >= 1
      && document.body.textContent.includes('Acme'),
    { timeout: 5000 });
  await shot('search');
});

await step('stats renders bars', async () => {
  await page.goto(`${base}/#/stats`, { waitUntil: 'networkidle0' });
  await waitFor('.stat-tiles');
  await waitFor('.bar-row');
  await shot('stats');
});

await step('export preview + settings render', async () => {
  await page.goto(`${base}/#/export`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => document.body.textContent.includes('Export CSV'));
  await shot('export');
  await page.goto(`${base}/#/settings`, { waitUntil: 'networkidle0' });
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

// Benign noise filter: favicon fetch etc.
const real = problems.filter((p) => !p.includes('favicon'));
if (real.length) {
  console.error(`\nE2E PROBLEMS (${real.length}):`);
  for (const p of real) console.error('  - ' + p);
  process.exit(1);
}
console.log('\nE2E SMOKE: ALL CLEAR');
