// Blind A/B pairing for design review.
//
// Copies our screenshot and a reference screenshot into a pair directory as
// A.png and B.png, in an order derived from a hash of the file names — stable,
// reproducible, and not guessable from the prompt. The mapping is written to
// .key.json, which the judging agent is told not to read.
//
// Usage:
//   node scripts/abpair.mjs --ours shots/wave1/dashboard.desktop.light.png \
//                           --ref  shots/refs/mercury-home.desktop.0.png \
//                           --out  shots/ab/dashboard-vs-mercury
import { mkdirSync, copyFileSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { createHash } from 'node:crypto';

const arg = (n) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > -1 ? process.argv[i + 1] : null;
};

const ours = arg('ours');
const ref = arg('ref');
const out = arg('out');
if (!ours || !ref || !out) {
  console.error('usage: abpair.mjs --ours <png> --ref <png> --out <dir>');
  process.exit(1);
}

mkdirSync(out, { recursive: true });
const h = createHash('sha256').update(basename(ours) + basename(ref)).digest()[0];
const oursIsA = (h & 1) === 0;

copyFileSync(ours, join(out, oursIsA ? 'A.png' : 'B.png'));
copyFileSync(ref, join(out, oursIsA ? 'B.png' : 'A.png'));
writeFileSync(join(out, '.key.json'), JSON.stringify({
  A: oursIsA ? 'ours' : 'reference',
  B: oursIsA ? 'reference' : 'ours',
  ours, ref,
}, null, 2));

console.log(out);
