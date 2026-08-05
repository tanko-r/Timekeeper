# Changelog

A run log for the `/todo` skill (see `.claude/skills/todo/SKILL.md`) — every
invocation appends a dated entry here, whether it shipped something or found
nothing to do. This exists because the sidebar's "Run /todo" status can lag
(it polls a tmux window, not a push signal), so this file is the
authoritative record of what actually happened on the last run.

Newest entries first.

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
