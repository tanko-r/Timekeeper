"""Verify coverage, historical isolation, source hashes, and candidate split integrity."""
import sqlite3,json,hashlib,re
from pathlib import Path
import os
root=Path(os.environ.get('TK_PAIR_DIR','data/narrative-model/matter-pairs-2026-11-04'))
sources={r['id']:r for r in map(json.loads,(root/'sources.jsonl').read_text().splitlines())}
cache={r['entry_id']:r for r in map(json.loads,(root/'generation-cache.jsonl').read_text().splitlines())}
rows=list(map(json.loads,(root/'all-pairs.jsonl').read_text().splitlines()));c=sqlite3.connect(f'file:{root}/source.db?mode=ro',uri=True);c.row_factory=sqlite3.Row
expected={r[0] for r in c.execute("select id from entries where status='finalized' and deleted_at is null")}
assert len(rows)==len(expected)==len({r['entry_id'] for r in rows})
assert {r['entry_id'] for r in rows}==expected
history_checks=0
for r in rows:
 s=sources[r['entry_id']];g=cache.get(r['entry_id']);assert g is not None,'Generation not complete'
 h=hashlib.sha256(json.dumps({'target':s['target'],'history':s['initial_context']},sort_keys=True).encode()).hexdigest();assert g['source_hash']==h,'Stale generation cache'
 assert r['generation_status']!='pending'
 assert r['messages'][-1]['content']==r['target']
 assert len(r['context'] or '')<=3600
 for prior in r['history']:
  e=c.execute('select * from entries where id=?',(prior['entry_id'],)).fetchone()
  assert e['status']=='finalized' and e['deleted_at'] is None
  assert e['cm_id']==r['matter_id'] and e['date']<r['date']
  assert e['id']!=r['entry_id'];assert prior['narrative'] in r['context'];history_checks+=1
 if r['eligible_for_expansion_training']:assert not r['warnings'] and not r['unsupported_specifics']
observed=list(map(json.loads,(root/'observed-pairs.jsonl').read_text().splitlines()))
assert len(observed)==sum(bool(s.get('ai_brief','') and s['ai_brief'].strip()) for s in sources.values())
for r in observed:
 assert r['observed_brief']==sources[r['entry_id']]['ai_brief'].strip()
 assert 'synthetic_shorthand' not in r and 'activity_audit' not in r
 assert r['messages'][-1]['content']==r['target']
 for prior in r['history']:
  e=c.execute('select * from entries where id=?',(prior['entry_id'],)).fetchone()
  assert e['cm_id']==r['matter_id'] and e['date']<r['date'] and e['status']=='finalized' and e['deleted_at'] is None
seen=set();fingerprints=set();split_receipts={}
for split in ['train','valid','test']:
 rs=list(map(json.loads,(root/f'{split}.jsonl').read_text().splitlines()))
 for r in rs:
  assert r['entry_id'] not in seen;seen.add(r['entry_id']);assert r['split']==split and r['eligible_for_expansion_training']
  f=re.sub(r'[^a-z0-9]','',r['target'].lower());assert f not in fingerprints or split=='train','Duplicate crossed a candidate split'
 # Within-split duplicates are allowed; cross-split targets are not.
 fingerprints.update(re.sub(r'[^a-z0-9]','',r['target'].lower()) for r in rs)
 split_receipts[split]={'rows':len(rs),'sha256':hashlib.sha256((root/f'{split}.jsonl').read_bytes()).hexdigest()}
report={'covered_finalized_entries':len(rows),'history_links_checked':history_checks,'observed_pairs_checked':len(observed),'checks':['exact one-row-per-finalized-entry coverage','no target, same-day, future, draft, deleted or sibling-matter history','generation input hashes match frozen sources','assistant targets match source-derived targets','candidate IDs and duplicate targets do not cross temporal splits'],'splits':split_receipts}
(root/'coverage-receipt.json').write_text(json.dumps(report,indent=2));print(json.dumps(report,indent=2))
