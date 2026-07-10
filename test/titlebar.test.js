import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runningTitle } from '../public/js/lib/titlebar.js';

// Browser-tab title (also the PWA taskbar hover preview): while a timer runs,
// show its live clock + name so the running state is visible from the OS.

const T0 = 1_000_000_000_000; // arbitrary fetch time

test('no running timer → plain app title', () => {
  const { title, running } = runningTitle(
    [{ id: 1, name: 'A', running: 0, elapsed_seconds: 500 }], T0, T0);
  assert.equal(title, 'Timekeeper');
  assert.equal(running, false);
});

test('null/empty timers → plain app title', () => {
  assert.equal(runningTitle(null, T0, T0).title, 'Timekeeper');
  assert.equal(runningTitle([], T0, T0).title, 'Timekeeper');
});

test('running timer → just ▶ live clock + name (no app name), wall-clock time since fetch added', () => {
  const timers = [
    { id: 1, name: 'Filed earlier', running: 0, elapsed_seconds: 900 },
    { id: 2, name: 'Acme research', running: 1, elapsed_seconds: 5040 },
  ];
  const { title, running } = runningTitle(timers, T0 + 20_000, T0); // +20s of wall clock
  assert.equal(title, '▶ 1:24:20 Acme research');
  assert.equal(running, true);
});

test('clock under an hour renders MM:SS', () => {
  const { title } = runningTitle(
    [{ id: 1, name: 'Quick timer', running: 1, elapsed_seconds: 65 }], T0, T0);
  assert.equal(title, '▶ 01:05 Quick timer');
});

test('clock never runs backwards on skewed timestamps', () => {
  const { title } = runningTitle(
    [{ id: 1, name: 'T', running: 1, elapsed_seconds: 60 }], T0 - 5_000, T0);
  assert.equal(title, '▶ 01:00 T');
});
