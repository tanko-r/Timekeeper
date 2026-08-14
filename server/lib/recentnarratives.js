// "What did I write last time on this matter?" (2026-08-14 feedback: a button
// to pop up the last 10 or 20 entries with narratives for this matter, and
// import the narrative from one or more of them).
//
// A matter's history repeats itself — the same call, the same review, worded
// the same way, week after week. Handing back the raw last 20 rows would
// therefore spend most of the list on duplicates of one line. Identical
// narratives collapse into a single row carrying how many entries used it,
// dated by the most recent one, so the list stays 20 DIFFERENT things.

// Same text for this purpose = same words in the same order, ignoring case,
// surrounding space, and the trailing period. Time allocations are NOT
// normalized away: "(0.5)" and "(1.2)" describe genuinely different entries.
function key(text) {
  return String(text || '').trim().replace(/\s+/g, ' ').replace(/\.$/, '').toLowerCase();
}

// rows: newest first, each { id, date, narrative, total, status }.
// Returns at most `limit` distinct narratives, newest first, each with `uses`.
export function pickRecentNarratives(rows, limit = 20) {
  const out = [];
  const seen = new Map(); // key → the row already in `out`
  for (const row of rows || []) {
    const k = key(row.narrative);
    if (!k) continue;
    const hit = seen.get(k);
    if (hit) { hit.uses += 1; continue; }
    // Cap on DISTINCT narratives, but keep counting uses of the ones already
    // taken — the count is what marks a matter's habitual line.
    if (out.length >= limit) continue;
    const entry = { ...row, narrative: String(row.narrative).trim(), uses: 1 };
    out.push(entry);
    seen.set(k, entry);
  }
  return out;
}
