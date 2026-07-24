import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDaySummary } from '../public/js/lib/daysummary.js';

const entry = (over = {}) => ({
  id: 1,
  date: '2026-07-24',
  total: 1.2,
  billable: 1,
  narrative: 'Reviewed the thing.',
  cm: { cm_number: '123456-000123', short_name: 'Series B Financing', client_name: 'Acme Holdings' },
  ...over,
});

test('formats one block per entry with client, matter, number, hours, narrative', () => {
  const text = buildDaySummary([entry()], { title: 'Friday, July 24, 2026' });
  assert.equal(text, [
    'Friday, July 24, 2026 — 1.2h',
    '',
    'Acme Holdings — Series B Financing (123456-000123) — 1.2h',
    '  Reviewed the thing.',
  ].join('\n'));
});

test('header omits the billable split when every entry is billable', () => {
  const text = buildDaySummary([entry(), entry({ id: 2, total: 0.3 })], { title: 'Day' });
  assert.equal(text.split('\n')[0], 'Day — 1.5h');
});

test('header shows the split and tags entries when some time is non-billable', () => {
  const text = buildDaySummary([
    entry(),
    entry({ id: 2, total: 0.5, billable: 0, narrative: 'Firm meeting.' }),
  ], { title: 'Day' });
  assert.equal(text.split('\n')[0], 'Day — 1.7h (1.2h billable / 0.5h non-billable)');
  assert.match(text, /— 0\.5h \[non-billable\]\n {2}Firm meeting\./);
  // billable entries are never tagged — that is the norm, tagging is noise
  assert.equal(text.match(/\[non-billable\]/g).length, 1);
});

test('blocks are separated by a blank line', () => {
  const text = buildDaySummary([entry(), entry({ id: 2 })], { title: 'Day' });
  assert.match(text, /Reviewed the thing\.\n\nAcme Holdings/);
});

test('falls back to the matter short name when the client has no name', () => {
  const text = buildDaySummary([entry({
    cm: { cm_number: '123456-000123', short_name: 'Series B Financing', client_name: '' },
  })], { title: 'Day' });
  assert.match(text, /^Series B Financing \(123456-000123\) — 1\.2h$/m);
});

test('renders a matterless entry as (no matter) with no number', () => {
  const text = buildDaySummary([entry({ cm: null })], { title: 'Day' });
  assert.match(text, /^\(no matter\) — 1\.2h$/m);
});

test('renders an empty narrative as (no narrative)', () => {
  const text = buildDaySummary([entry({ narrative: '   ' })], { title: 'Day' });
  assert.match(text, /\n {2}\(no narrative\)$/);
});

test('wraps narratives at 76 characters on word boundaries, indented two spaces', () => {
  const narrative = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa';
  const text = buildDaySummary([entry({ narrative })], { title: 'Day' });
  const lines = text.split('\n').slice(3);
  assert.ok(lines.length > 1, 'expected the narrative to wrap');
  for (const line of lines) {
    assert.ok(line.startsWith('  '), `expected indent on ${JSON.stringify(line)}`);
    assert.ok(line.length <= 78, `line too long: ${JSON.stringify(line)}`);
  }
  assert.equal(lines.map((l) => l.slice(2)).join(' '), narrative);
});

test('lets an unbreakable token overrun rather than hyphenating it', () => {
  const url = 'https://example.test/' + 'x'.repeat(90);
  const text = buildDaySummary([entry({ narrative: `See ${url} for detail.` })], { title: 'Day' });
  assert.ok(text.includes(url), 'the long token must survive intact');
});

test('preserves line breaks inside a narrative and indents each line', () => {
  const text = buildDaySummary([entry({ narrative: 'First line.\nSecond line.' })], { title: 'Day' });
  assert.match(text, /\n {2}First line\.\n {2}Second line\.$/);
});

test('sorts by client, then matter, then id — case-insensitively', () => {
  const mk = (id, client, matter) => entry({
    id, total: 0.1, cm: { cm_number: '123456-00000' + id, short_name: matter, client_name: client },
  });
  const text = buildDaySummary([
    mk(4, 'beta corp', 'Zoning'),
    mk(3, 'Acme Holdings', 'trademark'),
    mk(1, 'Acme Holdings', 'Series B'),
    mk(2, 'Acme Holdings', 'Series B'),
  ], { title: 'Day' });
  const heads = text.split('\n').filter((l) => l.includes(' — 0.1h'));
  assert.deepEqual(heads.map((h) => h.split(' (')[0]), [
    'Acme Holdings — Series B',
    'Acme Holdings — Series B',
    'Acme Holdings — trademark',
    'beta corp — Zoning',
  ]);
  assert.match(heads[0], /000001/);
  assert.match(heads[1], /000002/);
});

test('showDates groups entries under date headings with per-day subtotals', () => {
  const text = buildDaySummary([
    entry({ id: 2, date: '2026-07-24', total: 0.5 }),
    entry({ id: 1, date: '2026-07-22', total: 1.0 }),
  ], { title: 'Week of July 20, 2026', showDates: true });
  const iSecond = text.indexOf('Wednesday, July 22, 2026 — 1.0h');
  const iFirst = text.indexOf('Friday, July 24, 2026 — 0.5h');
  assert.ok(iSecond > 0 && iFirst > iSecond, 'days ascend, each with a subtotal');
  assert.equal(text.split('\n')[0], 'Week of July 20, 2026 — 1.5h');
});

test('showDates skips days with no entries', () => {
  const text = buildDaySummary([entry({ date: '2026-07-22' })], { title: 'Week', showDates: true });
  assert.equal(text.match(/, 2026 —/g).length, 1);
});

test('reports an empty day', () => {
  assert.equal(buildDaySummary([], { title: 'Friday, July 24, 2026' }),
    'Friday, July 24, 2026 — 0.0h\n\nNo entries.');
});

test('hours precision follows the rounding increment', () => {
  const tenths = buildDaySummary([entry({ total: 1.25 })], { title: 'Day', increment: 0.1 });
  assert.match(tenths, /— 1\.3h$/m);
  const quarters = buildDaySummary([entry({ total: 1.25 })], { title: 'Day', increment: 0.25 });
  assert.match(quarters, /— 1\.25h$/m);
});
