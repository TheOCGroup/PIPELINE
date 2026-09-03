import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDb, testConfig } from "./helpers/temporaryDatabase.mjs";
import { createApp } from "../src/app/createApp.js";

function seedClosedPurchase(db, id="opp_exit_1") {
  db.prepare(`INSERT INTO seller_opportunities (id, opportunity_code, ocg_one_property_id, created_by, pipeline_stage, opportunity_status, closed_at)
    VALUES (?, 'EXIT-1', 'property-exit-1', 'test', 'closed', 'closed_purchased', '2026-09-25T16:00:00Z')`).run(id);
  return id;
}

function handoff(opportunityId) {
  return {
    contractVersion:"1.0",
    sourceSystem:"mission-control",
    targetSystem:"ocg-os",
    handoffType:"renovation_exit_ready",
    sourceOpportunityId:opportunityId,
    propertyId:"property-exit-1",
    address:"123 Main St",
    renovation:{
      contractVersion:"1.0",
      sourceSystem:"mission-control",
      projectId:"reno-project-1",
      sourceOpportunityId:opportunityId,
      propertyId:"property-exit-1",
      address:"123 Main St",
      exitDecision:"sell",
      acquisitionPrice:145000,
      arvBaseline:235000,
      approvedBudget:30000,
      committedCost:32000,
      finalSpend:32000,
      approvedDraws:28000,
      completionEvidenceRef:"album://final",
      completedAt:"2026-10-01T18:00:00Z",
      contractorScorecards:[]
    },
    exitEvaluation:{
      contractVersion:"1.0",
      sourceSystem:"mission-control",
      sourceOpportunityId:opportunityId,
      propertyId:"property-exit-1",
      address:"123 Main St",
      originalDecision:"sell",
      recommendedDecision:"sell",
      confidence:"medium",
      requiresInvestmentCommittee:true,
      metrics:{totalBasis:177000,arv:235000,expectedSalePrice:240000,netSaleProceeds:220800,projectedSaleProfit:43800,monthlyRent:2200,monthlyOperatingExpenses:500,monthlyNoi:1700,monthlyDebtService:1500,dscr:1.133,refinanceAmount:176250,equityRemaining:58750},
      evidence:{completionEvidenceRef:"album://final",hasFreshSalePrice:true,hasFreshRent:true,hasDebtService:true,hasRefinanceAmount:true},
      limitations:[]
    },
    decisionStatus:"investment_committee_required"
  };
}

test("Mission Control exit handoff returns to OCG OS and cannot bypass Investment Committee",()=>{
  const tempDb=makeTempDb(), app=createApp(testConfig(tempDb.dbPath));
  try {
    const opportunityId=seedClosedPurchase(app.db);
    const first=app.services.renovationExits.receive({payload:handoff(opportunityId),actor:"mission-control"});
    assert.equal(first.duplicate,false);
    assert.equal(first.handoff.originalDecision,"sell");
    assert.equal(first.handoff.recommendedDecision,"sell");
    assert.equal(first.handoff.payload.decisionStatus,"investment_committee_required");

    const duplicate=app.services.renovationExits.receive({payload:handoff(opportunityId),actor:"mission-control"});
    assert.equal(duplicate.duplicate,true);
    assert.equal(duplicate.handoff.id,first.handoff.id);

    assert.throws(()=>app.services.renovationExits.review({handoffId:first.handoff.id,decision:"approve_hold",rationale:"Prefer rental",actor:"committee"}),/exit_review_conflicts_with_evidence/);
    const approved=app.services.renovationExits.review({handoffId:first.handoff.id,decision:"approve_sell",rationale:"Fresh sale evidence supports disposition",actor:"committee"});
    assert.equal(approved.decision,"approve_sell");
    assert.equal(app.services.renovationExits.reviews(first.handoff.id).length,1);

    assert.throws(()=>app.db.prepare("UPDATE renovation_exit_handoffs SET original_decision='hold'").run(),/immutable/i);
    assert.throws(()=>app.db.prepare("UPDATE renovation_exit_reviews SET rationale='rewrite'").run(),/append[_-]only/i);
  } finally { app.close(); tempDb.cleanup(); }
});

test("exit receiver refuses incomplete renovation evidence and non-purchased opportunities",()=>{
  const tempDb=makeTempDb(), app=createApp(testConfig(tempDb.dbPath));
  try {
    const opportunityId="opp_exit_bad";
    app.db.prepare(`INSERT INTO seller_opportunities (id, opportunity_code, ocg_one_property_id, created_by, pipeline_stage, opportunity_status) VALUES (?, 'EXIT-BAD', 'property-exit-bad', 'test', 'due_diligence', 'under_contract')`).run(opportunityId);
    assert.throws(()=>app.services.renovationExits.receive({payload:handoff(opportunityId)}),/closed_purchase_required/);
    const closedId=seedClosedPurchase(app.db,"opp_exit_missing_evidence");
    const payload=handoff(closedId); delete payload.renovation.completionEvidenceRef;
    assert.throws(()=>app.services.renovationExits.receive({payload}),/renovation_completion_evidence_required/);
  } finally { app.close(); tempDb.cleanup(); }
});
