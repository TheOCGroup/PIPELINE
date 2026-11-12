import test from 'node:test';
import assert from 'node:assert/strict';
import { deliverMissionControlHandoff as deliver } from '../src/services/missionControlDeliveryService.js';
const endpoint='https://mission-control.example.com/api/v1/integrations/pipeline/acquisition-handoff';
function fixture(status='ready') {
 const events=[];
 const handoff={id:'h1',targetSystem:'mission-control',payload:{contractVersion:'1.0'},status};
 return {events, transactions:{listHandoffs:id=>id==='opp1'?[handoff]:[],recordHandoffEvent:e=>{events.push(e);handoff.status=e.eventType;}}};
}
const opts={opportunityId:'opp1',handoffId:'h1',endpoint,secret:'test-secret'};
test('dispatch posts canonical envelope and records acknowledgment',async()=>{
 const f=fixture();let calls=0;
 const result=await deliver({...opts,transactions:f.transactions,fetchImpl:async(url,request)=>{calls++;assert.equal(url,endpoint);assert.equal(request.method,'POST');assert.equal(request.headers.authorization,'Bearer test-secret');assert.deepEqual(JSON.parse(request.body),{handoffId:'h1',payload:{contractVersion:'1.0'}});return {status:201,json:async()=>({ok:true,data:{duplicate:false,project:{id:'project1'}}})};}});
 assert.equal(calls,1);assert.equal(result.acknowledged,true);assert.deepEqual(f.events.map(e=>e.eventType),['dispatch_attempted','acknowledged']);assert.equal(f.events[1].externalRef,'project1');
});
test('acknowledged handoffs do not resend',async()=>{const f=fixture('acknowledged');const r=await deliver({...opts,transactions:f.transactions,fetchImpl:()=>{throw Error('must not call')}});assert.equal(r.alreadyAcknowledged,true);assert.equal(f.events.length,0);});
test('receiver duplicate is accepted as acknowledgment',async()=>{const f=fixture();const r=await deliver({...opts,transactions:f.transactions,fetchImpl:async()=>({status:200,json:async()=>({ok:true,data:{duplicate:true,project:{id:'p1'}}})})});assert.equal(r.duplicate,true);assert.equal(f.events.at(-1).eventType,'acknowledged');});
test('failed delivery is recorded and retryable',async()=>{const f=fixture();let calls=0;const fetchImpl=async()=>{calls++;if(calls===1)throw Error('network_down');return {status:201,json:async()=>({ok:true,data:{duplicate:false,project:{id:'p1'}}})};};const first=await deliver({...opts,transactions:f.transactions,fetchImpl});assert.equal(first.acknowledged,false);assert.equal(f.events.at(-1).eventType,'failed');const second=await deliver({...opts,transactions:f.transactions,fetchImpl});assert.equal(second.acknowledged,true);assert.equal(calls,2);});
test('fail closed on missing secret and insecure URL without writing events',async()=>{const f=fixture();await assert.rejects(deliver({...opts,secret:'',transactions:f.transactions}),/handoff_secret_required/);await assert.rejects(deliver({...opts,endpoint:'http://public.example.com/api/v1/integrations/pipeline/acquisition-handoff',transactions:f.transactions}),/secure_handoff_endpoint_required/);await assert.rejects(deliver({...opts,endpoint:'https://evil.example.com/api/v1/integrations/pipeline/acquisition-handoff?token=x',transactions:f.transactions}),/invalid_handoff_endpoint/);assert.equal(f.events.length,0);});
test('unknown handoff is not dispatched',async()=>{const f=fixture();await assert.rejects(deliver({...opts,handoffId:'unknown',transactions:f.transactions}),/acquisition_handoff_not_found/);assert.equal(f.events.length,0);});
test('malformed acknowledgment never marks a handoff acknowledged',async()=>{const f=fixture();const r=await deliver({...opts,transactions:f.transactions,fetchImpl:async()=>({status:200,json:async()=>({ok:true,data:{}})})});assert.equal(r.acknowledged,false);assert.equal(f.events.at(-1).eventType,'failed');});
