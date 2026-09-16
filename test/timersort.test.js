import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareTimersAZ, groupTimersByClient } from '../public/js/lib/timersort.js';

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

// 2026-09-15/16 feedback: the time-based tabs (Today/Yesterday/Week/Recent)
// show one alphabetical list mixing every client — group it by client
// instead, same header style as the "All" tab's named groups, except a
// client with only one timer here doesn't get its own header — those pool
// into a trailing "Other Clients" group.
// T(timer id, name, client id, client name) — timer id and client id are
// deliberately different numbering so a test misreading one for the other
// would fail.
const T2 = (id, name, clientId, clientName) => ({ id, name, client_id: clientId, client_name: clientName });

test('groupTimersByClient gives a multi-timer client its own group, labeled and ordered by first appearance', () => {
  const timers = [
    T2(10, 'A', 1, 'Acme'), T2(11, 'B', 2, 'Bell'), T2(12, 'C', 1, 'Acme'), T2(13, 'D', 2, 'Bell'),
  ];
  const groups = groupTimersByClient(timers);
  assert.deepEqual(groups.map((g) => g.label), ['Acme', 'Bell']);
  assert.deepEqual(groups.map((g) => g.list.map((t) => t.name)), [['A', 'C'], ['B', 'D']]);
});

test('groupTimersByClient pools single-timer clients into a trailing "Other Clients" group', () => {
  const timers = [
    T2(10, 'A', 1, 'Acme'), T2(11, 'B', 2, 'Bell'), T2(12, 'C', 1, 'Acme'), T2(13, 'D', 3, 'Cedar'),
  ];
  const groups = groupTimersByClient(timers);
  // Acme has 2 → its own group; Bell and Cedar are solo → pooled, in the
  // order they first appeared, and the pool comes after every real group.
  assert.deepEqual(groups.map((g) => g.label), ['Acme', 'Other Clients']);
  assert.deepEqual(groups[1].list.map((t) => t.name), ['B', 'D']);
});

test('groupTimersByClient omits "Other Clients" entirely when nothing is solo', () => {
  const timers = [T2(1, 'A', 1, 'Acme'), T2(2, 'B', 1, 'Acme'), T2(3, 'C', 2, 'Bell'), T2(4, 'D', 2, 'Bell')];
  const groups = groupTimersByClient(timers);
  assert.deepEqual(groups.map((g) => g.label), ['Acme', 'Bell']);
});

test('groupTimersByClient pools everything into "Other Clients" when every client is solo', () => {
  const timers = [T2(1, 'A', 1, 'Acme'), T2(2, 'B', 2, 'Bell'), T2(3, 'C', 3, 'Cedar')];
  const groups = groupTimersByClient(timers);
  assert.deepEqual(groups.map((g) => g.label), ['Other Clients']);
  assert.deepEqual(groups[0].list.map((t) => t.name), ['A', 'B', 'C']);
});

test('groupTimersByClient treats matterless timers as one client ("No client") like any other', () => {
  const timers = [T2(1, 'A', null), T2(2, 'B', null), T2(3, 'C', 1, 'Acme')];
  const groups = groupTimersByClient(timers);
  // two matterless timers → their own "No client" group, same rule as a
  // real client with 2+; the single Acme timer is solo → pooled instead.
  assert.deepEqual(groups.map((g) => g.label), ['No client', 'Other Clients']);
  assert.deepEqual(groups[0].list.map((t) => t.name), ['A', 'B']);
  assert.deepEqual(groups[1].list.map((t) => t.name), ['C']);
});
