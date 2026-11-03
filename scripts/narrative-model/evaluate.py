"""Identical prompts and deterministic decoding across deployed Ollama models.
Metrics are diagnostics, not semantic accuracy claims. All text stays local.
"""
import argparse,json,re,statistics,time,urllib.request
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--models',nargs='+',default=['qwen2.5:1.5b-instruct','timekeeper-lora:latest','timekeeper-narrative:v2']);a=p.parse_args()
root=Path('data/narrative-model/v2');system=(root/'system.txt').read_text()
probes=[
 ('call w pierce re access','Call with pierce regarding access.'),
 ('rev lease; email w J. Smith re assignment','Review lease; email with J. Smith regarding assignment.'),
 ('draft response to city re records request','Draft response to city regarding records request.'),
 ('prep for closing; call w lender counsel','Prepare for closing; call with lender counsel.'),
 ('review loan docs; draft enforceability legal opinion','Review loan documents; draft enforceability legal opinion.'),
 ('call w Alex re easement','Call with Alex regarding easement.'),
 ('revise license; email w L. Olson','Revise license; email with L. Olson.'),
 ('review title commitment and survey; identify access exceptions; email client re exceptions','Review title commitment and survey; identify access exceptions; email client regarding exceptions.'),
 ('review lease (0.4); call w client (0.2)','Review lease; call with client.'),
 ('email w Z. Quenby re Alder Wharf license','Email with Z. Quenby regarding Alder Wharf license.'),
 ('review seventh amendment to Development Agreement','Review seventh amendment to Development Agreement.'),
 ('call w client','Call with client.'),
]
rows=[dict(input=b,target=t,kind='manual_probe') for b,t in probes]+[json.loads(l) for l in (root/'test.jsonl').read_text().splitlines()]
def score(r,text):
 names=re.findall(r"\b[A-Z]\.\s+[A-Za-z][A-Za-z'-]+",text)
 return dict(words=len(text.split()),reference_words=len(r['target'].split()),format_ok=bool(text.endswith('.') and '\n' not in text and not re.search(r'^(Here|Sure|Narrative|Billing|Work done|Work performed|Work notes|Work Revise)',text)),time=bool(re.search(r'\(\s*\d+(?:\.\d+)?\s*\)|\b\d+(?:\.\d+)?\s*(hours?|minutes?)\b',text)),unsupported_initials=[n for n in names if n.lower() not in r['input'].lower()],filler=bool(re.search(r'\b(to ensure|in order to|for review and approval|as necessary|key considerations)\b',text,re.I)))
for model in a.models:
 out=[]
 for i,r in enumerate(rows):
  payload=dict(model=model,stream=False,keep_alive='10m',messages=[dict(role='system',content=system),dict(role='user',content='Work done: '+r['input'])],options=dict(temperature=0,seed=42,num_ctx=2048,num_predict=220))
  start=time.time();req=urllib.request.Request('http://127.0.0.1:11434/api/chat',json.dumps(payload).encode(),{'Content-Type':'application/json'})
  with urllib.request.urlopen(req,timeout=300) as res: answer=json.load(res)
  text=answer['message']['content'].strip();item=dict(**r,output=text,metrics=score(r,text),seconds=time.time()-start,done_reason=answer.get('done_reason'));out.append(item)
  print(json.dumps(dict(model=model,index=i,**item)),flush=True)
 name=model.replace('/','_').replace(':','_');(root/f'eval-{name}.json').write_text(json.dumps(out,indent=2))
 print(json.dumps({'model':model,'n':len(out),'median_words':statistics.median(x['metrics']['words'] for x in out),'format_pass':sum(x['metrics']['format_ok'] for x in out),'time_fail':sum(x['metrics']['time'] for x in out),'initial_fail':sum(bool(x['metrics']['unsupported_initials']) for x in out),'filler_fail':sum(x['metrics']['filler'] for x in out)}),flush=True)
