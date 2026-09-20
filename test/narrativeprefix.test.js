import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPrefixOnly, prefixForMatter, afterPrefix, splitPrefix } from '../public/js/lib/narrativeprefix.js';

test('isPrefixOnly: blank or just the prefix', () => {
  assert.equal(isPrefixOnly('', '(ABC02)'), true);
  assert.equal(isPrefixOnly('  (ABC02) ', '(ABC02)'), true);
  assert.equal(isPrefixOnly('(ABC02) Call.', '(ABC02)'), false);
  assert.equal(isPrefixOnly('', null), true);
  assert.equal(isPrefixOnly('(ABC02)', null), false);
});

test('prefixForMatter: an untouched box follows the matter; typed text never moves', () => {
  assert.equal(prefixForMatter('', null, '(ABC02)'), '(ABC02) ');
  assert.equal(prefixForMatter('(ABC02) ', '(ABC02)', '(XYZ01)'), '(XYZ01) ');
  assert.equal(prefixForMatter('(ABC02) ', '(ABC02)', null), '');
  assert.equal(prefixForMatter('(ABC02) Call.', '(ABC02)', '(XYZ01)'), '(ABC02) Call.');
  assert.equal(prefixForMatter('Call.', null, '(XYZ01)'), 'Call.');
});

test('afterPrefix: added text follows the prefix', () => {
  assert.equal(afterPrefix('(ABC02)', ' Review lease '), '(ABC02) Review lease');
  assert.equal(afterPrefix(null, 'Review lease'), 'Review lease');
});

test('splitPrefix: prose apart from its prefix, round-trips through afterPrefix', () => {
  assert.deepEqual(splitPrefix('(ABC02) Call re lease.', '(ABC02)'), { lead: '(ABC02)', body: 'Call re lease.' });
  assert.deepEqual(splitPrefix('Call re lease.', '(ABC02)'), { lead: null, body: 'Call re lease.' });
  assert.deepEqual(splitPrefix('(ABC02) ', '(ABC02)'), { lead: '(ABC02)', body: '' });
  assert.deepEqual(splitPrefix('Call.', null), { lead: null, body: 'Call.' });
  const { lead, body } = splitPrefix('(ABC02) Call.', '(ABC02)');
  assert.equal(afterPrefix(lead, body.toUpperCase()), '(ABC02) CALL.');
});

test('afterPrefix: borrowed text that already carries the prefix is not doubled', () => {
  assert.equal(afterPrefix('(ABC02)', '(ABC02) Call re lease.'), '(ABC02) Call re lease.');
});
