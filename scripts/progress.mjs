// Build the live progress page for the UI overhaul.
//
// Reads shots/progress.json (the run log, appended to as waves finish) plus
// whatever screenshot directories it names, and emits a single self-contained
// HTML file with every image inlined as a JPEG data URI — so it can be
// published as an artifact and read on a phone with no server behind it.
//
// Usage: node scripts/progress.mjs [--out progress/index.html]
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import puppeteer from 'puppeteer-core';

const arg = (n, d = null) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > -1 ? process.argv[i + 1] : d;
};

const OUT = arg('out', 'progress/index.html');
const LOG = arg('log', 'shots/progress.json');
if (!existsSync(LOG)) {
  console.error(`no run log at ${LOG}`);
  process.exit(1);
}
const log = JSON.parse(readFileSync(LOG, 'utf8'));

const browser = await puppeteer.launch({
  executablePath: '/usr/bin/chromium',
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage();

const cache = new Map();
// Downscale + re-encode through the browser's own canvas: no image library in
// the dependency budget, and chromium is already here for screenshots.
async function dataUri(path, maxWidth) {
  if (!path || !existsSync(path)) return null;
  const key = `${path}|${maxWidth}`;
  if (cache.has(key)) return cache.get(key);
  const b64 = readFileSync(path).toString('base64');
  const uri = await page.evaluate(async (src, mw) => {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = src; });
    const scale = Math.min(1, mw / img.width);
    const c = document.createElement('canvas');
    c.width = Math.round(img.width * scale);
    c.height = Math.round(img.height * scale);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.62);
  }, `data:image/png;base64,${b64}`, maxWidth);
  cache.set(key, uri);
  return uri;
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const COMBOS = [
  ['desktop', 'light'], ['desktop', 'dark'],
  ['mobile', 'light'], ['mobile', 'dark'],
];

const sections = [];
for (const piece of log.pieces || []) {
  const shots = [];
  for (const [vp, theme] of COMBOS) {
    const file = `${piece.screen}.${vp}.${theme}.png`;
    const before = await dataUri(join(log.baselineDir || 'shots/baseline', file), vp === 'mobile' ? 420 : 900);
    const after = piece.afterDir ? await dataUri(join(piece.afterDir, file), vp === 'mobile' ? 420 : 900) : null;
    if (!before && !after) continue;
    shots.push({ vp, theme, before, after });
  }
  sections.push({ piece, shots });
}

const verdictClass = (v) => (v === 'pass' ? 'pass' : v === 'fail' ? 'fail' : 'wip');

const html = `<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Timekeeper UI overhaul — progress</title>
<style>
  :root {
    --bg: #0f1012; --panel: #17181b; --line: #2a2c31; --text: #f2f2f0;
    --muted: #9b9ba3; --accent: #6aa6ff; --pass: #43b581; --fail: #e0685f; --wip: #e0b45f;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text);
    font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  header { padding: 24px 20px 12px; border-bottom: 1px solid var(--line); position: sticky; top: 0;
    background: rgba(15,16,18,.92); backdrop-filter: blur(8px); z-index: 5; }
  h1 { margin: 0 0 4px; font-size: 20px; letter-spacing: -0.02em; }
  .sub { color: var(--muted); font-size: 13px; }
  main { padding: 16px 20px 64px; max-width: 1200px; margin: 0 auto; }
  .piece { background: var(--panel); border: 1px solid var(--line); border-radius: 12px;
    padding: 16px; margin: 0 0 18px; }
  .piece h2 { margin: 0 0 2px; font-size: 16px; letter-spacing: -0.01em; }
  .meta { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin: 6px 0 12px; }
  .tag { font-size: 12px; padding: 2px 8px; border-radius: 999px; border: 1px solid var(--line);
    color: var(--muted); }
  .tag.pass { color: var(--pass); border-color: color-mix(in oklab, var(--pass) 45%, transparent); }
  .tag.fail { color: var(--fail); border-color: color-mix(in oklab, var(--fail) 45%, transparent); }
  .tag.wip { color: var(--wip); border-color: color-mix(in oklab, var(--wip) 45%, transparent); }
  .verdict { font-size: 13.5px; color: var(--muted); margin: 0 0 12px; white-space: pre-wrap; }
  .combo { margin: 14px 0 0; }
  .combo h3 { margin: 0 0 6px; font-size: 12px; text-transform: uppercase; letter-spacing: .08em;
    color: var(--muted); font-weight: 600; }
  .pair { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  figure { margin: 0; }
  figcaption { font-size: 11.5px; color: var(--muted); margin: 0 0 4px; }
  img { width: 100%; border-radius: 8px; border: 1px solid var(--line); display: block; background: #000; }
  .empty { color: var(--muted); font-size: 13px; padding: 12px; border: 1px dashed var(--line);
    border-radius: 8px; text-align: center; }
  @media (max-width: 680px) { .pair { grid-template-columns: 1fr; } main { padding: 12px 12px 48px; } }
</style>
</head>
<body>
<header>
  <h1>Timekeeper UI overhaul</h1>
  <div class="sub">branch <code>${esc(log.branch || 'ui-overhaul-2026-08')}</code> · updated ${esc(log.updated || '')} · ${sections.length} pieces</div>
</header>
<main>
${sections.map(({ piece, shots }) => `
  <section class="piece">
    <h2>${esc(piece.title || piece.screen)}</h2>
    <div class="meta">
      <span class="tag ${verdictClass(piece.verdict)}">${esc(piece.verdict || 'in progress')}</span>
      ${piece.round ? `<span class="tag">round ${esc(piece.round)}</span>` : ''}
      ${piece.wave ? `<span class="tag">wave ${esc(piece.wave)}</span>` : ''}
    </div>
    ${piece.notes ? `<p class="verdict">${esc(piece.notes)}</p>` : ''}
    ${shots.length ? shots.map((s) => `
      <div class="combo">
        <h3>${esc(s.vp)} · ${esc(s.theme)}</h3>
        <div class="pair">
          <figure><figcaption>before</figcaption>${s.before ? `<img loading="lazy" src="${s.before}" alt="before ${esc(piece.screen)} ${esc(s.vp)} ${esc(s.theme)}">` : '<div class="empty">no shot</div>'}</figure>
          <figure><figcaption>after</figcaption>${s.after ? `<img loading="lazy" src="${s.after}" alt="after ${esc(piece.screen)} ${esc(s.vp)} ${esc(s.theme)}">` : '<div class="empty">not built yet</div>'}</figure>
        </div>
      </div>`).join('') : '<div class="empty">no screenshots yet</div>'}
  </section>`).join('')}
</main>
</body>
</html>`;

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, html);
await browser.close();
console.log(`${OUT} — ${sections.length} pieces, ${(Buffer.byteLength(html) / 1e6).toFixed(1)} MB`);
