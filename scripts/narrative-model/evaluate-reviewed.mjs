// Real app routes + real Ollama, isolated temporary DB. No production entries.
import {writeFileSync} from 'node:fs';
import {startTestServer} from '../../test/helpers.js';
import {setSetting} from '../../server/db.js';
import {NARRATIVE_POLICY} from '../../server/lib/narrativeProfile.js';
const fresh=process.argv.includes('--fresh');const final=process.argv.includes('--final')||fresh;const models=process.argv.slice(2).filter(x=>!['--final','--fresh'].includes(x));if(!models.length)models.push('timekeeper-narrative:v2','timekeeper-narrative:v3');
let cases=[
 {id:'call-license',input:'all hands call; prepare; messages with K. Rowe; confer with client',context:'This matter concerns an access license. K. Rowe is another lawyer at the firm. Current issues list concerns license revisions.',modes:['longer','regenerate','shorter']},
 {id:'review-settlement',input:'review settlement agreement; email client',context:'Negotiation of a settlement agreement. No specific provisions have been identified.',modes:['longer','regenerate']},
 {id:'revise-option',input:'revise option agreement per client comments; email T. Vale',context:'Negotiation of option agreement. T. Vale is the other attorney. Client has provided comments.',modes:['longer']},
 {id:'shorten-deed',input:'Review deed comments and prepare for and participate in call with client regarding outstanding deed issues; exchange messages with P. Hale regarding revisions to deed; confer with client regarding response to remaining comments.',context:'Deed negotiation.',modes:['shorter']},
 {id:'brief-status',input:'email client re status',context:'Client requested a status update on outstanding easement comments.',totalHours:.1,modes:['longer']},
 {id:'unknown-name',input:'call with Casey regarding survey; prepare for call',context:'Survey review. No surname is known for Casey.',modes:['longer']},
 {id:'no-context',input:'all hands call; prepare; messages with S. Voss; confer with client',modes:['longer']},
];
if(final)cases=[
 {id:'final-assignment-call',input:'all hands call; prepare; messages with R. Bell; confer with client',context:'Negotiation of an assignment agreement. R. Bell is another lawyer. The current issues list concerns assignment revisions.',modes:['longer','regenerate','shorter']},
 {id:'final-escrow-review',input:'review escrow agreement; email client',context:'Negotiation of an escrow agreement. No particular provisions are identified.',modes:['longer','regenerate']},
 {id:'final-indemnity-revisions',input:'revise indemnity agreement per client comments; email Q. North',context:'An indemnity agreement is being negotiated. Q. North is the other attorney. Client has provided comments.',modes:['longer']},
 {id:'final-financing-shorten',input:'Review financing agreement comments and prepare for call with client; participate in call regarding outstanding financing issues; exchange messages with O. Flint regarding revisions; confer with client regarding response to remaining comments.',context:'Financing agreement negotiation.',modes:['shorter']},
 {id:'final-permit-status',input:'email client re status',context:'Client requested a status update on outstanding permit comments.',totalHours:.1,modes:['longer']},
 {id:'final-unknown-name',input:'call with Evan regarding boundary survey; prepare for call',context:'Boundary survey review. No surname is known for Evan.',modes:['longer']},
 {id:'final-general-call',input:'all hands call; prepare; messages with U. Farrow; confer with client',modes:['longer']},
];
if(fresh)cases=[
 {id:'fresh-side-letter',input:'review side letter; email client',context:'Negotiation of side letter. No specific provisions identified.',modes:['longer','regenerate']},
 {id:'fresh-interconnection-call',input:'all hands call; prepare; messages with W. Gale; confer with client',context:'Interconnection agreement negotiation. W. Gale is another attorney. Current issues list concerns interconnection revisions.',modes:['longer','regenerate']},
 {id:'fresh-parking-license',input:'revise parking license per client comments; email Y. Hurst',context:'Parking license negotiation. Y. Hurst is the other attorney.',modes:['longer']},
 {id:'fresh-security-shorten',input:'Review security agreement comments and prepare for call with client; participate in call regarding outstanding security agreement issues; messages with Z. Chase regarding revisions; confer with client regarding response to remaining comments.',context:'Security agreement negotiation.',modes:['shorter']},
 {id:'fresh-zoning-call',input:'call with Avery regarding zoning; prepare for call',context:'Zoning discussion. No surname is known for Avery.',modes:['longer']},
 {id:'fresh-insurance-status',input:'email client re status',context:'Client requested status update on outstanding insurance comments.',totalHours:.1,modes:['longer']},
];
const all=[];
for(const model of models){
 const t=await startTestServer();
 try{
  setSetting(t.db,'ai',{enabled:true,model,url:'http://127.0.0.1:11434',systemPrompt:NARRATIVE_POLICY});
  for(const c of cases)for(const mode of c.modes){
   const body={mode,brief:c.input,narrative:c.input,context:c.context,totalHours:c.totalHours};
   const res=await t.fetchJson('POST','/api/ai/narrate',body);if(res.status!==200)throw Error(JSON.stringify(res));
   const events=res.body.raw.trim().split('\n').map(JSON.parse);const done=events.find(x=>x.done);if(!done)throw Error(JSON.stringify(events));
   const row={model,id:c.id,mode,input:c.input,context:c.context,output:done.narrative,activity_retry:events.find(x=>x.debug)?.debug.activity_retry||false,words:done.narrative.split(/\s+/).length};all.push(row);console.log(JSON.stringify(row));
  }
  if(final){
   const cm=await t.fetchJson('POST','/api/cms',{cm_number:'100001-000099',short_name:'Service agreement'});
   if(cm.status>=400)throw Error(JSON.stringify(cm));
   const entry=await t.fetchJson('POST','/api/entries',{date:'2026-11-03',cm_id:cm.body.id,narrative:'Review service agreement issues list; messages with V. Orme regarding service agreement revisions.'});
   if(entry.status>=400)throw Error(JSON.stringify(entry));
   const input='all hands call; prepare; messages with V. Orme; confer with client';
   const response=await t.fetchJson('POST','/api/ai/narrate',{mode:'longer',brief:input,narrative:input,cm_id:cm.body.id});
   if(response.status!==200)throw Error(JSON.stringify(response));
   const events=response.body.raw.trim().split('\n').map(JSON.parse);const done=events.find(x=>x.done);if(!done)throw Error(JSON.stringify(events));
   const row={model,id:'final-db-history',mode:'longer',input,context:'Actual temporary matter history: service agreement issues list and revisions.',output:done.narrative,activity_retry:events.find(x=>x.debug)?.debug.activity_retry||false,words:done.narrative.split(/\s+/).length};all.push(row);console.log(JSON.stringify(row));
  }
  const splitInput=final?'review plat; email client':'review title report; email client';
  const split=await t.fetchJson('POST','/api/ai/expand',{brief:splitInput,clauses:splitInput.split('; '),totalHours:.7});
  if(final){const unsplit=await t.fetchJson('POST','/api/ai/expand',{brief:splitInput,totalHours:.7});all.push({model,id:'final-unsplit-plat',response:unsplit});console.log(JSON.stringify({model,id:'final-unsplit-plat',response:unsplit}));}
  all.push({model,id:final?'final-split-plat':'split-title',response:split});console.log(JSON.stringify({model,id:'split-title',response:split}));
 }finally{await t.close();}
}
writeFileSync(fresh?'data/narrative-model/v3/fresh-route-evaluation.json':final?'data/narrative-model/v3/final-route-evaluation.json':'data/narrative-model/v3/route-evaluation.json',JSON.stringify(all,null,2));
