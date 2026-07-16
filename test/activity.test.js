process.env.TZ = 'America/Los_Angeles';
import test from 'node:test';
import assert from 'node:assert/strict';
import { lastActivityMs, activityWindows, inWindow } from '../public/js/lib/activity.js';

// Wed 2026-07-15 15:00 local
const NOW = new Date(2026, 6, 15, 15, 0, 0).getTime();
const iso = (y, m, d, h = 12) => new Date(y, m - 1, d, h).toISOString();

test('lastActivityMs: running timer is active now', () => {
  assert.equal(lastActivityMs({ running: 1, last_started_at: iso(2026, 7, 10) }, NOW), NOW);
});

test('lastActivityMs: stopped timer uses the later of start/stop', () => {
  const t = { running: 0, last_started_at: iso(2026, 7, 14, 9), last_stopped_at: iso(2026, 7, 14, 17) };
  assert.equal(lastActivityMs(t, NOW), Date.parse(iso(2026, 7, 14, 17)));
  assert.equal(lastActivityMs({ running: 0 }, NOW), 0); // never used
});

test('activityWindows: yesterday is a closed [00:00, 00:00) window', () => {
  const w = activityWindows(NOW);
  assert.equal(w['act-yesterday'].label, 'Yesterday');
  assert.equal(w['act-yesterday'].since, new Date(2026, 6, 14).getTime());
  assert.equal(w['act-yesterday'].until, new Date(2026, 6, 15).getTime());
  assert.equal(w['act-today'].since, new Date(2026, 6, 15).getTime());
  assert.equal(w['act-today'].until, null);
  // display order: Today, Yesterday, Week, Recent
  assert.deepEqual(Object.keys(w), ['act-today', 'act-yesterday', 'act-week', 'act-recent']);
});

test('activityWindows: week starts Monday, recent is 14 days', () => {
  const w = activityWindows(NOW); // 2026-07-15 is a Wednesday
  assert.equal(w['act-week'].since, new Date(2026, 6, 13).getTime()); // Mon Jul 13
  assert.equal(w['act-week'].until, null);
  assert.equal(w['act-recent'].since, NOW - 14 * 86400000);
});

test('inWindow: since inclusive, until exclusive', () => {
  const w = activityWindows(NOW);
  const y = w['act-yesterday'];
  assert.equal(inWindow(y.since, y), true);                 // midnight yesterday
  assert.equal(inWindow(y.until - 1, y), true);             // 23:59:59.999
  assert.equal(inWindow(y.until, y), false);                // today 00:00 → Today's
  assert.equal(inWindow(y.since - 1, y), false);            // day before
});

test('a timer used yesterday AND today counts as Today, not Yesterday', () => {
  const w = activityWindows(NOW);
  const t = { running: 0, last_started_at: iso(2026, 7, 15, 9), last_stopped_at: iso(2026, 7, 15, 10) };
  const ms = lastActivityMs(t, NOW);
  assert.equal(inWindow(ms, w['act-today']), true);
  assert.equal(inWindow(ms, w['act-yesterday']), false);
});
