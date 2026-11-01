import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adjustRun } from '../server/lib/timerlogic.js';

// Midnight for the fictional day; "now" is 14:00 that day.
const M = Date.parse('2026-07-06T00:00:00-07:00');
const PM = M - 24 * 3600_000; // yesterday's midnight
const at = (h, m = 0) => M + (h * 60 + m) * 60_000;
const NOW = at(14);
const iso = (ms) => new Date(ms).toISOString();

const running = (over = {}) => ({
  running: 1, accumulated_seconds: 0,
  last_started_at: iso(at(9)), last_run_started_at: iso(at(9)),
  last_stopped_at: null, ...over,
});
const stopped = (over = {}) => ({
  running: 0, accumulated_seconds: 3600,
  last_started_at: null, last_run_started_at: iso(at(9)),
  last_stopped_at: iso(at(10)), ...over,
});
const adj = (timer, req) => adjustRun(timer, req, { nowMs: NOW, midnightMs: M, prevMidnightMs: PM });

test('running: set stop time banks the run up to that moment and stops', () => {
  const r = adj(running(), { stopMs: at(11) });
  assert.equal(r.error, undefined);
  assert.equal(r.running, 0);
  assert.equal(r.accumulatedSeconds, 2 * 3600);
  assert.equal(r.lastStartedAt, null);
  assert.equal(r.lastStoppedAt, iso(at(11)));
  assert.equal(r.lastRunStartedAt, iso(at(9)));
});

test('running: earlier segments of the day are kept', () => {
  const r = adj(running({ accumulated_seconds: 1800 }), { stopMs: at(10) });
  assert.equal(r.accumulatedSeconds, 1800 + 3600);
});

test('running: stop must not be before the start or in the future', () => {
  assert.match(adj(running(), { stopMs: at(8) }).error, /after the start/);
  assert.match(adj(running(), { stopMs: at(15) }).error, /future/);
});

test('running: editing only the start moves the running segment', () => {
  const r = adj(running(), { startMs: at(8, 30) });
  assert.equal(r.running, 1);
  assert.equal(r.lastStartedAt, iso(at(8, 30)));
  assert.equal(r.lastRunStartedAt, iso(at(8, 30)));
  assert.equal(r.accumulatedSeconds, 0);
});

test('running: start cannot be in the future or before today', () => {
  assert.match(adj(running(), { startMs: at(15) }).error, /future/);
  assert.match(adj(running(), { startMs: at(-1) }).error, /today/);
});

test('running: start and stop together', () => {
  const r = adj(running(), { startMs: at(8), stopMs: at(8, 45) });
  assert.equal(r.accumulatedSeconds, 45 * 60);
  assert.equal(r.lastRunStartedAt, iso(at(8)));
});

test('stopped: moving the stop later adds the difference', () => {
  const r = adj(stopped(), { stopMs: at(10, 30) });
  assert.equal(r.accumulatedSeconds, 3600 + 1800);
  assert.equal(r.lastStoppedAt, iso(at(10, 30)));
  assert.equal(r.running, 0);
});

test('stopped: moving the stop earlier removes the difference', () => {
  const r = adj(stopped(), { stopMs: at(9, 20) });
  assert.equal(r.accumulatedSeconds, 20 * 60);
});

test('stopped: stop cannot pass the start of the run', () => {
  assert.match(adj(stopped(), { stopMs: at(8, 59) }).error, /after the start/);
});

test('stopped: moving the start earlier adds time, later removes it', () => {
  assert.equal(adj(stopped(), { startMs: at(8, 30) }).accumulatedSeconds, 3600 + 1800);
  assert.equal(adj(stopped(), { startMs: at(9, 30) }).accumulatedSeconds, 1800);
  assert.equal(adj(stopped(), { startMs: at(9, 30) }).lastRunStartedAt, iso(at(9, 30)));
});

test('stopped: start must be before the stop', () => {
  assert.match(adj(stopped(), { startMs: at(10, 30) }).error, /before the stop/);
});

test('stopped without a known run start: stop editable, start not', () => {
  const t = stopped({ last_run_started_at: null });
  assert.equal(adj(t, { stopMs: at(10, 15) }).accumulatedSeconds, 3600 + 900);
  assert.match(adj(t, { startMs: at(9) }).error, /start/i);
});

test('stopped yesterday (banked): not editable', () => {
  const t = stopped({ last_stopped_at: iso(at(-2)), last_run_started_at: iso(at(-3)) });
  assert.match(adj(t, { stopMs: at(1) }).error, /banked|yesterday/i);
});

test('stopped: total never goes negative', () => {
  const t = stopped({ accumulated_seconds: 600, last_stopped_at: iso(at(10)), last_run_started_at: null });
  assert.match(adj(t, { stopMs: at(9) }).error, /below zero|negative/i);
});

test('overnight run: start is read-only, stop after midnight keeps today\'s part', () => {
  const t = running({ last_started_at: iso(M), last_run_started_at: iso(at(-3)) });
  assert.match(adj(t, { startMs: at(1) }).error, /overnight|yesterday/i);
  const r = adj(t, { stopMs: at(2) });
  assert.equal(r.accumulatedSeconds, 2 * 3600);
  assert.equal(r.rewindSeconds, 0);
});

test('overnight run: stop before midnight rewinds yesterday and zeroes today', () => {
  const t = running({ last_started_at: iso(M), last_run_started_at: iso(at(-3)) });
  const r = adj(t, { stopMs: at(-2) });
  assert.equal(r.error, undefined);
  assert.equal(r.accumulatedSeconds, 0);
  assert.equal(r.rewindSeconds, 2 * 3600);
  assert.equal(r.lastStoppedAt, iso(at(-2)));
  assert.equal(r.running, 0);
});

test('overnight run: cannot stop before the run began, or before yesterday', () => {
  const t = running({ last_started_at: iso(M), last_run_started_at: iso(at(-3)) });
  assert.match(adj(t, { stopMs: at(-4) }).error, /after the start/);
  const old = running({ last_started_at: iso(M), last_run_started_at: iso(PM - 3600_000) });
  assert.match(adj(old, { stopMs: PM - 1800_000 }).error, /more than a day|earlier day/i);
});

test('needs at least one of start or stop', () => {
  assert.match(adj(running(), {}).error, /start or stop/i);
});
