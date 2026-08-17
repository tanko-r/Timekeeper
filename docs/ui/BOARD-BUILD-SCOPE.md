# Timer board — the frozen build scope

**Owner decision, 2026-08-17.** `TIMERBOARD-SPEC.md` reached 3,308 lines and 122
criteria over three revisions and two critic gates still rejected it. The
rejections had stopped being about the design and had become one shape: **the
spec promising data the app does not have** — a median stop time with no stop
history in the schema, an undo token with no table, a minutes parser
contradicting the shipped one, a headline figure that measures as zero.

That is over-reach, not a bad core. So the scope is frozen here. The spec
remains the detailed reference for everything IN; this file is the contract for
what gets built now and what waits.

**The critic now judges the running app, not the document.**

---

## IN — this pass

Everything here is buildable against the app as it stands, with **one** additive
schema change (`timers.archived_at`, migration v19). No new narrative path, so
no new way for a sentence to cross a matter boundary.

| # | What | Why it is in |
|---|---|---|
| 1 | **Three bands.** A fixed 3-tile front row he owns, a `Recent` band, and the rest behind one labelled `Show all 84 timers` which **appends and never re-sorts**. | The whole point. 9 tiles of 84 instead of a 4,438px wall. |
| 2 | **Two sections again.** The timer board, and `Today's entries` as a separate list beneath it. | The owner instruction this work exists to carry out. |
| 3 | **Compact multi-column tiles**, 3 across on desktop, honouring the existing density control. | "Very compact… a list of buttons that persist day-to-day." |
| 4 | **Digits 1–9 start the Nth rendered tile**, the cap printed on the tile. | There is currently no shortcut that starts a SPECIFIC timer. |
| 5 | **Manual order is the default**, stated as a requirement. `A–Z` demoted off the face into `⋯`. | Position persistence IS the ask; a one-click A–Z on the face destroys it. |
| 6 | **`/` searches timers AND matters.** One match: `⏎` starts it. No match: one row offers `⏎ Start a new timer — client · matter · number`, which creates it, starts it, and toasts with Undo. | 84 timers, 89 matters. A partner naming a matter with no timer is currently a dead end. The attorney critic called this the single most valuable missing thing. |
| 7 | **The resolution line is always printed** in the filter: `⏎ starts: <name>` or `6 match — keep typing`. | `⏎` on several matches must never fail silently — he has already looked away. |
| 8 | **Archive a timer.** Reversible, touches no entry, still findable by the filter. | At 84 and climbing, a board that only grows is the wall coming back. |
| 9 | **The "ask me each time" dialog.** The server half already exists; silence still means LEAVE THE TIME BEHIND. | The owner decided this on 2026-08-16 and has never been given the choice it promised. |
| 10 | **The stop offer mounts on the tile he pressed.** | The split breaks its selector; left alone it silently relocates to the entries panel and yanks the page. |

## OUT — deferred, each with its reason and what it needs first

Not "dropped". Each is a real improvement that needs a foundation this pass does
not lay. Naming the foundation is the point.

| What | Why it waits | What it needs first |
|---|---|---|
| **The overnight repair** (`Stop at…`, correcting both days in one action) | The flagship idea, and the one that most earns its keep. But after `applyRollovers` the timer row is scrubbed — `accumulated_seconds=0`, the link re-pointed at today's entry, `last_started_at` set to midnight — so nothing in the payload says a rollover happened or names yesterday's banked entry. | A migration recording `rollover_entry_id` + `rollover_last_activity_at` inside the rollover statement, and a `rollover_from{}` projection. Plus a matter-refusal rule: a timer re-pointed overnight puts the two affected entries on different matters, and one press would correct Acme while deleting time on Northgate. |
| **`Typical stop — <time>`** | `timers.last_stopped_at` holds one value, overwritten every stop. There is no stop history anywhere in the schema. | A stop-history table. Until then, only real evidence is offered — never a fabricated `6:00 pm`. |
| **`Stop at…` Undo token** | Specified as a token POSTed back to restore both rows, with no route, table or column anywhere. | Ships with the repair, or not at all. |
| **The close-out stepper** | Genuinely valuable — three missing narratives is ~12 actions and two visual hunts at 5:50pm. But it is a close-out change, not a board change, and bundling it would put the riskiest UI in the same commit as the refactor. | Its own pass, straight after this one. |
| **`40m` → `0.7`** | `server/lib/quickcapture.js` returns `0.67` unquantised for `40m` and `null` for a bare `40`. Making the board's field disagree with the shipped line parser would give two answers for one string. | One shared parser, changed once, with the line-parser tests moved onto it. |
| **The calendar knowing about the untimed call** | The best answer to "I spent 40 minutes and didn't time it" is the app offering it unprompted. | A stage of its own. Named here so it is not mistaken for an oversight. |

---

## The gates this build must pass

Measured at the 84-timer seed (`scripts/lib/demoseed.mjs`), 1440×900 and 412×915.

1. `npm test` — **944 pass / 0 fail** or better. The number only goes up.
2. `node scripts/e2e-smoke.mjs` — clear, apart from the pre-existing aborted
   `/api/agent/todo/events` request, which reproduces on a clean tree.
3. **Nine tiles on screen** at desktop on a cold open, not eighty-four.
4. `Show all` **appends** — the first nine tiles do not move. Assert their
   positions before and after.
5. **Today's entries is its own section** with its own heading.
6. Page height and visible-control count both **well under** the measured
   baseline of 4,438px and 445 controls.
7. The stop offer mounts **on the tile**, not in the entries panel.
8. No horizontal overflow at 412px.
9. Every integrity proof still green, including the Stage 1 exit gate.
