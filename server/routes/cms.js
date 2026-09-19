import { Router } from 'express';
import { validateCmNumber } from '../lib/validation.js';
import { splitCmNumber } from '../lib/cmNumber.js';
import { rankMatters } from '../lib/matterSearch.js';
import { buildMattersCsv } from '../lib/mattersExport.js';
import { narrativePrefix } from '../lib/sitecode.js';

const CM_COLS = `matters.id, matters.cm_number, matters.short_name, matters.billable,
  matters.status, matters.favorite, matters.last_used_at, matters.created_at, matters.updated_at,
  matters.client_id, matters.matter_number, matters.fixed_fee,
  clients.client_number, clients.name AS client_name,
  COALESCE(clients.task_billing, 1) AS client_task_billing,
  COALESCE(clients.site_code_prefix, 0) AS client_site_code_prefix`;
const CM_FROM = 'FROM matters LEFT JOIN clients ON clients.id = matters.client_id';

// The text a new narrative on this matter starts with (server/lib/sitecode.js),
// or null — only a client that opted into site-code narratives gets one.
export function withNarrativePrefix(row) {
  if (!row) return row;
  return { ...row, narrative_prefix: row.client_site_code_prefix ? narrativePrefix(row) : null };
}

// Just the prefix for one matter — timers.js seeds timer-created entries with it.
export function matterNarrativePrefix(db, matterId) {
  const row = db.prepare(`SELECT ${CM_COLS} ${CM_FROM} WHERE matters.id=?`).get(matterId);
  return row ? withNarrativePrefix(row).narrative_prefix : null;
}

// Upsert the client for a 6-digit client number and return its id. Blank name;
// the user fills it in later via /api/clients. Reused by the timer importer.
export function ensureClient(db, clientNumber, nowIso) {
  db.prepare('INSERT OR IGNORE INTO clients (client_number, created_at, updated_at) VALUES (?, ?, ?)')
    .run(clientNumber, nowIso, nowIso);
  return db.prepare('SELECT id FROM clients WHERE client_number=?').get(clientNumber).id;
}

export function cmsRouter({ db, clock }) {
  const r = Router();
  const now = () => clock().toISOString();

  const getCmStmt = db.prepare(`SELECT ${CM_COLS} ${CM_FROM} WHERE matters.id=?`);
  const getCm = { get: (id) => withNarrativePrefix(getCmStmt.get(id)) };

  // Fuzzy picker: load active matters (with their client fields) and rank in
  // JS via the pure lib — single-user scale, so O(n) per keystroke is fine.
  const pickerStmt = db.prepare(`SELECT ${CM_COLS} ${CM_FROM} WHERE matters.status='active'`);

  r.get('/picker', (req, res) => {
    const q = String(req.query.q || '').trim();
    res.json(rankMatters(q, pickerStmt.all().map(withNarrativePrefix)));
  });

  // Roster export: the full client/matter list, archived included. The roster
  // is a reference document — leaving archived matters out would make it a
  // partial answer to "what are my numbers?". Returns { csv } like the time
  // export, so the browser saves it with downloadText.
  r.get('/export', (req, res) => {
    const rows = db.prepare(`
      SELECT ${CM_COLS},
        (SELECT COUNT(*) FROM entries e WHERE e.cm_id = matters.id AND e.deleted_at IS NULL) AS entry_count
      ${CM_FROM}
    `).all();
    res.json({ count: rows.length, csv: buildMattersCsv(rows) });
  });

  // Single record, full CM shape (client_id included) — used by the edit-matter
  // modal when opened from a context that only has the narrow entry.cm embed
  // (client_name but no client_id), e.g. the time entry editor.
  r.get('/:id', (req, res) => {
    const cm = getCm.get(req.params.id);
    if (!cm) return res.status(404).json({ error: 'CM not found.' });
    res.json(cm);
  });

  r.get('/', (req, res) => {
    const includeArchived = req.query.includeArchived === '1';
    const rows = db.prepare(`
      SELECT ${CM_COLS},
        (SELECT COUNT(*) FROM entries e WHERE e.cm_id = matters.id AND e.deleted_at IS NULL) AS entry_count
      ${CM_FROM} ${includeArchived ? '' : "WHERE matters.status='active'"}
      ORDER BY matters.favorite DESC, matters.short_name COLLATE NOCASE
    `).all();
    res.json(rows.map(withNarrativePrefix));
  });

  r.post('/', (req, res) => {
    const {
      cm_number, short_name = '', billable = 1, favorite = 0, fixed_fee = 0, client_name,
      client_task_billing, client_site_code_prefix,
    } = req.body || {};
    if (!validateCmNumber(cm_number)) {
      return res.status(400).json({ error: 'CM number must match format 123456-123456.' });
    }
    try {
      const { clientNumber, matterNumber } = splitCmNumber(cm_number);
      // Task billing is a client-wide setting, so it may only be set by the
      // request that brings the client into existence. A later matter under
      // the same client must never silently reflag every earlier matter.
      const clientIsNew = !db.prepare('SELECT 1 FROM clients WHERE client_number=?').get(clientNumber);
      const clientId = ensureClient(db, clientNumber, now());
      // INSERT first: it's the statement that can throw (duplicate cm_number).
      // Only once it has actually succeeded do we apply the client_name side
      // effect, so a failed (409) request never leaves a persisted mutation.
      const info = db.prepare(
        'INSERT INTO matters (cm_number, short_name, billable, favorite, fixed_fee, client_id, matter_number, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(cm_number, String(short_name), billable ? 1 : 0, favorite ? 1 : 0, fixed_fee ? 1 : 0,
        clientId, matterNumber, now(), now());
      if (typeof client_name === 'string' && client_name.trim() !== '') {
        // Name a still-blank client at creation time; never overwrite a real name.
        db.prepare("UPDATE clients SET name=?, updated_at=? WHERE id=? AND name=''")
          .run(client_name.trim(), now(), clientId);
      }
      if (clientIsNew && client_task_billing !== undefined) {
        db.prepare('UPDATE clients SET task_billing=?, updated_at=? WHERE id=?')
          .run(client_task_billing ? 1 : 0, now(), clientId);
      }
      // Same rule for site-code narratives: client-wide, so only the request
      // that creates the client may set it.
      if (clientIsNew && client_site_code_prefix !== undefined) {
        db.prepare('UPDATE clients SET site_code_prefix=?, updated_at=? WHERE id=?')
          .run(client_site_code_prefix ? 1 : 0, now(), clientId);
      }
      res.status(201).json(getCm.get(info.lastInsertRowid));
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) {
        return res.status(409).json({ error: `CM ${cm_number} already exists.` });
      }
      throw e;
    }
  });

  r.patch('/:id', (req, res) => {
    const cm = getCm.get(req.params.id);
    if (!cm) return res.status(404).json({ error: 'CM not found.' });
    const b = req.body || {};
    if (b.cm_number !== undefined && !validateCmNumber(b.cm_number)) {
      return res.status(400).json({ error: 'CM number must match format 123456-123456.' });
    }
    if (b.status !== undefined && !['active', 'archived'].includes(b.status)) {
      return res.status(400).json({ error: 'status must be active or archived.' });
    }
    const next = {
      cm_number: b.cm_number ?? cm.cm_number,
      short_name: b.short_name ?? cm.short_name,
      billable: b.billable !== undefined ? (b.billable ? 1 : 0) : cm.billable,
      status: b.status ?? cm.status,
      favorite: b.favorite !== undefined ? (b.favorite ? 1 : 0) : cm.favorite,
      fixed_fee: b.fixed_fee !== undefined ? (b.fixed_fee ? 1 : 0) : cm.fixed_fee,
    };
    try {
      let clientId = null;
      let matterNumber = null;
      if (b.cm_number !== undefined && b.cm_number !== cm.cm_number) {
        const parts = splitCmNumber(next.cm_number);
        clientId = ensureClient(db, parts.clientNumber, now());
        matterNumber = parts.matterNumber;
      }
      db.prepare(
        `UPDATE matters SET cm_number=?, short_name=?, billable=?, status=?, favorite=?, fixed_fee=?, updated_at=?
         ${clientId ? ', client_id=?, matter_number=?' : ''} WHERE id=?`
      ).run(next.cm_number, next.short_name, next.billable, next.status, next.favorite, next.fixed_fee, now(),
        ...(clientId ? [clientId, matterNumber] : []), cm.id);
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) {
        return res.status(409).json({ error: `CM ${b.cm_number} already exists.` });
      }
      throw e;
    }
    res.json(getCm.get(cm.id));
  });

  r.delete('/:id', (req, res) => {
    const cm = getCm.get(req.params.id);
    if (!cm) return res.status(404).json({ error: 'CM not found.' });
    const used = db.prepare('SELECT COUNT(*) c FROM entries WHERE cm_id=?').get(cm.id).c
      + db.prepare('SELECT COUNT(*) c FROM timers WHERE cm_id=?').get(cm.id).c;
    if (used > 0) {
      return res.status(409).json({
        error: 'CM has entries or timers — archive it instead of deleting.',
      });
    }
    db.prepare('DELETE FROM matters WHERE id=?').run(cm.id);
    res.json({ ok: true });
  });

  return r;
}
