import { test } from 'node:test';
import assert from 'node:assert/strict';
import { siteCode, narrativePrefix, seedNarrative } from '../server/lib/sitecode.js';

test('siteCode: leading code, any case, with or without a descriptor', () => {
  assert.equal(siteCode('ABC02'), 'ABC02');
  assert.equal(siteCode('ABC02 - Cedar Point (WA)'), 'ABC02');
  assert.equal(siteCode('abc09'), 'ABC09');
  assert.equal(siteCode('QR49 - Harbor'), 'QR49');
  assert.equal(siteCode('XYZ01 Harbor Ridge (flat fee)'), 'XYZ01');
});

test('siteCode: a strict code later in the name, but never a stray token', () => {
  assert.equal(siteCode('Meridian XYZ91'), 'XYZ91');
  assert.equal(siteCode('Real Estate Dev-General FY26'), null);
  assert.equal(siteCode('DSM'), null);
  assert.equal(siteCode('Micro'), null);
  assert.equal(siteCode(''), null);
  assert.equal(siteCode(null), null);
});

test('narrativePrefix: bare code unless fixed fee with a descriptor', () => {
  assert.equal(narrativePrefix({ short_name: 'ABC02 - Cedar Point (WA)', fixed_fee: 0 }), '(ABC02)');
  assert.equal(narrativePrefix({ short_name: 'ABC89 - Water Development Agreement', fixed_fee: 1 }),
    '(ABC89 - Water Development Agreement)');
  assert.equal(narrativePrefix({ short_name: 'ABC89', fixed_fee: 1 }), '(ABC89)');
  assert.equal(narrativePrefix({ short_name: 'abc89 – Water Agreement', fixed_fee: 1 }),
    '(ABC89 - Water Agreement)');
  // a "(flat fee)" tag in the short name is bookkeeping, not a descriptor
  assert.equal(narrativePrefix({ short_name: 'XYZ01 Harbor Ridge (flat fee)', fixed_fee: 1 }),
    '(XYZ01 - Harbor Ridge)');
  assert.equal(narrativePrefix({ short_name: 'XYZ01 (Fixed Fee)', fixed_fee: 1 }), '(XYZ01)');
  assert.equal(narrativePrefix({ short_name: 'General FY26', fixed_fee: 1 }), null);
  assert.equal(narrativePrefix(null), null);
});

test('seedNarrative: explicit template wins; prefix never doubles', () => {
  assert.equal(seedNarrative({ prefix: '(ABC02)' }), '(ABC02)');
  assert.equal(seedNarrative({ prefix: '(ABC02)', draft: 'Call re easement.' }), '(ABC02) Call re easement.');
  assert.equal(seedNarrative({ prefix: '(ABC02)', draft: '(ABC02) Call re easement.' }),
    '(ABC02) Call re easement.');
  assert.equal(seedNarrative({ template: '(TEL)', prefix: '(ABC02)', draft: 'Call.' }), '(TEL) Call.');
  assert.equal(seedNarrative({ draft: 'Call.' }), 'Call.');
  assert.equal(seedNarrative({}), '');
});
