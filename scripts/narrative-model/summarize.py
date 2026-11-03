"""Re-score saved outputs without regenerating or changing the held-out set."""
import json,re,statistics,html
from pathlib import Path
root=Path('data/narrative-model/v2');summaries={};sections=[]
for path in sorted(root.glob('eval-*.json')):
 rows=json.loads(path.read_text());name=path.stem[5:];summary={}
 for r in rows:
  r['metrics']['unsupported_initials']=[n for n in re.findall(r"\b[A-Z]\.\s+[A-Za-z][A-Za-z'-]+",r['output']) if n.lower() not in r['input'].lower()]
 for kind,rs in [('all',rows),('manual_probes',[r for r in rows if r['kind']=='manual_probe']),('held_out',[r for r in rows if r['kind']!='manual_probe'])]:
  if not rs:continue
  summary[kind]={'n':len(rs),'median_words':statistics.median(len(r['output'].split()) for r in rs),'reference_median_words':statistics.median(len(r['target'].split()) for r in rs),'initial_failures':sum(bool(r['metrics']['unsupported_initials']) for r in rs),'duration_failures':sum(r['metrics']['time'] for r in rs),'filler_failures':sum(r['metrics']['filler'] for r in rs),'preambles':sum(bool(re.match(r'^(Here|Sure|Narrative|Billing|Work done|Work performed|Work notes|Work Revise)',r['output'])) for r in rs),'past_tense_starts':sum(bool(re.match(r'^(Reviewed|Drafted|Prepared|Called|Revised|Sent|Conducted|Attended|Analyzed|Finalized)\b',r['output'])) for r in rs),'exact_reference_case_insensitive':sum(r['output'].lower()==r['target'].lower() for r in rs),'truncated':sum(r.get('done_reason')=='length' for r in rs)}
 summaries[name]=summary
 sections.append('<h2>'+html.escape(name)+'</h2><table><tr><th>Input</th><th>Reference</th><th>Generated</th></tr>'+''.join('<tr>'+''.join('<td>'+html.escape(r[k])+'</td>' for k in ('input','target','output'))+'</tr>' for r in rows)+'</table>')
(root/'evaluation-summary.json').write_text(json.dumps(summaries,indent=2))
(root/'comparison.html').write_text('<!doctype html><meta charset="utf-8"><title>Narrative model comparison</title><style>body{font:16px system-ui;max-width:1500px;margin:40px auto;padding:20px;color:#222;background:#faf9f5}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ccc;padding:12px;text-align:left;vertical-align:top;width:33%}h2{margin-top:60px}</style><h1>Local narrative model comparison</h1><p>Private local evaluation. Automatic checks are diagnostics; inspect outputs for changed facts and omitted work.</p>'+''.join(sections))
print(json.dumps(summaries,indent=2))
