#!/usr/bin/env python3
"""LoRA fine-tune a small model on Timekeeper narratives. CPU only.

The GPU is not an option on this box: ROCm detects gfx1010 but ships no
kernels for it (hipErrorInvalidDeviceFunction), and HSA_OVERRIDE_GFX_VERSION
=10.3.0 hangs rather than working. So this is deliberately sized for a 4-core
i3 -- small model, short sequences, LoRA on the attention projections only.

Loss is masked to the assistant turn. Training on the prompt tokens too would
teach the model to reproduce the notes, which is the opposite of the goal.

  ./.venv-lora/bin/python scripts/finetune-lora.py --steps 5      # timing probe
  ./.venv-lora/bin/python scripts/finetune-lora.py                # real run
"""
import argparse, json, os, time
os.environ.setdefault("CUDA_VISIBLE_DEVICES", "")  # never touch the broken GPU

import torch
from torch.utils.data import Dataset
from transformers import AutoModelForCausalLM, AutoTokenizer, Trainer, TrainingArguments
from peft import LoraConfig, get_peft_model

p = argparse.ArgumentParser()
p.add_argument("--model", default="Qwen/Qwen2.5-0.5B-Instruct")
p.add_argument("--data", default="data/finetune")
p.add_argument("--out", default="data/finetune/adapter")
p.add_argument("--epochs", type=float, default=3.0)
p.add_argument("--steps", type=int, default=-1, help="cap steps (timing probe)")
p.add_argument("--batch", type=int, default=4)
p.add_argument("--maxlen", type=int, default=256)
p.add_argument("--lr", type=float, default=2e-4)
a = p.parse_args()

tok = AutoTokenizer.from_pretrained(a.model)
if tok.pad_token is None:
    tok.pad_token = tok.eos_token


class Narratives(Dataset):
    """Chat-formatted samples with the prompt masked out of the loss."""

    def __init__(self, path):
        self.rows = []
        for line in open(path, encoding="utf8"):
            line = line.strip()
            if not line:
                continue
            msgs = json.loads(line)["messages"]
            # Render prompt and full text separately so we know exactly where
            # the assistant turn starts -- string search would break on any
            # narrative that happens to contain its own prompt text.
            prompt = tok.apply_chat_template(msgs[:-1], tokenize=False, add_generation_prompt=True)
            full = prompt + msgs[-1]["content"] + tok.eos_token
            p_ids = tok(prompt, add_special_tokens=False)["input_ids"]
            f_ids = tok(full, add_special_tokens=False)["input_ids"][: a.maxlen]
            labels = list(f_ids)
            for i in range(min(len(p_ids), len(labels))):
                labels[i] = -100
            if all(l == -100 for l in labels):
                continue  # nothing to learn from; prompt filled the window
            self.rows.append({"input_ids": f_ids, "labels": labels})

    def __len__(self):
        return len(self.rows)

    def __getitem__(self, i):
        return self.rows[i]


def collate(batch):
    n = max(len(b["input_ids"]) for b in batch)
    pad = tok.pad_token_id
    return {
        "input_ids": torch.tensor([b["input_ids"] + [pad] * (n - len(b["input_ids"])) for b in batch]),
        "attention_mask": torch.tensor([[1] * len(b["input_ids"]) + [0] * (n - len(b["input_ids"])) for b in batch]),
        "labels": torch.tensor([b["labels"] + [-100] * (n - len(b["labels"])) for b in batch]),
    }


train_ds = Narratives(f"{a.data}/train.jsonl")
valid_ds = Narratives(f"{a.data}/valid.jsonl")
print(f"train {len(train_ds)}  valid {len(valid_ds)}  model {a.model}")

model = AutoModelForCausalLM.from_pretrained(a.model, dtype=torch.float32)
model.config.use_cache = False
model = get_peft_model(model, LoraConfig(
    r=16, lora_alpha=32, lora_dropout=0.05, bias="none", task_type="CAUSAL_LM",
    target_modules=["q_proj", "k_proj", "v_proj", "o_proj"],
))
model.print_trainable_parameters()

args = TrainingArguments(
    output_dir=a.out,
    num_train_epochs=a.epochs,
    max_steps=a.steps if a.steps > 0 else -1,
    per_device_train_batch_size=a.batch,
    gradient_accumulation_steps=1,
    learning_rate=a.lr,
    logging_steps=5,
    save_strategy="no",
    report_to=[],
    use_cpu=True,
)
trainer = Trainer(model=model, args=args, train_dataset=train_ds, data_collator=collate)

t0 = time.time()
trainer.train()
dt = time.time() - t0
done = trainer.state.global_step
print(f"\n{done} steps in {dt:.0f}s  ->  {dt/max(done,1):.1f}s/step")
if a.steps > 0:
    per_epoch = (len(train_ds) + a.batch - 1) // a.batch
    total = per_epoch * a.epochs
    print(f"PROBE ONLY. A full {a.epochs:g}-epoch run is ~{total:.0f} steps "
          f"= ~{total * dt / max(done,1) / 60:.0f} min")
else:
    model.save_pretrained(a.out)
    print(f"adapter saved to {a.out}")
