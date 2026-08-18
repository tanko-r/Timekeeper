#!/usr/bin/env python3
"""Score base vs tuned on held-out entries -- with an invention counter.

The metric that matters is not length. It is whether the model names a person,
document or issue that was NOT in its input. On a fee bill that is describing
work that did not happen, so it is scored per-narrative and reported first.

Also checks the model never emits its own hours: (0.4) belongs to the app,
which reads entry_tasks.duration. A model writing those is inventing billable
time.

Console prints statistics only. Real text goes to the HTML file.

  ./.venv-lora/bin/python scripts/finetune-compare.py --adapter data/finetune/adapter-1.5b \
      --model Qwen/Qwen2.5-1.5B-Instruct
"""
import argparse, json, os, re, difflib
os.environ.setdefault("CUDA_VISIBLE_DEVICES", "")
import torch
from transformers import AutoModelForCausalLM, AutoTokenizer
from peft import PeftModel

ap = argparse.ArgumentParser()
ap.add_argument("--model", default="Qwen/Qwen2.5-1.5B-Instruct")
ap.add_argument("--adapter", default="data/finetune/adapter-1.5b")
ap.add_argument("--data", default="data/finetune")
ap.add_argument("--out", default="data/finetune/compare.html")
a = ap.parse_args()

tok = AutoTokenizer.from_pretrained(a.model)
if tok.pad_token is None: tok.pad_token = tok.eos_token

valid = [json.loads(l) for l in open(f"{a.data}/valid.jsonl", encoding="utf8") if l.strip()]
train_targets = [json.loads(l)["messages"][2]["content"]
                 for l in open(f"{a.data}/train.jsonl", encoding="utf8") if l.strip()]

STOP = {"Review","Call","Draft","Prepare","Analyze","Email","Emails","Revise","Confer",
        "Attend","Messages","Follow","Teams","Conference","Additional","Correspondence",
        "Communication","Close","Notes","Matter","Recent"}

def entities(t):
    out = set()
    for m in re.finditer(r"\b[A-Z]\.\s*[A-Z][a-z]+", t): out.add(m.group(0))
    for m in re.finditer(r"\b(?:[A-Z][a-z]{2,}|[A-Z]{2,})(?:\s+(?:[A-Z][a-z]{2,}|[A-Z]{2,}|of|to|and))*\b", t):
        v = m.group(0).strip()
        if len(v) > 3: out.add(v)
    return [e for e in out if e not in STOP]

def invented(inp, out):
    """Entities in the output traceable to nothing in the input."""
    low = inp.lower()
    bad = []
    for e in entities(out):
        l = e.lower()
        if l in low or l.replace(". ", "").replace(".", "") in low.replace(". ", "").replace(".", ""):
            continue
        if re.sub(r"^[a-z]\.\s*", "", l) in low:   # "J. DiMaggio" grounded by "dimaggio"
            continue
        bad.append(e)
    return bad

HOURS = re.compile(r"\(\s*\d+(?:\.\d+)?\s*\)")

def gen(model, msgs):
    text = tok.apply_chat_template(msgs[:-1], tokenize=False, add_generation_prompt=True)
    ids = tok(text, return_tensors="pt")
    with torch.no_grad():
        o = model.generate(**ids, max_new_tokens=140, do_sample=False,
                           pad_token_id=tok.pad_token_id)
    return tok.decode(o[0][ids["input_ids"].shape[1]:], skip_special_tokens=True).strip()

print("loading base…", flush=True)
base = AutoModelForCausalLM.from_pretrained(a.model, dtype=torch.float32).eval()
rows = [{"msgs": s["messages"], "base": gen(base, s["messages"])} for s in valid]
del base
print("loading tuned…", flush=True)
tuned = PeftModel.from_pretrained(
    AutoModelForCausalLM.from_pretrained(a.model, dtype=torch.float32), a.adapter).eval()
for r in rows: r["tuned"] = gen(tuned, r["msgs"])

def memo(s):
    return max((difflib.SequenceMatcher(None, s.lower(), t.lower()).ratio()
                for t in train_targets), default=0.0)

def report(label, key):
    texts = [r[key] if key != "real" else r["msgs"][2]["content"] for r in rows]
    inps  = [r["msgs"][1]["content"] for r in rows]
    w = sorted(len(t.split()) for t in texts)
    inv = [len(invented(i, t)) for i, t in zip(inps, texts)]
    hrs = sum(bool(HOURS.search(t)) for t in texts)
    semi = sum(";" in t for t in texts)
    print(f"  {label:7} p50 {w[len(w)//2]:>3}w  invented {sum(inv):>3} "
          f"({sum(1 for x in inv if x):>2}/{len(rows)} entries)   "
          f"hours-emitted {hrs:>2}   semicolons {semi:>2}/{len(rows)}   "
          f"mem {sum(memo(t) for t in texts)/len(texts):.2f}")

print(f"\n{len(rows)} held-out entries")
print("  invented = names/documents in the output that appear nowhere in the input")
print("  hours-emitted = narratives containing (0.4) — the app's job, never the model's\n")
for lab, k in (("REAL", "real"), ("base", "base"), ("tuned", "tuned")):
    report(lab, k)
print("\n  REAL is the ceiling: David's own entries scored the same way.")

esc = lambda s: s.replace("&","&amp;").replace("<","&lt;").replace(">","&gt;")
h = ["<!doctype html><meta charset=utf-8><title>LoRA expansion test</title><style>",
 "body{font:15px/1.5 system-ui;max-width:1200px;margin:2rem auto;padding:0 1rem}",
 "td,th{border:1px solid #ddd;padding:.5rem;vertical-align:top}table{border-collapse:collapse;width:100%}",
 "th{background:#f4f4f4;font-size:13px}.n{font-family:ui-monospace,monospace;font-size:13px}",
 ".p{font-size:12px;color:#555;white-space:pre-wrap}.bad{color:#c02626;font-size:11px}",
 ".w{font-size:11px;color:#999}</style><h1>LoRA expansion test — held-out entries</h1>",
 "<p>Red = named in the output but nowhere in the input. Those are inventions, and on a ",
 "fee bill they describe work that did not happen.</p><table>",
 "<tr><th style='width:28%'>input</th><th style='width:24%'>REAL</th><th style='width:24%'>base</th><th style='width:24%'>tuned</th></tr>"]
for r in rows:
    inp = r["msgs"][1]["content"]; real = r["msgs"][2]["content"]
    cells = ""
    for k, t in (("real", real), ("base", r["base"]), ("tuned", r["tuned"])):
        bad = invented(inp, t)
        cells += (f"<td class=n>{esc(t)}<div class=w>{len(t.split())}w</div>"
                  + (f"<div class=bad>invented: {esc(', '.join(bad))}</div>" if bad else "") + "</td>")
    h.append(f"<tr><td class=p>{esc(inp)}</td>{cells}</tr>")
h.append("</table>")
open(a.out, "w", encoding="utf8").write("\n".join(h))
print(f"\nreport: {a.out}   (real client text — local only)")
