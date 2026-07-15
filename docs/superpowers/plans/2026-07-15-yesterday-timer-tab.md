# "Yesterday" Timer Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Yesterday" activity tab to the dashboard timer board — timers whose last start/stop fell on yesterday's calendar day.

**Architecture:** Extract the activity-window math from `timergrid.js` into a pure browser module `public/js/lib/activity.js` (unit-testable under node:test, like `lib/tick.js`), grow the window shape with an optional exclusive `until` bound, and add the Yesterday window. No server changes.

**Tech Stack:** Vanilla ES modules (no-build React 18 UMD + htm frontend), node:test.

**Spec:** `docs/superpowers/specs/2026-07-15-yesterday-timer-tab-design.md`

## Global Constraints

- Frontend is no-build: plain ES modules under `public/js/`; never add a bundler.
- After changing any `public/js/**` file, bump `CACHE` in `public/sw.js` by one.
- TDD: failing test first; `npm test` runs node:test.
- Dates are local-time; the box TZ is America/Los_Angeles (tests pin `process.env.TZ`).
- Commit each task atomically; push when the plan is done.

---

### Task 1: Pure activity-window module

**Files:**
- Create: `public/js/lib/activity.js`
- Test: `test/activity.test.js`

**Interfaces:**
- Produces: `lastActivityMs(timer, nowMs) → number` (epoch ms; `timer` has `running`, `last_started_at`, `last_stopped_at` ISO strings or null)
- Produces: `activityWindows(nowMs) → { 'act-today': {label, since, until}, 'act-yesterday': …, 'act-week': …, 'act-recent': … }` (since/until epoch ms; `until` null = open-ended; key order is display order)
- Produces: `inWindow(ms, win) → boolean` (`since` inclusive, `until` exclusive)

- [ ] **Step 1: Write the failing test**

Create `test/activity.test.js`:

```js
process.env.TZ = 'America/Los_Angeles';
import test from 'node:test';
import assert from 'node:assert/strict';
import { lastActivityMs, activityWindows, inWindow } from '../public/js/lib/activity.js';

// Wed 2026-07-15 15:00 local
const NOW = new Date(2026, 6, 15, 15, 0, 0).getTime();
const iso = (y, m, d, h = 12) => new Date(y, m - 1, d, h).toISOString();

test('lastActivityMs: running timer is active now', () => {
  assert.equal(lastActivityMs({ running: 1, last_started_at: iso(2026, 7, 10) }, NOW), NOW);
});

test('lastActivityMs: stopped timer uses the later of start/stop', () => {
  const t = { running: 0, last_started_at: iso(2026, 7, 14, 9), last_stopped_at: iso(2026, 7, 14, 17) };
  assert.equal(lastActivityMs(t, NOW), Date.parse(iso(2026, 7, 14, 17)));
  assert.equal(lastActivityMs({ running: 0 }, NOW), 0); // never used
});

test('activityWindows: yesterday is a closed [00:00, 00:00) window', () => {
  const w = activityWindows(NOW);
  assert.equal(w['act-yesterday'].label, 'Yesterday');
  assert.equal(w['act-yesterday'].since, new Date(2026, 6, 14).getTime());
  assert.equal(w['act-yesterday'].until, new Date(2026, 6, 15).getTime());
  assert.equal(w['act-today'].since, new Date(2026, 6, 15).getTime());
  assert.equal(w['act-today'].until, null);
  // display order: Today, Yesterday, Week, Recent
  assert.deepEqual(Object.keys(w), ['act-today', 'act-yesterday', 'act-week', 'act-recent']);
});

test('activityWindows: week starts Monday, recent is 14 days', () => {
  const w = activityWindows(NOW); // 2026-07-15 is a Wednesday
  assert.equal(w['act-week'].since, new Date(2026, 6, 13).getTime()); // Mon Jul 13
  assert.equal(w['act-week'].until, null);
  assert.equal(w['act-recent'].since, NOW - 14 * 86400000);
});

test('inWindow: since inclusive, until exclusive', () => {
  const w = activityWindows(NOW);
  const y = w['act-yesterday'];
  assert.equal(inWindow(y.since, y), true);                 // midnight yesterday
  assert.equal(inWindow(y.until - 1, y), true);             // 23:59:59.999
  assert.equal(inWindow(y.until, y), false);                // today 00:00 → Today's
  assert.equal(inWindow(y.since - 1, y), false);            // day before
});

test('a timer used yesterday AND today counts as Today, not Yesterday', () => {
  const w = activityWindows(NOW);
  const t = { running: 0, last_started_at: iso(2026, 7, 15, 9), last_stopped_at: iso(2026, 7, 15, 10) };
  const ms = lastActivityMs(t, NOW);
  assert.equal(inWindow(ms, w['act-today']), true);
  assert.equal(inWindow(ms, w['act-yesterday']), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --test-name-pattern="" test/activity.test.js` (or just `node --test test/activity.test.js`)
Expected: FAIL — `Cannot find module '../public/js/lib/activity.js'`

- [ ] **Step 3: Write the implementation**

Create `public/js/lib/activity.js`:

```js
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/activity.test.js` then the full `npm test`
Expected: all PASS

- [ ] **Step 5: Commit**

```bash
git add public/js/lib/activity.js test/activity.test.js
git commit -m "feat(timers): pure activity-window module with a closed Yesterday window"
```

---

### Task 2: Wire the Yesterday tab into the timer grid

**Files:**
- Modify: `public/js/components/timergrid.js:456-478` (activity block), `:672` (tooltip map), `:1-10` (imports)
- Modify: `scripts/e2e-smoke.mjs` (new step)
- Modify: `public/sw.js:9` (CACHE bump)

**Interfaces:**
- Consumes: `activityWindows(nowMs)`, `lastActivityMs(t, nowMs)`, `inWindow(ms, win)` from Task 1.
- Produces: nothing downstream — `tabList` already builds itself from `Object.entries(ACTIVITY)`, so the new key flows through automatically.

- [ ] **Step 1: Add the import**

In `public/js/components/timergrid.js`, after the line
`import { startAlignedTick } from '/js/lib/tick.js';` add:

```js
import { activityWindows, lastActivityMs, inWindow } from '/js/lib/activity.js';
```

- [ ] **Step 2: Replace the inline activity block**

Replace this block (currently at ~lines 456–478, starting with the
`// ---------- activity tabs` comment and ending with the `activityList`
definition):

```js
  // ---------- activity tabs (2026-07-10 feedback) ----------
  // "Today" / "Week" show timers that actually RAN in the period; "Recent"
  // is the rolling two-week working set, so stale timers fall out of it.
  // Activity = the last time the timer started or stopped (running = now);
  // views sort alphabetically (2026-07-11 feedback — was most-recent-first,
  // which made cards shuffle around as timers ran).
  const nowMs = Date.now();
  const lastActivityMs = (t) => {
    if (t.running) return nowMs;
    return Math.max(
      t.last_stopped_at ? Date.parse(t.last_stopped_at) : 0,
      t.last_started_at ? Date.parse(t.last_started_at) : 0);
  };
  const dayStart = new Date(nowMs); dayStart.setHours(0, 0, 0, 0);
  const weekStart = new Date(dayStart); weekStart.setDate(weekStart.getDate() - ((weekStart.getDay() + 6) % 7)); // Monday
  const ACTIVITY = {
    'act-today': { label: 'Today', since: dayStart.getTime() },
    'act-week': { label: 'Week', since: weekStart.getTime() },
    'act-recent': { label: 'Recent', since: nowMs - 14 * 86400000 },
  };
  const activityList = (key) => shown
    .filter((t) => lastActivityMs(t) >= ACTIVITY[key].since)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
```

with:

```js
  // ---------- activity tabs (2026-07-10 feedback; +Yesterday 2026-07-15) ----------
  // "Today" / "Yesterday" / "Week" show timers that actually RAN in the
  // period; "Recent" is the rolling two-week working set. Window math lives
  // in lib/activity.js (pure, unit-tested); views sort alphabetically
  // (2026-07-11 feedback — most-recent-first made cards shuffle while
  // timers ran).
  const nowMs = Date.now();
  const ACTIVITY = activityWindows(nowMs);
  const activityList = (key) => shown
    .filter((t) => inWindow(lastActivityMs(t, nowMs), ACTIVITY[key]))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
```

- [ ] **Step 3: Add the tab tooltip**

In the tab render (~line 672), replace:

```js
              title=${tab.activity ? { 'act-today': 'Timers that ran today', 'act-week': 'Timers that ran this week (Mon–)', 'act-recent': 'Timers used in the last two weeks' }[tab.key] : undefined}
```

with:

```js
              title=${tab.activity ? { 'act-today': 'Timers that ran today', 'act-yesterday': 'Timers last used yesterday (not yet today)', 'act-week': 'Timers that ran this week (Mon–)', 'act-recent': 'Timers used in the last two weeks' }[tab.key] : undefined}
```

(The `activity-start`/`activity-end` bracket classes key off `act-today` /
`act-recent` and are untouched — Yesterday lands inside the bracket.)

- [ ] **Step 4: Add the e2e assertion**

In `scripts/e2e-smoke.mjs`, insert after the `'dark mode applies'` step:

```js
await step('timer activity tabs include Yesterday', async () => {
  await page.emulateMediaFeatures([]);
  await page.goto(`${base}/#/`, { waitUntil: 'networkidle0' });
  await waitFor('.timer-tabs');
  const labels = await page.$$eval('.timer-tabs .timer-tab-label', (els) => els.map((e) => e.textContent));
  for (const want of ['Today', 'Yesterday', 'Week', 'Recent']) {
    if (!labels.includes(want)) throw new Error(`missing activity tab "${want}" — got: ${labels.join(', ')}`);
  }
});
```

- [ ] **Step 5: Bump the service-worker cache**

In `public/sw.js` line 9, bump the version by one (e.g. `timekeeper-v46` →
`timekeeper-v47` — use whatever the current number is +1).

- [ ] **Step 6: Verify**

Run: `npm test`
Expected: PASS (activity tests + no regressions)

Run: `node scripts/e2e-smoke.mjs`
Expected: all steps pass, including the new `timer activity tabs include Yesterday`.

- [ ] **Step 7: Update TODO.md and commit**

Remove the line `- add "Yesterday" timer grouping` from `TODO.md`
(`## Manual Notes from David:` section).

```bash
git add public/js/components/timergrid.js scripts/e2e-smoke.mjs public/sw.js TODO.md
git commit -m "feat(timers): Yesterday activity tab on the dashboard timer board"
```

---

## Deploy

```bash
systemctl --user restart timekeeper
```
(Frontend-only change, but the restart is harmless and the CACHE bump needs a
fresh serve; installed PWA clients pick up the new shell on next visit.)
