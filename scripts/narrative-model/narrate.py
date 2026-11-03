"""Use the local adapter with its training prompt. Prints an unposted draft."""
import argparse,json,urllib.request
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('notes');p.add_argument('--model',default='timekeeper-narrative:v2');args=p.parse_args()
root=Path(__file__).resolve().parents[2]/'data/narrative-model/v2'
payload={'model':args.model,'stream':False,'messages':[{'role':'system','content':(root/'system.txt').read_text()},{'role':'user','content':'Work done: '+args.notes}],'options':{'temperature':0,'num_ctx':2048,'num_predict':220}}
request=urllib.request.Request('http://127.0.0.1:11434/api/chat',json.dumps(payload).encode(),{'Content-Type':'application/json'})
with urllib.request.urlopen(request,timeout=300) as response: result=json.load(response)
if result.get('done_reason')=='length':raise SystemExit('Generation reached its token limit. Shorten the notes; the incomplete draft was not returned.')
print(result['message']['content'].strip())
