import { Router } from 'express';
import { validateCmNumber } from '../lib/validation.js';
import { splitCmNumber } from '../lib/cmNumber.js';

const CM_COLS = 'id, cm_number, short_name, billable, status, favorite, last_used_at, created_at, updated_at';

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

  const getCm = db.prepare(`SELECT ${CM_COLS} FROM matters WHERE id=?`);

  r.get('/picker', (req, res) => {
    const q = String(req.query.q || '').trim();
    const like = `%${q}%`;
    const rows = db.prepare(`
      SELECT ${CM_COLS} FROM matters
      WHERE status='active' AND (? = '' OR cm_number LIKE ? OR short_name LIKE ? COLLATE NOCASE)
      ORDER BY favorite DESC, last_used_at IS NULL, last_used_at DESC, short_name COLLATE NOCASE
      LIMIT 25
    `).all(q, like, like);
    res.json(rows);
  });

  r.get('/', (req, res) => {
    const includeArchived = req.query.includeArchived === '1';
    const rows = db.prepare(`
      SELECT ${CM_COLS},
        (SELECT COUNT(*) FROM entries e WHERE e.cm_id = matters.id AND e.deleted_at IS NULL) AS entry_count
      FROM matters ${includeArchived ? '' : "WHERE status='active'"}
      ORDER BY favorite DESC, short_name COLLATE NOCASE
    `).all();
    res.json(rows);
  });

  r.post('/', (req, res) => {
    const { cm_number, short_name = '', billable = 1, favorite = 0 } = req.body || {};
    if (!validateCmNumber(cm_number)) {
      return res.status(400).json({ error: 'CM number must match format 123456-123456.' });
    }
    try {
      const { clientNumber, matterNumber } = splitCmNumber(cm_number);
      const clientId = ensureClient(db, clientNumber, now());
      const info = db.prepare(
        'INSERT INTO matters (cm_number, short_name, billable, favorite, client_id, matter_number, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(cm_number, String(short_name), billable ? 1 : 0, favorite ? 1 : 0, clientId, matterNumber, now(), now());
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
        `UPDATE matters SET cm_number=?, short_name=?, billable=?, status=?, favorite=?, updated_at=?
         ${clientId ? ', client_id=?, matter_number=?' : ''} WHERE id=?`
      ).run(next.cm_number, next.short_name, next.billable, next.status, next.favorite, now(),
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
