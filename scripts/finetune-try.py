#!/usr/bin/env python3
"""Type a brief, see what the tuned model writes -- next to the base model.

  ./.venv-lora/bin/python scripts/finetune-try.py                  # interactive
  ./.venv-lora/bin/python scripts/finetune-try.py "call w/ opposing re discovery"
  ./.venv-lora/bin/python scripts/finetune-try.py -m "Acme Lease" "rev estoppel"

Both models are held in memory so each answer is a fair A/B on the same input.
Nothing is written anywhere and nothing leaves the box.
"""
import argparse, os, sys
os.environ.setdefault("CUDA_VISIBLE_DEVICES", "")
import torch
from transformers import AutoModelForCausalLM, AutoTokenizer
from peft import PeftModel

BASE, ADAPTER = "Qwen/Qwen2.5-0.5B-Instruct", "data/finetune/adapter"
SYSTEM = ("Write one attorney time entry narrative. Match the house voice: "
          "terse, past tense, no filler, no invented time amounts.")

ap = argparse.ArgumentParser()
ap.add_argument("brief", nargs="*", help="the notes; omit for interactive mode")
ap.add_argument("-m", "--matter", default="", help="matter short name")
a = ap.parse_args()

print("loading both models (~20s)…", file=sys.stderr, flush=True)
tok = AutoTokenizer.from_pretrained(BASE)
if tok.pad_token is None: tok.pad_token = tok.eos_token
base = AutoModelForCausalLM.from_pretrained(BASE, dtype=torch.float32).eval()
tuned = PeftModel.from_pretrained(
    AutoModelForCausalLM.from_pretrained(BASE, dtype=torch.float32), ADAPTER).eval()

def write(model, matter, brief):
    user = f"Matter: {matter}\nNotes: {brief}" if matter else f"Notes: {brief}"
    msgs = [{"role": "system", "content": SYSTEM}, {"role": "user", "content": user}]
    text = tok.apply_chat_template(msgs, tokenize=False, add_generation_prompt=True)
    ids = tok(text, return_tensors="pt")
    with torch.no_grad():
        out = model.generate(**ids, max_new_tokens=60, do_sample=False,
                             pad_token_id=tok.pad_token_id)
    return tok.decode(out[0][ids["input_ids"].shape[1]:], skip_special_tokens=True).strip()

def show(matter, brief):
    b, t = write(base, matter, brief), write(tuned, matter, brief)
    print(f"\n  base  ({len(b.split()):>2}w)  {b}")
    print(f"  TUNED ({len(t.split()):>2}w)  {t}")
    print(f"\n  (your house voice: median 11 words)\n")

if a.brief:
    show(a.matter, " ".join(a.brief))
else:
    print("\nType notes and press enter. Ctrl-C to quit.")
    print("Prefix with a matter like  Acme Lease | rev estoppel cert\n")
    try:
        while True:
            line = input("notes> ").strip()
            if not line: continue
            matter, brief = ("", line) if "|" not in line else [x.strip() for x in line.split("|", 1)]
            show(matter, brief)
    except (KeyboardInterrupt, EOFError):
        print("\nbye")
