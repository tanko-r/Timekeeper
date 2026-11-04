# Matter-grounded continuation of v3

`prepare-v4.mjs` freezes the screened matter corpus into a v4 run directory.
It uses 263 training pairs and 71 behavior-rehearsal rows: approved targets,
Rewrite/Shorten variations, and the corrected shortened call examples. Exact
validation/test target matches are excluded from rehearsal. The 33 validation
and 25 test entries do not participate in this optimization pass.

The starting adapter is `v3/adapter-final`. Some source entries were already
seen by earlier adapters, so these splits measure incremental improvement and
regression; they are not a pristine benchmark of generalization from scratch.

Training uses the installed Qwen2.5-1.5B base in float32, the existing rank-16
attention LoRA in layers 16–27, full-context gradients, assistant-only loss,
seed 46, microbatch 1 with gradient accumulation 2, and warmup/cosine learning
rate peaking at 0.00004. No prompt or answer is silently truncated. A cached
no-grad evaluation path is checked numerically against full-sequence loss;
training itself retains gradients through the full prompt.

The first run requests one complete epoch. Checkpoints are saved every 64
examples and evaluated on all validation rows every 100 examples and at the
end. The best validation loss selects the candidate; the final test is used
only after selection. `--resume` loads the latest adapter, optimizer and RNG
state and continues the same deterministic order after an interruption.

```bash
node scripts/narrative-model/prepare-v4.mjs
OMP_NUM_THREADS=4 MKL_NUM_THREADS=4 /home/david/Projects/Intapp-clone/.venv-lora/bin/python -u scripts/narrative-model/train-v4.py
/home/david/Projects/Intapp-clone/.venv-lora/bin/python scripts/narrative-model/export.py --root data/narrative-model/v4 --name timekeeper-narrative:v4 --adapter data/narrative-model/v4/adapter
node scripts/narrative-model/evaluate-v4.mjs timekeeper-narrative:v3 timekeeper-narrative:v4
node scripts/narrative-model/evaluate-v4.mjs --test timekeeper-narrative:v3 timekeeper-narrative:v4
TK_EVAL_DIR=data/narrative-model/v4 node scripts/narrative-model/evaluate-reviewed.mjs --fresh timekeeper-narrative:v3 timekeeper-narrative:v4
```

Raw evaluation uses identical stored prompts and greedy decoding. It records
activity retention, supplied-name retention, new names absent from supplied
context, time amounts, truncation and recovery of source facts available in
history but omitted from the shorthand. These are lexical diagnostics, not a
claim of factual accuracy. App-route evaluation also exercises retries and
splitting; both v3 and v4 use the same runtime profile and guards.

Review model outputs alongside the source context and target before selecting
the live default. The v3 weights and previous runtime configuration are retained
for rollback. Private corpus, weights and reports live under ignored
`data/narrative-model/v4/`.

## Focused retention stage

Early validation showed lower loss but dropped participants in complex entries.
`prepare-v4-focus.mjs` creates 81 additional rows using training-only source
entries and authorized synthetic variations: 40 consistent name replacements,
12 older/newer document contrasts, eight multi-participant call examples, seven
approved examples, ten corrected shortening cases, and four no-context cases.
No production entries are changed and no reserved target is duplicated.

The focused stage starts from the selected main adapter at learning rate
0.00002. It reuses the previously measured initial validation loss only after
checking both the adapter and validation-file hashes. The validation and test
sets remain the same.

```bash
node scripts/narrative-model/prepare-v4-focus.mjs
OMP_NUM_THREADS=4 MKL_NUM_THREADS=4 /home/david/Projects/Intapp-clone/.venv-lora/bin/python -u scripts/narrative-model/train-v4.py --root data/narrative-model/v4/focus --initial-adapter data/narrative-model/v4/adapter --lr 0.00002 --baseline-report data/narrative-model/v4/training-report.json
```

For comparison with the actual generation guard, add `--guarded` to
`evaluate-v4.mjs`. Error cases count as zero recovered context facts; the fact
availability denominator is the complete frozen set, not only successful
responses. Raw and guarded results are retained separately. Full HTTP route
checks use the temporary app server in `evaluate-reviewed.mjs`.

## Runtime candidate checks

The full-epoch adapter, focused adapter and checkpoint-200 preview are retained
separately. An F16 copy of the cached base was converted locally and tested with
the focused adapter, preserving the installed base's Ollama chat template.
`export.py --base-model /absolute/path/to/base-f16.gguf` reproduces that packaging.
Precision alone did not repair the observed retention problems.

`blend-v4.py` also tests a conservative interpolation of the approved v3 behavior
and the full-epoch update. It concatenates the LoRA factors, producing an exact
75%/25% weighted sum of the effective delta matrices at rank 32. Every effective
matrix is numerically checked against that sum; this is not elementwise averaging
of incompatible LoRA factors. The same base and profile apply to both adapters.
No validation/test targets are used in blending.

The local `REPORT.md` and `comparison.html` record the final selection and evidence.
Model promotion requires useful expansion as well as retention; a lower language
model loss by itself does not establish better drafts. The evaluator records HTTP
rejections instead of stopping at the first model failure.

## Completed run and deployment decision

The 334-row main epoch completed, reducing teacher-forced validation loss from
3.5473 to 2.1783. The 81-row retention experiment reached 2.1771. Those changes
did not consistently improve generated drafts. The full update tended to
under-expand; the 75% v3 / 25% main-update blend retained the approved expansion
style and was frozen as the experimental `timekeeper-narrative:v4` candidate.

**v3 remains the default.** On the 33 guarded validation entries, the blend had
six missing-name cases versus three for v3, six rejected requests versus five,
and recovered five context facts versus six out of 23 available. Names checks
include some conservative spelling/reference matches, but manual review also
confirmed dropped participants. The 25 reserved raw entries were somewhat better
on activity retention (17 versus 15), but recovered no additional context facts.
There is insufficient evidence of the better extrapolation requested to replace
the working default. No reserved-test results were used to train or tune another
candidate.

The app recognizes v4 and applies the same prompt, retry and task-splitting rules
if it is selected manually. All adapters, source data, trials and comparisons
are retained locally and included in the HDD backup. Only code and documentation
go to the Git remote. Detailed private results are in
`data/narrative-model/v4/REPORT.md` and `comparison.html`.
