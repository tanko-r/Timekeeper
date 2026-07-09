import { Router } from 'express';
import { SIX } from '../lib/cmNumber.js';

const CLIENT_COLS = 'id, client_number, name, task_billing, created_at, updated_at';

export function clientsRouter({ db, clock }) {
  const r = Router();
  const now = () => clock().toISOString();
  const getClient = db.prepare(`SELECT ${CLIENT_COLS} FROM clients WHERE id=?`);

  r.get('/', (req, res) => {
    const rows = db.prepare(`
      SELECT ${CLIENT_COLS},
        (SELECT COUNT(*) FROM matters m WHERE m.client_id = clients.id) AS matter_count
      FROM clients ORDER BY client_number
    `).all();
    res.json(rows);
  });

  r.get('/:id', (req, res) => {
    const c = getClient.get(req.params.id);
    if (!c) return res.status(404).json({ error: 'Client not found.' });
    res.json(c);
  });

  r.patch('/:id', (req, res) => {
    const c = getClient.get(req.params.id);
    if (!c) return res.status(404).json({ error: 'Client not found.' });
    const b = req.body || {};
    if (b.client_number !== undefined && !SIX.test(String(b.client_number))) {
      return res.status(400).json({ error: 'Client number must be 6 digits.' });
    }
    if (b.client_number !== undefined && String(b.client_number) !== c.client_number) {
      const { matterCount } = db.prepare('SELECT COUNT(*) AS matterCount FROM matters WHERE client_id=?').get(c.id);
      if (matterCount > 0) {
        return res.status(409).json({
          error: 'Cannot change client number: this client has matters. Renumbering would break their CM# linkage.',
        });
      }
    }
    const next = {
      client_number: b.client_number ?? c.client_number,
      name: b.name ?? c.name,
      task_billing: b.task_billing !== undefined ? (b.task_billing ? 1 : 0) : c.task_billing,
    };
    try {
      db.prepare('UPDATE clients SET client_number=?, name=?, task_billing=?, updated_at=? WHERE id=?')
        .run(String(next.client_number), String(next.name), next.task_billing, now(), c.id);
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) {
        return res.status(409).json({ error: `Client ${b.client_number} already exists.` });
      }
      throw e;
    }
    res.json(getClient.get(c.id));
  });

  return r;
}
