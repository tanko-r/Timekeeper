import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {startTestServer} from './helpers.js';
import {setSetting} from '../server/db.js';
async function fixture(answers) {
 const calls=[];
 const server=createServer((req,res)=>{let text='';req.on('data',x=>text+=x);req.on('end',()=>{calls.push(JSON.parse(text));res.setHeader('content-type','application/json');res.end(JSON.stringify({message:{content:answers[Math.min(calls.length-1,answers.length-1)]},done_reason:'stop'}));});});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const t=await startTestServer();setSetting(t.db,'ai',{enabled:true,model:'timekeeper-narrative:v3',url:`http://127.0.0.1:${server.address().port}`});
 return {t,calls,close:async()=>{await t.close();await new Promise(r=>server.close(r));}};
}
test('only validated narrative reaches the editor after an activity retry',async()=>{
 const f=await fixture(['Call with client; draft agreement.','Prepare for and participate in call with client.']);
 try {
  const r=await f.t.fetchJson('POST','/api/ai/narrate',{mode:'longer',narrative:'call with client; prepare'});
  assert.equal(r.status,200);assert.equal(f.calls.length,2);
  assert.match(f.calls[1].messages[1].content,/Action: Rewrite/);
  assert.doesNotMatch(r.body.raw,/draft agreement/);
  const done=r.body.raw.trim().split('\n').map(JSON.parse).find(x=>x.done);
  assert.equal(done.narrative,'Prepare for and participate in call with client.');
 }finally{await f.close();}
});
test('two activity mismatches return an error without writing a candidate',async()=>{
 const f=await fixture(['Email client.']);
 try {
  const r=await f.t.fetchJson('POST','/api/ai/narrate',{mode:'longer',narrative:'call with client; prepare'});
  assert.equal(r.status,502);assert.equal(r.body.error,'ai_activity_mismatch');
 }finally{await f.close();}
});
test('split uses validated narrative clauses and returns every task with allocated hours',async()=>{
 const f=await fixture(['Review plat and identify issues; email client regarding same.']);
 try {
  const r=await f.t.fetchJson('POST','/api/ai/expand',{brief:'review plat; email client',totalHours:.7});
  assert.equal(r.status,200);assert.equal(r.body.tasks.length,2);
  assert.deepEqual(r.body.tasks.map(x=>x.task_code),['Review','Correspondence']);
  assert.ok(Math.abs(r.body.tasks.reduce((n,x)=>n+x.hours,0)-.7)<.0001);
  assert.ok(Array.isArray(r.body.debug.messages));
 }finally{await f.close();}
});
