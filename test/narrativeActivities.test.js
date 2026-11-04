import {test} from 'node:test';
import assert from 'node:assert/strict';
import {activityIssues} from '../server/lib/narrativeActivities.js';
test('expansion retains work and permits background review within preparation',()=>{
 assert.equal(activityIssues('all hands call; prepare; messages with A. Mercer; confer with client','Review issues list and prepare for and participate in all-hands call; correspond with A. Mercer; confer with client regarding strategy.').ok,true);
});
test('adding revisions to calls is rejected; adjective revised is allowed',()=>{
 assert.deepEqual(activityIssues('call; messages','Call; messages and revise proposals.').added,['revise']);
 assert.equal(activityIssues('review license; email client','Review revised license; email client.').ok,true);
});
test('dropped preparation and replacing a call with an email are rejected',()=>{
 assert.ok(activityIssues('review comments; prepare for call; messages; confer with client','Review comments; call; messages; confer with client.').missing.includes('prepare'));
 assert.equal(activityIssues('call with Evan; prepare for call','Compose email to Evan regarding anticipated call.').ok,false);
});
test('reviewing client comments can be part of revision; shorthand can expand',()=>{
 assert.equal(activityIssues('revise license; email client','Review client comments and revise license; email client.').ok,true);
 assert.equal(activityIssues('rev lease; msgs with client','Review lease; messages with client.').ok,true);
 assert.equal(activityIssues('rev lease; msgs with client','Messages with client.').ok,false);
});
test('task mapping preserves order and separates a combined preparation/call clause',async()=>{
 const {reviewedFragments}=await import('../server/lib/reviewedNarrative.js');
 assert.deepEqual(reviewedFragments(['call','prepare','messages with client'],'Prepare for and participate in all-hands call regarding lease; messages with client regarding lease.'),['Participate in all-hands call regarding lease','Prepare for all-hands call regarding lease','messages with client regarding lease']);
 assert.equal(reviewedFragments(['review plat','email client'],'Email client.'),null);
});
