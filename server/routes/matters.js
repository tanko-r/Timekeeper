import { Router } from 'express';
import { rankPhrases } from '../lib/phrasebook.js';
import { pickRecentNarratives } from '../lib/recentnarratives.js';
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

// FRAGMENTS ONLY, deliberately — this is the matter boundary (docs/ui/BRIEF.md,
// "Data integrity"). A task-line fragment is reusable wording and is SUPPOSED
// to be shared across a client's matters; a NARRATIVE is the client-facing
// sentence that lands on a bill and describes work done on one specific matter,
// and it may never be suggested for another matter — not across clients, and
// not between two matters of the same client.
//
// This query used to carry a second UNION arm selecting `e.narrative` from
// sibling matters. That one arm was the root of two proven leaks: a brand-new
// matter's very first timer was stamped with the sibling's whole sentence
// (timers.js doStart), and the close-out sheet prefilled it into an entry that
// was then finalized and exported. Both are gone with the arm.
const SIBLING_PHRASES = `
    SELECT et.fragment AS text, e.date FROM entry_tasks et
    JOIN entries e ON e.id = et.entry_id
    JOIN matters m ON m.id = e.cm_id
    WHERE m.client_id = ? AND m.id != ? AND e.deleted_at IS NULL AND TRIM(et.fragment) != ''`;

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
    const sib = db.prepare(SIBLING_PHRASES).all(matter.client_id, matter.id)
      .map((o) => ({ ...o, source: 'client' }));
    if (sib.length > 0) { borrowed = true; occurrences = own.concat(sib); }
  }
  // Every phrase carries an accurate `source`: 'matter' = this matter's own
  // text (a fragment or one of its own free narratives), 'client' = wording
  // borrowed from a sibling matter's task lines. Consumers that write a whole
  // narrative — the timer's suggested_narrative, the AI prompt's "recent work
  // on this matter" block — must take 'matter' only. rankPhrases promotes a
  // group to 'matter' as soon as one own-matter occurrence exists, so the flag
  // never understates ownership.
  return { matter_id: matter.id, borrowed, phrases: rankPhrases(occurrences, { today }) };
}

// Flat name list for prompt context (AI name resolution, 2026-07-10): the
// matter's own roster, most recently seen first.
//
// Sibling names are OFF by default (2026-08-15). This list is captioned in the
// prompt as "People from this matter's history", and it blended client-sibling
// names unconditionally — not only when own history was thin. A counterparty
// who appears on no entry of this matter was therefore offered to a model that
// was writing THIS matter's billing narrative, under a heading claiming she
// belonged to it; ai.js's own notes record the model then importing people
// "from OTHER matters in the voice context" into narratives that named
// neither. That is a client fact crossing a matter boundary, so the AI path
// takes own names only. Pass { includeSiblings: true } for a caller that
// genuinely wants the client-wide roster and labels it as such.
export function matterPeopleList(db, matterId, opts = {}) {
  const { limit = 20, includeSiblings = false } =
    typeof opts === 'number' ? { limit: opts } : (opts || {});
  const matter = db.prepare('SELECT id, client_id FROM matters WHERE id=?').get(matterId);
  if (!matter) return [];
  const own = db.prepare(`
    SELECT name FROM matter_people WHERE matter_id = ?
    ORDER BY last_seen_at DESC, count DESC, name
  `).all(matter.id).map((p) => p.name);
  if (!includeSiblings) return own.slice(0, limit);
  const have = new Set(own.map((n) => n.toLowerCase()));
  const sib = matter.client_id == null ? [] : db.prepare(`
    SELECT MIN(mp.name) AS name, SUM(mp.count) AS count, MAX(mp.last_seen_at) AS last_seen
    FROM matter_people mp JOIN matters m ON m.id = mp.matter_id
    WHERE m.client_id = ? AND m.id != ?
    GROUP BY LOWER(mp.name)
    ORDER BY last_seen DESC, count DESC, name
  `).all(matter.client_id, matter.id)
    .map((p) => p.name)
    .filter((n) => !have.has(n.toLowerCase()));
  return own.concat(sib).slice(0, limit);
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

  // The matter's own recent narratives, newest first, duplicates collapsed —
  // the editor's "Reuse a narrative" list. Finalized and draft alike: what he
  // wrote this morning is the most likely thing to reuse this afternoon.
  // Over-fetch, then let the pure lib cap the DISTINCT count.
  const recentNarratives = db.prepare(`
    SELECT e.id, e.date, e.narrative, e.status,
      COALESCE(e.total_override,
        (SELECT COALESCE(SUM(t.duration), 0) FROM entry_tasks t WHERE t.entry_id = e.id)) AS total
    FROM entries e
    WHERE e.cm_id = ? AND e.deleted_at IS NULL AND TRIM(e.narrative) != ''
    ORDER BY e.date DESC, e.id DESC
    LIMIT 400
  `);

  r.get('/:id/recent-narratives', (req, res) => {
    const matter = getMatter.get(req.params.id);
    if (!matter) return res.status(404).json({ error: 'Matter not found.' });
    const asked = Number(req.query.limit);
    const limit = Number.isFinite(asked) ? Math.min(50, Math.max(1, Math.floor(asked))) : 20;
    res.json({
      matter_id: matter.id,
      entries: pickRecentNarratives(recentNarratives.all(matter.id), limit),
    });
  });

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
