import { randomUUID } from "node:crypto";
import { normalizeTenantId, opportunityTenant } from "../repositories/sqlite/tenantScope.js";
import { recordGovernanceAudit } from "./governanceAudit.js";

const STATES=new Set(['queued','researching','building','editing','testing','qa','waiting','blocked','retrying','awaiting_approval','complete','failed','canceled']);
// Executable/working states: entering any of these IS starting work.
// 'queued' and 'awaiting_approval' are holding states (awaiting_approval is
// where the approval flow itself lives); 'blocked', 'canceled' and 'failed'
// are exits that execute nothing; 'complete' is the settle state the
// approval envelope has always gated separately.
const WORKING_STATES=new Set(['researching','building','editing','testing','qa','waiting','retrying']);
const EVENTS=new Set(['delegated','state_changed','tool_started','tool_completed','handoff','artifact','qa_started','qa_passed','qa_failed','blocked','retry','approval_requested','approval_granted','approval_denied','completed','failed','canceled']);
const settled=s=>['complete','failed','canceled'].includes(s);
const now=()=>new Date().toISOString().replace(/\.\d{3}Z$/,'Z');

/**
 * Agent Work Room — extended with the Issue #7 Director governance layer.
 *
 * The 023 substrate behavior is unchanged for legacy callers (create / get /
 * list / event / transition with free-text agent names, opportunity-linked
 * tenant scoping). Governance adds, on top:
 *
 *   Tenant ownership (migration 032): every task carries tenant_id, stamped
 *   from service configuration at creation. Reads filter on it, so a task
 *   owned by a foreign tenant — linked opportunity or not — resolves
 *   exactly like a nonexistent task (PR #36 ghost equality).
 *
 *   Delegation (delegate): creates a child task (parent_task_id) under a
 *   resolved delegator identity holding 'work_task.delegate', down the
 *   manager chain only, to an active delegatee identity. Idempotent on
 *   (tenant_id, idempotency_key): a replay returns the original child with
 *   deduplicated:true and writes no second event.
 *
 *   Retry (retry): only from failed/blocked; increments attempt, emits a
 *   'retry' event, and at the configured bound settles the task failed and
 *   raises a founder-escalation audit event instead of retrying forever.
 *
 *   Approval envelopes: a task whose envelope_class is 'high_risk' (set at
 *   creation from a high-risk capability in the migration-031 registry, or
 *   explicitly) is system-gated: approval_required is forced on, and until
 *   a founder identity records approval via approve() it may not enter ANY
 *   executable/working state — via transition(), via retry(), or by being
 *   created directly in one — and may not settle 'complete'. Only holding
 *   moves (queued / awaiting_approval) and exits that execute nothing
 *   (blocked/canceled/failed) stay open without a grant. A bare attempt
 *   throws 'approval_envelope_violation' and is audited. Denial settles
 *   the task back to 'blocked'. Legacy 'standard' tasks keep the original
 *   caller-asserted approval_required semantics untouched. Migration 034
 *   mirrors the working-state gate at the database layer, so direct SQL
 *   cannot move an unapproved high-risk task into work either (F1 —
 *   QUINCEY MODERATE, closed by the 2026-11-01 remediation).
 *
 * Governance dependencies (directory / capabilities) are injected by
 * buildServices; when absent, governance methods fail closed while the
 * legacy surface keeps working.
 */
export function createAgentWorkRoomService(db, tenantId, governance = {}){
 const scopeTenantId=normalizeTenantId(tenantId);
 const directory=governance.directory||null;
 const capabilities=governance.capabilities||null;
 // Work-room tasks may legitimately reference opportunities by external id
 // before (or without) a PIPELINE row existing, so the assertion here is
 // foreign-only: an id that EXISTS under another tenant is treated exactly
 // like this surface treats a missing task (work_task_not_found / null /
 // empty), while a merely unknown id keeps its existing behavior.
 const isForeign=(opportunityId)=>{if(!opportunityId)return false;const t=opportunityTenant(db,opportunityId);return t!==null&&t!==scopeTenantId;};
 const insertEvent=db.prepare(`INSERT INTO agent_work_events (id,task_id,event_type,actor,from_actor,to_actor,tool_name,summary,artifact_ref,evidence_ref,metadata_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
 function event(input){if(!EVENTS.has(input.eventType))throw new Error('invalid_work_event_type');const task=get(input.taskId);if(!task)throw new Error('work_task_not_found');const row={id:randomUUID(),taskId:input.taskId,eventType:input.eventType,actor:input.actor,fromActor:input.fromActor||null,toActor:input.toActor||null,toolName:input.toolName||null,summary:input.summary,artifactRef:input.artifactRef||null,evidenceRef:input.evidenceRef||null,metadataJson:input.metadata?JSON.stringify(input.metadata):null,createdAt:now()};insertEvent.run(row.id,row.taskId,row.eventType,row.actor,row.fromActor,row.toActor,row.toolName,row.summary,row.artifactRef,row.evidenceRef,row.metadataJson,row.createdAt);return row;}
 function envelopeFor(input){
   // A task exercising a high-risk capability from the registry is always
   // high-risk, whatever the caller asserts; an explicit high_risk class
   // is honored; anything else is standard.
   if(input.capability&&capabilities){const def=capabilities.capabilityDef(input.capability);if(def&&def.risk_tier==='high_risk')return 'high_risk';}
   return input.envelopeClass==='high_risk'?'high_risk':'standard';
 }
 function create(input){
   if(!STATES.has(input.state||'queued'))throw new Error('invalid_work_task_state');
   if(isForeign(input.opportunityId))throw new Error('work_task_not_found');
   if(input.parentTaskId){const parent=get(input.parentTaskId);if(!parent)throw new Error('work_task_not_found');}
   const envelopeClass=envelopeFor(input);
   const highRisk=envelopeClass==='high_risk';
   const approvalRequired=highRisk?true:!!input.approvalRequired;
   const approvalState=highRisk?'requested':'none';
   const id=input.id||randomUUID(),ts=now();
   if(input.idempotencyKey){
     const existing=db.prepare('SELECT * FROM agent_work_tasks WHERE tenant_id=? AND idempotency_key=?').get(scopeTenantId,input.idempotencyKey);
     if(existing)return {...get(existing.id),deduplicated:true};
   }
   // F1: a high-risk task is born unapproved (approval_state 'requested'
   // below; a caller cannot inject a grant), so it may not be born into a
   // working state either — creation is the third door into execution,
   // next to transition() and retry(). Refused creations write no task row
   // and are attested like transition violations.
   if(highRisk){
     const requestedState=input.state||'queued';
     if(WORKING_STATES.has(requestedState)||requestedState==='complete'){
       recordGovernanceAudit(db,{eventType:'AGENT_APPROVAL_ENVELOPE_VIOLATION',actorId:input.director||'unknown',payload:{tenantId:scopeTenantId,taskId:null,title:input.title,fromState:null,toState:requestedState,capability:input.capability||null,reason:'high_risk_create_in_working_state'}});
       throw new Error('approval_envelope_violation');
     }
   }
   db.prepare(`INSERT INTO agent_work_tasks (id,department,title,requested_by,orchestrator,director,lead_agent,specialist_agent,opportunity_id,state,current_action,blocker,approval_required,started_at,updated_at,settled_at,parent_task_id,tenant_id,idempotency_key,attempt,max_attempts,capability,envelope_class,approval_state) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
     .run(id,input.department,input.title,input.requestedBy||'Genaro',input.orchestrator||'Aiden',input.director,input.leadAgent||null,input.specialistAgent||null,input.opportunityId||null,input.state||'queued',input.currentAction||null,input.blocker||null,approvalRequired?1:0,ts,ts,settled(input.state||'queued')?ts:null,input.parentTaskId||null,scopeTenantId,input.idempotencyKey||null,1,Math.max(1,Number(input.maxAttempts)||3),input.capability||null,envelopeClass,approvalState);
   event({taskId:id,eventType:'delegated',actor:input.orchestrator||'Aiden',fromActor:input.requestedBy||'Genaro',toActor:input.director,summary:`Delegated: ${input.title}`});
   if(highRisk){
     // Founder escalation: a high-risk task enters the world already owing
     // a founder decision; the request is attested in the audit machinery.
     event({taskId:id,eventType:'approval_requested',actor:input.director,summary:`Founder approval required (high-risk envelope${input.capability?`: ${input.capability}`:''}): ${input.title}`});
     recordGovernanceAudit(db,{eventType:'AGENT_TASK_ESCALATED',actorId:input.director,payload:{tenantId:scopeTenantId,taskId:id,title:input.title,capability:input.capability||null,reason:'high_risk_envelope'}});
   }
   return get(id);
 }
 // F5 (QUINCEY LOW): the tenant match is exact — a NULL-tenant row resolves
 // exactly like a foreign row. Migration 032 backfilled every pre-existing
 // row and create() always stamps the configured tenant, so a NULL tenant
 // can only be a post-032 raw write; no tenant-scoped reader may see it.
 function get(id){const task=db.prepare('SELECT * FROM agent_work_tasks WHERE id=?').get(id);if(!task)return null;if(task.tenant_id!==scopeTenantId)return null;if(isForeign(task.opportunity_id))return null;return {...task,events:listEvents(id)};}
 function listEvents(taskId){return db.prepare('SELECT * FROM agent_work_events WHERE task_id=? ORDER BY created_at ASC,rowid ASC').all(taskId);}
 function list({opportunityId=null,state=null,limit=100}={}){if(isForeign(opportunityId))return[];let sql='SELECT * FROM agent_work_tasks WHERE tenant_id=?',args=[scopeTenantId];if(opportunityId){sql+=' AND opportunity_id=?';args.push(opportunityId);}if(state){sql+=' AND state=?';args.push(state);}sql+=' ORDER BY updated_at DESC,rowid DESC LIMIT ?';args.push(Math.min(Math.max(Number(limit)||100,1),250));return db.prepare(sql).all(...args).map(t=>({...t,events:listEvents(t.id)}));}
 function transition(input){
   if(!STATES.has(input.state))throw new Error('invalid_work_task_state');
   const task=get(input.taskId);if(!task)throw new Error('work_task_not_found');
   if(settled(task.state))throw new Error('settled_work_task_is_terminal');
   // Approval-envelope enforcement (high-risk tasks only; legacy standard
   // tasks keep caller-asserted approval_required semantics).
   //
   // F1 (QUINCEY MODERATE): the gate is on the TARGET state, from ANY
   // current state. An unapproved high-risk task may not enter an
   // executable/working state (researching/building/editing/testing/qa/
   // waiting/retrying) and may not settle 'complete'. Holding moves
   // (queued, awaiting_approval — the approval flow itself) and exits that
   // execute nothing (blocked/canceled/failed) stay open without a grant.
   // Migration 034 enforces the same target-state rule at the DB layer.
   if(task.envelope_class==='high_risk'&&task.approval_state!=='granted'){
     if(WORKING_STATES.has(input.state)||input.state==='complete'){
       recordGovernanceAudit(db,{eventType:'AGENT_APPROVAL_ENVELOPE_VIOLATION',actorId:input.actor||'unknown',payload:{tenantId:scopeTenantId,taskId:task.id,fromState:task.state,toState:input.state,capability:task.capability||null}});
       throw new Error('approval_envelope_violation');
     }
   }
   const ts=now(),settledAt=settled(input.state)?ts:null;
   const nextApprovalState=input.state==='awaiting_approval'&&task.envelope_class==='high_risk'?'requested':task.approval_state;
   db.prepare('UPDATE agent_work_tasks SET state=?,current_action=?,blocker=?,approval_required=?,updated_at=?,settled_at=?,approval_state=? WHERE id=?').run(input.state,input.currentAction||null,input.blocker||null,input.approvalRequired?1:0,ts,settledAt,nextApprovalState,input.taskId);
   const type=input.eventType||(input.state==='complete'?'completed':input.state==='failed'?'failed':input.state==='canceled'?'canceled':input.state==='blocked'?'blocked':input.state==='retrying'?'retry':input.state==='awaiting_approval'?'approval_requested':'state_changed');
   event({taskId:input.taskId,eventType:type,actor:input.actor,summary:input.summary||`${task.state} → ${input.state}`,toolName:input.toolName,artifactRef:input.artifactRef,evidenceRef:input.evidenceRef,metadata:input.metadata});
   return get(input.taskId);
 }
 // ---- Issue #7 governance surface -------------------------------------
 function requireGovernance(){if(!directory||!capabilities)throw new Error('governance_unavailable');}
 function resolveActor(ref,capability){
   requireGovernance();
   const actor=directory.resolve(ref);
   if(!actor||actor.status!=='active')throw new Error('agent_not_found');
   if(capability&&!capabilities.can(actor.id,capability))throw new Error('agent_capability_denied');
   return actor;
 }
 function delegate(input){
   requireGovernance();
   const parent=get(input.parentTaskId);if(!parent)throw new Error('work_task_not_found');
   if(settled(parent.state))throw new Error('settled_work_task_is_terminal');
   // Order: identity -> hierarchy -> capabilities. The structural rule
   // (delegation flows down the manager chain) is judged before the
   // delegator's own permissions.
   requireGovernance();
   const delegator=directory.resolve(input.delegatorAgentId||input.actorAgentId);
   if(!delegator||delegator.status!=='active')throw new Error('agent_not_found');
   const delegatee=directory.resolve(input.delegateeAgentId||input.delegateeName);
   if(!delegatee)throw new Error('agent_not_found');
   if(delegatee.status!=='active')throw new Error('agent_not_active');
   // Delegation flows DOWN the manager chain: the delegator must be the
   // delegatee's manager or one of its ancestors (founder included).
   if(!directory.isSelfOrAncestor(delegatee.id,delegator.id)||delegator.id===delegatee.id)throw new Error('delegation_outside_hierarchy');
   if(!capabilities.can(delegator.id,'work_task.delegate'))throw new Error('agent_capability_denied');
   if(input.capability){
     const def=capabilities.capabilityDef(input.capability);
     if(!def)throw new Error('unknown_capability');
     if(!capabilities.can(delegatee.id,input.capability))throw new Error('delegatee_capability_denied');
   }
   if(input.idempotencyKey){
     const existing=db.prepare('SELECT * FROM agent_work_tasks WHERE tenant_id=? AND idempotency_key=?').get(scopeTenantId,input.idempotencyKey);
     if(existing)return {task:get(existing.id),deduplicated:true};
   }
   const child=create({department:input.department||parent.department,title:input.title,requestedBy:parent.requested_by,orchestrator:parent.orchestrator,director:delegator.name,leadAgent:delegatee.kind==='lead'?delegatee.name:parent.lead_agent||null,specialistAgent:delegatee.kind==='specialist'?delegatee.name:null,opportunityId:input.opportunityId||parent.opportunity_id||null,state:'queued',currentAction:input.currentAction||null,parentTaskId:parent.id,idempotencyKey:input.idempotencyKey||null,capability:input.capability||null,envelopeClass:input.envelopeClass,maxAttempts:input.maxAttempts});
   // The governance delegation record proper (create()'s own 'delegated'
   // event is the generic room-entry attestation; this one names the
   // delegator -> delegatee pair and the parent it hangs from).
   event({taskId:child.id,eventType:'delegated',actor:delegator.name,fromActor:delegator.name,toActor:delegatee.name,summary:`Delegated by ${delegator.name} to ${delegatee.name}: ${input.title}`,metadata:{parentTaskId:parent.id,delegateeAgentId:delegatee.id}});
   recordGovernanceAudit(db,{eventType:'AGENT_TASK_DELEGATED',actorId:delegator.name,payload:{tenantId:scopeTenantId,taskId:child.id,parentTaskId:parent.id,delegateeAgentId:delegatee.id,delegateeName:delegatee.name,capability:input.capability||null,idempotencyKey:input.idempotencyKey||null}});
   return {task:get(child.id),deduplicated:false};
 }
 function retry(input){
   requireGovernance();
   const task=get(input.taskId);if(!task)throw new Error('work_task_not_found');
   const actor=resolveActor(input.actorAgentId||input.actor,'work_task.retry');
   if(!['failed','blocked'].includes(task.state))throw new Error('work_task_not_retryable');
   // F1: retrying IS entering a working state ('retrying'), so an
   // unapproved high-risk task may not be retried at all — founder approval
   // comes first, and the refusal is attested like any envelope violation.
   // A granted task that later fails retries normally (bound included):
   // its approval_state stays 'granted' across the failure.
   if(task.envelope_class==='high_risk'&&task.approval_state!=='granted'){
     recordGovernanceAudit(db,{eventType:'AGENT_APPROVAL_ENVELOPE_VIOLATION',actorId:actor.name,payload:{tenantId:scopeTenantId,taskId:task.id,fromState:task.state,toState:'retrying',capability:task.capability||null,reason:'high_risk_retry_before_approval'}});
     throw new Error('approval_envelope_violation');
   }
   if(task.attempt>=task.max_attempts){
     // Retry bound reached: settle failed and escalate to the founder
     // instead of looping. The refusal itself is attested twice (task
     // event + governance audit) so the escalation cannot be silent.
     const ts=now();
     db.prepare('UPDATE agent_work_tasks SET state=?,blocker=?,updated_at=?,settled_at=? WHERE id=?').run('failed',task.blocker||`Retry bound reached (${task.max_attempts} attempts)`,ts,ts,task.id);
     event({taskId:task.id,eventType:'blocked',actor:actor.name,summary:`Retry bound reached (${task.attempt}/${task.max_attempts}); escalated to founder`});
     recordGovernanceAudit(db,{eventType:'AGENT_TASK_ESCALATED',actorId:actor.name,payload:{tenantId:scopeTenantId,taskId:task.id,title:task.title,reason:'retry_bound_reached',attempt:task.attempt,maxAttempts:task.max_attempts}});
     throw new Error('max_attempts_exceeded');
   }
   const ts=now();
   db.prepare('UPDATE agent_work_tasks SET state=?,attempt=?,current_action=?,updated_at=?,settled_at=NULL WHERE id=?').run('retrying',task.attempt+1,input.currentAction||task.current_action||null,ts,task.id);
   event({taskId:task.id,eventType:'retry',actor:actor.name,summary:input.summary||`Retry attempt ${task.attempt+1} of ${task.max_attempts}`});
   recordGovernanceAudit(db,{eventType:'AGENT_TASK_RETRIED',actorId:actor.name,payload:{tenantId:scopeTenantId,taskId:task.id,attempt:task.attempt+1,maxAttempts:task.max_attempts}});
   return get(task.id);
 }
 function approve(input){
   requireGovernance();
   const task=get(input.taskId);if(!task)throw new Error('work_task_not_found');
   // Founder escalation endpoint: ONLY a founder-role identity may grant
   // or deny a high-risk envelope (ASSUMPTION: approver set = founder
   // alone; Aiden receives decisions via the report, Aiden does not rule).
   const approver=directory.resolve(input.actorAgentId||input.actor);
   if(!approver||approver.status!=='active'||approver.role!=='founder')throw new Error('approval_not_authorized');
   if(task.envelope_class!=='high_risk')throw new Error('approval_envelope_not_required');
   if(task.state!=='awaiting_approval')throw new Error('work_task_not_awaiting_approval');
   const decision=input.decision==='denied'?'denied':'granted';
   const ts=now();
   if(decision==='granted'){
     db.prepare('UPDATE agent_work_tasks SET approval_state=?,approved_by=?,approved_at=?,updated_at=? WHERE id=?').run('granted',approver.name,ts,ts,task.id);
     event({taskId:task.id,eventType:'approval_granted',actor:approver.name,summary:input.summary||`Founder approval granted for high-risk task: ${task.title}`});
   }else{
     db.prepare('UPDATE agent_work_tasks SET approval_state=?,approved_by=?,approved_at=?,state=?,blocker=?,updated_at=? WHERE id=?').run('denied',approver.name,ts,'blocked',input.summary||'Founder approval denied',ts,task.id);
     event({taskId:task.id,eventType:'approval_denied',actor:approver.name,summary:input.summary||`Founder approval denied for high-risk task: ${task.title}`});
   }
   recordGovernanceAudit(db,{eventType:decision==='granted'?'AGENT_APPROVAL_GRANTED':'AGENT_APPROVAL_DENIED',actorId:approver.name,payload:{tenantId:scopeTenantId,taskId:task.id,title:task.title,capability:task.capability||null}});
   return get(task.id);
 }
 return {create,get,list,event,transition,delegate,retry,approve};
}
