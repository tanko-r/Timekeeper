# Changelog

A run log for the `/todo` skill (see `.claude/skills/todo/SKILL.md`) — every
invocation appends a dated entry here, whether it shipped something or found
nothing to do. This exists because the sidebar's "Run /todo" status can lag
(it polls a tmux window, not a push signal), so this file is the
authoritative record of what actually happened on the last run.

Newest entries first.

## 2026-08-06

- Fixed AI rewrite putting shorthand back into text that had already been
  expanded ("A. Hollowell" → "ah"). The abbreviation glossary is now written
  one-directionally and is dropped entirely from rewrite prompts, which get
  a rewrite demonstration instead. Measured against llama3.1:8b: shorthand
  leaked back in 3 of 3 runs before, 0 of 3 after.
- Picking a timer from the float window's Find box now STARTS that timer,
  instead of only adding it to today's list. It follows the same path as the
  row's ▶ button, so the server's start-exclusivity stops whatever was
  running and that timer gets the close-out pane to narrate.
- Renamed the first field of the New client/matter modal from "Client" to
  "Client number", and reworded its hint and placeholder to lead with the
  6-digit number ("Type the 6-digit number — or type a name to search
  existing clients"). The field always accepted both a number and a name
  search; the generic "Client" label made it read as a free-text name box.

## 2026-08-04

- Fixed the "Run /todo" sidebar button never returning to neutral after a
  run finished. Root cause: its "running" status was derived purely from
  whether the tmux window named `todo` existed — but the window is
  deliberately kept open after the command exits (`exec bash -i`, so David
  can review the transcript later), so the button stayed lit indefinitely.
  Also, the frontend only checked status once on mount, so it wouldn't have
  updated even if the backend had been correct.
  - `server/lib/agentsession.js`: added `paneIsRunningAgent`, which checks
    the pane's foreground command (`claude` vs. the parked `bash`) instead
    of window existence.
  - `server/routes/agent.js`: `GET /api/agent/todo` now reports `running`
    from the pane check; `POST /api/agent/todo` closes a finished, parked
    window before launching a fresh run instead of mistaking it for a live
    one and silently no-op'ing.
  - `public/js/components/runtodo.js`: polls status every 5s (matching the
    existing timer-polling pattern in `app.js`) instead of once on mount.
  - Added this changelog and a step in `.claude/skills/todo/SKILL.md` to
    keep it updated every run.
  - Tests: `npm test` (550 pass, including new/updated coverage in
    `test/agentsession.test.js` and `test/api.agent.test.js`).

- Replaced the 5s status poll above with a push: the launched command now
  pings the server the instant it exits, over Server-Sent Events, instead of
  the button asking every 5 seconds.
  - `server/lib/agentsession.js`: `shellWrap`/`newWindowArgs` splice a
    best-effort `curl` call to a new `/api/agent/todo/done` route into the
    launched command, right before the window is parked.
  - `server/routes/agent.js`: added `GET /api/agent/todo/events` (SSE
    stream held open only while a run is live) and `POST /api/agent/todo/done`
    (broadcasts to connected listeners).
  - `public/js/components/runtodo.js`: opens the SSE connection only while
    `running` is true — nothing to watch otherwise, and it avoids a standing
    connection for the app's whole session. Falls back to a re-check on
    reconnect and on tab-visibility change, in case a push is ever missed.
  - Caught during verification: an always-open SSE connection broke
    `scripts/e2e-smoke.mjs`, whose ~30 `page.goto`/`page.reload` calls wait
    on Puppeteer's `networkidle0` — a persistent connection means network is
    never idle, so every navigation after the first would hang until
    Puppeteer's internal timeout. Scoping the connection to "only while a
    run is live" fixed it structurally (e2e never triggers a real run, so
    the connection never opens during the suite) rather than by loosening
    the wait condition.
  - Tests: `npm test` (561 pass; two unrelated pre-existing flakes in
    `db.test.js`/`aivoice.test.js` that only appear under full-suite
    parallelism, not touched by this change — confirmed by running each
    file standalone and by two clean full-suite reruns).
    `node scripts/e2e-smoke.mjs`: clean.
