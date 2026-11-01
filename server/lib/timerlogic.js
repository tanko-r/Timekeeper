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

// Fix a run's start and/or stop time after the fact (forgot to stop; stopped
// late). Pure: takes the timer row plus the day's boundaries and returns the
// new column values, or { error }. The day-accumulator model stays intact —
// the run's length changes, so accumulated_seconds changes by the same amount.
//
//   req          { startMs?, stopMs? } (epoch ms)
//   nowMs        the current time
//   midnightMs   start of today (local)
//   prevMidnightMs  start of yesterday (local)
//
// A run left going through midnight began yesterday. Its start is read-only,
// but its stop may be moved back into yesterday: `rewindSeconds` is how much
// of the time already banked to yesterday's entry has to be taken back.
export function adjustRun(timer, req, { nowMs, midnightMs, prevMidnightMs }) {
  const { startMs, stopMs } = req;
  if (startMs == null && stopMs == null) return { error: 'Give a start or stop time.' };
  if (startMs != null && startMs > nowMs) return { error: 'The start time is in the future.' };
  if (stopMs != null && stopMs > nowMs) return { error: 'The stop time is in the future.' };
  if (startMs != null && startMs < midnightMs) return { error: 'The start time must be today.' };

  const parse = (iso) => (iso ? Date.parse(iso) : null);
  const acc = timer.accumulated_seconds;

  if (timer.running) {
    const segStart = parse(timer.last_started_at);
    const runStart = parse(timer.last_run_started_at) ?? segStart;
    const overnight = runStart < midnightMs;
    if (startMs != null && overnight) {
      return { error: 'This run began yesterday (overnight), so its start cannot be changed here.' };
    }
    const newStart = startMs ?? segStart;
    if (stopMs == null) {
      return {
        running: 1, accumulatedSeconds: acc, rewindSeconds: 0,
        lastStartedAt: new Date(newStart).toISOString(),
        lastRunStartedAt: new Date(startMs).toISOString(),
        lastStoppedAt: timer.last_stopped_at,
      };
    }
    let rewindSeconds = 0;
    let newAcc;
    if (stopMs >= newStart) {
      newAcc = acc + Math.round((stopMs - newStart) / 1000);
    } else if (overnight && stopMs >= runStart) {
      if (stopMs < prevMidnightMs) {
        return { error: 'This run is more than a day old. Fix the earlier day’s entry by hand.' };
      }
      newAcc = 0;
      rewindSeconds = Math.round((midnightMs - stopMs) / 1000);
    } else {
      return { error: 'The stop time must be after the start time.' };
    }
    return {
      running: 0, accumulatedSeconds: newAcc, rewindSeconds,
      lastStartedAt: null,
      lastRunStartedAt: new Date(overnight ? runStart : newStart).toISOString(),
      lastStoppedAt: new Date(stopMs).toISOString(),
    };
  }

  // stopped
  const oldStop = parse(timer.last_stopped_at);
  if (oldStop == null || oldStop < midnightMs) {
    return { error: 'This time was banked to an earlier day (yesterday). Edit the entry’s hours instead.' };
  }
  const oldStart = parse(timer.last_run_started_at);
  if (startMs != null) {
    if (oldStart == null) return { error: 'The start of this run is not known, so only the stop time can change.' };
    if (oldStart < midnightMs) {
      return { error: 'This run began yesterday (overnight), so its start cannot be changed here.' };
    }
  }
  const newStop = stopMs ?? oldStop;
  const newStart = startMs ?? oldStart;
  if (newStop < midnightMs) return { error: 'The stop time must be today.' };
  if (newStart != null && newStop < newStart) {
    return { error: startMs != null && stopMs == null
      ? 'The start time must be before the stop time.'
      : 'The stop time must be after the start time.' };
  }
  const newAcc = acc + Math.round((newStop - oldStop) / 1000)
    + (startMs != null ? Math.round((oldStart - startMs) / 1000) : 0);
  if (newAcc < 0) return { error: 'That would take today’s total below zero.' };
  return {
    running: 0, accumulatedSeconds: newAcc, rewindSeconds: 0,
    lastStartedAt: null,
    lastRunStartedAt: newStart != null ? new Date(newStart).toISOString() : null,
    lastStoppedAt: new Date(newStop).toISOString(),
  };
}
