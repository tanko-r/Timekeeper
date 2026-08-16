import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.TZ = 'America/Los_Angeles';
const { openDb } = await import('/home/david/Projects/Intapp-clone/server/db.js');
const { createApp } = await import('/home/david/Projects/Intapp-clone/server/app.js');
const puppeteer = (await import('puppeteer-core')).default;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const todayLocal = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const daysAgo = (n) => todayLocal(new Date(Date.now() - n * 86400000));

const dir = mkdtempSync(join(tmpdir(), 'tk-dbg-'));
const db = openDb(join(dir, 'ui.db'));
const app = createApp({ db, config: { DATA_DIR: dir, TRUST_LAN: true }, clock: () => new Date() });
const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const base = `http://127.0.0.1:${server.address().port}`;
const api = async (m, p, b) => {
  const res = await fetch(base + p, { method: m, headers: { 'content-type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) });
  const t = await res.text();
  if (!res.ok) throw new Error(`${m} ${p} -> ${res.status} ${t}`);
  return t ? JSON.parse(t) : null;
};

const LEASE_1 = 'Reviewed the landlord termination notice and the underlying lease';
const LEASE_2 = 'Telephone conference with W. Hammond regarding the estoppel certificate';
const lease = await api('POST', '/api/cms', { cm_number: '100001-000010', short_name: 'Acme lease dispute', client_name: 'Acme Holdings', billable: 1 });
const north = await api('POST', '/api/cms', { cm_number: '100244-000002', short_name: 'Northgate diligence', client_name: 'Northgate Partners', billable: 1 });
for (const [n, ago] of [[LEASE_1, 2], [LEASE_2, 5]]) {
  await api('POST', '/api/entries', { date: daysAgo(ago), cm_id: lease.id, narrative: n, tasks: [{ task_code: 'Review', duration: 0.6, fragment: '' }] });
}

const browser = await puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900 });
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE', m.text()); });

const timer = await api('POST', '/api/timers', { name: 'Lease work', cm_id: lease.id });
await api('POST', `/api/timers/${timer.id}/start`, { minutesAgo: 10 });
await page.goto(`${base}/#/`, { waitUntil: 'networkidle0' });
await sleep(600);
await page.waitForSelector(`.today-list .work-row[data-timer-id="${timer.id}"]`);
await page.click(`.work-row[data-timer-id="${timer.id}"] .timer-stop-btn`);
await page.waitForSelector('.stop-chips');
await sleep(1000);
const entry = db.prepare('SELECT id, cm_id, narrative FROM entries WHERE id=(SELECT linked_entry_id FROM timers WHERE id=?)').get(timer.id);
console.log('ENTRY AFTER STOP', entry);

await page.click(`.work-row[data-timer-id="${timer.id}"] button[title="Row menu"]`);
await page.waitForSelector('.ctx-menu');
console.log('MENU', await page.$$eval('.ctx-menu button', (bs) => bs.map((b) => b.textContent.trim())));
await page.evaluate(() => {
  const el = [...document.querySelectorAll('.ctx-menu button')].find((b) => /Open (entry|0)/.test(b.textContent));
  el.click();
});
await sleep(1200);
console.log('PANEL?', await page.evaluate(() => !!document.querySelector('.ed-panel')));
console.log('MATTER ROW', await page.evaluate(() => document.querySelector('.ed-row-matter')?.outerHTML.slice(0, 600)));
await page.click('.ed-row-matter .cm-value');
await sleep(400);
console.log('AFTER OPEN', await page.evaluate(() => document.querySelector('.ed-row-matter')?.outerHTML.slice(0, 800)));
await page.type('.ed-row-matter .cmpicker input', 'Northgate', { delay: 15 });
await sleep(800);
console.log('ITEMS', await page.$$eval('.cmpicker-item', (els) => els.map((e) => e.textContent.trim())));
const box = await page.evaluate(() => {
  const n = [...document.querySelectorAll('.cmpicker-item')].find((x) => x.textContent.includes('Northgate'));
  n.scrollIntoView({ block: 'center' });
  const r = n.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
});
await page.mouse.click(box.x, box.y);
await sleep(800);
console.log('AFTER PICK', await page.evaluate(() => document.querySelector('.ed-row-matter')?.textContent.replace(/\s+/g, ' ').trim()));
console.log('ENTRY NOW', db.prepare('SELECT id, cm_id, narrative FROM entries WHERE id=?').get(entry.id));
await page.click('.ed-done');
await sleep(1500);
console.log('ENTRY AFTER DONE', db.prepare('SELECT id, cm_id, narrative FROM entries WHERE id=?').get(entry.id));
console.log('OFFER STILL?', await page.evaluate(() => {
  const el = document.querySelector('.stop-chips');
  return el ? el.textContent.replace(/\s+/g, ' ').trim().slice(0, 300) : null;
}));

await browser.close();
await new Promise((r) => server.close(r));
db.close();
rmSync(dir, { recursive: true, force: true });
