import { addDays, localMidnightMs } from './dates.js';

export function elapsedSeconds(timer, nowMs) {
  let s = timer.accumulated_seconds;
  if (timer.running && timer.last_started_at) {
    s += Math.max(0, (nowMs - Date.parse(timer.last_started_at)) / 1000);
  }
  return Math.floor(s);
}

// Nightly reset bookkeeping. When a timer's last_reset_date is behind today,
// everything accrued up to the end of that day gets banked to that day and the
// clock restarts at today's midnight (running) or zero (paused). Time "run"
// across a multi-day server outage between those two boundaries is dropped —
// the machine was off; nobody billed it.
export function rollover(timer, todayStr) {
  if (timer.last_reset_date >= todayStr) return null;
  const boundaryMs = localMidnightMs(addDays(timer.last_reset_date, 1));
  return {
    bankSeconds: elapsedSeconds(timer, boundaryMs),
    bankDate: timer.last_reset_date,
    restartIso: new Date(localMidnightMs(todayStr)).toISOString(),
  };
}
