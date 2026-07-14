// Clock-display ticking. A bare setInterval(…, 1000) drifts against the
// moment the rendered second actually changes (which is anchored to when the
// timer payload was fetched), so the display periodically hangs ~2s and then
// jumps two counts. Instead, compute the delay to just past the NEXT
// whole-second boundary relative to the anchor and reschedule every tick.

// ms until (now - anchor) next crosses a whole second, plus a small epsilon
// so the tick renders after the boundary, never a hair before it.
export function msUntilNextSecond(nowMs, anchorMs, epsilonMs = 25) {
  const frac = (((nowMs - anchorMs) % 1000) + 1000) % 1000;
  return (1000 - frac) + epsilonMs;
}

// Self-rescheduling aligned ticker. Calls onTick just after every boundary;
// returns a cancel function. Re-create whenever the anchor changes.
// `host` supplies setTimeout/clearTimeout — the PiP float passes its own
// window, whose timers stay unthrottled while the opener tab is hidden.
export function startAlignedTick(anchorMs, onTick, host = globalThis) {
  let handle;
  const schedule = () => {
    handle = host.setTimeout(() => { onTick(); schedule(); }, msUntilNextSecond(Date.now(), anchorMs));
  };
  schedule();
  return () => host.clearTimeout(handle);
}
