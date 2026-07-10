import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { startTestServer } from './helpers.js';

// Alt+drag UI feedback: screenshot lands in FEEDBACK_DIR, a checkbox entry
// referencing it lands in TODO_PATH. Tests point both at the sandbox
// DATA_DIR (the route's fallback) so nothing touches the real repo files.

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const IMG = `data:image/png;base64,${PNG_B64}`;

async function withServer(fn) {
  const t = await startTestServer();
  try { await fn(t); } finally { await t.close(); }
}

test('POST /api/feedback saves the screenshot and appends a TODO entry', () =>
  withServer(async (t) => {
    const { status, body } = await t.fetchJson('POST', '/api/feedback', {
      note: 'Tabs feel cramped', image: IMG, route: '#/',
    });
    assert.equal(status, 201);
    assert.ok(body.file, 'saved file name returned');

    const dir = join(t.dir, 'feedback');
    const files = readdirSync(dir);
    assert.equal(files.length, 1);
    assert.ok(files[0].endsWith('.png'));

    const todo = readFileSync(join(t.dir, 'TODO.md'), 'utf8');
    assert.match(todo, /## UI feedback \(screenshots\)/);
    assert.match(todo, /Tabs feel cramped/);
    assert.ok(todo.includes(`feedback/${files[0]}`), 'TODO references the screenshot');
  }));

test('POST /api/feedback without a screenshot files a note-only entry', () =>
  withServer(async (t) => {
    const { status } = await t.fetchJson('POST', '/api/feedback', {
      note: 'Meter too subtle', route: '#/stats',
    });
    assert.equal(status, 201);
    assert.equal(existsSync(join(t.dir, 'feedback')), false, 'no image dir created');
    const todo = readFileSync(join(t.dir, 'TODO.md'), 'utf8');
    assert.match(todo, /Meter too subtle \(no screenshot · #\/stats\)/);
  }));

test('POST /api/feedback appends to an existing TODO without duplicating the section', () =>
  withServer(async (t) => {
    await t.fetchJson('POST', '/api/feedback', { note: 'First', route: '#/' });
    await t.fetchJson('POST', '/api/feedback', { note: 'Second', route: '#/' });
    const todo = readFileSync(join(t.dir, 'TODO.md'), 'utf8');
    assert.equal(todo.match(/## UI feedback/g).length, 1);
    assert.ok(todo.indexOf('First') < todo.indexOf('Second'));
  }));

test('POST /api/feedback rejects empty notes and bad images', () =>
  withServer(async (t) => {
    assert.equal((await t.fetchJson('POST', '/api/feedback', { note: '  ' })).status, 400);
    assert.equal((await t.fetchJson('POST', '/api/feedback', {
      note: 'x', image: 'data:text/html;base64,PGI+aGk8L2I+',
    })).status, 400);
  }));
