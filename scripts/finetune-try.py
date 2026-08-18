#!/usr/bin/env python3
"""Type notes, get a narrative. Base vs tuned, side by side.

Pulls real matter history from the database so the test matches how the model
was trained -- the model uses prior entries on the matter to work out what a
vague note refers to.

  ./.venv-lora/bin/python scripts/finetune-try.py                       # interactive
  ./.venv-lora/bin/python scripts/finetune-try.py "call w pierce re access"
  ./.venv-lora/bin/python scripts/finetune-try.py -m EAT02 "rev 6th amendment hessburg"

In interactive mode, list matters with  :matters  and pick one with  :m <text>
"""
import argparse, os, re, sqlite3, sys
os.environ.setdefault("CUDA_VISIBLE_DEVICES", "")
import torch
from transformers import AutoModelForCausalLM, AutoTokenizer
from peft import PeftModel

DB = os.path.expanduser("~/Projects/timekeeper-prod/data/timekeeper.db")
SYSTEM = ('You write attorney time entry narratives. Expand the terse notes into '
          'the full narrative: name the documents, people and issues the notes refer to, using '
          'the matter history for what abbreviations mean. Semicolon-separated clauses, past '
          'tense, no filler. Never invent hours.')

ap = argparse.ArgumentParser()
ap.add_argument("notes", nargs="*")
ap.add_argument("-m", "--matter", default="", help="matter name or fragment")
ap.add_argument("--model", default="Qwen/Qwen2.5-1.5B-Instruct")
ap.add_argument("--adapter", default="data/finetune/adapter-1.5b")
ap.add_argument("--context", type=int, default=6)
a = ap.parse_args()

db = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
strip = lambda n: re.sub(r"\s+", " ", re.sub(r"\s*\(\s*\d+(?:\.\d+)?\s*\)", "",
        re.sub(r"^\s*(?:\([A-Za-z0-9 .\-]{2,30}\)\s*)+", "", n or ""))).strip()

def find_matter(frag):
    if not frag: return None, []
    row = db.execute("select id, short_name from matters where short_name like ? "
                     "order by length(short_name) limit 1", (f"%{frag}%",)).fetchone()
    if not row: return None, []
    hist = [strip(r[0]) for r in db.execute(
        "select narrative from entries where cm_id=? and narrative is not null "
        "and deleted_at is null order by date desc, id desc limit ?", (row[0], a.context))]
    return row[1], [h for h in hist if h][::-1]

print("loading base and tuned (~30s)…", file=sys.stderr, flush=True)
tok = AutoTokenizer.from_pretrained(a.model)
if tok.pad_token is None: tok.pad_token = tok.eos_token
base = AutoModelForCausalLM.from_pretrained(a.model, dtype=torch.float32).eval()
tuned = PeftModel.from_pretrained(
    AutoModelForCausalLM.from_pretrained(a.model, dtype=torch.float32), a.adapter).eval()

def build(matter, hist, notes):
    parts = []
    if matter: parts.append(f"Matter: {matter}")
    if hist: parts.append("Recent work on this matter:\n" + "\n".join(f"- {h}" for h in hist))
    parts.append(f"Notes: {notes}")
    return "\n\n".join(parts)

# The model invents initials. Measured: given "pierce" with C. Pierce absent
# from the context window, it wrote "R. Pierce" -- a real colleague, the wrong
# initial, stated with total confidence. matter_people already holds the right
# answer (C. Pierce, seen 3x on that matter), so this is a lookup, not a guess.
#
# Same shape as the de-identification work: the database is authoritative, the
# model is a supplement. Anything the roster knows, the roster decides.
def roster_for(matter_name):
    if not matter_name: return {}
    row = db.execute("select id from matters where short_name = ?", (matter_name,)).fetchone()
    if not row: return {}
    out = {}
    for name, cnt in db.execute(
            "select name, count from matter_people where matter_id=? order by count desc", (row[0],)):
        m = re.match(r"^([A-Z])\.\s*([A-Z][\w'-]+)$", (name or "").strip())
        if m: out.setdefault(m.group(2).lower(), name.strip())
    return out

def fix_initials(text, roster):
    """Correct or supply the initial for any surname the roster knows.

    ONE pass, not two. Running an initial-fixer and then a bare-surname-fixer
    turns "R. Pierce" into "C. C. Pierce": the second pass sees the surname it
    just corrected and prefixes it again. The optional group handles both cases
    in a single match.
    """
    if not roster: return text, []
    fixes = []

    def repl(m):
        whole, surname = m.group(0), m.group(2)
        truth = roster.get(surname.lower())
        if not truth or whole == truth:
            return whole
        fixes.append(f"{whole} -> {truth}")
        return truth

    text = re.sub(r"\b(?:([A-Z])\.\s*)?([A-Z][a-z][\w'-]*)\b", repl, text)
    return text, fixes


def run(model, user):
    msgs = [{"role": "system", "content": SYSTEM}, {"role": "user", "content": user}]
    text = tok.apply_chat_template(msgs, tokenize=False, add_generation_prompt=True)
    ids = tok(text, return_tensors="pt")
    with torch.no_grad():
        o = model.generate(**ids, max_new_tokens=140, do_sample=False,
                           pad_token_id=tok.pad_token_id)
    return tok.decode(o[0][ids["input_ids"].shape[1]:], skip_special_tokens=True).strip()

def show(matter_frag, notes):
    matter, hist = find_matter(matter_frag)
    user = build(matter, hist, notes)
    if matter: print(f"  [matter: {matter} — {len(hist)} prior entries as context]")
    b, t = run(base, user), run(tuned, user)
    roster = roster_for(matter)
    t_fixed, fixes = fix_initials(t, roster)
    print(f"\n  base  ({len(b.split()):>3}w)  {b}")
    print(f"\n  TUNED ({len(t.split()):>3}w)  {t}")
    if fixes:
        print(f"\n  CORRECTED    {t_fixed}")
        print(f"  (roster fixed: {'; '.join(fixes)})")
    print()

if a.notes:
    show(a.matter, " ".join(a.notes))
else:
    matter = a.matter
    print("\nType notes, press enter.   :m <text> sets the matter   :matters lists them   Ctrl-C quits")
    print(f"current matter: {matter or '(none)'}\n")
    try:
        while True:
            line = input("notes> ").strip()
            if not line: continue
            if line == ":matters":
                for r in db.execute("select short_name, count(*) c from entries e "
                                    "join matters m on m.id=e.cm_id group by 1 order by c desc limit 15"):
                    print(f"   {r[1]:>3}  {r[0]}")
                continue
            if line.startswith(":m "):
                matter = line[3:].strip()
                found, hist = find_matter(matter)
                print(f"   matter -> {found or 'NOT FOUND'} ({len(hist)} prior entries)")
                continue
            show(matter, line)
    except (KeyboardInterrupt, EOFError):
        print("\nbye")
