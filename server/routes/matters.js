import { Router } from 'express';
import { rankPhrases } from '../lib/phrasebook.js';
import { todayLocal } from '../lib/dates.js';

// Memory-layer read endpoints (spec §5). Everything here is derived from the
// user's own entries history — deterministic, instant, no LLM.
// "Thin" own history borrows from client siblings so new matters start warm:
const THIN_PHRASES = 5; // fewer own ranked phrases than this → blend siblings
const THIN_PEOPLE = 3;  // fewer own people than this → append sibling roster

// A phrase occurrence is any non-blank task fragment, plus the narrative of
// entries with fewer than 2 substantive task lines (mirrors narrative_auto in
// entries.js) — auto-generated multi-line narratives are joins of their own
// fragments and would double-count.
const FREE_NARRATIVE = `TRIM(e.narrative) != ''
      AND (SELECT COUNT(*) FROM entry_tasks t WHERE t.entry_id = e.id
            AND (TRIM(t.fragment) != '' OR TRIM(t.task_code) != '' OR t.duration > 0)) < 2`;

const OWN_PHRASES = `
    SELECT et.fragment AS text, e.date FROM entry_tasks et
    JOIN entries e ON e.id = et.entry_id
    WHERE e.cm_id = ? AND e.deleted_at IS NULL AND TRIM(et.fragment) != ''
    UNION ALL
    SELECT e.narrative AS text, e.date FROM entries e
    WHERE e.cm_id = ? AND e.deleted_at IS NULL AND ${FREE_NARRATIVE}`;

const SIBLING_PHRASES = `
    SELECT et.fragment AS text, e.date FROM entry_tasks et
    JOIN entries e ON e.id = et.entry_id
    JOIN matters m ON m.id = e.cm_id
    WHERE m.client_id = ? AND m.id != ? AND e.deleted_at IS NULL AND TRIM(et.fragment) != ''
    UNION ALL
    SELECT e.narrative AS text, e.date FROM entries e
    JOIN matters m ON m.id = e.cm_id
    WHERE m.client_id = ? AND m.id != ? AND e.deleted_at IS NULL AND ${FREE_NARRATIVE}`;

// Suggestions for one matter — exported for reuse (precedent: loadEntry /
// syncNarrative in entries.js): timers.js calls this at timer START to
// pre-compute a suggested narrative. Returns null for an unknown matter.
// Statements are prepared per call — trivially cheap at single-user scale.
export function matterSuggestions(db, matterId, today) {
  const matter = db.prepare('SELECT id, client_id FROM matters WHERE id=?').get(matterId);
  if (!matter) return null;
  const own = db.prepare(OWN_PHRASES).all(matter.id, matter.id)
    .map((o) => ({ ...o, source: 'matter' }));
  let occurrences = own;
  let borrowed = false;
  if (rankPhrases(own, { today }).length < THIN_PHRASES && matter.client_id != null) {
    const sib = db.prepare(SIBLING_PHRASES).all(matter.client_id, matter.id, matter.client_id, matter.id)
      .map((o) => ({ ...o, source: 'client' }));
    if (sib.length > 0) { borrowed = true; occurrences = own.concat(sib); }
  }
  return { matter_id: matter.id, borrowed, phrases: rankPhrases(occurrences, { today }) };
}

export function mattersRouter({ db, clock }) {
  const r = Router();
  const getMatter = db.prepare('SELECT id, client_id FROM matters WHERE id=?');

  r.get('/:id/suggestions', (req, res) => {
    const out = matterSuggestions(db, req.params.id, todayLocal(clock()));
    if (!out) return res.status(404).json({ error: 'Matter not found.' });
    res.json(out);
  });

  const ownPeople = db.prepare(`
    SELECT name, count, last_seen_at AS last_seen FROM matter_people
    WHERE matter_id = ? ORDER BY last_seen_at DESC, count DESC, name
  `);

  const siblingPeople = db.prepare(`
    SELECT MIN(mp.name) AS name, SUM(mp.count) AS count, MAX(mp.last_seen_at) AS last_seen
    FROM matter_people mp JOIN matters m ON m.id = mp.matter_id
    WHERE m.client_id = ? AND m.id != ?
    GROUP BY LOWER(mp.name)
    ORDER BY last_seen DESC, count DESC, name
  `);

  r.get('/:id/people', (req, res) => {
    const matter = getMatter.get(req.params.id);
    if (!matter) return res.status(404).json({ error: 'Matter not found.' });
    const own = ownPeople.all(matter.id).map((p) => ({ ...p, source: 'matter' }));
    let people = own;
    let borrowed = false;
    if (own.length < THIN_PEOPLE && matter.client_id != null) {
      const have = new Set(own.map((p) => p.name.toLowerCase()));
      const sib = siblingPeople.all(matter.client_id, matter.id)
        .filter((p) => !have.has(p.name.toLowerCase()))
        .map((p) => ({ ...p, source: 'client' }));
      if (sib.length > 0) { borrowed = true; people = own.concat(sib); }
    }
    res.json({ matter_id: matter.id, borrowed, people });
  });

  return r;
}
