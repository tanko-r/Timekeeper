"""Verify split isolation, target completeness, names, and duration stripping."""
import json,re,hashlib
from pathlib import Path
root=Path('data/narrative-model/v2');seen=set();receipts={}
for split in ('train','valid','test'):
 path=root/f'{split}.jsonl';rows=[json.loads(l) for l in path.read_text().splitlines()]
 for r in rows:
  assert r['id'] not in seen;seen.add(r['id'])
  assert r['target'].endswith('.') and len(r['target'].split())>=4
  assert not re.search(r'\(\s*\d+(?:\.\d+)?\s*\)',r['target'])
  for name in re.findall(r'\b[A-Z]\.\s+[A-Z][a-z]+',r['target']): assert name.lower() in r['input'].lower(),r['id']
  assert r['messages'][-1]['content']==r['target']
 receipts[split]={'rows':len(rows),'sha256':hashlib.sha256(path.read_bytes()).hexdigest()}
calibration=root/'calibration-train.jsonl'
if calibration.exists():
 training_ids={json.loads(l)['id'] for l in (root/'train.jsonl').read_text().splitlines()}
 variants=[json.loads(l) for l in calibration.read_text().splitlines()]
 for r in variants:
  assert r['id'] in training_ids, 'Calibration crossed a split boundary'
  assert not re.search(r'\(\s*\d+(?:\.\d+)?\s*\)',r['target'])
  for name in re.findall(r'\b[A-Z]\.\s+[A-Z][a-z]+',r['target']):assert name.lower() in r['input'].lower()
 receipts['calibration']={'rows':len(variants),'source_ids':len({r['id'] for r in variants}),'sha256':hashlib.sha256(calibration.read_bytes()).hexdigest()}
(root/'data-check.json').write_text(json.dumps(receipts,indent=2));print(json.dumps(receipts,indent=2))
