// Long-running timer notification scheduling (TODO #3): an OS/browser
// notification when a timer's CURRENT running stretch passes 2 hours, then
// hourly (3h, 4h, …). Pure functions — the component supplies stretch
// seconds and keeps the returned marks map between ticks — so this is
// unit-testable under node:test like the other public/js/lib modules.
// Distinct from the visual idle-nudge (settings.idleNudgeHours), which keys
// off the day accumulator and only decorates the card.

// The notification mark for a running stretch: whole hours elapsed once the
// threshold is reached, else null. Marks are what make the cadence hourly —
// one notification per distinct mark.
export function longRunMark(seconds, thresholdHours = 2) {
  const h = Math.floor(seconds / 3600);
  return h >= thresholdHours ? h : null;
}

// Diff one tick against the last-notified marks. `timers` is
// [{id, name, running, seconds}] where seconds is the current running
// stretch (NOT the day accumulator — a restarted timer must not re-alert
// until it has been running continuously past the threshold again).
// Returns { due, marks }: notifications to fire now, and the map to carry
// into the next tick. Stopped or below-threshold timers drop out of the map
// so a fresh stretch notifies again.
export function longRunNotifications(timers, lastMarks, thresholdHours = 2) {
  const due = [];
  const marks = {};
  for (const t of timers) {
    if (!t.running) continue;
    const mark = longRunMark(t.seconds, thresholdHours);
    if (mark == null) continue;
    const last = lastMarks[t.id] ?? 0;
    marks[t.id] = Math.max(mark, last);
    if (last < mark) due.push({ id: t.id, name: t.name, mark });
  }
  return { due, marks };
}
