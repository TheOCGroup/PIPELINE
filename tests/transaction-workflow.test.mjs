import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDb, testConfig } from "./helpers/temporaryDatabase.mjs";
import { createApp } from "../src/app/createApp.js";

function seedPresentedDeal(db, suffix = "happy") {
  const opportunityId=`opp_tx_${suffix}`, offerId=`off_tx_${suffix}`, versionId=`ver_tx_${suffix}_1`;
  db.prepare(`INSERT INTO seller_opportunities (id, opportunity_code, ocg_one_property_id, created_by, pipeline_stage, opportunity_status, offer_presented_at) VALUES (?, ?, ?, 'test', 'offer_presented', 'active', '2026-09-02T20:00:00Z')`).run(opportunityId,`TX-${suffix}`,`property-tx-${suffix}`);
  db.prepare(`INSERT INTO seller_offers (id, opportunity_id, current_version, status, active_version_id, created_by) VALUES (?, ?, 1, 'presented', NULL, 'test')`).run(offerId,opportunityId);
  db.prepare(`INSERT INTO seller_offer_versions (id, offer_id, version_number, version_status, strategy_type, purchase_price, earnest_money, inspection_days, closing_days, contingencies_json, underwriting_source_type, underwriting_source_id, underwriting_version_id, underwriting_arv_snapshot, underwriting_rehab_snapshot, underwriting_mao_snapshot, underwriting_confidence, created_by) VALUES (?, ?, 1, 'approved', 'cash_purchase', 145000, 1000, 10, 30, '[]', 'victor_analysis', 'victor-tx', '1', 235000, 30000, 155000, 0.9, 'test')`).run(versionId,offerId);
  db.prepare("UPDATE seller_offers SET active_version_id = ? WHERE id = ?").run(versionId,offerId);
  db.prepare("UPDATE seller_opportunities SET pipeline_stage = 'offer_presented', opportunity_status = 'active' WHERE id = ?").run(opportunityId);
  db.prepare("UPDATE seller_offers SET status = 'presented' WHERE id = ?").run(offerId);
  return {opportunityId,offerId,versionId};
}

function completeClosingTasks(service, opportunityId) {
  const tasks=service.listTasks(opportunityId);
  assert.equal(tasks.length,6);
  for(const task of tasks) service.upsertTask({ opportunityId, taskKey:task.taskKey, category:task.category, title:task.title, status:"complete", requiredForClosing:true, dueAt:task.dueAt, evidenceRef:`evidence://${task.taskKey}`, actor:"test", reason:"Verified for closing" });
}

test("post-offer workflow requires evidenced diligence and reaches closed purchase",()=>{
 const tempDb=makeTempDb(), app=createApp(testConfig(tempDb.dbPath));
 try{
  const deal=seedPresentedDeal(app.db);
  let m=app.services.transactions.transition({opportunityId:deal.opportunityId,action:"start_negotiation",actor:"test"}); assert.equal(m.type,"negotiation_started");
  m=app.services.transactions.transition({opportunityId:deal.opportunityId,action:"accept",actor:"test",effectiveAt:"2026-09-03T14:00:00Z"}); assert.equal(m.type,"seller_accepted");
  app.services.transactions.transition({opportunityId:deal.opportunityId,action:"begin_due_diligence",actor:"test"});
  let readiness=app.services.transactions.readiness(deal.opportunityId); assert.equal(readiness.readyToScheduleClosing,false); assert.equal(readiness.unresolvedCount,6);
  assert.throws(()=>app.services.transactions.transition({opportunityId:deal.opportunityId,action:"schedule_closing",actor:"test",scheduledClosingAt:"2026-09-25T15:00:00Z"}),/closing_readiness_incomplete/);
  assert.throws(()=>{const t=app.services.transactions.listTasks(deal.opportunityId)[0];app.services.transactions.upsertTask({opportunityId:deal.opportunityId,taskKey:t.taskKey,category:t.category,title:t.title,status:"complete",requiredForClosing:true,actor:"test"});},/closing_task_evidence_required/);
  completeClosingTasks(app.services.transactions,deal.opportunityId);
  readiness=app.services.transactions.readiness(deal.opportunityId); assert.equal(readiness.readyToScheduleClosing,true); assert.equal(readiness.unresolvedCount,0);
  app.services.transactions.transition({opportunityId:deal.opportunityId,action:"schedule_closing",actor:"test",scheduledClosingAt:"2026-09-25T15:00:00Z"});
  app.services.transactions.transition({opportunityId:deal.opportunityId,action:"close",actor:"test",effectiveAt:"2026-09-25T16:00:00Z"});
  const opp=app.db.prepare("SELECT * FROM seller_opportunities WHERE id = ?").get(deal.opportunityId); assert.equal(opp.pipeline_stage,"closed"); assert.equal(opp.opportunity_status,"closed_purchased");
  const outcome=app.db.prepare("SELECT * FROM seller_opportunity_outcomes WHERE opportunity_id = ? ORDER BY rowid DESC LIMIT 1").get(deal.opportunityId); assert.equal(outcome.outcome_type,"purchased"); assert.equal(outcome.reopen_eligibility,"permanently_closed");
  assert.equal(app.services.transactions.listMilestones(deal.opportunityId).length,5);
  const eventCount=app.db.prepare("SELECT COUNT(*) n FROM transaction_task_events").get().n; assert.equal(eventCount,6);
  assert.throws(()=>app.db.prepare("UPDATE transaction_task_events SET reason='rewrite'").run(),/append-only/i);
 }finally{app.close();tempDb.cleanup();}
});

test("transaction workflow refuses stage skipping, tracks blockers, and records loss",()=>{
 const tempDb=makeTempDb(),app=createApp(testConfig(tempDb.dbPath));
 try{
  const deal=seedPresentedDeal(app.db,"guard");
  assert.throws(()=>app.services.transactions.transition({opportunityId:deal.opportunityId,action:"schedule_closing",scheduledClosingAt:"2026-09-25T15:00:00Z"}),/due_diligence_required/);
  app.services.transactions.transition({opportunityId:deal.opportunityId,action:"accept",actor:"test"});
  app.services.transactions.transition({opportunityId:deal.opportunityId,action:"begin_due_diligence",actor:"test"});
  const title=app.services.transactions.listTasks(deal.opportunityId).find(t=>t.category==="title");
  app.services.transactions.upsertTask({opportunityId:deal.opportunityId,taskKey:title.taskKey,category:title.category,title:title.title,status:"blocked",requiredForClosing:true,blockerReason:"Unreleased lien",actor:"test"});
  const readiness=app.services.transactions.readiness(deal.opportunityId); assert.equal(readiness.blockedCount,1); assert.match(readiness.blocked[0].blockerReason,/lien/);
  const milestone=app.services.transactions.transition({opportunityId:deal.opportunityId,action:"lose",actor:"test",reason:"Title defect could not be cured"}); assert.equal(milestone.type,"transaction_lost");
  const opp=app.db.prepare("SELECT * FROM seller_opportunities WHERE id = ?").get(deal.opportunityId); assert.equal(opp.pipeline_stage,"lost"); assert.equal(opp.opportunity_status,"closed_lost");
 }finally{app.close();tempDb.cleanup();}
});
