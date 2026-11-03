"""Export the selected adapter to a separately named local Ollama model."""
import json,subprocess,argparse
from pathlib import Path
root=Path('data/narrative-model/v2').resolve()
p=argparse.ArgumentParser();p.add_argument('--adapter');args=p.parse_args()
adapter=Path(args.adapter).resolve() if args.adapter else (root/'calibrated-adapter' if (root/'calibrated-adapter').exists() else root/'adapter')
cache=Path.home()/'.cache/huggingface/hub/models--Qwen--Qwen2.5-1.5B-Instruct'
base=cache/'snapshots'/(cache/'refs/main').read_text().strip()
converter=Path.home()/'Projects/llama-server/llama.cpp/convert_lora_to_gguf.py'
import sys
subprocess.run([sys.executable,str(converter),'--base',str(base),'--outfile',str(root/'adapter.gguf'),'--outtype','f32',str(adapter)],check=True)
system=(root/'system.txt').read_text()
(root/'Modelfile').write_text(f'FROM qwen2.5:1.5b-instruct\nADAPTER {root / "adapter.gguf"}\nSYSTEM """{system}"""\nPARAMETER temperature 0\nPARAMETER num_ctx 2048\nPARAMETER num_predict 220\n')
subprocess.run(['ollama','create','timekeeper-narrative:v2','-f',str(root/'Modelfile')],check=True)

(root/'deployed.json').write_text(json.dumps({'model':'timekeeper-narrative:v2','adapter':str(adapter),'base_revision':base.name},indent=2))
