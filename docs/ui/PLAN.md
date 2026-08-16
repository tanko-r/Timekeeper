# Timekeeper overhaul — plan for the next sessions

The order below is deliberate: correctness before appearance, and a preview in
the owner's hands as early as it is safe to give him one. Track progress in
`docs/ui/STATUS.md`, which is the single file to update as work lands.

Read before starting any stage: `docs/ui/BRIEF.md` (the contract, including
the three owner constraints), `docs/ui/INTEGRITY.md` (what is broken and why
it matters), and `docs/ui/teardown.md` (the design standard).

---

## Stage 1 — Integrity. Nothing else ships first.

The audit confirmed 33 defects, 8 of them critical, every one reachable in
ordinary use. `test/integrity.*.test.js` and `test/verify.*.test.js` contain
tests that fail on purpose to prove each one. A defect is fixed when its test
passes and stays in the suite.

**1a. Land the fence that is already written.** The working tree holds
uncommitted work from a session that ran out of usage: a `source_cm_id` on
`PATCH /api/entries/:id` that the server refuses when it does not match the
entry's current matter, plus client changes to send it.
`test/integrity.fence.test.js` passes 17/17. Review it, run both suites,
commit it on its own.

**1b. Scope the suggestion endpoint.** `matterSuggestions` in
`server/routes/matters.js` blends sibling matters' whole narratives when a
matter is thin. Share task-line *fragments* across siblings; never whole
narratives. This one function feeds close-out pre-fill, the stop chips, ghost
text, and the timer start stamp, so fixing it closes four confirmed leaks.

**1c. Scope both AI pools.** `pickPairs` in `server/lib/exemplars.js` and
`buildVoiceContext` in `server/routes/ai.js`. Same-matter becomes a filter,
not a sort key, topped up with synthetic examples where a matter is thin.
Highest stakes of any fix here: a model can reproduce an example almost
verbatim.

**1d. Pin every timer write-back to the matter it was generated for** — the
start stamp in `timers.js`, the AI refinement in `ai.js`, and the draft stash.

**1e. The time-loss family.** Timer re-point re-billing the morning; a date
move leaving hours on the clock; close-out finalizing a running timer at a
stale total and zeroing the clock; `start-for-entry` discarding another
entry's unfiled seconds; zero-hour entries finalizing and exporting as `0.0`.

**1f. Export.** Stamp only on confirmed receipt; make the stamped set exactly
equal the exported set; give every entry a stable `.TIM` identity so a draft
cannot ship twice; remove the 1000-row blind spot; make screen, CSV and `.TIM`
totals agree.

**1g. Records and recovery.** Record and make recoverable every bulk matter
move; carry AI provenance through copy and quick capture.

After each of 1a–1g: run `npm test` and `node scripts/e2e-smoke.mjs` one at a
time, then commit and push. Small commits — a sixteen-agent wave was lost to a
usage limit earlier in this project, and small committed stages are what made
that survivable.

**Stage 1 exit test:** an adversarial verifier makes at least nine attack
attempts (matter change mid-run, thin-matter close-out, midnight rollover,
copy, duplicate, bulk operations, quick capture, two timers on one matter,
export interruption), reads the database after each, and cannot produce a
single cross-matter narrative, a single false provenance claim, or a single
lost hour.

---

## Stage 2 — The preview

Only after Stage 1 passes its exit test. Everything is prepared:

```
scripts/poc-sync.sh --seed          # worktree, service, restart
```

Then seed the demo day against `http://127.0.0.1:4748`, set an app password
from the LAN (Settings → Remote access), and send the owner
`https://poc-time.rigid-dreamy-sweep.us` with the password. DNS, tunnel
ingress and the systemd user service already exist. Alt+drag feedback from the
preview writes into the **main** repo's `feedback/` and `TODO.md`.

---

## Stage 3 — The stop-chip content spec

The owner's spec, not yet built: the chips offer the last couple of narratives
from **that matter**, plus one AI-generated narrative extrapolating the likely
next step from that matter's own prior narratives. Generic phrasing or nothing
where the matter has no history.

Open question to put to him: whether the extrapolation may draw on anything
beyond that matter's own narratives. Assumed no.

Also here: taking the suggestion at every stop currently costs 17 interactions
for a five-entry day against 12 for ignoring them. Either make it genuinely
cheaper or stop offering it where it changes nothing.

---

## Stage 4 — Wave 2b-3, the screens not yet rebuilt

Re-rank every outstanding critic finding under the desktop-first rule before
starting, so no effort goes into phone parity.

- **Ledger**: pagination or virtualisation (5,386 CSS px for 23 entries),
  export as a dialog rather than a page, delete the `All entries | Export`
  sub-navigation pair.
- **Calendar**: the month grid is 42 tab stops and must become one roving
  grid; tapping a day must bring its panel into view; collapse empty trailing
  weeks; fold the Statistics tab under the month grid with `#/stats`
  redirecting.
- **Settings**: the section name prints three times before the first control;
  one settings-row component across all sub-pages; theme switching made
  first-class.

## Stage 5 — Desktop craft and polish

- Entry editor: 12 controls on an existing entry against a target of 10.
- Desktop density pass: the owner asked for a denser timer list, and desktop
  density is a feature. Compact mode meets the four-rows target; Comfortable
  has a 2.07× height spread and needs a fixed narrative slot.
- Desktop fixed chrome is 97px against 49px before the overhaul.
- Motion, empty states, and the shortcut overlay audited against what the keys
  actually do.

## Stage 6 — Close out the project

- The standing critic reviews the whole app against `docs/ui/teardown.md` and
  appends a dated review.
- Refresh the progress page (`node scripts/progress.mjs`) and republish.
- Write the list of what to push further.

---

## Working rules that have earned their place

- **Commit after every stage, never at the end.** Two waves were lost to usage
  limits mid-flight; committed stages survived, uncommitted ones did not.
- **Screenshots and measurements, never a builder's summary.** Every critic in
  this project that judged from a summary missed something a critic that drove
  the DOM found.
- **A fresh critic per piece**, with no loyalty to the builder.
- **Agents must not edit `public/sw.js` or `public/index.html`.** The
  orchestrator owns those and bumps the cache version at wave boundaries.
- Run `npm test` and the e2e suite one at a time — four cores, and the e2e
  timeouts flake under load.
- Keep file scopes disjoint across parallel agents, or serialize them.
