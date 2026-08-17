# TIMERBOARD-SPEC — the restored timer board, at eighty-four timers

**Status:** build spec, **revision 3**. Executable without further questions; scoreable by a
critic.
**Branch:** `ui-overhaul-2026-08`. **Written:** 2026-08-16. **Revised:** 2026-08-16 (same
day, after the owner's scale correction and **five** critic passes — two of which rejected
revision 2: the attorney returned *GOOD NOT MAGIC*, the builder returned *NOT BUILDABLE*,
and a completeness critic returned nineteen gaps).
**Inputs:** `docs/ui/STATUS.md` (owner rulings), `docs/ui/BRIEF.md`,
`docs/ui/TIMERBOARD-CRITIQUES.md` (the three reports this revision closes, verbatim),
`scripts/lib/demoseed.mjs` (the 84-timer seed — **every number in this document is measured
against it, on this box, and says so**), `public/js/components/timergrid.js`,
`public/js/components/stopchips.js`, `public/js/components/quickcapture.js`,
`public/js/components/cmpicker.js`, `server/routes/timers.js`, `public/css/tokens.css`,
`public/css/timers.css`, `public/css/runbar.css`,
`shots/baseline/dashboard.desktop.light.png`.

Standing rules that outrank this document: **(1)** data integrity — a narrative never
crosses a matter boundary, and no time is lost, double-counted or stamped exported without
reaching a file; **(2)** desktop first; **(3)** it is a timers app, and `/` filters on
Today.

The bar this is judged against: **it must feel like magic to a busy corporate lawyer with
very limited bandwidth to enter time.** Not tidy. Not complete. Magic — meaning the thing
he needs is already on screen, and the thing he did wrong is already repaired.

**Rule of the revision, stated once:** every number below was *taken*, not estimated. Where
revision 2 quoted a figure that a measurement contradicts, revision 3 prints the measured
figure and says what the old one was. A spec that misreports its own instrument teaches the
builder that its criteria are decoration.

---

## 0. WHAT CHANGED

### 0.1 Revision 2 — the thirteen blockers from the first two critics (kept, all still closed)

| # | The blocker | The answer, and where it lives now |
|---|---|---|
| **B-1** | The board was designed and measured for 8 timers; at 84 it is ~1,500px of tiles on the phone and pushes the entries list under the run bar. The phone sketch showed an unspecified "… 4 more". | **§2 THE DEFAULT VIEW.** A bounded **working set** — a fixed **front row** plus a **Recent** band, 9 tiles desktop / 6 phone — with everything else behind **one named control**, which *appends* and never moves the first nine. Criteria 1–5, 10–14, 19–23, 34. |
| **B-2** | 84 identical tiles distinguished only by a truncated string. | **(a)** the front row is taller and always first — SIZE and POSITION (§2.2, §4.9); **(b)** **digit keys start the Nth tile** and the cap is printed on the tile (§8.3); **(c)** **Enter in the filter starts the match**, and now also *creates* one from a matter (§8.5). Criteria 37–48. |
| **B-3** | Default sort order never stated; a permanent one-click A–Z sat on the face. | **Default order is MANUAL, a requirement not a preference** (§2.4). **A–Z is demoted into `Board setup…`**, still undoable. Criteria 49–52. |
| **B-4** | The forgot-to-stop timer got a `title` tooltip, which does not exist on his Android PWA. | **§4.8 THE STOP REPAIR** — words on the tile face and a one-tap primary, reachable from **every** stop surface. Criteria 53–69. |
| **B-5** | The retroactive path — the majority of his entries — had no board presence. | **§6.** Split page primary `Start` · `Log time…`; `l` on a tile; pre-scoped QuickCapture; **and the hours field now speaks minutes** (§6.4). Criteria 70–77. |
| **B-6** | An acceptance criterion said "the three known reds and no fourth". | The gate reads **944 pass / 0 fail**, measured on this box on 2026-08-16 at commit `185beff`. Criterion 110. |
| **B-7** | `stopchips.js` was a fourth file the plan never named; its mount selector dies after the split. | Named in the file plan (§10.7); the offer mounts **on the tile he pressed**; and the e2e assertion that this breaks is now **in the migration table** (§11 row 1). Criteria 90–93, 111. |
| **B-8** | The e2e migration table omitted the assertions that *contradict* the design. | **§11** enumerates **twenty-eight**, each marked migrate, retire, or proved-unaffected, with the reason. Criteria 111–113. |
| **B-9** | The 800-line ceiling was arithmetically unreachable. | Six files, ceilings re-derived with the omissions the builder priced (§10.1). Criterion 115. |
| **B-10** | `role="grid"` + `role="button"` tiles is invalid ARIA. | `role="list"` / `role="listitem"` with roving `tabindex` (§4.7). Criteria 96–98. |
| **B-11** | The `＋ New timer` ghost cell broke the one-tab-stop invariant. | Deleted; the control lives in `.board-foot`. Criterion 99. |
| **B-12** | Arrow geometry was wrong in grouped mode; `colsOf()` returned 3 by coincidence. | Per-grid geometry with a real-px guard (§8.2). Criteria 100, 101. |
| **B-13** | Four seam breaks with no owner. | **§10.8 names the owner of all nine.** Criteria 104–107. |

### 0.2 Revision 3 — every finding in `docs/ui/TIMERBOARD-CRITIQUES.md`

Three reports. **Two rejected the document.** Nothing below is acknowledged-and-deferred:
each row is closed in the body, and every BLOCKER or MAJOR carries at least one numbered
acceptance criterion that **fails if the answer is missing**. Four findings I judge wrong;
those rows say so, with the reason, and the spec argues the point rather than ignoring it.

**From the attorney — the difference between good and magic**

| # | Finding | Closed by |
|---|---|---|
| **A-1** | The filter is timer-only. 84 timers, 89 matters; a partner names a matter with no timer and the filter is a **dead end**. *"the single most valuable missing thing in the document."* | **§2.6 + §8.5 THE FILTER SEARCHES TIMERS *AND* MATTERS.** A matter with no timer offers one row, `⏎ Start a new timer — <client> · <matter> · <number>`, which creates it, starts it and toasts with Undo. It reuses `GET /api/cms/picker?q=`, which already exists (`cmpicker.js:110`) — **no new endpoint**. Criteria 45, 46, 47, and 43, 44. |
| **A-2** | There is no close-out flow. After narrative #1 nothing advances him: ≈12 actions and two visual hunts at 5:50pm. | **§5.5 THE CLOSE-OUT STEPPER.** One entry at a time, `1 of 3`, pre-filled, `⏎` accepts and advances. Criteria 81, 82, 83, 84, 85, 86. |
| **A-3** | `Enter` on ≥2 matches fails **silently**; he has already looked away. | **§8.5 the resolution line is printed in the field, always** — `⏎ starts: <name>` / `6 match — keep typing` / `⏎ starts a new timer — <matter>` / `no match`. Criterion 43. His secondary suggestion — fire anyway on the most-recent match — is **declined in §8.5 with the reason**. |
| **A-4** | Digits 4–9 are not muscle memory: Recent recomposes on every start. | **§2.3 RECENT IS APPEND-ONLY WITHIN A DAY**, persisted in `settings.board.recent = { date, ids }`. Criterion 39. |
| **A-5** | The run bar bypasses the overnight repair — the fattest stop button on his phone banks fifteen hours. | **§4.8.4: any stop of a timer in repair state, from ANY surface, routes through the repair.** Criterion 67. |
| **A-6** | The same-day forget (`running-long`) gets the tooltip treatment B-4 was raised about, and is *more* frequent. | **One state family, one treatment** (§4.8): over the threshold the words go on the face and the repair becomes the primary. Criterion 68. |
| **A-7** | The repair menu leads with a hardcoded `6:00 pm` guess while the only evidence costs the same two taps. | **§4.8.2: the evidence goes on the tile face with a one-tap primary** `Stop at 6:12 pm`. The fabricated fallback becomes **the median stop time of the last 30 days**, labelled as a guess. Criteria 57, 60. |
| **A-8** | Prose says "one action", criterion said "≤3". | **§4.8.3 counts honestly:** one transaction, one Undo, **one tap** on the evidence primary and **two** through the menu. Criterion 58. |
| **A-9** | He said forty minutes and the app makes him say 0.7. | **§6.4:** the hours slot accepts `40m` / `40` / `:40` / `0.7`, echoes `0.7h — 40 min, rounded up from 0.67`, and the pills are labelled in both units. Criteria 74, 75, 76. |
| **A-10** | The front row is seeded from an accident of creation order and nothing ever says it went stale. | **§2.2 seeds from the most hours in the last 14 days**; **§2.7 nudges** when a front-row tile has been cold 30 days, with one-tap accept and dismiss-for-90-days. Criteria 7, 27, 28. |
| **A-11** | Band B rule 3 draws an empty labelled box after two weeks away. | **§2.3:** 14 → 30 → 90-day fallback, and **a band with no members renders neither tiles nor label**. Criterion 29. |
| **A-12** | The front row's cap of 6 contradicts everything built on 3. | **The front row is exactly 3.** No cap to learn. §2.2. Criteria 5, 2. |
| **A-13** | The phone's Recent band is never specified; a matter on his desktop board is absent from his phone board. | **§2.5 ONE LIST, THREE CUTS.** Phone 6 is a prefix of desktop 9 is a prefix of all 84. Criteria 20, 19. |
| **A-14** | "Resets to `working` on a new day" has no definition of a new day. | **§2.8 THE DAY BOUNDARY**, with the trigger, the data field and the harness. Criteria 30, 31. |
| **A-15** | Digit precedence doesn't cover focus in the entries list. | §8.3 precedence rule 5. Criterion 40. |
| **A-16** | `0.9h unfiled` is money styled as trivia — and it has no action. | **§5.3 the number was also arithmetically wrong**; §5.4 puts the corrected figure in the attention band as a button into the stepper. Criteria 87, 88. |
| **A-17** | Cut the RTL truncation trick. | **Cut.** §4.7 and §13.2 non-goal 15. Criterion 36 tests what replaced it. |
| **A-18** | The `📌` front-row flag duplicates the pinned flag on a band that suppresses duplicates. | **§4.11:** the front row carries **no glyph at all** — position and size are its marks. `📌` stays the float pin alone. Criterion 9. |
| **A-19** | Three separate mechanisms for "show me the matter number". | §4.9: two, and the spec stops counting Comfortable as an answer. |
| **A-20** | `Show all 84 timers` / `Hide the other 75` makes him read a self-rewriting label. | **Fixed text `All timers` / `Fewer timers`.** The count lives in the meta. Anti-pattern 14 rewritten. Criterion 4. |
| **A-21** | `⋯ Board options` is a preferences panel wearing a menu, with the one daily thing buried under ten settings. | **The menu is `Board setup…` and holds configuration only.** `Log time already spent…` is off it entirely — it is the page primary's own half and item #1 of every tile menu. Criteria 52, 71. |
| **A-22** | Six independent arrangement axes on a board whose thesis is stability. | Two on the face (grouping, order-is-manual); the rest behind `Board setup…`. §4.3. |
| **A-23** | `By client` grouping is a filing cabinet he'd never open. | **Judged wrong — kept, with the reason in §4.2.** It is one seg button of zero extra height, `Only: this client` needs the axis to exist, and the owner's own words are *"sortable, editable, etc."* Deleting an existing capability to save nothing violates the demotion-not-deletion rule. |
| **A-24** | Multi-select and batch cost a mode he has never used. | **Judged wrong — kept, with the reason in §7.5.** It is an existing capability, it spends **zero** resting pixels (it is one item inside `Board setup…`), and "nothing is dropped" is a structural rule of this document, not a preference. |
| **A-25** | `Shift+Alt+↑` for ±0.2h is a second modifier layer to save one keypress. | **Cut.** §8.4, and out of criterion 65. |

**From the completeness critic — integrity first**

| # | Finding | Closed by |
|---|---|---|
| **C-1** | **The overnight repair has no data source.** After `applyRollovers` the timer row is scrubbed; nothing in the payload says a rollover happened, names yesterday's banked entry or carries its hours. Six criteria depended on data that does not exist. | **§10.9 server change 3 + migration v19**: two nullable columns on `timers` written *inside* the rollover transaction, and a `rollover_from` object on the list projection. Specified in full in §4.8.1. Criteria 53, 54, 55, 57, 59. |
| **C-2** | **`POST /stop-at` has no matter check, and the design creates the cross-matter path itself.** | **§4.8.3 rules 8–10:** a 409 naming both matters, the matter printed beside **every** hours preview, and `last activity` scoped to this timer's own matter. Criteria 63, 64. |
| **C-3** | The owner's **"ask me each time" dialog** is assigned to this work and is absent. | **§6.5 THE MATTER-CHANGE DIALOG**, on the shared overlay: what it says, what the two answers do, and that **silence leaves the time behind**. Criteria 78, 79, 80. |
| **C-4** | The front row holds six but renders three. | Exactly 3 (A-12). |
| **C-5** | More than six worked today: timers 7, 8, 9 sink into the tail carrying unfiled time. | **§2.3: rule (a) is uncapped.** Only the backfill is capped. Criteria 114, 2. |
| **C-6** | `settings.board` is the only server-side view preference and its read-failure mode is unspecified. | **§2.9 THE MIRROR.** Render from `localStorage` immediately; reconcile only on a **successful** fetch; never seed on failure. Criteria 32, 33. |
| **C-7** | A tile pressed twice on a slow link, against a brand-new non-idempotent endpoint. | **§4.7 `data-pending`** + **`stop-at` idempotent on `(timer_id, at)`**. Criteria 48, 65. |
| **C-8** | The board below nine timers is undefined; e2e builds small fixtures. | **§2.10: at ≤9 timers the board does not band at all.** One flat grid, no labels, no disclosure. This is what keeps thirteen existing e2e assertions green. Criterion 34. |
| **C-9** | Nobody walks the sequence where a new start displaces the running timer. | **§8.6 THE DISPLACING START**, including what happens to the Undo. Criteria 94, 95. |
| **C-10** | Midnight with the page open. No trigger for the new-day reset. | §2.8 (A-14). |
| **C-11** | A board filtered to zero, and what the filter does to everything else. | **§2.6** — bands replaced, foot reduced, digits index matches, zero renders the blankslate in place of the grid. Criterion 35. |
| **C-12** | **There is no way to retire a timer. The board only grows.** | **§4.10 `Archive timer`** — reversible, entry-preserving, and a migration column rather than a promise the data model cannot keep. Criteria 108, 109. |
| **C-13** | `Pin to float window` and `Move to the front row` are two unrelated ways to say the same thing. | §4.11 (A-18): independent, each stated, one glyph between them. Criterion 9. |
| **C-14** | The attention band's `1 ran overnight` has no owner file. | **§10.10 assigns it to `dashboard.js` and to server change 3's `alerts` field.** Criterion 69. |
| **C-15** | New start paths do not write `tk:lastTimer`, so `t` toggles the wrong timer. | §8.7. Criterion 42. |
| **C-16** | A 60-character unbroken token overflows, and no measurement can catch it. | **§9.5** `overflow-wrap: anywhere` + `maxlength` on `.name-input`; **driven by inline rename**, so no seed churn. Criterion 36. |
| **C-17** | The test gate contradicts the owner's own status board. | **944**, measured at `185beff`. Criterion 110. |
| **C-18** | Small capability drops in a table that claims none. | §7.1 row 4 (narrative search restored), §7.2 row 11a (`· unnamed`), §7.5 row 89a (`relinked` toast). |
| **C-19** | Close-out, export and the 5s poll are never related to the board. | §5.4, §10.3, §9.6. Criteria 89, 107. |

**From the builder — this must become BUILDABLE**

| # | Finding | Closed by |
|---|---|---|
| **D-1** | Criterion 3 is **false at the seed**: the running timer is the 2nd created, lands in the front-row seed and is deduped out of Recent. | **§1.2 the seed is re-measured and §2.11 re-derives the worked example from it.** The invariant is restated as *the running timer is always in the prefix* — Band A **or** Band B. Criterion 6. |
| **D-2** | §2.2 contradicts itself and criteria 2/3 on front-row size. | Exactly 3 (A-12). |
| **D-3** | The greyscale criterion (≥1.5×) is unreachable at the specified heights: phone 1.27×, desktop ceiling 1.47×. | **Numbers fixed:** ordinary ceiling **36px** desktop against a **56px** front row (1.56×); phone front row becomes **72px** against 44px (1.64×). New token, re-derived page heights. Criterion 37. |
| **D-4** | `e2e-smoke.mjs:381` checks `el.closest('.work-row')` on the stop chips; the spec claims it still passes. **It does not.** | **§11 row 1.** Migrated to `closest('.timer-tile, .work-row')`. Criterion 111 (§11 row 1), and criterion 90. |
| **D-5** | `e2e:1228-1231` contradicts "`Only` applies to Band C only". | Closed by §2.10 — that fixture has one timer, so it does not band. §11 row 12. |
| **D-6** | Every `.group-head` assertion breaks in working scope; there are **13** call sites, not ten. | Same: §2.10. §11 rows 6–11 list all thirteen. |
| **D-7** | The mandated markup deletes `title` from every tile button; eight e2e click sites use it. | **§4.7: every tile button carries BOTH `title` and `aria-label`, with the same words.** §11 row 13. Criterion 97. |
| **D-8** | Criterion 36 is not implementable with the one sanctioned endpoint. | Server change 3 supplies `rollover_from`; **`POST /stop-at` accepts `dry_run: true`** and returns the preview without writing. §4.8.3. Criterion 59. |
| **D-9** | `timerboard.js ≤640` is unreachable — B-9 was moved, not fixed (≈830 priced). | **§10.1 re-budgets six files**, splitting the tile into `timertile.js`, with the builder's own omissions added to the arithmetic. Criterion 115. |
| **D-10** | `.sr-only` does not exist anywhere in the CSS. | **§9.3 creates it in `base.css`**, which is already a touched file. Criterion 98. |
| **D-11** | Three `STATUS.md` citations are wrong and the build is told to paste one into source. | **Re-checked line by line and corrected** — `STATUS.md:322-324` (the owner quote), `STATUS.md:348-370` (tenths), `STATUS.md:201-202` (worked-to-the-top). §10.2. Criterion 120. |
| **D-12** | Criterion 17 (`≤48` visible controls) has no counting rule and is unreachable (~100). | **Retired with the reason** and replaced by two counts that are defined and measurable — **criteria 17 and 18**. |
| **D-13** | Criteria 6/9 have neither a data shape nor a harness. | `settings.board.recent.date` is the shape (§2.8); **the harness gets an injectable clock** (§11 row 24). Criterion 30. |
| **D-14** | **The run bar is fixed to the TOP.** Every measured desktop `y` in §3 is wrong. | **§3.1 and §3.2 redrawn from `runbar.css:100-101,179`**, with `--runbar-total` in the arithmetic. Criteria 13, 21, 22. |
| **D-15** | Capability silently dropped: narrative-text search. | Restored, §7.1 row 4. Criterion 44. |
| **D-16** | The tile loses its expand chevron and gains no working touch path. | **§4.9: expansion is `x`, the tile menu's `Show details`, and a click on the front row's line 2.** Stated, not implied. Criterion 103. |
| **D-17** | The rtl truncation is the most expensive thing in the document and has no criterion. | Cut (A-17). |
| **D-18** | `timergrid.js ≤780` has 0–20 lines of headroom, not 40. | Ceiling restated at **≤800** with `batchMenuItems`, `selectCard`, the small helpers and the row assembly in the arithmetic. §10.1. |
| **D-19** | Criterion 61 cannot be observed as written (long-run marks fire at 2h). | Rewritten: request counting for the poll, **unit test** for the mark guard. Criterion 107. |
| **D-20** | `Undo` on a digit/Enter start has no mechanism against an exclusive start. | **§8.6:** `Undo` is offered **only when the start displaced nothing**. A displacing start toasts both names and offers `Open <displaced>'s entry`. Criterion 95. |
| **D-21** | `Show` (activity) scope vs the bands is undefined. | §2.3: `Show`, `Only` and grouping are **Band C only**, all three. Criterion 8. |
| **D-M1** | `--tile-h-front-touch` used and never defined; no token for the comfortable touch tile. | §9.2. |
| **D-M2** | `--space-1-5` is undefined in `tokens.css`. | Defined, §9.2. |
| **D-M3** | "all ten window-event listeners" — there are **seven**. | §10.2. |
| **D-M4** | Seed fact wrong: the longest name. | **Measured: 44 chars, `Acme — Borealis merger: disclosure schedules`.** §1.2. |
| **D-M5** | "83 timers" / "84" / "HE HAS EIGHTY-THREE TIMERS" in the comment the builder must paste. | **84 everywhere**, measured. §1.2, §10.2. |
| **D-M6** | `node scripts/poc-sync.sh --seed` — it is a bash script. | `bash scripts/poc-sync.sh --seed`. §1.3. |
| **D-M7** | "It keeps its undo" — `sortAZ` has no undo today. | Stated as **new work**, §4.3. |
| **D-M8** | `Only` renders only when `grouping !== 'flat'`. | Stated, §4.3. |
| **D-M9** | §11 row 11 omits five `.work-row` sites. | All listed, §11 rows 14–19. |
| **D-M10** | Digit caps paint simultaneously with `StopChips`' own `1 2 3` caps. | **§8.3: `.tile-key` is hidden board-wide while an offer is mounted.** Criterion 30. |

Everything revision 2 got right is kept: the capability table where **nothing is dropped**
(§7), the density levels (§4.9), the token discipline and the no-new-colour rule (§9.2),
the anti-patterns list (§9.7), the risk list (§13.1), and the default-view reasoning (§2.1,
§2.12).

---

## 1. THE SCALE, AND THE DECISION

### 1.1 Eighty-four timers is the design problem

The owner counted his live database on 2026-08-16: **83 timers, 89 matters, 421 entries.**
Revision 1 was drawn and measured at eight. That is not a rounding error; it is a different
product. At eight, a board is a bank of buttons. At eighty-four it is a wall, and a wall is
the thing he was already complaining about.

### 1.2 The seed, MEASURED — this table is the instrument, and revision 2's was partly wrong

`scripts/lib/demoseed.mjs` is the measuring instrument. Revision 2 quoted it from reading;
revision 3 quotes it from **running** it. The command is in §1.3; the run below was made on
this box on **2026-08-16** at commit `185beff`, `TZ=America/Los_Angeles`.

| Seed fact | Revision 2 said | **Measured** |
|---|---|---|
| Timers | 84 | **84** (5 hand-built + 79 bulk; one is the matterless quick timer) ✓ |
| Matters | 89 | **84** — revision 2 quoted the owner's *live* count as if it were the seed. **§1.4 amends the seed to 90** so the matter-with-no-timer case is measurable. |
| Clients | 16 + Internal | **17 distinct** (16 fictional + Internal) ✓ |
| Groups | 5 | **5** — Litigation, Corporate, Real estate, Pro bono, Internal ✓ |
| Longest timer name | 44 chars, `Meridian — physician group affiliation` | **44 chars, `Acme — Borealis merger: disclosure schedules`.** The two names revision 2 offered are 37 and 42. |
| Name collisions | 8 `Acme —`, 6 `Northgate —`, 5 `Verity —` | ✓ measured — truncation is the **normal** case |
| Timers with activity today | "worked today 6" | **7** — six stopped **plus the running one** |
| Running | 1, `Acme — merger` | **1, `Acme — merger`, id 2, `sort_order` 1 — the SECOND timer in manual order.** This is builder finding D-1 and it is real. |
| Entries today | 10 | **11** |
| Hours filed today | — | **15.0h** (14.6 billable, 0.4 non-billable), target 8 |
| Entries needing a narrative | 3 | **2** — `alerts.invalidDrafts` returns entries 3 and 4 (`narrative_empty`) |
| Dormant tail | 78 | **77** (84 − 7 with activity today) |
| Σ timer clocks | "0.9h unfiled" | **9.25h — and 8.83h of it is ALREADY FILED.** See §5.3: revision 2's `unfiled` arithmetic was wrong, not just its number. |

The six stopped timers and their clocks, measured (`sort_order | name | clock | linked entry`):

```
 7  Acme — office lease, Harbor Street        0.50h  → entry 23 (0.5h)
19  Verity — appeal, Ninth Circuit            0.92h  → entry 24 (1.0h)
32  Sandpiper — labelling compliance          1.33h  → entry 25 (1.4h)
46  Ellison — succession planning memo        1.75h  → entry 26 (1.8h)
63  Peregrine — music licensing clearance     2.17h  → entry 27 (2.2h)
75  Lyndon — ADA accessibility remediation    2.58h  → entry 28 (2.6h)
 1  Acme — merger  (RUNNING)                  ticking → entry 29 (0.0h so far)
```

**Wherever a number appears in this document it is taken at that seed and says so.** A
measurement quoted without the seed is not evidence.

### 1.3 Rebuilding and measuring it

```
bash scripts/poc-sync.sh --seed            # NOT `node` — it is #!/usr/bin/env bash
node scripts/uishots.mjs --out shots/board --only dashboard   # 1440×900 and 412×915
node scripts/uishots.mjs --strict
```

Or point a temp server at `seedDemo(base, { today })` directly, where `today` **must be the
local date** (`Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' })`) — passing
a UTC date after 5pm Pacific seeds tomorrow and every count comes out wrong. That is how
revision 2's entry count drifted.

### 1.4 One seed amendment, and why it is not cheating

The seed has 84 matters and 83 of them have a timer. The attorney's BLOCKER — *the partner
names a matter I have no timer for* — is therefore **unmeasurable** at this seed, and a
criterion that cannot fail is not a criterion.

So `demoseed.mjs` gains, in the same commit, **six matters with no timer**, fictional, on
existing clients:

```
100244-000077  Northgate — successor trustee appointment      Northgate Partners
100455-000066  Harbor — parking deck easement                 Harbor Lease Trust
100711-000066  Meridian — telehealth licensure review         Meridian Health
101044-000055  Ridgeway — Fund III wind-down                  Ridgeway Capital
101266-000066  Peregrine — podcast network carve-out          Peregrine Media
101599-000066  Ashcombe — athletics media rights              Ashcombe University
```

The seed then reads **84 timers / 90 matters / 17 clients**, which is deliberately the
shape of his live database (83 / 89). **The timer count does not change**, so every tile
measurement, every `All timers` label and every criterion in this document still stands at
84. No other seed change is sanctioned — in particular **no 60-character fixture name**: the
long-token case is driven through inline rename instead (§9.5, criterion 27), which costs
the screenshots nothing.

### 1.5 Hiding is sanctioned. This is the permission the first version did not have.

The owner, 2026-08-16:

> "we can definitely find ways to make the timers more compact. I use dozens. so hiding or
> sorting would be good. don't need to see all at once."

That sentence is the key to the whole design. He does **not** want to see 84 tiles. He
wants the few that matter today, and a fast way to the rest. Revision 1 tried to show
everything compactly; this document shows a **bounded working set** and puts the other 75
one labelled click away. Every "but he might need timer #61" objection is answered by the
filter — which searches all 84 timers **and all 90 matters** at all times (§2.6) — and by
one control that reveals them all.

### 1.6 The board comes back. The teardown was wrong.

The UI overhaul merged the timer board and the day's entry list into one full-width row
list (`TodayList` in `public/js/components/timergrid.js`). The owner rejected it
(`docs/ui/STATUS.md:322-324`):

> "The original base app has approximately the structure I want. A list of buttons that
> persist day-to-day. I don't recreate them. They are very compact, sortable, editable,
> etc. It should follow that."

And on the teardown's argument for the merge, 2026-08-16: **"teardown was wrong."**

So: the board returns as its own section, the day's entries are a separate list beneath it,
and `docs/ui/teardown.md:286-287` — the merge, which it called its single highest-value
change — **is dead**. Not deprecated, not "revisit later", not preserved behind a setting.
Dead. A builder who finds an argument for the merge in a comment, a test name or a doc has
found a bug in that artifact.

> **First edit of the build:** delete the 22-line comment at
> `public/js/components/timergrid.js:19-42` (the block headed
> `// ONE LIST OF TODAY'S WORK (teardown §5/§6, E1 …)`). Replace it with the comment in
> §10.2 — **which carries corrected citations**; revision 2's version told the builder to
> paste `STATUS.md:236-238`, which is a paragraph about session-4 verification.

Precedence: standing rules 1–3 > this document > `BRIEF.md` > `teardown.md` (which, on the
merge, has no force at all).

---

## 2. THE DEFAULT VIEW — what a board of 84 shows when he opens it cold at 9am

**This section is the heart of the revision.** If it is right, the rest is carpentry.

### 2.1 The workday it is designed against

1. **9:00 am, cold open.** He is about to work on one of the four or five matters that are
   *live this week* — not one of the 77 that are open but dormant.
2. **2:40 pm, a partner calls.** About six seconds while saying *"sure, let me pull that
   up"*. If he has to read tiles, he does not start the clock, and the hour is lost.
   **Revision 2 quietly redefined this moment into the easy one and declared victory** — the
   attorney caught it. A matter untouched for three weeks is in neither band. The honest
   answer for moment 2 is **the filter**, and the filter therefore has to be good enough to
   be the answer: it searches matters as well as timers, it prints what `⏎` will do, and it
   can create the timer that does not exist. §2.6 and §8.5 carry that weight now, not §2.2.
3. **6:30 pm, the dormant one.** Once or twice a day, a matter he has not touched in a
   month. Three seconds and a keystroke.
4. **5:50 pm, close-out.** Eleven entries, some without a sentence. This is the moment the
   app exists for and revision 2 never walked it. §5.5.

### 2.2 BAND A — THE FRONT ROW: exactly three, his, and never a number to remember

**The front row holds exactly 3 tiles.** Not "up to 3, cap 6". Three. One grid row at
≥1024px; three stacked tiles on the phone. Front-row height (§9.2): **56px desktop, 72px
touch** — 1.56× and 1.64× the ordinary tile, which is what makes criterion 28 passable
(D-3).

Why exactly three, in the words of the critic who caught it: *"the whole point is a shelf,
and a shelf with six things on it is a shelf you have to read."* A cap he can push against
is a rule he has to learn about his own board, and any rule he has to learn is app-thinking.

- **Membership is his.** Stored server-side in `settings.board.front` as an ordered array of
  exactly three timer ids. **It never changes by itself.**
- **He changes it** by dragging a tile onto the front row, by `Move to the front row` on the
  tile menu, or by pressing `f` on a focused tile. Adding a fourth **swaps out the
  last-placed member** and toasts `Front row: <in> replaced <out>` with `Undo`. There is no
  error, no cap message, no arithmetic.
- **Seeded from evidence, not from creation order** (A-10). On the first successful settings
  read that returns no `board.front`, seed it with the three timers whose matters carry the
  **most recorded hours in the last 14 days**, ties broken by most recent activity, then by
  `sort_order`. Revision 2's "the first three timers in manual order" put an arbitrary
  accident on his eye-level shelf and never mentioned it again.
- **If a front-row timer is deleted or archived**, it drops out and the band renders two.
  It is never silently auto-refilled — but §2.7 offers.

This band spends the two channels the first version left unspent — **size and position**.

### 2.3 BAND B — `Recent`: append-only within a day

Up to nine tiles total across A+B on desktop (six on the phone, §2.5). Ordinary height
(34px desktop / 44px touch), under a `--fs-micro` band label.

**Composition, computed ONCE per day and then frozen except for appends:**

1. **Rule (a) — today's work. UNCAPPED.** Every timer with clock time today
   (`elapsed_seconds > 0`) or a linked entry today (`linked_entry_id != null`), ordered by
   `last_started_at` ascending. *Uncapped* is the answer to C-5: `STATUS.md:201-202` says
   the one thing the current list gets right is that it *"sorts worked timers to the top, so
   the six that matter today are the six he sees first"* — a nine-matter day must not push
   timers 7–9, each carrying unfiled time, into a manual-ordered tail of 75.
2. **Rule (b) — the backfill.** Timers active in the **last 14 days**, most recently active
   first, added until A+B reaches 9. If 14 days yields nothing, try **30**, then **90**.
3. **Deduped against Band A**, which wins. A timer never renders twice.

**APPEND-ONLY WITHIN A DAY (A-4).** The composed order is persisted as
`settings.board.recent = { date: 'YYYY-MM-DD', ids: [...] }`. For the rest of that day the
band renders `ids` in stored order; a timer that becomes eligible later is **appended to the
end**, never inserted. A timer that enters at position 7 stays at 7 until tomorrow's reset.
This is what makes digits 4–9 real muscle memory for the only horizon that matters — a
workday — and it costs one sort rule plus one persisted array.

**A band with no members renders nothing — not even its label** (A-11). Monday after two
weeks away, if rules (a) and (b) are all empty at 90 days, `.band-recent` is absent
entirely. A labelled void on his worst-attention day of the year is worse than no band.

**`Show`, `Only` and grouping apply to Band C ONLY** (D-21). `Show: Yesterday` does not
empty the front row; `Only: Litigation` does not empty `Recent`. All three are filing
systems for the tail.

### 2.4 Default order is MANUAL, and that is a requirement

`Order` defaults to **`Manual`** — `sort_order` ascending, exactly as stored, exactly as he
last dragged it. Not "recent activity", not A–Z, not "smart". The board's entire premise is
that a button is in the same place tomorrow; an order the app recomputes is a board that
rearranges itself behind him, and a board that rearranges itself cannot be pressed without
reading. `Order` governs **Band C**; Bands A and B have their own stated rules.

`Recent activity` remains available in `Board setup… → Order`. `Sort A–Z…` is an **item**
in `Board setup…`, not a control on the face, because it is a once-a-year setup action whose
only job is to destroy the arrangement the board exists to preserve. It gains an undo — see
§4.3, and note that this is **new work**: `sortAZ` (`timergrid.js:504-509`) has no undo
today, and revision 2 wrongly described it as a keep (D-M7).

### 2.5 ONE LIST, THREE CUTS — the property that makes all of this work

There is exactly one ordered list of timers:

```
[ front row (3) ] ++ [ Recent (n) ] ++ [ all the rest, in Band C order ]
```

- **The phone renders the first 6.**
- **The desktop working scope renders the first 9.**
- **`All timers` renders all 84 — by APPENDING.** It never re-sorts, never re-flows, never
  moves a tile that was already on screen.

Each cut is a **prefix** of the next. That single property buys four things:

- **Digit keys mean one thing.** `1`–`9` are the first nine rendered tiles, in both scopes,
  all day. Muscle memory survives the disclosure. (§8.3)
- **Position persists** — literally the owner's ask.
- **The phone and the desktop agree** (A-13). Revision 2 silently capped the phone's Recent
  at 3 and never said so, which means a matter he touched Tuesday was on his desktop board
  and missing from his phone board. It is now the *same list*, cut shorter: positions 1–6
  are identical on both devices. *Position that does not survive the device is not
  position.*
- **Grouping cannot destroy the working set.** Grouping applies to Band C alone.

### 2.6 THE FILTER — the answer to 2:40 pm, and the most valuable thing added in this revision

**This closes attorney BLOCKER A-1.** At 84 timers the filter stops being a convenience and
becomes the primary way to reach anything not on the shelf. Revision 2's filter searched
**timer names only**, so a partner naming a matter with no timer produced *zero results and
no way forward* — Esc, hunt for `＋ New timer`, name it, save, start it, five-plus actions
while a partner listens to him type.

**Typing in the filter replaces the bands entirely with one flat band, `Matches`.** Its
contents, in this order:

**1 — TIMER MATCHES.** Drawn from **all 84 regardless of scope**, matched forgivingly on
timer name, matter short name, matter number, client name, task code, **and today's entry
narratives** (`matchesFilter`, `timergrid.js:796` — restoring the capability the control's
own label already advertises and revision 2 dropped, D-15). Digit caps re-print on the first
nine.

**2 — THE MATTER ROW.** When the query returns **0, 1 or 2 timer matches**, one extra row is
appended directly under the last tile, drawn from `GET /api/cms/picker?q=<query>` — the
endpoint `CmPicker` already calls (`cmpicker.js:110`), ranked by `rankMatters`
(`server/lib/matterSearch.js:24`). It shows the **best matter that does not already have a
timer**:

```
 ┌──────────────────────────────────────────────────────────────────────┐
 │ ⏎  Start a new timer — Northgate Partners · successor trustee        │
 │    appointment · 100244-000077                                       │
 └──────────────────────────────────────────────────────────────────────┘
```

`.match-new-timer`, a real `<button>`, full width, one grid row, `--surface-1` with a dashed
`--border-strong` edge — **the same dashed-outline language `.narrative-write` already uses
for "this does not exist yet"**. No new colour.

Pressing it (or `⏎` when it is the only offer, §8.5) does three things in one gesture:

1. `POST /api/timers` `{ name: <matter short_name>, cm_id, task_code: null }`
2. `POST /api/timers/:id/start`
3. toast `Started — <name> · new timer` with **`Undo`**, which stops the timer (inside the
   2-second misclick grace, so nothing is filed) and deletes it.

**One action, from a query that matched no timer at all.** That is the six-second path, and
it is the only one.

**Integrity fences on this path, all mandatory:**
- The timer is created **on the matter the row names and on no other**. The row prints
  client, matter and number precisely so the thing he confirms is the thing that is created.
- It carries **no narrative template, no stash, no suggestion**. A brand-new timer starts
  textually empty.
- The two POSTs are **not atomic**. If the start fails, the timer survives, the toast reads
  `Created — <name>. Not started.` and `Undo` deletes it. Time is never assumed.
- The offer is **suppressed entirely** when the best matter already owns a timer (that timer
  is already in the match list) and when the query is under 2 characters.

**Everything else the filter touches, specified (C-11):**

| Question | Answer |
|---|---|
| What happens to `.band-front` / `.band-recent`? | Removed from the DOM. One `.timer-band.band-matches` with one grid. |
| Does `All timers` stay in `.board-foot`? | **No.** It is meaningless — the filter already searches all 84. `.board-foot` shows `＋ New timer` alone while a query is typed. |
| What do digits do? | Index the first nine **matches**. A digit past the match count is a **no-op** — no toast, no beep, no focus move. |
| Zero matches **and** no matter offer? | The board blankslate (`§7 #10`) replaces the grid: `Nothing matches "xyz"` + `Clear filter` + `＋ New timer`. |
| Zero timer matches **but** a matter offer? | The matter row renders alone. This is the case that matters and it must not be swallowed by the blankslate. |
| Meta? | `3 of 84 shown`. |
| `Esc`? | Clears the query, restores the previous scope and bands, returns focus to the previously focused tile. |

### 2.7 The staleness nudge — refusing to edit is not the same as refusing to notice

R18 correctly forbids the app from silently rewriting his front row. The attorney's point is
that revision 2 then stopped: *"Six weeks in, my front row is three closed matters and I
don't know it."*

So: when a front-row timer has had **no recorded time for 30 days**, one quiet line renders
**inside Band A**, below the three tiles:

```
 Northgate — fund IV formation hasn't run in 6 weeks.
 Swap for Acme — Borealis merger: HSR clearance?      [ Swap ]  [ Not now ]
```

`.front-nudge`, `--fs-caption`, `--text-muted`, one line, `overflow-wrap: anywhere`, two
labelled buttons ≥44px on touch. `Swap` performs the exchange with an `Undo` toast; `Not
now` dismisses **that pairing for 90 days** (`settings.board.nudgeDismissed = { timerId:
isoDate }`). At most **one** nudge renders at a time — the oldest cold tile. It is never a
modal, never a colour, never a badge.

The replacement offered is the timer with the most hours in the last 14 days that is not
already in the front row — the same rule as the seed, so the suggestion is explainable in
one sentence.

### 2.8 THE DAY BOUNDARY — what "a new day" actually means (A-14, C-10)

He leaves this installed as a PWA and open overnight. He is, definitionally, the man who
leaves things running past midnight. Revision 2 said scope "resets to `working` on a new
day" and never said what fired it.

**The coordinator holds `today`**, derived from the same aligned tick that drives
`liveElapsed` (`startAlignedTick`, §10.2), as a local `YYYY-MM-DD` string. On every tick it
compares. **When `today` changes, in this order:**

1. `reload()` — refetch `/api/timers`, which runs `applyRollovers` server-side and returns
   the new `rollover_from` (§4.8.1). Any timer that ran through midnight enters
   `overnight` state **on screen, without a manual reload**.
2. `boardScope` → `'working'`.
3. `settings.board.recent` is recomposed from scratch for the new date, and PATCHed.
4. `settings.board.front` is **untouched** — it is his, and a date change is not an opinion.
5. A tile whose only claim on Band B was a `filed` entry from yesterday leaves the band; a
   `filed` tile becomes `idle` because `linked_entry_id` was nulled by the rollover.
6. The entries panel refetches, and its rows are yesterday's no longer.

The same comparison runs on `visibilitychange` and `focus`, so a phone woken at 8am
reconciles before he can press anything. **The 5s poll pauses while
`document.visibilityState !== 'visible'`** (C-19) — the wake refetch already covers the
resume, and 84 rows with six correlated subqueries every five seconds down a Cloudflare
tunnel to a sleeping phone is a battery bug this document should not ship.

**The harness** (D-13): `scripts/e2e-smoke.mjs:22` constructs the server with
`clock: () => new Date()`. It becomes

```js
let clockSkewMs = 0;
const deps = { db, config, clock: () => new Date(Date.now() + clockSkewMs) };
```

with a helper `advanceDays(n)` that sets the skew and dispatches `visibilitychange`. That is
the injection point criteria 17–19 drive. It is a harness change, not a product change.

### 2.9 `settings.board` — the mirror, because his front row must survive a bad tunnel (C-6)

Grouping, `Only`, activity, order and density are `localStorage` (`timergrid.js:120-146`)
and survive a dead network. The front row, the scope and the day's Recent order are
**server-side** deliberately, so the desktop and the Android PWA agree. That trade must not
cost him his shelf when the tunnel is slow.

```
settings.board = {
  front:  [id, id, id],                       // exactly 3, his, ordered
  scope:  'working' | 'all',
  recent: { date: 'YYYY-MM-DD', ids: [...] }, // the frozen day order (§2.3)
  nudgeDismissed: { '<timerId>': 'YYYY-MM-DD' }
}
```

**The rules:**

1. Every **successful** `GET /api/settings` mirrors `settings.board` into
   `localStorage['tk:board']`.
2. The board renders from the mirror **immediately, on first paint**. Three tiles never
   arrive late under a thumb that is already travelling.
3. Reconcile **only on a successful fetch**. A failed or timed-out read changes nothing.
4. **The first-run seed (§2.2) fires only when a fetch SUCCEEDED and returned no
   `board.front`.** Read literally, revision 2's rule fired on every failed fetch and
   silently rearranged his shelf.
5. A PATCH that 400s (R16) leaves the mirror in place and raises `Couldn't save your front
   row — it's still set on this device.` It never silently reverts the tiles.

### 2.10 A BOARD BELOW TEN TIMERS DOES NOT BAND AT ALL (C-8)

Every number in this document is taken at 84. At 4 timers, bands are theatre — and worse,
they are what would break thirteen existing e2e assertions built on small fixtures.

**Rule: when the board holds 9 or fewer timers (after archiving, before filtering), there
are no bands.** One `.timer-grid` inside one unlabelled `.timer-band.band-flat`, holding
every timer in Band C order (manual by default), grouped if grouping is on. Consequences,
all deliberate:

- No `.band-front`, no `.band-recent`, **no band labels**.
- **No `All timers` control** — `.board-foot` shows `＋ New timer` alone.
- Digits `1`–`9` index the rendered tiles, which is every timer there is.
- Grouping, `Only` and `Show` apply to **the whole board**, because the whole board is the
  tail. This is why `e2e-smoke.mjs:1228-1231` (`Only` → exactly one `.timer-row`) passes
  untouched (D-5) and why every `.group-head` assertion at lines 1144–1257 passes untouched
  (D-6).
- At **zero** timers the board renders §7 #9's blankslate — `＋ New timer` and `Start` —
  which is what `e2e-smoke.mjs:182` migrates to.
- The front row is **absent, not empty**, until the board bands. Membership set below the
  threshold is stored and honoured the moment the tenth timer exists.

Above nine, the bands appear. The transition is not animated and needs no explanation on
screen: he only ever sees one side of it.

### 2.11 THE WORKED EXAMPLE, RE-DERIVED FROM THE ACTUAL SEED (D-1)

Revision 2's worked example — *"the running `Acme — merger`, then the 5 other timers worked
today"* — was false twice over, and its criterion 3 could not pass. The measured facts
(§1.2): the running timer is `sort_order` 1, the second timer created, so it lands inside
"the first three in manual order" that revision 2 seeded the front row with, and Band B's
dedup then removed it from Recent.

Under revision 3's rules, at the seed, cold open, working scope, desktop:

**BAND A** — seeded by hours in the last 14 days (§2.2):

| Pos | Timer | Matter · client · number | 14-day hours |
|---|---|---|---|
| **1** | `Verity — appeal brief` | Verity appeal · Verity Labs · 100377-000004 | **24.9h** |
| **2** | `Acme — lease dispute` | Acme lease dispute · Acme Holdings · 100001-000012 | **16.1h** |
| **3** | `Acme — merger` **(RUNNING)** | Acme — Borealis merger · Acme Holdings · 100001-000031 | **2.6h** |

Position 3 is a genuine tie at 2.6h with `Lyndon — ADA accessibility remediation`; the
stated tie-break (most recent activity) gives it to the running timer. The criterion asserts
**the rule and the tie-break**, not the three literal names, so a seed edit does not silently
turn it green.

**BAND B** — rule (a), uncapped, `last_started_at` ascending, deduped against A:

| Pos | Timer | Clock | Entry |
|---|---|---|---|
| **4** | `Lyndon — ADA accessibility remediation` | 2.58h | 28 (2.6h, no written narrative) |
| **5** | `Peregrine — music licensing clearance` | 2.17h | 27 (2.2h, no written narrative) |
| **6** | `Ellison — succession planning memo` | 1.75h | 26 (1.8h, no written narrative) |
| **7** | `Sandpiper — labelling compliance` | 1.33h | 25 (1.4h) |
| **8** | `Verity — appeal, Ninth Circuit` | 0.92h | 24 (1.0h) |
| **9** | `Acme — office lease, Harbor Street` | 0.50h | 23 (0.5h) |

Rule (a) yields exactly six after dedup, so **no backfill is needed at this seed** and the
prefix is exactly nine. The phone renders positions **1–6**.

**THE INVARIANT, which replaces revision 2's false one:**

> **The running timer is always inside the working-set prefix — Band A or Band B, never
> Band C, in every scope, at every viewport.** Which band it lands in depends on his front
> row and is not the app's business. What the app guarantees is that it is always on screen
> and always has a digit.

And so he never has to hunt for the digit: **the run bar prints it.** `⏱ 3 · 00:41:12 · Acme
— merger`. One place, always, and it is the same key that returns him to it.

### 2.12 Why not the alternatives

| Considered | Rejected because |
|---|---|
| Show all 84, just smaller | 84 × 34px + gaps ≈ 1,176px of tiles on desktop, ~3,700px on the phone. It is the wall he complained about. |
| Scroll the board in a fixed-height well | A scroller hides *by accident* and gives no way to know what is hidden. |
| Collapse to groups by default | 5 collapsed sections is 5 clicks to reach anything, and the group a matter is filed under is not what he remembers about it. |
| Recency-only (no front row) | Moment 2 breaks, and position moves every day. |
| Front row only (no Recent band) | Moment 1 breaks: a 3-tile board at 9am is a board he expands every morning. |
| A "smart" learned ordering | Unexplainable motion. He cannot press what he cannot predict, and he cannot correct what he does not understand. |
| A front row of up to six | The attorney's own answer: a shelf with six things on it is a shelf you have to read — and it breaks the digit map, which is finding D-2. |
| Making the filter fire on ≥2 matches | Declined; see §8.5 for the reason, which is standing rule 1. |

---

## 3. THE SHAPE — both wireframes at eighty-four timers, **with the run bar where it actually is**

**Revision 2 drew the run bar fixed to the bottom of the desktop page and derived every `y`
from that.** It is fixed to the **top** — `public/css/runbar.css:100-101`:

```css
.runbar { position: fixed; top: 0; left: 0; right: 0; }
.tk-runbar .main { padding-top: calc(var(--runbar-total) + var(--space-6)); }   /* :179 */
```

With a timer running (the seed's own state) `--runbar-total` is
`--runbar-h + --border-w + safe-top` = `(44 + 4) + 1 + 0` = **49px**, so `.main` starts at
**y = 73**. Only the **bottom nav** is bottom-fixed, and it is phone-only
(`shell.css:872`). Every measurement below is re-derived from that. This is builder finding
D-14 and it moved the whole page down by ~76px.

### 3.1 Desktop — 1440 × 900, light, **84 timers**, 11 entries today, working scope, one timer running

```
x=0        200                                                                     1440
├──────────┼──────────────────────────────────────────────────────────────────────────┤
│════ RUN BAR (fixed, TOP, y 0–49) ═══════════════════════════════════════════════════│
│ ⏱ 3 · 00:41:12  Acme — merger    6.9h filed ▓▓▓▓▓░░ 86%   [▤][■ Stop][🔒 Close]      │
├──────────┼──────────────────────────────────────────────────────────────────────────┤
│ SIDEBAR  │ .main  max-width 1200 · content column 1136px · padding-top 73           │
│ 200px    │                                                                          │
│ ⏱Timekpr │ y=73   ‹ Sun, Aug 16, 2026 ›        [⋯ Day actions] [▶ Start│＋ Log time…]│
│ ▪Dashbrd │                                                          ↑ one control,  │
│ ▫Calendar│                                                            two verbs §6  │
│ ▫Search  │ y=125  ⚠ Needs attention: 2 need a narrative · 0.7h on 1 clock   (44px)  │
│ ▫Stats   │                                                                          │
│ ▫Clients │ y=185  ┌ Today ── meter ──────────────────────────────────────── 96px ─┐ │
│ ▫Export  │        └───────────────────────────────────────────────────────────────┘ │
│ ▫Settings│                                                                          │
│ ＋Add todo│ y=297  ╔═ .panel.timer-board ══════════════════════════════ 1136 × 283 ═╗│
│ ▫Run/todo│  309   ║ Timers 84 · 9 shown · 1 running · 0.7h unfiled                 ║│
│ ▫Float   │        ║   [Flat|Group|Client] [🔎 Filter timers or matters  /] [⋯ Setup]║│
│          │  345   ║                                          ← ONE 36px band       ║│
│          │  357   ║ ┌1─────────────┐┌2─────────────┐┌3─────────────┐ FRONT ROW     ║│
│          │        ║ │Verity — appeal│Acme — lease   │Acme — merger ⏱│ 56px tiles    ║│
│          │        ║ │Verity Labs ·  │Acme Holdings ·│Acme Holdings ·│ 3 across      ║│
│          │  413   ║ └───────────────┘└──────────────┘└──────────────┘ 2 lines each  ║│
│          │  421   ║ Recent                                              (17px)      ║│
│          │  444   ║ ┌4─────────────┐┌5─────────────┐┌6─────────────┐  34px tiles   ║│
│          │  478   ║ └───────────────┘└──────────────┘└──────────────┘  row-gap 8   ║│
│          │  486   ║ ┌7─────────────┐┌8─────────────┐┌9─────────────┐  col-gap 16   ║│
│          │  520   ║ └───────────────┘└──────────────┘└──────────────┘               ║│
│          │  532   ║ .board-foot                                                     ║│
│          │        ║ [＋ New timer]                              [All timers]        ║│
│          │  568   ║                                                                 ║│
│          │  580   ╚════════════════════════════════════════════════════════════════╝│
│          │                                                                          │
│          │  596   ╔═ .panel.entry-panel ══════════════════════════════ 1136 × 300+ ═╗│
│          │  608   ║ Today's entries   11 entries · 15.0h             [⋯]           ║│
│          │  656   ║ ▌Acme — Borealis merger (⏱ running)                            ║│
│  Press ? │  710   ║ ▌Lyndon — ADA accessibility remediation (draft)(no narrative)  ║│
│ for      │  764   ║ ▌Peregrine — music licensing clearance (draft)(no narrative)   ║│
│ shortcuts│  818   ║ ▌Ellison — succession planning memo (draft)                    ║│
│          │  872   ║ ▌Sandpiper — labelling compliance … (below the fold; the panel ║│
│          │        ║   scrolls with the page — nothing is hidden by the design)     ║│
└──────────┴──────────────────────────────────────────────────────────────────────────┘
```

**Derivation of the vertical stack** (1440×900, 84 timers, working scope, Compact, running):

| y | Element | Height |
|---|---|---|
| 0 | run bar (fixed, top) | 49 |
| 73 | page head (`.main` padding-top = 49 + 24) | 36 |
| 125 | attention band | 44 |
| 185 | Today meter panel | 96 |
| 297 | `.timer-board` panel top (pad 12) | — |
| 309 | control band (heading + meta + seg + filter + `⋯`) | 36 |
| 357 | front-row tiles (`--tile-h-front` 56) | 56 |
| 421 | `Recent` band label (`--fs-micro`) | 17 |
| 444 | `Recent` row 1 (`--tile-h-compact` 34) | 34 |
| 486 | `Recent` row 2 (row-gap 8) | 34 |
| 532 | `.board-foot` | 36 |
| 580 | panel bottom | **283 total** |
| 596 | `.entry-panel` top | — |
| 656 | first `.work-row` | 48 |
| 872 | fifth `.work-row` — the fold | 48 |

**Chrome above the first pressable tile: 60px** (panel pad 12 + one 36px band + 12 gap).
Baseline 142px. The heading, the meta, the grouping seg, the filter and `⋯` share one band
because **A–Z came off the face** (B-3).

**Four entry rows are fully visible, not five.** Revision 2 claimed five above a run bar it
had placed at the bottom; with the bar honestly at the top, 73px of the page is gone before
anything renders. Criterion 11 says four. Understating the fit and passing beats overstating
it and shipping a page that scrolls at 9am.

For contrast, the same page with the first version's design at 84 timers: 28 tile rows ×
42px = **1,176px of tiles**, first entry row at y ≈ 1,566, the entries list far below the
fold. That is the regression this revision exists to prevent.

### 3.2 Phone — 412 × 915, **84 timers**, working scope, one timer running

```
┌────────────────────────────────────────┐ 412px, gutter 16 → 380px usable
│════ RUN BAR (fixed, TOP) ═════════════ │  y=0…76
│ ⏱ 3 · 00:41:12  Acme — merger [■ Stop] │
│ ‹  Sun, Aug 16        [⋯]  [▶│＋ Log]  │  y=76…132   page head, split primary
│ ⚠ 2 need a narrative · 0.7h unfiled    │  y=132…176  attention band, both tappable
│ ┌ Today ──────────────── meter ──────┐ │  y=176…272
│ └────────────────────────────────────┘ │
│ ╔ Timers 84 · 6 shown · 1 running ════╗│  y=288  board panel top
│ ║ [🔎 Filter timers or matters    /] ║│  y=300…336  band 1 (36px)
│ ║ [Flat|Group|Client]     [⋯ Setup]  ║│  y=344…380  band 2 (36px)
│ ║ ┌────────────────────────────────┐ ║│  y=392  FRONT ROW tile 1 (72px)
│ ║ │1 Verity — appeal brief         │ ║│
│ ║ │  Verity Labs · 100377-000004   │ ║│
│ ║ │  0.0                     [▶] ⋯ │ ║│
│ ║ ├────────────────────────────────┤ ║│  y=470  tile 2 (72px)
│ ║ │2 Acme — lease dispute          │ ║│
│ ║ │  Acme Holdings · 100001-000012 │ ║│
│ ║ ├────────────────────────────────┤ ║│  y=548  tile 3 (72px)
│ ║ │3 Acme — merger            ⏱    │ ║│
│ ║ │  Acme Holdings · 100001-000031 │ ║│
│ ║ │  00:41:12   0.7          [■] ⋯ │ ║│
│ ║ └────────────────────────────────┘ ║│  y=620
│ ║ Recent                             ║│  y=626…643
│ ║ ┌4 Lyndon — ADA accessibi… ▶⋯┐    ║│  y=649…693   44px tiles
│ ║ ├5 Peregrine — music lice… ▶⋯┤    ║│  y=699…743
│ ║ ├6 Ellison — succession p… ▶⋯┤    ║│  y=749…793
│ ║ └────────────────────────────────┘ ║│
│ ║ [＋ New timer]     [All timers]    ║│  y=805…849   44px, both labelled
│ ╚════════════════════════════════════╝│  y=861  panel bottom
│ ╔ Today's entries  11 · 15.0h   [⋯] ═╗│  y=877
│ ║ ▌Acme — Borealis merger (⏱ running)║│
│ ║ ▌Lyndon — ADA accessibility remed. ║│
│ ║  No narrative yet ✎  2.6 [▶] [⋯]   ║│
│ ║ … 4 more rows …                    ║│
│ ║ [Show all 11 entries]              ║│  ← phone only, §5.4
│ ╚════════════════════════════════════╝│
│════ BOTTOM NAV (fixed) ═══════════════│
│  Today   Calendar   Search   ⋯        │
└────────────────────────────────────────┘
```

One column. Front-row tiles **`--tile-h-front-touch` 72px** (raised from 56 — see D-3;
72/44 = **1.64×**, which is what makes the greyscale criterion passable, and the extra 16px
is what lets the three-line front tile carry client · number without clamping). Ordinary
tiles `--tile-h-touch` 44px, row gap 6px. `scrollWidth === 412`.

**Total page height, derived, 84 timers + 11 entries:**

```
run bar 76 + head 56 + attention 44 + meter 96 + gaps 4×16=64
+ board panel 573  (12 pad + 36 + 8 + 36 + 12 + 3×72+2×6=228 + 17 + 6 + 3×44+2×6=144 + 12 + 44 + 12 + 6)
+ entries panel 430 (12 + 44 + 12 + 6×48+5×6=318 + ... clamped by the 6-row cap, §5.4)
+ bottom nav 56
= 1,395px  →  criterion 22 sets the ceiling at 1,480px
```

Revision 2 claimed ≤1,400 with the front row at 56px and the run bar at the bottom. The
honest ceiling with the taller front row and the top bar is **1,480px**, and it is still
under two viewport heights, which is the thing that actually matters.

Digit caps are **not drawn below 768px** — the same rule `stopchips.js` already uses for its
`1 2 3` caps (`useWideViewport`, `stopchips.js:949`). Omission, not translation. The numbers
in the sketch are positions, shown for the reader; on the phone the tile face carries no
`<kbd>`.

---

## 4. THE TIMER BOARD

Container: `<section class="panel timer-board" aria-labelledby="tk-board-h">`. The panel is
the raised surface (`--surface-1`, `--border`, `--radius-md`, `--shadow-1`) and the tiles
inside drop to `--surface-0`. **The board reads as a tray of inset buttons, not cards
floating on a page.** That relationship is the owner's stated taste and is mandatory
(`.panel .timer-tile { background: var(--surface-0) }`).

### 4.1 Section header and meta

`<h2 id="tk-board-h" class="t-heading">Timers</h2>` followed by a muted
`<span class="board-meta t-label">`. At the seed, working scope, nothing typed:

**`84 timers · 9 shown · 1 running · 0.7h unfiled`**

- `84 timers` — the total, always. He is entitled to know the board is not the whole bank.
  With archived timers present it reads `84 timers · 3 archived`.
- `9 shown` — the working set count. `84 shown` in `all` scope; `3 of 84 shown` while a
  filter is typed (this is where the `1/N` counter now lives — §11 row 3).
- `1 running` — omitted when nothing runs.
- `0.7h unfiled` — **the corrected quantity, see §5.3.** It is *not* the sum of the timer
  clocks. Omitted when zero.

### 4.2 The control row — one band, five controls at rest

`--control-h-md` (36px), `gap: var(--gap-inline)`, wrapping to two bands ≤767px. Left to
right: heading + meta · flex spacer · grouping · filter · `⋯`.

| # | Control | Markup | Does | On screen because |
|---|---|---|---|---|
| 1–3 | **Flat ｜ Group ｜ Client** | `.seg` with 3 `<button>`, `aria-label="Group"` | Sets `tk:timerGrouping`; groups **Band C only** (§2.3). Default `flat`. | The owner's words are *"compact, sortable, editable, etc."* (`STATUS.md:322-324`). One physical control, no menu round-trip. |
| 4 | **Filter timers or matters** | `<input class="timer-search" type="search" placeholder="Filter timers or matters  /">` — **always visible, never a toggle** | §2.6. Searches all 84 timers **and all 90 matters** in every scope; `⏎` acts on the printed resolution (§8.5) | Standing rule 3, and it is the answer to 2:40 pm. |
| 5 | **✕ clear** | `.timer-search-clear`, 44×44 | Clears the query, keeps focus in the field | Exists only while a query is typed. |
| 6 | **⋯ Board setup** | `.btn.btn-icon.today-menu-btn`, `aria-label="Board setup"` | §4.3 | One button replacing eight. |

Below the grid, **outside it** (B-11), `.board-foot`:

| Control | Markup | Notes |
|---|---|---|
| **＋ New timer** | `.btn.btn-sm`, **outline, not accent-filled** | Not the loudest control — the page header holds the screen's one filled-accent surface (§6.1). |
| **All timers** / **Fewer timers** | `.btn.btn-sm.board-more`, `aria-expanded` | **Fixed text, both states** (A-20). Revision 2's `Show all 84 timers` / `Hide the other 75 timers` made him *read* a self-rewriting label every time — the exact sin this document prosecutes. The count lives in the meta, which is a passive readout. Absent while filtering (§2.6) and absent below ten timers (§2.10). |

**On keeping `By client` (attorney item A-23, judged wrong).** He would cut it: *"75 tiles
across 16 clients is a filing cabinet I'd never open."* It stays, for three reasons stated
here so the disagreement is on the record rather than silently overruled: it is **one seg
button inside a band that exists anyway**, so its resting cost is zero pixels and zero extra
tab stops; `Only: this client` in `Board setup…` needs the client axis to exist at all; and
deleting a working capability to save nothing breaks this document's demotion-not-deletion
rule (§7), which is the rule that keeps eighty-nine capabilities honest. If he never opens
it, it costs him nothing. If it were behind a menu and he wanted it, it would cost him two
taps forever.

**Not on the board, deliberately:** `A–Z` (demoted, §4.3), `📁 New group`, `⤓ Import`, batch
actions, a second `Quick start`, and a duplicate quick-timer tile in the grid.

### 4.3 `Board setup…` — configuration only, and nothing he needs daily (A-21)

Shared `Menu` component (`components/menu.js:408`) — no fourth menu implementation.
Title: **`Board setup`**. Every row 44px, tap-reachable.

Revision 2 called this `Board options` and made `Log time already spent…` its first item —
so *the one thing he needs daily sat on top of ten configuration switches, and he read past
all ten every time.* That is fixed by removing it from this menu entirely: logging past time
is the page primary's own half (`＋ Log time…`, §6.1) and item #1 of every tile menu (§6.2).
**Nothing in `Board setup…` is used more than once a month.**

1. `Show` — `.seg`: `All | Ran today | Yesterday | This week | Recent` → `tk:timerActivity`.
   **Band C only** (D-21).
2. `Only` — `<select>`: `Everything | This group… | This client…` → `tk:timerOnly:<grouping>`.
   **Rendered only when `grouping !== 'flat'`**, exactly as `timergrid.js:1011` does today
   (D-M8). Band C only.
3. `Order` — `.seg`: **`Manual` (default) `| Recent activity`** → `tk:timerOrder`. Band C only.
4. `Density` — `.seg`: `Compact | Comfortable` → `writeDensity()` (global, §9.4)
5. `Show archived timers` — checkbox (§4.10)
6. `Select several…`
7. `New group…` → `GroupModal`
8. `Rename "<group>"…` / `Delete "<group>"` — only when `Group` + an `Only` selection
9. `Import timers from CSV…` → `TimerImport`
10. **`Sort A–Z… (rewrites your manual order)`** — writes `sort_order` A–Z within groups via
    `PUT /api/timers/order`. **Undoable — and this is NEW WORK** (D-M7): `sortAZ`
    (`timergrid.js:504-509`) has no undo today and revision 2 wrongly listed it as a keep.
    Capture the pre-sort id array, toast `Sorted A–Z by name, within groups` with an `Undo`
    that re-PUTs the captured order.

### 4.4 Scope chips — still deliberately NOT restored

The baseline's `role="tablist"` chip strip does not come back. It mixed two incompatible
filter axes in one mutually-exclusive tablist, advertised empty sets, duplicated itself, and
cost 57px of vertical band forever. Its on-screen replacement is the existing `.filter-pill`
row — when and only when a filter is active, one pill per active filter (`Ran today ✕`,
`Only: Litigation ✕`), directly under the control band, clickable to clear. Zero height when
nothing is filtered.

At 84 timers this matters more, not less: a permanent 57px strip whose counts are mostly `0`
is 57px stolen from the working set.

### 4.5 Bands, sections and grids

```html
<div class="board-bands">
  <!-- ≤9 timers: ONE unlabelled band, no front row, no Recent (§2.10) -->
  <div class="timer-band band-flat">
    <div class="timer-grid density-compact" role="list"> … every timer … </div>
  </div>

  <!-- >9 timers, working scope: -->
  <div class="timer-band band-front">
    <div class="timer-grid grid-front density-compact" role="list"> … 3 tiles … </div>
    <div class="front-nudge" hidden><!-- §2.7 --></div>
  </div>
  <div class="timer-band band-recent">
    <div class="band-label t-micro" id="tk-band-recent">Recent</div>
    <div class="timer-grid density-compact" role="list" aria-labelledby="tk-band-recent"> … </div>
  </div>
  <!-- all scope only: -->
  <div class="timer-band band-all">
    <div class="band-label t-micro" id="tk-band-all">All timers</div>
    <section class="timer-section" aria-labelledby="g-3">
      <div class="group-head" id="g-3"><span class="group-name">Litigation</span>
        <span class="muted">21</span></div>
      <div class="timer-grid density-compact" role="list"> … tiles … </div>
    </section>
  </div>

  <!-- while a query is typed: everything above is replaced (§2.6) -->
  <div class="timer-band band-matches">
    <div class="timer-grid density-compact" role="list"> … matches … </div>
    <button class="match-new-timer"><!-- ⏎ Start a new timer — … --></button>
  </div>
</div>
```

- **Bands A and B are never grouped, never re-sorted, never filtered by `Show` or `Only`.**
- `flat` (default) in Band C: one unnamed grid, **no `.group-head`**.
- `Group` / `Client` in Band C: one `.timer-section` per group with `.group-head`
  (`.group-name` + a muted count). **Suppress the heading when there is exactly one section
  and it is the null/ungrouped one.** The `.group-head` also renders a muted **`· unnamed`**
  marker with a `title` pointing at Clients & Matters when a `Client` section has a number
  but no name — the capability at `timergrid.js:1160-1161` that revision 2 dropped (C-18).
- Every `.timer-section` contains exactly one `.timer-grid`.
- The front row and every `.timer-section` are drag targets (`dragover`/`drop`).

### 4.6 The tile grid

```css
.timer-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(var(--tile-min), 1fr));
  column-gap: var(--gap-block);      /* 16px */
  row-gap: var(--space-2);           /* 8px  */
  align-items: start;                /* an expanded tile grows alone */
  min-width: 0;
}
```

`--tile-min: 288px` (new token, §9.2). Resulting column counts — **verify by measurement,
they are acceptance criteria**:

| Viewport | Content column | Columns |
|---|---|---|
| ≥1024px (sidebar 200, `.main` max 1200) | 1136px | **3** |
| 768–1023px (76px nav rail) | 660–920px | 2 (3 at ≥1000) |
| ≤767px (`grid-template-columns: 1fr`) | 380px @412 | **1** |

**Row-major, not column-major.** The baseline used `columns: 300px` multicolumn so an A–Z
sort read top-to-bottom down a column. Reversed here on purpose: multicolumn cannot do
responsive track counts, leaves a hole at the bottom-right on any count not divisible by 3,
and makes arrow-key order and drop targeting disagree with what is on screen. Record this
reversal in a comment next to the rule.

**Reading the column count — with the guard (B-12).** Chrome returns the *specified*
`repeat(auto-fill, minmax(288px, 1fr))` string when a grid is `display:none` or detached,
and that string splits into three whitespace chunks, so a naive reader returns 3 by
coincidence and the arrow keys silently break:

```js
// public/js/lib/boardselect.js
export function colsOf(gridEl) {
  if (!gridEl || !gridEl.offsetParent) return 1;   // hidden or detached — no geometry
  const t = getComputedStyle(gridEl).gridTemplateColumns;
  if (!t || t === 'none') return 1;
  const tracks = t.trim().split(/\s+/).filter((v) => /^[\d.]+px$/.test(v));
  return tracks.length || 1;                        // resolved px tracks only
}
```

Recompute on `resize` (debounced) and on grid mutation. **`colsOf` is called per grid, not
once for the board.**

### 4.7 The tile

```
 ┌──────────────────────────────────────────────────────┐  288 × 34 (ordinary, compact)
 │4│▌ Lyndon — ADA accessibility remed…   02:34:00 2.6[▶]⋯│
 └──────────────────────────────────────────────────────┘
  ↑kbd ↑rail ↑name (flex:1 1 0, ellipsis)  ↑clock ↑tenths ↑transport ↑overflow
  14px  3px   --fs-label / --fw-medium      running  always  32×28     28×28

 ┌──────────────────────────────────────────────────────┐  288 × 56 (FRONT ROW, compact)
 │3│▌ Acme — merger                                 [■]⋯│
 │ │  Acme Holdings · 100001-000031      00:41:12   0.7 │
 └──────────────────────────────────────────────────────┘
   ↑ the front row is 2 lines: the extra height buys the MATTER IDENTITY
     that the 34px tile can only carry in title and the .sr-only line.
```

Markup — the classes are contractual (tests and CSS bind to them), and the ARIA is
mandatory in this exact shape (B-10):

```html
<div class="timer-tile timer-row worked running"
     role="listitem" tabindex="0"
     data-timer-id="2" data-row-key="t2" data-state="running" data-pos="3"
     title="Acme — merger · Acme — Borealis merger · Acme Holdings · 100001-000031 · running">
  <kbd class="tile-key" aria-hidden="true">3</kbd>
  <span class="sr-only">Acme — merger, Acme — Borealis merger, Acme Holdings,
        100001-000031. Running, 0.7 hours.</span>
  <button class="timer-name" tabindex="-1" title="Acme — merger">Acme — merger</button>
  <span class="timer-flag idle-nudge" aria-hidden="true">⚠</span>
  <span class="timer-clock-pair">
    <span class="timer-clock-raw t-clock" aria-hidden="true">00:41:12</span>
    <button class="timer-clock figure-md" tabindex="-1"
            title="Clock: 0.7 hours. Edit." aria-label="Clock: 0.7 hours. Edit.">0.7</button>
  </span>
  <button class="timer-stop-btn" tabindex="-1"
          title="Stop &amp; file time"
          aria-label="Stop &amp; file time — Acme — merger">■</button>
  <button class="timer-more" tabindex="-1"
          title="Row menu" aria-label="Timer menu — Acme — merger">⋯</button>
  <div class="timer-body" hidden><!-- expansion, §4.9 --></div>
</div>
```

**Every tile button carries BOTH `title` and `aria-label` (D-7).** Revision 2's markup gave
them `aria-label` only, which silently breaks eight e2e click sites that select
`button[title="Start"]`, `button[title="Stop & file time"]` and `button[title="Row menu"]`
(`e2e-smoke.mjs:359, 361, 370, 374, 733, 776, 1168, 1545`) and matches the real code
(`timergrid.js:1578, 1644`). The `title` is the short verb; the `aria-label` is the verb plus
the timer name, because a screen reader hears the button out of context and a pointer user
does not. **The `title` must never be the only place a state lives** (that was blocker B-4)
— it is a redundant channel, not a primary one.

**The ARIA rules, and why (B-10).**

- `.timer-grid` is `role="list"`; each tile is `role="listitem"` with roving `tabindex`.
- **No `role="button"` on the tile. No `aria-pressed` anywhere on the container.**
- Running state is announced by **the transport button's own accessible name** plus the
  `.sr-only` line.
- Each `.timer-section` is `aria-labelledby` its `.group-head`; each band grid is
  `aria-labelledby` its `.band-label`.

**Element inventory, left to right:**

| Slot | Element | Type scale | Flex | Notes |
|---|---|---|---|---|
| key cap | `.tile-key` | `--fs-micro` / `--text-muted` | `flex: none`, 14px | Positions 1–9 only, **≥768px only**, and **hidden board-wide while a stop offer is mounted** (D-M10). `aria-hidden`. |
| rail | `.timer-tile::before` | — | `position:absolute; left:0; width: var(--valid-mark-w)` | Colour by state, §4.8. Never the only channel. |
| name | `.timer-name` | `--fs-label` / `--fw-medium` | `flex: 1 1 0; min-width: 0; white-space: nowrap; text-overflow: ellipsis` | Click → inline rename (`.name-input`, `maxlength="80"`, §9.5). Enter commits, Esc abandons. |
| flags | `.timer-flag` (⚠ idle-nudge, 🌙 overnight, 📌 pinned-to-float, ⏸ paused) | `--icon-sm` | `flex: none` | Only render when true. **There is no front-row glyph** (§4.11). |
| clock | `.timer-clock-raw` | `--fs-clock` / `--font-clock` | `flex: none` | **Rendered only while running.** |
| tenths | `.timer-clock` (button) | `--fs-num-sm` / `--fw-semibold` / `--figure` | `flex: none` | Always. Click → `.figure-edit` with `−`/`+` `.figure-step` pills. `PUT /api/timers/:id/clock`, **quantised to 0.1h**. |
| transport | `.timer-start-btn` / `.timer-stop-btn` | 32×28, `--icon-md` glyph | `flex: none` | The tile's one primary. |
| overflow | `.timer-more` | 28×28 | `flex: none` | **Persistent — never `visibility:hidden` until hover.** |

Two painted buttons on a resting tile — transport and `⋯`. The name and the tenths are
click-to-edit **typography**, not chrome.

**`data-pending` — a control with no acknowledgement is a control pressed twice (C-7).**
The board adds four ways to fire a start (tile transport, digit key, `⏎` on a lone match,
tile menu) against a `start` that is a bare `await api.post(...)` whose only confirmation
(`.just-started`, `timergrid.js:300-305`) fires *after* `await reload()`. Over the tunnel
that is hundreds of milliseconds of a tile that looks untouched. So:

- On press, the tile takes `data-pending="1"` **optimistically**: the transport button is
  `disabled` (via `--state-disabled-bg/-fg/-border`, never `opacity`), the rail dims to
  `--border-strong`, and the `⋯` stays live. No spinner.
- Cleared by the reload that follows, or by the error toast.
- A second press while pending is **swallowed** — no second POST.
- `POST /stop-at` is **idempotent on `(timer_id, at)`**: a repeat within the same minute
  returns the same `undo_token` and `changed[]` without writing again.

**Matter identity at 84 timers with colliding names.** Eight seeds begin `Acme —` and six
begin `Northgate —`; the ordinary 288×34 tile truncates at roughly 26 characters. Three
answers, none of which cost hue:

1. **The front row is two lines** and carries `client · matter number` on line 2.
2. **Comfortable density** adds the same second line to every tile (§4.9).
3. `title` **and** the `.sr-only` line carry name + matter + client + number on every tile at
   every density.

**Revision 2's fourth answer — the RTL truncation trick — is CUT** (A-17, D-17). It made a
tile *look different depending on which other tiles happened to be on screen*, which is the
exact instability this document exists to eliminate; it would mangle `100001-000011` and
em-dashes under bidi; it required a pairwise prefix scan plus a per-tile overflow
measurement across up to 84 tiles in a component that re-renders on a 1s tick; and it had no
acceptance criterion, which anti-pattern 15 forbids. The real fix for two tiles reading
`Acme — Borealis merger: HSR…` and `Acme — Borealis merger: dis…` is that he can rename
either one in place, in one click, on the tile.

**Unassigned tiles.** Time accruing to nothing is the one dangerous state, so it is loud: a
45° hatch across the whole tile **and** the literal words `no matter` in place of the tenths,
plus an `Assign matter` button on the expanded body.

### 4.8 Tile states — and the ONE repair that serves both forgot-to-stop failures

`data-state` is the machine-readable channel; the rail is the visual one; a glyph or a word
is always the third. **No state is expressed by colour alone.** Rail priority, highest first:

| State | Class / `data-state` | Rail | Fill | Second channel | Transport |
|---|---|---|---|---|---|
| **Ran overnight** | `.overnight` / `overnight` | `--attention`, 3px | `color-mix(in srgb, var(--attention) 7%, var(--surface-0))` | **words on the tile face**: `ran overnight · 15h — last activity 6:12 pm`, `--fs-caption`, replacing the tenths; `🌙 .timer-flag` | **`Stop at 6:12 pm`** primary + `Stop at…` secondary (§4.8.2) |
| **Running too long** | `.running.idle-nudge` / `running-long` | `--attention`, 3px | as overnight | **the same treatment**: `running 6h — last activity 1:40 pm` on the face, `⚠ .timer-flag` | **the same repair** (§4.8.4) |
| **Running** | `.running` / `running` | `--live`, 3px | `color-mix(in srgb, var(--live) 7%, var(--surface-0))` | the ticking `hh:mm:ss` **appears only on this tile** — a content difference, not a hue — plus the tenths in `--live` | `.timer-stop-btn`, ■, `--danger` text + border |
| **Paused with time** | `.worked` / `paused` | `--border-strong`, 3px | `--surface-0` | `⏸ .timer-flag` + non-zero tenths in `--figure` | `.timer-start-btn`, ▶, `Resume` |
| **Has a draft entry today** | `.worked.filed` / `filed` | `--border-strong`, 3px | `--surface-0` | a 6px `.timer-flag.filed` dot + `title="Filed today — see Today's entries"` | `.timer-start-btn`, ▶, `Start` |
| **Unassigned** | `.unassigned` / `unassigned` | none | 45° hatch, `--surface-1`/`--surface-2`, 7px stripes | the words `no matter` replace the tenths | `.timer-start-btn`, ▶ |
| **Pending** | `[data-pending]` | dims to `--border-strong` | unchanged | transport `disabled` | disabled |
| **Idle** | — / `idle` | none | `--surface-0` | tenths read `0.0` in `--figure-quiet` | `.timer-start-btn`, ▶, `--transport` |
| **Archived** | `.archived` / `archived` | `--border`, 1px | `--surface-1` | the word `archived` where the tenths were; only rendered under `Show archived timers` | `Restore` (no transport) |
| **Selected** | `.selected` | `--state-selected-mark`, `var(--state-mark-w)` inset | `--state-selected` | checkbox checked | unchanged |
| **Dragging** | `.dragging` | — | `opacity: .35` | 2px dashed `.timer-drop-slot` at the landing site | unchanged |
| **Offering** (stop chips mounted, §10.7) | `.offering` | as its underlying state | as underlying | the tile spans `grid-column: 1 / -1` and grows to hold the offer | unchanged |
| **Just started** | `.just-started` | — | one-shot pulse, `--dur-base` | respects `prefers-reduced-motion` | — |

Green is **not** in the palette. Hours figures get **no hue** — rank by size, weight and
tabular figures (`--figure` tier).

**One state family, one treatment (A-6).** Revision 2 gave `overnight` the words on the face
and gave `running-long` — *the more frequent failure*, the timer left through lunch and
noticed at 3pm — a `⚠` on the face, the words hidden **inside the expanded body**, and
`Stop at…` buried in `⋯`. That is precisely the tooltip treatment blocker B-4 was raised
about, reintroduced one row down the table. **They are now the same code path and the same
design.** The only difference is the threshold and the wording:

| | Enters the state when | Face text |
|---|---|---|
| `overnight` | `rollover_from != null` and it banked > 0h (§4.8.1) | `ran overnight · Nh — last activity <time>` |
| `running-long` | running continuously for more than `settings.idleNudgeHours` (default **3**, `dashboard.js:74`) | `running Nh — last activity <time>` |

#### 4.8.1 THE DATA SOURCE — the third server change, which revision 2 did not have (C-1)

**This is the finding that made the flagship feature unbuildable, and it is the most
important correction in revision 3.**

`applyRollovers` (`server/routes/timers.js:189-221`) banks yesterday's seconds into an entry
via `syncToEntry`, then **scrubs the timer row**:

```sql
UPDATE timers SET accumulated_seconds=0, last_started_at=?, last_reset_date=?,
                  linked_entry_id=NULL WHERE id=?
```

and, for a running timer, immediately re-points `linked_entry_id` at **today's** new entry.
`TIMER_COLS` (`timers.js:29-32`) then carries nothing that says a rollover happened, nothing
that names yesterday's banked entry, and no hours. A builder handed revision 2 would either
fake it from `last_started_at === midnight` — which cannot tell a rollover from a deliberate
12:00am start and yields no hours figure — or quietly invent a fourth server change.

**Migration v19** (appended to `MIGRATIONS` in `server/db.js`; PRAGMA `user_version`; no old
migration is mutated) adds two nullable columns to `timers`:

```sql
ALTER TABLE timers ADD COLUMN rollover_entry_id INTEGER REFERENCES entries(id);
ALTER TABLE timers ADD COLUMN rollover_last_activity_at TEXT;
```

Written **inside the same statement that scrubs the row**, so a crash cannot separate them:

- `rollover_entry_id` = the entry id `syncToEntry` returned for `r.bankDate`, and **only**
  when `hours > 0` and the timer was `running` at the boundary. A paused timer that merely
  crossed midnight with a zero clock sets both to `NULL`.
- `rollover_last_activity_at` = the timer's `last_stopped_at`, or — when that is null,
  because it ran the whole evening — the **greatest `updated_at` among entries on
  `r.bankDate` whose `cm_id` equals this timer's `cm_id`** (C-2: matter-scoped, never
  another client's activity). Null when nothing is known, and the UI then omits the evidence
  line and the one-tap primary entirely rather than guessing.

**Cleared to `NULL`** by: any `stop`, any successful `stop-at`, `fresh`, a matter re-point,
and the next day's rollover if no overnight run occurred. A repair state that outlives its
repair is a lie on the tile face.

**The list projection** (`listStmt()`) gains one subquery block, and `GET /api/timers`
returns per timer:

```js
rollover_from: {
  entry_id, date, hours, cm_id, cm_short_name, cm_number, client_name,
  status,                 // 'draft' | 'finalized'
  exported_at,            // null unless it has reached a file
  last_activity_at,       // ISO, or null
} | null
```

`hours` is the entry's stored total (the same `storedTotal` rule the rest of the file uses).
**This is the only thing the client needs** to render `ran overnight · 15h — last activity
6:12 pm`, to refuse a finalized correction, and to name both matters in a 409.

**And the attention band** (C-14): `server/routes/dashboard.js`'s `alerts` gains a fourth
disjoint bucket, `overnight`, listing `{ timer_id, name, hours, cm_short_name }` for every
timer with a non-null `rollover_from`. `public/js/views/dashboard.js:176-236` renders it as
`1 ran overnight`, tappable, scrolling to and focusing that tile. Revision 2 asserted this
string in a criterion while its own file plan built nothing that could produce it.

#### 4.8.2 ON THE TILE FACE — the evidence, not a guess (A-7)

```
 ┌────────────────────────────────────────────────────────────┐
 │▌ Northgate — fund IV formation                    🌙       │
 │  ran overnight · 15h — last activity 6:12 pm               │
 │  [ Stop at 6:12 pm ]                        [ Stop at… ] ⋯ │
 └────────────────────────────────────────────────────────────┘
```

`.timer-overnight-note` is `--fs-caption`, `--attention`, **text — not a tooltip, not an
icon**, at every viewport and every density. It replaces the tenths, because the tenths are
the number that is wrong. This tile is `grid-column: 1 / -1` for as long as it is in repair
state, exactly like `.offering`, so the words fit without clamping.

**`Stop at 6:12 pm` is the primary and it is ONE TAP.** Revision 2 led with a hardcoded
`6:00 pm` — a fabricated number, unexplained, that costs the same two taps as the option
that actually knows something. The order is inverted: the evidence is the button, and the
menu is where you go when the evidence is wrong.

When `last_activity_at` is null the primary is absent and `Stop at…` is the only control.
**The app never invents an evidence timestamp.**

#### 4.8.3 `Stop at…` — the menu, the endpoint, and the integrity rules

`Stop at…` opens a `Menu` (the shared primitive) titled `Stop the clock at…`. **Every option
prints the hours it will produce on BOTH days AND the matter each one lands on** (C-2 — the
menu previewing hours alone is how he corrects Acme and silently deletes time on Northgate):

| Option | Yesterday · matter | Today · matter |
|---|---|---|
| `Last activity — 6:12 pm` (omitted if `last_activity_at` is null) | 2.2h · Northgate — fund IV | deleted · Northgate — fund IV |
| `Typical stop — 6:40 pm` — **the median stop time across the last 30 days**, labelled `typical`, not presented as fact. Revision 2 hardcoded `6:00 pm`; he often works till nine. | 2.7h · Northgate — fund IV | deleted · Northgate — fund IV |
| `Midnight` | 6.0h (unchanged) · Northgate — fund IV | deleted · Northgate — fund IV |
| `Type a time…` (inline `<input type="time">` + a yesterday/today toggle) | computed | computed or deleted |

The previews come from the endpoint itself:

```
POST /api/timers/:id/stop-at
  { at: "2026-08-15T18:12:00", tz_offset_minutes: -420, dry_run: true }
→ 200 { changed: [{ entry_id, date, cm_id, cm_short_name, hours_before,
                    hours_after, deleted }], warnings: [] }
```

`dry_run: true` computes and returns **without writing**, which is how criterion 42 is
satisfied with **one** endpoint rather than the extra GET builder finding D-8 said was
missing. The menu opens by firing all applicable previews in parallel on mount.

Without `dry_run`, the same call performs the repair and returns
`{ timer, changed: [...], undo_token }`.

**Rules — all integrity rules, all tested server-side:**

1. **One transaction.** Both entries move or neither does.
2. `at` must be **≥ the timer's start for that day** and **≤ now**. Otherwise 400, nothing
   written.
3. Every resulting duration is **quantised to 0.1h, rounded up**, at the point of storage
   (owner rule, `STATUS.md:348-370`). A 0.75 is never stored.
4. **An entry that holds anything else is never deleted.** The rollover entry is deleted only
   when it is a draft, timer-sourced, holds no narrative, holds no other task line and has
   never been manually edited. Otherwise its timer-contributed line is set to zero and the
   entry survives, flagged `needs a look`.
5. **A finalized or exported entry is never touched.** If yesterday's banked entry is
   finalized, `Stop at…` renders every option **disabled with the reason on it** and the
   note reads `Yesterday's 6.0h is finalized — unlock it first to correct it.`
6. **Audited** and reversible: the toast reads
   `Stopped at 6:12 pm — Northgate yesterday 6.0h → 2.2h, today's 9.0h removed` with
   **`Undo`**, which POSTs the `undo_token` and restores both rows exactly.
7. **Idempotent on `(timer_id, at)`** (C-7): a repeat within the same minute returns the same
   `undo_token` and `changed[]` and writes nothing.
8. **★ THE MATTER FENCE (C-2).** If the banked entry's `cm_id` and the rollover entry's
   `cm_id` differ, the endpoint **409s and writes nothing**, with the message naming both:
   `This timer moved matters overnight — yesterday's 6.0h is on Northgate — fund IV and
   today's is on Acme — Borealis merger. Correct them one at a time from Today's entries.`
   The tile shows the same sentence in place of the primary. **A timer can be re-pointed
   between yesterday evening and this morning; the design creates this path itself, and
   revision 2 asserted rule 7's safety without anything enforcing it.**
9. **`Last activity` is scoped to this timer's own matter** — see §4.8.1. A stop time
   inferred from another client's activity is a matter-boundary leak wearing a convenience.
10. It **never** moves a narrative and never writes to a matter other than the two named in
    `changed[]`.

**Six actions across two pages becomes ONE TAP on the evidence primary, or two through the
menu — one transaction, one Undo** (A-8). Revision 2's prose said "one action" while its own
criterion said "≤3"; a document this scrupulous about counting must not inflate its
headline. The honest count is above.

#### 4.8.4 EVERY STOP SURFACE ROUTES THROUGH THE REPAIR (A-5)

This is the side door revision 2 left open. The run bar is fixed to the top of every screen
and is the closest, fattest, most reflexive stop button he has; at 9:04am he hits it before
his eyes reach the board, and it banks fifteen hours with no repair offered.

**Rule: when the running timer is in `overnight` or `running-long`, EVERY stop surface
becomes the repair.** All of them, named, so none is missed:

| Surface | Normally | In repair state |
|---|---|---|
| The tile's `.timer-stop-btn` | stop & file | `Stop at 6:12 pm` primary + `Stop at…` |
| **The run bar's `[■ Stop]`** | stop & file | **`[■ Stop at…]`** → the identical menu, opened over the run bar |
| The tile menu `Stop & file time` | stop & file | replaced by `Stop at…` |
| The entry row's `Stop` (`.entry-timer-btn`) | stop & file | `Stop at…` |
| `Enter` / `Space` on the focused tile | stop | opens `Stop at…` (does not stop) |
| `t` (toggle last timer) | stop | opens `Stop at…` (does not stop) |
| **Close-out** (`c`, `🔒 Close`) | settles running timers | **blocks and offers the repair first**, naming the timer and its hours (§5.4) |

A stop that would bank more than `idleNudgeHours` of untouched time is never one tap away
from being irreversible. The one exception, stated so it is not a bug report: the misclick
grace (under 2 seconds) is unaffected — it cannot be in repair state.

### 4.9 Density and expansion

The persisted global control stays and applies to the board. Class on the **grid**, not the
tile: `class="timer-grid density-compact|density-comfortable"`.

| Density | Ordinary tile `min-height` | Front-row tile `min-height` | Adds |
|---|---|---|---|
| `compact` (default) | 34px desktop / 44px ≤767 | 56px desktop / **72px** ≤767 | front row already carries line 2 |
| `comfortable` | 52px desktop / 60px ≤767 | 72px desktop / 88px ≤767 | line 2 on **every** tile: client · matter number (`.work-cm`, `--fs-caption`, `--text-muted`), clamped to one line |

`min-height`, never `height` — an open inline editor must be able to grow. Every tile at a
given density and band is the same height: **reserve the slot, then clamp what goes in it.**

**Expansion, and its touch path, stated rather than implied (D-16).** The tile has **no
chevron** — at 34px there is no room for a third painted button across 84 tiles, and
`.timer-name` is itself a button (rename), so revision 2's "click on the tile body, or tap"
had no target. The three real paths:

1. **`x` / `X`** on the focused tile (keyboard).
2. **`⋯ → Show details`**, item #2 of every tile menu — **this is the touch path**, and it is
   one tap more than a chevron would be. That is the price of not spending a third button
   on every tile, and it is stated here rather than left for the builder to discover.
3. **A click on the front row's line 2** (the `client · number` strip), which is inert text
   and is a real hit target at 56/72px.

Expansion toggles `.expanded`, revealing `.timer-body` via `display: none ↔ block` (never a
clipped zero height — the keyboard must not walk into off-screen content). `align-items:
start` means only the expanded tile grows. The body shows, in order: matter short name +
number + client + task code; the divergent-clock note when the clock and the filed entry
disagree; the repair explanation and its options; `Assign matter` when unassigned; front-row
membership; `Archive timer`. **Nothing in the body is unreachable when compact** — identity
is in `title` and the `.sr-only` line, and state, hours and start/stop are on the face.

Expansion is not animated. `prefers-reduced-motion` neutralises the `.just-started` pulse,
any `--transition-control` fade, **and `@keyframes drop-slot-open`** (C-19) via the catch-all
in `base.css`.

### 4.10 `Archive timer` — because the board only ever grew (C-12)

84 becomes 120 next year. Matters close; timers do not. The only pruning path in revision 2
was `Delete timer`, which is a frightening verb for a button that produced billed hours —
and `server/routes/cms.js:143-145` already refuses to delete a matter with a timer, telling
him to *"archive it instead of deleting"*, an archive the data model did not have.

**Migration v19 adds one more nullable column** (same migration as §4.8.1):

```sql
ALTER TABLE timers ADD COLUMN archived_at TEXT;
```

- `Archive timer` sits on the tile menu, under a divider, above `Delete timer…`. It PATCHes
  `archived_at`. **No entry is touched, ever** — the hours it produced stay exactly where
  they are, on their own entries, and the confirm text says so.
- An archived timer **leaves every band**, leaves the digit map, is excluded from the
  working set and from `All timers`, and is excluded from the front row (archiving a
  front-row member removes it and leaves the band at two, §2.2).
- It is **not** excluded from the meta: `84 timers · 3 archived`.
- **The filter still finds it**, rendered `.archived` with the word `archived` on the face
  and one control, `Restore`. He can never search for something and be told it does not
  exist when it does.
- `Board setup… → Show archived timers` renders them in a final `Archived` section at the
  bottom of Band C, collapsed by default.
- Archiving a **running** timer is refused with `Stop it first.`
- Reversal is one tap, from either surface, with no confirm.

`Delete timer…` survives unchanged, still confirming that entries are kept.

### 4.11 The front row and the float pin are different things, and only one of them gets the pushpin (C-13, A-18)

Revision 2 gave front-row membership the `📌` flag — **the same pushpin `timers.pinned`
already owns** — and placed it on Band C duplicates, which the same table says never appear
because Band C is duplicate-suppressed. An icon telling him a tile is also somewhere else,
on a tile that is not there.

| | What it is | Where it shows | Glyph |
|---|---|---|---|
| **Front row** | three tiles at eye level on this board | Band A, positions 1–3 | **none** — position and size *are* the mark |
| **Pinned to float** | this timer appears in the always-on-top float window (`#/float`) | anywhere on the board | **`📌`** |

They are **independent by design**, and here is why he would use both: the float window is
one small OS-level window he keeps over a document he is drafting; the front row is where
his thumb goes when he picks up the phone. A timer can reasonably be in one, both or
neither. The board never syncs them and never suggests syncing them.

---

## 5. TODAY'S ENTRIES — and the ten minutes the app exists for

Container: `<section class="panel entry-panel" aria-labelledby="tk-entries-h">`, sibling of
the board inside the `.today-list` wrapper.

### 5.1 What it shows

Header: `<h2 id="tk-entries-h">Today's entries</h2>` + muted `11 entries · 15.0h`, plus one
`⋯` (`aria-label="Entry list options"`) carrying `Density` and `Show narratives`. With a
board filter active it also shows `3 of 11 shown`.

Rows: `<div class="work-row entry-row" data-entry-id="41" data-row-key="e41">` — **one row
per entry, no merging by matter.** The merged `m<cmId>` row kind is retired (§1.6).

Compact row (target ≤48px):

```
▌ Lyndon — ADA accessibility remediation   101488-000055   (draft) (no narrative)
   No narrative yet ✎                                   2.6   [Start]   [⋯]
```

- state rail (`worked` / `needs-narrative` / `running` / `unassigned`, `--valid-mark-w`)
- matter short name (`--fs-subheading`) + `.work-cm` matter number (tabular, muted;
  `display:none` ≤767)
- `.badge-billable` / `.badge-nonbillable`, `.chip-draft` / `.chip-finalized` (padlock) /
  `.chip-exported` (+ stamp) / `.chip-running` / `no narrative`
- `.narrative-editable` — **dotted underline + pencil**; when empty, the dashed
  `.narrative-write` "Write narrative" button
- the hours figure, right-aligned, `--fs-num-md`, `--figure`, click-to-edit with
  `.figure-step` ± pills → `PATCH /api/entries/:id` (quantised to 0.1h, and accepting
  minutes — §6.4)
- **one labelled primary**: `Start` / `Stop` (`.entry-timer-btn`)
- **one `.entry-more`** `⋯`, `aria-label="Entry menu"`

Comfortable / expanded adds the task split line, the validation findings list
(`ValidationList` minus `narrative_empty` / `no_matter`, which the chips already say), and
the full narrative editor.

Roving list, same model as the board: `.work-row` is the tab stop, inner controls
`tabindex="-1"`, `role="list"` / `role="listitem"` on `.work-rows` / `.work-row`.

### 5.2 How it differs from the board

| | Board tile | Entry row |
|---|---|---|
| Persists day to day | **Yes** — the same bank tomorrow | No — today's records only |
| Identified by | the attorney's button name | the **matter** |
| Figure | the timer's **clock** | the entry's **recorded hours** |
| Ticking clock | yes, when running | **never** — a `⏱ running` chip only |
| Grouping / A–Z / reorder / drag / front row / archive | yes | **no** |
| Multi-select / batch | yes | no |
| Bounded default view | **yes** (§2) | phone only (§5.4) |
| Layout | banded multi-column grid | single-column list |
| Keyboard scope | roving grid | roving list |

### 5.3 The reconciliation rule — and the arithmetic revision 2 got wrong

**The two sections may not print a third number.**

- The tile's two figures are **one quantity in two notations** — `hh:mm:ss` and tenths, both
  the timer's clock. A tile never prints the entry's hours.
- The entry row prints **only** the entry's recorded hours. An entry row never ticks.
- **One live-clock authority.** Every ticking figure on the page — the running tile and the
  run bar — is computed from the *same* `fetchedAt` and the *same* `startAlignedTick`, owned
  by the coordinator (§10.2).

**★ `unfiled` is NOT the sum of the timer clocks.** Revision 2 defined it as *"the sum of all
84 timer clocks, i.e. time on the board that has not reached an entry"* and called the board
and entries totals *"disjoint by construction"*. Measured at the seed, that is false in both
halves:

```
Σ timer clocks           = 9.25h
Σ entry hours today      = 15.0h
of the 9.25h, 8.83h is ALREADY ON ENTRIES 23–28
```

In this data model a stop does **not** zero the clock — the clock accumulates for the whole
day and each stop syncs the day total into the linked entry (`timers.js:22-24`). So the six
stopped timers hold 8.83h that is filed, and printing it as "unfiled" would tell him he has
nine unbilled hours when he has none. **A board that over-reports unbilled work is exactly
as dangerous as one that under-reports it** — he would go looking for eight hours that do
not exist, at 5:50pm, which is when he abandons the whole exercise.

**The correct quantity, and the only one the meta may print:**

```
unfiled = Σ over all timers of  max(0, clockHours(t) − filedHours(t.linked_entry_id))
```

quantised to 0.1h, where `filedHours` is 0 when `linked_entry_id` is null. It is computed
over **all 84 timers, not the 9 shown** — a working set that under-reports the day would be
a data-integrity defect, not a display choice. At the seed it is **0.7h and rising**: the
running `Acme — merger` alone, whose entry 29 stands at 0.0h.

Do not duplicate: grouping controls, A–Z, New timer, the `/` field, drag reorder,
select-mode checkboxes, timer clock editing, `Edit timer…`, `Duplicate`, `Pin to float`, or
a second search input.

### 5.4 The phone entry cap, and what close-out sees

At the seed there are **11 entries today**. Eleven 48px rows is 528px, which is what pushes
the 412px page past its budget. On the phone only (≤767px), the entries panel renders **6
rows** and a `Show all 11 entries` control in `.entry-foot`, identical in shape and wording
to the board's disclosure. Desktop renders all 11.

The rule for which 6: **most recent first**, except that **every entry needing a narrative is
always in the visible set** — an entry the close-out will block on may never be the one that
is hidden. If more than 6 need a narrative, all of them show and the cap lifts.

**Close-out sees the board (C-19).** `c` / the run bar's `🔒 Close` now surfaces two things
before it finalizes anything:

1. **Any timer in `overnight` or `running-long` state blocks**, named, with its hours and the
   repair offered inline (§4.8.4). Close-out already runs the midnight rollover — the
   session that fixed that found *"an overnight timer lost ten hours"* — so it must not now
   silently bank the same shape it was taught to catch.
2. **The board's `unfiled` total is printed**: `0.7h is still on 1 clock and isn't filed
   yet` with a button into the stepper. At 84 timers, unfiled clock time on a tile he cannot
   see is precisely the failure that total was invented to surface; having gotten the
   arithmetic right (§5.3), the document does not then whisper the result.

Export is unchanged and does **not** block on the board — export reads entries, and an
unfiled clock is not an entry. That is stated so nobody adds it later by analogy.

### 5.5 ★ THE CLOSE-OUT STEPPER — the weakest walk in revision 2, and the moment the app exists for (A-2)

**This closes the attorney's second BLOCKER.**

As revision 2 specified it, the dashboard's `N need a narrative` link focused *a* row,
singular, and then stopped. Counted end to end: click the link (1) → type (2) → save (3) →
**and now nothing** — hunt the list for the next `no narrative` chip (4), click its pencil
(5), type (6), save (7), hunt again (8), click (9), type (10), save (11), `🔒 Close` (12).
**≈12 actions and two visual hunts through an 11-row list, in the last ten minutes of a
fourteen-hour day** — which is precisely when he abandons it and tells himself he will do it
tomorrow.

**`2 need a narrative` opens a stepper, not a row focus.** One entry at a time, full
attention, on the shared overlay primitive (`components/overlay.js` — no fourth modal
implementation):

```
 ┌──────────────────────────────────────────────────────────────┐
 │  Close out today                                    1 of 2 ✕ │
 │  ────────────────────────────────────────────────────────────│
 │  Northgate diligence · 100244-000002 · Northgate Partners    │
 │  0.8h · Due Diligence                                        │
 │                                                              │
 │  ┌──────────────────────────────────────────────────────────┐│
 │  │ Reviewed diligence materials and updated the issues list ││ ← pre-filled,
 │  │ regarding the Sandpiper acquisition.                     ││   fully selected
 │  └──────────────────────────────────────────────────────────┘│
 │                                                              │
 │  ⏎ accept & next      Tab skip      Esc stop      [ Save ]   │
 └──────────────────────────────────────────────────────────────┘
```

**The rules:**

1. **The queue** is every entry dated today that fails `narrative_empty`, in the entries
   list's own order, computed once when the stepper opens. It does not re-order under him.
2. **The counter is literal**: `1 of 2` at the seed. It never lies about the remaining work.
3. **Pre-filled** from the existing suggestion machinery — the same source the stop offer
   uses, which already exists in this codebase and is already matter-fenced. **It is
   pre-filled, selected, and the entry is NOT saved until he acts.** Nothing is written on
   open.
4. **`⏎` accepts and advances.** `Tab` skips without writing. `Esc` closes the stepper,
   keeping every acceptance already made. `✕` and the backdrop do the same as `Esc`.
5. **Three Enters closes the day.** That is the whole design.
6. **Matter fences apply unchanged.** The pre-fill is composed for *this entry's matter*; a
   sentence composed for another matter can never appear in this box. Text the app composed
   and he has not edited is stamped `narrative_suggested` exactly as the stop chip and
   close-out already do (`STATUS.md:255-268`); text he edits is his and is never stamped.
7. **Every write is a normal `PATCH /api/entries/:id`.** The stepper adds **no endpoint** and
   no new write path — it is a queue over a control that already exists, which is why it is
   in this stage rather than a later one.
8. **It is reachable three ways**: the attention band's `2 need a narrative`, the attention
   band's `0.7h isn't filed yet` (which enqueues the unfiled clocks first, offering `File
   0.7h to <matter>` before the narrative box), and close-out itself.
9. **On the phone** the overlay is full-screen and the keyboard hint line is replaced by
   three ≥44px buttons: `Skip`, `Save & next`, `Done`.
10. **A finalized or exported entry never enters the queue.**

`tk:focus-entry` (§7.5 #86) survives unchanged for the single-row case — clicking a specific
row's pencil still focuses and expands that row. The stepper is what the *count* opens.

---

## 6. THE RETROACTIVE PATH — "I just spent 40 minutes on a call I didn't time"

For an interrupted lawyer this is the **majority** of his entries, and revision 1 gave it no
board presence at all. `public/js/components/quickcapture.js` already does it in two actions,
with parsing, hour pills and AI fill.

### 6.1 The page primary becomes a two-part control

```
 ┌────────────────────┬──────────────────┐
 │  ▶  Start          │  ＋ Log time…    │     one control, one filled surface
 └────────────────────┴──────────────────┘     hairline divider between halves
   time NOW  (q)         time PAST  (n)
```

`.day-primary` is a single accent-filled group with a `--border-w` divider; `Start` carries
the fill, `Log time…` is the attached outline half, so the page still has exactly **one**
filled saturated-accent surface and the hue budget is intact (§13.1 R13). Both halves are
real `<button>`s with visible labels — never bare icons. Existing shortcuts unchanged: `q` =
Start, `n` = Log.

### 6.2 On the board

- **Tile menu item #1: `Log time already spent…`** → QuickCapture **pre-scoped** to that
  timer's matter and task code, hours empty, hour pills live.
- **Tile menu item #2: `Show details`** — the expansion touch path (§4.9).
- **`l` on a focused tile** does the same as item #1. (Mnemonic: log.)
- **Entry menu: `Log more time to this matter…`** → the same, scoped from the entry.
- **It is NOT in `Board setup…`** (A-21). The unscoped case is the page primary's own half,
  which is on the face at all times.

### 6.3 The pre-scope contract

`QuickCapture` (`quickcapture.js:75`) currently takes `{ onClose, onFiled }`. It gains one
optional prop:

```js
QuickCapture({ onClose, onFiled, scope })
// scope = { cm: {id, cm_number, short_name, client_name}, task_code, timerId } | null
```

When `scope.cm` is present the matter slot opens **already picked** (`pickMatter`
pre-seeded, `explicit` set so the parse cannot override it), the sheet title reads
`Log time — Northgate — fund IV formation`, and `missing` starts as `['hours']` so the
sheet's "what next" copy says `Set the hours`. Typing a different matter into the line still
wins — an explicit re-pick always beats a pre-scope, exactly as it beats a parse today.

**Data integrity:** a pre-scoped capture writes to `scope.cm.id` and to nothing else. It
carries no narrative from the timer, no template, no stash, and no suggestion built for
another matter. `timerId` is carried for the audit record only; it does **not** link the
entry to the timer and does **not** touch the timer's clock.

**After it files, the toast carries two actions** (attorney A-12): `Undo` **and**
`Start the clock on this matter` — because the commonest thing after billing a 40-minute
call is starting the memo on the same matter, and nothing in revision 2 did both.

App wiring: `app.js` owns the QuickCapture mount and gains `openQuickCapture(scope)`; the
`tk:quick-capture` window event carries `detail.scope`. The coordinator dispatches it — it
never mounts QuickCapture itself.

### 6.4 ★ HE SAID FORTY MINUTES. THE APP MUST NOT MAKE HIM SAY 0.7 (A-9)

He bills in tenths; he *thinks* in minutes for a phone call. Making him do 40 ÷ 60 → round up
→ 0.7, twelve times a day, is the app charging him rent. Nothing in revision 2's §6 or its
criteria said the hours field accepted anything but a decimal, and the QuickCapture hours
slot is a stepper (`qc-hours`, `quickcapture.js:299-313`) with no typed input at all.

**Every hours input in this document accepts all four notations** — the QuickCapture hours
slot, the tile's `.figure-edit`, the entry row's hours figure, and the stepper's hours field:

| He types | Stored | Echo shown beneath the field |
|---|---|---|
| `40m`, `40 min` | 0.7 | `0.7h — 40 min, rounded up from 0.67` |
| `:40` | 0.7 | same |
| `40` | 0.7 | `0.7h — read as 40 minutes` **(bare integers ≥ 6 are minutes)** |
| `0.7`, `.7` | 0.7 | `0.7h — 42 min` |
| `1.5`, `1h30`, `90m` | 1.5 | `1.5h — 1 h 30 min` |

- **The bare-integer rule is the one judgement call, so it is stated loudly**: a bare `40` is
  minutes; a bare `2` is hours. The boundary is **6** — nobody types `6` meaning six minutes
  when `0.1` exists, and nobody types `6` meaning six hours by accident either, so 6 and
  above are minutes and below 6 are hours. **The echo always says which reading was taken**,
  so a wrong guess is visible before he commits, never after. `server/lib/quickcapture.js:91`
  already refuses a bare `3` as too ambiguous; this rule is its typed-field sibling and both
  must give the same answer for the same string.
- **Quantised to 0.1h, rounded up, at the point of storage** (`STATUS.md:348-370`). 0.67
  never reaches the database.
- **The hour pills are labelled in both units** (`HOUR_PILLS`, `quickcapture.js:64`):
  `0.1 · 6m` `0.2 · 12m` `0.3 · 18m` `0.5 · 30m` `0.8 · 48m` `1.0 · 1h` `1.5 · 1h30`
  `2.0 · 2h`.
- Parsing is **one pure function** in `server/lib/` with unit tests, shared by the server
  line parser and the client fields. Two copies is how the two disagreed.

### 6.5 ★ THE MATTER-CHANGE DIALOG — the owner's "ask me each time" (C-3)

**This is a recorded owner decision explicitly routed to this build**
(`STATUS.md:124`, `STATUS.md:301-308`), and revision 2 closed the file on it by shipping the
half he did not choose. The server half landed in `4ad84db`: an entry holding real hours or a
real narrative **no longer follows a re-pointed timer**, and `move_entry: true`
(`server/routes/timers.js:415`) is how a caller asks for the move. *"Until it is built, the
desktop app silently leaves the entry behind with no way to say 'move it too' — safe, but
only half the decision he made."*

**When it appears.** Saving `TimerModal` (§10.6) with a **changed `cm_id`**, when the
timer's linked draft entry holds **real hours (> 0) or a real narrative** (any narrative that
is not exactly the timer's own seeded template/stash text — the same test
`deleteIfUntouched` already applies at `timers.js:178-181`). If the draft is untouched,
**nothing is asked** — there is nothing to decide.

**What it says.** A `Confirm` on the shared overlay primitive (`components/overlay.js`), so
it inherits focus trapping, `Esc`, the backdrop and the 44px touch tier. No new component.

```
 ┌────────────────────────────────────────────────────────────────┐
 │  This timer already filed time today                           │
 │  ────────────────────────────────────────────────────────────  │
 │  0.8h and a narrative are on:                                  │
 │        Northgate diligence · 100244-000002                     │
 │  You're moving the timer to:                                   │
 │        Harbor — ground lease restructuring · 100455-000022     │
 │                                                                │
 │  [ Leave the time on Northgate diligence ]   ← default         │
 │  [ Move it to Harbor too ]                                     │
 │                                                       [Cancel] │
 └────────────────────────────────────────────────────────────────┘
```

**What the two answers do.**

| Answer | Sends | Result |
|---|---|---|
| `Leave the time on <old matter>` | `PATCH /api/timers/:id` with `cm_id` and **no `move_entry`** | The entry stays on the old matter with its hours and its sentence. The timer is re-pointed and its next time opens a new entry on the new matter. |
| `Move it to <new matter> too` | the same PATCH plus **`move_entry: true`** | The server moves the entry, applying its own fences. Any narrative composed for the old matter is retracted by the existing provenance machinery — the board does not reimplement it. |
| `Cancel` | nothing | The modal stays open with the matter picker still on the new choice, so he can change his mind about the matter rather than about the entry. |

**What silence means — and this is the safe default and the owner's own decision.**
`Esc`, the backdrop, `⏎` on the focused default and the browser back gesture **all mean
LEAVE THE TIME BEHIND.** `move_entry: true` is sent **only** when he presses the second
button, deliberately, with both matter names in front of him. The board never sends it
implicitly, never as a "remember my choice", and never as a setting.

**Where it does not appear**, so nobody adds it by analogy: the pre-scoped QuickCapture
(§6.3, which never re-points a timer), the filter's new-timer row (§2.6, which creates a
fresh timer with no entry), `Stop at…` (§4.8.3, which has its own 409 fence), and the
close-out stepper (§5.5, which never changes a matter).

---

## 7. WHAT MOVES WHERE

Every capability from the code inventory. **Nothing is dropped.** `⊕` = gains a touch path.
`⊖` = loses one (there must be none). `≡` = unchanged reach. `★` = new in revision 2 or 3.

### 7.1 List chrome (1–13)

| # | Capability | Lands in | Reached by |
|---|---|---|---|
| 1 | "Today's work" heading | **split** — `Timers` (board) + `Today's entries` | ≡ |
| 2 | Active-filter pills | Board, under the control band | ≡ tap to clear |
| 3 | Search toggle | **Gone as a toggle** — the field is permanently visible | ⊕ |
| 4 | Search input, forgiving match | Board control row; matches timer name / matter short name / matter number / client / task code **and today's entry narratives** (`timergrid.js:796`), **across all 84 in every scope**, **plus all 90 matters** (§2.6) | ⊕ — narrative search was silently dropped by revision 2 (D-15) and is restored; matter search is new |
| 5 | Search clear ✕ | Board, 44×44 | ≡ |
| 6 | Match counter `shown/total` | **`.board-meta`** (`3 of 84 shown`) + entries meta | ≡ passive |
| 7 | List options ⋯ | **Two menus**: `Board setup` + `Entry list options` | ≡ |
| 8 | Batch action bar | Board, above the bands, in select mode | ≡ |
| 9 | Empty state "Nothing tracked today" | **Two** blankslates: board → `＋ New timer` / `Start`; entries → `＋ New entry` / `Log time…` | ⊕ |
| 10 | "Nothing matches" → Clear filters | Both sections, each its own | ≡ |
| 11 | Section headers + count | Board, **Band C only** (whole board below ten timers, §2.10) | ≡ |
| 11a ★ | **`· unnamed` client marker** in a By-client group head (`timergrid.js:1160-1161`) — the only place the app says a client record is incomplete | Board `.group-head` | ≡ (C-18) |
| 12 | "Drop timers here" on an empty group | Board `.timer-section` | ≡ |
| 13 | "＋ New timer" footer | Board `.board-foot` — **not** a ghost grid cell (B-11) | ≡ |
| 13a ★ | **`All timers` / `Fewer timers`** | Board `.board-foot` | tab stop, tap |
| 13b ★ | **Front row membership** | drag onto Band A · tile menu `Move to the front row` · `f` on a focused tile | ⊕ |
| 13c ★ | **`⏎ Start a new timer — <matter>`** | Board `.band-matches` (§2.6) | ⊕ tap or `⏎` |

### 7.2 List options menu (14–24)

| # | Capability | Lands in | Reached by |
|---|---|---|---|
| 14 | Show: All/Today/Yesterday/Week/Recent | `Board setup` → `Show` (Band C only) | ≡ tap |
| 15 | Group: Flat/By group/By client | **Board control row**, `.seg` — promoted | ⊕ |
| 16 | Density: Compact/Comfortable | `Board setup` **and** `Entry list options` — one global setting, two doors | ⊕ |
| 17 | Only this group / this client | `Board setup` → `Only` (rendered only when grouping ≠ flat, D-M8) | ≡ |
| 18 | Order: Recent activity / Manual | `Board setup` → `Order`, **default Manual** (B-3) | ≡ |
| 19 | Sort A–Z | **`Board setup` → `Sort A–Z… (rewrites your manual order)`** — demoted, and **newly undoable** (D-M7) | ≡ tap |
| 20 | Select several… | `Board setup` | ≡ |
| 21 | New group… | `Board setup` | ≡ |
| 22 | Rename "<group>"… | `Board setup` (Group + Only) | ≡ |
| 23 | Import timers from CSV… | `Board setup` | ≡ |
| 24 | Delete "<group>" | `Board setup` | ≡ |
| 24a ★ | **Show archived timers** | `Board setup` (§4.10) | ⊕ |

### 7.3 Row surface (25–53)

| # | Capability | Lands in | Reached by |
|---|---|---|---|
| 25 | Select checkbox | Board tile, select mode | ≡ |
| 26 | Inline rename | Board tile `.timer-name` (`maxlength="80"`) | ≡ click / `Shift+Enter` → dialog |
| 27 | Click name opens the entry | Entries row name | ≡ |
| 28 | Matter number badge | Entries row line 1; **front-row tile line 2**; comfortable tile line 2; `title` + `.sr-only` on every tile | ⊕ |
| 29 | Non-billable badge | Entries row | ≡ |
| 30 | Status chip (draft/finalized) | Entries row | ≡ |
| 31 | "exported" chip + stamp | Entries row | ≡ |
| 32 | "no narrative" chip | Entries row | ≡ |
| 33 | Assign matter | **Both** — tile expanded body → `TimerModal`; entries row → `openEditor` | ≡ |
| 34 | Idle-nudge flag | Board tile — **and it is now a full repair state** (§4.8) | ⊕ |
| 35 | Pinned-to-float flag | Board tile, `📌`, **and it is the only pushpin** (§4.11) | ≡ |
| 36 | Start / Stop primary | **Both** | ≡ |
| 37 | Disabled Start on a finalized entry | Entries row | ≡ |
| 38 | Live `hh:mm:ss`, click to edit decimal | Board tile only | ≡ |
| 39 | The row's ONE figure | **Split by section** — tile = clock; entry row = recorded hours | ≡ |
| 40 | Figure editor, ± 0.1 pills | Both, each writing its own target, **both now accepting minutes** (§6.4) | ⊕ |
| 41 | Expand chevron | Entries rows keep `.work-expand`; **the tile has no chevron and three stated paths** — `x`, `⋯ → Show details`, front-row line 2 (§4.9, D-16) | ≡ |
| 42 | Click body expands; Ctrl/Shift-click multi-selects | Board tile (multi-select on the tile, expand per #41); entries row (expand only) | ≡ |
| 43 | Right-click → row menu | Both — **in addition to** the persistent `⋯` | ≡ |
| 44 | Row ⋯ menu | **Two menus**, each titled to name its object | ≡ |
| 45 | Drag to reorder / re-group | Board only; desktop pointer **in addition to** `Move to group…`, `Move to the front row`, `Move Up/Down` | ≡ |
| 46 | Per-entry narrative rows | Entries list — collapses into #47 | ≡ |
| 47 | Single inline narrative editor | Entries row **and the close-out stepper** (§5.5) | ⊕ |
| 48 | "Running — files at the next stop." / "Nothing recorded today." | Tile expanded body / entries blankslate | ≡ |
| 49 | Validation findings list | Entries row expanded | ≡ |
| 50 | Task split line | Entries row expanded | ≡ |
| 51 | Divergent decimal clock note | Tile expanded body | ≡ |
| 52 | State rail | Both, same token vocabulary and priority | ≡ |
| 53 | `just-started` pulse | Board tile | ≡ |
| 53a ★ | **`ran overnight · Nh — last activity <time>` + one-tap repair** | Board tile face + tile menu + expanded body + **run bar + entry row + close-out** (§4.8.4) | ⊕ |
| 53b ★ | **Digit key cap `1`–`9`** | Board tile, ≥768px, hidden while an offer is mounted | keyboard (the touch path is the tile itself) |
| 53c ★ | **`Archive timer` / `Restore`** | Tile menu + expanded body (§4.10) | ⊕ |
| 53d ★ | **`data-pending`** | Board tile (§4.7) | passive |

### 7.4 Row menu (54–65)

`components/menu.js` splits `rowMenuItems` into **`timerMenuItems(timer, actions)`** and
**`entryMenuItems(entry, actions)`**. `rowMenuTitle` becomes two titles that name the
object: `Timer — Acme — merger` and `Entry — Northgate diligence · 0.8h`.

| # | Item | Menu | Notes |
|---|---|---|---|
| 54 | Start / Stop & file time | Timer menu | ≡ — replaced by `Stop at…` in repair state (§4.8.4) |
| 54a ★ | **Log time already spent…** | Timer menu, **item #1** | pre-scoped QuickCapture (§6.2) |
| 54b ★ | **Show details** | Timer menu, **item #2** | the expansion touch path (§4.9) |
| 54c ★ | **Stop at…** | Timer menu, only in `overnight` or `running-long` | §4.8.3 |
| 54d ★ | **Move to / Remove from the front row** | Timer menu | the touch path for the drag |
| 54e ★ | **Archive timer** / **Restore timer** | Timer menu, above `Delete timer…`, behind a divider | §4.10 |
| 55 | Backdate: 10m ago / 30m ago / at last stop | Timer menu | ≡ |
| 56 | Start a timer on this matter | Entry menu | ≡ |
| 57 | Open each entry when >1 today | **Retired** — one row per entry makes it unnecessary | capability preserved |
| 58 | Open entry… / View entry… | Entry menu | ≡ |
| 59 | Open today's entry | Timer menu (disabled without `linked_entry_id`) | ≡ |
| 60 | Write narrative here | Entry menu | ≡ |
| 61 | Finalize this entry | Entry menu (422 → opens editor; toast with `Unlock` undo) | ≡ |
| 62 | Unlock for editing | Entry menu | ≡ |
| 63 | Copy to today | Entry menu | ≡ |
| 64 | Edit timer… | Timer menu — **and its save path now asks §6.5's question** | ⊕ |
| 65 | Delete entry | Entry menu — present on every row that has an entry, disabled-with-reason when finalized | ≡ |
| + | Move to group… | Timer menu | ≡ |
| + ★ | Log more time to this matter… | Entry menu | ⊕ |

### 7.5 Batch (66–69), the edit dialog (70–77), cross-surface (78–89)

| # | Capability | Lands in | Reached by |
|---|---|---|---|
| 66–69 | Batch label / Move to group / Pin-Unpin all / Delete N | Board — select mode → `Actions…` | ≡ |
| 70–77 | `TimerModal`: name, CmPicker, task code, group, template, clock-now, position + Move Up/Down, Duplicate, Pin, New entry, Delete timer, save-flows-into-editor | **`timermodals.js`** (§10.6), plus `Move to the front row` and **the matter-change dialog (§6.5)** | ⊕ |
| 78 | Long-running notification (2h then hourly) | Coordinator only | ≡ |
| 79 | Notification permission on first start | Coordinator | ≡ |
| 80 | `tk:edit-timer` listener | Coordinator | ≡ |
| 81 | `tk:timers-changed` listener | Coordinator | ≡ |
| 82 | `tk:toggle-last-timer` (`t`) | Coordinator — **and every new start path now writes `tk:lastTimer`** (§8.7, C-15) | ≡ |
| 83 | `tk:stop-timer` | Coordinator — routes through the repair when applicable (§4.8.4) | ⊕ |
| 84 | `tk:quick-timer` (header `Start`, `q`) | Coordinator | ≡ |
| 84a ★ | `tk:quick-capture` (header `Log time…`, `n`, tile menu, `l`) | **`app.js` mounts; the coordinator dispatches with `detail.scope`** | ⊕ |
| 85 | `tk:timer-search` (`/`) | Coordinator → focuses the board's `.timer-search` via the owned ref (§10.8) | ≡ |
| 86 | `tk:focus-entry` ("N need a narrative") | **Coordinator → `entryFocus` prop → `TodayEntries`** (§10.8). The *count* opens the stepper (§5.5); a specific row still focuses, expands and opens its editor. On the phone it lifts the 6-row cap if the target is beyond it | ⊕ |
| 87 | Reveal a just-created timer | Coordinator — clears the filter, forces scope to `all` if the timer is not in the working set, scrolls, focuses | ⊕ |
| 88 | Stop offer (`StopChips`) | **Coordinator** mounts once; the offer renders **in the tile** (§10.7) | ≡ |
| 89 | Toasts ("Misclick (under 2s)", "Nothing to file yet", …) | Coordinator | ≡ |
| 89a ★ | **The `relinked` toast** — *"Previous entry is settled — started a new one; its hours have left the clock"* (`timergrid.js:296`), the one message that explains a clock jumping to zero | Coordinator — and it matters more now, because the board has **four** new start paths that can trigger it | ≡ (C-18) |

**No row in this table is `⊖`.** If the build produces one, it is a defect.

**On keeping multi-select and batch (attorney A-24, judged wrong).** He would cut 66–69:
*"I have never batch-labelled a timer. It costs a mode, a selection bar, checkbox state, Esc
semantics and a slice of the budget."* Two of those costs are real and two are not. The mode,
the bar and the checkbox state cost **zero resting pixels** — nothing renders until
`Select several…` is chosen from a menu he opens once a month, and the `Esc` semantics are
already shared with the filter and the overlays. The line-count cost is real and it is
priced into `timerboard.js` in §10.1. Against that: at 84 timers and growing, "move these
nine dormant Whitlock timers into a group" and "archive these six closed matters" are
exactly the operations that keep the board from becoming the wall again — and the archive
capability added in §4.10 makes batch *more* valuable, not less. It stays.

---

## 8. KEYBOARD — the desktop-first spine

### 8.1 Focus order on `#/`

```
page head (‹ date › · ⋯ Day actions · [Start│Log time…])
  → board control row: [Flat][Group][Client] [filter] [✕] [⋯ Board setup]
  → THE BOARD BANDS                   ← exactly ONE tab stop across ALL bands
  → .board-foot: [＋ New timer] [All timers]
  → THE ENTRIES LIST                  ← exactly ONE tab stop
  → .entry-foot (phone) / entry-list ⋯
  → footer
```

The board's bands and every section grid inside Band C share **one** roving tab stop.
`.board-foot` sits outside the grid so its two buttons are ordinary tab stops (B-11). The run
bar is fixed at the top and is reached by `Shift+Tab` from the page head, as today.

### 8.2 Roving tabindex, and the arrow geometry that is actually correct (B-12)

- The **tile** is the tab stop: `tabindex="0"` on exactly one tile board-wide, `-1` on the
  other 83.
- **Every control inside a tile is `tabindex="-1"`** — `.timer-name`, `.timer-clock`,
  transport, `.timer-more`, the select checkbox. Tab lands on a tile, never on its Start
  button. Breaking this explodes tab order across 84 timers.
- Each list keeps **its own** `focusKey` and **its own** DOM scope (`.timer-board …` /
  `.entry-panel …`).

**Horizontal (`←` / `→`):** ±1 tile in **DOM order across all bands and sections**, clamped
at the ends.

**Vertical (`↑` / `↓`) — computed per section, never over a flat index.**

```js
// public/js/lib/boardselect.js  (pure, unit-tested; the DOM read is injected)
export function verticalTarget(grids, gridIndex, tileIndex, dir) {
  const g = grids[gridIndex];                 // { count, cols }
  const col = tileIndex % g.cols;
  const next = tileIndex + dir * g.cols;
  if (next >= 0 && next < g.count) return { gridIndex, tileIndex: next };
  const gi = gridIndex + dir;
  if (gi < 0) return null;                    // ↑ off the board: caller keeps focus
  if (gi >= grids.length) return 'entries';   // ↓ off the board: into the entries list
  const n = grids[gi];
  const idx = dir > 0
    ? Math.min(col, n.count - 1)                                  // first row of the next
    : Math.max(0, n.count - 1 - ((n.count - 1 - col) % n.cols));  // last row, same column
  return { gridIndex: gi, tileIndex: idx };
}
```

`grids` is built from `[...board.querySelectorAll('.timer-grid')]` with
`{ count: g.querySelectorAll('.timer-tile').length, cols: colsOf(g) }` — **`colsOf` per
grid** (§4.6), with the `offsetParent` + px-track guard.

**`Home` / `End`:** first / last tile on the board, across all bands.

### 8.3 Digit keys — the only way to start a SPECIFIC timer (B-2b)

**`1`–`9` start the timer in that position of the current view.** The cap is printed on the
tile (`.tile-key`, `--fs-micro`, `--text-muted`, ≥768px).

**Positions are the first nine RENDERED tiles, in DOM order, whatever the band structure.**
That single sentence is the whole rule and it survives every configuration in this document
(this is completeness gap C-4 and builder D-2 closed at the root):

| Configuration | What `1`–`9` are |
|---|---|
| >9 timers, working scope | front row (1–3) then `Recent` (4–9) |
| >9 timers, `all` scope | **the same nine** — `All timers` appends (§2.5) |
| ≤9 timers (§2.10) | the flat band, in Band C order |
| a filter typed | the first nine **matches** (§2.6) |
| `Recent` holds more than six (a nine-matter day, §2.3) | 4–9 are its first six; the seventh and later Recent tiles **carry no cap and no digit**, and the caps simply stop at 9 |
| front row reduced to two by a deletion (§2.2) | `3` is the first `Recent` tile; the caps re-derive on every render |

**Behaviour:** if that timer is not running, **start it** (which exclusively stops whatever
was running, §8.6). If it **is** running, focus its tile and do nothing else — a digit key
must never stop a clock by accident. A digit past the rendered count is a **no-op**.

**Precedence, which must be built explicitly:**

1. Ignored when the event target is `input` / `textarea` / `select` / `contenteditable`.
2. Ignored when `overlayOpen()` (`components/overlay.js`) — dialogs and the stepper own their
   keys.
3. **Ignored while a stop offer is mounted.** `stopchips.js:655` already binds `1 2 3` in the
   capture phase with its own liveness gate; the board binds in the bubble phase and
   additionally refuses when `document.querySelector('.stop-chips-inner')` exists. **And
   `.tile-key` is hidden board-wide for the duration** — otherwise the tile caps and the
   offer's own `1 2 3` caps paint at the same time, which is the stale-key-cap hazard
   documented at `e2e-smoke.mjs:462-464` (D-M10).
4. **Focus in the entries list does not change the mapping** (A-15). Pressing `4` while a
   `.work-row` has focus starts **board tile 4**. The entries list has no digit map of its
   own and never will — one meaning per key, page-wide.
5. Otherwise the board handles it, `preventDefault()`.

### 8.4 Keys on a focused tile

| Key | Effect |
|---|---|
| `←` / `→` | ±1 tile in DOM order across bands and sections; clamps |
| `↑` / `↓` | vertical neighbour **within the tile's own grid**, then same column in the adjacent grid (§8.2) |
| `Home` / `End` | first / last tile on the board |
| `↓` past the last grid | **moves into the entries list**, focusing its first row |
| `Enter` / `Space` | start / stop the focused timer — **or open the repair** in `overnight` / `running-long` (§4.8.4) |
| `x` / `X` | expand / collapse |
| `f` | ★ toggle front-row membership (toast + `Undo`) |
| `l` | ★ `Log time already spent…` → QuickCapture pre-scoped to this matter (§6.2) |
| `Shift+Enter` | `Edit timer…` (`TimerModal`) |
| `Ctrl`/`⌘`+`Enter` | open the timer's entry today, or the editor pre-filled from its matter |
| `Alt+↑` / `Alt+↓` | clock ±0.1h, quantised, `PUT /api/timers/:id/clock` |
| `Esc` | exit select mode / clear selection |

**`Shift+Alt+↑/↓` for ±0.2h is CUT** (A-25). A second modifier layer that saves one keypress
is a rule he has to remember about a nudge he uses to fix a rounding error. Two presses of
`Alt+↑` is the answer.

Guards unchanged: ignore when the target is `input`/`textarea`/`select`; ignore
`Enter`/`Space` when the target is a `<button>`.

### 8.5 The `/` fork — the resolution is PRINTED, always (A-1, A-3)

`/` on `#/` focuses `.timer-search` — **the board's timer filter**. Any instruction to fold it
into quick capture, repurpose it or remove it is void (`BRIEF.md:273-276`). Elsewhere in the
app `/` searches entries. This fork is deliberate and is never "fixed".

**★ The field prints what `⏎` will do, on one line, at all times.** This is the attorney's
MAJOR A-3 and it is the difference between a magic trick and a trap: revision 2's `⏎` did
nothing visible on ≥2 matches, and he has already looked away, saying *"sure, let me pull
that up."* He would lose that hour believing he had billed it. A four-keystroke trick whose
failure mode is **silence** is not a trick he can trust.

`.search-resolution`, `--fs-caption`, `--text-muted`, directly beneath the field, `aria-live="polite"`, always rendered while a query is typed:

| State | The line reads | `⏎` does |
|---|---|---|
| exactly 1 timer match, not running | `⏎ starts: Northgate — fund IV formation` | **starts it**, clears the query, restores the previous scope, focuses its tile, toasts with `Undo` (§8.6) |
| exactly 1 timer match, already running | `⏎ goes to: Acme — merger (running)` | focuses its tile. **Never stops it.** |
| ≥2 timer matches | `6 match — keep typing` | **moves focus to the first match and nothing else**, which the line already told him |
| 0 timer matches, a matter offered | `⏎ starts a new timer — Northgate Partners · successor trustee appointment` | creates it, starts it, toasts with `Undo` (§2.6) |
| 0 timer matches, no matter offered | `no match — ⏎ does nothing` | nothing |
| ≥2 matches **and** a matter offered | `6 match — keep typing · ⇧⏎ starts a new timer for <matter>` | `⏎` moves focus; **`Shift+⏎`** takes the new-timer row |

He confirms by peripheral glance, never by reading tiles.

**On his secondary suggestion — "on ≥2, consider firing anyway on the most-recently-used
match with an Undo toast" — DECLINED, and here is the reason.** A wrong start is not a
cosmetic error in this app: it opens a draft entry on the wrong matter, it seeds that entry
with that matter's narrative template, and the undo has to unwind a two-row state change
across a matter boundary. Standing rule 1 outranks every piece of magic in this document,
including this one. *"A wrong start that costs one tap beats a right non-start that costs an
hour"* is true only if the wrong start is free, and here it is not. The printed resolution
solves the same problem — he knows, before he looks away, that `⏎` will not start anything —
at zero integrity cost.

| Key | Effect |
|---|---|
| `Tab` | Jump to the first matching tile |
| `Esc` | Clear the query, restore the previous scope and bands, return focus to the previously focused tile |

`/ f u n d ⏎` → a running `Northgate — fund IV formation` clock, from anywhere on the page,
without a mouse, without reading a wall of tiles. **At the seed, `nor` matches 6**, so the
honest demo string is one that matches exactly one — and criterion 32 uses a query measured
to match exactly one at this seed rather than a query chosen for the prose.

The field keeps its `stopPropagation()` on every key so app shortcuts and `StopChips` hot
keys stay out. It is always visible — a `/` affordance that is also a tappable input.

### 8.6 ★ THE DISPLACING START — what happens when a start stops something else (C-9, D-20)

`start` is exclusive: the server stops and files whatever was running, and
`timergrid.js:281-287` mounts `StopChips` **for that other timer**. So `/ f u n d ⏎` and
pressing `4` can both pop a narrative-suggestion sheet belonging to a completely different
matter — after `Esc` has cleared the query and restored a scope that may not include the
displaced timer's tile. Revision 2 never stated this interaction, and its criteria asserted
only that the *started* timer was running.

**The rules:**

1. **The displaced timer's offer mounts on the displaced timer's own tile**, via
   `offeringTimerId` (§10.8 seam 6), which forces that tile visible **in the band it already
   belonged to**, regardless of scope, filter or grouping.
2. **The board scrolls to it** with the `scroll-margin` tokens (§9.7 anti-pattern 13) and
   moves focus into the offer. He is being asked a question; the question is on screen.
3. **The sheet names its matter in its own heading** — it always did, and at 84 timers with
   colliding prefixes that is now load-bearing rather than decorative.
4. **The toast is different, and there is no `Undo`:**

| What happened | Toast |
|---|---|
| Nothing was running | `Started — <name>` **with `Undo`** (stop inside the 2s misclick grace; nothing is filed) |
| Something was running | `Started — <new>. <old> stopped and filed 1.4h.` with **`Open <old>'s entry`** — **no `Undo`** |

**Why no Undo on a displacing start** (D-20): an exclusive start is a *two-timer state
change*. Undoing it means stopping the new timer (which files or discards under the grace
window), restarting the old one at its prior elapsed, and re-opening an entry that may
already carry a chip-chosen narrative. There is no endpoint for that, §13.2 sanctions no
fourth server change for it, and a half-working Undo on a two-row change is an hour-losing
shape. **So the document does not promise one.** What it promises instead is that both
timers are named in the toast and the displaced one's entry is one tap away — which is
information he can act on, rather than a button that might not do what it says.

### 8.7 `tk:lastTimer` — every start and stop path writes it (C-15)

`start` and `stop` write `localStorage['tk:lastTimer']` (`timergrid.js:279, 309`) and the
global `t` shortcut (`tk:toggle-last-timer`, `timergrid.js:393-402`) reads it. This revision
adds **five** paths that start or stop a timer: digit keys, `⏎` on a lone filter match, the
filter's new-timer row, `Stop at…`, and the run bar's repair. **Every one of them writes
`tk:lastTimer`.** §7.5 #82 lists `t` as unchanged, and that is exactly the trap: the
shortcut is unchanged and its input would otherwise be stale — he starts Northgate with
`/ f u n d ⏎`, presses `t` without looking, and toggles whatever he last pressed a *button*
for.

### 8.8 Global keys — unaffected

`n`, `t`, `q`, `c`, `s`, `/`, `g` then `d`/`c`/`s`/`e`, `[`, `]`, `Ctrl+Enter`, `Esc`, `?`
all behave exactly as before. `n` opens the `Log time…` half of the split primary, which is
what it already did.

### 8.9 The `?` overlay must be rewritten

`public/js/app.js:392-399` — the section titled `The timer list` becomes `The timer board`:

```js
['The timer board', [
  ['Tab / click',      'Focus the board'],
  ['1 – 9',            'Start that timer — the number is printed on the tile'],
  ['← →',              'Move between timers in a row'],
  ['↑ ↓',              'Move between rows — and into the entries list'],
  ['Enter or Space',   'Start–stop the focused timer'],
  ['x',                'Expand or collapse the focused timer'],
  ['f',                'Put the focused timer in the front row (or take it out)'],
  ['l',                'Log time you already spent on this matter'],
  ['Shift+Enter',      'Edit the focused timer'],
  ['Ctrl+Enter',       'Open the focused timer’s entry'],
  ['Alt+↑ / Alt+↓',    'Nudge the focused timer’s clock ±0.1h'],
]],
```

And `The filter bar ( / )` (`app.js:400-403`) gains two lines:

```js
['Enter',       'Do what the line under the field says — start a match, or nothing'],
['Shift+Enter', 'Start a new timer on the matter it offers'],
```

---

## 9. CSS PLAN

### 9.1 Files touched

`public/css/timers.css` (the work), `public/css/tokens.css` (size tokens only),
`public/css/base.css` (**create `.sr-only`**, delete a dead rule, extend the 44px touch
tier), `public/css/views.css:572` and `public/css/overlays.css:893` (retarget two dead
selectors). **No other CSS file.**

### 9.2 New tokens — sizes only, no colours

Added to `tokens.css` on **bare `:root` only**. They are dimensions, not colours, so they are
*not* duplicated into the two dark blocks:

```css
--tile-min: 288px;                        /* grid track floor → 3 columns at 1136px */
--tile-h-compact: 34px;
--tile-h-comfortable: 52px;
--tile-h-touch: var(--tap-min);           /* 44px — the ordinary ≤767px tile */
--tile-h-comfortable-touch: 60px;         /* D-M1: was used, never defined */
--tile-h-front: 56px;                     /* the front row, desktop */
--tile-h-front-touch: 72px;               /* D-3 + D-M1: 72/44 = 1.64×, the greyscale gate */
--tile-h-front-comfortable: 72px;
--tile-h-front-comfortable-touch: 88px;
--tile-key-w: 14px;                        /* the 1–9 cap column */
--space-1-5: 6px;                          /* D-M2: used at §9.6, never defined */
```

**The height numbers are an acceptance criterion, not a preference.** Revision 2 specified a
56px front row against a 44px touch tile (**1.27×**) and an ordinary desktop ceiling of 38px
(**1.47×**) while criterion 26 demanded ≥1.5× in greyscale — two criteria that could not both
pass (D-3). The ordinary desktop ceiling is now **36px** (56/36 = 1.56×) and the touch front
row is **72px** (72/44 = 1.64×).

**No new colour value is introduced anywhere.** Every state in §4.8 — including `overnight`,
`running-long`, `archived` and `pending` — resolves to a token that already exists in all
three theme blocks (`--attention`, `--attention-soft`, `--live`, `--danger`,
`--border-strong`, `--border`, `--state-selected-mark`, `--state-disabled-*`, `--figure*`,
`--transport`). If a build finds it needs a colour it does not have, that is a signal the
state is wrong, not that a hex is missing.

### 9.3 Classes — revive, create, retire

**Create:** `.timer-board`, `.board-meta`, `.board-bands`, `.timer-band`, `.band-front`,
`.band-recent`, `.band-all`, `.band-flat`, `.band-matches`, `.band-label`, `.board-foot`,
`.board-more`, `.timer-grid` (**new meaning: a CSS grid**, replacing the deleted
`columns: 300px` multicolumn), `.grid-front`, `.timer-tile`, `.tile-key`, `.timer-body`,
`.timer-overnight-note`, `.timer-flag.filed`, `.timer-tile.offering`, `.timer-tile.archived`,
`.front-nudge`, `.match-new-timer`, `.search-resolution`, `.entry-panel`, `.entry-row`,
`.entry-foot`, `.closeout-step`.

**★ `.sr-only` MUST BE CREATED, in `base.css` (D-10).**
`grep -rn "sr-only" public/css/ public/js/` returns **nothing** today. Revision 2 mandated a
`<span class="sr-only">` on **every tile** carrying name + matter + client + number, and with
no rule that text **paints** — breaking the ≤300px panel, the ≤36px tile, the page-height
budget and the no-horizontal-overflow rule all at once, while criteria 60 and 61 depended on
it. The standard clip pattern, once, in `base.css`:

```css
.sr-only {
  position: absolute; width: 1px; height: 1px;
  padding: 0; margin: -1px; overflow: hidden;
  clip: rect(0 0 0 0); clip-path: inset(50%);
  white-space: nowrap; border: 0;
}
```

**Keep on the tile for test/CSS continuity:** `.timer-row` (co-class on every `.timer-tile`),
`data-timer-id`, `data-row-key`.

**Reuse unchanged:** `.panel`, `.today-head`, `.section-title`, `.seg` / `.seg button.on`,
`.filter-pill`, `.timer-search-wrap` / `-field` / `.timer-search` / `.timer-search-clear`,
`.timer-section`, `.group-head` / `.group-name`, `.timer-name` / `.name-input`,
`.timer-clock` / `.timer-clock-raw` / `.timer-clock-pair` / `.clock-input` / `.figure-edit` /
`.figure-step`, `.timer-start-btn` / `.timer-stop-btn` / `.entry-timer-btn`, `.timer-more` /
`.entry-more`, `.timer-flag` / `.idle-nudge` / `.timer-flag.pinned`, `.timer-selbar`,
`.timer-drop-slot` + `@keyframes drop-slot-open`, `.timer-lifecycle*`, `.stop-chips` /
`.stop-chips-inline`, and on the entries side `.work-rows`, `.work-row`, `.work-body`,
`.work-expand`, `.work-hours` / `.work-figures` / `.figure-tag`, `.work-cm`,
`.narrative-editable` / `.narrative-write` / `.narrative-inline-input`, `.chip-*`,
`.badge-billable|nonbillable`, `.blankslate`.

**Retire:** `.timer-tab` (`base.css:1134`, already dead) — delete. **`.timer-new` as a grid
cell** — the class survives on the `.board-foot` button, but no rule may place it in the grid
(B-11).
**Retarget:** `.panel .timer-card` → `.panel .timer-tile` (`views.css:572`);
`.timer-card.just-started` + `@keyframes tk-start` → `.timer-tile.just-started`
(`overlays.css:893`).

**`.today-list` changes meaning.** It stops being a panel and becomes the wrapper holding
both sections, so `.today-list .timer-row` and `.today-list .work-row` keep resolving:

```css
.today-list { display: flex; flex-direction: column; gap: var(--gap-block); }
.today-list, .today-head { scroll-margin-top: calc(var(--runbar-total) + var(--space-6)); }
```

Move its old surface/border/radius/shadow declarations onto `.timer-board` and `.entry-panel`
(both are `.panel`).

**The offering tile, and the repair tile** (B-7, §4.8.2):

```css
.timer-tile { display: flex; align-items: center; gap: var(--gap-inline); flex-wrap: wrap; }
.timer-tile.offering,
.timer-tile[data-state="overnight"],
.timer-tile[data-state="running-long"] { grid-column: 1 / -1; align-items: flex-start; }
```

`flex-wrap: wrap` lets the portal slot and the repair note take a full line inside the tile;
the tile spans the whole grid row so the offer has 1136px rather than 288px. `align-items:
start` on the grid means the neighbours do not grow.

### 9.4 Density plumbing — reuse, do not reinvent

`readDensity` / `writeDensity` / `useDensity` and `tk:density-changed` already exist in
`public/js/components/entrylist.js:59-89`, backed by `localStorage['tk:listDensity']`. Use
them verbatim. The coordinator calls `useDensity()` once and passes `density` to both
sections. Every board grid writes `class="timer-grid density-${density}"`; the entries list
keeps `class="work-rows density-${density}"` — **it must keep `work-rows`, or
`timers.css:315, 343-383` stops applying**. No third density level, no board-local density.

### 9.5 Long names, unbroken tokens, and the measurement that could never catch them (C-16)

The seed's longest name is **44 characters with spaces** (`Acme — Borealis merger: disclosure
schedules`, measured — revision 2 named two shorter ones), so every screenshot passes. The
tile's single-line name is `white-space: nowrap; text-overflow: ellipsis` and is safe at any
length. **The front row's line 2 and Comfortable's line 2 are not**, and no wrapping rule was
specified anywhere:

```css
.timer-tile .work-cm,
.timer-tile .timer-name-line2,
.front-nudge,
.match-new-timer { overflow-wrap: anywhere; }
.name-input { max-length via attribute; }      /* maxlength="80" on the element */
```

`.name-input` has **no `maxlength` today and never has**. It gets `maxlength="80"`, and
`POST`/`PATCH /api/timers` clamps to the same 80 server-side, because a client-only limit is
not a limit.

**How it is tested without touching the seed:** criterion 27 drives the inline rename to a
60-character unbroken token in a real browser at 412px and asserts
`document.documentElement.scrollWidth === 412`. Revision 2 would have needed a fixture timer
in `demoseed.mjs`, which would have shipped a nonsense name into every screenshot; driving
the rename costs the shots nothing and tests the same rule.

### 9.6 Breakpoints

Only the numbers this codebase already uses: **767/768** and **1024**. No new breakpoint.

```css
@media (max-width: 767px) {
  .timer-grid { grid-template-columns: 1fr; row-gap: var(--space-1-5); }
  .timer-grid .timer-tile { min-height: var(--tile-h-touch); }
  .grid-front .timer-tile { min-height: var(--tile-h-front-touch); }   /* 72px */
  .timer-grid.density-comfortable .timer-tile { min-height: var(--tile-h-comfortable-touch); }
  .timer-tile .work-cm { display: none; }          /* except in .grid-front, which needs it */
  .grid-front .timer-tile .work-cm { display: block; }
  .tile-key { display: none; }                     /* omission, not translation */
}
```

Add `.timer-tile`, `.timer-name`, `.timer-clock`, `.timer-start-btn`, `.timer-stop-btn`,
`.timer-more`, `.board-more`, `.match-new-timer` and `.front-nudge button` to the existing
≤767px 44×44 hit-area tier in `base.css` rather than declaring sizes locally.
`@media (pointer: coarse)` at 768–1023 buys hit area with the centred invisible `::before`
overlay (`base.css:1086`).

### 9.7 Anti-patterns that will fail review

1. A raw hex, px font-size, px gap, radius, shadow, duration or z-index outside `tokens.css`.
2. A hover or pressed state built from `--surface-2`/`--surface-3` (1.04:1 in dark).
3. A second filled saturated-accent surface on the page. `--accent` is spent on the split
   primary (§6.1). Running is `--live`; idle transport is `--transport`; figures `--figure`.
4. Green anywhere.
5. Colour as the only channel for any tile state.
6. `opacity` to say disabled (use `--state-disabled-bg/-fg/-border`).
7. A clipped zero-height collapse for the tile body (use `display: none`).
8. A hover-revealed `⋯`. It is persistent; any hover-revealed control must also reveal on
   `:focus-visible`.
9. `flex: 1 1 auto` on the tile's name when the control cluster shares the line.
10. Content setting tile height in a grid of like items — `min-height` + clamp.
11. Any horizontal overflow at 390–412px.
12. Wrapping tile hover in `@media (hover: hover)` — the measurement harness is headless
    Chromium and reports `hover: none`.
13. Scrolling a tile into view without `scroll-margin-top: calc(var(--runbar-total) +
    var(--space-6))` and `scroll-margin-bottom: calc(var(--shell-nav-total) +
    var(--space-6))`.
14. **A disclosure whose label rewrites itself by state.** No `…`, no bare chevron, no
    "more" — *and no `Show all 84 timers` → `Hide the other 75 timers` either* (A-20). The
    control says `All timers` / `Fewer timers`, fixed text, and the count lives in the meta
    where it is read passively.
15. **A control that appears in a wireframe and nowhere else in this document.** If it is
    drawn, it has behaviour, state, a keyboard path and **a criterion**.
16. ★ **A state that exists only in a `title` attribute.** He runs this as an Android PWA;
    `title` has no hover. Every state that changes what he should *do* has words on the face
    (§4.8) — and `title` is a redundant second channel, never the first.
17. ★ **A per-render pairwise scan over the tile set.** The board re-renders on a 1s tick and
    a 5s poll in a no-build UMD React app; anything O(n²) over 84 tiles inside render is
    forbidden. This is what killed the rtl-truncation trick (A-17).

---

## 10. FILE PLAN

**The builder may NOT edit `public/sw.js` or `public/index.html`.** The orchestrator owns
both. Because `sw.js` enumerates every JS module in `SHELL`, the builder's handoff **must
report the nine new module paths** listed in §10.1 plus the `CACHE` bump, or installed PWA
clients will 404 the new modules from the cache-first shell.

### 10.1 The line budget, with the arithmetic (B-9, D-9, D-18)

Revision 1 put an unreachable 800-line ceiling on `timergrid.js`. Revision 2 moved the
overflow into a new `timerboard.js` and put a 640 ceiling on it; the builder priced the real
content at **≈830** and called it "moved, not fixed" — and separately found revision 2's
`timergrid.js ≤780` derivation omitted `batchMenuItems` (43), `selectCard` (32),
`clearSelection`/`exitSelectMode`/`focusEntryOf`/`guard`, and the `allRows`/`todayEntries`
assembly (~40), leaving 0–20 lines of headroom rather than 40.

**An unmeetable ceiling is worse than none — it teaches the builder that criteria are
decoration.** So the split goes one level further and every omission the builder named is in
the arithmetic:

| File | Contents | Ceiling |
|---|---|---|
| `components/timergrid.js` (coordinator) | state, effects, the one fetch clock, the 5s poll, notifications, **all 21 mutations**, event listeners, `reveal()`, `StopChips` + menu + modal + stepper mounts, a three-line render | **≤ 800** |
| `components/timerboard.js` ★ | control row, filter + resolution line, filter pills, bands, sections, grids, match band, `.board-foot`, batch bar, front-nudge, drag handlers **with a board-local `dragId` ref**, `onBoardKey` | **≤ 520** |
| `components/timertile.js` ★ | `TimerTile` alone — markup, state computation, rename, clock pair + `.figure-edit`, transport, `⋯`, flags, key cap, `.sr-only` line, repair note + primary, front-row line 2, `data-pending`, expanded body, drag attrs | **≤ 340** |
| `components/todayentries.js` ★ | one row per entry, its own `⋯`, roving list, blankslate, phone cap | **≤ 400** |
| `components/closeoutstepper.js` ★ | §5.5 — the queue, the overlay, the pre-fill, `⏎`/`Tab`/`Esc` | **≤ 200** |
| `components/timermodals.js` ★ | `TimerModal` (1674–1786) + `GroupModal` (1788–1807) moved verbatim, then extended with `Move to the front row` and **the matter-change dialog (§6.5)** | **≤ 280** |
| `lib/boardselect.js` ★ | **pure**: `workingSet()`, `recentOrder()`, `matchesFilter()`, `fold()`, `squash()`, `visualOrder()`, `colsOf()`, `verticalTarget()`, `digitTarget()`, `selectCard()`, `allRows()` | **≤ 220** |
| `lib/boardmenu.js` ★ | **pure**: `boardSetupItems()`, `timerMenuItems()`, `entryMenuItems()`, `batchMenuItems()`, `stopAtOptions()` — arrays of `{label, onClick}` for the shared `Menu` | **≤ 160** |
| `lib/boardstate.js` ★ | **near-pure**: the `settings.board` mirror (§2.9), the first-run seed, `recomposeRecent()`, and the day-boundary comparison (§2.8) | **≤ 160** |
| `lib/hours.js` ★ | **pure**: `parseHoursInput()` and `hoursEcho()` (§6.4). **The server imports this same file** (`import { parseHoursInput } from '../../public/js/lib/hours.js'`) — it is plain ESM with no browser or node dependency, and one canonical parser is the whole point; a second copy is how the three hours formatters drifted before. | **≤ 90** |
| `test/boardselect.test.js` ★ | node:test, **at 84 timers** | — |
| `test/boardstate.test.js` ★ | node:test — mirror, seed-only-on-success, day rollover | — |
| `test/hours.test.js` ★ | node:test — every row of §6.4's table, both directions | — |

**Derivation for `timergrid.js ≤800`**, with the builder's omissions included: imports 35 +
header comment 28 + state 75 + fetch/poll/notify 90 + mutations 360 (the 17 existing plus
`stopAt`, `setFront`, `archive`, `createAndStart`) + listeners 90 + `reveal()`/scope 40 +
menu/confirm/stepper mounts 70 + render 25 = **813**, minus the ~60 that
`batchMenuItems`/`selectCard`/`allRows` take with them into `lib/` = **≈753**, with ~47 of
real headroom. `boardstate.js` and `boardmenu.js` exist for exactly this reason.

**Derivation for `timerboard.js ≤520`**: control row 95 + filter pills 12 + band/section/grid
render 90 + match band and new-timer row 35 + `.board-foot` 15 + batch bar 20 + front-nudge
25 + drag handlers 60 + `onBoardKey` 120 + imports/props 35 = **507**. The tile (the builder
priced it at ≈327) is in its own file; the menu builders are pure and in `lib/`.

Putting the selection rules, the menu items, the board state and the hours parser in **pure,
unit-tested modules** is not line-count accounting: the working-set rule is the heart of this
design (§2), the hours parser is the heart of §6.4, and both must be provable at 84 timers
without a browser.

### 10.2 `components/timergrid.js` — the coordinator

Replace lines 19-42 with this comment. **The citations are corrected** — revision 2 mandated
`STATUS.md:236-238`, which is a paragraph about session-4 verification, and told the builder
to paste "EIGHTY-THREE" for a seed of 84 (D-11, D-M5):

```js
// ---------------------------------------------------------------------------
// TWO SECTIONS: A TIMER BOARD, AND THE DAY'S ENTRIES BENEATH IT
//
// An earlier pass merged these into one list of rows. The owner rejected it:
// "The original base app has approximately the structure I want. A list of
//  buttons that persist day-to-day. I don't recreate them. They are very
//  compact, sortable, editable, etc." (docs/ui/STATUS.md:322-324)
// …and on the teardown's argument for the merge: "teardown was wrong."
//
// So the board is back as its own section — a persistent bank of compact tiles
// that is the SAME set of buttons tomorrow — and the entries the day produced
// are a separate list below it. Do not re-merge the lists, and do not restore
// the m<cmId> merged row kind. Spec: docs/ui/TIMERBOARD-SPEC.md.
//
// HE HAS EIGHTY-FOUR TIMERS. The board therefore opens on a BOUNDED WORKING
// SET — a fixed front row of three plus a Recent band, nine tiles — with the
// rest behind one labelled control. The working set is always a PREFIX of the
// full board, and the phone's six is a prefix of that, which is what keeps the
// digit keys and his muscle memory stable across scopes and devices. Those
// rules live in lib/boardselect.js and lib/boardstate.js and are unit-tested
// at 84 timers. See spec §2.
//
// THIS FILE IS THE COORDINATOR, and only that. It owns the ONE fetch clock
// (`fetchedAt` + startAlignedTick), the 5s poll, the day boundary, the
// long-run notifications, every mutation that touches both halves, the stop
// offer, the modals, the close-out stepper and the window-event listeners. It
// renders <TimerBoard/>, <TodayEntries/> and <CloseoutStepper/> and nothing
// else. Two fetch clocks would let the board and the entries disagree by up to
// 5s; two poll timers would double the notifications.
// ---------------------------------------------------------------------------
```

Keeps: `timers`/`groups` state + `reload()` + the 5s poll (**paused while the tab is
hidden**, §2.8) + `visibilitychange`/`focus` refetch; `fetchedAt`, `forceTick`,
`startAlignedTick`, `liveElapsed`; ★ `today` and the day-boundary effect; `longRunMarks` +
the notification effect (**guard it** — R7); `useDensity()`; `gridFilter`; `grouping` /
`onlyKey` / `activityKey` / `order`; ★ `boardScope` / `frontRow` / `recentIds` /
`pendingIds`; `selected` / `selectMode` / `anchorId`; every mutation (`start`, `stop`,
`stopAt` ★, `clockDelta`, `clockSet`, `entryTotalSet`, `finalizeEntry`, `unlockEntry`,
`deleteEntry`, `startForEntry`, `duplicate`, `fresh`, `quickTimer`, `sortAZ`, `nudgeOrder`,
`dropOn`, `persistOrder`, `setFront` ★, `archiveTimer` ★, `createAndStart` ★); `reveal()`;
**all seven** window-event listeners (`timergrid.js:257, 264, 400, 416, 417, 452, 464` —
revision 2 said ten, D-M3); `StopChips`; both `Confirm`s; both `Menu` mounts; the
`timermodals.js` and `closeoutstepper.js` mounts.

Renders:

```jsx
<div class="today-list">
  <TimerBoard  ...boardProps />
  <TodayEntries ...entryProps />
  <CloseoutStepper ...stepperProps />
</div>
```

### 10.3 `components/timerboard.js` — NEW, ≤520 lines

Exports `TimerBoard`. **Pure presentation + local focus/expand/drag state.** It fetches
nothing and owns no timer.

```
timers, groups, density, filter, setFilter, searchInputRef, resolution,
grouping, setGrouping, onlyKey, setOnlyKey, activityKey, setActivityKey,
order, setOrder, scope, setScope, frontRow, onSetFront, recentIds, nudge,
selected, selectMode, /* selection setters */, pendingIds,
revealRequest /* {id, stamp} */, focusRequest /* {dir, stamp} */,
liveElapsed, offeringTimerId, matterOffer,
onStart, onStop, onStopAt, onClockSet, onClockDelta, onRename, onEditTimer,
onOpenEntry, onLogTime, onNewTimer, onCreateAndStart, onArchive, onSortAZ,
onBoardMenu, onTileMenu, onNudgeAccept, onNudgeDismiss,
onDrop(timerId, target)      /* target = {kind:'front'|'group'|'before', id} */,
onFocusOut(dir)              /* ↓ off the last grid hands focus to the entries list */
```

**The 5s poll is not sized by this file but is constrained by it** (C-19): the board must
never trigger a second fetch, and the poll it depends on **pauses while
`document.visibilityState !== 'visible'`**. Eighty-four rows with six correlated subqueries
each, every five seconds, over a Cloudflare tunnel to a sleeping phone, is a battery bug.

### 10.4 `components/timertile.js` — NEW, ≤340 lines

Exports `TimerTile`. Everything in §4.7's markup and §4.8's state table, plus the repair note
and primary (§4.8.2), the front row's line 2, the key cap, the `.sr-only` line and
`data-pending`. It receives a timer and callbacks; it owns no state but its own inline-edit
buffers.

### 10.5 `components/todayentries.js` — NEW, ≤400 lines

Exports `TodayEntries`. One row per entry, its own `⋯`, its own roving list, its own
blankslate, the phone 6-row cap + `.entry-foot`. Reuses `InlineNarrative`, `EmptyState`,
`StatusChip`, `BillableBadge`, `ValidationList`. Props:
`entries, density, filter, liveRunning, entryFocus /* {key, expand, editNarrative, stamp} */,
focusRequest, onStart, onStop, onSetHours, onOpenEntry, onFinalize, onUnlock, onDelete,
onLogTime, onEntryMenu, onFocusOut(dir)`.

### 10.6 `components/timermodals.js` and `components/closeoutstepper.js` — NEW

`timermodals.js` (≤280): `TimerModal` and `GroupModal`, moved out of `timergrid.js` verbatim
(B-9), then extended with `Move to the front row` in the position section and with **the
matter-change dialog (§6.5)**, which is a `Confirm` on the shared overlay — not a new modal
component.

`closeoutstepper.js` (≤200): §5.5. It renders on the shared overlay primitive, takes
`{ queue, onSave, onClose }`, and adds **no endpoint**.

### 10.7 `components/stopchips.js` — the fourth file, and the mount decision (B-7)

`useRowSlot` (`stopchips.js:907-944`) resolves
`document.querySelector('.today-list .work-row[data-timer-id="…"]')` and falls back to
`[data-entry-id]`. The split gives the tile `.timer-tile` / `.timer-row` — **not
`.work-row`** — so the timer branch dies, the entry branch matches a row in the **entries
panel hundreds of pixels below**, and `row.scrollIntoView()` yanks the page away from the
tile he just pressed.

**The decision: the offer mounts where he pressed stop — on the tile.** Three changes, all
inside `stopchips.js`:

1. **Resolution order** in `useRowSlot`:
   ```js
   const find = () => (
     (timerId != null
       && document.querySelector(`.timer-board .timer-tile[data-timer-id="${timerId}"]`))
     || (entryId != null
       && document.querySelector(`.entry-panel .work-row[data-entry-id="${entryId}"]`))
     || null);
   ```
   Tile first, entry row second, floating panel third. **The tile the offer mounts on is
   forced visible** via `offeringTimerId` (§10.8 seam 6).
2. **`SLOT_CSS`** — the old value assumed `order:3` inside `.work-row`'s flex layout:
   ```js
   const SLOT_CSS = 'all:unset;display:block;order:9;flex:1 1 100%;min-width:0';
   ```
   `order: 9` puts the slot after every painted control in the tile (all order 0) and after
   `.timer-body` if it is open — safe, because the highest `order` in `timers.css` is `2`
   (`.work-body`/`.work-extra`, `:305-306`).
3. **Hot-key scope** — `stopchips.js:632` does `root.closest('.work-row')`:
   ```js
   const row = root && root.closest ? root.closest('.timer-tile, .work-row') : null;
   ```

**And the e2e assertion this breaks is now IN the migration table** (§11 row 1). Revision 2
claimed at §10.6 that *"the e2e assertion still passes because it checks `.work-row`"* — that
is true only of the **broken** behaviour. Under the specified fix the offer mounts on
`.timer-tile`, whose co-class is `.timer-row`, not `.work-row`, so
`el.closest('.work-row')` returns null and `e2e-smoke.mjs:381` throws. That is builder
blocker D-4: B-8 recurring in the exact place B-7 was supposed to close.

Nothing else about the component changes. The pre-fill stays (a precondition of
`fence.suggestionmatter.test.js:277`), the 30s bare dismissal stays, the matter fences stay
untouched.

### 10.8 THE SEAMS — every shared ref and cross-list event, with its owner (B-13)

| # | Shared thing | Owner | How it crosses the seam |
|---|---|---|---|
| 1 | **`dragId`** | **`TimerBoard`**, board-local `useRef`. The coordinator never sees it. | `onDragStart` sets the board's own ref; `onDrop` calls `props.onDrop(timerId, target)` with **explicit arguments**. **Criterion 71: the string `dragId` does not appear in `timergrid.js`.** |
| 2 | **`tk:focus-entry`** | Coordinator listens; **`TodayEntries` acts** (a specific row) or **`CloseoutStepper` opens** (a count) | Coordinator sets `entryFocus = { key: 'e<id>', expand: true, editNarrative: true, stamp }`. `TodayEntries` runs an effect keyed on the stamp: lifts the phone cap if needed, sets its own `focusKey`, expands, focuses the editor, scrolls with the `scroll-margin` tokens. |
| 3 | **`searchInputRef`** | **Coordinator** (because `tk:timer-search` arrives there) | Passed to `TimerBoard`, which attaches it to `<input class="timer-search">`. |
| 4 | **`revealRequest`** | **Coordinator** (`reveal()`) | `{ id, stamp }` prop. The board's effect clears the filter, forces `scope='all'` when the id is outside the working set, scrolls, focuses. |
| 5 | **`focusKey`** (board) and **`focusKey`** (entries) | Each owns its own; queries scoped to `.timer-board …` / `.entry-panel …` | `onFocusOut('down')` → coordinator sets `focusRequest = {target:'entries', edge:'first', stamp}`; `onFocusOut('up')` → `{target:'board', edge:'last', stamp}`. Neither reads the other's DOM. |
| 6 | **`stopPopup` / `offeringTimerId`** | **Coordinator** mounts `StopChips` once | Prop to `TimerBoard`, which (a) forces that tile visible **in its own band**, (b) adds `.offering`, (c) **scrolls to it on a displacing start** (§8.6). The board must not read the DOM to discover the offer. |
| 7 | **`fetchedAt` / `liveElapsed` / `startAlignedTick` / `today`** | **Coordinator only** | Passed down as values. `TodayEntries` never fetches `/api/timers`. |
| 8 | **`boardScope` + `frontRow` + `recentIds`** | **Coordinator**, via `lib/boardstate.js`, persisted to `settings.board` and mirrored to `localStorage` (§2.9) | Props + setters. `reveal()` and the day boundary both write scope, which is why it cannot live in the board. |
| 9 | ★ **`matterOffer`** (§2.6's new-timer row) | **Coordinator** — it owns the debounced `GET /api/cms/picker?q=` and the two POSTs | `{ query, cm } \| null` prop. The board renders the row and calls `onCreateAndStart(cm)`. The board never fetches. |

### 10.9 Server and settings — THREE changes, and why the third is not optional

Revision 2 sanctioned two. The completeness critic showed that the flagship feature cannot be
built with two, because **nothing in the payload says a rollover happened** (C-1). Non-goal 6
is amended accordingly, in §13.2, and the third change is named here:

1. **`POST /api/timers/:id/stop-at`** (§4.8.3) — the repair. One transaction, audited, with
   an undo token, a `dry_run` mode, idempotency on `(timer_id, at)`, and **the matter fence
   (rule 8)**. Unit-tested in `test/api.timers.test.js`, integrity-tested in
   `test/integrity.entries.test.js` (no hour created or destroyed) and in a new
   `test/integrity.stopat.test.js` (the cross-matter 409, and that a 409 writes nothing).
2. **`server/routes/settings.js:6` — add `'board'` to `KEYS`.** The route whitelists settings
   keys and 400s on anything else. Server-stored rather than `localStorage` because his front
   row must be the same on the desktop and on the Android PWA.
3. **★ ROLLOVER PROVENANCE — migration v19 + the `rollover_from` projection + the dashboard
   alert** (§4.8.1). Three nullable columns appended to `timers`
   (`rollover_entry_id`, `rollover_last_activity_at`, `archived_at`), written inside the
   existing rollover and archive statements; one subquery block on `listStmt()`; one disjoint
   bucket on `server/routes/dashboard.js`'s `alerts`. **Appended to `MIGRATIONS` in
   `server/db.js` with a new `PRAGMA user_version`; no existing migration is mutated and no
   existing column changes type or meaning.** Tested in `test/api.timers.test.js` (the
   projection appears exactly when a running timer banked > 0h and is cleared by any stop)
   and `test/migrations.test.js`.

No other server change. No new runtime dependency.

### 10.10 JS elsewhere

- `public/js/app.js:392-403` — the `?` overlay (§8.9); `openQuickCapture(scope)` and
  `tk:quick-capture` carrying `detail.scope` (§6.3); the split page primary (§6.1).
- `public/js/components/menu.js` — split `rowMenuItems` (456–566) into `timerMenuItems` /
  `entryMenuItems` (now living in `lib/boardmenu.js`); split `rowMenuTitle` (571–577) into
  two titles that name the object. New items: `Log time already spent…`, `Show details`,
  `Stop at…`, `Move to / Remove from the front row`, `Archive timer` / `Restore timer`.
- `public/js/components/quickcapture.js` — the `scope` prop (§6.3), the typed hours field and
  dual-unit pills (§6.4), and the post-file toast's second action.
- `public/js/components/runbar.js` — the repair routing (§4.8.4) and **the running timer's
  digit** (`⏱ 3 · 00:41:12 · Acme — merger`, §2.11).
- **`public/js/views/dashboard.js` — the attention band gains `N ran overnight` and
  `Nh isn't filed yet`, both tappable** (C-14). Revision 2 declared this file an "unchanged
  component contract" while a criterion asserted a string only this file could render — the
  document committing its own anti-pattern 15. Its props are unchanged; the band's markup is
  not.

---

## 11. THE e2e MIGRATION — every contradicting assertion, migrated, retired, or shown to be safe

`scripts/e2e-smoke.mjs` migrates **in the same commit**, never by deleting an assertion
(`BRIEF.md:200-204`). Revision 2 listed fifteen rows and the builder found four more that
break — including **the one the B-7 fix itself breaks** (row 1), which revision 2 explicitly
claimed still passed. **Twenty-eight rows. Nothing is silently deleted, and nothing is
silently assumed safe.**

| # | Line(s) | Asserts today | Verdict | Reason / new target |
|---|---|---|---|---|
| 1 | **381** | `el.closest('.work-row')` on `.stop-chips` — *"the chips are on the stopped row"* | **MIGRATE** | **The assertion the B-7 fix breaks (D-4).** The offer now mounts on `.timer-tile` (co-class `.timer-row`), so `closest('.work-row')` is null and the step throws. New: `!!el.closest('.timer-tile, .work-row')`, **plus** a new assertion that after a stop *from a tile* it resolved to `.timer-tile` — criterion 67 asserts the opposite mount is `null`, which is the regression that matters. |
| 2 | 1697 | `!document.querySelector('.timer-search')` after `Esc` — the bar disappears | **RETIRE the clause** | The field is always visible now (§4.2). Replaced by: after `Esc`, `.timer-search` still exists, `.value === ''`, and the working-set tile count is back to 9. |
| 3 | 1700 | after `Esc`, focus is on `.work-row` | **MIGRATE** | `document.activeElement.classList.contains('timer-tile')`. |
| 4 | 1666, 1673 | the `1/N` counter read from `.timer-search-wrap .muted` | **MIGRATE** | The counter moves to `.board-meta`: assert `/^\d+ of 84 shown/` and `/^0 of 84 shown/` at zero. |
| 5 | 1672 | zero matches → `.work-row` count `=== 0` | **MIGRATE** | `.timer-board .timer-tile` count `=== 0`. `.work-row` now means an entry row and the two must not be conflated. |
| 6 | 1193 | the list menu contains `A–Z` | **MIGRATE, not retire** | A–Z is **demoted into** `Board setup…` (B-3): open `.timer-board .today-menu-btn` and assert `Sort A–Z…` is present. Demoting keeps the assertion; promoting would have retired it. |
| 7 | 111–129 + **13** call sites (1143, 1237, 1249, 1256, 1276, 1279, 1316, 1321, 1392, 1436, 1484, 1562, 2035) | `setListSeg(label, text)` drives `Show` / `Group` / `Order` through a menu seg | **MIGRATE the helper, not the call sites** | `Show` and `Order` stay in the menu. `Group` is on the face, so the helper branches: if `label === 'Group'`, click `.timer-board .seg[aria-label="Group"] button` by text; otherwise open the menu as today. **Thirteen call sites untouched, one helper edited** — revision 2 said ten (D-6). |
| 8 | 149–160 | `sectionCount` counts `.work-row` inside `.timer-section` | **MIGRATE** | `.timer-row` (the tile's co-class). A section holds tiles, not entry rows. |
| 9 | 1144–1150 | after creating a group: `.group-head .group-name` exists; `sectionCount('Litigation') === 0`; `sectionCount('Ungrouped') >= 1` | **NO CHANGE — and here is the proof** | These fixtures hold **one or two timers**, and §2.10 says a board of ≤9 timers **does not band**: one flat grid, grouping applied to the whole board, `.group-head` present exactly as today. Revision 2 would have broken every one of these (D-6). |
| 10 | 1154–1161 | `.today-list .timer-row` length `=== 0`, then `=== 1` | **NO CHANGE** | Same reason as row 9. |
| 11 | 1182–1183, 1207–1220 | `dndToSection` then `.timer-row` count `=== 1` inside a named section | **NO CHANGE** | Same reason. Drop targeting on `.timer-section` is unchanged (§4.5). |
| 12 | 1228–1231 | `Only` → exactly one `.today-list .timer-row .timer-name`, `Acme research` | **NO CHANGE — and this is builder blocker D-5 closed** | Revision 2 exempted Bands A/B from `Only`, so with a front row of 3 this could never be 1 again. §2.10 makes it moot: a one-timer fixture has no bands. |
| 13 | 1239–1257 | group rename / delete; `.group-head` count `=== 0` afterwards | **NO CHANGE** | Same reason. |
| 14 | 359, 361, 370, 374, 733, 776, 1168, 1545 | `.timer-row button[title="Start"]` / `[title="Stop & file time"]` / `[title="Row menu"]` | **NO CHANGE — because the spec changed instead** | Revision 2's mandated markup gave tile buttons `aria-label` only, silently breaking all eight (D-7). §4.7 now requires **both** `title` and `aria-label` on every tile button, matching `timergrid.js:1578, 1644`. |
| 15 | 438–443 | `.work-entry` count `>= 2` — *"the matter's entries did not merge onto one row"* | **RETIRE** | This asserts the merge, which the owner killed. The one deliberate retirement in this table. **Replaced by the opposite capability:** a matter billed twice today renders **two** `.entry-panel .work-row` with distinct `data-entry-id`, each with its own hours, narrative editor and menu. Criterion 91. |
| 16 | 410 | `.today-list .work-row` first-row text | **MIGRATE** | `.entry-panel .work-row` — it is about an entry. |
| 17 | 498, 501, 504, 516 | `.today-list .work-row` narrative / running-row lookups | **MIGRATE** | `.entry-panel .work-row`. |
| 18 | 526, 568 | `el.closest('.work-row')?.dataset.entryId` | **MIGRATE** | `.entry-panel .work-row`. |
| 19 | 793, 796 | `.today-list .work-row` → `Assign matter` | **MIGRATE** | `.entry-panel .work-row`. |
| 20 | 1058, 1065 | `.today-list .work-row` text lookups | **MIGRATE** | `.entry-panel .work-row`. |
| 21 | 1401, 1404, 1456 | `document.querySelector('.today-list .work-row').focus()` and neighbours | **MIGRATE** | `.timer-board .timer-row` — these drive board focus. Rows 16–21 are the per-assertion split revision 2's single row 11 collapsed and partly omitted (D-M9): **decide by the capability each one covers, never by textual search-and-replace.** |
| 22 | 1395–1411 | single-column arrow semantics: Down → next row, Right → next row | **MIGRATE** | Grid semantics, **and the grouped partial-last-row case** (B-12): in `Group` + `all` scope at 3 columns, focus the last tile of a section whose count is not divisible by 3, `ArrowDown` lands on the same-column tile of the next section. Criterion 64. |
| 23 | 678, 708 | `clock.closest('.work-row').querySelector('.work-expand').click()` to expand a timer | **MIGRATE** | `clock.closest('.timer-tile')`, then **the tile menu's `Show details`** — the tile has no chevron and §4.9 names the three paths (D-16). |
| 24 | 182 | `.today-list .blankslate` on a cold start | **MIGRATE** | `.timer-board .blankslate` — the board's blankslate offers `＋ New timer` and `Start`. The entries panel gets its own. |
| 25 | 1524 | manual-order nudge: `next?.classList.contains('work-row')` | **MIGRATE** | `.timer-row`, and the assertion runs in `all` scope (manual order is Band C's order) — or, on a small fixture, in the flat band (§2.10). |
| 26 | 1655–1662 | `/` focuses `.timer-search`, typing narrows to one tile | **MIGRATE and EXTEND** | Unchanged in shape, **plus four**: the filter searches all 84 in **working** scope (a dormant tail timer matches without `All timers`); the `.search-resolution` line prints `⏎ starts: <name>`; `Enter` on a one-match query **starts that timer**; and a query naming a **matter with no timer** renders `.match-new-timer`. Criteria 31–34. |
| 27 | 462–464 | the stale-key-cap hazard around `StopChips`' own `1 2 3` | **EXTEND** | Add: while `.stop-chips-inner` exists, `document.querySelectorAll('.tile-key:not([hidden]))` is empty and no computed `.tile-key` is visible (D-M10). Criterion 30. |
| 28 | **22** | `const deps = { db, config, clock: () => new Date() }` — a real clock, no injection point | **EXTEND the harness** | `let clockSkewMs = 0; clock: () => new Date(Date.now() + clockSkewMs)` plus an `advanceDays(n)` helper that sets the skew and fires `visibilitychange`. **Without this, criteria 17–19 cannot be driven at all** (D-13). A harness capability, not a product change. |

`test/fence.suggestionmatter.test.js:199,200,288` and
`test/verify.narrativehistory.cmid.test.js:394,397,401` are **server-side** — they must not
need a change. If they do, stop: the board has touched integrity logic it has no business
touching.

---

## 12. ACCEPTANCE CRITERIA

Evidence is **screenshots and driven behaviour, never source**, except where a criterion
explicitly names a grep or a unit test. Run
`node scripts/uishots.mjs --out shots/board --only dashboard` at **1440×900** and
**412×915**, in **light and dark**, then `node scripts/uishots.mjs --strict`.
**Any console error, and any `manifest.json` error, is a failure.**

**Every measured criterion is taken against the seed in `scripts/lib/demoseed.mjs` as
amended by §1.4 — 84 timers, 90 matters, 17 clients, 5 groups, 7 timers with activity today
(1 running), 11 entries today, 15.0h filed, 2 entries needing a narrative.** A number
reported against any other dataset is not evidence. Where a criterion needs a different
shape (a nine-worked day, a four-timer board, an overnight timer) it says so and names the
fixture.

### Structure and the default view (B-1, A-12, A-20, C-4, D-1, D-2)

1. `#/` renders exactly two labelled sections, `Timers` and `Today's entries`, in that order,
   each its own `.panel`.
2. **Cold open, 84 timers, working scope: `.timer-board .timer-tile` count is exactly 9 on
   desktop and exactly 6 at 412px.** Not 84.
3. Pressing `All timers` renders 84 tiles **and the first nine keep the same
   `data-timer-id` in the same DOM order and the same `getBoundingClientRect().top`** — the
   working set is a prefix and the disclosure only appends (§2.5).
4. The disclosure's text is **`All timers` before and `Fewer timers` after**, byte-identical
   across states apart from those two words; it has `aria-expanded`; it is **not** inside
   `.timer-grid`; and it is **absent** while a filter is typed and on a board of ≤9 timers.
   *(Fails if the label rewrites itself with a count — A-20.)*
5. **`.band-front .timer-tile` count is exactly 3**, they carry `data-pos` 1–3, and their
   `data-timer-id`s equal `settings.board.front` in order. Driven at front rows of 1, 2 and 3
   members: at 2, digit `3` starts the **first `Recent` tile**, and every `.tile-key` on the
   board equals its own `data-pos`. *(Fails on any "cap 6" implementation — C-4, D-2.)*
6. **THE RUNNING TIMER IS ALWAYS IN THE PREFIX.** At the seed and at a fixture where the
   running timer is *not* in `settings.board.front`, `document.querySelector('.timer-tile.running')`
   is inside `.band-front` or `.band-recent` and **never** inside `.band-all`, in both scopes
   and at both viewports; and the run bar prints its digit (`⏱ 3 · …`). *(This is the
   invariant that replaces revision 2's criterion 3, which was false at this seed — D-1.)*
7. The front row is seeded from **hours in the last 14 days**, not creation order: on a fresh
   database seeded with §1.4's data and no stored `board.front`, the three members are the
   three timers whose matters carry the most 14-day hours, ties broken by most recent
   activity then `sort_order`. Asserted by computing the ranking from the API and comparing
   ids — **not** by hardcoding three names. *(Fails on "the first three in manual order" —
   A-10.)*
8. `Group` groups **Band C only**: `.band-front` and `.band-recent` contain no `.group-head`,
   and their tile order is unchanged by the grouping seg. Repeat for
   `Board setup → Only: Litigation` and `Board setup → Show: Yesterday` — **all three leave
   Bands A and B untouched** (D-21).
9. **No element in `.band-front` or `.band-recent` carries a `📌`**, and a timer with
   `pinned = 1` renders `📌` wherever it appears. Front-row membership has **no glyph**
   (C-13, A-18).
10. A timer with no entry today appears **only** in the board. A finalized entry with no timer
    appears **only** in the entries list. No timer name appears in the entries list; no entry
    hours figure appears on a tile.

### Measured — desktop 1440×900, **84 timers**, 11 entries, one timer RUNNING (D-14)

11. Distance from `.timer-board` panel top to the first `.timer-tile` top: **≤72px**
    (target 60; baseline 142).
12. `.timer-board` panel total height: **≤300px** in working scope (target 283).
13. **With the run bar fixed at the TOP** (`runbar.css:100-101`, `--runbar-total` = 49px,
    `.main` padding-top 73px): all **9** working-set tiles and at least **4**
    `.entry-panel .work-row` are fully inside the 900px viewport with `scrollY === 0`.
    Asserted by reading `getBoundingClientRect()`, and the harness asserts
    `getComputedStyle(document.querySelector('.runbar')).top === '0px'` first, so a future
    move of the bar fails this criterion loudly instead of silently. *(Revision 2 asserted 5
    rows above a bar it had placed at the bottom.)*
14. In `all` scope the board panel grows and the page scrolls; **no tile is clipped, and
    `.entry-panel` is still reachable by scrolling with no horizontal overflow.**
15. Ordinary tile height spread at Compact: **max/min ≤ 1.05×**; measured ordinary tile
    height **≤36px**; front-row tile height **56–60px**.
16. At 1440×900 each `.timer-grid` renders **3 tiles per row**; at least two tiles in a band
    share a `top` within 2px. At 412px, 1 per row.
17. **Board chrome control count: interactive elements inside `.timer-board` that are NOT
    inside a `.timer-tile` — heading area, seg, filter, clear, `⋯`, and `.board-foot` — is
    **≤8**, and **≤7** with no query typed.** *(This replaces revision 2's `≤48 visible
    controls`, which had no counting rule and priced out at ~100 — D-12. A ceiling nobody can
    compute is not a gate.)*
18. **Painted buttons on a resting tile: exactly 2** (transport and `⋯`), asserted across all
    9 default tiles by computing `getComputedStyle(...).backgroundColor !== 'rgba(0, 0, 0, 0)'
    || borderStyle !== 'none'`. The name and the tenths are click-to-edit typography.

### Measured — phone 412×915, **84 timers**, 11 entries (A-13, D-3)

19. `.timer-board .timer-tile` count is **6**; `.entry-panel .work-row` count is **6** with a
    `Show all 11 entries` control (§5.4).
20. **The phone's six `data-timer-id`s are exactly the desktop's first six, in the same
    order**, driven in one browser session by resizing between the two viewports without
    reloading. *(Fails on any device-specific band composition — A-13.)*
21. **≥6 pressable timer tiles fully above the fold**, and the first control that can start a
    timer is at `y < 460` (raised from revision 2's 400 because the run bar is at the top and
    the front row is 72px — the honest number, measured).
22. Total Today page height: **≤1,480px** (§3.2's derivation lands at 1,395).
23. `document.documentElement.scrollWidth === 412`. Zero horizontal overflow. Repeat at
    390×844.
24. Every tile control has a hit box **≥44×44**. Safe-area insets respected.
25. `.tile-key` is not rendered below 768px.
26. Every entry that needs a narrative is inside the visible 6 rows, even when more than 6
    entries exist (§5.4).

### The front row over time, empty bands, and the day boundary (A-10, A-11, A-14, C-6, C-10)

27. **Staleness nudge:** with a fixture where a front-row timer has no recorded time for 31
    days, `.front-nudge` renders inside `.band-front`, names that timer and one replacement,
    and offers two labelled ≥44px controls. `Swap` performs the exchange and toasts with
    `Undo`. **At most one nudge renders**, and none renders when every front-row timer is
    warm. *(Fails if the board only refuses to auto-edit and never notices — A-10.)*
28. `Not now` suppresses that pairing for 90 days across a reload
    (`settings.board.nudgeDismissed`).
29. **A band with no members renders neither tiles nor its label.** With a fixture where
    nothing has run in 90 days, `.band-recent` is **absent from the DOM** — not an empty grid
    under a `Recent` heading (A-11).
30. **The day boundary, with the page open** (A-14, C-10): using the injected clock (§11 row
    28), advance past local midnight without reloading. Within one tick: `boardScope` is
    `working`; `settings.board.recent.date` equals the new date and its `ids` are recomposed;
    **`settings.board.front` is byte-identical**; a timer that was `filed` renders `idle`; and
    a timer that ran through midnight renders `data-state="overnight"` **on screen with no
    manual reload**.
31. Scope persists across a reload and resets to `working` on a reload after a simulated new
    day.
32. **The settings mirror** (C-6): with `GET /api/settings` stubbed to hang, the board still
    paints its front row from `localStorage['tk:board']` on first paint, and **no tile moves**
    when the request later fails. With the same stub on a database that has no stored
    `board.front`, **the first-run seed does NOT fire** and the front row renders from the
    mirror or not at all — it never silently rearranges (§2.9 rule 4).
33. A `PATCH /api/settings` that 400s leaves the tiles in place and raises
    `Couldn't save your front row — it's still set on this device.`

### Scale-down, filtering, and long names (C-8, C-11, C-16)

34. **A board of 4 timers does not band** (C-8): `.band-front`, `.band-recent`, `.band-label`
    and `.board-more` are all **absent**; one `.timer-grid` holds all four; digits 1–4 start
    them; `Group` produces `.group-head` sections over the whole board. Repeat at 0 timers
    (the board blankslate) and at 9.
35. **Filtered to zero and to few** (C-11): with a query matching nothing and offering no
    matter, `.timer-board .blankslate` replaces the grid and `.board-foot` shows only
    `＋ New timer`; `.band-front` and `.band-recent` are absent; a digit key is a **no-op**
    (no toast, no focus change, no request).
36. **A 60-character unbroken token** (C-16): rename a tile inline to
    `Aaaaaaaaaabbbbbbbbbbccccccccccddddddddddeeeeeeeeeeffffffffff` at 412px and assert
    `document.documentElement.scrollWidth === 412` at Compact, Comfortable and in the front
    row. `.name-input` refuses input past `maxlength="80"`, and the API clamps at 80.

### Finding the right button without reading (B-2, A-1, A-3, A-4, C-15, D-3, D-M10)

37. **The front row is visually distinguishable from `Recent` with the page rendered in
    greyscale**: `frontHeight / ordinaryHeight ≥ 1.5` **at 1440×900 (56/36 = 1.56) and at
    412px (72/44 = 1.64)**, and the front row is always the first element in `.board-bands`.
    Screenshot evidence, both themes. *(Both halves must pass; revision 2's numbers gave 1.47
    and 1.27 — D-3.)*
38. Every tile in positions 1–9 renders a `.tile-key` with the digit matching its `data-pos`,
    at ≥768px.
39. **`Recent` is append-only within a day** (A-4): at the seed, note the `data-timer-id` at
    positions 4–9; start a tail timer; **positions 4–9 are unchanged** and the new timer
    appends at 10 (or takes the first free slot past the existing members). Repeat after a
    reload. Then advance the clock a day and assert the band **does** recompose.
40. **Pressing `4` starts the 4th tile's timer** — driven, asserted by `data-state="running"`
    on that tile and by the run bar naming it. Pressing the digit of the already-running tile
    focuses it and **does not stop it**. Pressing `4` while a `.work-row` has focus starts
    **board tile 4** (A-15).
41. Digit keys are suppressed while a stop offer is mounted, while an overlay or the stepper
    is open, and while the caret is in any field — driven, all four. **And while
    `.stop-chips-inner` exists, no `.tile-key` is visible** (D-M10).
42. **`tk:lastTimer` is written by every start and stop path** (C-15): after a digit-key
    start, after `⏎` on a lone filter match, after the filter's new-timer row, and after
    `Stop at…`, pressing `t` toggles **that** timer. Driven, all four.
43. **★ THE RESOLUTION LINE IS ALWAYS PRINTED** (A-3): with 1 match it reads
    `⏎ starts: <name>`; with ≥2 it reads `<n> match — keep typing`; with 0 and a matter
    offered it reads `⏎ starts a new timer — <client> · <matter>`; with 0 and nothing offered
    it reads `no match — ⏎ does nothing`. Asserted on `textContent`, `aria-live="polite"`,
    at both viewports. **On ≥2 matches, `Enter` moves focus and starts nothing — and the line
    said so before he pressed it.** *(Fails on any silent Enter — A-3.)*
44. **`/` then a query matching exactly one timer at this seed, then `Enter`, leaves that
    timer RUNNING**, the query cleared, focus on its tile, and a toast with `Undo`. **A
    dormant tail timer (one of the 75) matches the filter in working scope without pressing
    `All timers`.**
45. **The filter searches matters as well as timers** (A-1): a query naming one of §1.4's six
    matter-only records returns **zero `.timer-tile` and one `.match-new-timer`**, whose text
    contains the client name, the matter short name and the matter number.
46. **★ THE ONE-ACTION CREATE-AND-START** (A-1): pressing that row (or `⏎`) leaves, in one
    interaction, a **new timer that exists, is running, and is on that matter** —
    `POST /api/timers` then `POST /api/timers/:id/start`, asserted by reading the API. The
    toast carries `Undo`, and `Undo` stops it inside the misclick grace and deletes it,
    leaving **no entry behind**. *(This criterion failing is the attorney's BLOCKER
    reopening.)*
47. Integrity on that path: the created timer's `cm_id` equals the matter named in the row and
    no other; its `narrative_template`, `draft_narrative` and `suggested_narrative` are all
    empty; and when the start call fails, the timer survives, the toast reads
    `Created — <name>. Not started.`, and no entry exists.
48. **A double press does nothing twice** (C-7): with the network throttled to 2s latency,
    press a tile's transport twice. Exactly **one** `POST /api/timers/:id/start` is issued,
    the tile carries `data-pending` between press and reload, and its transport is `disabled`
    (asserted on the property, not on `opacity`).

### Order and arrangement (B-3)

49. With no stored preference, `Board setup → Order` shows **`Manual`** selected, and Band C's
    tile order equals `sort_order` ascending.
50. **There is no `A–Z` control on the board face.** `.timer-board .board-foot`,
    `.timer-board .today-head` and the control band contain no element whose text matches
    `/A[–-]Z/`. The capability is present as `Sort A–Z…` inside `Board setup`.
51. `Sort A–Z…` raises a toast with `Undo`; pressing `Undo` restores the exact pre-sort
    `data-timer-id` sequence, verified across a reload. *(New work — `sortAZ` has no undo
    today, D-M7.)*
52. **`Board setup` contains no daily action.** Its item list contains no `Log time already
    spent…` and no `Start`; every item is configuration (A-21).

### The repair — data, evidence, and every door (B-4, C-1, C-2, A-5, A-6, A-7, A-8, D-8)

53. **★ `rollover_from` EXISTS AND IS CORRECT** (C-1). With a fixture where a timer ran from
    6pm through midnight: `GET /api/timers` returns, for that timer, a non-null
    `rollover_from` carrying `entry_id`, `date` (yesterday), `hours` (the banked figure),
    `cm_id`, `cm_short_name`, `cm_number`, `client_name`, `status`, `exported_at` and
    `last_activity_at`. For a paused timer that merely crossed midnight with a zero clock it
    is **null**. *(Fails on any implementation that infers the state from
    `last_started_at === midnight` — the whole of §4.8 depends on this field existing.)*
54. `rollover_from` is **cleared to null** by a plain `stop`, by a successful `stop-at`, by
    `fresh`, by a matter re-point, and by the next day's rollover with no overnight run.
    Driven, all five. A repair state that outlives its repair is a lie on the tile face.
55. Migration v19 appends `rollover_entry_id`, `rollover_last_activity_at` and `archived_at`
    to `timers` and **mutates no existing migration**: `test/migrations.test.js` asserts the
    old `MIGRATIONS` entries are byte-identical to the previous commit's, and that an old
    database at `user_version` 18 upgrades without data loss.
56. **The tile face carries the literal text** `ran overnight` and the hours, at 1440×900
    **and at 412px**, at Compact **and** Comfortable, in light **and** dark. Asserted on
    `textContent`, not on `title`. `document.querySelectorAll('[title*="overnight"]').length`
    is irrelevant to the pass.
57. **The evidence is on the face and the primary is ONE TAP** (A-7): when
    `last_activity_at` is present, the face reads `ran overnight · 15h — last activity
    6:12 pm` and the tile's primary button is labelled `Stop at 6:12 pm`. When
    `last_activity_at` is null, that button is **absent** and only `Stop at…` renders — **the
    app never invents an evidence timestamp**.
58. **The interaction count is honest** (A-8): from the tile to the repaired state is **1**
    interaction via the evidence primary and **2** via `Stop at…` → an option. Driven and
    counted. The pre-revision path was 5–6 across two pages. *(Fails if the spec's prose and
    its criterion disagree, which is what this criterion exists to prevent.)*
59. **The preview shows both days AND both matters** (C-2, D-8): opening `Stop at…` fires
    `POST /stop-at` with `dry_run: true` per option and each row prints
    `<hours> · <matter short name>` for **yesterday and today**. **No second endpoint
    exists** — `grep -n "stop-at/preview\|GET.*stop-at" server/` returns nothing.
60. The menu's fabricated option is labelled **`Typical stop — <time>`** and equals the median
    stop time across the last 30 days. `grep -n "18:00\|6:00 pm" public/js/` finds no
    hardcoded default (A-7).
61. **Choosing an option performs ONE transaction**: yesterday's banked entry moves to the
    chosen figure, today's rollover entry is removed, the timer stops and its clock is zero —
    all four asserted by reading the database, and a mid-operation failure leaves **neither**
    changed.
62. The toast carries **one `Undo`**, and pressing it restores **both** rows exactly, verified
    by reading the database.
63. **★ THE MATTER FENCE** (C-2): with a fixture where yesterday's banked entry is on matter A
    and today's rollover entry on matter B, `POST /stop-at` returns **409**, **writes
    nothing** (asserted by comparing both entries before and after), and its message contains
    **both matter names**. The tile shows the same sentence in place of the primary.
    *(Standing rule 1. Revision 2 asserted "it never crosses a matter boundary" with nothing
    enforcing it, on a path the design itself creates.)*
64. `last_activity_at` is derived **only** from writes on this timer's own `cm_id`: with a
    fixture where another client's entry was touched later on the same day, the offered time
    is the timer's own, not the other matter's (C-2).
65. `POST /stop-at` is **idempotent on `(timer_id, at)`**: a repeat within the same minute
    returns the same `undo_token` and `changed[]` and writes nothing (C-7).
66. Integrity across the repair and its undo: `Σ hours` over both days changes by exactly the
    intended delta and by nothing else; every stored figure is a multiple of 0.1; a finalized
    or exported entry is never modified (and its options render disabled with the reason); the
    rollover entry is not deleted when it carries a narrative or a second task line.
67. **★ EVERY STOP SURFACE ROUTES THROUGH THE REPAIR** (A-5). With an overnight timer running,
    driven one at a time: the run bar's stop, the tile's stop, the tile menu's stop, the entry
    row's stop, `Enter` on the focused tile, and `t`. **All six open the repair and none of
    them banks the hours.** *(The run bar is the fattest, most reflexive stop button on his
    phone; revision 2 closed the front door and left this open.)*
68. **`running-long` gets the same treatment as `overnight`** (A-6): with a timer running
    longer than `settings.idleNudgeHours`, the words `running Nh — last activity <time>` are
    on the **tile face** (not in the expanded body, not in a `title`), and the repair is the
    **primary** (not an item in `⋯`). Asserted on `textContent` at both viewports.
69. **The attention band reads `N ran overnight`** and is tappable, scrolling to and focusing
    that tile. Its data comes from `server/routes/dashboard.js`'s `alerts` (C-14).

### The retroactive path and minutes (B-5, A-9, A-12)

70. The page primary is a two-part control with **two visible text labels**, `Start` and
    `Log time…`, both `<button>`, both ≥44px tall on touch. Exactly **one** filled
    saturated-accent surface exists on the page.
71. Every tile menu's **first** item is `Log time already spent…`; choosing it opens
    QuickCapture with that timer's matter **already selected** — asserted by the sheet title
    naming the matter and by the matter slot being filled without typing.
72. From a cold board, logging 0.7h to a matter takes **≤4 interactions** end to end.
73. A pre-scoped capture writes to that matter and no other: the created entry's `cm_id`
    equals the scope's, it carries no narrative from the timer's template or stash, and the
    timer's clock is unchanged.
74. **★ THE APP SPEAKS MINUTES** (A-9). Driven in the QuickCapture hours field, the tile's
    `.figure-edit`, the entry row's hours figure and the stepper's hours field — **all four**:
    typing `40m`, `:40` and `40` each stores **0.7**, and typing `0.7` stores 0.7. The echo
    line beneath the field states the reading taken (`0.7h — 40 min, rounded up from 0.67`
    / `0.7h — read as 40 minutes`). Typing `2` stores **2.0 hours**; the boundary is 6.
    *(Fails if any one field is decimal-only.)*
75. `test/hours.test.js` covers every row of §6.4's table in both directions, and
    `server/lib/quickcapture.js`'s `parseDuration` and `lib/hours.js` return the same answer
    for the same string. `grep -rn "parseHoursInput" public/js/ server/` shows **one
    definition**.
76. The hour pills are labelled in both units (`0.5 · 30m`, `1.0 · 1h`, …).
77. The post-file toast carries **two** actions: `Undo` and `Start the clock on this matter`,
    the second of which starts a timer on that matter (A-12).

### The matter-change dialog — the owner's decision (C-3)

78. **★ IT EXISTS.** Saving `TimerModal` with a changed `cm_id`, where the linked draft holds
    hours > 0 **or** a narrative that is not the timer's own seeded text, opens a `Confirm` on
    the shared overlay naming **both matters** and showing the entry's hours. With an
    untouched draft, **nothing is asked** and the save proceeds. *(`STATUS.md:301-308` routed
    this dialog to this build; revision 2 shipped the half he did not choose.)*
79. `Leave the time on <old>` PATCHes **without** `move_entry` and the entry stays on the old
    matter with its hours and sentence intact. `Move it to <new> too` PATCHes with
    `move_entry: true` and the server's own fences apply. `Cancel` writes nothing and leaves
    the modal open.
80. **SILENCE LEAVES THE TIME BEHIND.** `Esc`, the backdrop, `⏎` on the focused default and
    the browser back gesture all resolve to *leave*. `grep -n "move_entry" public/js/` shows
    it sent from **exactly one** call site — the second button's handler. It is never sent
    implicitly, never remembered, never a setting.

### Close-out (A-2, A-16, C-19)

81. **★ THE STEPPER EXISTS AND ADVANCES.** Clicking the attention band's `2 need a narrative`
    opens an overlay reading `1 of 2`, naming the matter, its number, its client and its
    hours, with the narrative box **pre-filled and selected**. `⏎` saves and advances to
    `2 of 2`; a second `⏎` saves and closes. **Two Enters closed the day.** Driven end to end
    at the seed. *(Fails on revision 2's behaviour, which focused one row and stopped —
    ≈12 actions and two visual hunts.)*
82. `Tab` skips without writing; `Esc`, `✕` and the backdrop close while keeping every
    acceptance already made; **nothing is written when the stepper merely opens**.
83. The queue is computed once on open and does not re-order under him; a finalized or
    exported entry never enters it; the counter is literal.
84. The pre-fill is composed for **this entry's matter**: with a fixture where a sibling
    matter carries a busy narrative, that sentence never appears. Text the app composed and he
    has not edited is stamped `narrative_suggested`; text he edits is not.
85. The stepper adds **no endpoint**: `grep -n "api/" public/js/components/closeoutstepper.js`
    shows only `PATCH /api/entries/:id`.
86. On the phone the overlay is full-screen with three ≥44px buttons and no keyboard-hint
    line.
87. **★ `unfiled` IS THE RIGHT NUMBER** (A-16, §5.3). At the seed the board meta reads
    **`0.7h unfiled`** (the running timer's un-synced elapsed), **not `9.25h`**: the quantity
    is `Σ max(0, clockHours − filedHours(linked entry))` over **all 84 timers**, asserted by
    computing it from the API and comparing to the rendered string. With a fixture where a
    hidden tail timer holds 1.2h unfiled, the number includes it. *(Revision 2 defined this as
    the sum of the clocks and called it "disjoint by construction"; measured, 8.83h of the
    9.25h was already on entries — the board would have told him he had nine unbilled hours he
    did not have.)*
88. The attention band renders `0.7h isn't filed yet` **as a button**, and it opens the
    stepper with the unfiled clocks queued first (A-16).
89. Close-out **blocks on a timer in repair state**, names it and its hours, and offers the
    repair inline; and it prints the board's `unfiled` total before finalizing anything
    (C-19). Export does **not** block on it.

### stopchips mount and the displacing start (B-7, C-9, D-4, D-20)

90. After stopping a timer **from its tile**, `document.querySelector('.stop-chips-inline')`
    exists and `.closest('.timer-tile').dataset.timerId` equals the stopped timer's id.
91. **`document.querySelector('.entry-panel .stop-chips-inline')` is `null`** in that case.
    This criterion fails if the offer relocates into the entries panel — the exact silent
    regression B-7 identified.
92. The offering tile spans the full grid row (`grid-column: 1 / -1`), its neighbours' tops
    are unchanged, and the page's `scrollY` moves by **≤8px** as the offer mounts.
93. The offer's `1` / `2` / `3` / `e` keys work while focus is inside the tile — the hot-key
    scope resolves through `.timer-tile` as well as `.work-row`.
94. **★ THE DISPLACING START** (C-9): with timer X running, start timer Y by digit key. The
    offer mounts on **X's own tile**, X's tile is forced visible in its own band, the board
    scrolls to it, and the offer's heading names **X's matter**. Repeat via `⏎` on a lone
    filter match **after `Esc` has restored a scope that excludes X** — the offer still mounts
    on X's tile.
95. **Undo semantics are honest** (D-20): a start that displaced nothing toasts with `Undo`,
    and `Undo` stops it inside the misclick grace leaving no entry. A start that **displaced**
    a running timer toasts `Started — <new>. <old> stopped and filed <n>h.` with
    **`Open <old>'s entry`** and **no `Undo` button**. Asserted by querying the toast's
    actions. *(A half-working Undo across a two-timer state change is an hour-losing shape;
    the document does not promise one.)*

### ARIA, keyboard and seams (B-10, B-11, B-12, B-13, D-7, D-10, D-16, A-25)

96. **`document.querySelectorAll('[role="grid"]').length === 0`** on `#/`. No element with
    `role="button"` contains a `<button>` descendant. `.timer-grid` is `role="list"`; every
    `.timer-tile` is `role="listitem"`; no `aria-pressed` on any tile or grid container.
97. **Every `<button>` inside every rendered tile has a non-empty computed accessible name
    AND a non-empty `title`** — asserted for all four (name, clock, transport, overflow)
    across all 9 default tiles, and the `title` values include `Start`,
    `Stop & file time` and `Row menu` so the eight existing e2e click sites resolve (D-7).
98. **`.sr-only` is defined and invisible** (D-10): `getComputedStyle` of a tile's `.sr-only`
    span reports a clipped 1×1 box, and removing the rule from `base.css` makes criteria 12,
    15, 22 and 23 fail. Its text carries name + matter + client + number.
99. **`document.querySelector('.timer-grid .timer-new')` is `null`.** Exactly one element
    **inside `.timer-grid`** has `tabindex="0"`; every other tile and every inner control is
    `tabindex="-1"`. `Tab` from the control row lands on a **tile**, not on its Start button;
    the next `Tab` leaves the whole board and lands on `.board-foot`'s first button.
100. **Grouped arrows, partial last row:** in `Group` + `all` scope at 3 columns, focus the
     last tile of a section whose tile count is not divisible by 3, press `ArrowDown` — focus
     lands on the **same-column tile of the next section's first row**, never on a tile in the
     same visual row. Repeat upward.
101. `colsOf` returns **1** for a grid that is `display:none` or detached, and the real track
     count otherwise. It never returns 3 from an unresolved `repeat(...)` string.
102. `ArrowDown` off the last grid moves focus into the entries list; `ArrowUp` on the first
     entry row returns to the board's last tile. On a focused tile, each of these drives:
     `Enter`, `Space`, `x`, `f`, `l`, `Shift+Enter`, `Ctrl+Enter`, `Alt+↑`, `Alt+↓`.
     **`Shift+Alt+↑/↓` is NOT bound** — `grep -n "shiftKey && e.altKey" public/js/` returns
     nothing (A-25).
103. **Expansion has a touch path** (D-16): tapping `⋯ → Show details` expands the tile at
     412px with no keyboard, and tapping the front row's line 2 expands it. The tile has no
     `.work-expand`.
104. **`grep -n 'dragId' public/js/components/timergrid.js` returns nothing.** Drag and drop
     still works: dragging a tile onto another band, onto a group section and onto the front
     row all persist across reload.
105. The dashboard's "N need a narrative" link drives end to end at 84 timers, and a
     single-row focus request still focuses the right `.entry-panel .work-row`, expands it,
     opens its narrative editor and **on the phone lifts the 6-row cap**.
106. Creating a timer that lands outside the working set reveals it: the filter clears, scope
     flips to `all`, the tile is scrolled into view and focused.
107. `TodayEntries` never requests `/api/timers`. **Observable as written** (D-19): count
     requests for 30s with one running timer and the tab visible — exactly one `/api/timers`
     per 5s window; then hide the tab for 15s and assert **zero** (C-19). The long-run
     notification guard is proved by a **unit test** on the effect's dependency list, not by
     watching for a `Notification` that fires at 2h.

### Retiring a timer (C-12)

108. **★ `Archive timer` EXISTS.** From the tile menu, archiving a timer removes it from every
     band and from the digit map, leaves the meta reading `84 timers · 1 archived`, and
     **touches no entry** — asserted by comparing every entry row before and after. Archiving
     a running timer is refused with `Stop it first.`
109. An archived timer is **still found by the filter**, rendered with the word `archived` and
     a `Restore` control; `Board setup → Show archived timers` reveals a collapsed `Archived`
     section; restoring is one tap from either surface and returns it to its old position.
     *(84 becomes 120 next year; without this the wall arrives on schedule, and `Delete` is a
     frightening verb for a button that produced billed hours.)*

### Integrity, tests, plumbing (B-6, B-8, B-9, D-11, D-18)

110. **`npm test` — 944 tests, 944 pass, 0 fail.** Measured on this box on **2026-08-16** at
     commit **`185beff`** (`ui-overhaul-2026-08`), `duration_ms 45748`. **The pass count only
     ever goes up.** A run reporting fewer tests, or any failure, is a fail. *(Revision 2 said
     934, which is ten below the real floor — a gate that would have let a build delete ten
     tests and pass the criterion that exists to prevent exactly that. B-6 was raised for
     stating a false gate; this is the third statement of it and it is measured, not
     remembered.)*
111. `node scripts/e2e-smoke.mjs` green. **Every one of the twenty-eight rows in §11 is
     accounted for in the diff**: each is migrated to a named new target covering the same
     capability, retired with its replacement present and passing, or shown by §2.10 to be
     unaffected — and for the "unaffected" rows the diff shows they were **run**, not assumed.
112. No assertion is deleted without a replacement named in §11.
113. The retirement's replacement (row 15): with a matter billed twice today,
     `.entry-panel .work-row` contains **two** rows with distinct `data-entry-id`, each with
     its own hours figure, narrative editor and `⋯` menu, and neither is hidden by the phone
     cap.
114. `test/boardselect.test.js`, `test/boardstate.test.js` and `test/hours.test.js` exist and
     cover, **at 84 timers where applicable**: the working-set composition rule (front row +
     today-uncapped + 14/30/90 backfill, deduped); the **prefix property** (phone 6 ⊂ desktop
     9 ⊂ all 84); append-only Recent across a simulated day; `verticalTarget` across grids
     with partial last rows; `digitTarget` at front rows of 1, 2 and 3 and past the rendered
     count; `colsOf`'s guard; the settings mirror's seed-only-on-success rule; and every row
     of §6.4's table.
115. **Line ceilings** (D-9, D-18): `timergrid.js` ≤800 and contains no tile or entry-row
     markup; `timerboard.js` ≤520; `timertile.js` ≤340; `todayentries.js` ≤400;
     `closeoutstepper.js` ≤200; `timermodals.js` ≤280; `lib/boardselect.js` ≤220;
     `lib/boardmenu.js` ≤160; `lib/boardstate.js` ≤160; `lib/hours.js` ≤90.
     `timerboard.js`, `timertile.js` and `todayentries.js` are the only files that render
     rows.
116. Every stored/billed/exported figure written from the board, the entries list, the repair,
     the stepper or a pre-scoped capture is quantised to 0.1h. A `0.75` cannot be produced by
     a nudge, an inline edit, a `Stop at…`, a minutes entry or a QuickCapture.
117. Board meta and entries meta are disjoint quantities under §5.3's corrected definition,
     and with a split-entry fixture no figure appears in one section that appears nowhere in
     the other.
118. No hardcoded colour, size or spacing outside `tokens.css`.
     `grep -nE '#[0-9a-fA-F]{3,8}|rgba?\(' public/css/timers.css` returns nothing new.
119. Both themes photographed at both viewports; every new state (front row, band label,
     overnight, running-long, archived, pending, offering, key cap, disclosure, match row,
     resolution line, nudge) legible in both; every colour state paired with a second channel.
120. The comment at `timergrid.js:19-42` is replaced with §10.2's text **and its citations
     resolve**: `STATUS.md:322-324` contains the owner's quote and `STATUS.md:348-370` the
     tenths rule — checked by opening the file, not by trusting this document (D-11). The
     comment says **EIGHTY-FOUR**. **No file in the repo still argues for the merge** —
     `grep -rn "highest-value" docs/ public/js/` finds nothing that recommends merging.
121. `public/sw.js` and `public/index.html` are unmodified in the builder's diff; the handoff
     names the **nine** new module paths and requests the `CACHE` bump.
122. No real client, matter, firm or personal data in code, shots or commit messages. The
     six matters added by §1.4 are fictional and on existing fictional clients.

### Finding → criterion map

**Every BLOCKER and MAJOR in `TIMERBOARD-CRITIQUES.md` has at least one criterion that fails
if it is not implemented.**

| Finding | Criteria |
|---|---|
| A-1 filter is timer-only (BLOCKER) | **45, 46, 47**, 43, 44 |
| A-2 no close-out flow (BLOCKER) | **81, 82**, 83, 84, 85, 86 |
| A-3 Enter fails silently (MAJOR) | **43** |
| A-4 digits 4–9 not muscle memory (MAJOR) | **39** |
| A-5 run bar bypasses the repair (MAJOR) | **67** |
| A-6 same-day forget in a tooltip (MAJOR) | **68** |
| A-7 hardcoded 6:00 pm (MAJOR) | **57, 60** |
| A-8 "one action" vs "≤3" (MINOR) | 58 |
| A-9 forty minutes → 0.7 (MAJOR) | **74**, 75, 76 |
| A-10 front row seeded from an accident (MAJOR) | **7, 27**, 28 |
| A-11 empty `Recent` band (MINOR) | 29 |
| A-12 front-row cap of 6 (BLOCKER) | **5**, 2 |
| A-13 phone band unspecified (MAJOR) | **20**, 19 |
| A-14 "a new day" undefined (MAJOR) | **30**, 31 |
| A-15 digit precedence in the entries list (MINOR) | 40 |
| A-16 `unfiled` styled as trivia (MAJOR) | **87, 88** |
| A-17 cut the rtl trick | 36 (what replaced it), §13.2 non-goal 15 |
| A-18 duplicated 📌 | 9 |
| A-20 self-rewriting disclosure label | 4 |
| A-21 menu is a preferences panel | 52, 71 |
| A-25 `Shift+Alt` cut | 102 |
| C-1 no data source for the repair (BLOCKER) | **53, 54, 55**, 57, 59 |
| C-2 `stop-at` has no matter check (BLOCKER) | **63, 64**, 59 |
| C-3 "ask me each time" dialog absent (BLOCKER) | **78, 79, 80** |
| C-4 front row 6 vs 3 | 5 |
| C-5 more than six worked today | 114 (uncapped rule), 2 |
| C-6 `settings.board` read failure | **32**, 33 |
| C-7 double press / idempotency | **48**, 65 |
| C-8 board below nine timers | **34** |
| C-9 displacing start | **94**, 95 |
| C-10 midnight with the page open | **30** |
| C-11 board filtered to zero | **35** |
| C-12 no way to retire a timer | **108, 109** |
| C-13 pin vs front row | 9 |
| C-14 attention band has no owner | 69 |
| C-15 `tk:lastTimer` | 42 |
| C-16 unbroken 60-char token | 36 |
| C-17 test gate | 110 |
| C-18 small capability drops | §7.1 11a, §7.5 89a, 45 |
| C-19 close-out / poll / reduced motion | 89, 107 |
| D-1 criterion 3 false at the seed | **6** |
| D-2 front-row size contradiction | **5** |
| D-3 greyscale unreachable | **37** |
| D-4 `e2e:381` breaks | **111** (§11 row 1), 90 |
| D-5, D-6 `Only` / `.group-head` at working scope | **34**, §11 rows 9–13 |
| D-7 `title` deleted from tile buttons | **97** |
| D-8 preview not implementable | **59** |
| D-9, D-18 line ceilings | **115** |
| D-10 `.sr-only` does not exist | **98** |
| D-11 wrong `STATUS.md` citations | **120** |
| D-12 `≤48 controls` uncountable | **17, 18** |
| D-13 no harness for the day rollover | **30** (§11 row 28) |
| D-14 run bar is at the top | **13** |
| D-15 narrative search dropped | 44 (§7.1 row 4) |
| D-16 no touch path for expansion | **103** |
| D-19 criterion 61 unobservable | **107** |
| D-20 Undo has no mechanism | **95** |
| D-21 `Show` vs the bands | **8** |
| B-1 … B-13 (revision 2) | see §0.1; 2–5, 11–18, 37–41, 49–51, 56–62, 70–73, 90–93, 96–107, 110–115 |

---

## 13. RISKS AND NON-GOALS

### 13.1 Risks — each with the mitigation this spec mandates

| # | Risk | Mitigation |
|---|---|---|
| R1 | **Two fetch clocks.** `liveElapsed` is `elapsed_seconds + (Date.now() - fetchedAt)`. Two components fetching independently make the board and the entries disagree by up to 5s | **One `fetchedAt`, owned by the coordinator**, passed down. `TodayEntries` never fetches `/api/timers` (criterion 107). |
| R2 | **Refresh fan-out.** `reload()` refreshes timers; `onEntryChanged()` refreshes entries; nearly every action needs both | **The coordinator owns "refresh both."** Every mutation lives there. A section never calls an API directly. |
| R3 | **The stop offer crosses the seam** and, after the split, silently relocates (B-7) | Mount `StopChips` once, in the coordinator; resolve the tile first (§10.7); criterion 91 fails if it lands in the entries panel. Keep wave-1 behaviour exactly, **including the unasked pre-fill** (`fence.suggestionmatter.test.js:277`). |
| R4 | **One `menu` state served three things** | Two menu states, two item builders (now pure, in `lib/boardmenu.js`), each titled so it announces its object. Still one `Menu` component. |
| R5 | **`tk:focus-entry` resolved a row through the timers table** | Collapses to `e<id>`, and crosses the seam as a stamped `entryFocus` prop (§10.8 seam 2). Criterion 105 drives it at 84 timers with the phone cap on. |
| R6 | **Density is global.** Both containers must keep their density class | Board: `timer-grid density-*`. Entries: **`work-rows density-*`** (load-bearing for `timers.css:315, 343-383`). |
| R7 | **Duplicated poll and duplicated notifications** | Poll and `longRunMarks` stay single-owner in the coordinator; **guard the notification effect** on `[timers]`, proved by a unit test, not by a 30-second watch (criterion 107). |
| R8 | **`onSet` had two destinations** | Structural fork: `onClockSet` only on `TimerBoard`, `onSetHours` only on `TodayEntries`. `editKind` disappears. |
| R9 | **Two focus scopes fighting** | Scope every focus query to its own section. Roving invariant: the tile/row is the only tab stop. |
| R10 | **`reveal()` depends on filter state, scope AND the working set** | `reveal()` stays in the coordinator, which owns filter and scope, and forces `all` when the target is outside the working set (criterion 106). |
| R11 | **Two blank slates** | Board's offers `＋ New timer` and `Start`; entries' offers `＋ New entry` and `Log time…`. e2e line 182 migrates to the board's. |
| R12 | **Selector churn reads as breakage** | The tile carries **both** `.timer-tile` and `.timer-row`; **every tile button keeps its `title`** (D-7); `.today-list` survives as the wrapper; `.timer-section` and `.group-head` unchanged; and a board of ≤9 timers does not band, which is what keeps thirteen existing assertions green (§2.10). |
| R13 | **The hue budget.** A bank of tiles is the easiest place to blow it | One filled accent surface on the page, and it is the split primary (§6.1). Running is `--live`. Overnight and running-long are `--attention`, which the app already spends on the attention band. Archived is `--border`. Idle transport `--transport`. Figures `--figure`. **No new colour token (§9.2).** No green. |
| R14 | **Restoring controls costs the trim** | Paid for twice: A–Z came off the face, and the tile carries **two** painted buttons. Criteria 17 and 18 are the checks — **and they replace revision 2's uncountable `≤48`** (D-12). |
| R15 | **The working set hides the timer he wants** | Four defences: the meta always says `84 timers · 9 shown`; the filter always searches all 84 **and all 90 matters** (criteria 44, 45); the disclosure is fixed-text and labelled; and `unfiled` counts hidden timers (criterion 87). |
| R16 | **`settings.board` is a new settings key** and the route whitelists keys | One word added to `KEYS` (`settings.js:6`), covered by `test/api.settings.test.js`. |
| R17 | **`POST /stop-at` loses an hour.** Two entries on two dates in one operation | One transaction; quantise on write; never delete an entry holding anything else; never touch a finalized or exported entry; audited; one undo token restoring both rows; **idempotent**. Criteria 61, 62, 65, 66. |
| R18 | **The front row becomes stale** — he set it in August and it is wrong by November | It is his, and three ways to change it are all one action. The board never edits it silently — **and it now NOTICES**: the 30-day nudge (§2.7, criteria 27, 28). Refusing to edit is not the same as refusing to notice. |
| R19 ★ | **`settings.board` arrives late or not at all**, and three tiles move under a travelling thumb | The `localStorage` mirror renders first; reconcile only on success; **never seed on failure** (§2.9, criterion 32). |
| R20 ★ | **`rollover_from` is wrong or stale**, and the tile face states a falsehood about his time | Written inside the rollover transaction; cleared by five named events; and criterion 54 drives all five. A repair state that outlives its repair is worse than no repair state. |
| R21 ★ | **A timer can be re-pointed overnight**, so the repair spans two matters | The 409 fence (§4.8.3 rule 8), the matter beside every preview, and matter-scoped `last_activity` (criteria 63, 64). **This is the one genuinely new integrity surface in the document.** |
| R22 ★ | **The board grows without bound.** 84 → 120 next year | `Archive timer` (§4.10), reversible, entry-preserving, one migration column (criteria 108, 109). |
| R23 ★ | **The 5s poll over a tunnel to a phone.** 84 rows × 6 correlated subqueries every 5s | The poll **pauses while the tab is hidden**; the existing wake refetch covers the resume; no second fetch is added anywhere (criterion 107). |
| R24 ★ | **The filter's create-and-start makes a timer he did not want.** It is two non-atomic POSTs on a path designed to be pressed in six seconds | The row prints client, matter and number before he presses; the timer is created textually empty; `Undo` is on the toast and deletes it inside the misclick grace; a failed start leaves the timer and says so (criteria 46, 47). |
| R25 ★ | **The stepper writes something he did not read.** It pre-fills a sentence and `⏎` accepts it | Nothing is written on open; the box is pre-filled *and selected*, so his first keystroke replaces it; the matter fences and the `narrative_suggested` provenance stamp are the existing ones, unmodified (criteria 82, 84). |

### 13.2 Non-goals — what this change deliberately does NOT do

Each of these is out of scope **with a named stage**, not pretended away.

1. **Does not restore the baseline header.** No `📁 New group`, no `⤓ Import`, no `⏱ Quick`
   on the board, no six-button cluster. Trimming, not restoring.
2. **Does not restore the scope-chip tablist.** Activity filters stay in `Board setup…`
   (§4.4).
3. **Does not restore column-major multicolumn flow.** Row-major grid, deliberately (§4.6).
4. **Does not fold, repurpose or remove the `/` timer filter.** Void instruction
   (`BRIEF.md:273-276`).
5. **Does not re-merge the lists**, now or later, for any reason short of a new owner
   instruction. The teardown's merge argument is dead (§1.6).
6. **Changes the backend in exactly THREE named places** — `POST /api/timers/:id/stop-at`
   (§4.8.3), one word added to the settings whitelist (§10.9), and **rollover/archive
   provenance: migration v19's three nullable columns, the `rollover_from` projection and one
   `alerts` bucket** (§4.8.1). *This amends revision 2's "exactly two": the completeness
   critic proved the repair cannot be built with two, because after `applyRollovers` nothing
   in the payload says a rollover happened.* No other schema change, no new runtime
   dependency, no bundler, no framework. Browser code stays plain ES modules under
   `public/js/`.
7. **Does not touch `.main { max-width: 1200 }`.** The 240px of unused width at 1440 is a real
   complaint but it is a shell change, out of scope, and 3 columns at 1136px is the owner's
   stated reference. **Stage 3** owns the shell.
8. **Does not tear out anything built for mobile.**
9. **Does not remove the run bar, QuickCapture, the stop-chip pre-fill, drag reorder,
   multi-select, or any menu item.** Demotion only, never deletion — including the two the
   attorney would cut, `By client` (§4.2) and batch (§7.5), each of which says why in place.
10. **Does not chase the suggestion-flow interaction targets** (23 → ≤13). **Stage 3.**
11. **Does not add a third fixed bar.**
12. **Does not attempt matter-number-on-every-compact-tile.** At 288px it starves a
    44-character name. Identity lives in `title`, the `.sr-only` line, the front row's second
    line and the comfortable/expanded line — and the dangerous case (no matter at all) is made
    loud instead (§4.7).
13. **Does not invent a learned or "smart" ordering.** The front row is his; `Recent` is a
    plain, explainable rule that is frozen for a day; everything else is manual order.
14. **Does not put an unlabelled or self-rewriting truncation control anywhere** (§9.7
    anti-pattern 14).
15. ★ **Does not ship the rtl-truncation trick.** Cut on the attorney's and the builder's
    findings together (A-17, D-17): it makes a tile look different depending on which other
    tiles happen to be on screen, it is O(n²) inside render, and it had no criterion. Not
    deferred — **abandoned**.
16. ★ **Does not connect the calendar to untimed time.** The attorney is right that the 40
    minutes already exist somewhere: *"the magic answer is not a three-tap form — it's the
    attention band saying `⚠ Untimed: Call — M. Reyes, 2:00–2:40 pm · Northgate? [Log 0.7h]`"*
    — **one tap, and he never opened a form.** That is genuinely better than §6, and it is
    genuinely not this stage: it needs calendar-event ingestion, a matter-inference rule with
    its own fences, a dismissal model, and a privacy decision about which calendars are read.
    **It is STAGE 4, named here so it reads as a decision rather than an oversight**, and §6's
    faster form is what this stage ships.
17. ★ **Does not add per-timer targets, budgets or utilisation.** **Stage 5.**
18. ★ **Does not add a second archive tier** (delete-after-N-days, auto-archive on matter
    close). `Archive` is manual and reversible; automatic pruning of a bank he built by hand
    is exactly the unexplainable motion §13.2 #13 forbids. **Stage 5**, if ever.
19. ★ **Does not make the entries list bounded on the desktop.** The day's record is what the
    desktop page is for; only the phone caps at six (§5.4).
20. ★ **Does not give the entries list its own digit map.** One meaning per key, page-wide
    (§8.3 rule 4).






