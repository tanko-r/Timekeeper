"""Read-only, local export. Split near-duplicate families before augmentation."""
import collections, difflib, hashlib, json, random, re, sqlite3
from pathlib import Path
OUT=Path('data/narrative-model/v2'); OUT.mkdir(parents=True,exist_ok=True)
SYSTEM=('Render the work notes as a concise legal billing narrative in the attorney\'s voice. '
'Use present tense, concrete action verbs and semicolons between distinct tasks; end with a period. '
'Preserve every supplied name, document and substantive fact. Expand ordinary shorthand. '
'Do not invent initials, people, documents, work performed or outcomes. '
'Do not include durations, billing codes, explanations or a preamble. Return only the narrative.')
def clean(s):
 s=re.sub(r'^\s*(?:FLAT FEE\s*)?(?:\([A-Z0-9 .–-]+\)\s*)*','',s or '')
 s=re.sub(r'\s*\(\s*\d+(?:\.\d+)?\s*\)','',s)
 return re.sub(r'\s+',' ',s).strip().rstrip('; .')+'.'
def compact(s):
 for a,b in [('Review and analyze','rev/analyze'),('Review and revise','rev/revise'),('regarding','re'),('with','w/'),('messages','msgs'),('communications','comms'),('Prepare','prep'),('Review','rev')]:
  s=re.sub(r'\b'+re.escape(a)+r'\b',b,s,flags=re.I)
 return s.rstrip('.')
def near(a,b):
 m=difflib.SequenceMatcher(None,a.lower(),b.lower());return m.quick_ratio()>.85 and m.ratio()>.85
def tokens(s): return set(re.findall(r'[a-z]{3,}',s.lower()))
c=sqlite3.connect('file:data/timekeeper.db?mode=ro',uri=True)
rows=c.execute("select id,date,cm_id,narrative,ai_brief,ai_draft from entries where status='finalized' and deleted_at is null order by date,id").fetchall()
accepted=[]; rejects=collections.Counter()
for id,date,cm,n,b,d in rows:
 t=clean(n)
 if not 4<=len(t.split())<=85 or re.search(r'\b(regarding|with|and|to|for)\s*[;.]',t,re.I): rejects['length_or_incomplete']+=1;continue
 if re.search(r'\b(to ensure|in order to|for review and approval|as necessary|key considerations|and completeness)\b',t,re.I): rejects['filler']+=1;continue
 if d and difflib.SequenceMatcher(None,t.lower(),clean(d).lower()).ratio()>.90: rejects['almost_unchanged_ai']+=1;continue
 if any(near(t,r['target']) for r in accepted): rejects['near_duplicate']+=1;continue
 # Actual briefs may omit newly added facts. Use only pairs with lexical support;
 # this heuristic is documented, not claimed to prove factual entailment.
 genuine=bool(b) and not (tokens(t)-tokens(clean(b))-{'analyze','analysis','call','message'}) and all(n.lower() in b.lower() for n in re.findall(r'\b[A-Z]\.\s+[A-Z][a-z]+',t))
 accepted.append(dict(id=id,date=date,cm_id=cm,target=t,input=clean(b) if genuine else compact(t),kind='observed' if genuine else 'reconstructed'))
rng=random.Random(20261102);rng.shuffle(accepted)
splits={'test':accepted[:32],'valid':accepted[32:56],'train':accepted[56:]}
for name,rs in splits.items():
 with (OUT/f'{name}.jsonl').open('w') as f:
  for r in rs:
   r['messages']=[{'role':'system','content':SYSTEM},{'role':'user','content':'Work done: '+r['input']},{'role':'assistant','content':r['target']}]
   f.write(json.dumps(r)+'\n')
manifest={'source_rows':len(rows),'accepted':len(accepted),'rejected':dict(rejects),'splits':{k:dict(count=len(v),kinds=dict(collections.Counter(r['kind'] for r in v))) for k,v in splits.items()},'seed':20261102,'system':SYSTEM,'method':'Finalized nondeleted rows, filler and unchanged-AI filters, greedy 0.85 SequenceMatcher dedup before seeded split. Reconstructed notes preserve content. No matter history used. Lexical support of observed pairs is heuristic. Test never selects checkpoints.'}
(OUT/'manifest.json').write_text(json.dumps(manifest,indent=2));(OUT/'system.txt').write_text(SYSTEM)
print(json.dumps(manifest,indent=2))
