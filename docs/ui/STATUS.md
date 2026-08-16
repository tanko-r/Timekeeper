# Timekeeper overhaul — status board

**One file to update as work lands.** Every session: read it first, update it
last, commit it with the work. If it disagrees with reality, reality is right
and this file is stale — fix it.

Branch: `ui-overhaul-2026-08` · Last updated: 2026-08-16, session 4

---

## Right now

| | |
|---|---|
| Suites | **913 tests, 862 pass, 51 fail** — the failures are deliberate leak proofs, not regressions. The 633 pre-audit tests all pass. |
| e2e | `node scripts/e2e-smoke.mjs` ALL CLEAR — re-verified 2026-08-16 after 1e landed |
| Working tree | Clean and pushed. |
| Preview | Infrastructure ready, **not started** — blocked on Stage 1 |
| Next action | Stage 1f (export) and 1g (records), then the last two 1e items, then the Stage 1 exit test |

### Correction to the test counts (session 4)

The board previously said "973 tests, 141 fail". **That was arithmetic, not a
measurement** — someone added 832 pass + 141 fail and wrote the sum as the
total. Measured on this box, the suite has always been **902 tests**. At the
start of session 4 it stood at 832 pass / 70 fail. Regenerate the real numbers
any time; never infer them:

```bash
npm test > /tmp/tk.txt 2>&1
grep -E "^ℹ (tests|pass|fail)" /tmp/tk.txt
grep -oE "^test at (test/[^:]+):" /tmp/tk.txt | sed 's/test at //; s/:$//' | sort | uniq -c | sort -rn
```

### What session 2 left behind

Session 2 ran as a headless `claude -p` orchestrator. Print mode answers once
and exits, so it terminated its own five builders at the 600-second ceiling
and quit mid-1d, leaving their work uncommitted in the working tree. Nothing
was lost. Session 3 reviewed the nine files, repaired one defect in them (a
raw NUL byte written into `ghosttext.js`, which made git treat the file as
binary), and committed the work in seven pieces.

**Do not run an orchestrator with `-p`.** Start it in a tmux window so it
survives its own subagents.

### The four leaks 1d left open were not leaks (session 4)

The session-3 handoff said the stash/template/ghost fences held "but the
sentence still reaches the exported CSV". **It does not.** Session 4 drove all
four to a real database row and to a real browser, and found the code correct
in every case. All four proofs were red on their own SCAFFOLDING, which had
been written against the leaking build and stopped working once the leak was
closed:

| Proof | Why it was red | Not |
|---|---|---|
| `verify.timerstash.repoint` LEAK 4 | fence blanks the entry → `finalize` 422 `narrative_empty`, so the CSV assertion never ran | a CSV leak |
| `verify.stashfollow.matterb` LEAK D | same 422 | a CSV leak |
| `verify.timer-template-repoint` LEAK | same, plus it stopped inside the 2-second misclick grace, which deletes the untouched entry → `finalize` 404 | a CSV leak |
| `verify.ghosttext-matterswitch` LEAK | ghost is null, so Tab appends nothing and the field keeps the "Re" the attorney typed; the assertion demanded `''` | a Tab leak |

Every repair made the proof **stricter**, not looser — each now reads the
stored row before writing anything of its own. Each was verified by
temporarily removing the fence it guards (`disarm` in `timers.js`; both pool
fences in `ghosttext.js`) and confirming the proof goes red again, with the
ghost-text one reproducing the full leak: Acme Holdings' whole sentence stored
on a Verity Health entry. Commits `7c30644`, `4393482`.

**Lesson for the next session: a red proof is not evidence of the defect it
was written for. Read where it actually fails before believing its title.**

### Correction to session 1's handoff

Session 1 reported the fence as uncommitted. It was not. The usage limit hit
**after** the commit, so `e36d705` — whose message says only "docs" — in fact
carries all of 1a, all of 1b, and most of 1c. Session 2 verified this by
diffing that commit and by running both suites. The commit message is
misleading but the code is correct; the history is already pushed and is not
being rewritten to fix a message.

---

## Stage tracker

Mark each item `todo` / `doing` / `done` with the commit that closed it.

### Stage 1 — Integrity (blocks everything)

| Item | State | Notes |
|---|---|---|
| 1a Land the written fence | done | `e36d705` (bundled into the docs commit) — `integrity.fence` 17/17 green |
| 1b Scope `matterSuggestions` | done | `e36d705` — the sibling-narrative UNION arm is gone; `source` labels are honest |
| 1c Scope both AI pools | mostly done | `e36d705` — `pickPairs` filters on `cmId`; `matterPeopleList` no longer blends siblings. Residue: `verify.matterctx.thinsibling:404` |
| 1d Pin timer write-backs to their matter | **done** | `209b39c` `32e1995` `528affa` `a01252c` `69227c7` `ecb49a3` `7c30644` `4393482`. Closed: stop-chip provenance, thin-sibling AI, stale state, suggestions, auto-narrative discard, the stash/template fence and the ghost-text pool fence. The last four proofs were red on scaffolding, not on a leak — see above. `verify.timer-repoint-audit` and `verify.entry-repoint-doublefile` were never 1d's; they belong to 1e/1g. |
| 1e Time-loss family | **mostly done** | `5efcd0d` `535b660` `2524ed2` `a5559c6` `3259565`. Closed 15 of 17: `verify.entry-repoint-doublefile` (4), `verify.splitentry.secondstop` (2), `verify.taskduration-zeroing`, `verify.timer-txn-crash`, `integrity.entries` L3/L4, and 5 of `integrity.closeout`. **Two left, both in `integrity.closeout`:** the mid-day re-point test needs the owner's "ask me each time" decision built (above); the start-for-entry proof is red on a REAL defect — the hijack strands a timed, narrative-less draft that now blocks close-out. Two defects found that nobody was looking for and had no test: close-out never ran the midnight rollover (an overnight timer lost ten hours), and the first version of the re-file deduct dropped an hour whenever a draft was deleted. Both now have proofs. |
| 1f Export correctness | todo | 8 confirmed defects · 27 red tests: `integrity.export` (10), `verify.tim-draft-reexport` (3), `verify.export.rounding` (3), `verify.csv-duration-vs-entrytotal` (3), `verify.export-stamp-nofile` (2), `verify.export-stamp-before-response` (2), `verify.export-blank-narrative` (2), `verify.export-scope-widening`, `verify.csv-entrytotal-repeat` |
| 1g Records and recovery | todo | 5 confirmed defects · 17 red tests: `verify.bulk-setcm-recoverability` (4), `verify.bulksetcm.billingformat` (4), `verify.copy.softdeleted` (3), `verify.copy.aiprovenance` (2), `integrity.entries` L5/L6/L7/L8, `verify.timer-repoint-audit`, `verify.quickcapture.aiprovenance`, `integrity.ai`, `fence.suggestionmatter`, `integrity.closeout` close-out pre-fill |
| Stage 1 exit: 9-attack verification | todo | must find nothing |

### Stage 2 — Preview
| Launch on `poc-time.rigid-dreamy-sweep.us` | blocked | needs Stage 1 exit |

### Stage 3 — Stop-chip content spec
| Matter's own narratives + AI next-step extrapolation | todo | |
| Make the suggestion path cheaper than ignoring it (17 vs 12) | todo | |

### Stage 4 — Screens not yet rebuilt
| Ledger: pagination, export-as-dialog, drop subnav | todo | |
| Calendar: roving grid, day-tap, empty weeks, fold Stats | todo | |
| Settings: one row component, theme first-class | todo | |

### Stage 5 — Desktop craft
| Editor control trim (12 → 10) | todo | |
| Desktop density pass; Comfortable 2.07× spread | todo | |
| Desktop fixed chrome 97px → target under 60px | todo | |
| Motion, empty states, shortcut overlay audit | todo | |

### Stage 6 — Close out
| Standing critic whole-app review | todo | |
| Progress page refreshed and republished | todo | |

---

## Done so far

| Wave | What landed | Commit |
|---|---|---|
| 0 | CSS split into 8 modules; design tokens; both themes designed; responsive shell; mobile fences in the harness | `67293b9` |
| 0b | One overlay primitive for every dialog; close-out gained touch controls; accent rationed; dark interactive states | `31f0768` |
| 1 | Four destinations; run bar everywhere; quick capture visible; timer grid and entry list merged | `856a415` |
| 1b | Preamble cut; footer folded into bottom bar; list keyed by matter; hours tap-editable | `9114c9a` |
| 2b-1 | Narrative-first editor with Done; close-out skips finished work; three menu components became one | `e54bfca` |
| 2b-3 | Stop-chip contamination fix + regression test; desktop craft fixes | `d2b46c9` |
| 1d | Timer re-point disarms the narrative stash and template; ghost-text pool kept with its matter; entry editor keyed by its record and flushing queued saves; a chosen narrative no longer overwritten by the task-line join; AI suggestions naming another matter refused; the four remaining proofs driven past their stale scaffolding | `209b39c`…`4393482` |

## Measurements — the scoreboard

All on a 390×844 phone unless noted, measured on the rendered app.

| | Before | Now | Target |
|---|---|---|---|
| Today page height | 2,639px | 1,292px | — |
| First control that starts a timer | y=978 | y=328 | — |
| Complete work rows above the fold | 0 | 2 (4 compact) | 4 |
| Visible controls on Today | 64 desktop / 69 mobile | 43 / 39 | — |
| Five-entry day, ignoring suggestions | 18 measured (~22 est.) | 12 | 12 |
| Five-entry day, taking every suggestion | 23 | 17 | ≤13 |
| Desktop fixed chrome | 49px | 97px | under 60px |

---

## Owner decision 2026-08-16 — re-pointing a timer that already filed hours

Asked because the integrity corpus contradicted itself: `integrity.closeout`'s
re-point test asserts the entry must NOT follow the timer to the new matter,
while `integrity.entries` LOSS L7 asserts it must ("documented behaviour").
One of them had to be wrong.

**The owner chose: ask him each time.** When a timer whose linked draft entry
already holds filed hours is re-pointed to a different matter, the app puts the
choice to him — leave that time on the old matter, or move it too.

What that means for the implementation:

- The API must be **explicit**. `PATCH /api/timers/:id` takes a flag saying
  whether the linked entry moves. **Absent means DO NOT MOVE** — the safe
  default, because moving it carries the old matter's narrative across a matter
  boundary, which rule 1 below forbids absolutely. Never infer the answer.
- The prompt appears only when there is something to lose: a linked, live,
  draft entry that already holds hours or a narrative. A matterless quick timer
  being given its first matter is NOT this case — that text was never written
  against another matter, so it follows the timer silently, as today.
- `integrity.entries` LOSS L7 is about the AUDIT RECORD, not about the move. It
  must pass the explicit "move it too" flag and keep asserting that the move is
  audited and recoverable. That is a scaffold repair, not a weakening.

Not yet built — it is the last open piece of 1e and it touches
`server/routes/timers.js`, the timer edit dialog, and the shared overlay
primitive.

## Owner decision 2026-08-16 — all billing is in tenths of an hour

Asked because the bracketed allocations in a narrative ("Reviewed the lease
(0.8); drafted email (0.5).") are formatted to the billing increment, while the
amount actually charged on that line could be a different number such as 0.75.
The sentence and the charge could disagree.

**The owner's words:** *"Round it. All billing should be done in 1/10 hr
increments. Client will never see this anyway. It is exported and manually
added to Intapp."*

So the CHARGE moves, not the display. Every stored, billed and exported figure
— the entry total and every task line — is a multiple of the increment
(0.1 by default), rounded up, **quantised at the point of storage**. A figure
like 0.75 is never stored and never exported.

This is the decisive answer to the whole "screen hours, CSV hours and .TIM
hours disagree" family: quantise once on write and all three surfaces agree by
construction, with no formatter kept in sync. It also makes `durationLabel`'s
existing `toFixed` correct rather than lossy, so the three copies of the hours
formatter do NOT need to be reconciled — an earlier plan to do that rested on
a misreading and would have made the narrative print 0.75 while the ledger
said 0.8.

## Standing owner rules — never re-litigate these

1. **Data integrity above all.** A narrative may never cross a matter
   boundary, including between two matters of one client. Phrasebook, ghost
   text and text expansions are shared by design. AI example pairs come from
   the same matter or are synthetic. No time or narrative may be lost,
   dropped, double-counted, or marked exported without reaching the file.
2. **Desktop first.** Desktop wins any trade against phone quality; desktop
   density is a feature; keyboard is first-class. The phone gets the core loop
   done well, not feature parity.
3. **It is fundamentally a timers app.** `/` filters the timer list on Today
   and searches entries elsewhere — a deliberate fork, never to be "fixed".
   Compact is the right default provided rows expand and density persists.

## Open questions for the owner

- May the AI next-step extrapolation draw on anything beyond that matter's own
  narratives? (Assumed no.)
- Does the live database contain anything that should not be in it? A scan
  found only fictional names in tracked files, but only he can recognise a
  real client name.
