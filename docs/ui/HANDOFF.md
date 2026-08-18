# HANDOFF — read this first, then stop reading

**Written 2026-08-17, session 5.** One file to restart a cold session cheaply.
Refresh the mechanical half with `node scripts/handoff.mjs` — it prints git
state, real test counts and what is uncommitted, so a new session never has to
re-derive them with a dozen tool calls.

---

**Second track:** de-identification + the local LoRA experiment lives in
`docs/ai/HANDOFF-deid-finetune.md`. It has its own open question and its own
measured numbers. Nothing below touches it.

---

## 1. THE OPEN QUESTION

> **The timer board is BUILT, green and pushed. Which deferred item comes next?**
>
> - **A — the overnight repair** *(my recommendation)*. A timer left running
>   overnight costs six actions across two pages to fix, and its only warning is
>   a `title` tooltip, which does not exist on the Android PWA he actually uses.
>   The most expensive routine failure in legal billing.
>   Needs: a migration recording `rollover_entry_id` and
>   `rollover_last_activity_at` inside the rollover statement (the rollover
>   currently SCRUBS the row — `accumulated_seconds=0`, link re-pointed at
>   today's entry, `last_started_at` set to midnight — so the client cannot see
>   that a rollover happened at all), a `rollover_from{}` projection, and a hard
>   refusal when the two affected entries sit on different matters. That last
>   one is standing rule 1: a timer re-pointed overnight would otherwise let one
>   press correct Acme and silently delete time on Northgate.
> - **B — the close-out stepper.** Three missing narratives at 5:50pm is ~12
>   actions and two visual hunts through a ten-row list, which is exactly when he
>   abandons the day. No schema change; kept out of the board pass only to keep
>   the riskiest UI out of the same commit as a refactor.
> - **C — polish the board first.** Front-row names still truncate at 345px
>   (the number underneath disambiguates); the "ask me each time" dialog is still
>   unbuilt; `Order` and the activity window now work but are arguably redundant
>   beside the Recent band.
>
> A is worth most. B is cheapest. Both are specified in `TIMERBOARD-SPEC.md`.

**Do not ask him anything else without updating this file first.** He is losing
usage to cold caches, and a question that arrives without a handoff costs him a
whole context to answer.

---

## 2. WHAT IS TRUE RIGHT NOW

- Branch `ui-overhaul-2026-08`, pushed, tree clean.
- **THE BRANCH IS SHARED.** A de-identification lane (`1afcb1f`, `1d2100c`,
  `87d8b11`) is committing here too. `git pull --rebase` before assuming the
  tree is yours; keep commits atomic so the lanes stay separable.
- **986 tests, 986 pass, 0 fail. e2e 50/50 steps.** Re-measure with
  `node scripts/handoff.mjs --test`; never quote a count without its commit.
- `node scripts/e2e-smoke.mjs` clear apart from one aborted
  `/api/agent/todo/events` request on teardown, which **reproduces on a clean
  tree**. Not a regression.
- **STAGE 1 (integrity) is CLOSED**, exit gate included.
- **THE TIMER BOARD IS BUILT** (`e6bccee`, `b03ad2b`, `a45010a`).

| Measured at the 84-timer seed, 1440×900 | Before | Now |
|---|---|---|
| Today page height | 4,438px | **1,315px** |
| Visible controls | 445 | **95** |
| Tiles on screen | 85 rows | **9**, all above the fold |
| `Today's entries` | merged away | its own section |

### ⚠️ Three rules that will bite a fresh session

1. **`data/timekeeper.db` IS LIVE CLIENT DATA.** Tripwire: if "Microsoft"
   appears in a Timekeeper database, STOP. It was checked and it hits. Never
   read, dump or screenshot anything from `data/`. Tests and e2e use temp
   databases. The dummy database is the preview's, at
   `~/Projects/timekeeper-poc/data/`.
2. **e2e IS ORDER-DEPENDENT AND STILL A LITTLE UNSTABLE.** Two causes, one
   fixed and one not. FIXED: the board hides 75 of 84, so a step looking for a
   timer by name found it or not depending on how many existed at that moment
   — every tile lookup now calls `revealAllTimers()` first. NOT FIXED: it
   still flakes when run immediately after `npm test` on this four-core box.
   Run them ONE AT A TIME, and re-run a failure once before believing it —
   three consecutive runs once gave three different failure sets.
3. **Never run an orchestrator with `claude -p`.** Print mode answers once and
   exits; a previous session killed its own five builders at the 600-second
   ceiling and left eight hours of work uncommitted. Use tmux.

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

## 4. WHAT IS BUILT, AND WHAT IS NOT

Scope frozen in **`docs/ui/BOARD-BUILD-SCOPE.md`** — read it before touching the
board; it is the contract, and it names the foundation each deferred item needs.

**Built:** the three bands (front row / Recent / `Show all 84 timers`, which
APPENDS and never re-sorts); digit caps 1-9; a filter that searches timers AND
matters, with `⏎` starting one match and creating-and-starting a matter that has
no timer; the resolution line printed on every keystroke; manual order as the
default with A-Z demoted; archive a timer (migration v19); `Today's entries` as
its own section; the stop offer mounting on the tile he pressed; the grouping
controls applying to Band C.

**In scope but NOT built:** the "ask me each time" dialog. The server half is
safe — silence leaves the hours where the work was done — but he still has no
way to say "move it too".

**Deferred, each with its foundation named in the scope doc:** the overnight
repair, `Typical stop`, the `Stop at…` undo token, the close-out stepper,
`40m → 0.7`, and the calendar knowing about an untimed call.

### The trap that has now bitten three times

`stopchips.js` finds its mount by selector. It is fixed to look for
`.timer-board .timer-tile[data-timer-id]` FIRST — but the failure mode is that
it silently relocates into the entries panel while the e2e assertion still
passes. If you move a control, check `scripts/e2e-smoke.mjs:381` too.

### Two regressions the e2e migration caught, as a warning

Committing `e6bccee` broke the ⋯ on every entry row (the menu looked its row up
in the merged model, which does not hold `e<entry>` keys) and shift-click
range-select (it was handed timers where it expected rows). **Both failed in
total silence.** After any change to the row model, drive the menus and the
selection gestures, not just the render.

---

## 5. HOW TO PICK IT UP

```bash
cd /home/david/Projects/Intapp-clone
node scripts/handoff.mjs          # objective state, cheap
npm test                          # expect 986+ pass / 0 fail
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
