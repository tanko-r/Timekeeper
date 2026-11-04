# Matter-grounded synthetic shorthand pairs

This pipeline creates one auditable candidate for every nondeleted finalized
entry in a frozen database snapshot. It keeps the actual finalized narrative as
the target, stripping display codes and duration allocations and normalizing the
terminal period. A local Llama 3.1 8B generates only the synthetic shorthand.
Original saved `ai_brief` values are preserved separately as genuine observed
pairs; they may describe an earlier drafting state and need their own review.

The snapshot for this run is in
`data/narrative-model/matter-pairs-2026-11-04/source.db` (private, gitignored).
The run covers 736 finalized entries across 98 matters.

## Context and source isolation

`server/lib/matterHistory.js` is shared by the live narrative requests and
pair assembly. It supplies matter identity, recent chronology, older entries
matching the actual shorthand, and names evidenced in those entries. It reads
only finalized, nondeleted work from the exact matter. Drafts and sibling
matters are excluded. Cached canonical names are included only if the name is
also present in the selected source text, avoiding future roster leakage.

Historical pairs use dates strictly before the source entry's date. Same-day
entries are excluded because entry IDs and import timestamps do not prove the
order in which work happened. Initial generation sees recent earlier context;
final retrieval uses the generated shorthand, not the target narrative. The
historical context records every supporting source entry ID and date. Current
matter labels and entity metadata come from the frozen snapshot, not versioned
historical records; entity metadata is used only to identify facts already
present in the target that should remain explicit in the synthetic input.

If the note and earlier context do not supply a document title, number or named
participant, the assembler keeps it explicit in the note. Repairs are recorded;
they are not presented as facts extracted from prior history. Missing named
facts, activity mismatches, weak compression and source defects are flagged.
Automatic checks are heuristics, not proof that every detail is inferable.

## Files

- `all-pairs.jsonl`: every finalized source, synthetic input, original target,
  observed brief, dated context, repair receipts, flags and training messages.
- `train.jsonl`, `valid.jsonl`, `test.jsonl`: unflagged candidates only. Whole
  dates are split chronologically; identical targets cannot cross candidate
  splits. Base v3 already saw some earlier entries, so these are not pristine
  evaluation sets for the existing model.
- `observed-pairs.jsonl`: original saved shorthand and corresponding final
  narratives. Kept separate from synthetic generation; not automatically
  certified as expansion targets.
- `REVIEW.md`: examples with context and flags.
- `pairs.html`: searchable offline browser for every pair.
- `MATTER-CONTEXTS.md`: current source-grounded matter cards with space for
  attorney-supplied overviews and roles. These current cards are not used as
  historical context. Editing them does not automatically change app settings.
- `manifest.json`, `coverage-receipt.json`: counts, limitations, source hashes,
  split hashes and deterministic coverage checks.

All generated files are local. The frozen snapshot makes this run resumable.
The generation cache is append-only. Generated reports are overwritten when
reassembled; copy a report before editing it for a separate review pass.

## Run

The initial snapshot is created with SQLite's backup API, reading the production
database without modifying entries. For this run, do not replace `source.db`.

```bash
python3 scripts/narrative-model/snapshot-matter-pairs.py
node scripts/narrative-model/export-matter-pair-sources.mjs
python3 -u scripts/narrative-model/generate-matter-shorthand.py
node scripts/narrative-model/assemble-matter-pairs.mjs
python3 scripts/narrative-model/check-matter-pairs.py
python3 scripts/narrative-model/render-matter-pairs.py
```

This workflow prepares the next training corpus. It does not retrain or replace
the v3 weights. The app context improvement is independent of a future training
run; longer context is still not proof of what was done today.

For a future run, set `TK_PAIR_DIR` to a new private run directory before these
commands. Existing snapshots and source exports are reused, not silently
overwritten. Use the frozen `sources.jsonl` and generation cache for this run
when reproducing it. Candidate training from the untouched base model gives a
cleaner evaluation than continuing v3, which has seen some older source entries.
