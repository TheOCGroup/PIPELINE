import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app/createApp.js';
import { makeTempDb, testConfig, startApp } from './helpers/temporaryDatabase.mjs';

async function post(url,body){return fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});}

test('real OCG OS job is visible through governed Work Room lifecycle and persistent history',async t=>{
 const db=makeTempDb();
 const {app,baseUrl}=await startApp(createApp,testConfig(db.dbPath,{readOnly:false}));
 t.after(()=>{app.close();db.cleanup();});

 let res=await post(`${baseUrl}/api/v1/work-room`,{
  department:'OCG OS',title:'Underwrite acceptance property',requestedBy:'Genaro',orchestrator:'Aiden',director:'OCG OS Director',leadAgent:'Victor',opportunityId:'acceptance-property'
 });
 assert.equal(res.status,201);
 let body=await res.json();
 const id=body.data.task.id;
 assert.equal(body.data.task.state,'queued');
 assert.equal(body.data.task.events[0].event_type,'delegated');
 assert.equal(body.data.task.requested_by,'Genaro');
 assert.equal(body.data.task.orchestrator,'Aiden');
 assert.equal(body.data.task.director,'OCG OS Director');
 assert.equal(body.data.task.lead_agent,'Victor');

 for(const step of [
  {state:'researching',actor:'Victor',currentAction:'Recovering source-of-truth property evidence',summary:'Victor started property research'},
  {state:'testing',actor:'Victor',currentAction:'Testing underwriting calculations',summary:'Victor started calculation verification'},
  {state:'qa',actor:'Independent QA',currentAction:'Independent underwriting QA',eventType:'qa_started',summary:'Independent QA started'},
  {state:'awaiting_approval',actor:'OCG OS Director',currentAction:'Capital decision required',approvalRequired:true,summary:'Underwriting packet ready for governed decision'},
  {state:'complete',actor:'OCG OS Director',currentAction:'Verified underwriting complete',evidenceRef:'qa://acceptance/pass',summary:'Verified underwriting completed'}
 ]){
  res=await post(`${baseUrl}/api/v1/work-room/${id}/transition`,step);
  assert.equal(res.status,200);
 }

 res=await fetch(`${baseUrl}/api/v1/work-room/${id}`);
 assert.equal(res.status,200); body=await res.json();
 const task=body.data.task;
 assert.equal(task.state,'complete');
 assert.ok(task.settled_at);
 assert.ok(task.events.some(e=>e.event_type==='qa_started'));
 assert.ok(task.events.some(e=>e.event_type==='approval_requested'));
 assert.ok(task.events.some(e=>e.event_type==='completed'));
 assert.equal(Object.hasOwn(task,'percent_complete'),false);

 res=await fetch(`${baseUrl}/api/v1/work-room?opportunityId=acceptance-property`);
 body=await res.json();
 assert.equal(body.data.tasks.length,1);
 assert.equal(body.data.tasks[0].id,id);

 const shell=await (await fetch(`${baseUrl}/`)).text();
 assert.match(shell,/ocg-os-work-room\.js/);
 const asset=await fetch(`${baseUrl}/ocg-os-work-room.js`);
 assert.equal(asset.status,200);
 assert.match(asset.headers.get('content-type')||'',/application\/javascript/);
 const js=await asset.text();
 assert.match(js,/Persisted Agent Operations activity/);
 assert.match(js,/No simulated percentages/);
 assert.match(js,/Inspect history/);
 assert.doesNotMatch(js,/<!doctype html>/i);
});
