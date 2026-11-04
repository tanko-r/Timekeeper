# Reviewed narrative calibration

The authoritative targets are David's approved edits in
[narrative-training-review.md](narrative-training-review.md). The stale draft
banner in that file does not override the explicit overall and per-example
approvals. The exporter requires those approvals and records a source hash.

`prepare-reviewed.mjs` exports the seven approved examples. Example 1's brackets
are a contextual template: the training request explicitly supplies lease
negotiation history before resolving that placeholder. Example 5 uses the
corrected role for J. Romero from Example 2. Three approved outputs are also
converted structurally to JSON tasks for the task-splitting route. These are
training examples, not evaluation examples.

The v3 policy gives Expand, Rewrite and Shorten separate requests (Draft uses
the Expand action for terse work notes), using the
same builder in training and runtime. Curated model training replaces unrelated
few-shot voice examples for this model; matter history and additional attorney
instructions still apply. The v2 runtime remains available for comparison.

Run from the project root:

```bash
node scripts/narrative-model/prepare-reviewed.mjs
node scripts/narrative-model/synthesize-reviewed.mjs
OMP_NUM_THREADS=4 MKL_NUM_THREADS=4 /home/david/Projects/Intapp-clone/.venv-lora/bin/python -u scripts/narrative-model/train-reviewed.py --epochs 2 --batch 2
node scripts/narrative-model/prepare-shortening.mjs
OMP_NUM_THREADS=4 MKL_NUM_THREADS=4 /home/david/Projects/Intapp-clone/.venv-lora/bin/python -u scripts/narrative-model/train-reviewed.py --epochs 2 --batch 2 --adapter data/narrative-model/v3/adapter --data shortening-calibration.jsonl --out adapter-final
/home/david/Projects/Intapp-clone/.venv-lora/bin/python scripts/narrative-model/export.py --root data/narrative-model/v3 --name timekeeper-narrative:v3 --adapter data/narrative-model/v3/adapter-final
node scripts/narrative-model/evaluate-reviewed.mjs
node scripts/narrative-model/evaluate-reviewed.mjs --final
```

After the approved-only pass showed repetitive wording and a dropped task, the
user explicitly authorized synthetic examples based on the edits.
`synthesize-reviewed.mjs` adds 124 synthetic mode/context variants and repeats
the ten approved plain/structural targets twice, for 144 rows. Synthetic targets
are visible in the generator, and labeled separately from lawyer-approved text.
The approved-only attempt and its development outputs are archived locally.

Training continues the existing v2 LoRA using seed 44, learning rate 0.0001,
assistant-only loss, batch 2 and two fixed epochs on the expanded corpus. There is no claim of
held-out validation loss from the seven approved examples. Independent route
evaluation uses new names and documents through an isolated temporary app
server and real Ollama, including Expand, Rewrite, Shorten and JSON task splits.
The route evaluation must be reviewed for changed facts and inappropriate
specificity as well as expansion. With so few approved pairs, generalization
must be measured rather than inferred from fitting the approved targets.

Private artifacts remain under ignored `data/narrative-model/v3/`.

A focused final pass uses ten corrected Shorten targets plus the ten approved
plain/structural rows as rehearsal (20 rows, two epochs). It preserves the
explicit review step in shortened call narratives; the synthetic generator also
contains this correction for future runs. The local frozen training corpus and
correction corpus record the exact inputs used in this run.

## Runtime checks

The calibrated route buffers a draft before sending it to the editor and checks
for missing or newly asserted activity categories. It allows review of background
materials within preparation or revision, and handles common shorthand. A
mismatch triggers a Rewrite request; two mismatches return an error instead of
autosaving the changed work. This is a narrow lexical check, not proof of factual
accuracy. One known malformed phrase, “Compose call,” is normalized to “Conduct
call” without changing the activity or names.

Task splitting uses the validated whole narrative, maps its fragments to the
attorney's original clauses, and separates a combined preparation/call clause
when necessary. Task codes come from the original activities and the configured
code list. With no per-task durations supplied, total time is allocated evenly.
When a safe mapping is unavailable, the original task wording is retained; this
keeps tasks intact rather than accepting missing or merged JSON tasks from the
small model. The editor's normal task-based narrative handles punctuation and
time allocations.

The initial route evaluation was inspected during development and used to
refine the runtime checks. It is regression evidence, not an untouched benchmark
for the whole pipeline. Additional fresh subjects were excluded from training.
Raw outputs and intermediate failures remain in the local artifact directory.
