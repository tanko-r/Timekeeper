import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseQuickCapture } from '../server/lib/quickcapture.js';

const MATTERS = [
  { id: 1, short_name: 'Loading Dock Lease', client_name: 'Meridian', cm_number: '100001-000012', matter_number: '000012', client_number: '100001' },
  { id: 2, short_name: 'Harbor drafting', client_name: 'Meridian', cm_number: '100001-000099', matter_number: '000099', client_number: '100001' },
  { id: 3, short_name: 'Summit Development Agreement', client_name: 'Ironwood', cm_number: '100005-000001', matter_number: '000001', client_number: '100005' },
];
const CODES = ['Review', 'Draft', 'Revise', 'Research', 'Correspondence', 'Call/Conference', 'Negotiate', 'Travel'];
const parse = (line) => parseQuickCapture(line, { matters: MATTERS, taskCodes: CODES });

test('the spec example: call sam re loading dock lease .3', () => {
  const p = parse('call sam re loading dock lease .3');
  assert.equal(p.hours, 0.3);
  assert.equal(p.task_code, 'Call/Conference');
  assert.equal(p.person, 'Sam');
  assert.equal(p.topic, 'loading dock lease');
  assert.equal(p.narrative, 'Telephone conference with Sam regarding loading dock lease');
  assert.equal(p.matches[0].id, 1); // "loading dock" fuzzy-matches the lease matter
  assert.deepEqual(p.missing, []);
});

test('minutes and h-suffix durations', () => {
  assert.equal(parse('review lease 18m').hours, 0.3);
  assert.equal(parse('review lease 90min').hours, 1.5);
  assert.equal(parse('draft psa 1.5h').hours, 1.5);
  assert.equal(parse('draft psa 2hrs').hours, 2);
  assert.equal(parse('draft psa 0.4').hours, 0.4);
});

test('with-counterparty and correspondence mapping', () => {
  const p = parse('email w/ Alex Turner re summit development 0.2');
  assert.equal(p.task_code, 'Correspondence');
  assert.equal(p.person, 'Alex Turner');
  assert.equal(p.narrative, 'Correspondence with Alex Turner regarding summit development');
  assert.equal(p.matches[0].id, 3);
});

test('no re-marker: leftover tokens are the matter query', () => {
  const p = parse('revise harbor .5');
  assert.equal(p.task_code, 'Revise');
  assert.equal(p.topic, 'harbor');
  assert.equal(p.matches[0].id, 2);
  assert.equal(p.narrative, 'Revise harbor');
});

test('missing pieces are reported, first word kept when not a verb', () => {
  const p = parse('zoning setback issue');
  assert.equal(p.hours, null);
  assert.equal(p.task_code, null);
  assert.equal(p.topic, 'zoning setback issue');
  assert.deepEqual(p.missing.sort(), ['action', 'hours', 'matter']);
});

test('matter missing only when nothing matches', () => {
  const p = parse('call re nonexistent gibberish xyzzy .3');
  assert.ok(p.missing.includes('matter'));
  assert.deepEqual(p.matches, []);
});

test('empty and junk input', () => {
  const p = parse('   ');
  assert.deepEqual(p.missing.sort(), ['action', 'hours', 'matter']);
  assert.equal(p.narrative, '');
});
