# Data-integrity audit — entry mutation paths

Branch `ui-overhaul-2026-08`. Standard: `docs/ui/BRIEF.md` §"Data integrity",
which outranks everything else in this run.

> A **narrative** — the client-facing sentence describing work done on a
> specific matter — may never be shown as belonging to, suggested for,
> pre-filled into, or written onto an entry for a different matter. Not across
> clients, and not between two matters of the same client.
>
> No time and no narrative may ever be lost. No silent overwrite without an
> undo. No entry dropped, skipped, or double-counted.
>
> Shared **by design**, and not defects: the phrasebook of reusable wording,
> ghost text, and text expansions.

**Scope audited:** every server path that writes a narrative onto an entry or
could destroy one — `server/routes/entries.js` (`syncNarrative`, `writeTasks`,
`normalizeTasks`, `PATCH /:id`, `POST /:id/copy`, `POST /bulk`,
`finalizeOne`, `unlockOne`, `softDeleteEntry`, `restoreEntry`,
`syncTimersToEntry`, `rebuildMatterPeople`), `server/routes/timers.js`
(`syncToEntry`, `stopAndFile`, `doStart`, `PATCH /:id`, `/start-for-entry`,
`/fresh`, `PUT /:id/clock`, `applyRollovers`, `deleteIfUntouched`), and
`server/routes/quickcapture.js` + `server/lib/quickcapture.js`.

**Proving test: `test/integrity.entries.test.js`.** Eight tests, every one
written to FAIL against the tree as it stands. Each runs a real server on a
temp database (`test/helpers.js startTestServer`). Baseline: the pre-existing
suite is **633 pass / 0 fail**; this file adds 8 failures and nothing else.
Do not make them pass by weakening an assertion — the assertion is the spec.

---

## Verdict, in one paragraph

`quickcapture.js` is clean: it derives everything from the line the attorney
typed and never reads another matter's text. `POST /api/entries/:id/copy` is
clean on the matter question — it hard-codes `src.cm_id` and takes only a
date, so "copy to today" cannot move text between matters. The leaks are
elsewhere and they are two in number: **a timer's stashed draft narrative
survives a matter change and seeds the new matter's entry**, and **a sibling
matter's finished narrative is stamped onto a timer as its suggested
narrative at start**. The bigger problem in this audit area is the *loss*
side, and it is a real one: **changing an entry's matter or date leaves its
timer linked and its day clock loaded, so the next stop files the same hours
a second time.** That is a double-count of billable time, reachable from the
entry editor's matter picker and from the bulk "Reassign" bar, and it is the
exact failure `finalizeOne` already defends against and the other two paths
do not.

---

## The narrative-crossing findings

### L1 — CRITICAL. A sibling matter's narrative becomes another matter's suggested narrative
`server/routes/timers.js` `doStart()` → `matterSuggestions()`
(`server/routes/matters.js:42`)

`matterSuggestions` blends `SIBLING_PHRASES` whenever the matter's own history
is thin (`< 5` ranked phrases — so always, for a new matter). `SIBLING_PHRASES`
selects `e.narrative` — whole client-facing sentences — from **every other
matter of the same client**:

```sql
SELECT e.narrative AS text, e.date FROM entries e
JOIN matters m ON m.id = e.cm_id
WHERE m.client_id = ? AND m.id != ? AND e.deleted_at IS NULL AND …
```

`doStart` takes the top-ranked phrase and writes it into
`timers.suggested_narrative`, which is what the stop-timer chip offers first.
Against the spec — "the last couple of narratives used on THAT matter… if the
matter has no prior narratives, offer generic phrasing or offer nothing" —
this is a direct violation: a cold matter is offered a *sibling's* real
sentence, not generic phrasing.

This is **not** the shared phrasebook the brief protects. The brief's
phrasebook is reusable wording; `SIBLING_PHRASES` is a `SELECT` over finished
billing sentences carrying parties, documents and facts.

*Proof:* `LEAK L1` in `test/integrity.entries.test.js`. Fails with
`suggested_narrative = "Telephone conference with M. Alvarado regarding the
Fairview easement survey dispute"` on a Northgate timer.

*Independently found by two other auditors* — `integrity.suggestions.test.js`
and `integrity.closeout.test.js` prove the same root cause from the
suggestion-source and close-out angles. Three audits, one fix. **Fix at
`matterSuggestions`**: the sibling `UNION ALL` branch must select task
`fragment`s only, never `e.narrative`; or drop sibling borrowing entirely for
narrative-shaped text.

### L2 — HIGH. A timer's stashed draft narrative follows the timer to a new matter
`server/routes/timers.js` `PATCH /:id` (line ~329) and `syncToEntry()` (line ~78)

`PATCH /api/timers/:id` deliberately preserves `draft_narrative` across a
`cm_id` change:

```js
// user text — deliberately SURVIVES cmChanged; the next entry the
// timer creates is where the stash gets consumed
```

That is right for the case it was written for (a matterless quick timer that
later gets a matter). It is wrong for matter A → matter B, because
`syncToEntry` seeds **every** entry the timer subsequently creates with
`[narrative_template, draft_narrative].filter(Boolean).join(' ')`. Matter A's
typed sentence is therefore pre-filled onto matter B's entry. The adjacent
`suggested_narrative` is nulled on `cmChanged` for exactly this reason; the
stash is not.

`narrative_template` has the same lifetime and the same exposure. A template
is closer to reusable wording, but it is per-timer user text and can hold
matter facts; at minimum it should be re-confirmed on a matter change.

*Proof:* `LEAK L2`. Fails with an Acme sentence on a Verity entry. Also proven
by `integrity.suggestions.test.js` and `integrity.closeout.test.js`.

**Fix:** clear `draft_narrative` on a matter→matter change (keep it only when
the timer had no matter before), the same rule `suggested_narrative` already
follows.

### What is NOT a leak (checked, and deliberately not reported as one)

- **`POST /api/entries/:id/copy`** takes only `{date}` and inserts with
  `src.cm_id`. Copy-to-today cannot carry text across matters. Clean.
- **`POST /api/entries/bulk` `set_cm`** and **`PATCH /api/entries/:id`
  `cm_id`** move an entry, narrative and all, to a different matter. That is
  the attorney reclassifying his own misfiled time, not the app proposing
  another matter's sentence — it is intended. Its *consequences* are the
  problem, and they are findings L3, L6 and L8 below.
- **`server/lib/quickcapture.js`** builds its narrative stub purely from the
  typed line. `parseQuickCapture` reads matter *names* to match a matter; it
  never reads another matter's narrative.
- **`rebuildMatterPeople`** scans only `WHERE e.cm_id = ?`. Correctly scoped.
- **`GET /api/matters/:id/recent-narratives`** is scoped to
  `WHERE e.cm_id = ?`. Correctly scoped — this is what the chips *should* be
  built on.

---

## The loss findings

### L3 — CRITICAL. Changing an entry's matter or date lets the day clock be filed twice
`server/routes/entries.js` `PATCH /:id` and `POST /bulk` `set_cm`;
`server/routes/timers.js` `syncToEntry()`

The clock is a day accumulator, and `syncToEntry` only reuses the linked entry
when it still matches on **date and matter**:

```js
const valid = entry && !entry.deleted_at && entry.status === 'draft'
  && entry.date === dateStr && entry.cm_id === timer.cm_id;
```

`finalizeOne` understands the hazard and defends against it — it zeroes
`accumulated_seconds` and nulls `linked_entry_id`, with a comment naming the
"Acme duplicate, 2026-07-10" incident. **`PATCH /api/entries/:id` and bulk
`set_cm` do neither.** They change `cm_id` (or `date`) and walk away, leaving
a timer that is still linked and still holding the whole day on its clock. At
the next stop the entry fails the validity check, the timer relinks, and the
*entire* accumulated clock is filed into a brand-new entry while the moved
entry keeps its own `total_override`.

Measured: 1.5 h on the clock produces **2.5 h of entries** — 1.0 h on the
matter it was moved to, 1.5 h on a fresh entry for the timer's matter.

The `date` variant is identical (1.5 h clock → 1.5 h today + 1.0 h yesterday)
and is also proven in `integrity.closeout.test.js`.

The only warning is `relinked: true` in the stop response. Nothing stops it,
and nothing reconciles the duplicated hour.

*Proof:* `LOSS L3`.

**Fix:** whenever a write changes an entry's `cm_id` or `date`, apply the
`finalizeOne` treatment to every timer with `linked_entry_id = <entry>` —
unlink, and rebase or zero the clock. It is three lines and it belongs in a
shared helper next to `syncTimersToEntry`, called from `PATCH /:id` and from
bulk `set_cm`.

### L4 — HIGH. A second stop onto a split entry makes the narrative's allocations disagree with the billed hours
`server/routes/timers.js` `syncToEntry()` (lines 62–71) +
`server/routes/entries.js` `syncNarrative()`

`syncToEntry` mirrors the clock into a task line **only when the entry has
exactly one line** ("user-added splits are left alone") — but it still sets
`total_override` to the whole clock, and then calls `syncNarrative`, which
rebuilds the task-billed narrative from the now-stale line durations.

Sequence, all of it ordinary use:

1. stop at 1.0 h → entry `total_override = 1.0`, one line of 1.0
2. split it in the editor into 0.5 + 0.5 → narrative
   `"Review lease amendment (0.5); draft email to landlord (0.5)."`
3. same timer, another 0.5 h, stop → `total_override = 1.5`, lines untouched

The entry now **exports 1.5 h** while the sentence printed on the client's
bill accounts for **1.0 h**. Half an hour of work is invisible in the
narrative, and the line is internally contradictory for a task-billed client.

*Proof:* `LOSS L4`.

**Fix:** when `syncToEntry` raises a multi-line entry's total, put the delta
somewhere visible — append a new line for the increment, or scale/flag the
lines — rather than silently letting the total and the allocations diverge.
Failing that, refuse to move the total and surface a conflict.

### L6 — HIGH. A bulk matter reassignment has no audit row and no route back
`server/routes/entries.js` `POST /bulk` `set_cm` (line 274) +
`recordAudit` (line 583)

`recordAudit` returns immediately unless `beforeRow.ever_finalized`. A draft
entry — which is most of them — is reassigned with **no record of where it
came from**. The bulk bar in `public/js/views/search.js` offers Undo for
`delete` only; `set_cm` gets a toast that says "N reassigned" and nothing
else. One mis-click on "Reassign 40 entries" therefore takes forty matters'
narratives, drops them onto one matter, and there is no server-side record
from which to reconstruct the original assignment.

Two smaller defects sit in the same handler:

- it does not filter `deleted_at`, so **soft-deleted entries are reassigned
  too** (verified). Restore one later and its narrative surfaces on the wrong
  matter.
- it never touches `billable`, while the equivalent timer path adopts the new
  matter's flag.

*Proof:* `LOSS L6`.

**Fix:** record the `cm_id` change in `audit_log` for every entry, not only
ever-finalized ones (an entry's matter is the one field where "where did this
come from" is unanswerable without it), and give the bulk bar the same Undo
affordance `delete` has — it is a single reverse `set_cm` per original matter.

### L8 — MEDIUM. Bulk set_cm is the only matter-changing write that skips `syncNarrative`
`server/routes/entries.js` `POST /bulk` `set_cm`

`PATCH /:id` calls `syncNarrative` after a matter change, so an entry moved
onto a **block-billed** client loses its `(0.5)` per-line allocations, which
is that client's contracted format. Bulk `set_cm` does not call it. The entry
sits on the new client with the old client's billing format — and then some
unrelated later save silently reformats it, so the text on the bill depends on
whether the attorney happened to open the entry again.

*Proof:* `LOSS L8`.

**Fix:** call `syncNarrative(db, id)` inside the `set_cm` transaction.

### L5 — MEDIUM. `POST /:id/copy` launders AI provenance off a narrative
`server/routes/entries.js` `POST /:id/copy` (line 473)

The copy INSERT lists `narrative_manual` but not `narrative_ai`, `ai_brief` or
`ai_draft`. `server/routes/ai.js` keeps model output out of the voice pool
with `narrative_ai = 0`, precisely so "recency-weighted selection [does not]
feed the model's own output back as 'the attorney's voice' and compound the
verbosity this design removes". Copy an AI-written entry and the copy is
flagged as the attorney's own; finalize it and it enters the exemplar pool.
The feedback loop the flag exists to break is one keystroke away.

`ai_brief`/`ai_draft` are lost as well, so a later correction of the copy
yields no labelled (brief → corrected narrative) pair.

*Proof:* `LOSS L5`.

**Fix:** carry `narrative_ai`, `ai_brief` and `ai_draft` through the copy.

### L7 — MEDIUM. Re-pointing a timer moves an ever-finalized entry with no audit row
`server/routes/timers.js` `PATCH /:id`, the `associate` branch (line 340)

`PATCH /api/timers/:id` moves the linked draft entry to the timer's new
matter — "same entry, same time, same narrative, new matter" — and never
calls `recordAudit`. `PATCH /api/entries/:id` records exactly this change for
exactly this entry. So an entry that was finalized, unlocked and relinked can
change matter through the timer surface and leave no trace, while the same
change made from the entry editor is logged.

*Proof:* `LOSS L7`.

**Fix:** call the same `recordAudit` from the `associate` branch.

---

## Hazards found but not filed as failing tests

These are real and worth fixing; none is provable as a *server* defect without
asserting against behaviour that is currently intended.

1. **A `narrative`-only PATCH is silently discarded on an AUTO entry.**
   `syncNarrative` runs on every `PATCH /:id`. On an entry with ≥2 substantive
   task lines and `narrative_manual = 0`, it overwrites whatever the client
   just sent with the regenerated join. Verified: `PATCH {narrative: "…"}`
   returns 200 and the stored text is unchanged.
   The entry editor (`entryeditor.js`) and the inline narrative editor
   (`entrylist.js`) both send `narrative_manual` explicitly and are safe.
   `stopchips.js` sends only `{narrative, narrative_ai}` and is safe **only
   because** its `offerChips` gate (`!entry.narrative_auto && narrative is
   blank`) happens to exclude the dangerous case. That gate is load-bearing
   data integrity, not presentation. **The agent rewriting `stopchips.js` must
   preserve it**, or the chip pick will report "Narrative saved", show the text
   applied, and store nothing — with an Undo that is also a no-op.
   A belt-and-braces server fix: when a `PATCH` carries `narrative` but no
   `narrative_manual`, and the text differs from what `buildNarrative` would
   produce, treat it as a detach.

2. **Task-line durations are silently zeroed by a duration-less `tasks`
   array.** `normalizeTasks` does `Number(t.duration) || 0`, so a client that
   PATCHes tasks to change fragments only drops every duration. Verified: an
   entry goes from 1.2 h to 0 h and its narrative rewrites to
   `"Review lease (0.0); draft email (0.0)."` No caller does this today, and
   `total_override` shields timer-created entries (so a live clock is not
   destroyed), but the API accepts it without complaint. Prefer: reject a task
   line whose `duration` key is absent, or preserve the stored duration.

3. **`POST /:id/copy` will copy a soft-deleted entry** (`loadEntry` has no
   `deleted_at` guard), resurrecting text the attorney deleted. Add the guard.

4. **Transaction gaps.** Every *entry* write is properly wrapped
   (`writeTasks`, `applyCustomValues`, `syncNarrative` always run inside the
   caller's `db.transaction`). The gaps are on the timer side, where a
   multi-step mutation is several separate transactions:
   - `PATCH /api/timers/:id` — the `UPDATE timers` that can null
     `linked_entry_id` runs outside any transaction, before the `associate`
     block and before `syncToEntry`. A crash between them orphans the entry and
     reproduces L3's double-count.
   - `stopAndFile` stops the clock in one statement and files the hours in a
     later transaction.
   - `POST /:id/fresh` and `PUT /:id/clock` likewise.
   - `applyRollovers` banks and resets per timer without a transaction. This
     one is safe on replay (the re-bank is idempotent), the others are not.
   - `POST /entries/bulk` is intentionally per-item, reporting `done`/`failed`.
     That is defensible; L6 (no audit, no undo) is what makes it dangerous.

5. **Adjacent, outside this audit area, reported per the brief:**
   `POST /api/export` stamps `exported_at` **before** the response leaves the
   server (`server/routes/export.js:101`). A dropped connection or a closed tab
   marks entries exported that never reached a file — the brief's "no entry
   marked exported that did not actually reach the file". Whoever owns the
   export audit should confirm.

---

## Answers to the questions asked

**Can any endpoint write a narrative onto an entry whose matter differs from
the source of that text?** Yes, two: the timer `draft_narrative` stash (L2)
and the sibling-borrowed `suggested_narrative` (L1).

**Copy-to-today and duplicate?** Clean on the matter question.
`POST /:id/copy` hard-codes `src.cm_id` and accepts only a date; it copies the
narrative, `narrative_manual`, `billable`, `total_override`, task lines and
custom values, and drops AI provenance (L5). `POST /api/timers/:id/duplicate`
copies `name`, `cm_id`, `task_code`, `group_id` and `narrative_template`, and
deliberately does not copy `draft_narrative`, `suggested_narrative`,
`linked_entry_id` or the clock — correct.

**Can a bulk apply cross matters?** `set_cm` takes one matter and applies it
to many entries, each carrying its own narrative. That is the attorney's own
reclassification, so it is not a leak — but it is unrecoverable (L6), it skips
the narrative reformat (L8), it hits soft-deleted entries, and it can
double-count time (L3).

**Can a narrative be overwritten without an undo?** Not by `syncNarrative`
against a detached (`narrative_manual = 1`, non-empty) narrative — that
contract holds. It can be overwritten when the entry is AUTO, which is the
intended behaviour, but a client that writes a narrative without saying so is
silently ignored (hazard 1).

**Can a task line's duration be lost when lines are rewritten?** Yes — a
`tasks` array without `duration` keys zeroes every one of them (hazard 2), and
a multi-line entry's durations go stale against a raised total (L4).

**Can an entry be orphaned or soft-deleted without a route back?** No.
`deleteIfUntouched` only removes entries that are provably empty; every other
delete is soft with `POST /:id/restore` and a bulk `restore`; matterless
entries are surfaced by the export's `unassociated` list. The missing route
back is for a *matter reassignment*, not a deletion (L6).

**Can it be double-counted?** Yes — L3, and it is the most serious finding in
this area.
