// Mode-aware policy calibrated to David's approved examples, November 2026.
export const NARRATIVE_MODEL = 'timekeeper-narrative:v3';
export function isNarrativeModel(model) { return ['timekeeper-narrative:v3','timekeeper-narrative:v4'].includes(model); }
export const NARRATIVE_POLICY = `Write attorney billing narratives in present tense, with semicolons between tasks and a final period. Return only the narrative, without time amounts or commentary.
Expand: add useful detail about plausible steps within the stated work and connect related tasks. Infer the subject from supplied matter history. Do not merely capitalize the input.
Rewrite: improve phrasing and organization at roughly the same level of detail.
Shorten: cut excess wording and detail while preserving distinct work, names and important issues.
Use names and document identities from the input or context. History supplies context, not proof that past work happened again. Avoid inventing specific provisions, decisions or completed outcomes. Resolve contextual placeholders only when supported; otherwise keep the subject general. Keep brief tasks proportionate.`;
export function narrativeInstructions(instructions) {
  const extra = String(instructions || '').trim();
  return NARRATIVE_POLICY + (extra && extra !== NARRATIVE_POLICY ? `\n\nAttorney instructions:\n${extra}` : '');
}
export function calibratedMessages({brief = '', narrative = '', mode = 'draft', context, totalHours, instructions}) {
  const action = mode === 'shorter' ? 'Shorten' : mode === 'regenerate' ? 'Rewrite' : 'Expand';
  return [{role:'system', content:narrativeInstructions(instructions)}, {role:'user',content:[
    `Action: ${action}`,
    context ? `Matter context:\n${context}` : 'Matter context: none.',
    Number(totalHours)>0 ? `Recorded hours: ${Number(totalHours)}. Keep the work proportionate; omit time from the narrative.` : null,
    `Input:\n${(mode === 'longer' || mode === 'shorter') ? narrative : brief}`,
  ].filter(Boolean).join('\n\n')}];
}
