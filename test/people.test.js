import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractPeople } from '../server/lib/people.js';

test('extracts name after "telephone conference with"', () => {
  assert.deepEqual(
    extractPeople('Telephone conference with M. Smith regarding lease terms.'),
    ['M. Smith']);
});

test('extracts multiple names joined by "and" and commas', () => {
  assert.deepEqual(
    extractPeople('Email to John Smith and Mary Jones re revised draft'),
    ['John Smith', 'Mary Jones']);
  assert.deepEqual(
    extractPeople('email to A. Foo, B. Bar and C. Baz re closing'),
    ['A. Foo', 'B. Bar', 'C. Baz']);
});

test('generic roles are not people', () => {
  assert.deepEqual(extractPeople('Correspondence with opposing counsel regarding hearing.'), []);
  assert.deepEqual(extractPeople('Call with Opposing Counsel re schedule.'), []);
  assert.deepEqual(extractPeople('meeting with City of Springfield staff'), []);
});

test('possessive captures are descriptions, not names', () => {
  assert.deepEqual(extractPeople("Conference with Sam's counsel re lease."), []);
  assert.deepEqual(extractPeople('Call with Landlord\'s broker.'), []);
});

test('trailing punctuation and duration labels never leak into names', () => {
  assert.deepEqual(
    extractPeople('Emails from A. Turner; revise lease (0.3).'),
    ['A. Turner']);
});

test('connector tokens cut the capture', () => {
  assert.deepEqual(
    extractPeople('Meeting with John Smith Re Draft Agreement'),
    ['John Smith']);
});

test('courtesy titles are consumed but not stored', () => {
  assert.deepEqual(extractPeople('Email from Dr. Jones re inspection'), ['Jones']);
});

test('hyphens and apostrophes survive', () => {
  assert.deepEqual(
    extractPeople("Zoom with Sarah O'Brien-Smith re closing checklist"),
    ["Sarah O'Brien-Smith"]);
});

test('dedupes case-insensitively within one text', () => {
  assert.deepEqual(
    extractPeople('Call with John Smith; follow-up call with JOHN SMITH.'),
    ['John Smith']);
});

test('a bare single initial is not a name', () => {
  assert.deepEqual(extractPeople('call with M. re lease'), []);
});

test('no triggers, empty, or non-string input → empty', () => {
  assert.deepEqual(extractPeople('Review lease agreement for renewal terms.'), []);
  assert.deepEqual(extractPeople(''), []);
  assert.deepEqual(extractPeople(null), []);
  assert.deepEqual(extractPeople(undefined), []);
});
