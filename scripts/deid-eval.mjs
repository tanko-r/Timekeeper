#!/usr/bin/env node
// De-identification eval: how well does a local model find the identifiers in
// a time narrative?
//
// The experiment. Your own database already knows most of the answer: clients,
// matters and matter_people are a dictionary of real identifiers. So we do not
// have to guess whether the model is right — a deterministic dictionary pass
// runs first, its hits are GROUND TRUTH, and the model is scored against it.
//
//   MISSED = a known identifier the model left in place   (a privilege leak)
//   EXTRA  = something the model flagged that the dictionary does not know
//            (a real find worth adding, OR a hallucination — only you can tell)
//
// Everything is kept for review: the raw model response verbatim, the parsed
// finds, and the REDACTED narrative each model would actually produce. That
// last one is the real product — judge the model on the text it leaves behind,
// not on a list of strings.
//
// Nothing leaves the box. The database is opened READ-ONLY, the model is the
// local Ollama, and all output goes to data/deid-eval/ (gitignored). The
// console prints aggregate counts only, so this is safe to run with an agent
// watching.
//
//   node scripts/deid-eval.mjs                            # configured model, all entries
//   node scripts/deid-eval.mjs --limit 25                 # quick smoke run
//   node scripts/deid-eval.mjs --model llama3.1:8b,qwen3.5:9b,qwen3.5:2b
//   node scripts/deid-eval.mjs --fresh                    # ignore the cache
//
// Results are cached per (model, entry, narrative text) in cache.jsonl, so a
// run over several thousand entries can be stopped and resumed, and adding a
// model only costs the new model.
//
// Output in data/deid-eval/:
//   report.html   browsable, filterable, model-vs-model side by side
//   review.csv    one row per entry per model — for spreadsheet review
//   results.jsonl one JSON object per entry per model — full fidelity
//   summary.json  the scoreboard

import Database from 'better-sqlite3';
import { writeFileSync, appendFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { loadConfig } from '../server/config.js';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const has = (name) => args.includes(`--${name}`);

const OUT_DIR = 'data/deid-eval';
const CACHE = `${OUT_DIR}/cache.jsonl`;
const LIMIT = Number(flag('limit', 0)) || 0;
const MAX_HTML = Number(flag('max-html', 600));
const URL = flag('url', 'http://127.0.0.1:11434');
// A model that does not fit in 8 GB of VRAM spills onto the CPU and gets slow
// rather than wrong, so the timeout is generous and adjustable.
const TIMEOUT_MS = Number(flag('timeout', 120)) * 1000;

mkdirSync(OUT_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// 1. Ground truth: the dictionary you already have.
// ---------------------------------------------------------------------------

const db = new Database(loadConfig().DB_PATH, { readonly: true });

const dictionary = [];
const addTerm = (text, kind) => {
  const t = String(text || '').trim();
  if (t.length < 3) return; // two characters or fewer is noise, not an identifier
  dictionary.push({ term: t, kind });
};

for (const r of db.prepare('select name from clients').all()) addTerm(r.name, 'client');
for (const r of db.prepare('select short_name, cm_number from matters').all()) {
  addTerm(r.short_name, 'matter');
  addTerm(r.cm_number, 'cm_number');
}
for (const r of db.prepare('select name from matter_people').all()) addTerm(r.name, 'person');

// Longest first, so "Acme Holdings LLC" is claimed before "Acme".
dictionary.sort((a, b) => b.term.length - a.term.length);

const PLACEHOLDER = {
  client: '[CLIENT]', matter: '[MATTER]', cm_number: '[CMNUM]',
  person: '[PERSON]', model: '[ENTITY]',
};

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// \b does not fire next to punctuation like "M." so we anchor on non-word
// boundaries at both ends instead.
const termRe = (term, flags = 'i') =>
  new RegExp(`(?<![\\w'’-])${escapeRe(term)}(?![\\w'’-])`, flags);

function dictionaryHits(narrative) {
  const hits = [];
  let remaining = narrative;
  for (const { term, kind } of dictionary) {
    if (!termRe(term).test(remaining)) continue;
    hits.push({ term, kind });
    // Blank the match so a shorter overlapping term does not double-count.
    remaining = remaining.replace(termRe(term, 'gi'), ' '.repeat(term.length));
  }
  return hits;
}

// The actual product: what the narrative looks like after redaction. Longest
// spans first so nested names collapse cleanly.
function redact(narrative, spans) {
  let out = narrative;
  const ordered = [...spans].sort((a, b) => b.term.length - a.term.length);
  for (const { term, kind } of ordered) {
    if (!term || term.length < 2) continue;
    try {
      out = out.replace(termRe(term, 'gi'), PLACEHOLDER[kind] || '[ENTITY]');
    } catch { /* a model can emit a string that will not compile — skip it */ }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 2. The model pass. Demonstrations, not rules — an 8B follows examples and
//    argues with instructions. House fictional names only.
// ---------------------------------------------------------------------------

const SYSTEM = `You extract identifying details from attorney time entries.

An identifying detail is anything that names a specific real party: a person, a
company, a property, a case number, a deal name. Generic role words (client,
opposing counsel, lender, the county) are NOT identifying.

Reply with JSON only, in this exact shape: {"found": ["...", "..."]}
If there is nothing identifying, reply {"found": []}`;

const SHOTS = [
  ['tc w/ JMS re Acme Holdings MSA indemnity carve-out',
   '{"found": ["JMS", "Acme Holdings"]}'],
  ['review title commitment; note exceptions; email to client',
   '{"found": []}'],
  ['draft response to city re Northwind Trading records request; call w/ M. Okonkwo',
   '{"found": ["Northwind Trading", "M. Okonkwo"]}'],
  ['prep for closing on 1420 Harbor St; conf w/ lender counsel',
   '{"found": ["1420 Harbor St"]}'],
];

function buildMessages(narrative) {
  const messages = [{ role: 'system', content: SYSTEM }];
  for (const [user, assistant] of SHOTS) {
    messages.push({ role: 'user', content: user });
    messages.push({ role: 'assistant', content: assistant });
  }
  messages.push({ role: 'user', content: narrative });
  return messages;
}

// Models disagree about the shape of a list item. llama returns bare strings;
// qwen returns {"type": "company", "value": "Acme Holdings"}. Both mean the
// same thing, and scoring a model down for its JSON taste would measure the
// wrong thing — so accept either and pull out the identifier.
function itemToString(v) {
  if (typeof v === 'string') return v.trim();
  if (v && typeof v === 'object') {
    for (const k of ['value', 'name', 'text', 'entity', 'identifier']) {
      if (typeof v[k] === 'string' && v[k].trim()) return v[k].trim();
    }
  }
  return '';
}

function parseFound(raw) {
  const text = String(raw || '');
  // Models wrap JSON in prose or fences often enough that we dig for the object.
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return { found: [], malformed: true };
  try {
    const obj = JSON.parse(match[0]);
    // Some models rename the key despite the demonstrations.
    const list = [obj.found, obj.identifiers, obj.entities, obj.items]
      .find((v) => Array.isArray(v)) || [];
    return { found: list.map(itemToString).filter(Boolean), malformed: false };
  } catch {
    return { found: [], malformed: true };
  }
}

// think:false matters more than it looks. qwen3.5 is a reasoning model: left
// alone it spends hundreds of tokens deliberating before answering, and on a
// box where a 9B does not fit in 8 GB of VRAM and runs 74% on the CPU, that
// turned an 11-second call into a 90-second timeout. Ollama accepts the flag
// on non-thinking models too, so it is safe to send unconditionally.
async function askModel(model, narrative) {
  const started = Date.now();
  const resp = await fetch(`${URL}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model, stream: false, format: 'json', think: false,
      options: { temperature: 0 },
      messages: buildMessages(narrative),
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`ollama ${resp.status} ${(await resp.text()).slice(0, 200)}`);
  const data = await resp.json();
  const raw = String((data.message && data.message.content) || '');
  return { raw, ...parseFound(raw), ms: Date.now() - started };
}

// ---------------------------------------------------------------------------
// 3. Scoring. A model string counts as catching a dictionary term when the
//    normalized forms overlap — "Smith" catching "M. Smith" is a catch, not a
//    miss, because either way the identifier gets redacted.
// ---------------------------------------------------------------------------

const norm = (s) => String(s).toLowerCase()
  .replace(/['’]s\b/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

const overlaps = (a, b) => {
  const x = norm(a); const y = norm(b);
  return Boolean(x) && Boolean(y) && (x === y || x.includes(y) || y.includes(x));
};

// ---------------------------------------------------------------------------
// 4. Cache, so several thousand entries can run overnight and resume.
// ---------------------------------------------------------------------------

const hash = (s) => createHash('sha1').update(s).digest('hex').slice(0, 12);
const cache = new Map();

if (!has('fresh') && existsSync(CACHE)) {
  for (const line of readFileSync(CACHE, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      cache.set(`${rec.model} ${rec.id} ${rec.h}`, rec);
    } catch { /* a torn last line from an interrupted run — ignore it */ }
  }
}

// ---------------------------------------------------------------------------
// 5. Run.
// ---------------------------------------------------------------------------

const rows = db.prepare(`
  select id, date, cm_id, narrative from entries
  where narrative is not null and length(trim(narrative)) > 2 and deleted_at is null
  order by id
`).all();

const entries = LIMIT ? rows.slice(0, LIMIT) : rows;

const cfgModel = (() => {
  try {
    const s = db.prepare("select value from settings where key = 'ai'").get();
    return s ? (JSON.parse(s.value).model || null) : null;
  } catch { return null; }
})();

const models = flag('model', cfgModel || 'llama3.1:8b')
  .split(',').map((m) => m.trim()).filter(Boolean);

console.log(`entries: ${entries.length}   dictionary terms: ${dictionary.length}   models: ${models.join(', ')}`);
console.log(`cache: ${cache.size} prior results${has('fresh') ? ' (ignored, --fresh)' : ''}`);
console.log('(no narrative text is printed to this console — see the HTML report)\n');

// byEntry[id][model] = record, so the report can show models side by side.
const byEntry = new Map();
const results = {};

for (const model of models) {
  const perEntry = [];
  let done = 0; let fromCache = 0; const started = Date.now();

  for (const row of entries) {
    const key = `${model} ${row.id} ${hash(row.narrative)}`;
    let out = cache.get(key);
    if (out) {
      fromCache += 1;
    } else {
      try {
        out = await askModel(model, row.narrative);
      } catch (err) {
        out = { raw: '', found: [], malformed: true, ms: 0, error: String(err.message || err) };
      }
      const rec = { model, id: row.id, h: hash(row.narrative), ...out };
      appendFileSync(CACHE, `${JSON.stringify(rec)}\n`);
      out = rec;
    }

    const dictHits = dictionaryHits(row.narrative);
    const modelHits = out.found || [];
    const missed = dictHits.filter((d) => !modelHits.some((m) => overlaps(d.term, m)));
    const extras = modelHits.filter((m) => !dictHits.some((d) => overlaps(d.term, m)));

    // Two redactions: what the model alone would do, and what the model plus
    // your dictionary would do. The second is the one you would ship.
    const modelOnly = redact(row.narrative, modelHits.map((t) => ({ term: t, kind: 'model' })));
    const combined = redact(row.narrative, [
      ...dictHits,
      ...extras.map((t) => ({ term: t, kind: 'model' })),
    ]);

    const rec = {
      id: row.id, date: row.date, cm_id: row.cm_id, model,
      narrative: row.narrative,
      raw: out.raw || '',
      dictHits, modelHits, missed, extras,
      redactedModelOnly: modelOnly,
      redactedCombined: combined,
      malformed: Boolean(out.malformed), error: out.error || null, ms: out.ms || 0,
    };
    perEntry.push(rec);
    if (!byEntry.has(row.id)) byEntry.set(row.id, {});
    byEntry.get(row.id)[model] = rec;

    done += 1;
    if (done % 25 === 0 || done === entries.length) {
      const rate = (Date.now() - started) / done;
      const eta = Math.round((rate * (entries.length - done)) / 1000);
      process.stdout.write(`\r  ${model}: ${done}/${entries.length}  (cached ${fromCache})  eta ${eta}s   `);
    }
  }
  process.stdout.write('\n');

  const totalDict = perEntry.reduce((n, e) => n + e.dictHits.length, 0);
  const totalMissed = perEntry.reduce((n, e) => n + e.missed.length, 0);
  const ms = perEntry.map((e) => e.ms).filter(Boolean).sort((a, b) => a - b);

  results[model] = {
    entries: perEntry.length,
    dictTerms: totalDict,
    recall: totalDict ? (totalDict - totalMissed) / totalDict : null,
    missed: totalMissed,
    leakyEntries: perEntry.filter((e) => e.missed.length > 0).length,
    extras: perEntry.reduce((n, e) => n + e.extras.length, 0),
    entriesWithExtras: perEntry.filter((e) => e.extras.length > 0).length,
    malformed: perEntry.filter((e) => e.malformed && !e.error).length,
    // Kept separate from malformed. A timeout is an infrastructure failure and
    // says nothing about the model's accuracy; folding the two together once
    // hid a model that was timing out on 2 calls in 3.
    errors: perEntry.filter((e) => e.error).length,
    medianMs: ms.length ? ms[Math.floor(ms.length / 2)] : 0,
    p90Ms: ms.length ? ms[Math.floor(ms.length * 0.9)] : 0,
    perEntry,
  };
}

// ---------------------------------------------------------------------------
// 6. Output. Full text to disk only.
// ---------------------------------------------------------------------------

const esc = (s) => String(s).replace(/[&<>"]/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// --- results.jsonl : full fidelity, one object per entry per model ----------
const jsonl = [];
for (const m of models) for (const e of results[m].perEntry) jsonl.push(JSON.stringify(e));
writeFileSync(`${OUT_DIR}/results.jsonl`, `${jsonl.join('\n')}\n`, 'utf8');

// --- review.csv : for spreadsheet review ------------------------------------
const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
const csv = [['entry_id', 'date', 'model', 'narrative', 'redacted_combined',
  'redacted_model_only', 'dict_terms', 'model_found', 'missed', 'extras',
  'raw_response', 'ms'].join(',')];
for (const m of models) {
  for (const e of results[m].perEntry) {
    csv.push([
      e.id, e.date, m, q(e.narrative), q(e.redactedCombined), q(e.redactedModelOnly),
      q(e.dictHits.map((d) => `${d.term} (${d.kind})`).join(' | ')),
      q(e.modelHits.join(' | ')), q(e.missed.map((d) => d.term).join(' | ')),
      q(e.extras.join(' | ')), q(e.raw.replace(/\s+/g, ' ')), e.ms,
    ].join(','));
  }
}
writeFileSync(`${OUT_DIR}/review.csv`, `${csv.join('\n')}\n`, 'utf8');

// --- summary.json -----------------------------------------------------------
const summary = {};
for (const m of models) { const { perEntry, ...rest } = results[m]; summary[m] = rest; }
writeFileSync(`${OUT_DIR}/summary.json`, JSON.stringify(summary, null, 2), 'utf8');

// --- report.html : every entry, filterable, models side by side -------------
const ids = [...byEntry.keys()];
const shown = ids.slice(0, MAX_HTML);
const truncated = ids.length - shown.length;

const summaryRows = models.map((m) => {
  const r = results[m];
  const pct = r.recall === null ? '—' : `${(r.recall * 100).toFixed(1)}%`;
  return `<tr><td><code>${esc(m)}</code></td><td class="num">${pct}</td>
    <td class="num ${r.missed ? 'bad' : 'good'}">${r.missed}</td>
    <td class="num ${r.leakyEntries ? 'bad' : 'good'}">${r.leakyEntries}</td>
    <td class="num">${r.extras}</td><td class="num">${r.malformed}</td>
    <td class="num ${r.errors ? 'bad' : 'good'}">${r.errors}</td>
    <td class="num">${r.medianMs} ms</td><td class="num">${r.p90Ms} ms</td></tr>`;
}).join('\n');

const entryBlocks = shown.map((id) => {
  const perModel = byEntry.get(id);
  const any = models.map((m) => perModel[m]).find(Boolean);
  const leak = models.some((m) => perModel[m] && perModel[m].missed.length);
  const extra = models.some((m) => perModel[m] && perModel[m].extras.length);
  const bad = models.some((m) => perModel[m] && perModel[m].malformed);
  const classes = ['entry',
    leak ? 'has-leak' : '', extra ? 'has-extra' : '', bad ? 'has-bad' : '',
    (!leak && !extra && !bad) ? 'clean' : ''].filter(Boolean).join(' ');

  const cols = models.map((m) => {
    const e = perModel[m];
    if (!e) return `<td class="muted">—</td>`;
    return `<td>
      <div class="tags">
        ${e.missed.map((d) => `<span class="tag bad">MISSED ${esc(d.term)} <i>${d.kind}</i></span>`).join(' ')}
        ${e.extras.map((x) => `<span class="tag warn">EXTRA ${esc(x)}</span>`).join(' ')}
        ${e.malformed ? '<span class="tag bad">BAD JSON</span>' : ''}
        ${(!e.missed.length && !e.extras.length && !e.malformed) ? '<span class="tag good">clean</span>' : ''}
      </div>
      <div class="red">${esc(e.redactedCombined)}</div>
      <details><summary>raw · ${e.ms}ms</summary><pre>${esc(e.raw || '(empty)')}</pre>
        <div class="sub">model-only redaction:</div><div class="red">${esc(e.redactedModelOnly)}</div>
      </details></td>`;
  }).join('\n');

  return `<div class="${classes}">
    <div class="meta">#${id} · ${esc(any.date || '')}</div>
    <div class="narr">${esc(any.narrative)}</div>
    <table class="cmp"><tr>${models.map((m) => `<th>${esc(m)}</th>`).join('')}</tr><tr>${cols}</tr></table>
  </div>`;
}).join('\n');

writeFileSync(`${OUT_DIR}/report.html`, `<!doctype html><meta charset="utf-8">
<title>De-identification eval</title>
<style>
 body{font:15px/1.55 -apple-system,system-ui,sans-serif;max-width:1200px;margin:2rem auto;padding:0 1rem;color:#1a1a1a}
 table{border-collapse:collapse;width:100%;margin:1rem 0}
 th,td{border:1px solid #ddd;padding:.45rem .6rem;text-align:left;vertical-align:top}
 th{background:#f4f4f4;font-size:13px}
 .num{text-align:right;font-variant-numeric:tabular-nums}
 .good{color:#0a7c2f}.bad{color:#c02626}.warn{color:#a86400}.muted{color:#999}
 .entry{border-left:3px solid #ddd;padding:.5rem .8rem;margin:.7rem 0;background:#fafafa}
 .entry.has-leak{border-left-color:#c02626;background:#fff5f5}
 .entry.has-extra{border-left-color:#d99400}
 .entry.has-leak.has-extra{border-left-color:#c02626}
 .meta{font-size:12px;color:#666}
 .narr{font-family:ui-monospace,Menlo,monospace;font-size:13px;white-space:pre-wrap;margin:.35rem 0;font-weight:600}
 .red{font-family:ui-monospace,Menlo,monospace;font-size:13px;white-space:pre-wrap;color:#0a5c8a;margin:.25rem 0}
 .sub{font-size:11px;color:#888;margin-top:.4rem}
 .cmp{margin:.4rem 0 0}.cmp td{background:#fff;width:${Math.floor(100 / Math.max(models.length, 1))}%}
 .tag{display:inline-block;font-size:11px;padding:.05rem .35rem;border:1px solid currentColor;border-radius:3px;margin:.1rem .15rem .1rem 0}
 .note{font-size:13px;color:#555}
 code{background:#eee;padding:.1rem .3rem;border-radius:3px}
 pre{background:#f0f0f0;padding:.4rem;font-size:12px;overflow-x:auto;white-space:pre-wrap}
 details summary{font-size:12px;color:#666;cursor:pointer}
 #bar{position:sticky;top:0;background:#fff;padding:.6rem 0;border-bottom:1px solid #ddd;z-index:9}
 button{font:13px system-ui;padding:.3rem .7rem;margin-right:.3rem;border:1px solid #bbb;background:#fff;border-radius:4px;cursor:pointer}
 button.on{background:#1a1a1a;color:#fff;border-color:#1a1a1a}
</style>
<h1>De-identification eval</h1>
<p class="note">Ground truth is your own database: ${dictionary.length} known terms from
<code>clients</code>, <code>matters</code> and <code>matter_people</code>.
Recall is measured against identifiers we <i>know</i> are in the text.
<b>Bold line</b> = original narrative. <span style="color:#0a5c8a">Blue line</span> = redacted result
(dictionary + that model's extra finds). Open <i>raw</i> for the verbatim model response.
This file is local and gitignored, and it contains real client text.</p>
<table>
 <tr><th>model</th><th>recall</th><th>missed</th><th>leaky entries</th><th>extras</th><th>bad JSON</th><th>errors</th><th>median</th><th>p90</th></tr>
 ${summaryRows}
</table>
<div id="bar">
 <button class="on" data-f="all">all (${shown.length})</button>
 <button data-f="has-leak">leaks</button>
 <button data-f="has-extra">extras</button>
 <button data-f="has-bad">bad JSON</button>
 <button data-f="clean">clean</button>
</div>
${truncated > 0 ? `<p class="note warn"><b>${truncated} further entries are not shown in this HTML page</b>
 (capped at ${MAX_HTML} for browser performance). They are all present in
 <code>results.jsonl</code> and <code>review.csv</code>. Raise the cap with <code>--max-html</code>.</p>` : ''}
${entryBlocks}
<script>
 const btns = [...document.querySelectorAll('#bar button')];
 const items = [...document.querySelectorAll('.entry')];
 btns.forEach(b => b.onclick = () => {
   btns.forEach(x => x.classList.toggle('on', x === b));
   const f = b.dataset.f;
   items.forEach(el => { el.style.display = (f === 'all' || el.classList.contains(f)) ? '' : 'none'; });
 });
</script>
`, 'utf8');

console.log('\n  model                    recall   missed  leaky  extras  bad-json  errors  median   p90');
for (const m of models) {
  const r = results[m];
  const pct = r.recall === null ? '  —  ' : `${(r.recall * 100).toFixed(1)}%`.padStart(6);
  console.log(`  ${m.padEnd(24)} ${pct}  ${String(r.missed).padStart(6)}  ${String(r.leakyEntries).padStart(5)}  ${String(r.extras).padStart(6)}  ${String(r.malformed).padStart(8)}  ${String(r.errors).padStart(6)}  ${String(r.medianMs).padStart(5)}ms  ${String(r.p90Ms).padStart(5)}ms`);
  if (r.errors) console.log(`    ${r.errors} call(s) failed — raise --timeout, or the model may not fit in VRAM`);
}
console.log(`\nreview these (real client text — local only):
  ${OUT_DIR}/report.html    browsable, filterable, models side by side
  ${OUT_DIR}/review.csv     spreadsheet review
  ${OUT_DIR}/results.jsonl  full fidelity`);
