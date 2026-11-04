// Preserve the explicit review step in shortened call narratives.
import {readFileSync,writeFileSync} from 'node:fs';
const root='data/narrative-model/v3';const rows=readFileSync(`${root}/train.jsonl`,'utf8').trim().split('\n').map(JSON.parse);
const corrected=rows.filter(r=>r.kind==='synthetic_authorized'&&r.id.endsWith('-0-shorter')).map(r=>({...r,messages:r.messages.map((m,i)=>i===r.messages.length-1?{...m,content:m.content.replace(/^Prepare for and participate in (.+?) negotiations call;/,'Review $1 issues list and prepare for and participate in $1 negotiations call;')}:m)}));
if(corrected.length!==10)throw Error('Expected ten synthetic call examples');
const approved=[...new Map(rows.filter(r=>r.kind==='approved_plain'||r.kind==='approved_split').map(r=>[`${r.id}-${r.kind}`,r])).values()];
writeFileSync(`${root}/shortening-calibration.jsonl`,[...corrected,...approved].map(r=>JSON.stringify(r)).join('\n')+'\n');
console.log('Prepared 20 correction/rehearsal rows; final evaluation cases excluded.');
