import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDb, testConfig } from "./helpers/temporaryDatabase.mjs";
import { createApp } from "../src/app/createApp.js";

function seedExitReview(db,{suffix="sell",decision="approve_sell"}={}){
  const opportunityId=`opp_disp_${suffix}`, handoffId=`exit_${suffix}`, reviewId=`review_${suffix}`;
  db.prepare(`INSERT INTO seller_opportunities (id,opportunity_code,ocg_one_property_id,created_by,pipeline_stage,opportunity_status,closed_at) VALUES (?,? ,?,'test','closed','closed_purchased','2026-09-25T16:00:00Z')`).run(opportunityId,`DISP-${suffix}`,`property-${suffix}`);
  const payload={contractVersion:"1.0",sourceSystem:"mission-control",targetSystem:"ocg-os",handoffType:"renovation_exit_ready",sourceOpportunityId:opportunityId,renovation:{projectId:`reno-${suffix}`,completionEvidenceRef:"album://final"},exitEvaluation:{originalDecision:"sell",recommendedDecision:"sell",confidence:"medium",requiresInvestmentCommittee:true,metrics:{projectedSaleProfit:42000}},decisionStatus:"investment_committee_required"};
  db.prepare(`INSERT INTO renovation_exit_handoffs (id,opportunity_id,source_project_id,payload_json,original_decision,recommended_decision,confidence,received_by) VALUES (?,?,?,?, 'sell','sell','medium','test')`).run(handoffId,opportunityId,`reno-${suffix}`,JSON.stringify(payload));
  db.prepare(`INSERT INTO renovation_exit_reviews (id,handoff_id,decision,rationale,metrics_json,reviewed_by) VALUES (?,?,?,?,?,'committee')`).run(reviewId,handoffId,decision,"Approved after evidence review",JSON.stringify(payload.exitEvaluation.metrics));
  return {opportunityId,handoffId,reviewId};
}

test("approved sell exit creates one immutable execution plan with evidence-gated completion",()=>{
  const tempDb=makeTempDb(),app=createApp(testConfig(tempDb.dbPath));
  try{
    const seeded=seedExitReview(app.db);
    const first=app.services.dispositions.createPlan({handoffId:seeded.handoffId,reviewId:seeded.reviewId,actor:"operator"});
    assert.equal(first.duplicate,false);
    assert.equal(first.plan.dispositionType,"sell");
    assert.equal(first.plan.status,"ready");
    assert.ok(first.plan.requirements.includes("current_market_value"));
    assert.ok(first.plan.requirements.includes("net_proceeds_estimate"));
    const duplicate=app.services.dispositions.createPlan({handoffId:seeded.handoffId,reviewId:seeded.reviewId,actor:"operator"});
    assert.equal(duplicate.duplicate,true);
    assert.equal(duplicate.plan.id,first.plan.id);

    let plan=app.services.dispositions.recordEvent({planId:first.plan.id,eventType:"started",actor:"operator",externalRef:"listing-prep-1"});
    assert.equal(plan.status,"started");
    assert.throws(()=>app.services.dispositions.recordEvent({planId:first.plan.id,eventType:"blocked",actor:"operator"}),/disposition_blocker_detail_required/);
    plan=app.services.dispositions.recordEvent({planId:first.plan.id,eventType:"blocked",detail:"Final utility invoice missing",actor:"operator"});
    assert.equal(plan.status,"blocked");
    plan=app.services.dispositions.recordEvent({planId:first.plan.id,eventType:"unblocked",detail:"Invoice received",actor:"operator"});
    assert.equal(plan.status,"unblocked");
    assert.throws(()=>app.services.dispositions.recordEvent({planId:first.plan.id,eventType:"completed",actor:"operator"}),/disposition_completion_evidence_required/);
    plan=app.services.dispositions.recordEvent({planId:first.plan.id,eventType:"completed",evidenceRef:"closing://sale-123",externalRef:"sale-123",actor:"operator"});
    assert.equal(plan.status,"completed");
    assert.throws(()=>app.services.dispositions.recordEvent({planId:first.plan.id,eventType:"started",actor:"operator"}),/completed_disposition_is_terminal/);
    assert.throws(()=>app.db.prepare("UPDATE disposition_plans SET disposition_type='hold'").run(),/immutable/i);
    assert.throws(()=>app.db.prepare("UPDATE disposition_plan_events SET detail='rewrite'").run(),/disposition_event_append_only/i);
  }finally{app.close();tempDb.cleanup();}
});

test("disposition execution cannot start from hold/revise or a stale committee approval",()=>{
  const tempDb=makeTempDb(),app=createApp(testConfig(tempDb.dbPath));
  try{
    const held=seedExitReview(app.db,{suffix:"held",decision:"hold"});
    assert.throws(()=>app.services.dispositions.createPlan({handoffId:held.handoffId,reviewId:held.reviewId}),/approved_exit_decision_required/);

    const stale=seedExitReview(app.db,{suffix:"stale",decision:"approve_sell"});
    app.db.prepare(`INSERT INTO renovation_exit_reviews (id,handoff_id,decision,rationale,metrics_json,reviewed_by) VALUES ('review_stale_new',?,'hold','Market evidence changed','{}','committee')`).run(stale.handoffId);
    assert.throws(()=>app.services.dispositions.createPlan({handoffId:stale.handoffId,reviewId:stale.reviewId}),/latest_exit_review_required/);
  }finally{app.close();tempDb.cleanup();}
});
