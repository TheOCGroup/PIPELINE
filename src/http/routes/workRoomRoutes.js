import { sendJson } from '../response.js';

async function readJson(req){const chunks=[];for await(const chunk of req)chunks.push(Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk));const raw=Buffer.concat(chunks).toString('utf8');return raw.trim()?JSON.parse(raw):{};}
const actorOf=req=>req.pipelineSession?.userId||req.pipelineSession?.subject||'local-operator';
const text=(v,name,required=true)=>{const s=v===null||v===undefined?'':String(v).trim();if(required&&!s){const e=new Error(`missing_${name}`);e.status=400;throw e;}return s||null;};

export async function handleWorkRoomRoutes(req,res,ctx,url,segments){
 if(segments[0]!=='work-room')return false;
 const service=ctx.services.workRoom;
 if(!service){sendJson(res,503,{ok:false,error:'work_room_unavailable'});return true;}
 const taskId=segments[1]||null,action=segments[2]||null;
 try{
  if(req.method==='GET'||req.method==='HEAD'){
   if(taskId==='director-report'){const report=ctx.services.directorReport?.build({department:url.searchParams.get('department'),limit:url.searchParams.get('limit')});if(!report){sendJson(res,503,{ok:false,error:'director_report_unavailable'});return true;}sendJson(res,200,{ok:true,data:{report}});return true;}
   if(taskId){const task=service.get(taskId);if(!task){sendJson(res,404,{ok:false,error:'work_task_not_found'});return true;}sendJson(res,200,{ok:true,data:{task}});return true;}
   const data=service.list({opportunityId:url.searchParams.get('opportunityId'),state:url.searchParams.get('state'),limit:url.searchParams.get('limit')});
   sendJson(res,200,{ok:true,data:{tasks:data}});return true;
  }
  if(req.method!=='POST'){sendJson(res,405,{ok:false,error:'method_not_allowed'},{Allow:'GET, HEAD, POST'});return true;}
  if(ctx.config.readOnly===true){sendJson(res,503,{ok:false,error:'read_only'});return true;}
  const body=await readJson(req),actor=actorOf(req);
  if(!taskId){const task=service.create({department:text(body.department,'department'),title:text(body.title,'title'),requestedBy:body.requestedBy||'Genaro',orchestrator:body.orchestrator||'Aiden',director:text(body.director,'director'),leadAgent:body.leadAgent||null,specialistAgent:body.specialistAgent||null,opportunityId:body.opportunityId||null,state:body.state||'queued',currentAction:body.currentAction||null,blocker:body.blocker||null,approvalRequired:body.approvalRequired===true,capability:body.capability||null,envelopeClass:body.envelopeClass||null,idempotencyKey:body.idempotencyKey||null,maxAttempts:body.maxAttempts||null});sendJson(res,201,{ok:true,data:{task}});return true;}
  if(action==='delegate'){const result=service.delegate({parentTaskId:taskId,delegatorAgentId:body.delegatorAgentId||body.actorAgentId||body.actorAgent||null,delegateeAgentId:body.delegateeAgentId||null,delegateeName:body.delegateeName||null,title:text(body.title,'title'),department:body.department||null,capability:body.capability||null,idempotencyKey:body.idempotencyKey||null,opportunityId:body.opportunityId||null,currentAction:body.currentAction||null,envelopeClass:body.envelopeClass||null,maxAttempts:body.maxAttempts||null});sendJson(res,201,{ok:true,data:result});return true;}
  if(action==='retry'){const task=service.retry({taskId,actorAgentId:body.actorAgentId||body.actorAgent||null,actor:body.actor||actor,currentAction:body.currentAction||null,summary:body.summary||null});sendJson(res,200,{ok:true,data:{task}});return true;}
  if(action==='approve'){const task=service.approve({taskId,actorAgentId:body.actorAgentId||body.actorAgent||null,actor:body.actor||null,decision:body.decision||'granted',summary:body.summary||null});sendJson(res,200,{ok:true,data:{task}});return true;}
  if(action==='event'){const event=service.event({taskId,eventType:text(body.eventType,'eventType'),actor:body.actor||actor,fromActor:body.fromActor||null,toActor:body.toActor||null,toolName:body.toolName||null,summary:text(body.summary,'summary'),artifactRef:body.artifactRef||null,evidenceRef:body.evidenceRef||null,metadata:body.metadata&&typeof body.metadata==='object'?body.metadata:null});sendJson(res,201,{ok:true,data:{event,task:service.get(taskId)}});return true;}
  if(action==='transition'){const task=service.transition({taskId,state:text(body.state,'state'),actor:body.actor||actor,currentAction:body.currentAction||null,blocker:body.blocker||null,approvalRequired:body.approvalRequired===true,eventType:body.eventType||null,summary:body.summary||null,toolName:body.toolName||null,artifactRef:body.artifactRef||null,evidenceRef:body.evidenceRef||null,metadata:body.metadata&&typeof body.metadata==='object'?body.metadata:null});sendJson(res,200,{ok:true,data:{task}});return true;}
  sendJson(res,404,{ok:false,error:'not_found'});return true;
 }catch(err){if(err instanceof SyntaxError){sendJson(res,400,{ok:false,error:'invalid_json'});return true;}const known=new Set(['invalid_work_event_type','work_task_not_found','invalid_work_task_state','settled_work_task_is_terminal','approval_envelope_violation','approval_not_authorized','approval_envelope_not_required','work_task_not_awaiting_approval','work_task_not_retryable','max_attempts_exceeded','agent_not_found','agent_not_active','agent_capability_denied','delegatee_capability_denied','delegation_outside_hierarchy','unknown_capability','governance_unavailable']);if(err.status===400||String(err.message).startsWith('missing_')){sendJson(res,400,{ok:false,error:err.message});return true;}if(known.has(err.message)){sendJson(res,409,{ok:false,error:err.message});return true;}console.error('[work-room] request failed');sendJson(res,500,{ok:false,error:'work_room_request_failed'});return true;}
}
