import { Router } from 'express';

// The entity dictionary the attorney maintains by hand (spec 2026-08-30). The
// rows are mostly DERIVED from his entries, so this API is careful about the
// difference: it may add, rename, retype and hide, but it never pretends to
// delete something the extractor will simply find again on the next entry
// write. Deleting a derived row hides it; that is the honest operation.
//
// matter_id null = a global row, offered on every matter and ranked last.
const KINDS = new Set(['document', 'org', 'person']);
const COLS = `id, matter_id, name, derived_name, kind, count, last_seen_at,
  origin, hidden, locked`;

export function dictionaryRouter({ db }) {
  const r = Router();
  const get = db.prepare(`SELECT ${COLS} FROM matter_entities WHERE id=?`);

  // Own rows first, then the global ones: the same order the ghost ranks in,
  // so the page reads the way the predictions behave.
  r.get('/', (req, res) => {
    const raw = req.query.matter_id;
    if (raw == null || raw === '') {
      return res.json({
        rows: db.prepare(
          `SELECT ${COLS} FROM matter_entities WHERE matter_id IS NULL
             ORDER BY kind, name COLLATE NOCASE`).all(),
      });
    }
    const matterId = Number(raw);
    if (!db.prepare('SELECT id FROM matters WHERE id=?').get(matterId)) {
      return res.status(404).json({ error: 'Matter not found.' });
    }
    res.json({
      rows: db.prepare(
        `SELECT ${COLS} FROM matter_entities
           WHERE matter_id = ? OR matter_id IS NULL
           ORDER BY (matter_id IS NULL), kind, name COLLATE NOCASE`).all(matterId),
    });
  });

  r.post('/', (req, res) => {
    const b = req.body || {};
    const name = String(b.name || '').replace(/\s+/g, ' ').trim();
    const kind = String(b.kind || '');
    const matterId = b.matter_id == null || b.matter_id === '' ? null : Number(b.matter_id);
    if (!name || name.length > 120) {
      return res.status(400).json({ error: 'Name must be 1–120 characters.' });
    }
    if (!KINDS.has(kind)) {
      return res.status(400).json({ error: 'Kind must be document, org or person.' });
    }
    if (matterId != null && !db.prepare('SELECT id FROM matters WHERE id=?').get(matterId)) {
      return res.status(404).json({ error: 'Matter not found.' });
    }
    try {
      const info = db.prepare(
        `INSERT INTO matter_entities (matter_id, name, kind, origin) VALUES (?, ?, ?, 'manual')`
      ).run(matterId, name, kind);
      res.status(201).json(get.get(info.lastInsertRowid));
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) {
        return res.status(409).json({ error: `"${name}" is already in the dictionary here.` });
      }
      throw e;
    }
  });

  r.patch('/:id', (req, res) => {
    const row = get.get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Dictionary entry not found.' });
    const b = req.body || {};
    const name = b.name === undefined ? row.name : String(b.name).replace(/\s+/g, ' ').trim();
    const kind = b.kind === undefined ? row.kind : String(b.kind);
    const hidden = b.hidden === undefined ? row.hidden : (b.hidden ? 1 : 0);
    if (!name || name.length > 120) {
      return res.status(400).json({ error: 'Name must be 1–120 characters.' });
    }
    if (!KINDS.has(kind)) {
      return res.status(400).json({ error: 'Kind must be document, org or person.' });
    }
    // Editing name or kind locks the row: the next rebuild refreshes its
    // count but must never write his wording back to the extractor's.
    const locked = (name !== row.name || kind !== row.kind) ? 1 : row.locked;
    try {
      db.prepare('UPDATE matter_entities SET name=?, kind=?, hidden=?, locked=? WHERE id=?')
        .run(name, kind, hidden, locked, row.id);
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) {
        return res.status(409).json({ error: `"${name}" is already in the dictionary here.` });
      }
      throw e;
    }
    res.json(get.get(row.id));
  });

  r.delete('/:id', (req, res) => {
    const row = get.get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Dictionary entry not found.' });
    if (row.origin === 'manual') {
      db.prepare('DELETE FROM matter_entities WHERE id=?').run(row.id);
      return res.json({ ok: true, hidden: false });
    }
    // A derived row deleted outright returns on the next entry write. Hiding
    // is the operation that actually holds.
    db.prepare('UPDATE matter_entities SET hidden=1 WHERE id=?').run(row.id);
    res.json({ ok: true, hidden: true });
  });

  return r;
}
