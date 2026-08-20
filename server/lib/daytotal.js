import { elapsedSeconds } from './timerlogic.js';
import { todayLocal } from './dates.js';
import { ENTRY_HOURS_SQL } from './attention.js';

// Total seconds recorded for today, live — the one figure the float footer and
// the dashboard show as "today". Every today entry contributes its hours
// (override, else the sum of its task lines), EXCEPT an entry whose timer is
// running right now: that entry's stored total is frozen until the timer stops
// (see syncToEntry), so the live timer clock stands in for it. Running timers
// that have not filed an entry yet (a matterless quick timer) count too. No
// double count: a running timer's linked entry is excluded from the filed sum
// precisely because the timer's live clock replaces it.
export function liveDayTotalSeconds(db, clock) {
  const today = todayLocal(clock());
  const nowMs = clock().getTime();
  const running = db.prepare(
    'SELECT id, accumulated_seconds, last_started_at, running, linked_entry_id FROM timers WHERE running = 1'
  ).all();
  const runningEntryIds = running.map((t) => t.linked_entry_id).filter((x) => x != null);
  const placeholders = runningEntryIds.map(() => '?').join(',');
  const filedHours = db.prepare(
    `SELECT COALESCE(SUM(${ENTRY_HOURS_SQL}), 0) AS h FROM entries
     WHERE entries.deleted_at IS NULL AND entries.date = ?
       ${runningEntryIds.length ? `AND entries.id NOT IN (${placeholders})` : ''}`
  ).get(today, ...runningEntryIds).h;
  const runningSeconds = running.reduce((s, t) => s + elapsedSeconds(t, nowMs), 0);
  return Math.round((Number(filedHours) || 0) * 3600 + runningSeconds);
}
