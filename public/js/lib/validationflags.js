// Entry-card validation flags (2026-09-21 feedback — "cards are too big"):
// instead of a full-width row per finding, the card shows at most one icon
// per level beside the narrative, and the messages live in the hover text.
// Blocks lead because they stop a finalize; warnings only advise.

const LEVELS = ['block', 'warn'];

export function groupFindings(findings) {
  if (!findings || findings.length === 0) return [];
  return LEVELS.map((level) => {
    const msgs = findings.filter((f) => f.level === level).map((f) => f.message);
    return msgs.length ? { level, count: msgs.length, title: msgs.join('\n') } : null;
  }).filter(Boolean);
}
