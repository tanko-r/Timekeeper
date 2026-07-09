import { Router } from 'express';

// User-defined text-expansion shortcuts (spec §6): "IA" → "Interconnect
// Agreement". Deterministic and distinct from the derived phrasebook; the
// dictionary is built IN-FLOW (select text → save as shortcut), so this API
// is deliberately tiny: list, create, delete. Expansion itself happens in the
// browser (public/js/lib/expand.js).
const ABBREV_RE = /^\S{1,24}$/;

export function shortcutsRouter({ db, clock }) {
  const r = Router();
  const get = db.prepare('SELECT id, abbrev, phrase, created_at FROM shortcuts WHERE id=?');

  r.get('/', (req, res) => {
    res.json(db.prepare(
      'SELECT id, abbrev, phrase, created_at FROM shortcuts ORDER BY abbrev COLLATE NOCASE').all());
  });

  r.post('/', (req, res) => {
    const b = req.body || {};
    const abbrev = String(b.abbrev || '').trim();
    const phrase = String(b.phrase || '').replace(/\s+/g, ' ').trim();
    if (!ABBREV_RE.test(abbrev)) {
      return res.status(400).json({ error: 'Abbreviation must be 1–24 characters with no spaces.' });
    }
    if (!phrase || phrase.length > 200) {
      return res.status(400).json({ error: 'Phrase must be 1–200 characters.' });
    }
    try {
      const info = db.prepare('INSERT INTO shortcuts (abbrev, phrase, created_at) VALUES (?, ?, ?)')
        .run(abbrev, phrase, clock().toISOString());
      res.status(201).json(get.get(info.lastInsertRowid));
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) {
        return res.status(409).json({ error: `Shortcut "${abbrev}" already exists.` });
      }
      throw e;
    }
  });

  r.delete('/:id', (req, res) => {
    const info = db.prepare('DELETE FROM shortcuts WHERE id=?').run(req.params.id);
    if (info.changes === 0) return res.status(404).json({ error: 'Shortcut not found.' });
    res.json({ ok: true });
  });

  return r;
}
