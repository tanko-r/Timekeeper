process.env.TZ = 'America/Los_Angeles';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatTimEntries } from '../server/lib/tim.js';

const CFG = { email: 'TIMEKEEPER@EXAMPLE.COM', timekeeperId: '1001', u2: 'GEN01' };
const FIXED = { rng: () => 0.5, uuid: () => 'fixed-ref-1' };

function entry(overrides = {}) {
  return {
    id: 42,
    date: '2026-07-06',
    total: 1.5,
    narrative: 'Review lease (1.2); draft email to landlord (0.3).',
    finalized_at: '2026-07-07T04:14:30.000Z', // 9:14:30 PM PDT on 7/6
    cm: { cm_number: '100001-000012', short_name: 'Acme lease' },
    ...overrides,
  };
}

// Dates are zero-padded (07/06/2026): verified against Intapp's real importer
// 2026-07-10 — an unpadded work date is silently IGNORED (the entry lands on
// whatever day is open in the client); a padded one imports to the right day.
test('formats a .TIM line with the exact prototype field order and values', () => {
  const out = formatTimEntries([entry()], CFG, FIXED);
  const expected = [
    'am=5400', 'ar=345000000', 'billed=N', 'billing=N', 'cl=100001',
    'closed=N', 'co=N', 'createdintimesaver=Y', 'del=N',
    'ed=07/06/2026 9:14:30 PM', 'ex=N', 'f=TIME',
    'lmb=TIMEKEEPER@EXAMPLE.COM', 'ma=100001-000012',
    'md=07/06/2026 9:14:30 PM',
    'na=Review lease (1.2); draft email to landlord (0.3).',
    'op=TIMEKEEPER@EXAMPLE.COM', 'originapplication=DTE Axiom',
    're=N', 'ref=fixed-ref-1', 'releasable=Y', 'shortref=7450000',
    'ss=ii', 'st=Ready to be closed', 'tk=1001', 'u2=GEN01',
    'unconver=N', 'version=9.10.39.5', 'wd=07/06/2026 12:00:00 AM',
  ].join('|');
  assert.equal(out, expected);
});

test('multiple entries → one line each, newline-joined', () => {
  const out = formatTimEntries([entry(), entry({ id: 43 })], CFG, FIXED);
  assert.equal(out.split('\n').length, 2);
});

test('pipes in narratives are sanitized so the format cannot break', () => {
  const out = formatTimEntries([entry({ narrative: 'call re: A|B split' })], CFG, FIXED);
  assert.ok(out.includes('na=call re: A/B split'));
  assert.equal(out.split('|').length, 29, 'field count stays fixed');
});

test('midnight and noon hours format as 12', () => {
  const midnight = formatTimEntries([entry({ finalized_at: '2026-07-06T07:05:09.000Z' })], CFG, FIXED); // 12:05:09 AM PDT
  assert.ok(midnight.includes('ed=07/06/2026 12:05:09 AM'), midnight);
  const noon = formatTimEntries([entry({ finalized_at: '2026-07-06T19:00:00.000Z' })], CFG, FIXED); // 12:00:00 PM PDT
  assert.ok(noon.includes('ed=07/06/2026 12:00:00 PM'), noon);
});
