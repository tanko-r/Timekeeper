# Timer board — critic reports on TIMERBOARD-SPEC.md revision 2

Verbatim, 2026-08-16. Three independent lenses. Two rejected the spec.
Kept in the repo so the next session can check whether each finding was
actually closed rather than taking a summary on trust.



---

# THE ATTORNEY CRITIC

# Verdict review — TIMERBOARD-SPEC.md rev 2

Read end to end. This is a serious improvement over what I rejected. The overnight repair (§4.7.1) is the first thing in this project that made me feel like the app was on my side, and the prefix property (§2.3) is a real idea rather than a layout preference. But three of the five moments still don't land, and one of them is the moment the spec itself picked as its design target.

---

## THE FIVE WALKS, WITH COUNTS

### 1. 9:00am cold open, 83 timers → Northgate diligence running

**Best case: 1 action.** If it's in the front row or Recent, I press a digit or tap. Fine.

**Real case: `/` + 3–5 chars + Enter.** Also fine — that part works.

**Finding — MAJOR — §2.2, front-row seeding.** "First run seeds it with the first three timers in manual order." My manual order at 83 timers is whatever accident of creation date the database holds. So on day one my eye-level shelf holds three arbitrary matters, and *nothing in this document ever tells me it's wrong*. R18 correctly refuses to auto-edit it, then stops — refusing to edit is not the same as refusing to notice. Six weeks in, my front row is three closed matters and I don't know it.

**Better:** seed from the three matters with the most hours in the last 14 days. Then, when a front-row tile has had no time for 30 days, print one quiet line inside Band A: `Northgate — fund IV hasn't run in 6 weeks. Swap for Acme — Borealis?` with a one-tap accept and a one-tap dismiss-for-90-days. That's the difference between "it's yours" and "it's yours, and I'm not going to help you."

**Finding — MINOR — §2.2, Band B rule 3.** Monday after two weeks away: rule 2 is empty and rule 3 (14-day backfill) is *also* empty. Band B renders zero tiles under a label that says `Recent`. The spec never says what that draws. My cold open on the worst-attention day of the year is a labelled empty box. Specify it: fall back to 30/90 days before showing nothing, and if genuinely nothing, drop the band label entirely rather than labelling a void.

---

### 2. 2:40pm, partner calls about a matter untouched three weeks. Six seconds.

**This is where the spec argues with itself, and I caught it.**

§2.6 rejects recency-only ordering because "the partner's matter is not the one he touched most recently," and §2.2 concludes "at 2:40 the partner's matter is one of three tiles that have been in the same place." But a matter I have not touched in three weeks is, *by the construction of your own bands*, in neither Band A (curated, 3–6) nor Band B (today + 14 days). It is in the tail of 75. §2.1 even names this as "moment 3," a different moment — the document has quietly redefined the hard case into the easy one and then declared victory over it.

So the only real path is the filter. **Count: `/` + N chars + Enter ≈ 5–7 keystrokes.** Survivable *if* three things hold, and none of them do:

**Finding — BLOCKER — §2.5 / §8.5, the filter is timer-only.** I have 84 timers and 89 matters. When the partner names a matter with no timer, my query returns zero and the filter is a **dead end**. Esc, hunt for `＋ New timer`, name it, save, start it — five-plus actions while a partner listens to me type. And I search by what I *remember*, which is the client and the matter, not the button name I invented in March.

**Better, and this is the single most valuable missing thing in the document:** the filter searches timers **and matters**. Zero-or-few matches puts one row directly under the field:

```
⏎  Start a new timer — Bracken Ridge · reorganization · 100412-000003
```

Enter creates the timer, starts it, and toasts with Undo. One action, from a query that matched no timer at all. That is the six-second path, and it's the only one.

**Finding — MAJOR — §8.5, `Enter` on ≥2 matches fails silently.** Your own §8.5 admits `nor` matches six. With ≥2, Enter "only moves focus" — no toast, no clock, and I have already stopped looking at the screen because I said "sure, let me pull that up." I will lose that hour believing I was billing it. A four-keystroke magic trick whose failure mode is *silence* is not a trick I can trust.

**Better:** print the resolution in the field itself, one line, always: `⏎ starts: Northgate — fund IV formation` or `6 match — keep typing`. I confirm by peripheral glance, never by reading tiles. And on ≥2, consider firing anyway on the most-recently-used match with an Undo toast — a wrong start that costs one tap beats a right non-start that costs an hour.

**Finding — MAJOR — §2.3 / §8.3, digits 4–9 are not muscle memory.** Band B recomposes: the running timer is always first, today's work sorts by recency. Every start reshuffles positions 4–9. §2.3 calls this motion "honest," which it is — and honest motion is still motion. So `1`–`9`, the headline answer to "you could not find a timer without reading it," delivers stable muscle memory for **three timers out of eighty-three**. The other six require me to read the cap, which is reading.

**Better, and cheap:** **within a day, Recent is append-only.** A timer that enters at position 7 stays at 7 until tomorrow's reset; new arrivals append. Positions 4–9 become real for the length of a workday, which is the only horizon that matters. Cost: one sort rule in `boardselect.js`.

---

### 3. 9:04am, a tile reads 15 hours

**Count: 2 actions.** Tap `Stop at…`, tap `6:00 pm`. Toast with one Undo.

This is excellent and I want to say so plainly. Words on the tile face instead of a `title` I can't hover on a phone; one transaction; both days corrected; reversible; refuses to touch a finalized entry. This is the part of the spec that earns the install. Four things still wrong:

**Finding — MAJOR — §4.8, the run bar bypasses the repair.** §4.8 correctly replaces the tile's plain stop with `Stop at…`. But the run bar is fixed to the bottom of every screen and, per the §3.2 sketch, still reads `⏱ 15:04:11 Acme — Borealis [■ Stop]`. That is the closest, fattest, most reflexive stop button on my phone. I will hit it at 9:04 before my eyes reach the board, and it banks fifteen hours with no repair offered. You closed the front door and left the side door open.

**Better:** when the running timer is in `overnight` or `running-long`, the run bar's stop becomes `Stop at…` and routes to the identical menu. Any stop of an overnight timer, from any surface, goes through the repair.

**Finding — MAJOR — §4.8, the same-day forget gets the treatment you just rescued the overnight one from.** `running-long` puts `⚠` on the face and the words `running Nh` **in the expanded body** — hidden behind an `x` press — with `Stop at…` buried in `⋯`. The 6-hour timer I left running through lunch and notice at 3pm is *more frequent* than the overnight one, and it gets exactly the it's-in-a-tooltip treatment that was blocker B-4.

**Better:** one state, one treatment. Over a threshold (say 4h), the words go on the face and `Stop at…` becomes the primary. Same code path, no new design.

**Finding — MAJOR — §4.7.1, the menu leads with a guess I didn't ask for.** `6:00 pm` is hardcoded and unexplained. I often work till nine. Meanwhile `Last activity — 6:12 pm` — the option that is actually *evidence*, the only one that knows anything — is listed first but marked "omitted if unknown," and it costs the same two taps as the fabricated one.

**Better:** put the evidence on the tile face, not in the menu: `ran overnight · 15h — last activity 6:12 pm` with a one-tap `Stop at 6:12 pm` primary and `Stop at…` as the secondary for everything else. **One action instead of two**, and the app shows its work. Replace the hardcoded `6:00 pm` with the median stop time from my last 30 days.

**Finding — MINOR — §4.7.1 vs criterion 37.** The prose says "**one action** with one Undo"; criterion 37 says "≤3 (open menu, choose, done)." It's one transaction and two taps. A document this scrupulous about counting shouldn't inflate its own headline.

---

### 4. A 40-minute call just ended. Bill it.

**Count via tile: 4 actions** (tile `⋯` → `Log time already spent…` → hours → Enter). Via `l` on a focused tile, 3. Criterion 43's claim holds. The pre-scope contract (§6.3) is clean and the integrity rules on it are right.

But this is a *faster form*, not a *smaller job*, and for the case you yourself call "the MAJORITY of my entries" that's the difference between good and magic.

**Finding — MAJOR — §6.3, I said forty minutes and the app makes me say 0.7.** Nothing in §6 or criterion 43 says the hours field accepts `40m`, `40`, or `:40`. I bill in tenths; I *think* in minutes for a phone call. Making me do 40 ÷ 60 → round up → 0.7, twelve times a day, is the app charging me rent.

**Better:** the field accepts `40m` / `40` / `:40` / `0.7` and echoes `0.7h — 40 min, rounded up from 0.67`. Label the hour pills in both units: `0.5 · 30m`, `0.7 · 40m`, `1.0 · 1h`.

**Finding — MAJOR — §6, the 40 minutes already exist somewhere and you ignore them.** The sidebar in §3.1 has a Calendar. The call was a calendar entry, or it was in my phone log. The magic answer to "I just spent 40 minutes on a call I didn't time" is not a three-tap form — it's the attention band saying, unprompted:

```
⚠ Untimed: Call — M. Reyes, 2:00–2:40 pm · Northgate?   [Log 0.7h]  [Not billable]  [Dismiss]
```

That's **one tap** and I never opened a form. I accept this may be a separate stage — but the spec asserts this path is the majority of my entries and then never once connects it to the calendar the app already ships. Say so explicitly in §13.2 as a named non-goal with a stage, or it reads as an oversight.

**Finding — MINOR — §6.2.** After the call I file 0.7h and then start writing the memo on the same matter. Nothing does both. The post-file toast should carry `Start the clock on this matter` next to `Undo`.

---

### 5. 5:50pm. Eleven entries, three with no narrative.

**This is the weakest walk in the document, and it's the moment the app exists for.**

Count as specified: click `3 need a narrative` (1) → row focused, expanded, editor open (good) → type (2) → save (3) → **and now nothing.** §7.5 #86 and criterion 59 describe focusing *a* row, singular. Nothing advances me to narrative #2. So: hunt the list for the next `no narrative` chip (4), click its pencil (5), type (6), save (7), hunt again (8), click (9), type (10), save (11), then `🔒 Close` (12).

**≈12 actions and two visual hunts through a 10-row list**, in the last ten minutes of a fourteen-hour day, which is precisely when I abandon this and tell myself I'll do it tomorrow.

**Finding — BLOCKER (for "magic") — §5 / §7.5 #86, there is no close-out flow.** The spec calls `tk:focus-entry` a preserved capability and never asks what happens after the first one.

**Better:** `3 need a narrative` opens a **stepper**, not a row focus. One entry at a time, full attention:

```
1 of 3 · Northgate — LP side letters · 0.5h
┌──────────────────────────────────────────────┐
│ Reviewed and revised LP side letter…         │  ← AI draft, pre-filled, selected
└──────────────────────────────────────────────┘
⏎ accept & next     Tab skip     Esc stop
```

Three Enters closes the day. The AI fill already exists in this codebase. This turns my worst ten minutes into ten seconds, and it is the single highest-value thing you could add after the matter search.

**Finding — MAJOR — §4.1, `0.9h unfiled` is money and it's styled as trivia.** Nine-tenths of an hour sitting on timer clocks that never became entries is unbilled work. It renders as grey micro-text, fourth in a meta line, ranked below the word `84`. It has no action attached and no presence in the attention band.

**Better:** at close-out it belongs in the attention band as a button — `0.9h on 4 clocks isn't filed yet` → the same stepper. The board's own §5.3 correctly insists this number counts all 84 timers; having gotten the arithmetic right, don't whisper the result.

**Credit where due:** criterion 25 — every entry needing a narrative is always inside the phone's visible 6 — is exactly the right instinct. Apply that instinct to the whole close-out.

---

## SPEC DEFECTS THAT WOULD BITE A BUILDER

**BLOCKER — §2.2 vs §8.3 vs criterion 3: the front row's cap of 6 contradicts everything built on 3.** §2.2 says "up to 3 tiles at ≥1024px (one grid row)… **Cap 6**." But §8.3 hardwires `1`–`3` = front row and `4`–`9` = Recent; criterion 3 asserts exactly 3 tiles with `data-pos` 1–3; criterion 2 asserts exactly 9; the §3.1 vertical stack budgets one 56px front row. So what renders when I add a fourth? Three tiles and three invisible ones? Two rows of tall tiles blowing the 281px panel? Nobody knows, and I'd find out by breaking it. **Pick one: cap the front row at 3, or make the digit map dynamic and rewrite criteria 2, 3 and the §3.1 stack.** Cap at 3 is the better answer — the whole point is a shelf, and a shelf with six things on it is a shelf you have to read.

**MAJOR — §2.2 vs criteria 2/18: the phone's Recent band is never specified.** §2.2 says Band A "up to 3 on the phone" and Band B "up to 6 tiles" — that's 9. Criteria 2 and 18 say 6 on the phone, and the §3.2 sketch draws 3 + 3. So Band B is silently capped at 3 on mobile. State it — and notice what it means for me: **a matter I touched Tuesday is on my desktop board and absent from my phone board.** I run this as an Android PWA every day. Position that doesn't survive the device isn't position. If the phone must show 6, make it 2 front + 4 recent, or 3 + 3 with Recent using the *same* ordering rule so at least the prefix agrees across devices.

**MAJOR — §2.2, "resets to `working` on a new day" has no definition of a new day.** I leave the PWA open overnight — I am, definitionally, the guy who leaves things running overnight. Is this a server date compare on poll, a `visibilitychange` check, a midnight timer? Unspecified, and it's the same class of bug as the one §4.7.1 exists to repair.

**MINOR — §8.3, digit precedence doesn't cover focus in the entries list.** Focus on `.work-row`, press `4` — starts board tile 4? Probably right, but say so.

---

## WHAT THIS BOARD DOES THAT I DIDN'T ASK FOR AND WOULDN'T MISS

1. **§4.7 item 4 — the RTL truncation trick.** Flipping `direction: rtl` on tiles whose names collide, per render, so the ellipsis lands at the front. It's clever and it's wrong: it makes a tile **look different depending on which other tiles happen to be on screen** — the exact instability this entire document was written to eliminate. It will mangle `100001-000011` and em-dashes under bidi. No acceptance criterion tests it. **Cut it.** The front row's second line and comfortable density already solve collision, and the real fix is that I should rename `Acme — Borealis merger: HSR clearance` to put the distinguishing word first.

2. **§4.8, the `📌` front-row flag on Band C duplicates** — which the same row says never appear, since Band C is duplicate-suppressed. An icon telling me a tile is also somewhere else, on a tile that isn't there.

3. **Three separate mechanisms for "show me the matter number"** — `Comfortable` density, per-tile `x` expansion, and the front row's second line. I will never once open `Comfortable`.

4. **`By client` grouping.** 75 tiles across 16 clients is a filing cabinet I'd never open. `Only: this client` in the menu already does the real job.

5. **Multi-select and batch (66–69).** Preserved under "nothing is dropped." I have never batch-labelled a timer. It costs a mode, a selection bar, checkbox state, `Esc` semantics and a slice of the 640-line budget.

6. **`Shift+Alt+↑` for ±0.2h.** A second modifier layer to save one keypress.

---

## DOES ANYTHING MAKE ME THINK ABOUT THE APP INSTEAD OF MY WORK?

**Yes — four things, and the first two are the worst.**

1. **`Show all 84 timers` / `Hide the other 75 timers`.** Anti-pattern 14 overcorrected. I now carry two numbers that describe the *board* rather than my day, and because the label rewrites itself by state, I have to **read it every single time** rather than recognising it — which is the exact sin the whole document is prosecuting. `All timers` / `Fewer timers`, fixed text; the meta already carries the count.

2. **`⋯ Board options` is a preferences panel wearing a menu.** Eleven items: `Show`, `Only`, `Order`, `Density`, `Select several…`, `New group…`, `Rename group…`, `Delete group…`, `Import CSV…`, `Sort A–Z…` — and, first, the one thing I actually need daily, `Log time already spent…`. Every time I reach for logging time I read past ten configuration options. **Put `Log time already spent…` on the face and file the other ten behind a single `Board setup…`.**

3. **Six independent arrangement axes** — front row, Recent, `Order`, `Show`, `Only`, grouping — on a board whose entire thesis is "it is in the same place tomorrow." The thesis is right. The six knobs are the app asking me to finish designing it.

4. **The front-row cap of 6** (see the BLOCKER above). Any rule I have to *learn* about my own shelf is app-thinking. Three tiles, no cap to remember.

---

## THE SCORE, HONESTLY

Closed and closed well: **B-1** (the bounded working set is the right idea and the prefix property is the right *mechanism*), **B-4** (the best thing in the document), **B-3** (A–Z demoted, Manual default stated as a requirement — correct), **B-7 through B-13** (builder-grade, and criterion 46 in particular shows real understanding of how a green test hides a worse product).

Not closed: **B-2** — I still can't find a dormant timer without reading, because the filter only knows button names, its Enter fails silently, and 4–9 shuffle all day. **B-5** — present but weak: a faster form for a job that should have gotten smaller, and it still makes me convert minutes to tenths in my head.

And the moment you never walked at all is 5:50pm, which is the moment I actually hate.

**VERDICT: GOOD NOT MAGIC**

The single change that would most raise this: make the filter search **matters as well as timers**, print its resolution in the field (`⏎ starts: …`), and let Enter on a matter with no timer **create and start one in that same keystroke** — because the 2:40pm partner call is the moment this spec named as its target and is the one moment it does not actually reach.


---

# THE COMPLETENESS CRITIC

I have what I need. Here are the gaps.

---

# WHAT IS MISSING — TIMERBOARD-SPEC.md

Ranked by damage. Findings already covered by §13.1/§13.2 are marked as such and excluded.

---

**1. The overnight repair has no data source. The flagship feature cannot be built as written.**

`TIMER_COLS` (`server/routes/timers.js:29-32`) is `id, name, cm_id, task_code, sort_order, running, accumulated_seconds, last_started_at, last_reset_date, created_at, group_id, linked_entry_id, last_stopped_at, suggested_narrative, held_since, pinned, draft_narrative, narrative_template` — plus matter/client joins and `elapsed_seconds`. After `applyRollovers` runs (`timers.js:189-221`) the timer is scrubbed: `accumulated_seconds=0`, `linked_entry_id` re-pointed at *today's* entry, `last_reset_date=today`, `last_started_at=r.restartIso` (midnight). **Nothing in the payload says a rollover happened, names yesterday's banked entry, or carries its hours.** So the board cannot compute `ran overnight · 15h`, cannot populate the four `Stop at…` options with "yesterday becomes 2.2h / today becomes deleted", and cannot derive `Last activity — 6:12 pm`. §10.8 and non-goal 6 permit exactly two backend changes and neither is this. Six acceptance criteria (34–39) depend on data that does not exist.

*Why it matters:* this is the section the spec calls "the moment the app most obviously earns its keep." A builder will either fake it from `last_started_at === midnight` (which cannot tell a rollover from a deliberate 12:00am start, and yields no hours figure) or quietly add a third and fourth server change.

*Smallest addition:* name the third server change — add `rollover_from: { entry_id, date, hours, last_activity_at } | null` to the `/api/timers` list projection, computed from the banked entry `syncToEntry` wrote — and amend non-goal 6 from "two named places" to three.

---

**2. `POST /stop-at` has no matter check, and the design creates the cross-matter path itself.**

Rule 7 asserts "It never crosses a matter boundary" but nothing enforces it. The endpoint is addressed **by timer id**, and a timer can be re-pointed between yesterday evening and this morning: yesterday's banked entry sits on matter A, today's rollover entry on matter B. The response shape `changed: [{entry_id, date, hours_before, hours_after, deleted}]` carries **no `cm_id`**, and the four-option menu previews hours only — no matter names. He presses `6:00 pm` to correct Acme and silently deletes time on Northgate. Separately, `Last activity — 6:12 pm` is sourced from "the timer's last write **or the last entry touched yesterday**" — if that second clause is not matter-scoped, the stop time is inferred from another client's activity.

*Why it matters:* standing rule 1. This is the one genuinely new integrity surface in the document, and it is the one place the spec's own assertion is unbacked.

*Smallest addition:* one rule — `stop-at` 409s when the two affected entries are not on the same `cm_id`, with the message naming both matters; the menu prints the matter beside each hours preview; `Last activity` reads only writes on this timer's own matter. One assertion added to criterion 39.

---

**3. The owner's "ask me each time" dialog is assigned to this work and is absent.**

`STATUS.md:124` — *"Still outstanding, and it is UI not integrity: the owner's 'ask me each time' dialog... **Build it with the timer board.**"* And `STATUS.md:301-308`: the server half landed in `4ad84db`; until the dialog exists "the desktop app silently leaves the entry behind with no way to say 'move it too' — safe, but only half the decision he made." The spec's only touch is criterion 68, which asserts the *silence* (never send `move_entry` implicitly) and calls that a pass. `TimerModal` — the exact dialog that owns the matter picker — moves verbatim into `timermodals.js` (§10.5) with one addition (`Move to the front row`) and no prompt.

*Why it matters:* it is a recorded owner decision, explicitly routed to this build, and the spec closes the file on it by shipping the half he did not choose.

*Smallest addition:* one row in §10.5 and one criterion — saving `TimerModal` with a changed matter, where the linked draft holds hours or a narrative, opens a `Confirm` on the shared overlay offering *leave the time on the old matter* / *move it too* → `move_entry: true`.

---

**4. The front row holds six but renders three. Members 4–6 have no defined behaviour, and the digit-key invariant dies with them.**

§2.2: "Up to **3 tiles at ≥1024px** (one grid row), up to **3 on the phone** … **Cap 6**; a seventh attempt raises `The front row holds six.`" What happens to members 4, 5 and 6 is never stated — a second row, a silent truncation, or a scroll. §2.3 then hard-codes "`1`–`3` are the front row, `4`–`9` are `Recent`", which is only true at exactly three. **Nor is a front row of one or two defined**: is digit `3` dead, or does `Recent` slide up into position 3? Criterion 3 asserts "the first 3 tiles… carry `data-pos` 1–3", which passes vacuously at any membership.

*Why it matters:* §2.3 calls the prefix property the thing that buys stable muscle memory. A shelf whose size he can change from 1 to 6 with `f`, against a digit mapping written for exactly 3, means pressing `4` at 2:40 pm starts a different matter than it did yesterday.

*Smallest addition:* one sentence — the band renders **all** its members (wrapping to a second grid row past 3), digits index the rendered prefix in DOM order regardless of band membership, and the meta/caps re-derive on every change. One criterion at front-row sizes 1, 3 and 6.

---

**5. More than six timers worked today. The one thing STATUS says the current list gets right, broken.**

`STATUS.md:201-203`: *"One thing the current list gets RIGHT and the board must keep: it sorts worked timers to the top, so the six that matter today are the six he sees first."* Band B caps at 6 and Band C is **manual** order by requirement (§2.4). At the seed exactly 6 were worked, so the rule and the cap coincide and no measurement can catch it. On a nine-matter day, timers 7, 8 and 9 — each carrying unfiled clock time — sink into a manual-ordered tail of 75 behind a `Show all` button, with only a 6px `.timer-flag.filed` dot to find them by.

*Why it matters:* those are exactly the timers with time on them at close-out. Time on a hidden tile is the shape that loses an hour.

*Smallest addition:* Band B's cap lifts for rule 2 — every timer with time on its clock or an entry today is always in `Recent`, whatever the count; only the 14-day backfill (rule 3) is capped. Re-derive the height numbers in §3.1 at a 9-worked day and add a criterion at that fixture.

---

**6. `settings.board` is the only view preference that lives on the server, and its failure mode is unspecified.**

Grouping, `Only`, activity, order and density are all `localStorage` (`timergrid.js:120-146`) and survive a dead network. §10.8 puts the **front row and the scope** server-side — deliberately, so the phone and desktop agree — but the spec never says what the board renders when `GET /api/settings` is slow, fails, or is served stale by the cache-first worker. Read literally, §2.2's "First run seeds it with the first three timers in manual order" fires on every failed fetch: his shelf silently rearranges. And when the fetch lands late, three tiles move under a thumb that is already travelling. R16 covers the PATCH 400ing on a missing whitelist key; it does not cover read failure, and no risk covers latency.

*Why it matters:* he runs this as an Android PWA over a Cloudflare tunnel. The front row's entire value is that it is in the same place every time.

*Smallest addition:* mirror `settings.board` into `localStorage` on every successful read; render from the mirror immediately; reconcile only on a **successful** fetch, and never render the first-run seed unless the fetch succeeded and returned nothing.

---

**7. A tile pressed twice on a slow link. No in-flight state anywhere, and a brand-new non-idempotent endpoint.**

The spec adds four ways to fire a start (tile transport, digit key, `Enter` on a lone match, tile menu) and one new write that touches two days in one transaction — and specifies no pending state, no disabled-while-in-flight, no debounce and no idempotency key. The current code's `start` is a bare `await api.post(...)`; the confirmation (`.just-started` pulse, `timergrid.js:300-305`) fires only *after* `await reload()`. Over the tunnel that is hundreds of milliseconds of a tile that looks untouched. A second press fires a second exclusive start, whose server-side stop-and-file may land inside or outside the 2-second misclick grace. Two `POST /stop-at` calls have no defined second-call behaviour at all.

*Why it matters:* the spec's own success scenario is "about six seconds while saying *sure, let me pull that up*." A control with no acknowledgement is a control pressed twice.

*Smallest addition:* a `data-pending` tile state (spinner-free, just the transport disabled and the rail dimmed) set optimistically on press and cleared by the reload; `POST /stop-at` is idempotent on `(timer_id, at)` and returns the same `undo_token` for a repeat. One criterion driving a double-press under throttled network.

---

**8. The board below nine timers is undefined. Every number in the document is taken at 84.**

§1.1 makes the 84-timer seed the measuring instrument — correctly — but the spec never says what the board looks like at 0, 1, 5 or 8. Open questions with no answer: does `.band-recent` render its label with zero members; does `.board-foot` show `Show all 5 timers` when the tail is empty; does the front row render an empty grid on a genuinely first run before three timers exist; does the `Matches` band replace the bands at 3 timers. Criterion 2 hard-asserts "exactly 9 desktop / exactly 6 at 412px," which fails on any fixture smaller than the demo seed — and `scripts/e2e-smoke.mjs` builds its own small fixtures.

*Why it matters:* two audiences hit this immediately — the e2e suite (criterion 63 must stay green) and the blankslate path a new install lands on.

*Smallest addition:* one paragraph — bands render only when non-empty; `Show all N` is absent when Band C is empty; the front-row band is absent until it has a member; §7 #9's board blankslate is the whole board at zero timers. Plus one criterion at a 4-timer fixture.

---

**9. Nobody walks the sequence where a new start displaces the running timer.**

`start` is exclusive: the server stops and files whatever was running, and `timergrid.js:281-287` mounts `StopChips` **for that other timer**. So `/ f u n d ⏎` (§8.5, "the cheapest piece of magic in this document") and pressing `4` (§8.3) can both pop a narrative-suggestion sheet belonging to a completely different matter — after `Esc` has cleared the query and "restored the previous scope," which may not include the displaced timer's tile. §10.6's `offeringTimerId` probably rescues the mount, but the spec never states the interaction, and criteria 28 and 30 assert only that the *started* timer is running. Related and equally undefined: §8.3 and §8.5 both promise a toast with **`Undo`** on a start, and nowhere says what that Undo does to a two-timer state change — un-start (stop, which files or discards under the 2s grace) *and* restart the displaced timer whose entry may already carry a chip-chosen narrative.

*Why it matters:* the stop offer is where narratives get chosen. A sheet that appears unbidden, naming a matter he did not just press, is exactly the confusion the matter fences exist to prevent — and an unspecified Undo across two timers is an hour-losing shape.

*Smallest addition:* one sub-section — a digit/Enter start that displaces a running timer routes the displaced timer's offer through the normal path and **scrolls to it**, and its `Undo` is defined as *stop the newly started timer and restart the displaced one at its prior elapsed*, or is dropped entirely for displacing starts. Criterion 28 extends to assert where the displaced offer mounted.

---

**10. Midnight, with the page open. No trigger for the new-day reset.**

§2.2 says scope "resets to `working` on a new day" and criteria 6 and 9 test it by *simulating* a new day (a reload). He leaves this open as an installed PWA. What happens at 00:00:00 with the tab live is never stated: does the 5s poll notice the date change; does the front row survive; does a tile that was `filed` (draft entry today) become `idle`; does the running tile's clock visibly reset when `applyRollovers` fires server-side; and does the tile immediately enter the new `overnight` state on screen or only after a manual reload. The `visibilitychange`/`focus` refetch (`timergrid.js:209-217`) refreshes timers but nothing recomputes bands against a new date.

*Why it matters:* the overnight repair (§4.7.1) exists precisely because he leaves timers running past midnight — so the app *is* open when the day rolls, and that is the moment the board must be right.

*Smallest addition:* the coordinator holds a `today` value derived from the same aligned tick; when it changes, it resets scope, re-derives Band B and refetches. One criterion driving a clock crossing midnight.

---

**11. A board filtered to zero, and what the filter does to everything else.**

§2.5 collapses the bands to one flat `Matches` band. Unstated: whether `.board-foot`'s `Show all 84 timers` remains during a filter (it is meaningless — the filter already searches all 84); what `.band-front` and `.band-recent` do; what a digit key does with 0 or 2 matches (§8.3 says digits "index the first nine matches", §8.5 says `Enter` at 0 matches "stays put" — the digit case at 0 is undefined); and whether §7 #10's "Nothing matches" blankslate replaces the bands or sits above an empty grid. Criterion 3 (`.band-front` carries `data-pos` 1–3) contradicts a collapsed single band and no criterion resolves which wins while a query is typed.

*Why it matters:* he uses `/` constantly (`BRIEF.md:272`) and at 84 timers the spec makes it "the primary way to reach the tail." The most-used control has the least-specified surroundings.

*Smallest addition:* four lines in §2.5 — while a query is typed the bands are replaced entirely, `.board-foot` shows only `＋ New timer`, digits index matches and no-op past the match count, and zero matches renders the board blankslate in place of the grid.

---

**12. There is no way to retire a timer. The board only grows.**

The board's premise is a bank that persists for months. He has 84 timers against 89 matters. Matters close; the timers do not. The only pruning path in the whole capability table is `Delete timer` (a `Confirm` that says entries are kept). There is no archive, no "hide", no "not this year" — and `server/routes/cms.js:143-145` refuses to delete a matter that has a timer with the message *"CM has entries or timers — **archive it instead of deleting**"*, promising an archive the data model does not have (no `active`/`archived`/`closed` column exists on `matters`). R18 covers the front row going stale; nothing covers the board going stale.

*Why it matters:* 84 becomes 120 next year. `Show all 120 timers` is the wall he complained about, arriving on schedule, and Delete is a scary verb for a button that produced billed hours.

*Smallest addition:* either a stated non-goal ("archiving is out of scope; the tail is unbounded by design and Stage 5 owns it") or a one-line capability — `Archive timer` on the tile menu setting `sort_order` to the end of a hidden `Archived` section in Band C, reversible, no schema change.

---

**13. `Pin to float window` and `Move to the front row` are now two unrelated ways to say "this one matters."**

The pinned flag (`timers.pinned`), the `📌 .timer-flag`, the batch `Pin all to float window`, and the `Float` destination in the sidebar all survive untouched (§7 #35, #66–69, #70–77). The front row is new and does the same job in a different place with a different glyph — and §4.8 gives front-row membership the `📌` flag, **the same pushpin the pinned state already owns**. The spec never relates them, never says whether the float window should follow the front row, and never resolves the duplicated icon.

*Why it matters:* two overlapping "favourites" lists on one screen is the kind of thing he will set once, forget which is which, and stop trusting.

*Smallest addition:* pick a different glyph for front-row membership, and one sentence saying whether pinning and the front row are independent (and if so, why he would use both).

---

**14. The attention band's `1 ran overnight` has no owner file, and needs a change the file plan forbids.**

Criterion 35 asserts the band reads `1 ran overnight`. The band lives in `public/js/views/dashboard.js:176-236` and is driven by `alerts` from `server/routes/dashboard.js:74`. §10.9 declares `dashboard.js` "**unchanged component contract**; the split primary is a markup change in its header" — and §10.8 permits exactly two server changes, neither of them the dashboard alerts payload. So a criterion asserts a string that no section of the file plan builds. This is anti-pattern 15 ("a control that appears in a wireframe and nowhere else in this document") committed by the document itself.

*Smallest addition:* one row in §10.9 assigning the band change to `dashboard.js`, and the alerts field to whichever server change closes gap 1.

---

**15. New start paths do not write `tk:lastTimer`, so `t` toggles the wrong timer.**

`start` and `stop` both write `localStorage['tk:lastTimer']` (`timergrid.js:279, 309`) and the global `t` shortcut (`tk:toggle-last-timer`, `timergrid.js:393-402`) reads it. The spec adds three start paths — digit keys `1`–`9`, `Enter` on a lone filter match, and `Stop at…` — and specifies the memory for none of them. §7 #82 lists `t` as `≡` unchanged, which is exactly the trap: the shortcut is unchanged and its input is now stale.

*Why it matters:* `t` is the shortcut he presses without looking. Starting Northgate with `/ f u n d ⏎` and then pressing `t` toggles whatever he last pressed a *button* for.

*Smallest addition:* one line — every path that starts or stops a timer writes `tk:lastTimer`; one criterion asserting `t` after a digit-key start toggles that timer.

---

**16. A name that is one long unbroken token overflows, and no measurement can catch it.**

The seed's longest name is 44 characters *with spaces* (§1.1), so every measurement passes. The tile's name is `white-space: nowrap; text-overflow: ellipsis` (fine at any length), but §4.7's front row is **two lines** and §4.9's Comfortable adds line 2 to every tile, and no `overflow-wrap`/`word-break`/`hyphens` rule is specified anywhere for either. A 60-character single token in a 288px track — or in the inline `.name-input`, which has no `maxlength` and never has — pushes past the track and violates anti-pattern 11 and criterion 22 at 412px. The rtl-truncation trick in §4.7 answer 4 is specified only for *colliding prefixes* and does not apply.

*Smallest addition:* `overflow-wrap: anywhere` on the tile's line-2 spans plus a stated `maxlength` on `.name-input`, and one fixture timer with a 60-character unbroken name added to `demoseed.mjs` so criterion 22 actually exercises it.

---

**17. The test gate is a number the owner's own status board contradicts.**

Criterion 62 reads "**934 tests, 934 pass, 0 fail** (measured on this box, 2026-08-16, commit `307c5d9`)… **the pass count only ever goes up**." `STATUS.md:15`, same date, same branch, reads "**944 tests, 944 pass, 0 fail** (session 5)." A gate ten below the real floor means a build can delete ten tests and pass the criterion that exists to prevent exactly that.

*Smallest addition:* re-measure and state the number, or bind the criterion to the number in `STATUS.md` rather than a literal.

---

**18. Small capability drops in §7 (which claims "No row in this table is `⊖`").**

- **The `· unnamed` client marker.** `timergrid.js:1160-1161` renders a muted `· unnamed` in a By-client group head when the client has a number but no name, with a `title` pointing at Clients & Matters. §4.5 defines `.group-head` as `.group-name` + a muted count only. Gone, and it is the only place in the app that tells him a client record is incomplete.
- **The `relinked` toast** ("Previous entry is settled — started a new one; its hours have left the clock," `timergrid.js:296`) survives only inside §7 #89's "…". It is the one message that explains a clock jumping to zero; worth naming, since the split gives the board four new start paths that can trigger it.

*Smallest addition:* two rows in §7.3 / §7.5, both `≡`.

---

**19. Close-out, export and the 5s poll are never related to the board.**

Three loose ends the document does not connect:

- **`0.9h unfiled` counts all 84 timers** (§5.3, criterion 70) — deliberately, and correctly. But the spec never says whether **close-out** (`c`, the run bar's `🔒 Close`) or export sees that number or blocks on it. At 84 timers, unfiled clock time on a tile he cannot see is precisely the failure the total was invented to surface, and the surface that would act on it is unmentioned.
- **The 5s poll** now returns 84 timer rows (with six correlated subqueries each, `timers.js` `listStmt`) every five seconds over a Cloudflare tunnel to a phone. The spec bans a second fetch (R1, criterion 61) but never sizes the one it keeps, and never says the poll should back off when the tab is hidden.
- **`prefers-reduced-motion`** is handled for the pulse (§4.9) but the `.timer-drop-slot` open animation (`@keyframes drop-slot-open`, kept in §9.3) is not mentioned.

*Smallest addition:* one sentence each — close-out surfaces the board's unfiled total before finalizing; the poll pauses while `document.visibilityState !== 'visible'` (the existing wake-refetch already covers the resume); `drop-slot-open` joins the reduced-motion catch-all.

---

## Already acknowledged — not counted as gaps

- The working set hiding a wanted timer — **R15**.
- The front row going stale, and a deleted front-row timer dropping out without auto-refill — **R18**.
- `settings.board` PATCHing 400 on the settings whitelist — **R16**.
- `stop-at` losing an hour across two dates — **R17** (but see gap 2: the *matter* dimension is not in it).
- The stop offer relocating into the entries panel — **B-7 / R3 / criterion 46**.
- Matter number absent from the ordinary compact tile — **non-goal 12**.
- No learned ordering, no unlabelled disclosure, no re-merge — **non-goals 13, 14, 5**.
- A timer whose **matter was deleted** is unreachable, not a gap: `server/routes/cms.js:141-147` refuses to delete a matter that any timer or entry references.


---

# THE BUILDER CRITIC

## Test reality first

`npm test` on this box, this commit (`0be444c`, branch `ui-overhaul-2026-08`):

```
ℹ tests 944   ℹ pass 944   ℹ fail 0   ℹ skipped 0   ℹ duration_ms 55317
```

**944, not 934.** Criterion 62 (`TIMERBOARD-SPEC.md:1778`) states "934 tests, 934 pass" as a measured fact taken at `307c5d9`. It is off by ten. B-6 was raised precisely for stating a false test gate; revision 2 restates a different false test gate. The "only ever goes up" clause keeps it from failing the build, but the number a builder is told to hit is wrong.

---

## BLOCKERS

**1. Criterion 3 is false at the seed it is measured against.** `TIMERBOARD-SPEC.md:1605` — "The next 6 are `.band-recent .timer-tile` and include the running timer first." The running timer at the seed is `timers.merger` = `Acme — merger` (`scripts/lib/demoseed.mjs:58`, started last at `:135`). It is the **2nd timer created**, so it is inside "the first three timers in manual order" that §2.2 (`:157`) seeds the front row with. Band B is "deduped against Band A" (`:168`), so the running timer is deduped **out** of Recent. Criterion 3's second sentence cannot pass. §2.2's own worked example (`:176` — "the running `Acme — merger`, then the 5 other timers worked today") is wrong for the same reason, and doubly so: the six worked-today timers are all bulk (`demoseed.mjs:318`), the running merger is a seventh.

**2. §2.2 contradicts itself and criteria 2/3 on the size of the front row.** `:153` — "Up to **3 tiles at ≥1024px** (one grid row)". `:159` — "**Cap 6**; a seventh attempt raises `The front row holds six.`" Criterion 2 (`:1603`) demands *exactly 9* tiles; criterion 3 (`:1604`) demands *the first 3* are `.band-front`. What renders when he puts a 4th timer in the front row is undefined: 4 front tiles (breaking c2 at 10, and c3), or a silently-truncated front row (breaking the `f` key and `Move to the front row` he was just given three paths to). The digit-key stability claim at `:200` ("1–9 are always the front row then Recent") also collapses at cap 6 + 6 = 12 positions. This is the heart of §2 and it is unresolved.

**3. Criterion 26 is false on the phone and unreachable at criterion 14's own limits.** `:1657` — front row distinguishable "with the page rendered in greyscale: tile height differs by **≥1.5×**". Phone: `--tile-h-touch` 44 vs `--tile-h-front` 56 (`:1218-1220`, §3.2 `:359`) = **1.27×**. Desktop: criterion 14 (`:1631`) permits an ordinary tile up to **38px** against a front row of 56–60 → **1.47×**. Two acceptance criteria that cannot both pass.

**4. The §11 table omits the one e2e assertion that the B-7 fix breaks.** `scripts/e2e-smoke.mjs:381`:
```js
const anchored = await page.$eval('.stop-chips', (el) => ({
  inRow: !!el.closest('.work-row'), position: getComputedStyle(el).position,
}));
if (!anchored.inRow) throw new Error(`chips are not on the stopped row: …`);
```
§10.6 (`:1471`) asserts "The e2e assertion still passes because it checks `.work-row`." That is true only of the *broken* behaviour. Under the specified fix the offer mounts on `.timer-tile`, whose co-class is `.timer-row`, **not** `.work-row` (`:1239`). `closest('.work-row')` returns null and the step throws. Line 381 appears nowhere in §11's "all fifteen". This is B-8 recurring in the exact place B-7 was supposed to close.

**5. e2e:1228-1231 contradicts "`Only` applies to Band C only" and is not in §11.**
```js
const rows = [...document.querySelectorAll('.today-list .timer-row .timer-name')];
return rows.length === 1 && rows[0].textContent.includes('Acme research');
```
§2.3 (`:206`) and §4.3 item 3 (`:426`) exempt Bands A and B from `Only`. With a front row of 3 + Recent, `rows.length` is ≥4, never 1. Not listed in §11.

**6. Every `.group-head` assertion breaks in working scope, and §11 does not say so.** `e2e-smoke.mjs:1144-1146, 1239, 1257` wait for a `.group-head .group-name` immediately after `setListSeg('Group', …)`. §2.2 (`:180`) does not render Band C in working scope, and grouping is Band-C-only — so no `.group-head` exists until `Show all 84 timers` is pressed. Same for `:1154-1155` (`Drop timers here` on an empty group), `:1183`, `:1210-1220` (`dndToSection`), and `:149-160` (`sectionCount`, which §11 row 8 migrates by *selector* only). §11 row 6 (`:1568`) claims "Ten call sites untouched, one helper edited" — there are **13** call sites, and the assertions after them, not the calls, are what break.

**7. The mandated tile markup deletes `title` from every tile button; eight e2e click sites use it.** §4.7's markup (`:1556-1576`) gives the buttons `aria-label` only. Real code carries both (`timergrid.js:1578` `title="Stop & file time"`, `:1644` `title="Row menu"`). e2e clicks `.timer-row button[title="Start"]` / `[title="Stop & file time"]` / `[title="Row menu"]` at `e2e-smoke.mjs:359, 361, 370, 374, 733, 776, 1168, 1545`. None is in §11.

**8. Criterion 36 is not implementable with the one sanctioned endpoint.** `:1689` — the `Stop at…` menu must offer four options "each showing the resulting hours for **yesterday and today**", and `Last activity — 6:12 pm` derives from "the last entry touched yesterday" (`:693`). The client has today's entries only; nothing in §10.8 provides yesterday's banked entry or a preview. §13.2 non-goal 6 (`:1875`) forbids a third backend change. Either a `GET`/preview endpoint or a yesterday-entries read is required and neither is sanctioned.

**9. Criterion 67's `timerboard.js ≤640` is unreachable — B-9 was moved, not fixed.** `:1361, 1796`. The tile alone is the timer half of `WorkRow` (`timergrid.js:1304-1673`, 370 lines serving both kinds): name/rename ~35, clock-pair + `.figure-edit` ~55, transport ~15, `.timer-more` ~10, flags ~15, select checkbox ~12, expanded body ~50, state computation ~30, drag attrs ~10, wrapper ~25 ≈ **257**, plus the new `.tile-key`, `.sr-only` line, `.timer-overnight-note` + `Stop at…`, front-row line 2 and the rtl-truncation effect ≈ **+70**. Add the control row ~60, filter pills ~12, three-band render ~90, `.board-foot` ~15, batch bar ~20, drag handlers ~60, `onBoardKey` with per-grid geometry + digits + `f`/`l`/`x`/`Enter`/`Shift+Enter`/`Ctrl+Enter`/`Alt+↑↓` ~140 (today's flat version is already 70 at `timergrid.js:913-982`), board-menu builder ~75 (today's is 71 at `:983-1053`), imports/props ~35. **≈ 830 against a 640 ceiling.**

**10. `.sr-only` does not exist.** `grep -rn "sr-only" public/css/ public/js/` returns **nothing**. §4.7's mandatory markup (`:1562`) puts a `<span class="sr-only">` carrying name + client + matter number on **every tile**. With no rule, that text paints. It is the second channel criteria 51/52 rely on, and it breaks criteria 11 (`≤300px` panel), 14 (`≤38px` tile), 21 (`≤1400px` page) and 22 (no horizontal overflow). §9.3's "Create" list (`:1232`) does not include it and §9.1 (`:1204`) forbids touching any CSS file that would host it besides `timers.css`/`base.css`.

**11. Three STATUS.md citations are wrong, and the build is told to paste one into source.** The owner quote is at `docs/ui/STATUS.md:322-324`, not `236-238` (which reads "All three are green. Each fix was verified the session-4 way…"). The tenths rule is at `STATUS.md:348-365`, not `261-283` (which is about narrative provenance). `STATUS.md:251` is provenance, not grouping. §10.2 (`:1387`) mandates `(docs/ui/STATUS.md:236-238)` as a permanent comment in `timergrid.js`, and criterion 73 (`:1813`) blesses it. The spec's own §1.3 warns that this comment "is the exact text that will mislead the next builder."

**12. Criterion 17 (`≤48` visible controls) has no counting rule and is unreachable on its face.** `:1638`. Nine tiles × 4 interactive elements (name, clock, transport, ⋯ — §4.7's inventory, `:598-607`) = 36; ten desktop entry rows × ~4 (name, narrative, hours, Start, ⋯ — §5.1 `:781-788`) = 40+; plus page head 5, board 5, foot 2, run bar 3. **≈100.** Even counting only "painted" buttons (§4.7 `:609` — two per tile) you land at 18 + 20 + 10 = 48 with zero headroom. This is the same defect class as revision 1's 800-line ceiling.

**13. Criteria 6 and 9 have neither a data shape nor a harness.** `:1613, 1619` — scope "resets to `working` on a new day", verified by "simulating a new day". §10.8 (`:1539`) defines `settings.board = { front: [ids], scope }` — **no date field**, so the client cannot know a day turned. And `e2e-smoke.mjs:22` constructs the server with `clock: () => new Date()` — a real clock, no injection point.

---

## HIGH

**14. The run bar is fixed to the *top*, and both wireframes and the vertical derivation assume the bottom.** `public/css/runbar.css:101` — `.runbar { position: fixed; top: 0; left: 0; right: 0; }`, with `.tk-runbar .main { padding-top: calc(var(--runbar-total) + var(--space-6)) }` at `:179`. §3.1 (`:288-289`) draws "RUN BAR (fixed, y 856–900)" at the bottom, criterion 12 (`:1627`) calls y=856 "the run bar top", and the whole y-table (`:295-308`) starts the page head at y=20, ignoring the ~76px the run bar's padding pushes down whenever a timer runs — which is the seed's own state. Every measured desktop y in §3 is wrong by that amount, and criterion 12's parenthetical is simply false. Only the *bottom nav* is bottom-fixed, phone-only (`shell.css:872`).

**15. Capability silently dropped: narrative-text search.** `timergrid.js:796` — `matchesFilter` folds `...r.entries.flatMap((e) => [… e.narrative])` into the haystack, and `:1072` labels the control "Filter today's work by matter, client, number **or narrative**". §7.1 row 4 (`:919`) lists only "timer name/cm/client/number/task_code". §7 claims "**Nothing is dropped**" and "No row in this table is `⊖`" (`:1031`). This is a `⊖`. Name it or restore it.

**16. Capability degraded: the tile loses its expand chevron and gains no working touch path.** §7.3 #41 (`:969`) marks it `≡` — "`.work-expand` on entry rows; the tile is `x` / click". `.work-expand` exists today on timer rows (`timergrid.js:1629`). At 34px compact / 44px touch the tile is `.tile-key` + rail + `.timer-name` (`flex: 1 1 0`, a *button*) + clock pair + transport + ⋯ — there is no inert body region to tap. §4.9's "click on the tile body, or tap" has no target. e2e:678 (`clock.closest('.work-row').querySelector('.work-expand').click()`) migrates per §11 row 10 to "a tile-body click" that cannot be driven.

**17. §4.7's rtl truncation is the most expensive thing in the document and has no criterion.** `:626-633` requires, per render: a pairwise scan of visible tiles for a shared leading token run ≥8 chars, plus a per-tile overflow measurement (`scrollWidth` vs `clientWidth`), plus a conditional `direction: rtl` + `unicode-bidi: plaintext` flip — over up to 84 tiles, in a component that re-renders on a 1s tick and a 5s poll, in a no-build React 18 UMD app. No acceptance criterion tests it. §9.6 anti-pattern 15 (`:1334`) forbids exactly this ("If it is drawn, it has behaviour, state, a keyboard path and **a criterion**"). Cut it or price it.

**18. `timergrid.js ≤780` has ~0–20 lines of headroom, not 40.** §10.1's derivation (`:1367`) omits `batchMenuItems` (43 lines, `timergrid.js:602-644`, must stay — it PATCHes), `selectCard` (32, `:88-119`, not in `boardselect.js`'s export list at `:1364`), `clearSelection`/`exitSelectMode`/`focusEntryOf`/`guard`, and the `allRows`/`todayEntries` assembly (~40, `:740-800`). Realistic landing ≈ 762. Reachable, unlike revision 1 — but the claimed 40 of slack is not there.

**19. Criterion 61 cannot be observed as written.** `:1772` — "counting network requests for 30s with one running timer: … exactly **one `Notification` per long-run mark**." Long-run marks fire at 2h then hourly (§7.5 #78, `:1017`). Nothing is observable in 30s.

**20. `Undo` on a digit-start / Enter-start has no mechanism.** Criteria 28 (`:1662`) and 30 (`:1667`), plus §8.3 (`:1109`) and §8.5 (`:1152`). Start is exclusive — it stops whatever was running and banks its seconds. An "Undo" must restore the previous timer's running state *and* its elapsed. There is no endpoint for it and §13.2 non-goal 6 sanctions only two backend changes. The toast infrastructure exists (`emitToast(…, { actionLabel: 'Undo' })`, `timergrid.js:387`); the semantics do not.

**21. `Show` (activity) scope vs the bands is undefined.** §2.3 (`:206`) exempts Bands A/B from grouping and `Only`. §4.3 item 2 (`:425`) keeps `Show: All | Ran today | Yesterday | This week | Recent` in the menu and says nothing about bands. e2e:2035 drives it. A builder cannot know whether `Show: Yesterday` empties the front row.

---

## MEDIUM

| Ref | Finding |
|---|---|
| `:359` | `--tile-h-front-touch` is used in §3.2 and defined nowhere; §9.2 (`:1214-1221`) defines only `--tile-h-front`. §4.9's 60px comfortable-touch tile has no token either. |
| `:1298` | `--space-1-5` is undefined in `tokens.css` (the `6px` fallback saves it, but §9.6 anti-pattern 1 forbids a raw px). |
| `:1417` | "all **ten** window-event listeners" — `grep addEventListener('tk:' timergrid.js` returns **seven** (`:257, 264, 400, 416, 417, 452, 464`). |
| `:70` | Seed fact wrong: the longest name is **44 chars = `Acme — Borealis merger: disclosure schedules`**. The two named (`Meridian — physician group affiliation`, `Thornbury — regulatory market conduct exam`) are 37 and 42. §1.1 calls this table "the measuring instrument". |
| `:56` vs `:66` vs `:1395` | "83 timers" / "**84**" / "HE HAS EIGHTY-THREE TIMERS" — the last is the comment the builder must paste into source. `demoseed.mjs` produces 79 bulk + 5 hand-built = **84**. |
| `:80` | `node scripts/poc-sync.sh --seed` — it is `#!/usr/bin/env bash` (`scripts/poc-sync.sh:1`). `node` will not run it. |
| `:219` | "It keeps its undo (§4.3)" — `sortAZ` (`timergrid.js:504-509`) has **no** undo today; it is new work, correctly specified in §4.3 but mis-stated as a keep. |
| `:426` | §4.3 item 3 implies `Only` is always present; `timergrid.js:1011` renders it only when `grouping !== 'flat'`. |
| §11 row 11 | Omits `.work-row` sites at `e2e-smoke.mjs:498, 526, 568, 1401, 1456` from its per-assertion migration. |
| `:1117` | Digit caps `1 2 3` on front-row tiles paint simultaneously with `StopChips`' own `1 2 3` caps (`stopchips.js:655`). Suppression is logical only; the visual collision is the stale-key-cap hazard documented at `e2e-smoke.mjs:462-464`. |

---

## Verified genuinely fixed (not merely mentioned)

- **B-13 / `dragId`**: real defect confirmed at `timergrid.js:511-514` (`dropOn(target)` reads `dragId.current`). §10.7 seam 1 moves the ref board-local and passes `onDrop(timerId, target)` explicitly; criterion 58's grep is a real gate.
- **B-12 / geometry**: `verticalTarget`'s upward formula `n.count-1 - ((n.count-1-col) % n.cols)` is arithmetically correct for partial last rows (checked at count=7/cols=3 for col 0,1,2 → 6,4,5). `colsOf`'s `offsetParent` + `/^[\d.]+px$/` guard genuinely defeats the unresolved `repeat(...)` string.
- **B-10 / ARIA**: `role="list"`/`role="listitem"` with roving tabindex is valid and does not flatten children. `grep role="grid"` across `public/js/` returns nothing on `#/`, so criterion 49 is real and passable.
- **B-7 / SLOT_CSS**: `order: 9` is safe on entry rows — the highest `order` in `timers.css` is `2` (`.work-body`/`.work-extra`, `:305-306`), so the slot still lands last. The current value is `order:3` (`stopchips.js:219`).
- **B-11**: ghost cell deleted; criterion 53's `.timer-grid .timer-new === null` is checkable.
- **B-9**: the coordinator ceiling is now arithmetically reachable — the overflow simply relocated to `timerboard.js` (blocker 9).
- Token audit: of ~50 named tokens, only `--tile-min` and `--tile-h-compact` are missing, and both are declared new in §9.2. `--runbar-total` (`runbar.css:88-97`) and `--shell-nav-total` (`shell.css:57`) exist. Every reused class in §9.3 exists in CSS **except `.sr-only`** (blocker 10) and `.board-meta`/`.stop-chips-inline`, which are new/inline by design.
- e2e line citations in §11 are accurate where given (checked 111, 149, 182, 410, 438, 501, 678, 793, 1058, 1143, 1193, 1404, 1524, 1655, 1666, 1672, 1697, 1700, 2035). BRIEF.md:200-204, BRIEF.md:273-276, teardown.md:286-287 all verify.

---

Two of the three defects that got revision 1 rejected are present in revision 2 in new locations: the e2e migration table again omits the assertions that contradict the design (blockers 4–7, including the one the B-7 fix itself breaks), and the line ceiling is again unreachable — just on a different file (blocker 9). Add a false criterion at the heart of §2 (blocker 1), an internal contradiction about the front row's size (blocker 2), two mutually exclusive height criteria (blocker 3), a mandated class with no CSS (blocker 10), and a mandated source comment carrying a wrong citation (blocker 11).

**VERDICT: NOT BUILDABLE**
