#!/usr/bin/env node
// Vocabulary review: the pass that makes de-identification checkable at scale.
//
// You cannot read several thousand narratives to confirm nothing leaked. But
// you do not have to. Time entries are formulaic and repetitive, so the number
// of DISTINCT capitalized strings in them is far smaller than the number of
// entries — a few hundred, not a few thousand. Review the vocabulary once and
// you have reviewed the corpus.
//
// The pipeline:
//   1. redact everything the dictionary knows (clients, matters, people)
//   2. from what survives, pull every candidate identifier
//   3. drop anything on the allowlist (words you have already cleared)
//   4. show what is left, most frequent first
//
// You mark each survivor safe or unsafe once. Cleared words go in the
// allowlist and never come back, so a later import of 5,000 more entries only
// shows you genuinely NEW vocabulary. That is the property that scales.
//
// Read-only on the database. All output is local and gitignored.
//
//   node scripts/deid-vocab.mjs                  # review report
//   node scripts/deid-vocab.mjs --min 2          # only words seen twice or more
//
// Files in data/deid-eval/:
//   vocab.html   the checklist — open this
//   vocab.csv    same, for a spreadsheet
//   allowlist.txt  words you have cleared (edit by hand; one per line, # comments)

import Database from 'better-sqlite3';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { loadConfig } from '../server/config.js';

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

const OUT_DIR = 'data/deid-eval';
const ALLOWLIST = `${OUT_DIR}/allowlist.txt`;
const MIN_COUNT = Number(flag('min', 1));

mkdirSync(OUT_DIR, { recursive: true });

const db = new Database(loadConfig().DB_PATH, { readonly: true });

// ---------------------------------------------------------------------------
// 1. The dictionary, same ground truth the model eval uses.
// ---------------------------------------------------------------------------

const dictionary = [];
const add = (t, kind) => { const s = String(t || '').trim(); if (s.length >= 3) dictionary.push({ term: s, kind }); };
for (const r of db.prepare('select name from clients').all()) add(r.name, 'client');
for (const r of db.prepare('select short_name, cm_number from matters').all()) { add(r.short_name, 'matter'); add(r.cm_number, 'cm_number'); }
for (const r of db.prepare('select name from matter_people').all()) add(r.name, 'person');
dictionary.sort((a, b) => b.term.length - a.term.length);

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const termRe = (t, f = 'gi') => new RegExp(`(?<![\\w'’-])${escapeRe(t)}(?![\\w'’-])`, f);

function stripKnown(text) {
  let out = text;
  for (const { term } of dictionary) out = out.replace(termRe(term), ' ');
  return out;
}

// ---------------------------------------------------------------------------
// 2. Candidate identifiers in what survives.
// ---------------------------------------------------------------------------

// Seed allowlist: vocabulary that is capitalized in a time entry but names
// nobody. Everything here is generic legal / calendar / document language.
const SEED_ALLOW = `
# Seeded by scripts/deid-vocab.mjs. One entry per line, case-insensitive.
# Anything listed here is treated as NOT identifying and hidden from review.
# Add to it as you clear words; delete a line to see that word again.
Monday Tuesday Wednesday Thursday Friday Saturday Sunday
January February March April May June July August September October November December
Jan Feb Mar Apr Jun Jul Aug Sep Sept Oct Nov Dec
MSA LOI PSA NDA LLC LLP INC CORP LTD PC PLLC
Zoom Teams Outlook Word Excel PDF DocuSign
TC VM EM RE CC BCC FYI EOD ASAP
Draft Review Revise Revised Prepare Prep Call Email Letter Memo Meeting Conference
Agreement Amendment Addendum Exhibit Schedule Appendix Lease Deed Note Title Escrow
Complaint Answer Motion Discovery Deposition Subpoena Interrogatories
Court Judge Clerk County City State Federal
Client Counsel Opposing Lender Borrower Landlord Tenant Seller Buyer Broker
`.trim();

if (!existsSync(ALLOWLIST)) writeFileSync(ALLOWLIST, `${SEED_ALLOW}\n`, 'utf8');

const allow = new Set();
for (const raw of readFileSync(ALLOWLIST, 'utf8').split('\n')) {
  const line = raw.split('#')[0].trim();
  if (!line) continue;
  for (const w of line.split(/\s+/)) if (w) allow.add(w.toLowerCase());
}

// Three families of candidate, because they fail differently:
//   NAME     capitalized word or run of them  ("Northwind Trading")
//   INITIALS 2-4 capitals — how attorneys name each other, and the thing
//            off-the-shelf NER reliably misses
//   NUMERIC  street addresses, case numbers, anything digit-led that is not
//            a time or a plain year
const PATTERNS = [
  ['name', /\b(?:[A-Z][a-z][\w'’-]*)(?:\s+(?:[A-Z]\.|[A-Z][a-z][\w'’-]*)){0,3}\b/g],
  ['initials', /\b[A-Z]{2,4}\b/g],
  ['numeric', /\b\d{1,6}[-\/]?\d{0,6}\s+[A-Z][a-z]+(?:\s+(?:St|Ave|Rd|Blvd|Dr|Ln|Ct|Way|Pl)\b\.?)?|\b(?:No|Case|Docket)\.?\s*[\w-]+\b/g],
];

const seen = new Map(); // lowercased -> {display, kind, count, entries:Set}

const rows = db.prepare(`
  select id, narrative from entries
  where narrative is not null and length(trim(narrative)) > 2 and deleted_at is null
`).all();

for (const row of rows) {
  const residue = stripKnown(row.narrative);
  for (const [kind, re] of PATTERNS) {
    for (const m of residue.matchAll(re)) {
      const display = m[0].trim().replace(/[.,;:]+$/, '');
      if (display.length < 2) continue;
      const key = display.toLowerCase();
      if (allow.has(key)) continue;
      // A multi-word capture is only allowlisted when every word in it is.
      if (display.includes(' ') && display.split(/\s+/).every((w) => allow.has(w.toLowerCase()))) continue;
      if (!seen.has(key)) seen.set(key, { display, kind, count: 0, entries: new Set() });
      const rec = seen.get(key);
      rec.count += 1;
      rec.entries.add(row.id);
    }
  }
}

const candidates = [...seen.values()]
  .filter((c) => c.count >= MIN_COUNT)
  .sort((a, b) => b.count - a.count || a.display.localeCompare(b.display));

// ---------------------------------------------------------------------------
// 3. Report.
// ---------------------------------------------------------------------------

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;

writeFileSync(`${OUT_DIR}/vocab.csv`,
  `${['candidate', 'kind', 'occurrences', 'entries', 'example_entry_ids', 'verdict'].join(',')}\n${
    candidates.map((c) => [q(c.display), c.kind, c.count, c.entries.size,
      q([...c.entries].slice(0, 8).join(' ')), ''].join(',')).join('\n')}\n`, 'utf8');

const byKind = (k) => candidates.filter((c) => c.kind === k);
const section = (k, title, blurb) => {
  const list = byKind(k);
  if (!list.length) return '';
  return `<h2>${title} <span class="muted">(${list.length})</span></h2><p class="note">${blurb}</p>
  <table><tr><th></th><th>candidate</th><th class="num">seen</th><th class="num">entries</th><th>example entry ids</th></tr>
  ${list.map((c) => `<tr><td><input type="checkbox" class="cb" data-w="${esc(c.display)}"></td>
    <td><code>${esc(c.display)}</code></td><td class="num">${c.count}</td><td class="num">${c.entries.size}</td>
    <td class="ids">${[...c.entries].slice(0, 10).join(', ')}${c.entries.size > 10 ? ' …' : ''}</td></tr>`).join('\n')}
  </table>`;
};

writeFileSync(`${OUT_DIR}/vocab.html`, `<!doctype html><meta charset="utf-8">
<title>Vocabulary review</title>
<style>
 body{font:15px/1.55 -apple-system,system-ui,sans-serif;max-width:900px;margin:2rem auto;padding:0 1rem}
 table{border-collapse:collapse;width:100%;margin:.6rem 0}
 th,td{border:1px solid #ddd;padding:.35rem .55rem;text-align:left}
 th{background:#f4f4f4;font-size:13px}
 .num{text-align:right;font-variant-numeric:tabular-nums;width:5rem}
 .ids{font-size:11px;color:#777}
 .muted{color:#999;font-weight:400}
 .note{font-size:13px;color:#555;margin:.2rem 0 .4rem}
 code{background:#eee;padding:.1rem .3rem;border-radius:3px}
 #out{position:sticky;bottom:0;background:#fff;border-top:2px solid #1a1a1a;padding:.7rem 0}
 textarea{width:100%;height:7rem;font:12px ui-monospace,Menlo,monospace}
 button{font:13px system-ui;padding:.35rem .8rem;border:1px solid #1a1a1a;background:#1a1a1a;color:#fff;border-radius:4px;cursor:pointer}
</style>
<h1>Vocabulary review</h1>
<p class="note">${rows.length} narratives contain <b>${candidates.length} distinct candidate identifiers</b>
that your dictionary does not already know. Reviewing this list is equivalent to
reviewing every entry, because these are the only strings that could still identify anyone.</p>
<p class="note"><b>Tick a box for anything that is NOT identifying.</b> Copy the generated block at the
bottom into <code>data/deid-eval/allowlist.txt</code>. Cleared words never appear again, so importing
5,000 more entries will only show you genuinely new vocabulary.</p>

${section('name', 'Names and organizations', 'Capitalized words the dictionary did not claim. Most real leaks live here.')}
${section('initials', 'Initials', 'Two to four capitals. This is how attorneys refer to each other, and the family stock NER models miss most often. Many will be harmless abbreviations.')}
${section('numeric', 'Addresses and numbers', 'Street addresses, case and docket numbers.')}

<div id="out">
 <button onclick="gen()">Generate allowlist block</button>
 <span class="muted" id="n">0 ticked</span>
 <textarea id="ta" placeholder="tick boxes, then press the button"></textarea>
</div>
<script>
 const boxes=[...document.querySelectorAll('.cb')];
 boxes.forEach(b=>b.onchange=()=>{document.getElementById('n').textContent=boxes.filter(x=>x.checked).length+' ticked'});
 function gen(){
   const w=boxes.filter(b=>b.checked).map(b=>b.dataset.w);
   document.getElementById('ta').value='# cleared '+new Date().toISOString().slice(0,10)+'\\n'+w.join('\\n');
 }
</script>
`, 'utf8');

console.log(`narratives scanned:      ${rows.length}`);
console.log(`dictionary terms:        ${dictionary.length}`);
console.log(`allowlisted words:       ${allow.size}`);
console.log(`candidates to review:    ${candidates.length}`);
for (const k of ['name', 'initials', 'numeric']) {
  console.log(`  ${k.padEnd(10)} ${String(byKind(k).length).padStart(4)}`);
}
console.log(`\n  ${OUT_DIR}/vocab.html   the checklist — open this`);
console.log(`  ${OUT_DIR}/vocab.csv    spreadsheet version`);
console.log(`  ${ALLOWLIST}  edit to clear words permanently`);
