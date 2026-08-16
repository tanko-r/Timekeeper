# Data-integrity audit — close-the-day and the timer→entry lifecycle

Branch `ui-overhaul-2026-08`. Standard: `docs/ui/BRIEF.md` §"Data integrity:
non-negotiable, and above every other rule here".

Scope audited: `public/js/components/closeout.js`,
`server/routes/entries.js` (`finalizeOne`, `finalize-day`),
`server/routes/timers.js` (`syncToEntry`, `stopAndFile`, `doStart`,
`applyRollovers`, `PATCH /:id`, `start-for-entry`),
`server/routes/matters.js` (`matterSuggestions` — the source of every
pre-filled sentence), `server/lib/{attention,timerlogic,allocate,validation,
phrasebook}.js`, `server/routes/export.js`.

**Proving tests: `test/integrity.closeout.test.js`.** 16 tests, 11 of which
FAIL ON PURPOSE — each failure is a defect below. 5 pass and are guard rails
pinning behaviour that is correct today. Run with
`node --test test/integrity.closeout.test.js`.

Nothing under `public/` or `server/` was modified.

---

## Answers to the questions asked

### 1. When close-out pre-fills a narrative, where does the sentence come from, and is it scoped to that entry's matter?

The chain is:

```
closeout.js valueOf(g)          →  texts[g.key] if the lawyer touched the box,
                                   else (sugg[g.cm.id] || [])[0] || ''
closeout.js useEffect (l.258)   →  GET /api/matters/:id/suggestions, one per
                                   matter that still needs words
routes/matters.js               →  matterSuggestions() → rankPhrases()
```

The client-side scoping is **correct**: `texts` is keyed by group key
(`cm:<id>`, or `entry:<id>` for matterless drafts, which are never merged),
`sugg` is keyed by matter id, and a matterless group resolves to `''` rather
than to some other matter's list. One matter's box can never read another
matter's key.

**The server-side source is not scoped.** `matterSuggestions()` blends in
`SIBLING_PHRASES` whenever the matter's own history is "thin" (fewer than 5
ranked phrases — which is every new matter, and every matter with only two or
three distinct lines of history). `SIBLING_PHRASES` unions two things from
every OTHER matter of the same client:

```sql
-- server/routes/matters.js:28
SELECT et.fragment  ...  WHERE m.client_id = ? AND m.id != ?   -- task fragments
UNION ALL
SELECT e.narrative  ...  WHERE m.client_id = ? AND m.id != ?   -- WHOLE NARRATIVES
```

The second half is the violation. A task fragment ("review lease") is
reusable wording and the brief says share it freely. `e.narrative` is the
client-facing billing sentence — parties, documents, deadlines — and the brief
says it may not cross a matter boundary "not across clients, **and not between
two matters of the SAME client**."

So the answer is: **each pre-filled sentence comes from the phrase ranking for
that entry's matter, and that ranking is contaminated with sibling matters'
real billing narratives.** Cross-client is correctly walled off (guard-rail
test passes); cross-matter-within-a-client is wide open.

### 2. When the sweep accepts several entries at once, can one entry's text land on another?

**Across matters, no.** `acceptAll` and `finalizeAndExport` iterate `needs` and
write `valueOf(g)` only to `g.blank` — the blank entries of that same group.
Group keys are stable and unique.

**Within one matter, yes — by design.** `buildGroups` merges every draft on a
matter into one row with one box, and one Enter writes that sentence onto all
of them. Two genuinely different pieces of work on the same matter (a morning
call, an afternoon drafting session) end the day describing themselves
identically. This is disclosed in the row copy ("across N entries needs a
narrative — this one covers them all") and it does not cross a matter
boundary, so it is not a brief violation — but it is a quality trap worth
flagging to the owner.

One latent client bug: `closeout.js:370` clears the typed text with
`delete n[id]` where `id` is an **entry id**, while `texts` is keyed by
**group key**. The delete therefore never matches. Today the consequence is
benign (the box keeps showing what the lawyer typed instead of resetting to
the phrasebook), but it is dead code guarding a case that will matter as soon
as the key scheme changes. Listed as F9.

### 3. When time is allocated or split, can hours be duplicated or dropped? Does the sum before equal the sum after, always?

No, not always. Three separate failures:

* **Duplicated** — `syncToEntry` writes the *whole day clock* into the linked
  entry (`total_override = hours`, an overwrite, not an add). That is exactly
  right while the link holds, and it double-counts the moment the link goes
  stale, because the abandoned entry keeps the same hours. Proved twice: F4
  (entry moved to another date → 3 hours worked, 5 recorded) and F5 (timer
  re-pointed to another matter → the morning's hours re-billed).
* **Destroyed** — `finalizeOne` zeroes a running timer's clock while the entry
  holds a stale total. F1, the worst finding here.
* **Changed by rounding** — `allocateTenths` quantises to tenths regardless of
  the configured `rounding.increment`. At a quarter-hour increment, splitting
  0.75h across two lines yields 0.8h. F8.

The close-out flow itself never touches hours — it writes narratives and calls
`finalize-day` — so the sweep neither loses nor duplicates time on its own. It
loses time by *locking a total that was already wrong* (F1).

### 4. Can finalizing a day skip an entry silently?

**Skip: no.** `finalize-day` selects every live draft in the range and returns
each id in `finalized` or `blocked`; the close-out panel names every leftover
with the finding that blocked it and a button to open it. Matterless drafts
are blocked (`no_matter`) and surfaced, not dropped.

**Include-without-review: yes.** The client's "did new drafts appear while I
was reviewing?" guard (`closeout.js:396`) runs **only on the `ack` path**. On
the ordinary clean path a draft created between `load()` and the primary press
— a phone stop, another tab, an exclusivity auto-stop — is finalized and
exported without ever appearing on the review list. Listed as F7 (reasoned,
not proved; it is a client-side race).

**Promise-vs-outcome drift:** the panel commits to "Finalize & export 5" from
its own count, but `finalize-day` can refuse some of those 5 (required custom
field, malformed CM number, task-billed client with no task lines). The
shortfall is disclosed afterwards on the closed screen, so nothing is lost —
but the number on the primary button is a forecast, not a guarantee.

### 5. Can a zero-hour entry, or one with an empty narrative, be finalized and exported as a blank line?

**Empty narrative: no.** `narrative_empty` is a hard block and cannot be
acknowledged away (already covered by `test/api.finalize.test.js`).

**Zero hours: yes, two ways** — F6a and F6b. `validation.js` only raises
`zero_duration` when `tasks.length > 0`, and `no_task_lines` is waived for
block-billed clients, so a block-billed entry holding no time at all passes the
gate **in complete silence**, is locked, and becomes a CSV row with duration 0.
With task lines it is merely a warning, and close-out's only affirmative
control on the warn screen sends `ack` date-wide, so one click locks it at
0.0h alongside the good entries.

### 6. Timer side: which entry does a stop write to, and can it be the wrong one?

`stopAndFile` → `syncToEntry` writes to `timer.linked_entry_id`, and only if
the link passes four checks (`timers.js:50`): the entry exists, is not deleted,
is still a draft, `entry.date === today`, and `entry.cm_id === timer.cm_id`.
If any check fails it opens a **new** entry and writes the whole clock into it.

* **Matter changed while it ran** — the wrong entry gets the time, and a
  narrative crosses with it. `PATCH /api/timers/:id` with a new `cm_id`
  *moves the linked draft entry* to the new matter (`associate`, timers.js:317)
  "same entry, same time, same narrative, new matter". So hours already
  recorded and written up against matter A are silently re-billed to matter B,
  carrying matter A's narrative onto matter B's bill. **F5, proved.**
  Separately, the timer's stashed `draft_narrative` deliberately survives the
  matter change and is seeded onto the next entry the timer creates —
  **F3, proved.**
* **Two timers on the same matter** — safe. Each timer owns its own
  `linked_entry_id`, so they file into separate entries and never collide.
  The one exception is `start-for-entry`, which grabs *any* paused same-matter
  timer, re-links it away from its own entry and overwrites its clock —
  discarding any unfiled sub-increment seconds it was holding. **F10, proved.**
* **Day rolled over at midnight** — correct. `applyRollovers` banks
  elapsed-at-the-boundary onto yesterday's entry, resets, and (if still
  running) opens today's entry from midnight. Guard-rail test passes: two
  hours across midnight land as 1.0 + 1.0. Two caveats, both documented in
  the source as deliberate: time is dropped when the app is not polled for a
  whole day, and a sub-increment remainder is dropped to `console.log` with no
  user-visible record (only reachable when rounding is off or set to
  'nearest'; the default `up` rounding makes it unreachable).

---

## Findings

Severity is judged as the brief demands: anything that moves a narrative
across a matter boundary, or loses billable time, is critical or high. None of
these is "minor".

### F1 — CRITICAL — Closing the day destroys the hours a running timer is holding

*Where:* `server/routes/entries.js` `finalizeOne()` lines 518–522, reached from
`POST /api/finalize-day`, which is what `closeout.js finalizeAndExport()`
calls.

*Mechanism:* a timer's time reaches its entry only at **stop** —
`syncToEntry` writes `total_override` there. While the timer runs, the entry's
stored total is whatever the last stop left, and the live number the lawyer
sees in the UI is a client-side tick (`public/js/lib/tick.js`), not data.
Close-out reads the stored total (`Number(d.total || 0)`), counts it in "filing
N of M · X.Xh", and finalizes it. `finalizeOne` then, correctly for its own
purpose (preventing the double-file it was written to prevent), does:

```sql
UPDATE timers SET accumulated_seconds=0, last_started_at=?, linked_entry_id=NULL
```

The elapsed time between the last stop and the close-out is now on neither the
entry nor the clock. The entry is finalized and exported; there is no undo and
no audit row (audit only fires for `ever_finalized` entries being edited).

*Worked example from the test:* start 09:00, stop 11:00 (entry = 2.0h, narrative
written), restart 13:00, close the day at 17:00 without stopping. Six hours
worked. The entry finalizes at 2.0h, the clock is zeroed, **four billable hours
cease to exist** — and `finalize-day` returns `blocked: []`, so there is no
block, no warning, and nothing to acknowledge. The lawyer's only signal that
anything happened is that the timer's clock reads 0.

*Repro:* `node --test test/integrity.closeout.test.js` →
`LOSS: closing the day finalizes a running timer's entry at its stale total and
then zeroes the live clock`. Asserts `entry.total + clock == 6`; gets 2 + 0.

*Suggested direction (not implemented — read-only task):* `finalize-day` should
settle every running timer whose linked entry is in the range before it
finalizes anything — i.e. call the same path `stopAndFile` uses to write the
clock into the entry — or refuse the entry and report it as blocked with
"a timer is still running on this entry". Either way close-out must show the
live figure, not the stale one.

### F2 — CRITICAL — A sibling matter's narrative is served as this matter's suggestion, pre-filled by close-out, and exported onto the bill

*Where:* `server/routes/matters.js:28` `SIBLING_PHRASES` (the
`SELECT e.narrative` half) and `matterSuggestions()` lines 49–53. Consumed by
`closeout.js:199` `valueOf()`, by `ghosttext.js`, by the entry editor, and by
the stop chips.

*Mechanism:* when a matter's own ranked phrase list is shorter than
`THIN_PHRASES = 5`, every other matter of the same client contributes both its
task fragments **and its whole free-text narratives** to the ranking, at weight
0.25. Weight 0.25 is not a wall: three recent uses of a sibling sentence outrank
one own-matter phrase, and a matter with *no* history has nothing to outrank —
`phrases[0]` is then always a sibling's sentence.

Close-out takes `phrases[0]` verbatim as the box's value, and the primary
button's documented contract is that whatever sits in the box is the lawyer's
answer and gets written. So the default, no-keystroke path on a new matter is:
another matter's billing sentence → this matter's entry → the CSV.

*Repro:* two failing tests. `LEAK: a sibling matter's narrative is served as
this matter's top suggestion`, and the end-to-end
`LEAK: the close-out pre-fill writes a sibling matter's narrative onto this
matter's entry and exports it`, which replicates `valueOf` +
`finalizeAndExport` exactly and asserts on the CSV. The failure prints the
actual bill line:

```
2026-08-14,100001-000044,Acme — office lease,billable,Review,0.8,
Telephone conference with J. Ruiz regarding the Borealis share purchase
agreement and the closing conditions schedule,0.8,4
```

*Note:* the endpoint does return `source: 'matter' | 'client'` per phrase and a
top-level `borrowed` flag — every consumer in the close-out and timer paths
ignores both. Two other auditors in this run
(`test/integrity.suggestions.test.js`, `test/integrity.ai.test.js`) found the
same root cause from their own angles, and the AI audit found the same query
feeding `matterAiContext()`, which labels a sibling's sentence
`"The attorney's recent work on this matter"` (`server/routes/ai.js:123`) —
a false statement inside the prompt that writes the next narrative.

*Suggested direction:* keep the sibling **fragment** branch (reusable wording,
explicitly allowed) and drop the sibling **narrative** branch. That preserves
"new matters start warm" without moving a single client-facing sentence across
a boundary.

### F3 — HIGH — A timer's stashed draft narrative follows the timer onto a different matter

*Where:* `server/routes/timers.js:328` ("user text — deliberately SURVIVES
cmChanged") and `syncToEntry`'s seed at lines 76–84.

*Mechanism:* text typed into a timer row before it has an entry is stashed as
`timers.draft_narrative` (`public/js/lib/pip.js`, `narrativeMode() === 'stash'`).
`PATCH /api/timers/:id` clears `suggested_narrative` on a matter change —
correctly, "the suggestion belonged to the old matter" — but deliberately keeps
`draft_narrative`. The next entry the timer creates is seeded with
`narrative_template + draft_narrative`. So a sentence describing matter A's
work is written, automatically and without a keystroke, as matter B's entry
narrative. `narrative_template` behaves identically and is also matter-bound
in practice.

*Repro:* `LEAK: a timer's stashed draft narrative follows a matter change onto
the new matter's entry` — the office-lease entry comes back with "Reviewed the
Borealis share purchase agreement redline from opposing counsel."

*Suggested direction:* clear `draft_narrative` (and re-confirm
`narrative_template`) on a matter change, exactly as `suggested_narrative`
already is. If the stash is worth preserving, preserve it somewhere addressed
by the old matter, not by the timer.

### F4 — HIGH — A moved entry leaves its hours on the clock, and the next stop files them again

*Where:* `server/routes/timers.js:50` (the link-validity test) with
`server/routes/entries.js:438` (`syncTimersToEntry` runs only when the total
changed, and returns early for an entry whose date is not today).

*Mechanism:* editing a draft entry's **date** — "that was actually yesterday" —
leaves the timer linked to it with the full day clock intact. At the next stop
the link fails the `entry.date === dateStr` check, so `syncToEntry` opens a new
entry and writes the *whole clock* into it, while the moved entry keeps the
same hours. Three hours worked, five recorded.

The response does carry `relinked` / `previousTotal`, and `timergrid.js:293`
offers a "Deduct 2.0h" toast — but the over-count is already committed to the
database, and one dismissed toast makes it permanent.

*Repro:* `LOSS: moving an entry to another date leaves the hours on the clock,
so the next stop files them a second time`.

### F5 — HIGH — Re-pointing a running timer re-bills the morning's hours, and its narrative, to the new matter

*Where:* `server/routes/timers.js:317–352` (`associate`).

*Mechanism:* the `associate` path was added to stop a matter change from
double-filing (the F4 shape), and it does. But it does so by moving the linked
draft entry wholesale — "same entry, same time, same narrative, new matter".
When the lawyer re-points a timer mid-day because the *next* block of work is
on a different matter, the *previous* block goes with it: hours already stopped
and written up against matter A are re-keyed to matter B, and matter A's
narrative becomes matter B's narrative. Matter A loses the entry entirely.
Nothing is audited (the entry was never finalized) and there is no undo.

*Repro:* `LEAK/LOSS: re-pointing a timer mid-day re-bills the morning's hours —
and the morning's narrative — to the new matter`.

*Suggested direction:* only associate when the linked entry is *empty of
settled work* — the start-created placeholder case the feature was written for
(no narrative, no stopped time). Where the entry already holds filed hours,
leave it on its matter, unlink, and zero the clock by the amount already filed,
so the next stop starts from zero instead of re-filing.

### F6a — HIGH — A zero-hour entry on a block-billed client finalizes with no warning and exports as a 0.0 line

*Where:* `server/lib/validation.js:51` (`no_task_lines` waived when the client
is block-billed) and `:91` (`zero_duration` requires `tasks.length > 0`).

*Mechanism:* the two rules leave a hole exactly where they overlap. A
block-billed entry with a narrative, no task lines and no override has
`total = 0`, raises **no finding at all**, finalizes clean, and becomes a CSV
row with `duration 0, entry_total 0`. That is the blank bill line the brief
forbids, and from the lawyer's side it reads as a closed, exported day.

*Repro:* `LOSS: a zero-hour entry on a block-billed client finalizes with no
warning and exports as a 0.0 line`.

### F6b — MEDIUM — A zero-hour entry with task lines is only a warning, and one date-wide ack locks it

*Where:* `server/lib/validation.js:91`, `entries.js finalize-day` (`ack` applies
to the whole date), `closeout.js:750` (the warn screen's only affirmative
control is "Accept warnings & finalize").

*Mechanism:* `zero_duration` is ack-able, and close-out's ack is date-wide, so
the single click that clears "narrative is a bit short" on entry 1 also locks
entry 2 at 0.0h. The panel's own hours figure shows the shortfall, but the
warn screen does not repeat it per entry.

*Repro:* `LOSS: a zero-hour entry WITH task lines only warns, so "accept
warnings & finalize" locks it at 0.0h`.

### F7 — MEDIUM — The clean close-out path finalizes and exports drafts it never showed the lawyer

*Where:* `closeout.js:390–407` — the freshness check is inside `if (ack)`.

*Mechanism:* `drafts` is frozen at open. `finalize-day` finalizes **every**
draft on the date, not the ones the panel listed. The client guards this only
on the ack path, with a good reason stated in the comment (a date-wide ack
would acknowledge unseen warnings). On the clean path a draft that appears
mid-review — a phone stop, a second tab, an exclusivity auto-stop — is
finalized and exported unseen. If it carries a seeded `narrative_template` it
passes validation silently.

*Not proved by a test* (client-side race). Fix is one line of scope: run the
same freshness check on both paths.

### F8 — MEDIUM — `allocateTenths` changes the total whenever the firm does not bill in tenths

*Where:* `server/lib/allocate.js:8`, `units = Math.round(total * 10)`. Used by
`POST /api/ai/expand` to split an entry's hours across the task lines the model
proposed.

*Mechanism:* the function's invariant — "the result always sums exactly to the
total" — holds only for totals that are already multiples of 0.1. `rounding.increment`
is a user setting; at a quarter-hour increment every entry total is a multiple
of 0.25 and the split silently changes it: 0.75 → 0.8 (+0.05), 0.25 → 0.3, and
a total of 0.24 rounds **down**, losing time. Existing `test/allocate.test.js`
only ever passes tenths, so the invariant has never been tested where it fails.

*Repro:* `LOSS: allocateTenths silently changes the total when the firm bills in
quarter hours`. Not reachable on the default settings (increment 0.1, mode
`up`), which is why this is medium and not high.

### F9 — LOW — Close-out clears its typed-text map with the wrong key

*Where:* `closeout.js:370`, `setTexts((t) => { const n = { ...t }; delete n[id]; …})`
where `id` is an entry id and `texts` is keyed by group key (`cm:<id>` /
`entry:<id>`). The delete never matches.

Today's effect is benign — the box keeps showing the lawyer's own typing after
the editor closes, which is arguably the better behaviour. It is reported
because it is a silent no-op sitting on the path that reconciles the editor's
writes with the review list, and the next person to change the key scheme will
assume it works.

### F10 — LOW/MEDIUM — `start-for-entry` hijacks a paused timer and discards its unfiled seconds

*Where:* `server/routes/timers.js:540–559`.

*Mechanism:* with no timer linked to the target entry, the route grabs the most
recently used **paused same-matter** timer, re-links it away from its own
entry, and overwrites `accumulated_seconds` with the target entry's total. A
timer holding a sub-increment stretch (a stop under 0.1h files nothing and
leaves the seconds on the clock, by design, waiting for more work) loses it.
Bounded by the minimum increment, so at most ~0.1h per occurrence — but it is a
silent write over live time, and it also detaches a timer from an entry the
lawyer may still be working against.

*Repro:* `LOSS: start-for-entry hijacks a paused timer that belongs to another
entry and throws its unfiled seconds away`.

### F11 — LOW (noted, not proved) — `exported_at` is stamped before the file exists

`POST /api/export` marks `exported_at` on every finalized exportable entry as
part of the response (`export.js:97`), and `closeout.js doExport()` calls
`downloadText` only after that response returns. If the browser refuses or
loses the download, the entries are already marked exported and drop out of the
unexported-attention bucket (`lib/attention.js isUnexported`). The brief says
"no entry marked exported that did not actually reach the file". Mitigating: the
CSV can be re-exported at will from the Export page, and `markExported: false`
exists. Worth a confirm-then-stamp round trip if the flow is touched.

---

## What is correct and must not be "fixed"

Guard-rail tests pin these; leave them alone.

* **Cross-CLIENT narratives are already walled off.** `SIBLING_PHRASES` is
  scoped by `client_id`, so a Northgate matter never sees an Acme sentence
  through this path. Only the same-client boundary leaks.
* **`suggested_narrative` is correctly dropped when a timer changes matter**
  (`timers.js:325`) — the right precedent for fixing F3.
* **The phrasebook, ghost text and expansions are shared on purpose.** The
  mechanism is right; only the *content* of the ranked list is contaminated
  (F2). Do not scope the phrasebook per matter.
* **The stop-chip spec is the correct spec** — last couple of narratives from
  that matter plus one extrapolated line. It is the sibling blend underneath it
  that breaks it.
* **The day-accumulator overwrite is right.** `syncToEntry` writing the whole
  clock into one linked entry is what makes start/stop/start idempotent; the
  bugs are in the cases where the link goes stale, not in the overwrite.
* **`finalizeOne` unlinking and zeroing the timer is right** — it exists to stop
  the 2026-07-10 Acme double-file. F1 is not a case for removing it; it is a
  case for settling the clock into the entry *first*.
* **Midnight rollover is correct** — elapsed banks to the day it was worked, the
  clock restarts at today's midnight, and the entry is never deleted at the day
  boundary.
* **Empty narratives cannot be finalized**, and blocks cannot be acknowledged
  away.
* **Matterless drafts are never merged with each other** in the close-out
  grouping, are blocked from finalizing, and are excluded from the CSV while
  still being counted in the export preview.

---

## Suggested fix order

1. **F1** — time destroyed with no warning and no undo. Everything else is
   recoverable by hand; this is not.
2. **F2** — a real client's sentence on another matter's bill, on the default
   path, with no keystroke.
3. **F5, F3, F4** — the timer-lifecycle trio. F5 and F4 are two halves of the
   same stale-link problem and should be fixed together.
4. **F6a/F6b** — zero-hour lines reaching the CSV.
5. **F7, F8, F10, F9, F11.**

Every one of these needs its regression test to move from failing to passing in
`test/integrity.closeout.test.js` — per the brief, "a fix without a regression
test does not count as fixed". The assertions in that file are written as the
contract; fix the code to satisfy them, do not relax them.
