// Capture reference screenshots of the three comparison bars.
// Dev tool only — output lives in the scratchpad, never in the repo.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';

const OUT = process.argv[2] || '/tmp/refs';
mkdirSync(OUT, { recursive: true });

const TARGETS = [
  ['harvest-home', 'https://www.getharvest.com/'],
  ['harvest-timetracking', 'https://www.getharvest.com/time-tracking'],
  ['harvest-invoicing', 'https://www.getharvest.com/invoicing'],
  ['mercury-home', 'https://mercury.com/'],
  ['mercury-bill-pay', 'https://mercury.com/bill-pay'],
  ['attio-home', 'https://attio.com/'],
  ['attio-product', 'https://attio.com/product'],
];

const VIEWPORTS = [
  { key: 'desktop', width: 1440, height: 900, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
  { key: 'mobile', width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: '/usr/bin/chromium',
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--font-render-hinting=none'],
});

for (const vp of VIEWPORTS) {
  for (const [name, url] of TARGETS) {
    const page = await browser.newPage();
    await page.setViewport(vp);
    await page.setUserAgent(vp.isMobile
      ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
      : 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36');
    try {
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });
      await sleep(2500);
      // Three viewport-height frames down the page: hero, first product
      // section, second product section.
      for (let i = 0; i < 3; i += 1) {
        if (i > 0) {
          await page.evaluate((h) => window.scrollBy(0, h * 0.95), vp.height);
          await sleep(1500);
        }
        await page.screenshot({ path: join(OUT, `${name}.${vp.key}.${i}.png`) });
      }
      console.log(`  ok ${name} ${vp.key}`);
    } catch (e) {
      console.log(`  fail ${name} ${vp.key}: ${e.message}`);
    }
    await page.close();
  }
}
await browser.close();
