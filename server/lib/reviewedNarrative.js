import {calibratedMessages} from './narrativeProfile.js';
import {activityIssues} from './narrativeActivities.js';
import {containsTimeAmounts} from './timeAmounts.js';
export async function reviewedNarrative(cfg,args,signal) {
  const source=(args.mode==='longer'||args.mode==='shorter')?args.narrative:args.brief;
  for(let attempt=0;attempt<2;attempt++){
    const messages=calibratedMessages({...args,instructions:cfg.systemPrompt,...(attempt?{mode:'regenerate',brief:source,narrative:source}:{})});
    const temperature=attempt?0:0.2;
    const response=await fetch(`${cfg.url}/api/chat`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:cfg.model,messages,stream:false,think:false,keep_alive:'10m',options:{temperature}}),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(180_000)]):AbortSignal.timeout(180_000)});
    if(!response.ok)throw Error(`ollama returned ${response.status}`);
    const data=await response.json();
    const candidate=String(data.message?.content||'').trim().replace(/^Compose (?:a )?call\b/i,'Conduct call');
    if(candidate&&!/^[{[]/.test(candidate)&&data.done_reason!=='length'&&!containsTimeAmounts(candidate)&&activityIssues(source,candidate).ok)return {narrative:candidate,messages,temperature,activity_retry:!!attempt};
  }
  if(args.fallbackContext&&args.fallbackContext!==args.context){
    const result=await reviewedNarrative(cfg,{...args,context:args.fallbackContext,fallbackContext:undefined},signal);
    return {...result,activity_retry:true,context_retry:true};
  }
  const error=Error('The draft changed or omitted work. Please clarify the notes and try again.');error.code='ai_activity_mismatch';throw error;
}
export function reviewedTaskCode(text,codes){
 const proposed=/\b(?:revise|edit)\b/i.test(text)?'Revise':/\b(?:draft|compose)\b/i.test(text)?'Draft':/\bresearch\b/i.test(text)?'Research':/\b(?:review|analyze|rev|rna)\b/i.test(text)?'Review':/\b(?:email|messages?|correspond|send)\b/i.test(text)?'Correspondence':/\b(?:call|confer|meeting|conference)\b/i.test(text)?'Call/Conference':'Review';
 return codes.includes(proposed)?proposed:codes[0]||'';
}
export function reviewedFragments(sources,narrative){
  let fragments=narrative.replace(/[.;]+$/,'').split(';').map(x=>x.trim()).filter(Boolean);
  if(fragments.length!==sources.length){
    fragments=fragments.flatMap(x=>{
      const m=x.match(/^(Review .+? and )?prepare for and participate in (.+)$/i);
      return m?[`${m[1]||''}Prepare for ${m[2]}`.replace('and Prepare','and prepare'),`Participate in ${m[2]}`]:[x];
    });
  }
  if(fragments.length!==sources.length)return null;
  const remaining=[...fragments];const ordered=[];
  for(const source of sources){
    const choices=remaining.map((fragment,i)=>({i,issues:activityIssues(source,fragment)})).filter(x=>!x.issues.missing.length).sort((a,b)=>a.issues.added.length-b.issues.added.length);
    if(!choices.length)return null;
    ordered.push(remaining.splice(choices[0].i,1)[0]);
  }
  return ordered;
}
