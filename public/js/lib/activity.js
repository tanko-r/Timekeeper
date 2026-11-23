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

// Which timer tab the dashboard lands on (2026-10-06 feedback). The default
// "group" view opens on Recent at the start of every new day; a tab picked
// earlier the same day still sticks across reloads and navigation. A saved
// tab with no saved day (stored before this rule) counts as an earlier day.
// "By client" keeps its saved tab across days and defaults to All (see the
// 2026-09-14 note in timergrid.js).
export function landingTab({ grouping, saved, savedDay, today }) {
  if (grouping === 'group') return saved && savedDay === today ? saved : 'act-recent';
  return saved || 'all';
}

// Which timer tab the grid actually shows, given the saved one.
// - A saved tab that isn't in the current tab list (deleted group, client
//   filtered away, never saved) falls back to All.
// - Starting a search flips to All so every hit is visible (2026-11-23
//   feedback), even when the current tab has hits of its own. A tab clicked
//   DURING the search is honored, so the hits can still be narrowed.
// - A clicked tab the search empties jumps to All when hits exist elsewhere;
//   with no hits anywhere it stays put (2026-07-17 feedback).
// All of it is transient: clearing the search shows the saved tab again.
export function effectiveTimerTab({
  activeTab, tabKeys, filtering, pickedDuringSearch, currentTabCount, matchCount,
}) {
  if (!tabKeys.includes(activeTab)) return 'all';
  if (!filtering || activeTab === 'all') return activeTab;
  if (!pickedDuringSearch) return 'all';
  if (currentTabCount === 0 && matchCount > 0) return 'all';
  return activeTab;
}
