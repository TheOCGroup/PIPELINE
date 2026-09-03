import { randomUUID } from "node:crypto";

const APPROVED = Object.freeze({ approve_sell:"sell", approve_hold:"hold", approve_refinance:"refinance" });
const REQUIREMENTS = Object.freeze({
  sell:["current_market_value","listing_or_sale_strategy","property_disclosures","final_media_and_condition_evidence","net_proceeds_estimate"],
  hold:["rent_ready_verification","current_market_rent","insurance_and_occupancy_plan","property_management_or_leasing_plan","operating_reserve_plan"],
  refinance:["current_appraisal_or_value_evidence","lender_terms","income_and_expense_support","insurance_and_title_clearance","dscr_and_cash_out_verification"]
});
const EVENTS = new Set(["started","blocked","unblocked","completed","failed"]);

export class PostRenovationDispositionService {
  constructor(db){ this.db=db; }

  createPlan({ handoffId, reviewId, actor="local-operator" }) {
    const handoff=this.db.prepare("SELECT * FROM renovation_exit_handoffs WHERE id=?").get(handoffId);
    if(!handoff) throw new Error("renovation_exit_handoff_not_found");
    const review=this.db.prepare("SELECT * FROM renovation_exit_reviews WHERE id=? AND handoff_id=?").get(reviewId,handoffId);
    if(!review) throw new Error("renovation_exit_review_not_found");
    const type=APPROVED[review.decision];
    if(!type) throw new Error("approved_exit_decision_required");
    const latest=this.db.prepare("SELECT id FROM renovation_exit_reviews WHERE handoff_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1").get(handoffId);
    if(latest?.id!==reviewId) throw new Error("latest_exit_review_required");
    const existing=this.db.prepare("SELECT * FROM disposition_plans WHERE renovation_exit_handoff_id=? AND renovation_exit_review_id=?").get(handoffId,reviewId);
    if(existing) return {plan:this.get(existing.id),duplicate:true};
    const id=randomUUID(), requirements=REQUIREMENTS[type];
    this.db.prepare("BEGIN TRANSACTION").run();
    try{
      this.db.prepare(`INSERT INTO disposition_plans (id,opportunity_id,renovation_exit_handoff_id,renovation_exit_review_id,disposition_type,requirements_json,created_by) VALUES (?,?,?,?,?,?,?)`).run(id,handoff.opportunity_id,handoffId,reviewId,type,JSON.stringify(requirements),actor);
      this.db.prepare(`INSERT INTO disposition_plan_events (id,disposition_plan_id,event_type,detail,actor_id,occurred_at) VALUES (?,?,'ready',?,?,?)`).run(randomUUID(),id,`Approved ${type} disposition is ready for execution.`,actor,now());
      this.db.prepare("COMMIT").run();
    }catch(err){this.db.prepare("ROLLBACK").run();throw err;}
    return {plan:this.get(id),duplicate:false};
  }

  get(id){
    const row=this.db.prepare(`SELECT p.*,(SELECT event_type FROM disposition_plan_events e WHERE e.disposition_plan_id=p.id ORDER BY rowid DESC LIMIT 1) latest_event,(SELECT detail FROM disposition_plan_events e WHERE e.disposition_plan_id=p.id ORDER BY rowid DESC LIMIT 1) latest_detail,(SELECT external_ref FROM disposition_plan_events e WHERE e.disposition_plan_id=p.id ORDER BY rowid DESC LIMIT 1) external_ref FROM disposition_plans p WHERE p.id=?`).get(id);
    return row?this._decorate(toPlan(row)):null;
  }

  list(opportunityId){
    return this.db.prepare(`SELECT p.*,(SELECT event_type FROM disposition_plan_events e WHERE e.disposition_plan_id=p.id ORDER BY rowid DESC LIMIT 1) latest_event,(SELECT detail FROM disposition_plan_events e WHERE e.disposition_plan_id=p.id ORDER BY rowid DESC LIMIT 1) latest_detail,(SELECT external_ref FROM disposition_plan_events e WHERE e.disposition_plan_id=p.id ORDER BY rowid DESC LIMIT 1) external_ref FROM disposition_plans p WHERE p.opportunity_id=? ORDER BY p.created_at DESC,rowid DESC`).all(opportunityId).map(r=>this._decorate(toPlan(r)));
  }

  events(planId){ return this.db.prepare("SELECT * FROM disposition_plan_events WHERE disposition_plan_id=? ORDER BY rowid").all(planId).map(toEvent); }

  requirementEvidence(planId){
    return this.db.prepare("SELECT * FROM disposition_requirement_evidence WHERE disposition_plan_id=? ORDER BY rowid").all(planId).map(r=>({id:r.id,planId:r.disposition_plan_id,requirementKey:r.requirement_key,evidenceRef:r.evidence_ref,note:r.note,verifiedBy:r.verified_by,verifiedAt:r.verified_at,createdAt:r.created_at}));
  }

  verifyRequirement({ planId, requirementKey, evidenceRef, note=null, actor="local-operator", verifiedAt=null }){
    const plan=this.get(planId); if(!plan) throw new Error("disposition_plan_not_found");
    if(plan.status==="completed") throw new Error("completed_disposition_is_terminal");
    if(!plan.requirements.includes(requirementKey)) throw new Error("invalid_disposition_requirement");
    if(!String(evidenceRef||"").trim()) throw new Error("disposition_requirement_evidence_required");
    const existing=this.db.prepare("SELECT * FROM disposition_requirement_evidence WHERE disposition_plan_id=? AND requirement_key=?").get(planId,requirementKey);
    if(existing) throw new Error("disposition_requirement_already_verified");
    this.db.prepare(`INSERT INTO disposition_requirement_evidence (id,disposition_plan_id,requirement_key,evidence_ref,note,verified_by,verified_at) VALUES (?,?,?,?,?,?,?)`).run(randomUUID(),planId,requirementKey,evidenceRef.trim(),note,actor,verifiedAt||now());
    return this.get(planId);
  }

  recordEvent({ planId, eventType, detail=null, evidenceRef=null, externalRef=null, actor="local-operator", occurredAt=null }){
    if(!EVENTS.has(eventType)) throw new Error("invalid_disposition_event");
    const plan=this.get(planId); if(!plan) throw new Error("disposition_plan_not_found");
    if(eventType==="blocked"&&!String(detail||"").trim()) throw new Error("disposition_blocker_detail_required");
    if(plan.status==="completed") throw new Error("completed_disposition_is_terminal");
    if(eventType==="unblocked"&&plan.status!=="blocked") throw new Error("blocked_disposition_required");
    if(eventType==="completed"){
      if(!String(evidenceRef||"").trim()) throw new Error("disposition_completion_evidence_required");
      const missing=plan.requirements.filter(k=>!plan.verifiedRequirements.includes(k));
      if(missing.length) throw new Error(`disposition_requirements_incomplete:${missing.join(",")}`);
    }
    this.db.prepare(`INSERT INTO disposition_plan_events (id,disposition_plan_id,event_type,detail,evidence_ref,external_ref,actor_id,occurred_at) VALUES (?,?,?,?,?,?,?,?)`).run(randomUUID(),planId,eventType,detail,evidenceRef,externalRef,actor,occurredAt||now());
    return this.get(planId);
  }

  _decorate(plan){
    const evidence=this.requirementEvidence(plan.id), verifiedRequirements=evidence.map(e=>e.requirementKey), missingRequirements=plan.requirements.filter(k=>!verifiedRequirements.includes(k));
    return {...plan,requirementEvidence:evidence,verifiedRequirements,missingRequirements,requirementsComplete:missingRequirements.length===0};
  }
}

function now(){return new Date().toISOString().replace(/\.\d{3}Z$/,"Z");}
function toPlan(r){return{id:r.id,opportunityId:r.opportunity_id,handoffId:r.renovation_exit_handoff_id,reviewId:r.renovation_exit_review_id,dispositionType:r.disposition_type,requirements:JSON.parse(r.requirements_json||"[]"),createdBy:r.created_by,createdAt:r.created_at,status:r.latest_event||"ready",statusDetail:r.latest_detail||null,externalRef:r.external_ref||null};}
function toEvent(r){return{id:r.id,planId:r.disposition_plan_id,eventType:r.event_type,detail:r.detail,evidenceRef:r.evidence_ref,externalRef:r.external_ref,actorId:r.actor_id,occurredAt:r.occurred_at,createdAt:r.created_at};}
