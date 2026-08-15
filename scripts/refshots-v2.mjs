// Capture *real signed-in product UI* reference screenshots for the three
// comparison bars (Harvest, Mercury, Attio) — as opposed to scripts/refshots.mjs,
// which shoots marketing home pages and mostly yields hero copy / cookie banners.
//
// Strategy: marketing pages rarely show real interface. Help-centre articles,
// blog posts, and app-store listings do — they're full of large <img>
// screenshots of the actual signed-in app. So instead of screenshotting the
// page around an image, this script finds the big images ON the page and
// downloads THEM directly:
//   1. Collect every <img> (and <picture><source>) on the page, resolving to
//      its highest-resolution URL: parse srcset width descriptors, and
//      unwrap Next.js's `/_next/image?url=<encoded original>` proxy back to
//      the original CDN asset (avoids downloading a downsized copy).
//   2. Filter for "big enough to be a screenshot, not a nav icon" using
//      whichever signal is available: displayed size, loaded natural size,
//      or width/height baked into the CDN URL itself (Apple's mzstatic and
//      Storyblok both encode "WWWxHHH" in the asset path).
//   3. Download each candidate by navigating the browser directly to the
//      image URL and reading the raw response bytes (page.goto + buffer()).
//      This sidesteps CORS entirely — CORS only restricts in-page fetch/XHR,
//      not top-level navigation — which matters because most candidates live
//      on a different origin (storyblok.com, mzstatic.com, datocms-assets.com)
//      than the page that links to them.
// Falls back to a plain viewport screenshot for any URL where no qualifying
// <img> is found (cheap insurance against a genuinely-embedded CSS/canvas
// hero image), so nothing silently disappears.
//
// Also works around Cloudflare's basic bot-check ("Just a moment...") that
// blocks default headless Chromium on some help centres (support.getharvest.com):
// hide navigator.webdriver, disable the AutomationControlled blink feature,
// and use a plain desktop Chrome UA — then wait for the real page title.
//
// Usage: node scripts/refshots-v2.mjs [outDir]
// Output: outDir/<name>.imgNN.<ext>       (downloaded images, sorted by size)
//         outDir/<name>.viewport.png      (fallback, only if no images found)
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
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// [name, url] — name becomes the file prefix. Grouped by product; mostly
// help-centre articles (real annotated screenshots), a couple of blog/product
// pages known to embed a real app screenshot, and each product's App Store
// listing (real mobile screens). Every URL here was hand-verified (via a
// throwaway probe script) to actually contain qualifying <img> candidates
// before being added — see the session notes for the ones that came up empty
// (most Harvest and Mercury help articles are Wistia video walkthroughs or
// plain text, not static screenshots).
const TARGETS = [
  // --- Harvest ---
  ['harvest-appstore', 'https://apps.apple.com/us/app/harvest-track-time-invoice/id355395846'],
  ['harvest-tour-timetracking', 'https://www.getharvest.com/time-tracking'],
  ['harvest-tour-reporting', 'https://www.getharvest.com/reporting'],
  ['harvest-tour-software', 'https://www.getharvest.com/software'],
  ['harvest-help-timesheet-submit', 'https://support.getharvest.com/hc/en-us/articles/360048181832-Submitting-and-approving-timesheets'],

  // --- Mercury ---
  ['mercury-appstore', 'https://apps.apple.com/us/app/mercury-bank-differently/id1491984028'],
  ['mercury-blog-mobile', 'https://mercury.com/blog/manage-finances-mobile-app'],
  ['mercury-home', 'https://mercury.com/'],
  ['mercury-treasury', 'https://mercury.com/treasury'],

  // --- Attio ---
  ['attio-appstore', 'https://apps.apple.com/us/app/attio/id1511545395'],
  ['attio-help-filter-sort', 'https://attio.com/help/reference/managing-your-data/views/filter-and-sort-views'],
  ['attio-help-navigating', 'https://attio.com/help/reference/attio-101/introduction-to-navigating-attio'],
  ['attio-help-records', 'https://attio.com/help/reference/attio-101/attios-data-model/understanding-records'],
  ['attio-help-create-lists', 'https://attio.com/help/reference/managing-your-data/lists/create-lists'],
  ['attio-help-kanban', 'https://attio.com/help/reference/managing-your-data/views/create-and-manage-kanban-views'],
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Cookie banners: try clicking an accept-ish button; if that fails to find
// one, just nuke anything that looks like a consent/cookie banner element.
async function dismissCookieBanner(page) {
  try {
    await page.evaluate(() => {
      const rx = /\b(accept all|accept cookies|accept|agree|got it|ok|allow all)\b/i;
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
          if (rect.height < 400) el.remove(); // fixed overlay, not a whole page section
        }
      });
    });
  } catch { /* ignore */ }
}

// Scroll the full page height in steps so lazy-loaded images resolve their
// real `src`/`currentSrc`, then scroll back to top.
async function triggerLazyLoad(page) {
  let height = 0;
  try {
    height = await page.evaluate(() => (document.body ? document.body.scrollHeight : 0));
  } catch { /* navigation in flight — skip scrolling this round */ return; }
  const step = VIEWPORT.height;
  for (let y = 0; y < height && y < 20000; y += step) {
    try {
      await page.evaluate((yy) => window.scrollTo(0, yy), y);
    } catch { return; }
    await sleep(350);
  }
  try {
    await page.evaluate(() => window.scrollTo(0, 0));
  } catch { /* ignore */ }
  await sleep(300);
}

// Navigate past Cloudflare's "Just a moment..." interstitial (basic JS
// challenge, not a CAPTCHA) by giving it a few seconds and polling the title.
async function waitPastChallenge(page) {
  for (let i = 0; i < 6; i += 1) {
    const title = await page.title();
    if (!/just a moment/i.test(title)) return;
    await sleep(1500);
  }
}

// Collect candidate product-screenshot images: resolve each <img> to its
// highest-resolution URL and keep it if it's plausibly a screenshot rather
// than a nav icon or avatar.
async function collectCandidates(page) {
  return await page.evaluate(() => {
    function bestFromSrcset(srcset) {
      if (!srcset) return null;
      let best = null;
      let bestW = -1;
      for (const part of srcset.split(',')) {
        const bits = part.trim().split(/\s+/);
        const url = bits[0];
        const desc = bits[1];
        if (!url) continue;
        const w = desc && desc.endsWith('w') ? parseInt(desc, 10) : 0;
        if (w > bestW) { bestW = w; best = url; }
      }
      return best;
    }
    // Next.js serves optimized images via /_next/image?url=<encoded original>
    // — unwrap it so we fetch the source CDN's original asset, not a resize.
    function resolveOriginal(rawUrl) {
      try {
        const u = new URL(rawUrl, location.href);
        if (/\/_next\/image$/.test(u.pathname) && u.searchParams.has('url')) {
          return new URL(u.searchParams.get('url'), location.href).href;
        }
        return u.href;
      } catch {
        return rawUrl;
      }
    }
    // Apple's mzstatic ("…/600x1300bb.webp") and Storyblok ("…/2068x1392/…")
    // both bake pixel dimensions into the URL path — pull them out so we can
    // judge/sort candidates even before the browser has decoded the image.
    function dimsFromUrl(url) {
      const m = url.match(/(\d{3,5})x(\d{3,5})(?:bb)?[./-]/);
      if (!m) return null;
      return { w: parseInt(m[1], 10), h: parseInt(m[2], 10) };
    }

    const seen = new Set();
    const out = [];
    document.querySelectorAll('img').forEach((img) => {
      const rect = img.getBoundingClientRect();
      const picture = img.closest('picture');
      let raw = img.currentSrc || img.src || '';
      const fromImgSrcset = bestFromSrcset(img.srcset);
      if (fromImgSrcset) raw = fromImgSrcset;
      if (picture) {
        picture.querySelectorAll('source').forEach((s) => {
          const b = bestFromSrcset(s.getAttribute('srcset') || '');
          if (b) raw = b; // sources are listed most- to least-specific; last one wins as a simple heuristic
        });
      }
      if (!raw || raw.startsWith('data:')) return;

      const resolved = resolveOriginal(raw);
      if (seen.has(resolved)) return;

      const dims = dimsFromUrl(resolved);
      const nw = img.naturalWidth;
      const nh = img.naturalHeight;
      const dispOk = rect.width >= 350 && rect.height >= 180;
      const natOk = nw >= 500 && nh >= 300;
      const urlDimOk = !!dims && dims.w >= 400 && dims.h >= 300;
      if (!dispOk && !natOk && !urlDimOk) return;

      seen.add(resolved);
      const area = (dims ? dims.w * dims.h : 0) || nw * nh || rect.width * rect.height;
      out.push({ src: resolved, area, alt: (img.alt || '').slice(0, 80) });
    });
    return out;
  });
}

function extFromTypeOrUrl(type, url) {
  const t = type || '';
  if (t.includes('png')) return 'png';
  if (t.includes('webp')) return 'webp';
  if (t.includes('gif')) return 'gif';
  if (t.includes('jpeg') || t.includes('jpg')) return 'jpg';
  const m = url.match(/\.(png|jpe?g|webp|gif)(\?|$)/i);
  return m ? m[1].toLowerCase() : 'png';
}

// Download by navigating directly to the image URL and reading the raw
// response — works regardless of the CDN's CORS policy, unlike an in-page
// fetch(), because CORS only gates script-readable responses, not navigation.
async function downloadViaNavigate(page, url) {
  const resp = await page.goto(url, { waitUntil: 'load', timeout: 25000 });
  if (!resp || !resp.ok()) return null;
  const buf = await resp.buffer();
  const type = resp.headers()['content-type'] || '';
  return { buf, type };
}

const browser = await puppeteer.launch({
  executablePath: '/usr/bin/chromium',
  headless: 'new',
  args: [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--font-render-hinting=none',
    '--disable-blink-features=AutomationControlled',
  ],
});

const MAX_PER_PAGE = 10;

for (const [name, url] of TARGETS) {
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  await page.setViewport(VIEWPORT);
  await page.setUserAgent(UA);
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await waitPastChallenge(page);
    await sleep(1500);
    await dismissCookieBanner(page);
    await triggerLazyLoad(page);
    await dismissCookieBanner(page); // some banners appear after scroll/load

    const candidates = await collectCandidates(page);
    candidates.sort((a, b) => b.area - a.area);
    const top = candidates.slice(0, MAX_PER_PAGE);

    if (top.length === 0) {
      // No big <img> found — take a viewport screenshot as cheap insurance
      // against a genuinely-embedded CSS/canvas hero (likely to be discarded
      // on review, but costs nothing).
      await page.screenshot({ path: join(OUT, `${name}.viewport.png`) });
      console.log(`  ${name}: no image candidates, saved viewport fallback`);
    } else {
      let n = 0;
      for (const c of top) {
        const dl = await downloadViaNavigate(page, c.src);
        if (!dl) continue;
        const ext = extFromTypeOrUrl(dl.type, c.src);
        const fname = `${name}.img${String(n).padStart(2, '0')}.${ext}`;
        writeFileSync(join(OUT, fname), dl.buf);
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
