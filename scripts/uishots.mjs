// UI screenshot harness for the design overhaul.
//
// Boots the real server on a scratch database, seeds the fictional demo
// dataset, then photographs every screen across the full matrix:
//   viewport  × { desktop 1440x900, mobile 390x844 }
//   theme     × { light, dark }
//
// Usage:
//   node scripts/uishots.mjs --out shots/baseline
//   node scripts/uishots.mjs --out shots/wave1 --only dashboard,day
//   node scripts/uishots.mjs --out shots/x --viewport mobile --theme dark
//
// Output files are named <screen>.<viewport>.<theme>.png so a critic can pair
// them without a manifest. A manifest.json is written anyway, listing every
// shot plus any console errors seen while taking it.
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';
import { seedDemo } from './lib/demoseed.mjs';

process.env.TZ = process.env.TZ || 'America/Los_Angeles';

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
};

const OUT = arg('out', 'shots/latest');
const ONLY = (arg('only') || '').split(',').map((s) => s.trim()).filter(Boolean);
const VIEWPORT_FILTER = arg('viewport');
const THEME_FILTER = arg('theme');
mkdirSync(OUT, { recursive: true });

const todayLocal = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const TODAY = todayLocal();

const { openDb } = await import('../server/db.js');
const { createApp } = await import('../server/app.js');

const dir = mkdtempSync(join(tmpdir(), 'tk-shots-'));
const db = openDb(join(dir, 'shots.db'));
const config = { DATA_DIR: dir, TRUST_LAN: true, PUBLIC_HOSTNAME: 'time.example.test' };
const app = createApp({ db, config, clock: () => new Date() });
const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const base = `http://127.0.0.1:${server.address().port}`;

console.log(`seeding demo data at ${base} …`);
await seedDemo(base, { today: TODAY });

const VIEWPORTS = [
  { key: 'desktop', width: 1440, height: 900, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
  { key: 'mobile', width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
].filter((v) => !VIEWPORT_FILTER || v.key === VIEWPORT_FILTER);

const THEMES = ['light', 'dark'].filter((t) => !THEME_FILTER || t === THEME_FILTER);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A screen is a hash route plus an optional interaction that opens whatever
// transient UI the shot is about (editor, help overlay, close-out, …).
const SCREENS = [
  { key: 'dashboard', hash: '#/' },
  { key: 'day', hash: `#/day/${TODAY}` },
  { key: 'calendar', hash: '#/calendar' },
  { key: 'search', hash: '#/search' },
  { key: 'stats', hash: '#/stats' },
  { key: 'cms', hash: '#/cms' },
  { key: 'export', hash: '#/export' },
  { key: 'settings', hash: '#/settings' },
  { key: 'settings-ai', hash: '#/settings/ai' },
  { key: 'settings-remote', hash: '#/settings/remote' },
  {
    key: 'entry-editor',
    hash: `#/day/${TODAY}`,
    async act(page) {
      await page.keyboard.press('n');
      await page.waitForSelector('.modal', { timeout: 5000 });
      await sleep(400);
    },
  },
  {
    key: 'entry-editor-existing',
    hash: `#/day/${TODAY}`,
    async act(page) {
      await page.waitForSelector('.entry-row, .entry-card', { timeout: 5000 });
      await page.evaluate(() => {
        const el = document.querySelector('.entry-row, .entry-card');
        el.click();
      });
      await page.waitForSelector('.modal', { timeout: 5000 }).catch(() => {});
      await sleep(400);
    },
  },
  {
    key: 'shortcuts',
    hash: '#/',
    async act(page) {
      // press('?') sends the physical key, not the shifted character the app
      // listens for; type() produces a real '?' keydown.
      await page.keyboard.type('?');
      await page.waitForSelector('.kbd-help', { timeout: 5000 });
      await sleep(250);
    },
  },
  {
    key: 'quick-capture',
    hash: '#/',
    async act(page) {
      await page.keyboard.press('q');
      await sleep(500);
    },
  },
  {
    key: 'closeout',
    hash: '#/',
    async act(page) {
      await page.keyboard.press('c');
      await sleep(600);
    },
  },
].filter((s) => ONLY.length === 0 || ONLY.includes(s.key));

const browser = await puppeteer.launch({
  executablePath: '/usr/bin/chromium',
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--font-render-hinting=none'],
});

const manifest = [];

for (const vp of VIEWPORTS) {
  for (const theme of THEMES) {
    const page = await browser.newPage();
    await page.setViewport(vp);
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme }]);
    const errors = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

    // Theme is a real server-side setting; drive it the way the app does
    // rather than poking data-theme, so the shot proves the setting works.
    await fetch(`${base}/api/settings`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ theme }),
    });

    for (const screen of SCREENS) {
      const before = errors.length;
      const name = `${screen.key}.${vp.key}.${theme}.png`;
      try {
        await page.goto(`${base}/${screen.hash}`, { waitUntil: 'networkidle0' });
        // Hash-only changes do not reload; force the route every time.
        await page.evaluate((h) => { window.location.hash = h; }, screen.hash);
        await sleep(500);
        // Something on the dashboard autofocuses an input on load, and the
        // global key handler ignores keys typed inside one. Blur first so a
        // shortcut-driven shot exercises the real global handler.
        await page.evaluate(() => document.activeElement?.blur?.());
        if (screen.act) await screen.act(page);
        await sleep(250);
        await page.screenshot({ path: join(OUT, name), fullPage: !screen.act });
        manifest.push({
          screen: screen.key, viewport: vp.key, theme, file: name,
          errors: errors.slice(before),
        });
        process.stdout.write(`  ✔ ${name}\n`);
      } catch (e) {
        manifest.push({ screen: screen.key, viewport: vp.key, theme, file: null, failed: String(e.message) });
        process.stdout.write(`  ✖ ${name}: ${e.message}\n`);
      }
    }
    await page.close();
  }
}

writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));
await browser.close();
await new Promise((r) => server.close(r));
db.close();
rmSync(dir, { recursive: true, force: true });

const failed = manifest.filter((m) => m.failed);
const withErrors = manifest.filter((m) => m.errors && m.errors.length);
console.log(`\n${manifest.length - failed.length} shots written to ${OUT}`);
if (failed.length) console.log(`${failed.length} failed: ${failed.map((f) => `${f.screen}/${f.viewport}/${f.theme}`).join(', ')}`);
if (withErrors.length) console.log(`${withErrors.length} shots had console errors — see manifest.json`);
