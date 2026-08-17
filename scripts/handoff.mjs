#!/usr/bin/env node
// Cheap, objective state for a cold session.
//
// THE PROBLEM THIS SOLVES. When a session's context goes cold, the next one
// spends a dozen expensive tool calls re-deriving things that are simply facts:
// what branch, what is uncommitted, whether the suite is green, what is
// half-built. That is paid for in usage, every time, and it is the same answer
// every time.
//
// So the facts are printed by a script instead of rediscovered by a model.
// Read docs/ui/HANDOFF.md for the JUDGEMENT — what is being built and why, and
// the question waiting for the owner — and run this for the STATE.
//
//   node scripts/handoff.mjs           fast; no test run
//   node scripts/handoff.mjs --test    also runs the suite (~50s) and records it
//
// The last measured test result is cached in data/.handoff.json (gitignored),
// with the commit it was measured at, so a stale number is visibly stale
// instead of quietly wrong. A count quoted without the commit it was measured
// at is not evidence — this project has had two counts in its own docs that
// were arithmetic rather than measurement.
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = join(ROOT, 'data', '.handoff.json');
const RUN_TESTS = process.argv.includes('--test');

const sh = (cmd, fallback = '') => {
  try {
    return execSync(cmd, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return fallback; }
};

const line = (s = '') => process.stdout.write(`${s}\n`);
const rule = (t) => { line(); line(`── ${t} ${'─'.repeat(Math.max(0, 66 - t.length))}`); };

const head = sh('git rev-parse --short HEAD', '(no git)');

rule('WHERE');
line(`cwd      ${ROOT}`);
line(`branch   ${sh('git rev-parse --abbrev-ref HEAD', '?')}`);
line(`head     ${head}  ${sh('git log -1 --pretty=%s')}`);
const tracking = sh('git status -sb --porcelain=v1 | head -1');
line(`remote   ${tracking || '(none)'}`);

rule('WORKING TREE');
const status = sh('git status --short');
if (!status) {
  line('clean');
} else {
  line(status);
  line();
  line(`${status.split('\n').length} path(s) uncommitted — check docs/ui/HANDOFF.md §4 before assuming they are junk`);
}

rule('RECENT WORK');
line(sh('git log --oneline -8'));

rule('TESTS');
let cached = null;
if (existsSync(CACHE)) { try { cached = JSON.parse(readFileSync(CACHE, 'utf8')); } catch { /* ignore */ } }

if (RUN_TESTS) {
  line('running npm test …');
  let out = '';
  try {
    out = execSync('npm test', { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) { out = `${e.stdout || ''}${e.stderr || ''}`; }
  const num = (k) => {
    const m = out.match(new RegExp(`^\\u2139 ${k} (\\d+)`, 'm'));
    return m ? Number(m[1]) : null;
  };
  const rec = {
    tests: num('tests'), pass: num('pass'), fail: num('fail'), skipped: num('skipped'),
    commit: head, dirty: !!status,
  };
  try {
    mkdirSync(dirname(CACHE), { recursive: true });
    writeFileSync(CACHE, JSON.stringify(rec, null, 2));
  } catch { /* data/ may not exist in a checkout; the print below still works */ }
  cached = rec;
  if (rec.fail) {
    const failing = [...out.matchAll(/^✖ (.+?) \(/gm)].map((m) => m[1]);
    line(`FAILING (${rec.fail}):`);
    for (const f of [...new Set(failing)].slice(0, 12)) line(`  - ${f}`);
  }
}

if (cached) {
  const stale = cached.commit !== head;
  line(`${cached.pass}/${cached.tests} pass · ${cached.fail} fail${cached.skipped ? ` · ${cached.skipped} skipped` : ''}`);
  line(`measured at ${cached.commit}${cached.dirty ? ' (with a dirty tree)' : ''}${stale ? '  ⚠ STALE — HEAD has moved since; re-run with --test' : ''}`);
} else {
  line('no measurement recorded. Run: node scripts/handoff.mjs --test');
}

rule('LIVE-DATA TRIPWIRE');
// The owner's rule: "Microsoft" in a Timekeeper database means it is the LIVE
// one, with real client names in it. Counted, never printed — the whole point
// is that its contents do not end up in a transcript.
const dbPath = join(ROOT, 'data', 'timekeeper.db');
if (!existsSync(dbPath)) {
  line('data/timekeeper.db  absent — nothing to check');
} else {
  try {
    const { default: Database } = await import('better-sqlite3');
    const db = new Database(dbPath, { readonly: true });
    const hits = ['matters:short_name', 'clients:name', 'timers:name', 'entries:narrative']
      .reduce((a, spec) => {
        const [t, c] = spec.split(':');
        try {
          return a + db.prepare(
            `SELECT COUNT(*) n FROM ${t} WHERE lower(COALESCE(${c},'')) LIKE '%microsoft%'`).get().n;
        } catch { return a; }
      }, 0);
    const timers = (() => { try { return db.prepare('SELECT COUNT(*) n FROM timers').get().n; } catch { return '?'; } })();
    db.close();
    line(hits > 0
      ? `⚠  LIVE DATA (${hits} tripwire match(es), ${timers} timers). Do NOT read, dump or screenshot data/.`
      : `no tripwire match (${timers} timers) — but treat data/ as live unless you know otherwise.`);
  } catch (e) { line(`could not check: ${e.message}`); }
}

rule('READ NEXT');
line('1. docs/ui/HANDOFF.md        the open question, and what is in flight');
line('2. docs/ui/BOARD-BUILD-SCOPE.md   what is being built, and what is deferred');
line('3. docs/ui/STATUS.md         standing owner rules + the stage tracker');
line();
line('REFERENCE ONLY — grep, never read start to finish:');
line('   docs/ui/TIMERBOARD-SPEC.md (3.3k lines) · docs/ui/TIMERBOARD-CRITIQUES.md');
line();
