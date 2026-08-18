# HANDOFF — de-identification + the local LoRA experiment

**Written 2026-08-17.** Sister file to `docs/ui/HANDOFF.md`, which stays the
entry point for the UI overhaul. This track covers making David's narratives
safe to train on, and fine-tuning a model on them.

Numbers below are **measurements**, each cited to the commit it was taken at.
Do not quote one against a different commit without re-measuring.

---

## 1. THE OPEN QUESTION

> **Nothing is blocked. David chose to stop after the 0.5B proof.**
>
> The chain works end to end and is committed. Resume when EITHER of these is
> true, not before:
>
> - **He has exported several thousand entries.** 428 is thin, and only 15 of
>   them carry a real `ai_brief` (see §4). More data changes the answer more
>   than a bigger model does.
> - **He wants the real Llama 3.1 8B fine-tune.** That means renting a GPU for
>   an hour (~$0.40), which means de-identifying first (§5) because the data
>   leaves the box. On this machine an 8B is 5-8 hours on CPU and memory is
>   tight at 24 GB.
>
> If he asks for "a bigger one" without either condition, `Qwen2.5-3B-Instruct`
> is the honest next rung: ~2-3 hours on CPU, ungated, and it still fits the
> 8 GB card for inference afterwards.

---

## 2. WHAT ACTUALLY HAPPENED — the LoRA, at `a04318b`

A LoRA **was trained and it worked.** It is `Qwen2.5-0.5B-Instruct`, NOT
Llama 3.1 8B. Do not let the phrase "the fine-tune worked" stand near the
original question without that correction; it caused confusion once already.

386 train / 42 held out, 291 steps, 3.5 s/step, **17 minutes on the i3**.
Loss 1.82 → 0.093. Measured on the 42 held-out entries (house voice baseline,
measured 2026-08-01: p50 11 words, p90 29):

| | p50 | p90 | filler | mem |
|---|---|---|---|---|
| REAL (David's) | 11 | 23 | 18 | 0.61 |
| base 0.5B | 27 | 32 | 0 | 0.29 |
| **tuned** | **11** | **21** | **20** | **0.61** |

`mem` = mean similarity to the nearest *training* narrative. Loss at 0.093 on
386 examples is as consistent with memorisation as with learning, so this is
the probe that matters. David's own held-out entries score 0.61 — time entries
are repetitive and that is the honest ceiling. The tuned model sits **on** it,
not above it. It learned the register, not the rows.

Artifacts (gitignored, real client text): `data/finetune/adapter/`,
`compare.html`, `train.jsonl`, `valid.jsonl`, `train.log`.

**Not done:** the adapter was never converted to GGUF or loaded into Ollama, so
it has never been scored by `scripts/ai-eval.mjs` — the yardstick this project
already built for exactly this. That is the cheapest high-value next step if
the work resumes.

---

## 3. THE HARDWARE — tested, not assumed

**The GPU cannot train. This is now proven, not inferred.**

```
rocminfo         SEES gfx1010:xnack-, 8176 MB          <- detection works
torch+rocm7.0    torch.cuda.is_available() -> True     <- and lies
a single matmul  hipErrorInvalidDeviceFunction         <- no RDNA1 kernels
HSA_OVERRIDE_GFX_VERSION=10.3.0
                 hung 6 min on that same matmul, killed
```

So: CPU for training. The card is fine for *inference* via Ollama (Vulkan,
`RADV NAVI10`).

Inference footprints, from `ollama ps` — **file size does not predict VRAM**:

- `llama3.1:8b` — 4.9 GB file, stays on GPU, 622 ms median
- `qwen3.5:4b` — 3.4 GB file, loads at **8.6 GB**, 66% CPU, 6534 ms
- `qwen3.5:9b` — 6.6 GB file, loads at **11 GB**, 74% CPU, ~15 s

Environment: `.venv-lora/` at the repo root (system-site-packages + `transformers`
+ `peft`). **Do not use `~/Projects/gliner/venv`** — an earlier session borrowed
it for its libraries, which was confusing and is now unnecessary.

---

## 4. THE DATA LIMITATION — read before scaling anything

**Only 15 of 428 entries have a real `ai_brief`.** So there are not hundreds of
`brief -> narrative` pairs. There are hundreds of examples of the voice.

`scripts/finetune-export.mjs` reconstructs the other 413 inputs by stripping
each narrative to its content words. That is backtranslation, and it carries a
specific failure mode: the model can learn *"un-abbreviate the input"* rather
than *"write like David."* The 42 held-out entries exist to catch that, and on
this run they did not show it — but the risk grows with more synthetic data,
not less.

**The highest-value thing David can do costs him nothing:** use Timekeeper's AI
draft feature in normal daily work. Every use records a genuine
`ai_brief` -> `narrative` pair. A few hundred real pairs beats any amount of
reconstruction, and beats a bigger model.

---

## 5. DE-IDENTIFICATION — and when it actually matters

**It is NOT a prerequisite for local training.** An earlier session treated it
as a blocker and was wrong. The adapter trains, lives and runs on the box, and
the narratives are already in `data/timekeeper.db` on that same box.

It becomes a hard requirement the moment data leaves: renting a cloud GPU,
sharing an adapter, or publishing anything. A LoRA on a few hundred examples
can and does emit distinctive training phrases verbatim.

Measured at `87d8b11`, 416 narratives, 323 dictionary terms:

| model | recall | leaky entries | median |
|---|---|---|---|
| `llama3.1:8b` (prompt v2) | **95.3%** | 17 | 622 ms |
| `qwen3.5:4b` (prompt v2) | 93.3% | 22 | 6534 ms |

The pipeline, in the order that matters:

```
1. DICTIONARY   100% on known terms, by construction   <- the workhorse
2. VOCABULARY   279 strings, reviewed once, cleared    <- the safety net
3. MODEL        95.3%                                  <- a supplement
```

95% is a good assistant and not a privilege standard. Use typed placeholders
(`[CLIENT]`, `[PERSON]`, `[MATTER]`) rather than fake names — Timekeeper knows
the real matter at generation time and can substitute.

**Two open items needing David's eyes, not more code:**

1. Three `matter` short_names cause 10 of the 17 remaining misses. Recall on
   that category was 60.0% under BOTH prompts — adding matter names to the
   prompt and demonstrating two of them moved it by exactly zero. The
   hypothesis that the prompt was at fault is unsupported and still open. If
   those three names are generic project labels, the ground truth is wrong,
   not the model.
2. 268 `extras` — model finds the dictionary does not know. What fraction are
   real decides whether step 3 belongs in the pipeline at all.

Both are in `data/deid-eval/report.html`.

---

## 6. THE COMMANDS

```bash
# de-identification
node scripts/deid-eval.mjs --model llama3.1:8b     # score a model
node scripts/deid-vocab.mjs                        # vocabulary checklist

# fine-tune
node scripts/finetune-export.mjs                   # 428 entries -> jsonl
./.venv-lora/bin/python scripts/finetune-lora.py   # ~17 min at 0.5B
./.venv-lora/bin/python scripts/finetune-compare.py

# both training scripts take --model; scaling up is one flag
```

Data lives in `~/Projects/timekeeper-prod/data/`, NOT in this repo. Prod moved;
`Intapp-clone/data/` no longer exists. The eval scripts default to the prod path.

---

## ⚠️ Rules that will bite a fresh session

1. **Never send `report.html`, `vocab.html`, `compare.html`, `review.csv`,
   `results.jsonl` or either `.jsonl` training file through the conversation.**
   They contain real client narratives. Give David the path; let him open it.

2. **grep goes silently blind on files containing NUL bytes.** No matches, no
   error, no warning. This cost a full debugging cycle: a cache key used `\0`
   as a separator, every grep came back empty, the emptiness read as "not
   present," and a failed patch passed as a landed one. If a grep result is
   surprisingly empty, run `file <path>` and look for `(binary data)`.

3. **A prompt change invalidates the eval cache — but only since `87d8b11`.**
   Rows in `cache.jsonl` without a `p` field predate the fix and were scored
   under prompt v1.

4. **Re-run every model comparison after a prompt change.** The first bake-off
   ranked `qwen3.5:4b` above `llama3.1:8b`; fixing the prompt flipped it. That
   comparison was measuring the prompt, not the models.

5. **Open the database read-only.** `new Database(path, {readonly: true})`.
   The live service holds a WAL.

6. **`think: false` on every Ollama call.** qwen3.5 is a reasoning model; left
   alone it turned an 11-second call into a 90-second timeout here.

7. **`ollama` is a SYSTEM service, not `--user`.** `systemctl --user status
   ollama` reports inactive and is misleading.

8. **Say which model.** "The fine-tune worked" means a 0.5B Qwen. It is not
   the Llama 3.1 8B the project started out asking about.
