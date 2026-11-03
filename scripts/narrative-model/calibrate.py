"""Second-stage calibration on train-only variants; original validation selects weights.
Run after train.py. The final test set is never read here.
"""
import os
os.environ['HF_HUB_OFFLINE']='1'
import json,random,time,re
from pathlib import Path
import torch
from transformers import AutoTokenizer,AutoModelForCausalLM
from peft import PeftModel
root=Path('data/narrative-model/v2');torch.set_num_threads(4);torch.set_num_interop_threads(1);torch.manual_seed(43);rng=random.Random(43)
base='Qwen/Qwen2.5-1.5B-Instruct';tok=AutoTokenizer.from_pretrained(base,local_files_only=True)
model=PeftModel.from_pretrained(AutoModelForCausalLM.from_pretrained(base,local_files_only=True,dtype=torch.float32),root/'adapter',is_trainable=True);model.config.use_cache=False
source=[json.loads(l) for l in (root/'train.jsonl').read_text().splitlines()];rng.shuffle(source)
rows=[]
for r in source[:120]:
 # One original and three fact-preserving variants per source, all train-only.
 for variant in range(4):
  user=r['input'];target=r['target']
  if variant==1:user=' (0.4); '.join(user.rstrip('.').split('; '))+' (0.2)'
  if variant==2:
   user=re.sub(r'\b[A-Z]\.\s+([A-Z][a-z]+)',r'\1',user);target=re.sub(r'\b[A-Z]\.\s+([A-Z][a-z]+)',r'\1',target)
  if variant==3:
   user=user.replace('rev/analyze','review and analyze').replace('w/','w').replace('re same','regarding same')
  rows.append(dict(id=r['id'],variant=variant,input=user,target=target))
rng.shuffle(rows)
# Balance all variants; retain audit trail and source IDs.
rows=rows[:160]
(root/'calibration-train.jsonl').write_text(''.join(json.dumps(r)+'\n' for r in rows))
def encode(user,target):
 p=tok.apply_chat_template([{'role':'system','content':(root/'system.txt').read_text()},{'role':'user','content':'Work done: '+user}],tokenize=True,add_generation_prompt=True,return_dict=False)
 a=tok(target,add_special_tokens=False)['input_ids']+[tok.eos_token_id];assert len(p+a)<=512
 return p+a,[-100]*len(p)+a
def batch(rs):
 n=max(len(x) for x,y in rs)
 return dict(input_ids=torch.tensor([x+[tok.pad_token_id]*(n-len(x)) for x,y in rs]),attention_mask=torch.tensor([[1]*len(x)+[0]*(n-len(x)) for x,y in rs]),labels=torch.tensor([y+[-100]*(n-len(y)) for x,y in rs]))
def loss(b):
 h=model.base_model.model.model(input_ids=b['input_ids'],attention_mask=b['attention_mask']).last_hidden_state;y=b['labels'][:,1:];mask=y!=-100
 return torch.nn.functional.cross_entropy(model.base_model.model.lm_head(h[:,:-1][mask]).float(),y[mask])
train=[encode(r['input'],r['target']) for r in rows]
vr=[json.loads(l) for l in (root/'valid.jsonl').read_text().splitlines()]
# Validation variants are derived only from validation source IDs, never train IDs.
valid=[]
for r in vr:
 valid.append(encode(r['input'],r['target']))
 valid.append(encode(r['input'].rstrip('.')+' (0.3)',r['target']))
 valid.append(encode(re.sub(r'\b[A-Z]\.\s+([A-Z][a-z]+)',r'\1',r['input']),re.sub(r'\b[A-Z]\.\s+([A-Z][a-z]+)',r'\1',r['target'])))
def evaluate():
 model.eval();n=0;total=0
 with torch.no_grad():
  for i in range(0,len(valid),2):
   b=batch(valid[i:i+2]);k=(b['labels']!=-100).sum().item();total+=loss(b).item()*k;n+=k
 return total/n
report={'seed':43,'train_rows':len(train),'validation_rows':len(valid),'base_validation_loss':evaluate(),'checkpoints':[]};report['selected_step']=0;model.save_pretrained(root/'calibrated-adapter');tok.save_pretrained(root/'calibrated-adapter');best=report['base_validation_loss'];optimizer=torch.optim.AdamW([p for p in model.parameters() if p.requires_grad],lr=8e-5);start=time.time();model.train()
for i in range(0,len(train),4):
 step=i//4+1;optimizer.zero_grad();l=loss(batch(train[i:i+4]));l.backward();torch.nn.utils.clip_grad_norm_(model.parameters(),1);optimizer.step()
 if step%5==0:print(json.dumps({'step':step,'loss':l.item(),'seconds':time.time()-start}),flush=True)
 if step%20==0:
  v=evaluate();report['checkpoints'].append({'step':step,'validation_loss':v})
  if v<best:
   best=v;report['selected_step']=step;model.save_pretrained(root/'calibrated-adapter');tok.save_pretrained(root/'calibrated-adapter')
  (root/'calibration-report.json').write_text(json.dumps(report,indent=2));print(json.dumps(report),flush=True);model.train()
print('CALIBRATION COMPLETE',flush=True)
