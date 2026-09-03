import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDb, testConfig, startApp } from "./helpers/temporaryDatabase.mjs";
import { createApp } from "../src/app/createApp.js";
import { buildBrief } from "../src/domain/piper/briefModel.js";

function seedApprovedSell(db){
  const opportunityId="opp_disp_api", handoffId="exit_disp_api", reviewId="review_disp_api";
  db.prepare(`INSERT INTO seller_opportunities (id,opportunity_code,ocg_one_property_id,created_by,pipeline_stage,opportunity_status,closed_at) VALUES (?, 'DISP-API', 'property-disp-api', 'test', 'closed', 'closed_purchased', '2026-09-25T16:00:00Z')`).run(opportunityId);
  const payload={contractVersion:"1.0",sourceSystem:"mission-control",targetSystem:"ocg-os",handoffType:"renovation_exit_ready",sourceOpportunityId:opportunityId,renovation:{projectId:"reno-api",completionEvidenceRef:"album://final"},exitEvaluation:{originalDecision:"sell",recommendedDecision:"sell",confidence:"medium",requiresInvestmentCommittee:true,metrics:{projectedSaleProfit:40000}},decisionStatus:"investment_committee_required"};
  db.prepare(`INSERT INTO renovation_exit_handoffs (id,opportunity_id,source_project_id,payload_json,original_decision,recommended_decision,confidence,received_by) VALUES (?,?,?,?, 'sell','sell','medium','test')`).run(handoffId,opportunityId,"reno-api",JSON.stringify(payload));
  db.prepare(`INSERT INTO renovation_exit_reviews (id,handoff_id,decision,rationale,metrics_json,reviewed_by) VALUES (?,?, 'approve_sell','Approved sale','{}','committee')`).run(reviewId,handoffId);
  return {opportunityId,handoffId,reviewId};
}

async function post(baseUrl,path,body){
  const res=await fetch(`${baseUrl}${path}`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
  return {status:res.status,body:await res.json()};
}

test("operator API exposes governed disposition execution and Piper surfaces blockers",async(t)=>{
  const tempDb=makeTempDb(); t.after(()=>tempDb.cleanup());
  const {app,baseUrl}=await startApp(createApp,testConfig(tempDb.dbPath,{readOnly:false,isTest:false}));
  t.after(()=>app.server.close());
  const seeded=seedApprovedSell(app.db);

  const created=await post(baseUrl,"/api/v1/operator/dispositions",{handoffId:seeded.handoffId,reviewId:seeded.reviewId});
  assert.equal(created.status,201);
  assert.equal(created.body.data.plan.dispositionType,"sell");
  const planId=created.body.data.plan.id;
  const requirements=created.body.data.plan.requirements;

  const listed=await fetch(`${baseUrl}/api/v1/operator/dispositions?opportunityId=${seeded.opportunityId}`);
  assert.equal(listed.status,200);
  const listedBody=await listed.json();
  assert.equal(listedBody.data.plans.length,1);
  assert.equal(listedBody.data.plans[0].status,"ready");

  const blocked=await post(baseUrl,`/api/v1/operator/dispositions/${planId}`,{eventType:"blocked",detail:"Title company needs final release"});
  assert.equal(blocked.status,200);
  assert.equal(blocked.body.data.plan.status,"blocked");

  const snapshot=app.services.piperContext.snapshot();
  const opportunity=snapshot.opportunities.find(o=>o.id===seeded.opportunityId);
  assert.ok(opportunity);
  assert.equal(opportunity.disposition.status,"blocked");
  assert.match(opportunity.dispositionNextAction,/Resolve sell disposition blocker/);
  assert.ok(opportunity.risks.some(r=>r.source==="post-renovation-disposition"&&r.severity==="high"));
  assert.ok(snapshot.totals.blockedDispositions>=1);

  const brief=buildBrief(snapshot);
  const exitSection=brief.sections.find(s=>s.title==="EXIT EXECUTION");
  assert.ok(exitSection,"closed purchased property remains visible while disposition is active");
  assert.ok(exitSection.items.some(i=>i.opportunityId===seeded.opportunityId));
  assert.ok(brief.sections.find(s=>s.title==="NEXT")?.items.some(i=>i.opportunityId===seeded.opportunityId));

  const premature=await post(baseUrl,`/api/v1/operator/dispositions/${planId}`,{eventType:"completed",evidenceRef:"closing://sale"});
  assert.equal(premature.status,409);
  assert.match(premature.body.error,/disposition_requirements_incomplete:/);

  for(const requirementKey of requirements){
    const verified=await post(baseUrl,`/api/v1/operator/dispositions/${planId}/requirements`,{requirementKey,evidenceRef:`evidence://${requirementKey}`});
    assert.equal(verified.status,200);
  }
  const ready=app.services.dispositions.get(planId);
  assert.equal(ready.requirementsComplete,true);
});
