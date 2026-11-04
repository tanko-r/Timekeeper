"""Export the selected adapter to a separately named local Ollama model."""
import json,subprocess,argparse,urllib.request
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--adapter');p.add_argument('--base-model',default='qwen2.5:1.5b-instruct');p.add_argument('--root',default='data/narrative-model/v2');p.add_argument('--name',default='timekeeper-narrative:v2');args=p.parse_args()
root=Path(args.root).resolve()
adapter=Path(args.adapter).resolve() if args.adapter else (root/'calibrated-adapter' if (root/'calibrated-adapter').exists() else root/'adapter')
cache=Path.home()/'.cache/huggingface/hub/models--Qwen--Qwen2.5-1.5B-Instruct'
base=cache/'snapshots'/(cache/'refs/main').read_text().strip()
converter=Path.home()/'Projects/llama-server/llama.cpp/convert_lora_to_gguf.py'
import sys
subprocess.run([sys.executable,str(converter),'--base',str(base),'--outfile',str(root/'adapter.gguf'),'--outtype','f32',str(adapter)],check=True)
system=(root/'system.txt').read_text()
# A direct GGUF base must retain the same Qwen chat template as the installed base.
base_model=Path(args.base_model).resolve() if Path(args.base_model).is_file() else args.base_model
template=''
if isinstance(base_model,Path):
    request=urllib.request.Request('http://127.0.0.1:11434/api/show',data=json.dumps({'model':'qwen2.5:1.5b-instruct'}).encode())
    reference=json.load(urllib.request.urlopen(request))
    (root/'base-ollama-show.json').write_text(json.dumps(reference,indent=2))
    template='TEMPLATE \"\"\"'+reference['template']+'\"\"\"\n'
advanced=args.name.rsplit(':',1)[-1].startswith(('v3','v4'))
(root/'Modelfile').write_text(f'FROM {base_model}\n{template}ADAPTER {root / "adapter.gguf"}\nSYSTEM """{system}"""\nPARAMETER temperature 0\nPARAMETER num_ctx {4096 if advanced else 2048}\nPARAMETER num_predict {768 if advanced else 220}\n')
subprocess.run(['ollama','create',args.name,'-f',str(root/'Modelfile')],check=True)

(root/'deployed.json').write_text(json.dumps({'model':args.name,'adapter':str(adapter),'base_revision':base.name,'inference_base':str(base_model)},indent=2))
