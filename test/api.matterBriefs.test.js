import {test} from 'node:test';import assert from 'node:assert/strict';import {startTestServer} from './helpers.js';
import {BRIEF_SECTIONS} from '../server/lib/matterBriefs.js';
test('brief API exposes source-linked current and prior versions, validates settings and triggers isolated updates',async()=>{
 const t=await startTestServer({deps:{briefGenerate:async input=>({...Object.fromEntries(BRIEF_SECTIONS.map(k=>[k,[]])),overview:[{text:'Access agreement negotiation.',kind:'inferred',source_entry_ids:[input.sources[0].id]}]})}});
 try{
  const cm=await t.fetchJson('POST','/api/cms',{cm_number:'100001-000001',short_name:'Access'});const id=cm.body.id;
  t.db.prepare("INSERT INTO entries(cm_id,date,narrative,status) VALUES(?,'2026-10-20','Review access agreement.','finalized')").run(id);
  assert.equal((await t.fetchJson('GET',`/api/matter-briefs/${id}`)).body.brief,null);
  assert.equal((await t.fetchJson('PATCH','/api/settings',{matterBriefs:{hour:25}})).status,400);
  assert.equal((await t.fetchJson('PATCH','/api/settings',{matterBriefs:{enabled:true,hour:2}})).status,200);
  assert.equal((await t.fetchJson('POST','/api/matter-briefs/run',{mode:'matter',matter_id:999})).status,400);
  const run=await t.fetchJson('POST','/api/matter-briefs/run',{mode:'matter',matter_id:id});assert.equal(run.status,202);
  const current=await t.fetchJson('GET',`/api/matter-briefs/${id}`);assert.equal(current.body.brief.version,1);assert.equal(current.body.usable,true);
  assert.equal((await t.fetchJson('GET',`/api/matter-briefs/${id}/versions`)).body.versions.length,1);
  assert.equal((await t.fetchJson('GET',`/api/matter-briefs/${id}/versions/1`)).body.sources[0].narrative,'Review access agreement.');
  assert.equal((await t.fetchJson('GET','/api/matter-briefs')).body.count,1);
 }finally{await t.close();}
});
