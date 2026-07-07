// Entry validation. Everything returns findings; nothing throws.
// level 'block' = cannot finalize at all; 'warn' = needs one-click ack.

export const CM_RE = /^\d{6}-\d{6}$/;

export function validateCmNumber(s) {
  return CM_RE.test(String(s || ''));
}

export function validateEntry(entry, settings = {}) {
  const {
    minNarrativeChars = 20,
    bannedPhrases = [],
    blockBillingHours = 3.0,
    minIncrement = 0.1,
  } = settings;

  const findings = [];
  const add = (level, code, message) => findings.push({ level, code, message });

  const tasks = entry.tasks || [];
  const narrative = String(entry.narrative || '').trim();
  const sum = tasks.reduce((a, t) => a + (Number(t.duration) || 0), 0);
  const total = entry.total_override != null ? Number(entry.total_override) : sum;

  if (tasks.length === 0) {
    add('block', 'no_task_lines', 'Entry has no task lines.');
  }

  if (!narrative) {
    add('block', 'narrative_empty', 'Narrative is empty.');
  } else if (narrative.length < minNarrativeChars) {
    add('warn', 'narrative_short',
      `Narrative is under ${minNarrativeChars} characters.`);
  }

  if (narrative) {
    const lower = narrative.toLowerCase();
    for (const phrase of bannedPhrases) {
      if (phrase && lower.includes(String(phrase).toLowerCase())) {
        add('warn', 'banned_phrase',
          `Narrative uses vague phrase "${phrase}".`);
        break;
      }
    }
  }

  if (entry.total_override != null && Math.abs(sum - Number(entry.total_override)) > 0.001) {
    add('warn', 'sum_mismatch',
      `Task lines sum to ${sum.toFixed(2)} but total is ${Number(entry.total_override).toFixed(2)}.`);
  }

  if (tasks.length === 1 && Number(tasks[0].duration) > blockBillingHours) {
    add('warn', 'block_billing',
      `Single ${Number(tasks[0].duration).toFixed(1)}h line exceeds ${blockBillingHours}h — consider breaking it down.`);
  }

  for (const t of tasks) {
    const d = Number(t.duration) || 0;
    if (d > 0 && d < minIncrement - 1e-9) {
      add('warn', 'min_increment',
        `A task line duration (${d}) is under the minimum increment ${minIncrement}.`);
      break;
    }
  }

  if (tasks.length > 0 && total <= 0) {
    add('warn', 'zero_duration', 'Entry total is zero.');
  }

  return findings;
}

export function canFinalize(entry, settings = {}) {
  const findings = validateEntry(entry, settings);
  const blocks = findings.filter((f) => f.level === 'block');
  const warns = findings.filter((f) => f.level === 'warn');

  if (!validateCmNumber(entry.cm && entry.cm.cm_number)) {
    blocks.push({ level: 'block', code: 'invalid_cm', message: 'Client/Matter number is not valid.' });
  }

  const ok = blocks.length === 0 && (warns.length === 0 || !!entry.ack_validation);
  return { ok, blocks, warns };
}
