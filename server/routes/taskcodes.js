import { Router } from 'express';

export function taskCodesRouter({ db }) {
  const r = Router();
  const get = db.prepare('SELECT id, name, sort_order, active FROM task_codes WHERE id=?');

  r.get('/', (req, res) => {
    const includeInactive = req.query.includeInactive === '1';
    res.json(db.prepare(
      `SELECT id, name, sort_order, active FROM task_codes ${includeInactive ? '' : 'WHERE active=1'} ORDER BY sort_order, id`
    ).all());
  });

  r.post('/', (req, res) => {
    const name = String((req.body || {}).name || '').trim();
    if (!name) return res.status(400).json({ error: 'Task code name required.' });
    const max = db.prepare('SELECT COALESCE(MAX(sort_order), -1) m FROM task_codes').get().m;
    try {
      const info = db.prepare('INSERT INTO task_codes (name, sort_order) VALUES (?, ?)').run(name, max + 1);
      res.status(201).json(get.get(info.lastInsertRowid));
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) {
        return res.status(409).json({ error: `Task code "${name}" already exists.` });
      }
      throw e;
    }
  });

  r.patch('/:id', (req, res) => {
    const code = get.get(req.params.id);
    if (!code) return res.status(404).json({ error: 'Task code not found.' });
    const b = req.body || {};
    const name = b.name !== undefined ? String(b.name).trim() : code.name;
    if (!name) return res.status(400).json({ error: 'Task code name required.' });
    const active = b.active !== undefined ? (b.active ? 1 : 0) : code.active;
    try {
      db.prepare('UPDATE task_codes SET name=?, active=? WHERE id=?').run(name, active, code.id);
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) {
        return res.status(409).json({ error: `Task code "${name}" already exists.` });
      }
      throw e;
    }
    res.json(get.get(code.id));
  });

  r.put('/order', (req, res) => {
    const ids = (req.body || {}).ids;
    if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids array required.' });
    const upd = db.prepare('UPDATE task_codes SET sort_order=? WHERE id=?');
    db.transaction(() => ids.forEach((id, i) => upd.run(i, id)))();
    res.json({ ok: true });
  });

  r.delete('/:id', (req, res) => {
    const code = get.get(req.params.id);
    if (!code) return res.status(404).json({ error: 'Task code not found.' });
    db.prepare('DELETE FROM task_codes WHERE id=?').run(code.id);
    res.json({ ok: true });
  });

  return r;
}
