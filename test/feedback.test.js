import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseImageDataUrl, feedbackTodoEntry, appendFeedbackTodo,
} from '../server/lib/feedback.js';

// 1x1 transparent PNG
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

test('parseImageDataUrl accepts png/jpeg data URLs and returns the bytes', () => {
  const png = parseImageDataUrl(`data:image/png;base64,${PNG_B64}`);
  assert.equal(png.ext, 'png');
  assert.ok(png.buf.length > 20);
  assert.equal(png.buf[0], 0x89); // PNG magic

  const jpg = parseImageDataUrl(`data:image/jpeg;base64,${PNG_B64}`);
  assert.equal(jpg.ext, 'jpg');
});

test('parseImageDataUrl rejects other mime types, garbage, and oversize payloads', () => {
  assert.equal(parseImageDataUrl('data:text/html;base64,PGI+aGk8L2I+'), null);
  assert.equal(parseImageDataUrl('not a data url'), null);
  assert.equal(parseImageDataUrl(null), null);
  assert.equal(parseImageDataUrl(`data:image/png;base64,${PNG_B64}`, 10), null, 'over the byte cap');
});

test('feedbackTodoEntry formats a checkbox line with note, file, and route', () => {
  const line = feedbackTodoEntry({
    note: 'Tabs feel cramped',
    file: 'feedback/2026-07-09T21-30-00.png',
    route: '#/',
    when: new Date('2026-07-09T21:30:00-07:00'),
  });
  assert.equal(line, '- [ ] 2026-07-09 21:30 — Tabs feel cramped (feedback/2026-07-09T21-30-00.png · #/)');
});

test('feedbackTodoEntry works without a screenshot file', () => {
  const line = feedbackTodoEntry({
    note: 'Meter too subtle', file: null, route: '#/stats',
    when: new Date('2026-07-09T08:05:00-07:00'),
  });
  assert.equal(line, '- [ ] 2026-07-09 08:05 — Meter too subtle (no screenshot · #/stats)');
});

test('appendFeedbackTodo creates the section once and appends entries to it', () => {
  const base = '# Backlog\n\nStuff.\n';
  const one = appendFeedbackTodo(base, '- [ ] first');
  assert.match(one, /## UI feedback \(screenshots\)/);
  assert.match(one, /- \[ \] first\n$/);

  const two = appendFeedbackTodo(one, '- [ ] second');
  assert.equal(two.match(/## UI feedback/g).length, 1, 'section not duplicated');
  const idx1 = two.indexOf('- [ ] first');
  const idx2 = two.indexOf('- [ ] second');
  assert.ok(idx1 !== -1 && idx2 > idx1, 'second entry appended after the first');
});
