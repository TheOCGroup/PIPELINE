import { sendJson } from '../response.js';

/**
 * Agent Directory + Capability routes (Issue #7 governance surface).
 *
 *   GET  /api/v1/agents                          identity list (tenant)
 *   POST /api/v1/agents                          create identity
 *   GET  /api/v1/agents/:id                      one identity + capabilities
 *   POST /api/v1/agents/:id/retire               retire identity
 *   POST /api/v1/agents/:id/capabilities         grant a capability
 *   POST /api/v1/agents/:id/capabilities/revoke  revoke a capability
 *
 * Posture matches the work room: operator session is enforced upstream,
 * writes refused in read-only mode, foreign ids are 404 (never 403 — no
 * existence leak). Governance mutations additionally require the caller's
 * asserted agent identity (`actorAgentId` / `actorAgent` in the body) to
 * hold the governing capability inside the service layer; an unresolved
 * or under-privileged actor is denied there, never defaulted upward.
 */

async function readJson(req){const chunks=[];for await(const chunk of req)chunks.push(Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk));const raw=Buffer.concat(chunks).toString('utf8');return raw.trim()?JSON.parse(raw):{};}
const text=(v,name,required=true)=>{const s=v===null||v===undefined?'':String(v).trim();if(required&&!s){const e=new Error(`missing_${name}`);e.status=400;throw e;}return s||null;};

const KNOWN=new Set(['agent_not_found','agent_name_taken','agent_manager_not_found','agent_manager_not_active','agent_manager_required','agent_human_has_no_manager','agent_director_must_report_to_orchestrator','agent_hierarchy_cycle','agent_has_active_reports','agent_has_open_tasks','agent_not_active','identity_manage_not_authorized','capability_grant_not_authorized','capability_reserved_for_victor','capability_reserved','capability_grant_not_found','unknown_capability','invalid_agent_kind']);

export async function handleAgentDirectoryRoutes(req,res,ctx,url,segments){
 if(segments[0]!=='agents')return false;
 const directory=ctx.services.agents,capabilities=ctx.services.capabilities;
 if(!directory||!capabilities){sendJson(res,503,{ok:false,error:'agent_governance_unavailable'});return true;}
 const agentId=segments[1]||null,action=segments[2]||null,sub=segments[3]||null;
 try{
  if(req.method==='GET'||req.method==='HEAD'){
   if(!agentId){sendJson(res,200,{ok:true,data:{agents:directory.list({status:url.searchParams.get('status')})}});return true;}
   const agent=directory.get(agentId)||directory.byName(agentId);
   if(!agent){sendJson(res,404,{ok:false,error:'agent_not_found'});return true;}
   const grants=capabilities.listGrants(agent.id);
   const effective=capabilities.listCapabilities().map(def=>({capability:def.capability,effect:def.effect,riskTier:def.risk_tier,reservedRole:def.reserved_role,allowed:capabilities.can(agent.id,def.capability)}));
   sendJson(res,200,{ok:true,data:{agent,grants,effectiveCapabilities:effective}});return true;
  }
  if(req.method!=='POST'){sendJson(res,405,{ok:false,error:'method_not_allowed'},{Allow:'GET, HEAD, POST'});return true;}
  if(ctx.config.readOnly===true){sendJson(res,503,{ok:false,error:'read_only'});return true;}
  const body=await readJson(req);
  const actorAgentId=body.actorAgentId||body.actorAgent||null;
  if(!agentId){
   const agent=directory.createIdentity({name:text(body.name,'name'),kind:text(body.kind,'kind'),role:text(body.role,'role'),managerAgentId:body.managerAgentId||null,managerName:body.managerName||null,actorAgentId});
   sendJson(res,201,{ok:true,data:{agent}});return true;
  }
  const target=directory.get(agentId)||directory.byName(agentId);
  if(!target){sendJson(res,404,{ok:false,error:'agent_not_found'});return true;}
  if(action==='retire'&&!sub){const agent=directory.retireIdentity({agentId:target.id,actorAgentId});sendJson(res,200,{ok:true,data:{agent}});return true;}
  if(action==='capabilities'&&!sub){const grant=capabilities.grant({agentId:target.id,capability:text(body.capability,'capability'),actorAgentId});sendJson(res,201,{ok:true,data:{grant}});return true;}
  if(action==='capabilities'&&sub==='revoke'){const grant=capabilities.revoke({agentId:target.id,capability:text(body.capability,'capability'),actorAgentId});sendJson(res,200,{ok:true,data:{grant}});return true;}
  sendJson(res,404,{ok:false,error:'not_found'});return true;
 }catch(err){if(err instanceof SyntaxError){sendJson(res,400,{ok:false,error:'invalid_json'});return true;}if(err.status===400||String(err.message).startsWith('missing_')){sendJson(res,400,{ok:false,error:err.message});return true;}if(KNOWN.has(err.message)){sendJson(res,409,{ok:false,error:err.message});return true;}console.error('[agents] request failed');sendJson(res,500,{ok:false,error:'agent_governance_request_failed'});return true;}
}
