#!/usr/bin/env node
// One-off importer: Intapp "My Released Time" .xlsx export → finalized,
// already-exported entries, so the phrasebook / people roster / matter
// recency start with real history instead of an empty DB.
//
//   node scripts/import-intapp-history.mjs "intapp export.xls"           # dry run
//   node scripts/import-intapp-history.mjs "intapp export.xls" --apply   # write
//
// Dry run prints the full plan and touches nothing. Idempotent: a re-run
// skips rows whose (date, matter, narrative) already exist. Stop the
// timekeeper service before --apply (better-sqlite3 WAL tolerates a second
// writer, but don't tempt it).

import { execFileSync } from 'node:child_process';
import { loadConfig } from '../server/config.js';
import { openDb, nowIso } from '../server/db.js';
import { planIntappImport } from '../server/lib/intappimport.js';
import { rebuildMatterPeople } from '../server/routes/entries.js';

// ---------- minimal .xlsx reader (sheet 1, inline via system unzip) ----------

function unesc(s) {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function readZipEntry(xlsxPath, name) {
  return execFileSync('unzip', ['-p', xlsxPath, name], { maxBuffer: 64 * 1024 * 1024 }).toString('utf8');
}

// A shared string <si> may hold one <t> or several rich-text runs; concat all.
function sharedStrings(xml) {
  return [...xml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map(([, si]) =>
    [...si.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((t) => unesc(t[1])).join(''));
}

function sheetRows(xml, strings) {
  return [...xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)].map(([, rowXml]) => {
    const cells = {};
    for (const [, attrs, inner = ''] of rowXml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attr = Object.fromEntries([...attrs.matchAll(/(\w+)="([^"]*)"/g)].map((a) => [a[1], a[2]]));
      const col = attr.r.replace(/\d+/g, '');
      const v = /<v>([\s\S]*?)<\/v>/.exec(inner);
      cells[col] = attr.t === 's' ? strings[Number(v?.[1])] ?? '' : unesc(v?.[1] ?? '');
    }
    return cells;
  });
}

// ---------- main ----------

const [xlsxPath, ...flags] = process.argv.slice(2);
const apply = flags.includes('--apply');
if (!xlsxPath) {
  console.error('usage: node scripts/import-intapp-history.mjs <export.xlsx> [--apply]');
  process.exit(1);
}

const strings = sharedStrings(readZipEntry(xlsxPath, 'xl/sharedStrings.xml'));
const allRows = sheetRows(readZipEntry(xlsxPath, 'xl/worksheets/sheet1.xml'), strings);

// Expected header: Timer | Hours | Matter | Client Name | Matter Name | Narrative | Status
const header = ['A', 'B', 'C', 'D', 'E', 'F', 'G'].map((k) => allRows[0]?.[k] ?? '');
if (header[1] !== 'Hours' || header[2] !== 'Matter' || header[5] !== 'Narrative' || header[6] !== 'Status') {
  console.error('Unexpected header row:', header);
  process.exit(1);
}
const rows = allRows.slice(1).map((r) => ({
  hours: r.B ?? '', cm_number: r.C ?? '', client_name: r.D ?? '',
  matter_name: r.E ?? '', narrative: r.F ?? '', status: r.G ?? '',
}));

const db = openDb(loadConfig().DB_PATH);

const existingByCm = new Map(
  db.prepare('SELECT id, cm_number, billable FROM matters').all().map((m) => [m.cm_number, m]));
const existingEntryKeys = new Set(
  db.prepare(`SELECT e.date || '|' || m.cm_number || '|' || e.narrative AS k
              FROM entries e JOIN matters m ON m.id = e.cm_id WHERE e.deleted_at IS NULL`)
    .all().map((r) => r.k));

const { plan, counts } = planIntappImport(rows, { existingByCm, existingEntryKeys });

for (const p of plan) {
  if (p.action === 'skip') {
    console.log(`row ${p.rowNum}: SKIP — ${p.reason}`);
  } else {
    const shape = p.entry.tasks ? `${p.entry.tasks.length} task lines` : 'free narrative';
    const nm = p.newMatter ? `  [+ new matter ${p.newMatter.cm_number} "${p.newMatter.matter_name}"]` : '';
    console.log(`row ${p.rowNum}: ${p.entry.date}  ${p.entry.cm_number}  ${p.entry.hours}h  (${shape})${nm}`);
  }
}
console.log(`\n${counts.import} to import, ${counts.skip} skipped, ${counts.newMatters} new matters`);

if (!apply) {
  console.log('Dry run — pass --apply to write.');
  process.exit(0);
}

const iso = nowIso();
const insClient = db.prepare(
  'INSERT INTO clients (client_number, name) VALUES (?, ?) ON CONFLICT(client_number) DO NOTHING');
const nameClient = db.prepare(
  "UPDATE clients SET name=?, updated_at=? WHERE client_number=? AND TRIM(name)=''");
const getClient = db.prepare('SELECT id FROM clients WHERE client_number=?');
const insMatter = db.prepare(`
  INSERT INTO matters (cm_number, short_name, billable, client_id, matter_number, last_used_at)
  VALUES (?, ?, 1, ?, ?, ?)`);
const insEntry = db.prepare(`
  INSERT INTO entries (date, cm_id, narrative, billable, status, total_override, source,
    ack_validation, ever_finalized, exported_at, finalized_at, narrative_manual, created_at, updated_at)
  VALUES (?, ?, ?, ?, 'finalized', ?, 'manual', 1, 1, ?, ?, 0, ?, ?)`);
const insTask = db.prepare(
  "INSERT INTO entry_tasks (entry_id, task_code, duration, fragment, sort_order) VALUES (?, '', ?, ?, ?)");
const insAudit = db.prepare(
  'INSERT INTO audit_log (entry_id, action, detail, created_at) VALUES (?, ?, ?, ?)');
const bumpLastUsed = db.prepare(
  'UPDATE matters SET last_used_at=? WHERE id=? AND (last_used_at IS NULL OR last_used_at < ?)');

const imported = db.transaction(() => {
  const touched = new Set();
  let n = 0;
  for (const p of plan) {
    if (p.action !== 'import') continue;

    if (p.newMatter) {
      const clientNumber = p.newMatter.cm_number.slice(0, 6);
      insClient.run(clientNumber, p.newMatter.client_name);
      if (p.newMatter.client_name) nameClient.run(p.newMatter.client_name, iso, clientNumber);
      const clientId = getClient.get(clientNumber).id;
      const r = insMatter.run(p.newMatter.cm_number, p.newMatter.matter_name, clientId,
        p.newMatter.cm_number.slice(7, 13), null);
      existingByCm.set(p.newMatter.cm_number, { id: r.lastInsertRowid, billable: 1 });
    }

    const matter = existingByCm.get(p.entry.cm_number);
    // Timestamps anchor to the entry date so history reads naturally.
    const dayIso = `${p.entry.date}T12:00:00.000Z`;
    // Free narratives carry the sheet's Hours as an override; parsed task
    // lines already sum to it, so the app derives the same total.
    const totalOverride = p.entry.tasks ? null : p.entry.hours;
    const e = insEntry.run(p.entry.date, matter.id, p.entry.narrative, matter.billable,
      totalOverride, dayIso, dayIso, dayIso, dayIso);
    for (const [i, t] of (p.entry.tasks ?? []).entries()) {
      insTask.run(e.lastInsertRowid, t.duration, t.fragment, i);
    }
    insAudit.run(e.lastInsertRowid, 'import',
      JSON.stringify({ source: 'intapp-xlsx', row: p.rowNum, status: rows[p.rowNum - 1].status }), iso);
    bumpLastUsed.run(dayIso, matter.id, dayIso);
    touched.add(matter.id);
    n++;
  }
  for (const id of touched) rebuildMatterPeople(db, id);
  return { n, matters: touched.size };
})();

console.log(`Imported ${imported.n} entries across ${imported.matters} matters.`);
