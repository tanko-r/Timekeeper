# Integrity audit — can this app misbill?

Written 2026-08-15. Six independent audits, then a separate skeptic for each
claim whose default answer was "refuted" and who had to point at a real
database row before confirming. 56 claims were made; **33 were confirmed** — 8
critical, 16 high, 5 medium, 4 low. Every confirmed defect is reachable in
ordinary use.

Each confirmed defect has a test that fails on purpose to prove it. Those tests
live in `test/integrity.*.test.js` and `test/verify.*.test.js`. `npm test`
currently reports 902 tests, 811 passing and 91 failing; **the failures are the
proofs, not regressions.** The 633 tests that existed before the audit all
still pass.

---

## 1. The answer, in one paragraph

**Yes. As the code stands today, this app can put one client's words on another
client's bill, and it can lose your time — including during export.** None of
it requires you to do anything unusual. The three worst paths are: a matter
with little history is offered a *sibling matter's* actual billing sentences
and will finalize and export one without you ever touching a narrative;
re-pointing a timer at a different matter mid-day re-bills the morning's hours
*and* the morning's narrative to the new matter; and the export marks entries
as exported before the file has reached you, so a failed download loses that
time silently. A fix for the first family was written but the session ran out
of usage before it landed — the code is in the working tree, uncommitted, and
its own tests pass.

---

## 2. Confirmed defects, ranked by what they would cost you

### A. One matter's words on another matter's bill

1. **A thin matter inherits its sibling's sentences, and they export.** When a
   matter has fewer than five phrases of its own, the suggestion endpoint
   blends in phrases from other matters of the same client — and that blend
   includes whole billing narratives, not just reusable wording. Stop the
   timer, dismiss the panel, press `c`, press Finalize and export: the entry
   finalizes carrying the sibling matter's sentence. Zero taps on a narrative.
2. **Starting a timer stamps another matter's sentence onto it.** The timer's
   stored suggestion is taken from the top-ranked phrase with no check that it
   came from that matter.
3. **The chips claim you wrote it here.** Borrowed sentences render with the
   history icon and the words "You wrote this on this matter before" — about
   text written on a different matter.
4. **Ghost text draws from the same unfiltered pool.** The mechanism is fine
   and shared wording is allowed; the pool is not — it can surface another
   matter's whole sentence.
5. **The AI prompts carry other matters' narratives as examples**, in two
   separate places: the example-pair picker and the voice context. Confirmed
   against a real local model, not only in theory. This is the highest-stakes
   one, because the model can reproduce an example almost verbatim.
6. **A timer's stashed draft narrative follows the timer to a new matter.**
7. **An AI refinement that starts for one matter lands on the timer after you
   have repointed it at another client.** The guard checks only that the timer
   is still running.
8. **The suggestion panel outlives the matter it was built for.** Correcting a
   mis-keyed matter moves the previous client's sentence onto the new one with
   no further action.

### B. Time that goes missing

9. **A resumed timer bills half an hour that never reaches the export file.**
10. **Re-pointing a timer mid-day re-bills the morning's hours to the new
    matter** — the same time counted against two matters.
11. **Moving an entry to another date leaves the hours on the clock**, so the
    next stop files them a second time.
12. **Closing the day finalizes a running timer's entry at a stale total and
    then zeroes the live clock.** The difference is gone.
13. **`start-for-entry` hijacks a paused timer belonging to another entry and
    discards its unfiled seconds.**
14. **A zero-hour entry finalizes and exports as a `0.0` line** — on a
    block-billed client with no warning at all, and with task lines present it
    only warns, so "accept warnings and finalize" locks it at zero.
15. **Task allocations do not have to add up to the hours the entry exports.**
16. **Quarter-hour billing silently changes the total** when time is allocated
    across task lines.

### C. Export defects

17. **Entries are stamped exported even when the response never reaches you.**
    Two windows: the stamp commits before the payload is sent, and a failed
    download leaves the time marked as shipped.
18. **A ledger filtered to one matter exports and stamps a second client.**
19. **A two-row selection exports and stamps every entry in the span.**
20. **A draft ships in the `.TIM` file, is not stamped, and ships again once
    finalized** — double-billed.
21. **Unexported entries past the 1000-row cap are uncounted and out of
    range** — invisible, and never shipped.
22. **Screen hours and file hours disagree** (0.8 on screen, 0.75 in the file),
    and the CSV total, the `.TIM` total and the screen total can all differ on
    one entry.
23. **An inverted date range exports the wrong set.**
24. **`POST /api/export` writes a `.TIM` line with an empty narrative.**

### D. Records and recovery

25. **A bulk matter reassignment is not recorded and cannot be undone**, and it
    leaves the narrative in the previous client's billing format.
26. **Copying an entry drops its AI provenance**, so AI-written text can be
    laundered into the pool of "your own wording".
27. **Quick capture stores AI-written text as your own** for the same reason.
28. **Re-pointing a finalized-once entry performs a matter move with no audit
    record.**
29. **Several dialogs read the record they were opened for rather than the one
    they are showing** — the same shape as the bug already fixed.

---

## 3. What was checked and holds up

- The rounding rule itself (round up to the next tenth) is correct and
  consistently applied where it is applied.
- The narrative-versus-task-line sync logic is sound in the ordinary path.
- Authentication, the remote-access gate and the origin allow-list are sound.
- The phrasebook, text expansions and the *mechanism* of ghost text are
  correctly shared across matters, which is the intended design.
- The overlay and focus primitives introduced during the overhaul do not leak
  state between records.
- The 633 pre-existing tests still pass, so nothing in the UI overhaul broke
  existing behaviour.

---

## 4. Fix plan, in order

1. **Land the server fence already written** (uncommitted in the working tree,
   `test/integrity.fence.test.js` passes 17/17): every write of suggested text
   carries the matter it came from, and the server refuses it when that does
   not match the entry's current matter. This closes family A as a class.
2. **Scope the suggestion endpoint**: share task-line fragments across sibling
   matters, never whole narratives. One function, `matterSuggestions` in
   `server/routes/matters.js`, feeds every leaking consumer.
3. **Scope both AI pools** — `pickPairs` in `server/lib/exemplars.js` and
   `buildVoiceContext` in `server/routes/ai.js` — making same-matter a filter
   rather than a sort key, topped up with synthetic examples.
4. **Pin every timer write-back to the matter it was generated for**
   (`timers.js` start, `ai.js` refinement, the draft stash).
5. **Fix the time-loss family**: timer/entry re-point, date move, close-out of
   a running timer, `start-for-entry`, and zero-hour finalize.
6. **Fix export**: stamp only on confirmed receipt, make the stamped set equal
   the exported set exactly, give every entry a stable `.TIM` identity, remove
   the 1000-row blind spot, and make screen, CSV and `.TIM` totals agree.
7. **Record and make recoverable** every bulk matter move, and carry AI
   provenance through copy and quick capture.

Each fix keeps the failing test that proves it, flipped to passing.

---

## 5. What could not be checked from here

- Whether the live database contains anything that should not be in it. One
  auditor flagged a comment in `server/routes/ai.js` saying a measurement was
  run "against the live database" and inferred exposure. A scan of all tracked
  files found only fictional names (Acme, Northgate, Verity, John Smith), so
  the repo itself looks clean — but confirm this yourself, since only you can
  recognise a real client name.
- The AI paths were exercised against a stub and one real local model run.
  Behaviour with a different model, or with a long conversation, is unproven.
- Nothing here tests the actual firm billing system that consumes the export.
