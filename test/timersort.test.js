import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareTimersAZ } from '../public/js/lib/timersort.js';

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
