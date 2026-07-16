import { Router } from 'express';
import { effectiveFields, parseOptions } from '../lib/customfields.js';

const COLS = 'id, client_id, matter_id, name, type, options, pattern, pattern_hint, required, active, sort_order';

// options are stored as JSON text but cross the API as real arrays.
function pub(row) {
  return { ...row, options: parseOptions(row.options) };
}

// Effective definitions for a matter: its client's fields plus its own,
// matter overriding same-named client fields (lib/customfields.js). Exported
// for entries.js — enrich() attaches this to every entry payload.
export function loadEffectiveFields(db, matterId) {
  if (matterId == null) return [];
  const m = db.prepare('SELECT id, client_id FROM matters WHERE id=?').get(matterId);
  if (!m) return [];
  const list = (col, id) => db.prepare(
    `SELECT ${COLS} FROM custom_fields WHERE ${col}=? AND active=1 ORDER BY sort_order, id`).all(id);
  return effectiveFields(
    m.client_id != null ? list('client_id', m.client_id) : [],
    list('matter_id', m.id)).map(pub);
}

export function customFieldsRouter({ db }) {
  const r = Router();
  const get = db.prepare(`SELECT ${COLS} FROM custom_fields WHERE id=?`);

  // Shared POST/PATCH normalization; `existing` = row being patched, or null.
  function normalizeBody(b, existing) {
    const name = b.name !== undefined ? String(b.name).trim() : existing?.name;
    if (!name) return { error: 'Field name required.' };
    const type = b.type !== undefined ? String(b.type) : (existing?.type || 'text');
    if (!['text', 'select'].includes(type)) return { error: "type must be 'text' or 'select'." };
    let options = existing ? existing.options : '[]';
    if (b.options !== undefined) {
      if (!Array.isArray(b.options) || b.options.some((o) => typeof o !== 'string')) {
        return { error: 'options must be an array of strings.' };
      }
      options = JSON.stringify(b.options.map((o) => o.trim()).filter(Boolean));
    }
    const pattern = b.pattern !== undefined ? (String(b.pattern).trim() || null) : (existing?.pattern ?? null);
    if (pattern != null) {
      try { new RegExp(pattern); } catch { return { error: 'pattern is not a valid regular expression.' }; }
    }
    return {
      name, type, options, pattern,
      pattern_hint: b.pattern_hint !== undefined ? (String(b.pattern_hint).trim() || null) : (existing?.pattern_hint ?? null),
      required: b.required !== undefined ? (b.required ? 1 : 0) : (existing?.required ?? 0),
      active: b.active !== undefined ? (b.active ? 1 : 0) : (existing?.active ?? 1),
    };
  }

  r.get('/', (req, res) => {
    const q = req.query;
    const incl = q.includeInactive === '1' ? '' : ' AND active=1';
    let rows;
    if (q.client_id) {
      rows = db.prepare(`SELECT ${COLS} FROM custom_fields WHERE client_id=?${incl} ORDER BY sort_order, id`).all(q.client_id);
    } else if (q.matter_id) {
      rows = db.prepare(`SELECT ${COLS} FROM custom_fields WHERE matter_id=?${incl} ORDER BY sort_order, id`).all(q.matter_id);
    } else {
      rows = db.prepare(`SELECT ${COLS} FROM custom_fields WHERE 1=1${incl} ORDER BY client_id, matter_id, sort_order, id`).all();
    }
    res.json(rows.map(pub));
  });

  r.get('/effective/:matterId', (req, res) => {
    if (!db.prepare('SELECT id FROM matters WHERE id=?').get(req.params.matterId)) {
      return res.status(404).json({ error: 'Matter not found.' });
    }
    res.json(loadEffectiveFields(db, req.params.matterId));
  });

  r.post('/', (req, res) => {
    const b = req.body || {};
    const hasClient = b.client_id != null;
    const hasMatter = b.matter_id != null;
    if (hasClient === hasMatter) {
      return res.status(400).json({ error: 'Provide exactly one of client_id or matter_id.' });
    }
    if (hasClient && !db.prepare('SELECT id FROM clients WHERE id=?').get(b.client_id)) {
      return res.status(400).json({ error: 'Unknown client.' });
    }
    if (hasMatter && !db.prepare('SELECT id FROM matters WHERE id=?').get(b.matter_id)) {
      return res.status(400).json({ error: 'Unknown matter.' });
    }
    const v = normalizeBody(b, null);
    if (v.error) return res.status(400).json({ error: v.error });
    const max = db.prepare(
      'SELECT COALESCE(MAX(sort_order), -1) m FROM custom_fields WHERE client_id IS ? AND matter_id IS ?'
    ).get(hasClient ? b.client_id : null, hasMatter ? b.matter_id : null).m;
    try {
      const info = db.prepare(`INSERT INTO custom_fields
        (client_id, matter_id, name, type, options, pattern, pattern_hint, required, active, sort_order)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(hasClient ? b.client_id : null, hasMatter ? b.matter_id : null,
          v.name, v.type, v.options, v.pattern, v.pattern_hint, v.required, v.active, max + 1);
      res.status(201).json(pub(get.get(info.lastInsertRowid)));
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) {
        return res.status(409).json({ error: `A field named "${v.name}" already exists here.` });
      }
      throw e;
    }
  });

  r.patch('/:id', (req, res) => {
    const row = get.get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Field not found.' });
    const v = normalizeBody(req.body || {}, row);
    if (v.error) return res.status(400).json({ error: v.error });
    try {
      db.prepare('UPDATE custom_fields SET name=?, type=?, options=?, pattern=?, pattern_hint=?, required=?, active=? WHERE id=?')
        .run(v.name, v.type, v.options, v.pattern, v.pattern_hint, v.required, v.active, row.id);
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) {
        return res.status(409).json({ error: `A field named "${v.name}" already exists here.` });
      }
      throw e;
    }
    res.json(pub(get.get(row.id)));
  });

  r.put('/order', (req, res) => {
    const ids = (req.body || {}).ids;
    if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids array required.' });
    const upd = db.prepare('UPDATE custom_fields SET sort_order=? WHERE id=?');
    db.transaction(() => ids.forEach((id, i) => upd.run(i, id)))();
    res.json({ ok: true });
  });

  r.delete('/:id', (req, res) => {
    const row = get.get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Field not found.' });
    const used = db.prepare('SELECT COUNT(*) c FROM entry_custom_values WHERE field_id=?').get(row.id).c;
    if (used > 0) {
      return res.status(409).json({
        error: `"${row.name}" has ${used} recorded value${used === 1 ? '' : 's'} — deactivate it instead.`,
      });
    }
    db.prepare('DELETE FROM custom_fields WHERE id=?').run(row.id);
    res.json({ ok: true });
  });

  return r;
}
