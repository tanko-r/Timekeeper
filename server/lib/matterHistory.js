// Source-grounded context shared by live requests and historical pair export.
const STOP=new Set('the and with from regarding same review analyze prepare draft revise client email messages call confer agreement document work issues comments proposed revisions for per this that into'.split(' '));
export function containsMatterFact(text,fact){
 if(/\d/.test(fact)&&! /\s/.test(fact)){
   const escaped=fact.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
   return new RegExp(`(?<![\\p{L}\\d])${escaped}(?![\\p{L}\\d])`,'iu').test(text);
 }
 const fold=s=>String(s||'').toLowerCase().replace(/[^\p{L}\d]/gu,'');
 return fold(text).includes(fold(fact));
}
export function cleanMatterNarrative(text){
 let t=String(text||'').replace(/\s+/g,' ').trim();let before;
 do{before=t;t=t.replace(/^(?:FLAT FEE|WRITE OFF)\b\s*/i,'').replace(/^\([A-Z0-9 .–-]{2,30}\)\s*/,'');}while(t!==before);
 return t.replace(/\s*\(\s*\d+(?:\.\d+)?\s*\)/g,'').trim();
}
export function historyTerms(text){return [...new Set((String(text).toLowerCase().match(/[\p{L}\d][\p{L}\d'-]{2,}/gu)||[]).filter(x=>!STOP.has(x)))];}
export function historyNames(text){return [...new Set(String(text).match(/\b[A-Z]\.\s+[A-Za-z][\p{L}'’-]+/gu)||[])];}
export function matterHistory(db,matterId,{brief='',beforeDate,throughDate,excludeEntryId=0,maxChars=3600}={}){
 if(!matterId)return {text:null,entries:[],people:[]};
 const matter=db.prepare('SELECT id,cm_number,short_name FROM matters WHERE id=?').get(matterId);
 if(!matter)return {text:null,entries:[],people:[]};
 const dateFilter=beforeDate?'AND date < @cutoff':throughDate?'AND date <= @cutoff':'';
 const pool=db.prepare(`SELECT id,date,narrative,narrative_ai FROM entries WHERE cm_id=@matterId AND status='finalized' AND deleted_at IS NULL AND id!=@excludeEntryId ${dateFilter} ORDER BY date DESC,id DESC`).all({matterId,excludeEntryId,...(beforeDate||throughDate?{cutoff:beforeDate||throughDate}:{})}).map(r=>({...r,narrative:cleanMatterNarrative(r.narrative)})).filter(r=>r.narrative);
 const query=historyTerms(brief);const frequency=new Map();
 for(const r of pool)for(const term of historyTerms(r.narrative))frequency.set(term,(frequency.get(term)||0)+1);
 const relevant=pool.map((r,index)=>{const terms=new Set(historyTerms(r.narrative));return {r,index,score:query.reduce((n,t)=>n+(terms.has(t)?1+Math.log(1+pool.length/(frequency.get(t)||1)):0),0)};}).filter(x=>x.score>0).sort((a,b)=>b.score-a.score||a.index-b.index).slice(0,4).map(x=>x.r);
 // Include recent chronology as well as older work matching the actual shorthand.
 const candidates=[...new Map([...pool.slice(0,4),...relevant].map(r=>[r.id,r])).values()];
 const identity=`Matter: ${matter.cm_number}${matter.short_name?' — '+matter.short_name:''}.`;
 let used=identity.length+350;const entries=[];
 for(const r of candidates){if(used+r.narrative.length+45>maxChars)continue;entries.push(r);used+=r.narrative.length+45;}
 entries.sort((a,b)=>a.date.localeCompare(b.date)||a.id-b.id);
 const hidden=new Set(db.prepare("SELECT lower(name) AS name FROM matter_entities WHERE kind='person' AND hidden=1 AND (matter_id=? OR matter_id IS NULL)").all(matterId).map(r=>r.name));
 const historyText=entries.map(r=>r.narrative).join(' ');
 const canonical=db.prepare('SELECT name FROM matter_people WHERE matter_id=?').all(matterId).map(r=>r.name).filter(n=>containsMatterFact(historyText,n));
 const names=[...new Set([...entries.flatMap(r=>historyNames(r.narrative)),...canonical])];
 const people=names.filter(n=>!hidden.has(n.toLowerCase())&&!names.some(other=>other.toLowerCase().startsWith(n.toLowerCase()+' '))).slice(0,24);
 const parts=[identity];
 if(entries.length)parts.push('Prior finalized work on this exact matter (context for the subject, not a claim that these activities happened again):\n'+entries.map(r=>`- ${r.date} [entry ${r.id}]: ${r.narrative}`).join('\n'));
 else parts.push('No earlier finalized work is available for this matter. Keep an unknown subject general.');
 if(people.length)parts.push('Names used in this history: '+people.join(', ')+'.');
 if(parts.join('\n\n').length>maxChars&&people.length)parts.pop();
 return {text:parts.join('\n\n'),entries,people,matter,pool_count:pool.length};
}
