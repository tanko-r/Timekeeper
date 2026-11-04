// User authorized synthetic examples based on the approved edits, 2026-11-03.
import {readFileSync,writeFileSync,mkdirSync,renameSync,existsSync} from 'node:fs';
import {buildNarrateMessages,systemPrompt} from '../../server/routes/ai.js';
import {NARRATIVE_MODEL} from '../../server/lib/narrativeProfile.js';
const root='data/narrative-model/v3';
const current=readFileSync(`${root}/train.jsonl`,'utf8').trim().split('\n').map(JSON.parse);
const approved=[...new Map(current.filter(r=>r.kind==='approved_plain'||r.kind==='approved_split').map(r=>[`${r.id}-${r.kind}`,r])).values()];
if(approved.length!==10)throw Error('Run prepare-reviewed.mjs with seven approved examples first.');
const archive=`${root}/attempt-approved-only`;mkdirSync(archive,{recursive:true});
for(const name of ['train.jsonl','manifest.json','training-report.json','adapter','epoch-2','epoch-4','epoch-6','route-evaluation.json','evaluate.log'])if(existsSync(`${root}/${name}`)&&!existsSync(`${archive}/${name}`))renameSync(`${root}/${name}`,`${archive}/${name}`);

const topics=[['utility easement','easement','A. Mercer'],['construction agreement','construction','B. Arden'],['purchase agreement','purchase','C. Sayer'],['ground lease','lease','D. Wren'],['license agreement','license','E. Ellery'],['development agreement','development','F. Hadley'],['option agreement','option','G. Corbin'],['reimbursement agreement','reimbursement','H. Fenwick'],['sublease','sublease','I. Lennox'],['right of entry agreement','access','J. Marlow']];
const rows=[];
for(const [doc,subject,person] of topics){
 const context=`Negotiation of ${doc}. ${person} is another attorney. The current issues list concerns ${subject} revisions. No specific provisions or agreed outcomes are identified.`;
 const patterns=[
  {input:`all hands call; prepare; messages with ${person}; confer with client`,expand:`Review ${subject} issues list and prepare for all-hands negotiations call; participate in call regarding outstanding ${subject} issues; messages with ${person} regarding issues raised during call; confer with client regarding negotiating approach and proposed response to remaining ${subject} issues.`,rewrite:`Prepare for and participate in all-hands call regarding ${subject} negotiations; correspond with ${person} regarding ${subject} issues; confer with client regarding negotiating strategy.`,shorten:`Review ${subject} issues list and prepare for and participate in ${subject} negotiations call; messages with ${person}; confer with client regarding strategy.`},
  {input:`review ${doc}; email client`,expand:`Review and analyze ${doc} and identify issues requiring client input; compose email to client outlining ${subject} issues and requesting direction regarding proposed revisions.`,rewrite:`Review ${doc}; correspond with client regarding issues and proposed revisions.`,shorten:`Review ${doc}; email client regarding issues.`},
  {input:`revise ${doc} per client comments; email ${person}`,expand:`Review client comments regarding ${doc} and revise document to address same; compose email to ${person} transmitting revised ${doc} and explaining proposed changes.`,rewrite:`Revise ${doc} per client comments; email ${person} regarding revised document.`,shorten:`Revise ${doc} per client comments; email revised document to ${person}.`},
  {input:'email client re status',expand:`Compose email to client regarding status of outstanding ${subject} comments and anticipated response.`,rewrite:`Email client regarding status of outstanding ${subject} comments.`,shorten:`Email client regarding outstanding ${subject} comments.`,totalHours:.1},
 ];
 for(const [pattern,p] of patterns.entries())for(const [mode,key] of [['longer','expand'],['regenerate','rewrite'],['shorter','shorten']]){
  const input=mode==='shorter'?p.expand:p.input;
  const ctx=pattern===3?`Client requested a status update on outstanding ${subject} comments.`:context;
  rows.push({id:`synthetic-${subject}-${pattern}-${mode}`,kind:'synthetic_authorized',basis:'Approved examples 2–7; synthetic variation authorized by user.',mode,messages:[...buildNarrateMessages({model:NARRATIVE_MODEL,mode,brief:input,narrative:input,context:ctx,totalHours:p.totalHours}),{role:'assistant',content:p[key]}]});
 }
}
// Explicitly generalize the approved contextual placeholder when no subject is known.
const template=JSON.parse(readFileSync(`${root}/approved.json`,'utf8')).find(r=>r.id===1);
for(const person of ['K. Dacre','L. Hollis','M. Keene','N. Larkin']){
 const input=`all hands call; prepare; messages with ${person}; confer with client`;
 const target=template.target.replace(' on lease negotiations','').replaceAll('J. Romero',person);
 rows.push({id:`synthetic-no-context-${person}`,kind:'synthetic_authorized',basis:'Example 1 template with unknown subject omitted.',messages:[...buildNarrateMessages({model:NARRATIVE_MODEL,mode:'longer',brief:input,narrative:input}),{role:'assistant',content:target}]});
}
rows.push(...approved,...approved);
writeFileSync(`${root}/train.jsonl`,rows.map(r=>JSON.stringify(r)).join('\n')+'\n');
writeFileSync(`${root}/manifest.json`,JSON.stringify({source:'Approved edits plus explicit user authorization for synthetic variants',approved_rows:approved.length,approved_repetitions:2,synthetic_rows:rows.length-approved.length*2,training_rows:rows.length,held_out:'No final evaluation examples are included. Earlier route probes are development cases after inspection.'},null,2));
console.log(`Prepared ${rows.length} mode-aware training rows.`);
