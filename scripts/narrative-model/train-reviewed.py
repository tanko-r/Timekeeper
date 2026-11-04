"""Mode-aware SFT on lawyer-approved targets; fixed epochs, no claimed held-out loss."""
import os
os.environ['HF_HUB_OFFLINE']='1'
import json,random,time,hashlib,argparse
from pathlib import Path
import torch
from transformers import AutoTokenizer,AutoModelForCausalLM
from peft import PeftModel
parser=argparse.ArgumentParser();parser.add_argument('--epochs',type=int,default=6);parser.add_argument('--batch',type=int,default=1);parser.add_argument('--adapter',default='data/narrative-model/v2/calibrated-adapter');parser.add_argument('--data',default='train.jsonl');parser.add_argument('--out',default='adapter');args=parser.parse_args()
root=Path('data/narrative-model/v3');torch.set_num_threads(4);torch.set_num_interop_threads(1);torch.manual_seed(44);rng=random.Random(44)
base='Qwen/Qwen2.5-1.5B-Instruct';tok=AutoTokenizer.from_pretrained(base,local_files_only=True)
model=PeftModel.from_pretrained(AutoModelForCausalLM.from_pretrained(base,local_files_only=True,dtype=torch.float32),args.adapter,is_trainable=True);model.config.use_cache=False
rows=[json.loads(l) for l in (root/args.data).read_text().splitlines()];encoded=[]
for r in rows:
 msgs=r['messages'];p=tok.apply_chat_template(msgs[:-1],tokenize=True,add_generation_prompt=True,return_dict=False);a=tok(msgs[-1]['content'],add_special_tokens=False)['input_ids']+[tok.eos_token_id];assert len(p+a)<=1024
 encoded.append((r['id'],p+a,[-100]*len(p)+a))
def loss(rows):
 n=max(len(r[1]) for r in rows)
 ids=torch.tensor([r[1]+[tok.pad_token_id]*(n-len(r[1])) for r in rows]);labels=torch.tensor([r[2]+[-100]*(n-len(r[2])) for r in rows])[:,1:];mask=labels!=-100
 att=torch.tensor([[1]*len(r[1])+[0]*(n-len(r[1])) for r in rows])
 h=model.base_model.model.model(input_ids=ids,attention_mask=att).last_hidden_state
 return torch.nn.functional.cross_entropy(model.base_model.model.lm_head(h[:,:-1][mask]).float(),labels[mask])
optimizer=torch.optim.AdamW([p for p in model.parameters() if p.requires_grad],lr=1e-4);start=time.time();report={'seed':44,'epochs':[],'training_rows':len(rows),'source_manifest':json.loads((root/'manifest.json').read_text()),'method':'Continue v2 adapter, assistant-only loss; approved and user-authorized synthetic examples. Fixed epochs, no held-out loss claim.','requested_epochs':args.epochs,'batch':args.batch}
for epoch in range(args.epochs):
 rng.shuffle(encoded);model.train();ls=[]
 for i in range(0,len(encoded),args.batch):
  optimizer.zero_grad();l=loss(encoded[i:i+args.batch]);l.backward();torch.nn.utils.clip_grad_norm_(model.parameters(),1);optimizer.step();ls.append(l.item())
  if (i//args.batch+1)%10==0:print(json.dumps({'epoch':epoch+1,'batch':i//args.batch+1,'loss':l.item(),'seconds':time.time()-start}),flush=True)
 report['epochs'].append({'epoch':epoch+1,'loss':sum(ls)/len(ls),'seconds':time.time()-start})
 model.save_pretrained(root/f'{args.out}-epoch-{epoch+1}');tok.save_pretrained(root/f'{args.out}-epoch-{epoch+1}')
 (root/f'{args.out}-training-report.json').write_text(json.dumps(report,indent=2));print(json.dumps(report['epochs'][-1]),flush=True)
model.save_pretrained(root/args.out);tok.save_pretrained(root/args.out);print('TRAINING COMPLETE',flush=True)
