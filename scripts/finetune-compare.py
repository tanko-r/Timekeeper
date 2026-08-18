#!/usr/bin/env python3
"""Generate held-out narratives from base vs tuned, and score both.

Loss going to 0.09 on 386 examples is as consistent with memorisation as with
learning, so the console reports an overlap score against the training set:
if the tuned model reproduces training narratives verbatim, it memorised.

Console prints statistics only. Real text goes to the HTML file.
"""
import json, os, time, difflib
os.environ.setdefault("CUDA_VISIBLE_DEVICES", "")
import torch
from transformers import AutoModelForCausalLM, AutoTokenizer
from peft import PeftModel

BASE, ADAPTER = "Qwen/Qwen2.5-0.5B-Instruct", "data/finetune/adapter"
FILLER = ["regarding", "concerning", "various", "certain", "pertaining",
          "in connection with", "as it relates", "further to", "with respect to"]

tok = AutoTokenizer.from_pretrained(BASE)
if tok.pad_token is None: tok.pad_token = tok.eos_token

valid = [json.loads(l) for l in open("data/finetune/valid.jsonl", encoding="utf8") if l.strip()]
train_narratives = [json.loads(l)["messages"][2]["content"]
                    for l in open("data/finetune/train.jsonl", encoding="utf8") if l.strip()]

def gen(model, msgs):
    text = tok.apply_chat_template(msgs[:-1], tokenize=False, add_generation_prompt=True)
    ids = tok(text, return_tensors="pt")
    with torch.no_grad():
        out = model.generate(**ids, max_new_tokens=60, do_sample=False,
                             pad_token_id=tok.pad_token_id)
    return tok.decode(out[0][ids["input_ids"].shape[1]:], skip_special_tokens=True).strip()

print("loading base…", flush=True)
base = AutoModelForCausalLM.from_pretrained(BASE, dtype=torch.float32); base.eval()
rows = []
t0 = time.time()
for i, s in enumerate(valid):
    rows.append({"msgs": s["messages"], "base": gen(base, s["messages"])})
    if i % 10 == 0: print(f"  base {i}/{len(valid)}", flush=True)
del base

print("loading tuned…", flush=True)
tuned = PeftModel.from_pretrained(
    AutoModelForCausalLM.from_pretrained(BASE, dtype=torch.float32), ADAPTER)
tuned.eval()
for i, r in enumerate(rows):
    r["tuned"] = gen(tuned, r["msgs"])
    if i % 10 == 0: print(f"  tuned {i}/{len(rows)}", flush=True)

def words(s): return len(s.split())
def filler(s): return sum(f in s.lower() for f in FILLER)
def closest_train(s):
    """Highest similarity to any TRAINING narrative — the memorisation probe."""
    return max((difflib.SequenceMatcher(None, s.lower(), t.lower()).ratio()
                for t in train_narratives), default=0.0)

real = [r["msgs"][2]["content"] for r in rows]
def stats(label, texts):
    w = sorted(words(t) for t in texts)
    n = len(w)
    return (f"  {label:10} p50 {w[n//2]:>3}  p90 {w[int(n*.9)]:>3}  max {w[-1]:>3}   "
            f"filler {sum(filler(t) for t in texts):>3}   "
            f"mem {sum(closest_train(t) for t in texts)/n:.2f}")

print(f"\n{len(rows)} held-out entries, generated in {time.time()-t0:.0f}s")
print("  (house voice baseline, measured 2026-08-01: p50 11, p90 29)")
print(stats("REAL", real))
print(stats("base", [r["base"] for r in rows]))
print(stats("tuned", [r["tuned"] for r in rows]))
print("\n  mem = mean similarity to the closest TRAINING narrative.")
print("  REAL is the honest ceiling; tuned scoring far above it means memorisation.")

esc = lambda s: s.replace("&","&amp;").replace("<","&lt;").replace(">","&gt;")
html = ["<!doctype html><meta charset=utf-8><title>LoRA before/after</title><style>",
 "body{font:15px/1.5 system-ui;max-width:1100px;margin:2rem auto;padding:0 1rem}",
 "table{border-collapse:collapse;width:100%}td,th{border:1px solid #ddd;padding:.5rem;vertical-align:top}",
 "th{background:#f4f4f4;font-size:13px}.n{font-family:ui-monospace,monospace;font-size:13px}",
 ".p{font-size:12px;color:#666;white-space:pre-wrap}.w{font-size:11px;color:#999}</style>",
 "<h1>LoRA before / after — 42 held-out entries</h1>",
 "<p>These entries were <b>not</b> in training. Judge whether <i>tuned</i> sounds like you, ",
 "or merely expands the notes.</p><table>",
 "<tr><th style='width:22%'>prompt</th><th style='width:26%'>REAL (yours)</th>",
 "<th style='width:26%'>base</th><th style='width:26%'>tuned</th></tr>"]
for r in rows:
    html.append(f"<tr><td class=p>{esc(r['msgs'][1]['content'])}</td>"
                f"<td class=n>{esc(r['msgs'][2]['content'])}<div class=w>{words(r['msgs'][2]['content'])}w</div></td>"
                f"<td class=n>{esc(r['base'])}<div class=w>{words(r['base'])}w</div></td>"
                f"<td class=n>{esc(r['tuned'])}<div class=w>{words(r['tuned'])}w</div></td></tr>")
html.append("</table>")
open("data/finetune/compare.html","w",encoding="utf8").write("\n".join(html))
print("\nreport: data/finetune/compare.html   (real client text — local only)")
