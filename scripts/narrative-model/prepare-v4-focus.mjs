// User-authorized synthetic calibration. All real source rows are train-only.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';import {historyNames,containsMatterFact} from '../../server/lib/matterHistory.js';import {calibratedMessages,NARRATIVE_POLICY} from '../../server/lib/narrativeProfile.js';
const root='data/narrative-model/v4',out=`${root}/focus`;mkdirSync(out,{recursive:true});
const read=p=>readFileSync(p,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const people=['K. Vale','M. Orton','P. Wren','R. Sayer','T. Arden','L. Keene','C. Hollis','N. Ellery','B. Marlow','A. Dacre','E. Penrose','G. Larkin','F. Corbin','H. Hadley','I. Lennox','O. Fenwick','Q. North','S. Mercer','U. Alder','V. Flint'];
const training=read(`${root}/train.jsonl`).filter(r=>r.kind==='matter_grounded'&&r.target_words>=18&&r.synthetic_shorthand.split(';').length>=3);
const variants=[];
for(const r of training){
 const names=[...new Set(historyNames(r.target).map(n=>n.replace(/['’]s$/i,'')))].filter(n=>containsMatterFact(r.synthetic_shorthand.replace(/\(refs:[^)]*\)/g,''),n));
 if(!names.length)continue;
 const replacements=names.map((n,i)=>[n,people[(variants.length*7+i*3)%people.length]]);
 let messages=JSON.parse(JSON.stringify(r.messages));
 for(const [name,replacement] of replacements){
  const initial=name[0],surname=name.slice(2).trim().replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  const pattern=new RegExp(`\\b${initial}\\.?\\s*${surname}\\b`,'gi');
  messages=messages.map(m=>({...m,content:m.content.replace(pattern,replacement)}));
 }
 variants.push({id:`name-variant-${r.entry_id}`,kind:'train_only_counterfactual_names',source_entry_id:r.entry_id,replacements,messages});
 if(variants.length===40)break;
}
const docs=[['Harbor Ground Lease','Cedar Master Services Agreement'],['Birch Access License','Meadow Utility Easement'],['Summit Development Agreement','Bayview Reimbursement Agreement'],['Willow Purchase Agreement','Maple Option Agreement'],['Canyon Construction Agreement','Orchard Operating Agreement'],['Aspen Sublease','Pine Right of Entry Agreement']];
let n=0;
for(const pair of docs)for(const direction of [0,1]){
 const old=pair[direction],current=pair[1-direction],person=people[n%people.length];
 const context=`Prior finalized work on this exact matter:\n- 2026-09-01 [entry 1]: Review ${old}; messages with Z. Rook.\n- 2026-09-15 [entry 2]: Receive and review ${current} and prepare issues list.\n- 2026-09-18 [entry 3]: Confer with Z. Rook regarding outstanding ${current} comments.\n${person} is the client contact for this request.`;
 const input=`review document; email ${person}`;
 const target=`Review and analyze ${current} and identify issues requiring client input; compose email to ${person} outlining issues and requesting direction regarding proposed revisions.`;
 variants.push({id:`context-contrast-${n++}`,kind:'approved_pattern_synthetic_context_contrast',messages:[...calibratedMessages({mode:'longer',brief:input,narrative:input,context}),{role:'assistant',content:target}]});
}
for(let i=0;i<8;i++){
 const doc=docs[i%docs.length][i%2],names=[0,1,2,3].map(j=>people[(i*2+j)%people.length]);
 const input=`all hands call; prepare; messages with ${names[0]}, ${names[1]} and ${names[2]}; confer with ${names[3]}`;
 const context=`This matter concerns ${doc} negotiations. Current issues list concerns ${doc} revisions. ${names.slice(0,3).join(', ')} are other lawyers; ${names[3]} is the client contact.`;
 const target=`Review ${doc} issues list and prepare for all-hands negotiations call; participate in call regarding outstanding ${doc} issues; messages with ${names[0]}, ${names[1]} and ${names[2]} regarding issues raised during call; confer with ${names[3]} regarding negotiating approach and proposed response.`;
 variants.push({id:`named-call-${i}`,kind:'approved_call_pattern_synthetic_names',messages:[...calibratedMessages({mode:'longer',brief:input,narrative:input,context}),{role:'assistant',content:target}]});
}
const approved=read('data/narrative-model/v3/attempt-approved-only/train.jsonl').filter(r=>r.kind==='approved_plain');
const shortening=read('data/narrative-model/v3/shortening-calibration.jsonl').filter(r=>r.kind==='synthetic_authorized');
const noContext=read('data/narrative-model/v3/train.jsonl').filter(r=>String(r.id).includes('no-context'));
const rows=[...variants,...approved,...shortening,...noContext].map((r,i)=>({...r,id:`focus-${i}`}));
const reserved=new Set([...read(`${root}/valid.jsonl`),...read(`${root}/test.jsonl`)].map(r=>r.target.toLowerCase().replace(/[^a-z0-9]/g,'')));
for(const r of rows)if(reserved.has(r.messages.at(-1).content.toLowerCase().replace(/[^a-z0-9]/g,'')))throw Error('Reserved target duplicated in focus training');
writeFileSync(`${out}/train.jsonl`,rows.map(r=>JSON.stringify(r)).join('\n')+'\n');for(const split of ['valid','test'])writeFileSync(`${out}/${split}.jsonl`,readFileSync(`${root}/${split}.jsonl`));writeFileSync(`${out}/system.txt`,NARRATIVE_POLICY);writeFileSync(`${out}/manifest.json`,JSON.stringify({rows:rows.length,real_sources:'Train-only sources; names replaced consistently in inputs, context and targets.',synthetic_patterns:'Approved review/email and all-hands call patterns; different document histories and typed participants.',rehearsal:approved.length+shortening.length+noContext.length},null,2));console.log('Prepared focus rows:',rows.length);
