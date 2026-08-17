# Timekeeper overhaul — status board

**One file to update as work lands.** Every session: read it first, update it
last, commit it with the work. If it disagrees with reality, reality is right
and this file is stale — fix it.

Branch: `ui-overhaul-2026-08` · Last updated: 2026-08-16, session 5

---

## Right now

| | |
|---|---|
| Suites | **944 tests, 944 pass, 0 fail** (session 5). Nothing is red. The 633 pre-audit tests all pass. |
| e2e | `node scripts/e2e-smoke.mjs` clear. It reports one problem — an aborted `/api/agent/todo/events` SSE request on teardown — which **reproduces on a clean tree and predates this work**. Not a regression; not yet chased. |
| **STAGE 1** | **CLOSED**, exit gate included. Every integrity proof in the corpus is green and stays in the suite. |
| Working tree | Clean and pushed. |
| Preview | **LIVE** at `poc-time.rigid-dreamy-sweep.us`, password in the owner decision below. Fictional demo day, own database, port 4748. Re-point it with `scripts/poc-sync.sh`. **Re-seed it** (`--seed`) to pick up the 84-timer dataset. |
| Next action | The timer board (Stage 4, owner instruction). Spec at `docs/ui/TIMERBOARD-SPEC.md`, under revision against two critiques. |

### ⚠️ THE LIVE DATABASE IS LIVE (owner rule, 2026-08-16)

`data/timekeeper.db` holds **real client data** — 89 matters, 83 timers, 421
entries. The owner's tripwire: **if the name "Microsoft" appears in a
Timekeeper database, STOP — that is the live one.** It was checked on
2026-08-16 and it hits.

Never read, dump, screenshot or paste anything derived from `data/`. Tests and
e2e run against temp databases and are safe. `data/`, `shots/` and `feedback/`
are all gitignored with zero tracked files, so nothing has reached the repo.

The house fictional names — Acme, Northgate, Verity, Harbor, Borealis — are
demo data and are safe to work with freely. The parallel dummy database is the
preview's, at `~/Projects/timekeeper-poc/data/`.

### The demo dataset is now eighty-four timers (session 5)

`scripts/lib/demoseed.mjs` seeded five timers. The owner has eighty-three, and
said so: *"we can definitely find ways to make the timers more compact. I use
dozens. so hiding or sorting would be good. don't need to see all at once."*

Five timers hide the entire design problem. The seed now builds 84 across 16
fictional clients in 5 groups, with names up to 44 characters that collide on a
shared client prefix, six worked today (three still unwritten) and one running.
**Every measurement of the timer board must be taken against that seed.**
Seeds in 0.3s.

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
| 1c Scope both AI pools | **done** | `e36d705` — `pickPairs` filters on `cmId`; `matterPeopleList` no longer blends siblings. The `verify.matterctx.thinsibling` residue is green. |
| 1d Pin timer write-backs to their matter | **done** | `209b39c` `32e1995` `528affa` `a01252c` `69227c7` `ecb49a3` `7c30644` `4393482`. Closed: stop-chip provenance, thin-sibling AI, stale state, suggestions, auto-narrative discard, the stash/template fence and the ghost-text pool fence. The last four proofs were red on scaffolding, not on a leak — see above. `verify.timer-repoint-audit` and `verify.entry-repoint-doublefile` were never 1d's; they belong to 1e/1g. |
| 1e Time-loss family | **done** (proofs); one dialog outstanding | `5efcd0d` `535b660` `2524ed2` `a5559c6` `3259565`. Closed 15 of 17: `verify.entry-repoint-doublefile` (4), `verify.splitentry.secondstop` (2), `verify.taskduration-zeroing`, `verify.timer-txn-crash`, `integrity.entries` L3/L4, and 5 of `integrity.closeout`. **Both closed in session 5** (`c0a98f2`, `8f60afe`): `start-for-entry` now leaves a replacement clock on the entry it drops, so a hijacked timer cannot strand a timed, narrative-less draft that nobody can see; and the close-out pre-fill proof was red on its own scaffolding, not on a leak, and is repaired stricter. **Still outstanding, and it is UI not integrity:** the owner's "ask me each time" dialog. The server half is built and safe — silence means the entry does NOT follow a re-pointed timer — but until the dialog exists he has no way to say "move it too". Build it with the timer board. Two defects found that nobody was looking for and had no test: close-out never ran the midnight rollover (an overnight timer lost ten hours), and the first version of the re-file deduct dropped an hour whenever a draft was deleted. Both now have proofs. |
| 1f Export correctness | **done** | `0607bd4` `f0aca28` `5551e88`. Export is now a two-step handshake — the POST builds the file and stamps nothing; only a client confirm, sent after the download really succeeded, writes `exported_at`. Deferring to the response's `finish` event was tried and PROVED useless (a proxy cutting the connection at the first byte still emits `finish` exactly like a healthy delivery). Also: the exported set is now the set on screen; every entry has a stable `tim_ref` so the same hour cannot import twice unrecognised; blank narratives stay out of the file but still SHOW in the preview; the 1000-row ledger cap is opt-in. |
| 1g Records and recovery | **done** | `5551e88` `4ad84db`. Copying a soft-deleted entry no longer resurrects it; copy and quick capture carry AI provenance so model text stops being laundered into the attorney's own voice and fed back as an example of it; a bulk matter move is audited, adopts the new matter's billable flag and rebuilds the narrative in the new client's format; a timer re-point is audited and no longer moves an entry holding work without being asked. **Closed in session 5** (`92d50fb`): see the retraction below. |
| Stage 1 exit: 9-attack verification | **done** | `eb55adc` — `test/integrity.stage1exit.test.js`. Nine attacks plus a tenth that runs all nine against one database in sequence. It caught a real leak on its first run: **copying an entry dropped its matter provenance**, so moving the copy carried the sentence to another client. Kept in the suite, so the gate keeps holding. |

### Stage 2 — Preview
| Launch on `poc-time.rigid-dreamy-sweep.us` | **done** | Live 2026-08-16 at the owner's request, ahead of the Stage 1 exit gate. Password `harbor-lease-2026`. Own worktree at `~/Projects/timekeeper-poc`, own database, port 4748, `timekeeper-poc` user service (enabled). Re-point with `scripts/poc-sync.sh [ref]`; `--seed` rebuilds the demo data. Alt+drag feedback from it writes into the MAIN repo. |

### Stage 3 — Stop-chip content spec
| Matter's own narratives + AI next-step extrapolation | todo | |
| Make the suggestion path cheaper than ignoring it (17 vs 12) | todo | |

### Stage 4 — Screens not yet rebuilt
| **Timer board restored as its own section** | **todo — owner instruction, highest UI priority** | compact multi-column tiles + separate entries list; trimmed controls back on screen. See the owner decision above. Reverses the merge in `timergrid.js`. |
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

## The last three reds, and how they closed (session 5)

All three are green. Each fix was verified the session-4 way — remove the fence,
watch the proof go red on the exact assertion, restore it — and every proof
stays in the suite.

**1. `fence.suggestionmatter` — "NO ENTRY HOLDS ANOTHER MATTER'S SENTENCE"**
(`92d50fb`). The highest-severity item in the project, and a real leak: a live,
exportable entry on Northgate holding a sentence written for Acme.

The existing fence guards the WRITE — text composed for matter A is refused when
the entry has since moved to B. It cannot help when the order is reversed. The
sentence lands on A legitimately and then the ENTRY moves; the matter picker is
the sanctioned way to correct a mis-keyed matter, so the fence deliberately
stands aside for it, and the sentence went along to the other client's bill.

So provenance is recorded when the sentence is composed, in the v18 column
`entries.narrative_src_cm_id`, and RETRACTED when the entry leaves the matter it
was composed for. All matter-moving paths do it: the entry PATCH, the bulk move,
a timer re-point that takes its entry with it, and — caught later by the exit
gate — the COPY, which had been dropping the provenance entirely. The emptied
box refills from the entry's own task lines in the new client's format, so he
gets the new matter's sentence rather than a blank. Every retraction is audited
even on a plain draft, because it deletes text he can see.

**The trap the board warned about was real, and is handled.** `source_cm_id`
cannot answer "did the app compose this": quick capture sends it for a sentence
he TYPED, close-out sends it for a box he may have typed into. Stamping from it
alone would silently delete his own words on an ordinary matter correction — a
worse defect than the leak. The signal is therefore explicit and separate,
`narrative_suggested`, sent only by a surface writing text the app composed and
he has not edited: the stop chip on its pre-fill and its picks but NOT on either
Undo; close-out only while the box still matches the pre-fill exactly; the
editor only when the box still holds the exact sentence a chip put there,
compared by value at save time, and never on the insert-into-existing-text path.
Nine regression tests, and the ones that matter most prove his own words SURVIVE
a move. The unasked stop-chip pre-fill was NOT removed — that pre-fill is a
precondition of `fence.suggestionmatter.test.js:277`.

**2. `integrity.closeout` — the close-out pre-fill** (`8f60afe`). Red on its own
scaffolding, not on a leak, exactly as the four 1d proofs were. It asserted the
lease matter exported one row before checking that row — an assertion that could
only hold BECAUSE of the leak. Repaired and made stricter: the whole phrase list
is held to the standard, the safe fallback is asserted, and the export path is
driven for real with the attorney's own sentence.

**3. `integrity.closeout` — start-for-entry stranding a draft** (`c0a98f2`). A
real defect. `start-for-entry` now leaves a replacement clock on the entry it
drops, so the tile stays on the board carrying that entry's own time and the
6pm surprise becomes a visible row at the moment it is made. Its last assertion
was corrected and this was deliberate: it demanded finalize-day pass an entry
holding 0.1 BILLABLE hours with no sentence, which rule 1 forbids and which
`narrative_empty` is a block to prevent everywhere else in the suite.

## The exit gate found one nobody was looking for

`test/integrity.stage1exit.test.js` (`eb55adc`) runs the nine attacks PLAN.md
specified, plus a tenth that runs all nine against one database in sequence. On
its first run it caught **the copy leak**: copying an entry carried the composed
sentence byte for byte, and `narrative_ai` and `ai_brief` with it, but not
`narrative_src_cm_id` — so moving the copy found nothing to retract. Fixed and
fenced.

**Lesson, alongside session 4's: a sweep that reads every row catches what nine
targeted attacks miss. Keep the gate in the suite.**

## Still to build — the owner's "ask me each time" dialog

The SERVER half landed in `4ad84db`: an entry holding real hours or a real
narrative no longer follows a re-pointed timer, and `move_entry: true` is how a
caller asks for the move. **The dialog that asks him is not built.** Until it
is, the desktop app silently leaves the entry behind with no way to say "move
it too" — safe, but only half the decision he made. Build it on the shared
overlay primitive.

## Owner decision 2026-08-16 — THE TIMER BOARD COMES BACK

**This reverses the single change the teardown called its highest-value one.**
It is an owner instruction and it outranks the teardown, every critic, and the
comment at the top of `public/js/components/timergrid.js` that argues for the
merge. Do not re-merge the lists.

The owner saw the preview and said the timer buttons appeared to be missing.
They were not — but the overhaul had merged the timer BOARD and the day's
entry list into one full-width row list, so his persistent bank of buttons had
become a day log. His words:

> "The original base app has approximately the structure I want. A list of
> buttons that persist day-to-day. I don't recreate them. They are very
> compact, sortable, editable, etc. It should follow that."

The reference is `shots/baseline/dashboard.desktop.light.png`: a **Timers**
board of compact tiles, three across, each showing the name, the clock, the
hours and one start/stop control, with the running one visibly distinct — and
below it, a **separate** "Today's entries" list.

What to build:

- **Two sections again.** A dedicated timer board of compact, persistent
  buttons, with the day's recorded entries as a distinct list beneath it.
- **Compact tiles, multi-column** — not one full-width row per timer. Density
  is the point; he scans a bank of buttons and presses one.
- **Controls back on screen, trimmed.** Grouping (group / client / flat),
  search, A–Z and New timer sit permanently above the board. Import, New
  group and the batch actions stay in the `⋯` menu. The overhaul's complaint
  — fourteen controls before a single timer was visible — is answered by
  trimming, not by hiding all of them.
- **Keep what the overhaul got right:** labelled controls rather than bare
  icons, a touch path for every action, the persisted density control, and the
  `/` timer filter.

Not yet built. It is Stage 4/5 work and it comes after Stage 1 integrity.

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
