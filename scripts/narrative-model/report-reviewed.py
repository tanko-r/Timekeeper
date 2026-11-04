"""Summarize independent route results; retain text for substantive review."""
import json,re,html,hashlib
from pathlib import Path
root=Path('data/narrative-model/v3');rows=json.loads((root/'final-route-evaluation.json').read_text());summary={};table=[]
for r in rows:
 model=r['model'];s=summary.setdefault(model,{'plain_cases':0,'unsupported_names':[],'time_amounts':[],'expand_word_ratios':[],'split_http_failures':[]})
 if 'output' in r:
  text=r['output'];context=r['input']+' '+(r.get('context') or '')
  names=re.findall(r"\b[A-Z]\.\s+[A-Za-z][A-Za-z'-]+",text)
  unknown=[n for n in names if n.lower() not in context.lower()]
  s['plain_cases']+=1
  if unknown:s['unsupported_names'].append({'id':r['id'],'mode':r['mode'],'names':unknown})
  if re.search(r'\(\s*\d+(?:\.\d+)?\s*\)|\b\d+(?:\.\d+)?\s*(hours?|minutes?)\b',text):s['time_amounts'].append(r['id'])
  if r['mode']=='longer':s['expand_word_ratios'].append({'id':r['id'],'ratio':len(text.split())/len(r['input'].split())})
  table.append('<tr>'+''.join('<td>'+html.escape(str(x))+'</td>' for x in [model,r['id'],r['mode'],r['input'],text])+'</tr>')
 else:
  res=r['response'];tasks=res.get('body',{}).get('tasks',[])
  if res['status']!=200 or len(tasks)!=2:s['split_http_failures'].append(r['id'])
  table.append('<tr>'+''.join('<td>'+html.escape(str(x))+'</td>' for x in [model,r['id'],'JSON split','review plat; email client',json.dumps(res.get('body'),ensure_ascii=False)])+'</tr>')
(root/'evaluation-summary.json').write_text(json.dumps(summary,indent=2))
(root/'comparison.html').write_text('<!doctype html><meta charset="utf-8"><title>Reviewed narrative calibration</title><style>body{font:15px system-ui;margin:30px;background:#faf9f5;color:#222}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccc;padding:12px;text-align:left;vertical-align:top}td:last-child{width:40%}</style><h1>Independent app-route comparison</h1><p>Different runtime profiles are intentional: this compares the complete old and revised app behavior. These inputs were excluded from the new training corpus. Word growth is diagnostic, not a substitute for substantive review. All results are local.</p><table><tr><th>Model</th><th>Case</th><th>Mode</th><th>Input</th><th>Output</th></tr>'+''.join(table)+'</table>')
files=[p for p in root.glob('*') if p.is_file() and p.name!='artifact-hashes.json']+[p for p in (root/'adapter-final').glob('*') if p.is_file()]
(root/'artifact-hashes.json').write_text(json.dumps({str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in files},indent=2))
print(json.dumps(summary,indent=2))
