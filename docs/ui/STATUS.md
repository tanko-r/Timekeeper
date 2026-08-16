# Timekeeper overhaul — status board

**One file to update as work lands.** Every session: read it first, update it
last, commit it with the work. If it disagrees with reality, reality is right
and this file is stale — fix it.

Branch: `ui-overhaul-2026-08` · Last updated: 2026-08-16, session 2

---

## Right now

| | |
|---|---|
| Suites | 902 tests, 811 pass, 91 fail — **the failures are deliberate leak proofs**, not regressions. The 633 pre-audit tests all pass. |
| e2e | `node scripts/e2e-smoke.mjs` green — re-verified at the start of session 2 |
| Working tree | Clean. |
| Preview | Infrastructure ready, **not started** — blocked on Stage 1 |
| Next action | `PLAN.md` Stage 1d |

### Correction to session 1's handoff

Session 1 reported the fence as uncommitted. It was not. The usage limit hit
**after** the commit, so `e36d705` — whose message says only "docs" — in fact
carries all of 1a, all of 1b, and most of 1c. Session 2 verified this by
diffing that commit and by running both suites. The commit message is
misleading but the code is correct; the history is already pushed and is not
being rewritten to fix a message.

A per-file map of the 91 deliberate failures is the real work list. Regenerate
it any time with:

```bash
npm test > /tmp/tk.txt 2>&1
grep -oE "^test at (test/[^:]+):" /tmp/tk.txt | sed 's/test at //; s/:$//' | sort | uniq -c | sort -rn
```

---

## Stage tracker

Mark each item `todo` / `doing` / `done` with the commit that closed it.

### Stage 1 — Integrity (blocks everything)

| Item | State | Notes |
|---|---|---|
| 1a Land the written fence | done | `e36d705` (bundled into the docs commit) — `integrity.fence` 17/17 green |
| 1b Scope `matterSuggestions` | done | `e36d705` — the sibling-narrative UNION arm is gone; `source` labels are honest |
| 1c Scope both AI pools | mostly done | `e36d705` — `pickPairs` filters on `cmId`; `matterPeopleList` no longer blends siblings. Residue: `verify.matterctx.thinsibling:404` |
| 1d Pin timer write-backs to their matter | doing | 24 failing proofs: stash, template, ghost text, stop-chip provenance |
| 1e Time-loss family | todo | 6 confirmed defects |
| 1f Export correctness | todo | 8 confirmed defects |
| 1g Records and recovery | todo | 5 confirmed defects |
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
