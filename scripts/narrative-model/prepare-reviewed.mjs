import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {buildNarrateMessages,systemPrompt} from '../../server/routes/ai.js';
import {NARRATIVE_MODEL,NARRATIVE_POLICY} from '../../server/lib/narrativeProfile.js';
const source=readFileSync('docs/ai/narrative-training-review.md','utf8');
if(!/Overall decision: \*\*Approved(?: as edited)?\*\*/.test(source)) throw Error('Overall approval required');
const out='data/narrative-model/v3';mkdirSync(out,{recursive:true});
const rows=[];const examples=[];
for(const block of source.split(/(?=^## \d+\.)/m).slice(1)){
 const id=Number(block.match(/^## (\d+)/)[1]);
 if(!/Decision: \*\*Approved(?: as edited)?\*\*/.test(block)) continue;
 const field=(name)=>block.match(new RegExp(`\\*\\*${name}:\\*\\*\\s*\\n\\n> ([^\\n]+)`))?.[1];
 const input=field('Input');let target=field('Target narrative');
 let context=block.match(/\*\*Available context:\*\* ([^\n]+)/)?.[1];
 const action=block.match(/\*\*Action:\*\* (\w+)/)?.[1];
 if(!input||!target||!context||!action)throw Error(`Incomplete example ${id}`);
 let transformation=null;
 if(id===1){context='Prior matter entries concern lease negotiations.';target=target.replace('[lease negotiations]','lease negotiations');transformation='Resolve the approved contextual placeholder using explicit prior-entry context; no no-context lease assertion is taught.';}
 if(id===5)context='Lease negotiation. J. Romero is another lawyer at the firm.';
 if(context==='None.')context=null;
 const mode={Expand:'longer',Rewrite:'regenerate',Shorten:'shorter'}[action];
 const totalHours=id===7?.1:undefined;
 const args={model:NARRATIVE_MODEL,mode,brief:input,narrative:input,context,totalHours};
 rows.push({id,kind:'approved_plain',mode,messages:[...buildNarrateMessages(args),{role:'assistant',content:target}]});
 examples.push({id,input,target,context,action,transformation});
 // Structural conversion of approved prose into one task per input clause.
 if([3,4,7].includes(id)){
  const fragments=target.replace(/\.$/,'').split('; ');const codes=['Review','Draft','Revise','Research','Correspondence','Call/Conference','Negotiate','Travel','Court Appearance','Due Diligence','Closing'];
  const tasks=fragments.map((fragment,i)=>({task_code:id===7?'Correspondence':i===0?(id===4?'Revise':'Review'):'Correspondence',fragment,share:1/fragments.length}));
  rows.push({id,kind:'approved_split',messages:[{role:'system',content:systemPrompt(codes,null,null,{clauseCount:0,model:NARRATIVE_MODEL})},{role:'user',content:[context,`Work done: ${input}`].filter(Boolean).join('\n\n')},{role:'assistant',content:JSON.stringify({narrative:target,tasks})}]});
 }
}
writeFileSync(`${out}/train.jsonl`,rows.map(r=>JSON.stringify(r)).join('\n')+'\n');
writeFileSync(`${out}/approved.json`,JSON.stringify(examples,null,2));
writeFileSync(`${out}/system.txt`,NARRATIVE_POLICY);
writeFileSync(`${out}/manifest.json`,JSON.stringify({source:'docs/ai/narrative-training-review.md',sha256:createHash('sha256').update(source).digest('hex'),approved_examples:examples.length,training_rows:rows.length,rule:'Approved targets only; contextual template resolved explicitly; JSON variants are structural conversions. No unapproved synthetic targets.'},null,2));
console.log(`Prepared ${rows.length} rows from ${examples.length} approved examples.`);
