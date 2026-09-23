import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

// The service worker's SHELL list is hand-kept. A module missing from it is
// still fetched and cached at runtime, but through the HTTP cache — so after a
// CACHE bump a remote client can pair a fresh importer with a stale copy of
// the missing module. Every app module under public/js must be precached.
const root = join(import.meta.dirname, '..', 'public');
const sw = readFileSync(join(root, 'sw.js'), 'utf8');
const shell = new Set([...sw.matchAll(/'\.\/([^']+)'/g)].map((m) => m[1]));

const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
  d.isDirectory() ? walk(join(dir, d.name)) : [join(dir, d.name)]);

test('every app module under public/js is in the service worker SHELL list', () => {
  const modules = walk(join(root, 'js'))
    .map((p) => relative(root, p).split('\\').join('/'))
    .filter((p) => p.endsWith('.js'))
    // spike pages are dev experiments, not part of the installed app
    .filter((p) => !p.split('/').pop().startsWith('spike-'));
  const missing = modules.filter((p) => !shell.has(p));
  assert.deepEqual(missing, []);
});

test('every SHELL entry exists on disk', () => {
  const files = new Set(walk(root).map((p) => relative(root, p).split('\\').join('/')));
  const gone = [...shell].filter((p) => p && !files.has(p));
  assert.deepEqual(gone, []);
});
