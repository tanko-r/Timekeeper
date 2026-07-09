// Task-billed narrative generation (client task_billing = 1, default):
//   "Review lease (1.2); draft email to landlord (0.3); telephone conference
//    with client (0.4)."
// Block-billed narrative generation (client task_billing = 0) — fragments
// joined without per-task allocations:
//   "Review lease; draft email to landlord; telephone conference with client."
// Only applies to entries with two or more substantive task lines; single-line
// entries keep their free-text narrative (caller receives null).

function incrementDecimals(increment) {
  const s = String(increment ?? 0.1);
  const dot = s.indexOf('.');
  return dot === -1 ? 1 : Math.max(1, s.length - dot - 1);
}

export function durationLabel(hours, increment) {
  return Number(hours || 0).toFixed(incrementDecimals(increment));
}

function cleanFragment(text) {
  return String(text || '').trim().replace(/[.;\s]+$/, '');
}

export function buildNarrative(lines, { increment, taskBilling = true } = {}) {
  const substantive = (lines || [])
    .map((l) => ({
      text: cleanFragment(l.fragment) || cleanFragment(l.taskCode ?? l.task_code),
      duration: Number(l.duration) || 0,
    }))
    .filter((l) => l.text || l.duration > 0);

  if (substantive.length < 2) return null;

  const parts = substantive.map((l, i) => {
    let text = l.text || 'Time';
    if (i === 0) text = text.charAt(0).toUpperCase() + text.slice(1);
    return taskBilling ? `${text} (${durationLabel(l.duration, increment)})` : text;
  });
  return parts.join('; ') + '.';
}
