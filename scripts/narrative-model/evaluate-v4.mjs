import {reviewedNarrative} from '../../server/lib/reviewedNarrative.js';
// Raw deployed-runtime comparison: identical stored prompts, no activity retry.
import {readFileSync,writeFileSync} from 'node:fs';import {activityIssues} from '../../server/lib/narrativeActivities.js';import {historyNames,containsMatterFact} from '../../server/lib/matterHistory.js';import {containsTimeAmounts} from '../../server/lib/timeAmounts.js';
const argv=process.argv.slice(2),split=argv.includes('--test')?'test':'valid',guarded=argv.includes('--guarded'),label=(argv.includes('--guarded')?'guarded-':'')+split,models=argv.filter(x=>!x.startsWith('--'));if(!models.length)models.push('timekeeper-narrative:v3');
const root='data/narrative-model/v4',rows=readFileSync(`${root}/${split}.jsonl`,'utf8').trim().split('\n').map(JSON.parse);const results=[];
for(const model of models){
 const output=[];
 for(const r of rows){
  const started=Date.now();let answer;
  try {
   if(guarded){
    const generated=await reviewedNarrative({model,url:'http://127.0.0.1:11434',systemPrompt:r.messages[0].content},{mode:'longer',brief:r.synthetic_shorthand,narrative:r.synthetic_shorthand,context:r.context});
    answer={message:{content:generated.narrative},done_reason:'stop',activity_retry:generated.activity_retry};
   }else{
   const response=await fetch('http://127.0.0.1:11434/api/chat',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model,messages:r.messages.slice(0,-1),stream:false,think:false,keep_alive:'15m',options:{temperature:0,seed:46,num_ctx:4096,num_predict:768}}),signal:AbortSignal.timeout(180000)});
   if(!response.ok)throw Error(`HTTP ${response.status}`);answer=await response.json();
   }
   const text=answer.message.content.trim(),input=r.synthetic_shorthand,evidence=input+' '+(r.history||[]).map(x=>x.narrative).join(' ')+' '+(r.matter?.short_name||'');
   const missingNames=historyNames(r.target).filter(n=>containsMatterFact(input,n)&&!containsMatterFact(text,n));
   const inventedNames=historyNames(text).filter(n=>!containsMatterFact(evidence,n));
   const recoveries=(r.earlier_context_recoveries||[]).map(x=>({fact:x.fact,recovered:containsMatterFact(text,x.fact)}));
   const metrics={words:text.split(/\s+/).length,input_words:r.note_words,target_words:r.target_words,activity:activityIssues(input,text),missing_names:missingNames,invented_names:inventedNames,time_amounts:containsTimeAmounts(text),context_recoveries:recoveries,truncated:answer.done_reason==='length'};
   const result={model,activity_retry:!!answer.activity_retry,entry_id:r.entry_id,input,context:r.context,target:r.target,output:text,metrics,seconds:(Date.now()-started)/1000};output.push(result);results.push(result);console.log(JSON.stringify(result));
  }catch(e){const result={model,entry_id:r.entry_id,error:e.message};output.push(result);results.push(result);console.log(JSON.stringify(result));}
 }
 writeFileSync(`${root}/${label}-${model.replaceAll(':','_')}.json`,JSON.stringify(output,null,2));
}
const summary={};for(const model of models){const rs=results.filter(r=>r.model===model),ok=rs.filter(r=>r.metrics);const median=xs=>{xs.sort((a,b)=>a-b);return xs.length?xs[Math.floor(xs.length/2)]:null;};summary[model]={n:rs.length,errors:rs.length-ok.length,activity_pass:ok.filter(r=>r.metrics.activity.ok).length,missing_name_cases:ok.filter(r=>r.metrics.missing_names.length).length,invented_name_cases:ok.filter(r=>r.metrics.invented_names.length).length,time_amount_cases:ok.filter(r=>r.metrics.time_amounts).length,truncated:ok.filter(r=>r.metrics.truncated).length,median_words:median(ok.map(r=>r.metrics.words)),context_facts_available:rows.reduce((n,r)=>n+(r.earlier_context_recoveries||[]).length,0),context_facts_recovered:ok.reduce((n,r)=>n+r.metrics.context_recoveries.filter(x=>x.recovered).length,0)};}
writeFileSync(`${root}/${label}-summary-${models.map(x=>x.replaceAll(':','_')).join('-')}.json`,JSON.stringify(summary,null,2));console.log(JSON.stringify(summary));
