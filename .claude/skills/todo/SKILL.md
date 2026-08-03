---
name: todo
description: Use when David runs /todo, or asks to work the backlog, clear TODO.md, or address the UI feedback screenshots in this repo.
---

# Todo

Review and implement TODO.md at repo root.

## Workflow

1. **Read** `TODO.md`. It has two live sections: `## Manual Notes from David:`
   and `## UI feedback (screenshots)` (captured in-app with Alt+drag; each
   line references a PNG in `feedback/`). Read the referenced screenshot
   images — they carry the annotation and the context the text alone doesn't.
2. **Scope it.** If there's one small item, just do it. If there are several,
   or one is large/ambiguous, list what you found with a one-line plan each
   and confirm the order with David before writing code.
3. **Implement** following `CLAUDE.md`: failing test first (`npm test`,
   node:test), business rules as pure functions in `server/lib/*`, thin
   routes, prepared statements, no new runtime deps, no bundler.
4. **Verify** — run `npm test`, and `node scripts/e2e-smoke.mjs` when the
   change touches UI or request flow. If the e2e feedback-capture step flakes,
   check whether master fails the same way before blaming the change.
5. **Ship the change to the running app:**
   - Touched `public/js/**` or `public/css/*.css`? Bump `CACHE` in
     `public/sw.js`. Cache-first SW with no build step — skip this and PWA
     clients keep the old shell forever.
   - Touched `server/**`? `systemctl --user restart timekeeper`.
6. **Clean up TODO.md** — remove or check off the item you finished, and
   **delete the referenced screenshot** from `feedback/`. That directory
   should only hold not-yet-addressed items.
7. **Present the work** before committing: what changed, which files, test
   and e2e results (actual output, not "should pass"), and anything you
   deliberately left undone.
8. **Commit and push.** One atomic commit per logical item — don't bundle
   unrelated backlog entries. Include the TODO.md edit and the screenshot
   deletion in the same commit as the fix they belong to.

## Notes

- Check the design docs before "fixing" surprising behavior — the spec at
  `docs/superpowers/specs/2026-07-06-timekeeper-design.md` flags deliberate
  assumptions (midnight banking, export shape, remote auth).
- This is an installed PWA in daily use — **mostly desktop**, occasionally
  Android. Verify UI work at a desktop viewport first, then sanity-check
  ~412px (watch for toolbars that won't wrap). Don't sacrifice the desktop
  layout for phone width.
- Never put real client, matter, firm, or PII names in code, tests, or commit
  messages — use the house fictional names.
- If an item is a backlog *idea* rather than a concrete fix, say so and offer
  to spec it (see `docs/superpowers/`) instead of implementing it blind.
