// Timer activity windows for the dashboard tabs (Today / Yesterday / Week /
// Recent). Pure — timergrid passes Date.now(); tests pass fixed clocks.
// A timer's "activity" is its most recent start or stop; a running timer is
// active right now. Yesterday is the one CLOSED window: a timer that also
// ran today counts as Today, not Yesterday (only the latest start/stop is
// stored, so "ran yesterday at all" is unknowable once it runs again).

export function lastActivityMs(t, nowMs) {
  if (t.running) return nowMs;
  return Math.max(
    t.last_stopped_at ? Date.parse(t.last_stopped_at) : 0,
    t.last_started_at ? Date.parse(t.last_started_at) : 0);
}

// Key order is the tabs' display order. until: null = open-ended.
export function activityWindows(nowMs) {
  const dayStart = new Date(nowMs);
  dayStart.setHours(0, 0, 0, 0);
  const yesterdayStart = new Date(dayStart);
  yesterdayStart.setDate(yesterdayStart.getDate() - 1);
  const weekStart = new Date(dayStart);
  weekStart.setDate(weekStart.getDate() - ((weekStart.getDay() + 6) % 7)); // Monday
  return {
    'act-today': { label: 'Today', since: dayStart.getTime(), until: null },
    'act-yesterday': { label: 'Yesterday', since: yesterdayStart.getTime(), until: dayStart.getTime() },
    'act-week': { label: 'Week', since: weekStart.getTime(), until: null },
    'act-recent': { label: 'Recent', since: nowMs - 14 * 86400000, until: null },
  };
}

export function inWindow(ms, win) {
  return ms >= win.since && (win.until == null || ms < win.until);
}
