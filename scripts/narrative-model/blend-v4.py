"""Exactly interpolate two compatible LoRA updates; no held-out targets used."""
import argparse,json,shutil
from pathlib import Path
import torch
from safetensors.torch import load_file,save_file
p=argparse.ArgumentParser();p.add_argument('--weight',type=float,default=.25);p.add_argument('--new',default='data/narrative-model/v4/adapter');p.add_argument('--out',default='data/narrative-model/v4/blend');a=p.parse_args()
assert 0<=a.weight<=1
old=Path('data/narrative-model/v3/adapter-final');new=Path(a.new);out=Path(a.out);out.mkdir(parents=True,exist_ok=True)
c1=json.loads((old/'adapter_config.json').read_text());c2=json.loads((new/'adapter_config.json').read_text())
for key in ['base_model_name_or_path','layers_to_transform','fan_in_fan_out','use_rslora','use_dora']:
 assert c1.get(key)==c2.get(key),key
assert set(c1['target_modules'])==set(c2['target_modules'])
assert not c1.get('use_dora') and not c1.get('use_rslora') and not c1.get('rank_pattern') and not c2.get('rank_pattern')
x=load_file(old/'adapter_model.safetensors');y=load_file(new/'adapter_model.safetensors');assert x.keys()==y.keys();z={}
for k in x:
 if '.lora_A.' in k:z[k]=torch.cat([x[k],y[k]],dim=0)
 elif '.lora_B.' in k:z[k]=torch.cat([x[k]*((1-a.weight)*c1['lora_alpha']/c1['r']),y[k]*(a.weight*c2['lora_alpha']/c2['r'])],dim=1)
 else:raise ValueError(k)
# rank=alpha makes the exported scale 1. Verify the effective update directly.
for k in x:
 if '.lora_B.' in k:
  ak=k.replace('.lora_B.','.lora_A.')
  expected=(1-a.weight)*(c1['lora_alpha']/c1['r'])*(x[k]@x[ak])+a.weight*(c2['lora_alpha']/c2['r'])*(y[k]@y[ak])
  assert torch.allclose(z[k]@z[ak],expected,atol=2e-6,rtol=2e-5),k
c1['r']=c1['r']+c2['r'];c1['lora_alpha']=c1['r'];c1['inference_mode']=True
(out/'adapter_config.json').write_text(json.dumps(c1,indent=2));save_file(z,str(out/'adapter_model.safetensors'))
(out/'blend.json').write_text(json.dumps({'old':str(old),'new':str(new),'new_weight':a.weight,'method':'Exact weighted sum of effective LoRA delta matrices via rank concatenation; numerical equality checked on every module.'},indent=2))
print(out)
