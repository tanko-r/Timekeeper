import Database from 'better-sqlite3';import {writeFileSync,existsSync} from 'node:fs';import {matterHistory,cleanMatterNarrative,historyNames} from '../../server/lib/matterHistory.js';import {NARRATIVE_POLICY} from '../../server/lib/narrativeProfile.js';
const root=process.env.TK_PAIR_DIR||'data/narrative-model/matter-pairs-2026-11-04';if(existsSync(`${root}/sources.jsonl`)){console.log('Using frozen source export:',root);process.exit(0);}const db=new Database(`${root}/source.db`,{readonly:true});
const rows=db.prepare("SELECT id,date,cm_id,narrative,narrative_ai,ai_brief,ai_draft FROM entries WHERE status='finalized' AND deleted_at IS NULL ORDER BY date,id").all();
const records=rows.map(r=>{
 const target=cleanMatterNarrative(r.narrative);
 const context=matterHistory(db,r.cm_id,{beforeDate:r.date});
 const entityNames=r.cm_id?db.prepare("SELECT DISTINCT name,kind FROM matter_entities WHERE matter_id=? AND kind!='person'").all(r.cm_id).filter(e=>e.name.length>3&&target.toLowerCase().includes(e.name.toLowerCase())):[];
 return {...r,raw_narrative:r.narrative,target,people:historyNames(target),source_entities:entityNames,initial_context:context.text,initial_history:context.entries,matter:context.matter||null};
});
writeFileSync(`${root}/sources.jsonl`,records.map(r=>JSON.stringify(r)).join('\n')+'\n');writeFileSync(`${root}/system.txt`,NARRATIVE_POLICY);
console.log(`Exported ${records.length} finalized sources with strictly earlier-day context.`);
