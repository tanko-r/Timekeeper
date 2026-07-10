// Running-timer presence in the browser/OS chrome: the tab title (which is
// also what the PWA's taskbar hover preview shows) carries the live clock +
// timer name, and the favicon swaps to a "recording" variant. Pure logic
// here (node:test-able, like the other lib modules); app.js applies it to
// the DOM on a 1s tick.

// Local mirror of ui.js's fmtClock — ui.js pulls in the React/htm vendor
// bundle, which node:test can't load.
function fmtClock(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const hh = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return hh > 0 ? `${hh}:${mm}:${ss}` : `${mm}:${ss}`;
}

// Title for the current timer state. `fetchedAtMs` is when `timers` was
// fetched; wall-clock time since then is added so the title ticks between
// polls (same trick as TimerGrid's liveElapsed).
export function runningTitle(timers, nowMs, fetchedAtMs, base = 'Timekeeper') {
  const t = (timers || []).find((x) => x.running);
  if (!t) return { title: base, running: false };
  const secs = Math.floor(t.elapsed_seconds + Math.max(0, (nowMs - fetchedAtMs) / 1000));
  return { title: `▶ ${fmtClock(secs)} ${t.name} — ${base}`, running: true };
}

// Favicons as data URIs: the idle one mirrors index.html's ⏱; the running
// one adds a red recording dot. Kept together so they can't drift apart.
export const IDLE_ICON =
  "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>&#x23F1;</text></svg>";
export const RUNNING_ICON =
  "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>&#x23F1;</text><circle cx='78' cy='78' r='20' fill='%23e11d48' stroke='white' stroke-width='6'/></svg>";
