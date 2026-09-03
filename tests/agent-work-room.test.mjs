import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app/createApp.js';
import { makeTempDb, testConfig } from './helpers/temporaryDatabase.mjs';

test('Work Room persists delegation, real state changes, evidence, and terminal history',()=>{
 const db=makeTempDb(); const app=createApp(testConfig(db.dbPath));
 try{
  const room=app.services.workRoom;
  const task=room.create({department:'OCG OS',title:'Underwrite 123 Main St',director:'OCG OS Director',leadAgent:'Victor',opportunityId:'opp-test',state:'queued'});
  assert.equal(task.state,'queued');
  assert.equal(task.events[0].event_type,'delegated');
  let working=room.transition({taskId:task.id,state:'researching',actor:'Victor',currentAction:'Recovering property evidence',summary:'Victor started source-of-truth research'});
  assert.equal(working.state,'researching');
  room.event({taskId:task.id,eventType:'tool_completed',actor:'Victor',toolName:'property-records',summary:'Property evidence recovered',evidenceRef:'evidence://property/123-main'});
  let qa=room.transition({taskId:task.id,state:'qa',actor:'OCG OS Director',currentAction:'Independent underwriting QA',eventType:'qa_started',summary:'Independent QA started'});
  assert.equal(qa.state,'qa');
  room.event({taskId:task.id,eventType:'qa_passed',actor:'Independent QA',summary:'Underwriting evidence verified',evidenceRef:'qa://underwriting/pass'});
  const done=room.transition({taskId:task.id,state:'complete',actor:'OCG OS Director',summary:'Verified underwriting completed',evidenceRef:'qa://underwriting/pass'});
  assert.equal(done.state,'complete'); assert.ok(done.settled_at); assert.ok(done.events.length>=6);
  assert.throws(()=>room.transition({taskId:task.id,state:'building',actor:'Victor'}),/settled_work_task_is_terminal/);
  assert.throws(()=>app.db.prepare('UPDATE agent_work_events SET summary=? WHERE task_id=?').run('fake',task.id),/append-only/);
 } finally {app.close();db.cleanup();}
});

test('Work Room filters opportunity work without inventing progress',()=>{
 const db=makeTempDb(); const app=createApp(testConfig(db.dbPath));
 try{
  const room=app.services.workRoom;
  room.create({department:'OCG OS',title:'Deal A',director:'OCG OS Director',leadAgent:'Piper',opportunityId:'opp-a'});
  room.create({department:'OCG LAB',title:'Build B',director:'Technology Director',leadAgent:'Engineer'});
  const rows=room.list({opportunityId:'opp-a'});
  assert.equal(rows.length,1); assert.equal(rows[0].title,'Deal A'); assert.equal(rows[0].state,'queued');
  assert.equal(Object.hasOwn(rows[0],'percent_complete'),false);
 } finally {app.close();db.cleanup();}
});
