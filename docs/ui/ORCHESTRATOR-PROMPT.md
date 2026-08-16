You are the orchestrator for the Timekeeper integrity work. Work in
/home/david/Projects/Intapp-clone on branch ui-overhaul-2026-08.

READ FIRST, in this order:
1. docs/ui/STATUS.md — the status board. Update it as work lands; it is the
   one file that carries state between sessions.
2. docs/ui/PLAN.md — the staged plan. You are executing STAGE 1 ONLY.
3. docs/ui/INTEGRITY.md — the 33 confirmed defects and why each matters.
4. docs/ui/BRIEF.md — the contract, especially the three owner rules at the
   top of the constraints: data integrity above all, desktop first, and this
   is fundamentally a timers app.

YOUR SCOPE THIS SESSION: Stage 1 of PLAN.md — integrity — items 1a through
1g, then the Stage 1 exit test. Do not start Stage 2 (the preview), Stage 3
(the stop-chip spec) or anything later. If you finish Stage 1 and its exit
test passes, stop and report; the owner decides what comes next.

HOW TO WORK

Use the Workflow tool for fan-out, with a fresh critic separate from every
builder. Keep file scopes disjoint across parallel agents, or run them one at
a time. Prefer several small workflows over one large one: two sixteen-agent
waves were lost to usage limits in the previous session, and small committed
stages are what made that survivable.

Commit and push after EACH of 1a through 1g. Never batch them to the end.
Run `npm test` and `node scripts/e2e-smoke.mjs` one at a time, never
concurrently with a screenshot run — this box has four cores and the e2e
timeouts flake under load.

Agents must not edit public/sw.js or public/index.html; you own those and
bump the service worker cache version yourself at each commit that changes
public/js or public/css.

THE TESTS ARE THE SPECIFICATION

test/integrity.*.test.js and test/verify.*.test.js contain tests that FAIL ON
PURPOSE, one per confirmed defect, written by the auditors who proved them.
`npm test` currently reports 973 tests with 141 failing. Those failures are
the work list. The count is higher than the 91 the audit started with because
Stage 1d's builders added proof tests of their own; measured on this box, the
same suite was 811 pass / 183 fail before 1d landed. A defect is fixed when
its test passes and remains in the suite. Never delete or weaken one of those
tests to make a suite green — if a test is wrong about the intended
behaviour, say so explicitly in your report and explain why, but do not
quietly remove it.

The 633 tests that predate the audit must all keep passing.

START HERE — finish 1d, then go on to 1e

1a, 1b and 1c are committed. Most of 1d is committed too (`209b39c` through
`2173243`). The working tree is clean and pushed; confirm that with `git log`
and `git status` rather than taking this paragraph's word for it.

Four leaks that 1d opened are still red, and they are your first work:

  verify.timerstash.repoint      LEAK 4  — reaches the export CSV
  verify.stashfollow.matterb     LEAK D  — reaches the export CSV
  verify.timer-template-repoint  LEAK    — reaches the export CSV
  verify.ghosttext-matterswitch  LEAK    — Tab over a slow link (browser test)

The first three share a shape: the server-side fence that disarms a timer's
narrative stash on a matter change now holds, but the sentence still reaches
the exported CSV under the other client's number. Look at the export path
before assuming three separate causes.

Then continue with 1e (time loss), 1f (export correctness) and 1g (records
and recovery), and finish with the Stage 1 exit test.

DO NOT RUN YOURSELF, OR ANY ORCHESTRATOR, WITH `claude -p`. Print mode
answers once and exits: the previous orchestrator killed its own five
builders at the 600-second background ceiling and quit mid-1d, and its work
sat uncommitted for eight hours. Run in an interactive session in tmux.

THE LINE YOU ARE ENFORCING

A NARRATIVE — the client-facing sentence that lands on a bill and describes
work on a specific matter — may never cross a matter boundary, including
between two matters of the SAME client. Reusable phrasing is different and IS
shared by design: the phrasebook, ghost text and text expansions stay shared;
do not scope them per matter and do not report their sharing as a defect. The
distinction to implement everywhere is: a whole narrative sentence is never
shared; reusable wording is.

And no time may be lost: nothing dropped, double-counted, or marked exported
without reaching the file.

REPORTING

Update docs/ui/STATUS.md as each item lands — mark the stage tracker, refresh
the measurements if they change, and add anything the next session must know.
When you stop, leave the tree committed and pushed, with STATUS.md accurate.

Write your final summary for the owner: a working attorney, not a developer.
Lead with what is now safe that was not, in plain language, and restate any
shorthand rather than assuming it. Say plainly what you could not finish.
