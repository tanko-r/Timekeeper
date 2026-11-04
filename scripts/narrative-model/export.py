"""Export the selected adapter to a separately named local Ollama model."""
import json,subprocess,argparse
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--adapter');p.add_argument('--root',default='data/narrative-model/v2');p.add_argument('--name',default='timekeeper-narrative:v2');args=p.parse_args()
root=Path(args.root).resolve()
adapter=Path(args.adapter).resolve() if args.adapter else (root/'calibrated-adapter' if (root/'calibrated-adapter').exists() else root/'adapter')
cache=Path.home()/'.cache/huggingface/hub/models--Qwen--Qwen2.5-1.5B-Instruct'
base=cache/'snapshots'/(cache/'refs/main').read_text().strip()
converter=Path.home()/'Projects/llama-server/llama.cpp/convert_lora_to_gguf.py'
import sys
subprocess.run([sys.executable,str(converter),'--base',str(base),'--outfile',str(root/'adapter.gguf'),'--outtype','f32',str(adapter)],check=True)
system=(root/'system.txt').read_text()
(root/'Modelfile').write_text(f'FROM qwen2.5:1.5b-instruct\nADAPTER {root / "adapter.gguf"}\nSYSTEM """{system}"""\nPARAMETER temperature 0\nPARAMETER num_ctx {4096 if args.name.endswith(':v3') else 2048}\nPARAMETER num_predict {768 if args.name.endswith(':v3') else 220}\n')
subprocess.run(['ollama','create',args.name,'-f',str(root/'Modelfile')],check=True)

(root/'deployed.json').write_text(json.dumps({'model':args.name,'adapter':str(adapter),'base_revision':base.name},indent=2))
