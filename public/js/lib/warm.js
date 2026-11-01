// Decides whether the browser should send the model-warming heartbeat.
// Pure — app.js passes Date.now(); tests pass fixed clocks.
// A visible tab alone is not "in use": a window left open on the desktop is
// visible all day. Only recent real input (mouse, key, touch) counts, so the
// model is released once David stops working.

export const WARM_EVERY_MS = 5 * 60 * 1000;
// Heartbeats stop once the last input is older than this. The server holds
// the model 10 minutes after the final heartbeat, so it unloads between 10
// and 15 minutes after the last input.
export const IDLE_AFTER_MS = 5 * 60 * 1000;

export function shouldWarm({ visible, nowMs, lastInputMs, idleMs = IDLE_AFTER_MS }) {
  return !!visible && nowMs - lastInputMs < idleMs;
}
