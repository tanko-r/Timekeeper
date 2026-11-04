"""Local comparison artifact. Diagnostics complement, never replace, review."""
import json,html,hashlib,statistics
from pathlib import Path
root=Path('data/narrative-model/v4');h=html.escape
sections=[];summaries={}
for split in ['valid','guarded-valid','test','guarded-test']:
 files=list(root.glob(f'{split}-timekeeper-narrative_v*.json'))
 by_model={p.stem[len(split)+1:]:json.loads(p.read_text()) for p in files}
 if not by_model:continue
 corpus_split=split.replace('guarded-','')
 corpus={r['entry_id']:r for r in map(json.loads,(root/f'{corpus_split}.jsonl').read_text().splitlines())}
 models=sorted(by_model);ids=list(dict.fromkeys(r['entry_id'] for rs in by_model.values() for r in rs))
 table=[]
 for id in ids:
  same={m:next((r for r in by_model[m] if r['entry_id']==id),None) for m in models}
  first=next((r for r in same.values() if r is not None and 'input' in r),next(r for r in same.values() if r is not None))
  if 'input' not in first:first={**corpus[id],'input':corpus[id]['synthetic_shorthand']}
  cell=f'<b>Entry {id}</b><p>{h(first.get("input",""))}</p><p>Target: {h(first.get("target",""))}</p><details><summary>Supplied history</summary><pre>{h(first.get("context","") or "None")}</pre></details>'
  table.append('<tr><td>'+cell+'</td>'+''.join('<td>'+h((same[m] or {}).get('output',(same[m] or {}).get('error','Missing')))+'</td>' for m in models)+'</tr>')
 sections.append('<h2>'+h(split)+'</h2><table><tr><th>Input and source</th>'+''.join('<th>'+h(m)+'</th>' for m in models)+'</tr>'+''.join(table)+'</table>')
 for model,rs in by_model.items():
  ok=[r for r in rs if 'metrics'in r];summaries[f'{split}:{model}']={'n':len(rs),'errors':len(rs)-len(ok),'activity_pass':sum(r['metrics']['activity']['ok'] for r in ok),'missing_names':sum(bool(r['metrics']['missing_names']) for r in ok),'invented_names':sum(bool(r['metrics']['invented_names']) for r in ok),'time_amounts':sum(r['metrics']['time_amounts'] for r in ok),'median_words':statistics.median(r['metrics']['words'] for r in ok) if ok else None,'recovered_context_facts':sum(x['recovered'] for r in ok for x in r['metrics']['context_recoveries']),'available_context_facts':sum(len(r.get('earlier_context_recoveries',[])) for r in corpus.values())}
(root/'comparison.html').write_text('<!doctype html><meta charset="utf-8"><title>v4 matter-grounded fine-tune comparison</title><style>body{font:15px system-ui;margin:35px;background:#faf9f5;color:#222}table{border-collapse:collapse;width:100%}td,th{padding:12px;border:1px solid #ccc;vertical-align:top;text-align:left;width:33%}pre{white-space:pre-wrap;font:13px system-ui}details{margin-top:16px}</style><h1>v4 matter-grounded continuation</h1><p>Raw comparisons use identical prompts and greedy decoding. Guarded comparisons use the app generation helper, including its activity retry. Lexical checks are diagnostics, not a factual accuracy certification. The continued v3 adapter has seen some older entries; these results are incremental regression evidence.</p>'+''.join(sections))
(root/'evaluation-summary.json').write_text(json.dumps(summaries,indent=2));print(json.dumps(summaries,indent=2))
