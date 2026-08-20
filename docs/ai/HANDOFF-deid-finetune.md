# HANDOFF — de-identification + the local LoRA experiment

**Written 2026-08-17.** Sister file to `docs/ui/HANDOFF.md`, which stays the
entry point for the UI overhaul. This track covers making David's narratives
safe to train on, and fine-tuning a model on them.

Numbers below are **measurements**, each cited to the commit it was taken at.
Do not quote one against a different commit without re-measuring.

---

## 1. THE OPEN QUESTION

> **The roster corrector is IN THE APP (`7a8e426`). What next?**
>
> - **More data** *(my recommendation)*. 164 training samples is now the binding
>   constraint, not the model and not the tooling. Using Timekeeper's AI draft
>   button in daily work records genuine `ai_brief` -> `narrative` pairs for
>   free; only 15 of 428 entries have one today. A few hundred real pairs beats
>   both of the options below.
> - **Show the corrections in the UI.** `/ai/expand` and the streamed narrate
>   event now return `initial_fixes: [{from, to}]` and nothing renders it. The
>   server deliberately reports rather than silently rewrites — a name changed
>   under an attorney's signature should be visible. Frontend work, small.
> - **Scale up.** Rented GPU only; 8B/9B do NOT fit (§3). Qwen3.5-9B over
>   Llama 3.1 8B: newer, base weights ungated. ~$0.40/hour. De-identify first
>   (§5), because the data leaves the box.

---

## 2. WHAT WORKS TODAY — at `f7233ee`

**`ollama run timekeeper-lora`** — Qwen2.5-1.5B + LoRA, 994 MB.
Trained in 51 minutes on the i3 (123 steps, 25 s/step).

### 2a. It learned expansion

15 held-out entries, scored against David's own narratives as the ceiling:

| | p50 words | invented | hours emitted | semicolons | mem |
|---|---|---|---|---|---|
| REAL (David's) | 19 | 8 (7/15) | 0 | 8/15 | 0.55 |
| base 1.5B | 58 | **65** (12/15) | 0 | 12/15 | 0.39 |
| **tuned** | **17** | **10** (6/15) | **0** | **8/15** | 0.51 |

REAL scores 8 rather than 0 because the detector compares against notes derived
by compression, and compression drops things. So 8 is the floor an honest
narrative gets, and the tuned model sits on it. The base invents 65, and through
Ollama simply refuses ("I don't have any specific information about this matter").

### 2b. ⚠️ It invents INITIALS — the load-bearing caveat

Given `pierce` with C. Pierce absent from the context window, it wrote
`R. Pierce` in the Python runtime and `J. Pierce` through Ollama. A real
colleague, the wrong initial, stated with total confidence. On a fee bill that
is worse than vagueness.

Measured across four matters: **2 of 4 generations needed correction**
(`R. Pierce -> C. Pierce`, `J. Venn -> L. Venn`); the two the model got right
were left untouched. It gets initials right when the person appears in recent
history and invents them otherwise.

`matter_people` holds the truth, so this is a lookup, not a guess.
**FIXED at `7a8e426`:** `correctInitials` in `server/lib/people.js`, applied on
the way out of `/ai/expand` and the streamed narrate event, returning
`initial_fixes` so the correction is reported rather than applied silently.
Also in `scripts/finetune-try.py` for the standalone tester.

It only corrects surnames the roster knows — a first-time name gets an invented
initial and nothing catches it.

Same family: it wrote "6th Amendment to easement" where the real entry says
"6th Amendment to Development Agreement". Close, plausible, wrong. A drafting
assistant whose output a human reads, not a system that files on anyone's behalf.

### 2c. The dataset

179 samples, median grounding 1.00, median expansion 2.2x, from 428 entries.
`(YEL)` prefixes and `(0.4)` times are STRIPPED from every target — they belong
to the matter, not the voice, and the app inserts them from
`entry_tasks.duration`. Measured `hours emitted 0`, so it learned that.

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
# use it
ollama run timekeeper-lora
./.venv-lora/bin/python scripts/finetune-try.py     # interactive, with roster fix
  :matters        list matters
  :m EAT02        set matter (pulls 6 prior entries as context)

# rebuild it
node scripts/finetune-export.mjs --context 6        # 179 grounded samples
./.venv-lora/bin/python scripts/finetune-lora.py \
    --model Qwen/Qwen2.5-1.5B-Instruct --maxlen 512 \
    --out data/finetune/adapter-1.5b [--resume]     # ~51 min, checkpoints /20
./.venv-lora/bin/python scripts/finetune-compare.py \
    --model Qwen/Qwen2.5-1.5B-Instruct --adapter data/finetune/adapter-1.5b

# ship it to ollama  (Modelfile archived at docs/ai/Modelfile.timekeeper-lora)
BASE=$(find ~/.cache/huggingface/hub -maxdepth 4 -type d \
       -path "*Qwen2.5-1.5B-Instruct*/snapshots/*" | head -1)
./.venv-lora/bin/python ~/Projects/llama-server/llama.cpp/convert_lora_to_gguf.py \
    data/finetune/adapter-1.5b --base "$BASE" \
    --outfile data/finetune/timekeeper-lora.gguf --outtype f16
cd data/finetune && ollama create timekeeper-lora -f Modelfile

# de-identification (only needed if data LEAVES the box)
node scripts/deid-eval.mjs --model llama3.1:8b
node scripts/deid-vocab.mjs
```

Data lives in `~/Projects/timekeeper-prod/data/`, NOT in this repo.

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

9. **Launch long jobs with `setsid nohup … & disown`, never `run_in_background`.**
   Harness-backgrounded processes are reaped when the turn ends. This killed two
   training runs — one at step 60 of 123, one at step 0 — and both times the
   first instinct was to blame memory. There was never an OOM entry in the
   kernel log. Check `sudo dmesg -T | grep -i oom` before believing that story.

10. **A short probe overestimates step time.** A 4-step probe reported 77 s/step
    because model loading was averaged in; the real run was 25 s/step.

11. **`--base` on `convert_lora_to_gguf.py` wants a LOCAL directory**, not a HF
    repo id. Find it under `~/.cache/huggingface/hub/*/snapshots/*`.

12. **Ollama serves a Q4 base; training used fp32.** The adapter crosses that
    gap but behaves differently — the same prompt gave `R. Pierce` in Python and
    `J. Pierce` through Ollama. Evaluate in the runtime you will ship.

13. **`cd` inside a Bash call persists to the next call.** A `cd data/finetune`
    left later commands resolving paths against the wrong directory.
