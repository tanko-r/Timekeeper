import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareTimersAZ, clusterByClient } from '../public/js/lib/timersort.js';

// 2026-07-27 feedback: "I clicked sort A–Z and it's not properly sorted by
// timer caption. Maybe it's sorting by matter name?" — it was. The card shows
// the caption, so that is what A–Z has to order by.

const T = (name, cm_short_name = '') => ({ name, cm_short_name });

test('compareTimersAZ orders by the caption shown on the card, not the matter', () => {
  const timers = [
    T('TEL', 'Real Estate Dev-AMERS-USA-General FY26'),
    T('RNO12 - NVE Easement', 'Reno Transmission'),
    T('PHX80', 'Phoenix Substation'),
    T('YEL', 'Real Estate Dev-AMERS-USA-General FY26'),
  ];
  assert.deepEqual(
    [...timers].sort(compareTimersAZ).map((t) => t.name),
    ['PHX80', 'RNO12 - NVE Easement', 'TEL', 'YEL']);
});

test('compareTimersAZ ignores case and sorts numbers within a caption naturally', () => {
  const timers = [T('avc17'), T('AVC2'), T('AVC10'), T('Zulu'), T('alpha')];
  assert.deepEqual(
    [...timers].sort(compareTimersAZ).map((t) => t.name),
    ['alpha', 'AVC2', 'AVC10', 'avc17', 'Zulu']);
});

test('compareTimersAZ falls back to the matter for identical captions, and tolerates blanks', () => {
  const timers = [T('Call', 'Zeta matter'), T('Call', 'Alpha matter'), T(''), T('Call')];
  assert.deepEqual(
    [...timers].sort(compareTimersAZ).map((t) => t.cm_short_name),
    ['', '', 'Alpha matter', 'Zeta matter']);
});

// 2026-09-15 feedback: the time-based tabs (Today/Yesterday/Week/Recent) and
// All show one alphabetical list mixing every client — subtly cluster it by
// client instead, no labels, so the eye can still tell clients apart.
// T(timer id, name, client id) — timer id and client id are deliberately
// different numbering so a test misreading one for the other would fail.
const T2 = (id, name, clientId) => ({ id, name, client_id: clientId });

test('clusterByClient groups same-client timers together, in first-appearance order', () => {
  const timers = [T2(10, 'A', 1), T2(11, 'B', 2), T2(12, 'C', 1), T2(13, 'D', 3), T2(14, 'E', 2)];
  const { list } = clusterByClient(timers);
  // client 1 (A, C) first-appears before client 2 (B, E) before client 3 (D)
  assert.deepEqual(list.map((t) => t.name), ['A', 'C', 'B', 'E', 'D']);
});

test('clusterByClient marks the first card of every cluster after the first', () => {
  const timers = [T2(10, 'A', 1), T2(11, 'B', 2), T2(12, 'C', 1), T2(13, 'D', 3)];
  const { list, starts } = clusterByClient(timers);
  assert.deepEqual(list.map((t) => t.name), ['A', 'C', 'B', 'D']);
  // B (id 11) and D (id 13) start new clusters; A does not — it's the very
  // first card overall, so no leading gap before anything has rendered yet.
  assert.deepEqual([...starts].sort(), [11, 13]);
});

test('clusterByClient treats matterless timers (no client_id) as one shared cluster', () => {
  const timers = [T2(1, 'A', null), T2(2, 'B', null)];
  const { list, starts } = clusterByClient(timers);
  assert.deepEqual(list.map((t) => t.name), ['A', 'B']);
  assert.equal(starts.size, 0);
});

test('clusterByClient preserves within-cluster order and is a no-op when everything shares a client', () => {
  const timers = [T2(1, 'B', 9), T2(2, 'A', 9), T2(3, 'C', 9)];
  const { list, starts } = clusterByClient(timers);
  assert.deepEqual(list.map((t) => t.name), ['B', 'A', 'C']);
  assert.equal(starts.size, 0);
});
