// Capture *real signed-in product UI* reference screenshots for the three
// comparison bars (Harvest, Mercury, Attio) — as opposed to scripts/refshots.mjs,
// which shoots marketing home pages and mostly yields hero copy / cookie banners.
//
// Strategy: marketing pages rarely show real interface. Help-centre articles,
// blog/changelog posts, and app-store listings do — they're full of large
// <img> screenshots of the actual signed-in app. So instead of screenshotting
// the page around an image, this script finds the big images ON the page and
// downloads THEM directly (via an in-page fetch, so it inherits the browser's
// session/referrer — more reliable than a bare curl against a CDN).
//
// It also resolves srcset candidates (many CDNs serve a small "display" image
// but a much larger true asset via srcset) and falls back to a plain full-page
// screenshot for any URL where no qualifying <img> is found (e.g. a marketing
// hero that genuinely embeds one big screenshot as a CSS background).
//
// Usage: node scripts/refshots-v2.mjs [outDir]
// Output: outDir/<name>.imgNN.<ext>  (downloaded images)
//         outDir/<name>.viewport.png (fallback full-page shot, only if no images found)
//
// Dev tool only — one page at a time, single desktop viewport (1440x900).
// Mobile "screens" come from mobile-app-store screenshot images themselves,
// not from rendering pages at a phone viewport.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';

const OUT = process.argv[2] || '/tmp/refs-v2';
mkdirSync(OUT, { recursive: true });

const VIEWPORT = { width: 1440, height: 900, deviceScaleFactor: 1 };
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';

// [name, url] — name becomes the file prefix. Grouped by product; mostly
// help-centre articles (real annotated screenshots), a couple of blog/product
// pages, and each product's App Store listing (real mobile screens).
const TARGETS = [
  // --- Harvest ---
  ['harvest-help-dayview', 'https://support.getharvest.com/hc/en-us/articles/360048181892-Tracking-time-Day-view'],
  ['harvest-help-timesheet-approve', 'https://support.getharvest.com/hc/en-us/articles/360048181832-Submitting-and-approving-timesheets'],
  ['harvest-help-timesheet-settings', 'https://support.getharvest.com/hc/en-us/articles/360048181812-Timesheet-settings'],
  ['harvest-help-invoice-create', 'https://support.getharvest.com/hc/en-us/articles/360048686371-How-to-create-a-single-invoice'],
  ['harvest-help-invoice-send', 'https://support.getharvest.com/hc/en-us/articles/360048686471-Sending-invoices-and-estimates'],
  ['harvest-help-mobile-timer', 'https://support.getharvest.com/hc/en-us/articles/360048180052-iPhone-Tracking-Time'],
  ['harvest-help-mobile-invoices', 'https://support.getharvest.com/hc/en-us/articles/360048180092-Mobile-app-Managing-invoices-in-the-Reports-tab'],
  ['harvest-appstore', 'https://apps.apple.com/us/app/harvest-track-time-invoice/id355395846'],
  ['harvest-tour-timetracking', 'https://www.getharvest.com/time-tracking'],
  ['harvest-tour-invoicing', 'https://www.getharvest.com/invoicing'],

  // --- Mercury ---
  ['mercury-help-send-money', 'https://support.mercury.com/hc/en-us/articles/28772488555668-Sending-money-overview'],
  ['mercury-help-domestic-payment', 'https://support.mercury.com/hc/en-us/articles/28772344978068-Sending-domestic-payments'],
  ['mercury-help-payments-page', 'https://support.mercury.com/hc/en-us/articles/40585414546068-Using-the-Payments-page'],
  ['mercury-help-rtp', 'https://support.mercury.com/hc/en-us/articles/39968809104148-Receiving-real-time-payments-RTP'],
  ['mercury-appstore', 'https://apps.apple.com/us/app/mercury-bank-differently/id1491984028'],
  ['mercury-blog-mobile', 'https://mercury.com/blog/manage-finances-mobile-app'],
  ['mercury-home', 'https://mercury.com/'],

  // --- Attio ---
  ['attio-help-views', 'https://attio.com/help/academy/introduction/views'],
  ['attio-help-filter-sort', 'https://attio.com/help/reference/managing-your-data/views/filter-and-sort-views'],
  ['attio-help-kanban', 'https://attio.com/help/reference/managing-your-data/views/create-and-manage-kanban-views'],
  ['attio-help-navigating', 'https://attio.com/help/reference/attio-101/introduction-to-navigating-attio'],
  ['attio-help-records', 'https://attio.com/help/reference/attio-101/attios-data-model/understanding-records'],
  ['attio-help-create-lists', 'https://attio.com/help/reference/managing-your-data/lists/create-lists'],
  ['attio-appstore', 'https://apps.apple.com/us/app/attio/id1511545395'],
  ['attio-product-tour', 'https://attio.com/product'],
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Cookie banners: try clicking an accept-ish button; if that fails to find
// one, just nuke anything that looks like a consent/cookie banner element.
async function dismissCookieBanner(page) {
  try {
    await page.evaluate(() => {
      const rx = /accept|agree|got it|ok\b|allow all/i;
      const candidates = Array.from(document.querySelectorAll('button, a, [role="button"]'));
      for (const el of candidates) {
        const t = (el.textContent || '').trim();
        if (t && rx.test(t) && t.length < 40) {
          el.click();
          return;
        }
      }
    });
    await sleep(300);
  } catch { /* ignore */ }
  try {
    await page.evaluate(() => {
      const rx = /cookie|consent|gdpr|onetrust/i;
      document.querySelectorAll('[id],[class]').forEach((el) => {
        const id = el.id || '';
        const cls = typeof el.className === 'string' ? el.className : '';
        if (rx.test(id) || rx.test(cls)) {
          const rect = el.getBoundingClientRect();
          // only remove things that look like fixed overlays, not whole sections
          if (rect.height < 400) el.remove();
        }
      });
    });
  } catch { /* ignore */ }
}

// Scroll the full page height in steps so lazy-loaded <img src> attributes
// resolve, then scroll back to top.
async function triggerLazyLoad(page) {
  const height = await page.evaluate(() => document.body.scrollHeight);
  const step = VIEWPORT.height;
  for (let y = 0; y < height; y += step) {
    await page.evaluate((yy) => window.scrollTo(0, yy), y);
    await sleep(350);
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(300);
}

// Parse a srcset string, return the URL with the largest width descriptor.
function bestFromSrcset(srcset) {
  if (!srcset) return null;
  let best = null;
  let bestW = -1;
  for (const part of srcset.split(',')) {
    const [url, desc] = part.trim().split(/\s+/);
    if (!url) continue;
    const w = desc && desc.endsWith('w') ? parseInt(desc, 10) : 0;
    if (w > bestW) { bestW = w; best = url; }
  }
  return best;
}

// Collect candidate product-screenshot images: large enough (by displayed
// size OR intrinsic size, since carousels often display a scaled-down image
// backed by a big asset), deduped by resolved URL.
async function collectCandidates(page) {
  return await page.evaluate((bestFromSrcsetSrc) => {
    // eslint-disable-next-line no-eval
    const bestFromSrcset = eval(`(${bestFromSrcsetSrc})`);
    const seen = new Set();
    const out = [];
    document.querySelectorAll('img').forEach((img) => {
      const rect = img.getBoundingClientRect();
      const picture = img.closest('picture');
      let srcCandidates = [img.currentSrc || img.src];
      if (img.srcset) srcCandidates.push(bestFromSrcset(img.srcset));
      if (picture) {
        picture.querySelectorAll('source').forEach((s) => {
          if (s.srcset) srcCandidates.push(bestFromSrcset(s.srcset));
        });
      }
      srcCandidates = srcCandidates.filter(Boolean);
      const src = srcCandidates.sort((a, b) => b.length - a.length)[0]; // heuristic: longer url often = higher-res param
      if (!src || seen.has(src)) return;
      const nw = img.naturalWidth, nh = img.naturalHeight;
      const dispOk = rect.width >= 400 && rect.height >= 200;
      const natOk = nw >= 600 && nh >= 400;
      if (!dispOk && !natOk) return;
      seen.add(src);
      out.push({
        src,
        nw, nh,
        dispW: Math.round(rect.width),
        dispH: Math.round(rect.height),
        area: Math.max(nw * nh, rect.width * rect.height),
        alt: (img.alt || '').slice(0, 80),
      });
    });
    return out;
  }, bestFromSrcset.toString());
}

async function downloadImage(page, url) {
  // Fetch inside the page context so it carries the same session/referrer,
  // then hand the bytes back to Node as base64.
  return await page.evaluate(async (u) => {
    try {
      const res = await fetch(u, { credentials: 'include' });
      if (!res.ok) return null;
      const buf = await res.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let bin = '';
      const chunk = 0x8000;
      for (let i = 0; i < bytes.length; i += chunk) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
      }
      return { b64: btoa(bin), type: res.headers.get('content-type') || '' };
    } catch {
      return null;
    }
  }, url);
}

function extFromType(type, url) {
  if (type.includes('png')) return 'png';
  if (type.includes('webp')) return 'webp';
  if (type.includes('gif')) return 'gif';
  if (type.includes('jpeg') || type.includes('jpg')) return 'jpg';
  const m = url.match(/\.(png|jpe?g|webp|gif)(\?|$)/i);
  return m ? m[1].toLowerCase() : 'png';
}

const browser = await puppeteer.launch({
  executablePath: '/usr/bin/chromium',
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--font-render-hinting=none'],
});

const MAX_PER_PAGE = 8;

for (const [name, url] of TARGETS) {
  const page = await browser.newPage();
  await page.setViewport(VIEWPORT);
  await page.setUserAgent(UA);
  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });
    await sleep(1500);
    await dismissCookieBanner(page);
    await triggerLazyLoad(page);
    await dismissCookieBanner(page); // some banners appear after scroll/load

    const candidates = await collectCandidates(page);
    candidates.sort((a, b) => b.area - a.area);
    const top = candidates.slice(0, MAX_PER_PAGE);

    if (top.length === 0) {
      // Fallback: no big <img> found — take a full-page screenshot so we at
      // least have something to eyeball (likely to be discarded on review,
      // but cheap insurance against CSS-background hero screenshots).
      await page.screenshot({ path: join(OUT, `${name}.viewport.png`), fullPage: false });
      console.log(`  ${name}: no image candidates, saved viewport fallback`);
    } else {
      let n = 0;
      for (const c of top) {
        const dl = await downloadImage(page, c.src);
        if (!dl) continue;
        const ext = extFromType(dl.type, c.src);
        const fname = `${name}.img${String(n).padStart(2, '0')}.${ext}`;
        writeFileSync(join(OUT, fname), Buffer.from(dl.b64, 'base64'));
        n += 1;
      }
      console.log(`  ${name}: saved ${n}/${top.length} images (of ${candidates.length} candidates)`);
    }
  } catch (e) {
    console.log(`  fail ${name}: ${e.message}`);
  }
  await page.close();
}

await browser.close();
