// Renders the PWA/taskbar PNGs from public/icons/icon.svg (the single icon
// source — it is also the tab favicon as-is). Uses the system Chromium via
// puppeteer-core (already a devDependency for e2e). Re-run after editing
// icon.svg; commit the output, then bump CACHE in public/sw.js.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const icons = join(root, 'public', 'icons');
const svg = readFileSync(join(icons, 'icon.svg'), 'utf8');
const bg = svg.match(/<rect width="100" height="100"[^>]*fill="([^"]+)"/)[1];

// "any": the rounded-square icon on a transparent background.
// "maskable": full-bleed brand color, glyph shrunk into the 80% safe zone,
// so Android's circle/squircle masks never clip the stopwatch.
const OUT = [
  { file: 'icon-192.png', size: 192, maskable: false },
  { file: 'icon-512.png', size: 512, maskable: false },
  { file: 'icon-maskable-512.png', size: 512, maskable: true },
];

const browser = await puppeteer.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
try {
  const page = await browser.newPage();
  for (const { file, size, maskable } of OUT) {
    await page.setViewport({ width: size, height: size, deviceScaleFactor: 1 });
    const inner = maskable ? Math.round(size * 0.8) : size;
    await page.setContent(`<!doctype html><html><body style="margin:0;width:${size}px;height:${size}px;
      display:grid;place-items:center;background:${maskable ? bg : 'transparent'}">
      <img src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}"
        width="${inner}" height="${inner}"></body></html>`);
    await page.screenshot({ path: join(icons, file), omitBackground: !maskable });
    console.log(`wrote public/icons/${file}`);
  }
} finally {
  await browser.close();
}
