"""Reproducible CPU LoRA; assistant-only loss, validation-selected checkpoint."""
import os
os.environ['HF_HUB_OFFLINE']='1'
os.environ['WANDB_DISABLED']='true'
import json, random, time, math
from pathlib import Path
import torch
from transformers import AutoModelForCausalLM,AutoTokenizer
from peft import LoraConfig,get_peft_model
ROOT=Path('data/narrative-model/v2');torch.set_num_threads(4);torch.set_num_interop_threads(1)
random.seed(42);torch.manual_seed(42)
BASE='Qwen/Qwen2.5-1.5B-Instruct'
tok=AutoTokenizer.from_pretrained(BASE,local_files_only=True)
model=AutoModelForCausalLM.from_pretrained(BASE,local_files_only=True,dtype=torch.float32)
model.config.use_cache=False
# Frozen lower layers need no backward graph, substantially reducing CPU time.
model=get_peft_model(model,LoraConfig(r=16,lora_alpha=32,lora_dropout=.05,task_type='CAUSAL_LM',target_modules=['q_proj','k_proj','v_proj','o_proj'],layers_to_transform=list(range(16,28))))
model.print_trainable_parameters()
def dataset(split):
 result=[]
 for line in (ROOT/f'{split}.jsonl').read_text().splitlines():
  r=json.loads(line);messages=r['messages'];p=tok.apply_chat_template(messages[:-1],tokenize=True,add_generation_prompt=True,return_dict=False)
  a=tok(messages[-1]['content'],add_special_tokens=False)['input_ids']+[tok.eos_token_id]
  assert len(p+a)<=512, f'Never silently truncate targets: {r["id"]}'
  result.append((p+a,[-100]*len(p)+a))
 return result
def batch(rows):
 n=max(len(x[0]) for x in rows)
 return dict(input_ids=torch.tensor([x+[tok.pad_token_id]*(n-len(x)) for x,y in rows]),attention_mask=torch.tensor([[1]*len(x)+[0]*(n-len(x)) for x,y in rows]),labels=torch.tensor([y+[-100]*(n-len(y)) for x,y in rows]))
train=dataset('train');valid=dataset('valid')
def loss_for(b):
 # Compute vocabulary logits only where assistant labels are supervised.
 hidden=model.base_model.model.model(input_ids=b['input_ids'],attention_mask=b['attention_mask']).last_hidden_state
 labels=b['labels'][:,1:];mask=labels!=-100
 logits=model.base_model.model.lm_head(hidden[:,:-1][mask])
 return torch.nn.functional.cross_entropy(logits.float(),labels[mask])
model.eval()
with torch.no_grad():
 probe=batch(valid[:2]);standard=model(**probe).loss;selective=loss_for(probe)
 assert torch.allclose(standard,selective,atol=1e-5), (standard,selective)
 print('Selective assistant loss matches full forward:',selective.item(),flush=True)
def evaluate(rows):
 model.eval();loss=0;nt=0
 with torch.no_grad():
  for i in range(0,len(rows),2):
   b=batch(rows[i:i+2]);n=(b['labels']!=-100).sum().item();loss+=loss_for(b).item()*n;nt+=n
 return loss/nt
report={'base':BASE,'torch':torch.__version__,'seed':42,'rank':16,'layers':list(range(16,28)),'checkpoints':[],'style_target_ratio':.06,'min_style_steps':40,'max_epochs':1,'validation_interval':20,'early_stopping_patience':2,'train_rows':len(train),'base_validation_loss':evaluate(valid)}
report['selected_step']=0
model.save_pretrained(ROOT/'adapter');tok.save_pretrained(ROOT/'adapter')
print(json.dumps(report),flush=True)
optimizer=torch.optim.AdamW([p for p in model.parameters() if p.requires_grad],lr=2e-4,weight_decay=.01)
best=report['base_validation_loss'];step=0;total=math.ceil(len(train)/4);start=time.time();stale=0
random.shuffle(train);losses=[];model.train()
for i in range(0,len(train),4):
 step+=1;lr=2e-4*min(step/10,1)*(.2+.8*.5*(1+math.cos(math.pi*step/total)))
 for group in optimizer.param_groups: group['lr']=lr
 optimizer.zero_grad();loss=loss_for(batch(train[i:i+4]));loss.backward();torch.nn.utils.clip_grad_norm_(model.parameters(),1.0);optimizer.step();losses.append(loss.item())
 if step%5==0:print(json.dumps({'step':step,'total':total,'loss':sum(losses[-5:])/len(losses[-5:]),'seconds':round(time.time()-start)}),flush=True)
 if step%20==0 or step==total:
  v=evaluate(valid);report['checkpoints'].append({'step':step,'train_loss':sum(losses)/len(losses),'validation_loss':v})
  model.save_pretrained(ROOT/'latest-adapter')
  if v<best-.002:
   best=v;stale=0;model.save_pretrained(ROOT/'adapter');tok.save_pretrained(ROOT/'adapter');report['selected_step']=step
  else:stale+=1
  report['completed_steps']=step;report['elapsed_seconds']=time.time()-start
  (ROOT/'training-report.json').write_text(json.dumps(report,indent=2));print(json.dumps(report['checkpoints'][-1]),flush=True)
  model.train()
  if step>=40 and v<=report['base_validation_loss']*.06:
   report['stop_reason']='style_target_reached_transition_to_calibration';break
  if stale>=2:report['stop_reason']='validation_plateau';break
else:report['stop_reason']='one_epoch_complete'
report['elapsed_seconds']=time.time()-start
(ROOT/'training-report.json').write_text(json.dumps(report,indent=2));print('TRAINING COMPLETE',flush=True)
