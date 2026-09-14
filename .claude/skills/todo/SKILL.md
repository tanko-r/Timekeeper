---
name: todo
description: Use when David runs /todo, or asks to work the backlog, clear TODO.md, or address the UI feedback screenshots in this repo.
---

# Todo

Review and implement TODO.md at repo root.

## Workflow

Work items one at a time, autonomously, end to end — read, fix, verify, ship,
commit, push — then move to the next. Don't stop to present a plan or ask for
approval before writing code; the commit history and detailed messages are
the record David reviews after the fact, and each commit is a clean revert
point if one turns out wrong.

1. **Read** `TODO.md`. It has two live sections: `## Manual Notes from David:`
   and `## UI feedback (screenshots)` (captured in-app with Alt+drag; each
   line references a PNG in `feedback/`). Read the referenced screenshot
   images — they carry the annotation and the context the text alone doesn't.
2. **Scope it.** List every item found (silently, or in one short line each —
   no need to wait for confirmation). Order them sensibly: independent, small
   fixes first.
   - Every item here is an active task, not a backlog idea to defer — David
     asking for it means he wants it built now, even a whole new feature.
     Read the existing code first (there is often more built already than
     the TODO line suggests) to see how much of it is a real gap.
   - If real ambiguity remains after that reading — a design choice only
     David can make, not something inferable from the code — ask 1-3 focused
     questions (per his global CLAUDE.md) before writing code. Don't guess at
     a load-bearing decision, but don't stall on a question the codebase
     already answers either.
3. **Implement** following `CLAUDE.md`: failing test first (`npm test`,
   node:test), business rules as pure functions in `server/lib/*`, thin
   routes, prepared statements, no new runtime deps, no bundler.
4. **Verify** — run `npm test`, and `node scripts/e2e-smoke.mjs` when the
   change touches UI or request flow. If the e2e feedback-capture step flakes,
   check whether master fails the same way before blaming the change. If
   verification fails and you can't fix it after a couple of tries, leave the
   TODO.md item in place, note what you tried and why it's blocked, and move
   to the next item rather than committing a broken fix.
5. **Ship the change to the running app:**
   - Touched `public/js/**` or `public/css/*.css`? Bump `CACHE` in
     `public/sw.js`. Cache-first SW with no build step — skip this and PWA
     clients keep the old shell forever.
   - Touched `server/**`? `systemctl --user restart timekeeper`.
6. **Clean up TODO.md** — remove or check off the item you finished, and
   **delete the referenced screenshot** from `feedback/`. That directory
   should only hold not-yet-addressed items.
7. **Commit and push immediately** — one atomic commit per logical item,
   don't bundle unrelated backlog entries, don't batch commits for later.
   Include the TODO.md edit and the screenshot deletion in the same commit
   as the fix they belong to. Also prepend a line to `CHANGELOG.md` at the
   repo root, under today's date heading (`## YYYY-MM-DD`, newest date on
   top — create the heading if today's is missing), summarizing this one
   item; include that edit in the same commit. Write the commit body as a
   revert-quality note, since this is the only record David gets before the
   fact:
   - what was broken or missing, and what the fix does
   - files touched and why each one changed
   - test/e2e results actually observed (not "should pass")
   - anything deliberately left undone or out of scope
   - `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>` trailer as usual
   Push right after each commit — don't accumulate a stack of unpushed work.
8. **Repeat** for the next item until TODO.md's live sections are empty or
   every remaining item is genuinely blocked (verification failed twice, or
   it's waiting on an answer from David).
9. **Update CHANGELOG.md every run, even an empty one.** If step 7 already
   added entries this run, this step is done. If nothing was shipped —
   TODO.md's live sections were already empty, or every item found is
   blocked — commit a single `CHANGELOG.md` line under today's date saying
   so (e.g. "Nothing to do — TODO.md had no live items." or "Blocked on N
   item(s), nothing implemented."), and push it. This file is the
   authoritative record of what a run actually did, independent of the
   sidebar's "Run /todo" status indicator (which reflects tmux window state
   and can lag).
10. **Report** a short summary: items shipped (one line each, with commit
    refs), items blocked and why, questions asked and how they were answered.

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
- A TODO/feedback item that reads like a whole new feature is still an active
  task, not a reason to punt to a separate spec/plan step — build it here,
  end to end, same as a one-line bug fix. Only pause with a clarifying
  question (step 2) when the codebase genuinely doesn't answer it.
