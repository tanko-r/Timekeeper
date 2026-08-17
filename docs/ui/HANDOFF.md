# HANDOFF — read this first, then stop reading

**Written 2026-08-17, session 5.** One file to restart a cold session cheaply.
Refresh the mechanical half with `node scripts/handoff.mjs` — it prints git
state, real test counts and what is uncommitted, so a new session never has to
re-derive them with a dozen tool calls.

---

## 1. THE OPEN QUESTION

> **The timer board's first pass is being built now. When it lands, which
> deferred item comes next?**
>
> - **A — the overnight repair** *(my recommendation)*. A timer left running
>   overnight currently costs six actions across two pages to fix, and its only
>   warning is a `title` tooltip, which does not exist on the Android PWA he
>   actually uses. It is the most expensive routine failure in legal billing.
>   Needs: a migration recording `rollover_entry_id` and
>   `rollover_last_activity_at` inside the rollover statement, a `rollover_from{}`
>   projection, and a hard refusal when the two affected entries are on
>   different matters.
> - **B — the close-out stepper.** Three missing narratives at 5:50pm is ~12
>   actions and two visual hunts through a ten-row list, which is exactly when
>   he abandons the day. Needs no schema change; it is a close-out change, kept
>   out of this pass only to avoid putting the riskiest UI in the same commit as
>   a refactor.
> - **C — something he names instead.**
>
> Both are specified in `docs/ui/TIMERBOARD-SPEC.md`. A is worth more; B is
> cheaper and lower risk.

**Do not ask him anything else without updating this file first.** He is losing
usage to cold caches, and a question that arrives without a handoff costs him a
whole context to answer.

---

## 2. WHAT IS TRUE RIGHT NOW

- Branch `ui-overhaul-2026-08`, pushed. **Stage 1 (integrity) is CLOSED**,
  exit gate included.
- **THE BRANCH IS SHARED.** Commits `1afcb1f`, `1d2100c`, `87d8b11` (a
  de-identification scoring lane) landed between this session's commits and
  are not its work. Someone else is committing here. `git pull --rebase`
  before assuming the tree is yours, and keep commits atomic so the two
  lanes stay separable.
- **944 tests, 944 pass, 0 fail.** The number only ever goes up.
- `node scripts/e2e-smoke.mjs` is clear apart from one aborted
  `/api/agent/todo/events` request on teardown, which **reproduces on a clean
  tree and predates this work**. Not a regression, not yet chased.
- The Today page, measured at his real density for the first time:
  **4,438px tall, 85 rows, 445 visible controls, 12 rows above the fold.**
  That measurement is why the board is being rebuilt.

### ⚠️ Two rules that will bite a fresh session

1. **`data/timekeeper.db` IS LIVE CLIENT DATA.** His tripwire: if the name
   "Microsoft" appears in a Timekeeper database, STOP. It was checked and it
   hits. Never read, dump, screenshot or paste anything derived from `data/`.
   Tests and e2e use temp databases and are safe. The dummy database is the
   preview's, at `~/Projects/timekeeper-poc/data/`.
2. **Never run an orchestrator with `claude -p`.** Print mode answers once and
   exits; a previous session killed its own five builders at the 600-second
   ceiling and left eight hours of work uncommitted. Use an interactive session
   in tmux.

---

## 3. WHAT LANDED THIS SESSION

| Commit | What |
|---|---|
| `c0a98f2` | `start-for-entry` leaves a replacement clock on the entry it drops, so a hijacked timer cannot strand a timed, narrative-less draft nobody can see. |
| `8f60afe` | The close-out pre-fill proof was red **on the fix**, not on a leak. Repaired stricter. |
| `92d50fb` | **The last leak.** A sentence the app composed is now retracted when the entry leaves the matter it was composed for — entry PATCH, bulk move and timer re-point. Nine regression tests, and the ones that matter most prove his OWN words survive a move. |
| `eb55adc` | The nine-attack Stage 1 exit gate — **and the copy leak it caught on its first run** (copying an entry dropped its matter provenance). |
| `307c5d9` | The demo seed rebuilt at 84 timers. Five timers hid the entire design problem. |
| `f27458a`, `185beff`, `fd126b7` | Status board, the three critic reports verbatim, and the frozen board scope. |

**One test assertion was changed deliberately** and it is explained in
`c0a98f2`'s message: the `start-for-entry` proof demanded that close-out
finalize a billable entry with no sentence, which rule 1 forbids. The complaint
it was written about is kept and now stated as the rule.

---

## 4. WHAT IS IN FLIGHT

The timer board, scope frozen in **`docs/ui/BOARD-BUILD-SCOPE.md`** — read that
before touching anything, it is the contract. Ten things in, six deferred with
the foundation each needs named.

**Wave 1** (three parallel agents, verifying now):

| File | State |
|---|---|
| `public/js/lib/boardselect.js` + `test/boardselect.test.js` | new — the pure band-selection rules |
| `server/db.js` (migration v19), `server/routes/timers.js`, `test/timers.archive.test.js` | new — archive a timer |
| `public/css/timers.css` | modified — the tile grid and bands |
| `public/js/components/timertile.js` | new — written by hand, the tile itself |

**Still to write** (the interlocking core, deliberately kept in one pair of
hands because the seams are where the last two attempts broke):

1. `public/js/components/timerboard.js` — presentational: head, controls,
   filter, the three bands, foot. **All state stays in the coordinator.**
2. `public/js/components/timergrid.js` — keeps every piece of state, effect and
   mutation; renders `<TimerBoard>` and, beneath it, `Today's entries`.
3. The matter-searching filter (`⏎` on no match creates and starts a timer).
4. The "ask me each time" dialog — the server half already exists.

### The row model, so nobody has to re-derive it

`timergrid.js` builds `timerRows` (one per timer, carrying the entry it filed)
and `entryRows` (entries no timer owns, keyed `m<cmId>` or `e<id>`).
**After the split: timers become TILES on the board; ALL of today's entries
become the separate list.** The tile drops the narrative entirely — that is what
the entries list is for, and it is how the app looked before the merge
(`shots/baseline/dashboard.desktop.light.png`).

### The trap that has bitten twice

`stopchips.js` finds its mount with
`document.querySelector('.today-list .work-row[data-timer-id=…]')`. The tile is
`.timer-tile`, **not** `.work-row`, so the offer silently relocates into the
entries panel and yanks the page — **and the e2e assertion still passes**,
because it checks `.work-row`. Fix the selector AND
`scripts/e2e-smoke.mjs:381`.

---

## 5. HOW TO PICK IT UP

```bash
cd /home/david/Projects/Intapp-clone
node scripts/handoff.mjs          # objective state, cheap
npm test                          # expect 944+ pass / 0 fail
```

Read, in this order, and nothing else until you need it:

1. **this file**
2. `docs/ui/BOARD-BUILD-SCOPE.md` — what is being built and what is not
3. `docs/ui/STATUS.md` — the standing owner rules and the stage tracker

`docs/ui/TIMERBOARD-SPEC.md` (3,308 lines) and
`docs/ui/TIMERBOARD-CRITIQUES.md` are REFERENCE. Do not read them start to
finish; grep them for the thing you are building.

### Gates before anything is called done

Measured at the 84-timer seed, 1440×900 and 412×915:
`npm test` 944+/0 · e2e clear · **nine tiles on a cold open, not eighty-four** ·
`Show all` appends and the first nine do not move · `Today's entries` is its own
section · page height and control count well under 4,438px / 445 · the stop
offer mounts on the tile · no horizontal overflow at 412px.

### After changing any `public/js/**` or `public/css/*.css`

**Bump `CACHE` in `public/sw.js`** — cache-first service worker, no build step,
so nothing else tells an installed PWA to update. It is at `timekeeper-v102`.
Only the person holding the whole change may edit `sw.js`; agents may not.
