import test from 'node:test';
import assert from 'node:assert/strict';
import { groupFindings } from '../public/js/lib/validationflags.js';

const warn = (code, message) => ({ level: 'warn', code, message });
const block = (code, message) => ({ level: 'block', code, message });

test('no findings → no flags', () => {
  assert.deepEqual(groupFindings([]), []);
  assert.deepEqual(groupFindings(null), []);
  assert.deepEqual(groupFindings(undefined), []);
});

test('one flag per level, block first, messages joined for the hover text', () => {
  const flags = groupFindings([
    warn('narrative_short', 'Narrative is under 10 characters.'),
    block('narrative_empty', 'Narrative is empty.'),
    warn('total_zero', 'Entry total is zero.'),
  ]);
  assert.deepEqual(flags, [
    { level: 'block', count: 1, title: 'Narrative is empty.' },
    { level: 'warn', count: 2, title: 'Narrative is under 10 characters.\nEntry total is zero.' },
  ]);
});

test('warnings only → a single warn flag', () => {
  assert.deepEqual(groupFindings([warn('x', 'A.')]), [{ level: 'warn', count: 1, title: 'A.' }]);
});

test('unknown levels are ignored rather than rendered as a blank flag', () => {
  assert.deepEqual(groupFindings([{ level: 'info', code: 'x', message: 'Hi.' }]), []);
});
