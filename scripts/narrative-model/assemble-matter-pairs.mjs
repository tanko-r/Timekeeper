import Database from 'better-sqlite3';import {readFileSync,writeFileSync} from 'node:fs';import {createHash} from 'node:crypto';
import {matterHistory,historyNames,containsMatterFact} from '../../server/lib/matterHistory.js';import {calibratedMessages} from '../../server/lib/narrativeProfile.js';import {activityIssues} from '../../server/lib/narrativeActivities.js';
const root=process.env.TK_PAIR_DIR||'data/narrative-model/matter-pairs-2026-11-04';const db=new Database(`${root}/source.db`,{readonly:true});
const sources=readFileSync(`${root}/sources.jsonl`,'utf8').trim().split('\n').map(JSON.parse);
const cache=new Map(readFileSync(`${root}/generation-cache.jsonl`,'utf8').trim().split('\n').filter(Boolean).map(x=>{const r=JSON.parse(x);return [r.entry_id,r];}));
const fold=s=>String(s||'').toLowerCase().replace(/[^\p{L}\d]/gu,'');
const has=containsMatterFact;
function documentNames(text){
 const found=text.match(/\b(?:[A-Z][A-Za-z'-]*|of|and|to|the|\d+(?:st|nd|rd|th)?)(?:\s+(?:[A-Z][A-Za-z'-]*|of|and|to|the|\d+(?:st|nd|rd|th)?)){0,7}\s+(?:Agreement|Amendment|Lease|License|Easement|Memorandum|Addendum|Letter|Opinion|Checklist|Commitment)\b/g)||[];
 return found.map(x=>x.replace(/^(?:(?:Review|Analyze|Draft|Revise|Prepare|Finalize|Conduct|and|the|Additional|Continue|Conducting)\s+)+/g,'')).filter(x=>x.split(/\s+/).length>1);
}
function fallback(text){return text.replace(/Review and analyze/gi,'review').replace(/Review and revise/gi,'review/revise').replace(/regarding/gi,'re').replace(/messages/gi,'msgs').replace(/with/gi,'w').replace(/Prepare/gi,'prep').replace(/\.$/,'');}
const all=[];
for(const source of sources){
 const g=cache.get(source.id);const repairs=[];const warnings=[];
 const target=source.target?source.target.replace(/[.;\s]+$/,'')+'.':'';
 let shorthand=(g?.shorthand||fallback(target)).replace(/\s+/g,' ').trim().replace(/[.;]+$/,'');
 let ctx=matterHistory(db,source.cm_id,{beforeDate:source.date,brief:shorthand});
 const sourceSpecifics=[...new Set([...documentNames(target),...(target.match(/\b(?:agreements?|amendments?|easements?|leases?|licenses?|memorandum|memoranda|opinions?|deeds?|surveys?|addendum|addenda|exhibits?|letters?|handbooks?|checklists?|MOU|RNDA|OAI|PSA)\b/gi)||[]),...source.source_entities.filter(e=>e.kind==='document').map(e=>e.name),...(target.match(/\b[A-Za-z]*\d+[A-Za-z\d-]*\b/g)||[])])];
 const historyMaterial=()=>ctx.entries.map(r=>r.narrative).join(' ');
 const required=[];
 for(const fact of sourceSpecifics){if((fact.length>1||/^\d$/.test(fact))&&!has(shorthand,fact)&&!has(historyMaterial(),fact))required.push(fact);}
 // People stay in the notes: a roster alone does not identify today's participants.
 for(const name of source.people){const surname=name.replace(/^[A-Z]\.\s*/,'');if(!has(shorthand,name)&&!has(shorthand,surname))required.push(name);else if(!has(shorthand,name)&&!has(historyMaterial(),name))required.push(name);}
 for(const e of source.source_entities.filter(e=>e.kind==='org'&&!/^(?:seller'?s?|buyer'?s?|landlord'?s?|tenant'?s?|client'?s?|lender'?s?|borrower'?s?|city|county|counsel)$/i.test(e.name)))if(!has(shorthand,e.name)&&!has(historyMaterial(),e.name))required.push(e.name);
 if(required.length){const refs=[...new Set(required)];shorthand+=' (refs: '+refs.join(', ')+')';repairs.push({kind:'supplied_specifics',facts:refs,reason:'Not supplied by this shorthand and its earlier-day context. Explicit input facts, not invented history.'});}
 if(/\bprepare for and (?:participate|attend|conduct)/i.test(target)&&!/\b(?:prep|prepare)\b/i.test(shorthand)){shorthand='prep; '+shorthand;repairs.push({kind:'preserve_preparation'});}
 ctx=matterHistory(db,source.cm_id,{beforeDate:source.date,brief:shorthand});
 const targetWords=target.split(/\s+/).filter(Boolean).length;const noteWords=shorthand.split(/\s+/).filter(Boolean).length;
 const ratio=targetWords?noteWords/targetWords:null;
 const issues=activityIssues(target,shorthand);
 // Reviewing comments is an implicit step within revisions, not necessarily a separate shorthand task.
 const missing=issues.missing.filter(x=>!(x==='review'&&/\b(?:revise|revise\/review|review\/revise)\b/i.test(shorthand)));
 if(!g)warnings.push('generation_pending');else if(g.status!=='model_generated')warnings.push('generation_failed_fallback');
 if(!target)warnings.push('empty_source');
 if(/\b(?:regarding|with|and|to|for|from|of)\s*[;.]/i.test(target))warnings.push('incomplete_source');
 if(/\.[a-z]{3,}\./.test(target))warnings.push('possible_source_typo');
 if(/^(?:Reviewed|Revised|Drafted|Prepared|Called|Conducted|Attended|Analyzed|Finalized)\b/.test(target))warnings.push('past_tense_source');
 if(targetWords<6)warnings.push('short_target_style_only');
 if(ratio>.8)warnings.push('limited_compression');
 if(missing.length)warnings.push('activity_missing_in_shorthand');
 if(issues.added.length)warnings.push('extra_activity_in_shorthand');
 if(/\band\s+(?:revisions|drafting|preparation)\s+(?:to|of|for)\b/i.test(target))warnings.push('ambiguous_nominal_activity');
 const generic=new Set('Review Analyze Draft Revise Prepare Finalize Conduct Confer Call Email Emails Messages Communications Coordinate Discuss Attend Follow Continue Compile Respond Provide Additional Meet Work City County Seller Landlord Tenant Client Counsel LLC LLP Inc The This For And State Risk Agreement Amendment Lease License Easement Memorandum Opinion Exhibit Letter Survey Communicate Compose Correspondence Comprehensive General Internal Closely Final Revisions Arrange Request Close Message Participate'.toLowerCase().split(' '));
 const namedWords=[...new Set(target.match(/\b(?:[A-Z][a-z][A-Za-z’-]{2,}|[A-Z]{2,})\b/g)||[])].filter(x=>!generic.has(x.toLowerCase()));
 const unsupportedNames=namedWords.filter(x=>!has(shorthand,x)&&!has(historyMaterial(),x));
 if(unsupportedNames.length)warnings.push('named_detail_not_supplied');
 if(/\b(?:WRITE\s+OFF|MOVE\s+TO|PARTIAL|FLAT\s+FEE)\b/i.test(target))warnings.push('source_record_instruction');
 if(source.narrative_ai)warnings.push('ai_origin_finalized_target');
 const supported=[];const unsupported=[];
 for(const fact of [...source.people,...sourceSpecifics]){
  const inNote=has(shorthand,fact), evidence=ctx.entries.filter(r=>has(r.narrative,fact)).map(r=>r.id);
  if(!inNote&&evidence.length)supported.push({fact,history_entry_ids:evidence});
  else if(!inNote&&!evidence.length)unsupported.push(fact);
 }
 if(unsupported.length)warnings.push('specific_fact_missing');
 const overlap=ctx.entries.filter(r=>fold(r.narrative)===fold(target)).map(r=>r.id);
 if(overlap.length)warnings.push('target_repeats_earlier_entry');
 const observed=source.ai_brief?.trim()||null;
 all.push({entry_id:source.id,date:source.date,matter_id:source.cm_id,matter:source.matter,raw_target:source.raw_narrative,target,synthetic_shorthand:shorthand,model_shorthand:g?.shorthand||null,observed_brief:observed,generation_status:g?.status||'pending',generator:g?.model||null,context:ctx.text,history:ctx.entries.map(r=>({entry_id:r.id,date:r.date,narrative:r.narrative})),people:ctx.people,earlier_context_recoveries:supported,unsupported_specifics:unsupported,unsupported_named_words:unsupportedNames,repairs,warnings,activity_audit:{missing,added:issues.added},note_words:noteWords,target_words:targetWords,compression_ratio:ratio,eligible_for_expansion_training:warnings.length===0,messages:[...calibratedMessages({mode:'longer',brief:shorthand,narrative:shorthand,context:ctx.text}),{role:'assistant',content:target}]});
}
// Split whole dates chronologically; duplicate targets cannot straddle splits.
const dates=[...new Set(all.map(r=>r.date))].sort();const trainEnd=dates[Math.floor(dates.length*.8)],validEnd=dates[Math.floor(dates.length*.9)];
const fingerprintSplits=new Map();
for(const r of all){let split=r.date<trainEnd?'train':r.date<validEnd?'valid':'test';const fingerprint=fold(r.target);if(fingerprintSplits.has(fingerprint)&&fingerprintSplits.get(fingerprint)!==split){r.warnings.push('duplicate_crosses_temporal_split');r.eligible_for_expansion_training=false;}else fingerprintSplits.set(fingerprint,split);r.split=split;}
function save(name,rows){writeFileSync(`${root}/${name}.jsonl`,rows.map(r=>JSON.stringify(r)).join('\n')+'\n');}
save('all-pairs',all);for(const split of ['train','valid','test'])save(split,all.filter(r=>r.split===split&&r.eligible_for_expansion_training));
save('observed-pairs',all.filter(r=>r.observed_brief).map(r=>({...r,synthetic_shorthand:undefined,messages:[...calibratedMessages({mode:'longer',brief:r.observed_brief,narrative:r.observed_brief,context:matterHistory(db,r.matter_id,{beforeDate:r.date,brief:r.observed_brief}).text}),{role:'assistant',content:r.target}],pair_kind:'observed_original_brief',eligible_for_expansion_training:undefined})));
const warnings={};for(const r of all)for(const w of r.warnings)warnings[w]=(warnings[w]||0)+1;
const manifest={source_finalized:all.length,generated:all.filter(r=>r.generation_status==='model_generated').length,pending:all.filter(r=>r.generation_status==='pending').length,observed_pairs:all.filter(r=>r.observed_brief).length,eligible:all.filter(r=>r.eligible_for_expansion_training).length,without_prior_history:all.filter(r=>!r.history.length).length,context_recovery_pairs:all.filter(r=>r.earlier_context_recoveries.length).length,matters:new Set(all.map(r=>r.matter_id).filter(Boolean)).size,unassigned_entries:all.filter(r=>!r.matter_id).length,warning_counts:warnings,split_counts:Object.fromEntries(['train','valid','test'].map(s=>[s,all.filter(r=>r.split===s&&r.eligible_for_expansion_training).length])),split_boundaries:{train_before:trainEnd,validation_before:validEnd},limitations:['Synthetic notes are reverse-generated, not genuine shorthand.','Historical context is strictly earlier-day finalized work on the exact matter; current matter labels and entity metadata come from the frozen snapshot.','Automatic support/activity checks are heuristic, not semantic entailment proof.','Date splits are chronological, but base v3 may already have seen older entries; this is not a pristine base-model benchmark.','Every finalized entry remains in all-pairs, including review-only cases.','Training files contain only unflagged candidates; human review remains valuable.'],hashes:{sources:createHash('sha256').update(readFileSync(`${root}/sources.jsonl`)).digest('hex')}};
writeFileSync(`${root}/manifest.json`,JSON.stringify(manifest,null,2));
const review=[...all.filter(r=>r.eligible_for_expansion_training&&r.earlier_context_recoveries.length).sort((a,b)=>b.target_words-a.target_words).slice(0,12),...all.filter(r=>r.warnings.length&&!r.warnings.includes('generation_pending')).slice(-8)];
writeFileSync(`${root}/REVIEW.md`,'# Matter-grounded synthetic shorthand pairs\n\n'+`${all.length} finalized entries across ${manifest.matters} matters; ${manifest.generated} generated inputs; ${manifest.eligible} unflagged expansion candidates; ${manifest.observed_pairs} original saved briefs.\n\n[Browse every pair](pairs.html) · [Matter cards](MATTER-CONTEXTS.md) · [Full manifest](manifest.json)\n\nThese are review samples, not a separate approval gate. Targets are source-derived finalized text.\n\n`+review.map(r=>`## Entry ${r.entry_id} — ${r.date} — ${r.matter?.short_name||'Unassigned'}\n\n**Synthetic shorthand:** ${r.synthetic_shorthand}\n\n**Finalized target:** ${r.target}\n\n**Prior context:**\n\n${r.context}\n\n**Recovered from earlier context:** ${r.earlier_context_recoveries.map(x=>x.fact+' (entries '+x.history_entry_ids.join(', ')+')').join('; ')||'None identified'}\n\n**Flags:** ${r.warnings.join(', ')||'None'}\n`).join('\n'));
// Live matter cards remain source-grounded and editable; no invented roles or deal summaries.
const ids=[...new Set(all.map(r=>r.matter_id).filter(Boolean))];
writeFileSync(`${root}/MATTER-CONTEXTS.md`,'# Current matter context cards\n\nThese show finalized source evidence. Roles and deal status are not inferred as facts. Historical training pairs use their own earlier-date snapshots, not these current cards.\n\n'+ids.map(id=>{const c=matterHistory(db,id);return `## ${c.matter.cm_number} — ${c.matter.short_name}\n\n### Attorney-supplied overview / people and roles\n\n_Add or correct context here for a future reviewed profile._\n\n### Source evidence\n\n${c.text}\n`;}).join('\n'));
console.log(JSON.stringify(manifest,null,2));db.close();
