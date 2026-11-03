# Local narrative fine-tuning

This pipeline trains the already cached Qwen2.5-1.5B-Instruct model on finalized
Timekeeper entries. All examples, weights and evaluation outputs stay in the
ignored `data/narrative-model/v2/` directory. No production database writes occur.

The machine has an Intel i3-10100, 24 GiB RAM, and no supported training GPU.
Qwen 1.5B is the strongest locally cached instruction model in ordinary
Transformers weights that fits practical CPU training. The larger installed
Ollama models are quantized inference artifacts. The older `timekeeper-lora`
model is a comparison baseline, not the starting checkpoint.

Training uses float32, rank-16 LoRA on attention projections in the last 12 of
28 layers (1,867,776 trainable parameters), assistant-only cross entropy,
AdamW, seed 42, batch 4, at most one epoch, clipping at 1, and warmup/cosine learning
rate from 0.0002. Lower layers remain frozen. Validation loss selects the
checkpoint every 20 steps; training stops after two checkpoints without a
validation improvement of at least 0.002. The style phase also transitions to
calibration after at least 40 steps when loss is below 6% of the base loss. This
transition rule was chosen during development after observing validation results;
it was not a preregistered benchmark threshold. Final test examples do not select it.
Vocabulary logits are computed only for supervised assistant positions; the
script checks numerical equivalence with ordinary full-logit loss before training.

## Run

Run from the project root. This reuses the existing training environment in the
sibling project; it does not add application runtime dependencies.

```bash
PY=/home/david/Projects/Intapp-clone/.venv-lora/bin/python
python3 scripts/narrative-model/prepare.py
python3 scripts/narrative-model/check_data.py
OMP_NUM_THREADS=4 MKL_NUM_THREADS=4 "$PY" -u scripts/narrative-model/train.py
"$PY" -u scripts/narrative-model/calibrate.py
"$PY" scripts/narrative-model/export.py
python3 scripts/narrative-model/evaluate.py
python3 scripts/narrative-model/summarize.py
python3 scripts/narrative-model/report.py
ollama run timekeeper-narrative:v2 'Work done: review lease; email with J. Smith regarding assignment'
```

Re-exporting reads the current database and changes the dataset. Preserve the
existing manifest, JSONL files, hashes and reports to reproduce this run exactly.
Training requires a complete cached base model; network access is disabled in
training. The llama.cpp converter is the installed sibling checkout.

## Data and evaluation limits

Only finalized, nondeleted entries are eligible. Length, filler, near-duplicate
and almost-unchanged AI-output filters remove unsuitable examples. Almost all
surviving inputs are reconstructed from final narratives using conservative
shorthand replacements. They teach style and abbreviation expansion; they do
not constitute hundreds of genuine shorthand-to-draft examples. Names and
content are preserved, rather than dropped and treated as guessing targets.
Only two pairs survive as observed inputs in this run (one training, one
validation); the other 644 are reconstructed. Observed pairs use conservative
lexical and name support checks, which are
heuristics, not semantic entailment proofs.

Near duplicates are removed before a deterministic 590/24/32 split. The
manifest records provenance; `check_data.py` checks disjoint source IDs, name
support, duration removal, message consistency and file hashes. This is a
within-corpus split, not a claim of generalization to unseen clients or matters.

Evaluation compares the base, previous adapter and new adapter using identical
prompts and greedy Ollama decoding. Twelve independently written probes cover
unknown names, document identity, terse calls, multi-task entries and durations.
Thirty-two corpus entries provide a separate held-out style check. Automated
format, initial, duration and filler checks are diagnostics: they cannot prove
that all asserted work is supported. Read the saved outputs as well.

Use drafts for review. A learned style adapter cannot establish what work was
actually performed. This pipeline does not change the live application's model
setting, billing entries or export behavior.

References: [Qwen model card](https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct),
[PEFT LoRA documentation](https://huggingface.co/docs/peft/package_reference/lora).

## Calibration pass

`calibrate.py` continues the selected adapter with 160 examples sampled from
train-only original, duration-bearing, surname-only and shorthand variants.
It uses seed 43, batch 4 and learning rate 0.00008. It evaluates every 20 steps
on 72 validation examples (original, duration-bearing and surname-only variants
of the 24 reserved sources) and saves the best calibrated adapter. Export
automatically prefers that adapter when present. The original adapter remains
available for comparison. This phase addresses development smoke tests; it does
not read the final test set.
