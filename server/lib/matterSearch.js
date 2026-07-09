// Unified fuzzy search over client + matter fields for the CM picker (spec
// §3.4: typing "meri harbor" matches client "Meridian" matter "Harbor…").
// Deterministic and dependency-free: every whitespace-separated query token
// must match (case-insensitive substring) at least one field; matches at the
// start of a word score higher. Ties fall back to the classic picker order:
// favorite DESC, last_used_at DESC (nulls last), short_name alpha.

const FIELDS = ['short_name', 'client_name', 'cm_number', 'matter_number', 'client_number'];
const WORD_SEP = /[\s\-–—.,/()&_]/;

function tokenScore(token, matter) {
  let best = 0;
  for (const field of FIELDS) {
    const value = String(matter[field] ?? '').toLowerCase();
    if (!value) continue; // blank client names post-migration
    const idx = value.indexOf(token);
    if (idx === -1) continue;
    best = Math.max(best, idx === 0 || WORD_SEP.test(value[idx - 1]) ? 2 : 1);
    if (best === 2) break;
  }
  return best; // 0 = this token matched nothing
}

export function rankMatters(query, matters, { limit = 25 } = {}) {
  const tokens = String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const scored = [];
  for (const m of matters) {
    let score = 0;
    let ok = true;
    for (const t of tokens) {
      const s = tokenScore(t, m);
      if (s === 0) { ok = false; break; } // AND semantics
      score += s;
    }
    if (ok) scored.push({ m, score });
  }
  const recency = (m) => (m.last_used_at ? Date.parse(m.last_used_at) : 0);
  scored.sort((a, b) =>
    b.score - a.score
    || (b.m.favorite ? 1 : 0) - (a.m.favorite ? 1 : 0)
    || recency(b.m) - recency(a.m)
    || String(a.m.short_name || '').localeCompare(String(b.m.short_name || ''), undefined, { sensitivity: 'base' }));
  return scored.slice(0, limit).map((s) => s.m);
}
