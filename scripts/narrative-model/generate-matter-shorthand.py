"""Local reverse generation; resume cache keyed by entry and source hash.
Targets are finalized source text, never LLM-generated expansions.
"""
import argparse,hashlib,json,re,time,urllib.request,collections
from pathlib import Path
import os
p=argparse.ArgumentParser();p.add_argument('--pilot',type=int,default=0);p.add_argument('--model',default='llama3.1:8b');a=p.parse_args()
root=Path(os.environ.get('TK_PAIR_DIR','data/narrative-model/matter-pairs-2026-11-04'));rows=[json.loads(l) for l in (root/'sources.jsonl').read_text().splitlines()]
cache=root/'generation-cache.jsonl';done={}
if cache.exists():
 for line in cache.read_text().splitlines():
  try:r=json.loads(line);done[(r['entry_id'],r['source_hash'])]=r
  except (ValueError,KeyError):pass
if a.pilot:
 indices=sorted(set([0,1,len(rows)-1,len(rows)-2]+[round(i*(len(rows)-1)/max(a.pilot-5,1)) for i in range(a.pilot-4)]))
 rows=[rows[i] for i in indices]
system='''Reverse a finished attorney billing narrative into the terse notes the attorney could have typed BEFORE writing it. Return JSON with one field, shorthand.
Keep every distinct activity and person. Preparation and participation in a call are both work: write "prep; call", not just "call". Keep review, revisions, drafting and communications when stated. Use ordinary shorthand such as review, revise, draft, prep, call, msgs, email, conf, re, w.
Drop polished phrasing, routine process steps, explanations and repeated subjects. Aim for a few words per task, plus required names. Separate activities with semicolons. Never add work or people.
Use the supplied PRIOR matter history to omit a document's full title or a recurring subject only when it is clear from that history. Without that support retain the core document name and subject. Preserve novel names, document titles and specific references; do not ask the future model to guess information it could not know.
Example: "Review and analyze lease and identify issues requiring client input; compose email to client outlining lease issues and requesting direction" -> "review lease; email client".
Example: "Prepare for and participate in all-hands call; messages with client; confer with client" -> "prep; all hands call; msgs client; conf client".
Return shorthand only inside the JSON field, no rationale.'''
start=time.time();n=0
for r in rows:
 h=hashlib.sha256(json.dumps({'target':r['target'],'history':r['initial_context']},sort_keys=True).encode()).hexdigest()
 if (r['id'],h) in done:continue
 user='PRIOR matter history:\n'+(r['initial_context'] or 'None.')+'\n\nFinished narrative to reverse:\n'+r['target']
 payload={'model':a.model,'stream':False,'keep_alive':'30m','format':{'type':'object','properties':{'shorthand':{'type':'string'}},'required':['shorthand'],'additionalProperties':False},'options':{'temperature':0,'seed':45,'num_ctx':4096,'num_predict':256},'messages':[{'role':'system','content':system},{'role':'user','content':user}]}
 tick=time.time()
 try:
  if not r['target']:raise ValueError('Empty source narrative')
  req=urllib.request.Request('http://127.0.0.1:11434/api/chat',json.dumps(payload).encode(),{'Content-Type':'application/json'})
  with urllib.request.urlopen(req,timeout=180) as response:answer=json.load(response)
  raw=answer['message']['content'];note=json.loads(raw)['shorthand'].strip();status='model_generated'
  if not note or answer.get('done_reason')=='length':raise ValueError('Empty or truncated generation')
  record={'entry_id':r['id'],'source_hash':h,'model':a.model,'shorthand':note,'status':status,'seconds':time.time()-tick,'prompt_eval_count':answer.get('prompt_eval_count'),'eval_count':answer.get('eval_count')}
 except Exception as e:
  record={'entry_id':r['id'],'source_hash':h,'model':a.model,'shorthand':'','status':'generation_failed','error':str(e),'seconds':time.time()-tick}
 with cache.open('a') as f:f.write(json.dumps(record)+'\n')
 n+=1;done[(r['id'],h)]=record
 print(json.dumps({'generated':n,'cached_total':len(done),'entry_id':r['id'],'seconds':round(record['seconds'],2),'status':record['status'],'shorthand':record['shorthand']}),flush=True)
print(json.dumps({'complete':True,'generated_this_run':n,'elapsed_seconds':time.time()-start}),flush=True)
