import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { IDLE_ICON } from '../public/js/lib/titlebar.js';

// The app icon is orange (per David — so the pinned app stands out on the
// Windows taskbar). public/icons/icon.svg is the single source: it is the
// tab favicon directly, and scripts/build-app-icons.mjs renders the PNGs the
// manifest (taskbar / install) uses from it.
const root = join(import.meta.dirname, '..', 'public');
const ORANGE = '#ea580c';

test('icon.svg is the orange source icon', () => {
  const svg = readFileSync(join(root, 'icons', 'icon.svg'), 'utf8');
  assert.match(svg, /^<svg /);
  assert.ok(svg.includes(`fill="${ORANGE}"`), 'background is the orange brand color');
});

test('idle favicon is icon.svg, in both index.html and the titlebar swap', () => {
  assert.equal(IDLE_ICON, '/icons/icon.svg');
  const html = readFileSync(join(root, 'index.html'), 'utf8');
  const href = html.match(/<link rel="icon"[^>]*href="([^"]+)"/)[1];
  assert.equal(href, IDLE_ICON);
});

test('manifest lists separate "any" and "maskable" PNGs that exist', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
  const purposes = manifest.icons.map((i) => i.purpose);
  assert.ok(purposes.includes('any'));
  assert.ok(purposes.includes('maskable'));
  assert.ok(!purposes.some((p) => p.includes(' ')), 'no combined "any maskable" entry');
  for (const i of manifest.icons) assert.ok(existsSync(join(root, i.src)), `${i.src} exists`);
});
