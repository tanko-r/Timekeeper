import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { getSetting } from '../db.js';
import { isValidDate } from '../lib/dates.js';
import { attentionSql } from '../lib/attention.js';
import { toCsv } from '../lib/csv.js';
import { durationLabel } from '../lib/narrative.js';
import { formatTimEntries } from '../lib/tim.js';
import { enrich } from './entries.js';

export const CSV_HEADER = [
  'date', 'cm_number', 'cm_short_name', 'billable', 'task', 'duration',
  'narrative', 'entry_total', 'entry_id',
];

// The scope the attorney pointed at, read off a request. A file must hold the
// set the screen was showing: a date range on its own is WIDER than a ledger
// narrowed by a matter chip or an explicit row selection, and the widening is
// invisible until another client's time has been written and stamped.
//
// A malformed value is a 400 rather than a silent fallback: "ignore what I
// could not parse" is exactly how a narrowed export becomes a wide one.
export function parseScope(rawCm, rawIds) {
  let cmId = null;
  if (rawCm !== undefined && rawCm !== null && rawCm !== '') {
    const n = Number(rawCm);
    if (!Number.isInteger(n) || n <= 0) return { error: 'cm_id must be a matter id.' };
    cmId = n;
  }
  let ids = null;
  if (rawIds !== undefined && rawIds !== null && rawIds !== '') {
    const list = Array.isArray(rawIds) ? rawIds : String(rawIds).split(',');
    const parsed = list.map((x) => Number(x));
    if (parsed.some((n) => !Number.isInteger(n) || n <= 0)) return { error: 'ids must be entry ids.' };
    ids = [...new Set(parsed)];
  }
  return { cmId, ids };
}

export function buildExport(db, {
  from, to, includeDrafts = false, attention = null, cmId = null, ids = null,
}) {
  // An attention filter (see lib/attention.js) says which stalled entries to
  // look at, and answers "finalized only?" on its own — "not finalized" would
  // be an empty list under the default finalized-only rule.
  const attSql = attentionSql(attention);
  const statusSql = attSql ? `AND ${attSql}` : (includeDrafts ? '' : "AND status='finalized'");

  // …and on top of that, the narrowing the screen was showing. An explicit id
  // list is authoritative: an empty one selects nothing rather than everything.
  const scopeParts = [];
  const scopeArgs = [];
  if (cmId != null) { scopeParts.push('AND cm_id = ?'); scopeArgs.push(Number(cmId)); }
  if (Array.isArray(ids)) {
    if (ids.length === 0) scopeParts.push('AND 0');
    else {
      scopeParts.push(`AND id IN (${ids.map(() => '?').join(',')})`);
      scopeArgs.push(...ids.map(Number));
    }
  }
  const scopeSql = scopeParts.join(' ');

  const rows = db.prepare(`
    SELECT entries.* FROM entries
    WHERE deleted_at IS NULL AND date >= ? AND date <= ?
      ${statusSql} ${scopeSql}
    ORDER BY date, cm_id, id
  `).all(from, to, ...scopeArgs);
  const unassociated = db.prepare(`
    SELECT COUNT(*) c FROM entries
    WHERE deleted_at IS NULL AND date >= ? AND date <= ? AND cm_id IS NULL
      ${scopeSql}
  `).get(from, to, ...scopeArgs).c;
  // Matterless entries are never exportable — there is nothing to key them
  // under in the billing system. A blank narrative is never exportable either:
  // an empty na= field imports into the billing system as a real, blank bill.
  // Both stay in `entries` and in the text summary so the preview can show the
  // time they are holding (hiding a leaking entry from the very screen built
  // to find leaks would defeat the point), and both drop out of everything
  // that becomes a file — the CSV, the .TIM, the count and the stamp.
  const allEntries = rows.map((r) => enrich(db, r));
  const withMatter = allEntries.filter((e) => e.cm);
  const entries = withMatter.filter((e) => String(e.narrative || '').trim() !== '');
  const increment = (getSetting(db, 'rounding') || {}).increment || 0.1;

  // Custom-field columns (2026-07-15): one per distinct effective-field name
  // across the exported entries, "field:"-prefixed so a custom field named
  // "task" can never collide with the fixed task column. Alphabetical for a
  // stable layout; blank where a field doesn't apply to that entry's matter.
  const fieldNames = [...new Set(entries.flatMap((e) => (e.custom_fields || []).map((f) => f.name)))]
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  const header = [...CSV_HEADER, ...fieldNames.map((n) => `field:${n}`)];

  const csvRows = [];
  for (const e of entries) {
    const billable = e.billable ? 'billable' : 'non-billable';
    const custom = fieldNames.map((n) => {
      const f = (e.custom_fields || []).find((x) => x.name === n);
      return f ? (e.custom_values?.[f.id] ?? '') : '';
    });
    const lines = e.tasks.length > 0
      ? e.tasks
      : [{ task_code: '', duration: e.total }];
    for (const t of lines) {
      // Durations go out as stored numbers — display rounding must never
      // change what the billing system receives.
      csvRows.push([
        e.date, e.cm.cm_number, e.cm.short_name, billable,
        t.task_code, Number(t.duration) || 0,
        e.narrative, Number(e.total) || 0, e.id,
        ...custom,
      ]);
    }
  }

  const text = withMatter.map((e) => {
    const head = `${e.date} — ${e.cm.cm_number} ${e.cm.short_name} [${e.billable ? 'billable' : 'non-billable'}] — ${durationLabel(e.total, increment)}h${e.status === 'draft' ? ' (DRAFT)' : ''}`;
    return `${head}\n  ${e.narrative || '(no narrative)'}`;
  }).join('\n\n');

  return {
    count: entries.length,
    unassociated,
    entry_ids: entries.map((e) => e.id),
    entries: allEntries, // preview rows — matterless included
    exportable: entries, // the rows behind csv/text/.TIM
    csv: toCsv(header, csvRows),
    text,
  };
}

// The stable identity a .TIM line carries in `ref`. Until an entry has one,
// every export of it looks like NEW work to the billing system — the same hour
// imports twice with nothing in either file to spot the duplicate. Minted once,
// on the first export that actually writes the entry into a file, and never
// changed afterwards; lib/tim.js derives ref/shortref/ss/ar from it, so a
// re-export is byte-recognisable as the same entry.
export function mintTimRefs(db, entries, uuid = randomUUID) {
  const need = entries.filter((e) => !e.tim_ref);
  if (need.length === 0) return;
  const upd = db.prepare('UPDATE entries SET tim_ref=? WHERE id=? AND tim_ref IS NULL');
  const read = db.prepare('SELECT tim_ref FROM entries WHERE id=?');
  db.transaction(() => {
    for (const e of need) {
      upd.run(String(uuid()), e.id);
      e.tim_ref = (read.get(e.id) || {}).tim_ref || null;
    }
  })();
}

export function exportRouter({ db, clock }) {
  const r = Router();

  // ------------------------------------------------------------------------
  // THE TWO-PHASE HANDSHAKE.
  //
  // POST /api/export builds the payload and stamps NOTHING. The client stamps
  // by calling POST /api/export/:id/confirm once the download has actually
  // succeeded on its side. "No entry marked exported that did not actually
  // reach the file" cannot be answered from inside the request: a proxy that
  // cuts the connection at the first byte still fires res.on('finish') with
  // writableFinished true, byte-identical to a healthy delivery, so the server
  // has no way to tell a delivered file from a dropped one. Only the client
  // knows, so only the client may say so.
  //
  // Batches live in this Map and nowhere else: a single-user, single-process
  // app, and a batch lost to a restart FAILS SAFE — nothing is stamped, so the
  // time keeps alerting as unsent. A table would buy durability for the one
  // outcome that does not need it.
  // ------------------------------------------------------------------------
  const batches = new Map();
  const BATCH_TTL_MS = 6 * 60 * 60 * 1000;
  const BATCH_MAX = 500;

  function pruneBatches(nowMs) {
    for (const [id, b] of batches) if (nowMs - b.at > BATCH_TTL_MS) batches.delete(id);
    // Map iterates in insertion order, so this drops the oldest first.
    while (batches.size >= BATCH_MAX) batches.delete(batches.keys().next().value);
  }

  const validRange = (q) => isValidDate(q.from) && isValidDate(q.to);

  r.post('/export', (req, res) => {
    const b = req.body || {};
    if (!validRange(b)) return res.status(400).json({ error: 'from/to must be YYYY-MM-DD.' });
    const scope = parseScope(b.cm_id, b.ids);
    if (scope.error) return res.status(400).json({ error: scope.error });
    const result = buildExport(db, {
      from: b.from, to: b.to, includeDrafts: !!b.includeDrafts, attention: b.attention,
      cmId: scope.cmId, ids: scope.ids,
    });
    mintTimRefs(db, result.exportable);

    let batch = null;
    if (b.markExported !== false && result.entry_ids.length > 0) {
      pruneBatches(Date.now());
      batch = randomUUID();
      batches.set(batch, { ids: result.entry_ids.slice(), at: Date.now(), confirmed_at: null, stamped: 0 });
    }

    const { entries, exportable, ...out } = result;
    out.batch = batch;
    out.tim = formatTimEntries(exportable, getSetting(db, 'tim') || {}, { now: clock().toISOString() });
    res.json(out);
  });

  // The ONLY writer of exported_at on the export path. It stamps the ids
  // recorded on the batch and never an id from the request body — otherwise a
  // client could mark time sent that no file ever held. Idempotent: a retried
  // confirm reports the first stamp and writes nothing.
  r.post('/export/:id/confirm', (req, res) => {
    const batch = batches.get(String(req.params.id));
    if (!batch) return res.status(404).json({ error: 'Unknown or expired export batch.' });
    if (batch.confirmed_at) {
      return res.json({ ok: true, confirmed_at: batch.confirmed_at, stamped: batch.stamped, repeat: true });
    }
    const stamp = clock().toISOString();
    // No status condition: what reached the file has been sent, draft or not.
    // A draft that shipped and is not recorded as shipped ships AGAIN the
    // moment it is finalized, and the client is billed for the hour twice.
    const upd = db.prepare('UPDATE entries SET exported_at=? WHERE id=?');
    let stamped = 0;
    db.transaction(() => { for (const id of batch.ids) stamped += upd.run(stamp, id).changes; })();
    batch.confirmed_at = stamp;
    batch.stamped = stamped;
    res.json({ ok: true, confirmed_at: stamp, stamped });
  });

  r.get('/export/preview', (req, res) => {
    const q = req.query;
    if (!validRange(q)) return res.status(400).json({ error: 'from/to must be YYYY-MM-DD.' });
    const scope = parseScope(q.cm_id, q.ids);
    if (scope.error) return res.status(400).json({ error: scope.error });
    const { csv, exportable, ...out } = buildExport(db, {
      from: q.from, to: q.to, includeDrafts: q.includeDrafts === '1' || q.includeDrafts === 'true',
      attention: q.attention, cmId: scope.cmId, ids: scope.ids,
    });
    res.json(out);
  });

  return r;
}
