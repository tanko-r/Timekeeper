"""CPU LoRA continuation: full-context gradients, assistant-only loss.
Prompt tokens have no direct language-model loss, but answer gradients flow
through the entire context. Cached no-grad evaluation is checked against the
ordinary full-sequence assistant loss. Validation selects weights; test is not
read by this trainer.
"""
import os
os.environ['HF_HUB_OFFLINE']='1'
import argparse,json,math,random,time,hashlib
from pathlib import Path
import torch
from transformers import AutoModelForCausalLM,AutoTokenizer
from peft import PeftModel
p=argparse.ArgumentParser();p.add_argument('--epochs',type=int,default=1);p.add_argument('--resume',action='store_true');p.add_argument('--root',default='data/narrative-model/v4');p.add_argument('--initial-adapter',default='data/narrative-model/v3/adapter-final');p.add_argument('--lr',type=float,default=4e-5);p.add_argument('--baseline-report');a=p.parse_args()
root=Path(a.root);torch.set_num_threads(4);torch.set_num_interop_threads(1);torch.manual_seed(46)
base='Qwen/Qwen2.5-1.5B-Instruct';tok=AutoTokenizer.from_pretrained(base,local_files_only=True)
resume=(root/'resume.pt').exists() and a.resume
initial=root/'latest-adapter' if resume else Path(a.initial_adapter)
model=PeftModel.from_pretrained(AutoModelForCausalLM.from_pretrained(base,local_files_only=True,dtype=torch.float32),initial,is_trainable=True)
model.config.use_cache=False

def load(split):
 rows=[]
 for line in (root/f'{split}.jsonl').read_text().splitlines():
  r=json.loads(line);msgs=r['messages'];prompt=tok.apply_chat_template(msgs[:-1],tokenize=True,add_generation_prompt=True,return_dict=False);answer=tok(msgs[-1]['content'],add_special_tokens=False)['input_ids']+[tok.eos_token_id]
  assert prompt and answer and len(prompt+answer)<=2048, f'Never silently truncate context/target: {r.get("id",r.get("entry_id"))}'
  rows.append({'id':r.get('id',r.get('entry_id')),'p':prompt,'a':answer})
 return rows
train=load('train');valid=load('valid')
print(json.dumps({'train':len(train),'valid':len(valid),'max_sequence':max(len(r['p']+r['a']) for r in train+valid),'mean_prompt_tokens':sum(len(r['p']) for r in train)/len(train)}),flush=True)

def answer_loss(r):
 pids,answer=r['p'],r['a']
 with torch.no_grad():
  prefix=model.base_model.model.model(input_ids=torch.tensor([pids[:-1]]),use_cache=True)
  past=prefix.past_key_values
 hidden=model.base_model.model.model(input_ids=torch.tensor([[pids[-1]]+answer[:-1]]),past_key_values=past,use_cache=True).last_hidden_state
 logits=model.base_model.model.lm_head(hidden)
 return torch.nn.functional.cross_entropy(logits.float().reshape(-1,logits.shape[-1]),torch.tensor(answer))

def full_loss(r):
 ids=r['p']+r['a'];h=model.base_model.model.model(input_ids=torch.tensor([ids]),use_cache=False).last_hidden_state
 first=len(r['p'])-1;logits=model.base_model.model.lm_head(h[:,first:first+len(r['a'])])
 return torch.nn.functional.cross_entropy(logits.float().reshape(-1,logits.shape[-1]),torch.tensor(r['a']))
model.eval()
with torch.no_grad():
 for r in valid[:2]:
  full,cached=full_loss(r),answer_loss(r)
  assert torch.allclose(full,cached,atol=2e-5),(full.item(),cached.item())
print('Cached eval matches full-sequence assistant loss.',flush=True)

def evaluate():
 model.eval();total=0;n=0
 with torch.no_grad():
  for r in valid:
   loss=answer_loss(r).item();total+=loss*len(r['a']);n+=len(r['a'])
 model.train();return total/n
optimizer=torch.optim.AdamW([p for p in model.parameters() if p.requires_grad],lr=a.lr,weight_decay=.01)
order=[];rng=random.Random(46)
for epoch in range(a.epochs):
 batch=list(range(len(train)));rng.shuffle(batch);order.extend(batch)
report=json.loads((root/'training-report.json').read_text()) if resume else {'initial_adapter':str(initial),'peak_learning_rate':a.lr,'seed':46,'epochs_requested':a.epochs,'train_rows':len(train),'valid_rows':len(valid),'method':__doc__,'checkpoints':[]}
seen=0;best=float('inf');elapsed=0;step=0
if resume:
 state=torch.load(root/'resume.pt',weights_only=False);optimizer.load_state_dict(state['optimizer']);torch.set_rng_state(state['torch_rng']);seen=state['seen'];step=state['step'];best=state['best'];elapsed=state['elapsed']
else:
 if a.baseline_report:
  baseline=json.loads(Path(a.baseline_report).read_text())
  assert baseline['selected_adapter_sha256']==hashlib.sha256((initial/'adapter_model.safetensors').read_bytes()).hexdigest()
  assert baseline['valid_sha256']==hashlib.sha256((root/'valid.jsonl').read_bytes()).hexdigest()
  best=baseline['selected_validation_loss'];report['baseline_reference']=a.baseline_report
 else:best=evaluate()
 report['initial_validation_loss']=best
 if str(initial).endswith('v3/adapter-final'):report['v3_validation_loss']=best
 print(json.dumps({'initial_validation_loss':best}),flush=True)
 (root/'training-report.json').write_text(json.dumps(report,indent=2))
start=time.time();model.train();optimizer.zero_grad();losses=[];total_updates=math.ceil(len(order)/2)
def save_resume():
 model.save_pretrained(root/'latest-adapter')
 torch.save({'optimizer':optimizer.state_dict(),'torch_rng':torch.get_rng_state(),'seen':seen,'step':step,'best':best,'elapsed':elapsed+time.time()-start},root/'resume.pt')
for offset in range(seen,len(order)):
 loss=full_loss(train[order[offset]]);(loss/(1 if len(order)%2 and offset==len(order)-1 else 2)).backward();losses.append(loss.item());seen=offset+1
 if seen%2==0 or seen==len(order):
  step+=1;torch.nn.utils.clip_grad_norm_(model.parameters(),1)
  for group in optimizer.param_groups:group['lr']=a.lr*min(step/8,1)*(.2+.8*.5*(1+math.cos(math.pi*step/total_updates)))
  optimizer.step();optimizer.zero_grad()
 if seen%8==0:print(json.dumps({'examples':seen,'total':len(order),'updates':step,'recent_loss':sum(losses[-8:])/len(losses[-8:]),'seconds':round(elapsed+time.time()-start)}),flush=True)
 if seen%64==0:save_resume()
 if seen%100==0 or seen==len(order):
  v=evaluate();model.save_pretrained(root/f'checkpoint-{seen}');tok.save_pretrained(root/f'checkpoint-{seen}');report['checkpoints'].append({'examples':seen,'update':step,'validation_loss':v})
  if v<best:
   best=v;model.save_pretrained(root/'adapter');tok.save_pretrained(root/'adapter');report['selected_examples']=seen;report['selected_validation_loss']=v
  report['completed_examples']=seen;report['elapsed_seconds']=elapsed+time.time()-start
  (root/'training-report.json').write_text(json.dumps(report,indent=2));save_resume();print(json.dumps(report['checkpoints'][-1]),flush=True)
report['stop_reason']='requested_epoch_complete';report['elapsed_seconds']=elapsed+time.time()-start
report['valid_sha256']=hashlib.sha256((root/'valid.jsonl').read_bytes()).hexdigest()
if (root/'adapter/adapter_model.safetensors').exists():report['selected_adapter_sha256']=hashlib.sha256((root/'adapter/adapter_model.safetensors').read_bytes()).hexdigest()
(root/'training-report.json').write_text(json.dumps(report,indent=2));print('TRAINING COMPLETE',flush=True)
