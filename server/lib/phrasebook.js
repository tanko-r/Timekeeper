// Per-matter phrasebook (spec §5): rank past task-line fragments and free
// narratives by frequency × recency → the matter's recurring "moves".
// Pure — callers fetch rows from the DB and pass them in.

const DAY_MS = 86_400_000;

export function normalizePhrase(text) {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.;,:\s]+$/, '');
}

// occurrences: [{ text, date: 'YYYY-MM-DD', source?: 'matter'|'client' }]
// Returns [{ text, count, score, last_used, source }] sorted by score desc.
// - grouped case-insensitively; display text = most recent occurrence's casing
// - per (source, phrase, date) dedupe: same phrase same day counts once
//   (guards against narrative-mirrors-fragment and timer re-syncs)
// - score = Σ weight(source) × 0.5^(ageDays / halfLifeDays)
// - source: 'matter' if the phrase has any own-matter occurrence, else
//   'client' — the borrowed flag consumers render differently
export function rankPhrases(occurrences, {
  today,
  halfLifeDays = 30,
  minLength = 3,
  limit = 15,
  weights = { matter: 1, client: 0.25 },
} = {}) {
  const todayMs = Date.parse(`${today}T00:00:00Z`);
  const groups = new Map();
  for (const occ of occurrences || []) {
    const text = normalizePhrase(occ.text);
    if (text.length < minLength) continue;
    const key = text.toLowerCase();
    let g = groups.get(key);
    if (!g) {
      g = { text, count: 0, score: 0, last_used: '', source: 'client', days: new Set() };
      groups.set(key, g);
    }
    const source = occ.source === 'client' ? 'client' : 'matter';
    const dayKey = `${source}|${occ.date}`;
    if (g.days.has(dayKey)) continue;
    g.days.add(dayKey);
    const ageDays = Math.max(0, (todayMs - Date.parse(`${occ.date}T00:00:00Z`)) / DAY_MS);
    g.count += 1;
    g.score += (weights[source] ?? 1) * Math.pow(0.5, ageDays / halfLifeDays);
    if (occ.date >= g.last_used) { g.last_used = occ.date; g.text = text; }
    if (source === 'matter') g.source = 'matter';
  }
  return [...groups.values()]
    .sort((a, b) => b.score - a.score || b.count - a.count || a.text.localeCompare(b.text))
    .slice(0, limit)
    .map(({ days, ...g }) => ({ ...g, score: Math.round(g.score * 1000) / 1000 }));
}
