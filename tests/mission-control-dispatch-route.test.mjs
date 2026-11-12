import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { handleOperatorRoutes } from '../src/http/routes/operatorRoutes.js';
function setup({configured=true,readOnly=false}={}){
 const events=[];
 const handoff={id:'h1',targetSystem:'mission-control',status:'ready',payload:{contractVersion:'1.0'}};
 const transactions={listHandoffs:()=>[handoff],recordHandoffEvent:event=>{events.push(event);handoff.status=event.eventType;return handoff;}};
 const ctx={config:{readOnly,missionControlHandoffEndpoint:configured?'https://mission-control.example.com/api/v1/integrations/pipeline/acquisition-handoff':'',missionControlHandoffSecret:configured?'secret':''},services:{transactions,operator:{}}};
 return {ctx,events};
}
async function invoke(ctx,body={opportunityId:'opp1'}){
 const req=Readable.from([JSON.stringify(body)]);req.method='POST';req.operatorAuth={actor:'qa'};
 let code,raw='';const res={writeHead(status){code=status;},setHeader(){},end(text){raw=String(text||'');}};
 await handleOperatorRoutes(req,res,ctx,new URL('http://localhost/api/v1/operator/acquisition-handoffs/h1/dispatch'),['operator','acquisition-handoffs','h1','dispatch']);
 return {code,body:JSON.parse(raw)};
}
test('dispatch route refuses missing server-side configuration without writing',async()=>{const f=setup({configured:false});const r=await invoke(f.ctx);assert.equal(r.code,503);assert.equal(r.body.error,'mission_control_delivery_not_configured');assert.equal(f.events.length,0);});
test('dispatch route respects production read-only gate',async()=>{const f=setup({readOnly:true});const r=await invoke(f.ctx);assert.equal(r.code,503);assert.equal(r.body.error,'read_only');assert.equal(f.events.length,0);});
test('dispatch route requires opportunityId',async()=>{const f=setup();const r=await invoke(f.ctx,{});assert.equal(r.code,400);assert.equal(r.body.error,'missing_opportunityId');assert.equal(f.events.length,0);});
