# HANDOFF — de-identification + the local LoRA experiment

**Written 2026-08-17.** Sister file to `docs/ui/HANDOFF.md`, which stays the
entry point for the UI overhaul. This one covers a separate track: getting
David's time narratives safe to train on, and fine-tuning a model on them.

Refresh the mechanical half with `node scripts/handoff.mjs` (git state, test
counts). The numbers in section 2 are **measurements at commit `87d8b11`** —
do not quote them against a different commit without re-measuring.

---

## 1. THE OPEN QUESTION

> **David wants to run a LoRA locally "just for fun." Which path first?**
>
> - **A — small model, CPU, tonight** *(my recommendation)*. LoRA
>   `llama3.2:3b` (or `qwen3.5:0.8b` for a first loop) with `peft` on the i3.
>   `torch 2.12.1` is already installed and works today with zero setup risk.
>   Proves the whole chain end to end — data → adapter → GGUF → ollama →
>   `ai-eval.mjs` — in one evening. Slow but certain, and the chain is the
>   part worth de-risking, not the model size.
> - **B — ROCm on gfx1010.** `rocminfo` DOES see the card (see §3), so this is
>   less hopeless than the usual advice suggests. But no official PyTorch wheel
>   targets gfx1010; it needs `HSA_OVERRIDE_GFX_VERSION=10.3.0`, which lies to
>   ROCm about the ISA generation and frequently hangs or corrupts on RDNA1.
>   Genuinely fun, genuinely a science project. Do it AFTER A works, so there
>   is a known-good baseline to compare against.
> - **C — rent a GPU.** ~$0.40/hr, done in an hour. Correct for the real
>   fine-tune, wrong for "for fun," and it means uploading client narratives to
>   a third party unless they are de-identified first (§5).
>
> My read: A tonight, B as the actual fun, C when it matters. A also produces
> the tooling B and C both need.

---

## 2. WHAT IS TRUE RIGHT NOW

Measured at `87d8b11`, 416 narratives, 323 dictionary terms.

| model | recall | missed | leaky entries | extras | median |
|---|---|---|---|---|---|
| `llama3.1:8b` (prompt v2) | **95.3%** | 17 | 17 | 268 | 622 ms |
| `qwen3.5:4b` (prompt v2) | 93.3% | 24 | 22 | 280 | 6534 ms |

Prompt v1 → v2 on `llama3.1:8b`: clients 66.7% → 100%, people 93.8% → 97.8%,
`initial + surname` misses 15 → 6, all-caps initials 4 → 0. Overall 90.8% →
95.3%.

**Matter names did NOT move: 60.0% both runs, the same 15/25.** Adding matter
names to the prompt definition and demonstrating two of them changed nothing.
Three distinct `short_name` values account for all ten misses. The hypothesis
that the prompt was at fault there is unsupported and still open.

**The ranking flipped between prompts.** Under v1, `qwen3.5:4b` beat llama
93.9% to 90.8%. Under v2, llama wins 95.3% to 93.3% and qwen got slightly
worse. The first bake-off was measuring the prompt, not the models. Re-run any
model comparison after a prompt change.

### Two questions waiting on David's eyes, not on more code

1. **Are those 3 matter names genuinely identifying?** If they are generic
   project labels, the model is right and the ground truth is wrong.
2. **What fraction of the 268 extras are real?** This decides whether the model
   belongs in the pipeline at all. Both answers are in
   `data/deid-eval/report.html`.

---

## 3. THE HARDWARE, MEASURED NOT ASSUMED

Checked 2026-08-17 on this box:

```
GPU          RX 5700 XT, gfx1010 (RDNA1), 8 GB
rocminfo     SEES gfx1010                    <- better than the usual advice
Vulkan       RADV NAVI10, works
/opt/rocm    present
torch        2.12.1+cu130  -> cuda False, i.e. CPU-only here (CUDA build)
transformers NOT installed
peft         NOT installed
disk         159 G free on /, 621 G on /mnt/hdd
ollama       SYSTEM service (not --user), active
```

**The 8 GB ceiling is the binding constraint, and file size does not predict
it.** Measured with `ollama ps`:

- `llama3.1:8b` — 4.9 GB file, stays on the GPU, 622 ms median
- `qwen3.5:4b` — 3.4 GB file, loads at **8.6 GB**, runs 66% on CPU, 6534 ms
- `qwen3.5:9b` — 6.6 GB file, loads at **11 GB**, runs 74% on CPU, ~15 s

A "4B" with a larger footprint than an "8B" is the qwen3.5 KV cache. Always
check `ollama ps` for the CPU/GPU split before blaming a model for being slow.

---

## 4. WHAT LANDED

Commits `1afcb1f`, `1d2100c`, `87d8b11` on `ui-overhaul-2026-08`, pushed.

**`scripts/deid-eval.mjs`** — scores a local model's de-identification against
the database as ground truth. The idea worth keeping: `clients`, `matters` and
`matter_people` already ARE a dictionary of real identifiers, so the model does
not have to be trusted or eyeballed to be measured. Saves the raw response, the
parsed finds, and the redacted narrative each model would actually produce.
Caches per `(model, prompt, entry, narrative)` so runs over thousands of entries
resume, and a prompt edit correctly invalidates.

**`scripts/deid-vocab.mjs`** — the pass that makes review tractable at scale.
416 narratives collapse to **279 distinct candidate identifiers** once the
dictionary takes its share. Reviewing that list is equivalent to reviewing every
entry. Cleared words go to a persistent allowlist, so importing 5,000 more
entries surfaces only genuinely new vocabulary.

Outputs (all gitignored, all real client text): `data/deid-eval/report.html`,
`vocab.html`, `review.csv`, `results.jsonl`, `cache.jsonl`, `allowlist.txt`.

---

## 5. HOW TO PICK IT UP — the LoRA runbook

### Step 0. De-identify first, and mean it

421 entries is thin. Run `scripts/import-intapp-history.mjs` on an Intapp
"My Released Time" export before training — it is idempotent on
`(date, matter, narrative)` and calls `rebuildMatterPeople`, so **importing
history grows the dictionary**, which raises pass-1 coverage, which shrinks
what the model has to catch. The pipeline gets stronger with more data.

Then, in order:

```
1. DICTIONARY   100% on known terms, by construction     <- the workhorse
2. VOCABULARY   scripts/deid-vocab.mjs, reviewed once    <- the safety net
3. MODEL        llama3.1:8b @ 95.3%                      <- a supplement
```

95% is a good assistant and NOT a privilege standard. The model is step 3 for a
reason. Replace identifiers with typed placeholders (`[CLIENT]`, `[PERSON]`,
`[MATTER]`) rather than fake names — Timekeeper knows the real matter at
generation time and can substitute, so the model never needs it.

### Step 1. Build the training set

Emit JSONL from the redacted narratives — `ai_brief` → `narrative` is the
natural instruction/response pair, and `entries.ai_brief` already exists.
Hold out ~10% for eval. Do NOT train on `narrative_ai` rows without checking
whether the model wrote them; training a model on its own output is how a house
voice collapses into mush.

### Step 2. Train

```bash
pip3 install --user transformers peft datasets accelerate
# path A: CPU, works today
# path B: ROCm — pip3 install torch --index-url https://.../rocm6.x
#         then HSA_OVERRIDE_GFX_VERSION=10.3.0 (expect crashes on RDNA1)
```

Keep it small: LoRA `r=16`, `alpha=32`, target the attention projections, 3
epochs, seq len 128. The narratives are ~80 tokens; a long context window buys
nothing and costs a lot on CPU.

### Step 3. Get it into ollama

Convert the adapter with llama.cpp's `convert_lora_to_gguf.py`, then:

```
FROM llama3.1:8b
ADAPTER ./timekeeper-lora.gguf
```

`ollama create timekeeper-lora -f Modelfile`

### Step 4. Score it against the yardstick that already exists

`scripts/ai-eval.mjs` says so in its own header: *"the yardstick any fine-tuned
model has to beat."* It scores narrative output against the house voice measured
from real history (median ≤16 words, longest ≤34).

```bash
AI_EVAL_MODEL=timekeeper-lora node scripts/ai-eval.mjs
```

**Record the base model's score BEFORE training.** A fine-tune with no baseline
is a vibe, not a result.

---

## ⚠️ Rules that will bite a fresh session

1. **Never send `report.html`, `vocab.html`, `review.csv` or `results.jsonl`
   through the conversation.** They contain real client narratives. The entire
   point of the local model is that privileged text stays on the box; attaching
   the output ships it to Anthropic and undoes the design. Tell David the path;
   let him open it.

2. **grep goes silently blind on files containing NUL bytes.** It classifies
   them as binary and returns *no matches and no error*. This cost a full
   debugging cycle: a cache key used `\0` as a field separator, every grep came
   back empty, the emptiness read as "not present," and a failed patch passed as
   a successful one. If a grep result is surprisingly empty, run
   `file <path>` and check for `(binary data)` before believing it.

3. **A prompt change invalidates the eval cache — but only since `87d8b11`.**
   Any `cache.jsonl` row without a `p` field predates the fix and was scored
   under prompt v1. `--fresh` ignores the whole cache and re-runs everything,
   which is hours at several thousand entries.

4. **Open the database read-only.** `new Database(path, {readonly: true})`.
   The live service holds a WAL; both eval scripts already do this and neither
   should ever gain a write path.

5. **Numbers in this file are measurements at a commit.** This project has
   shipped two invented counts in its own docs. Re-measure or cite `87d8b11`.

6. **`ollama` is a SYSTEM service here, not `--user`.** `systemctl --user
   status ollama` reports inactive and is misleading.

7. **`think: false` on every ollama call.** qwen3.5 is a reasoning model; left
   alone it turned an 11-second call into a 90-second timeout on this box.
   Ollama accepts the flag on non-thinking models too.
