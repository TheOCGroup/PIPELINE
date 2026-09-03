import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDb, testConfig } from "./helpers/temporaryDatabase.mjs";
import { createApp } from "../src/app/createApp.js";

function seedPresentedDeal(db, suffix = "risk", strategyType = "cash_purchase") {
  const opportunityId = `opp_${suffix}`;
  const offerId = `offer_${suffix}`;
  const versionId = `version_${suffix}`;
  db.prepare(`INSERT INTO seller_opportunities (id, opportunity_code, ocg_one_property_id, created_by, pipeline_stage, opportunity_status, offer_presented_at) VALUES (?, ?, ?, 'test', 'offer_presented', 'active', '2026-09-01T14:00:00Z')`).run(opportunityId, `RISK-${suffix}`, `property-${suffix}`);
  db.prepare(`INSERT INTO seller_offers (id, opportunity_id, current_version, status, active_version_id, created_by) VALUES (?, ?, 1, 'presented', NULL, 'test')`).run(offerId, opportunityId);
  db.prepare(`INSERT INTO seller_offer_versions (id, offer_id, version_number, version_status, strategy_type, purchase_price, earnest_money, inspection_days, closing_days, contingencies_json, underwriting_source_type, underwriting_source_id, underwriting_version_id, underwriting_arv_snapshot, underwriting_rehab_snapshot, underwriting_mao_snapshot, underwriting_confidence, created_by) VALUES (?, ?, 1, 'approved', ?, 145000, 1000, 10, 30, '[]', 'victor_analysis', 'victor-risk', '1', 235000, 30000, 155000, 0.9, 'test')`).run(versionId, offerId, strategyType);
  db.prepare("UPDATE seller_offers SET active_version_id = ? WHERE id = ?").run(versionId, offerId);
  db.prepare("UPDATE seller_opportunities SET pipeline_stage='offer_presented', opportunity_status='active' WHERE id=?").run(opportunityId);
  db.prepare("UPDATE seller_offers SET status='presented' WHERE id=?").run(offerId);
  return { opportunityId };
}

test("cash-purchase diligence derives deadlines without inventing a financing clearance", () => {
  const tempDb = makeTempDb();
  const app = createApp(testConfig(tempDb.dbPath));
  try {
    const { opportunityId } = seedPresentedDeal(app.db, "deadlines");
    app.services.transactions.transition({ opportunityId, action: "accept", actor: "test", effectiveAt: "2026-09-03T14:00:00Z" });
    app.services.transactions.transition({ opportunityId, action: "begin_due_diligence", actor: "test", effectiveAt: "2026-09-03T14:05:00Z" });
    const byKey = Object.fromEntries(app.services.transactions.listTasks(opportunityId).map(t => [t.taskKey, t]));

    assert.equal(byKey.property_inspection.dueAt, "2026-09-13T14:00:00Z");
    assert.equal(byKey.title_commitment.dueAt, "2026-09-10T14:00:00Z");
    assert.equal(byKey.earnest_money.dueAt, "2026-09-06T14:00:00Z");
    assert.equal(byKey.financing_clearance, undefined);
    assert.equal(byKey.insurance_binder.dueAt, "2026-09-30T14:00:00Z");
    assert.equal(byKey.final_walkthrough.dueAt, "2026-10-02T14:00:00Z");
    assert.equal(byKey.closing_statement.dueAt, "2026-10-02T14:00:00Z");
    assert.equal(byKey.final_walkthrough.requiredForScheduling, false);
    assert.equal(byKey.closing_statement.requiredForScheduling, false);
  } finally {
    app.close();
    tempDb.cleanup();
  }
});

test("financed strategies add financing clearance before closing can be scheduled", () => {
  const tempDb = makeTempDb();
  const app = createApp(testConfig(tempDb.dbPath));
  try {
    const { opportunityId } = seedPresentedDeal(app.db, "financed", "seller_finance");
    app.services.transactions.transition({ opportunityId, action: "accept", actor: "test", effectiveAt: "2026-09-03T14:00:00Z" });
    app.services.transactions.transition({ opportunityId, action: "begin_due_diligence", actor: "test", effectiveAt: "2026-09-03T14:05:00Z" });
    const financing = app.services.transactions.listTasks(opportunityId).find(t => t.taskKey === "financing_clearance");
    assert.ok(financing);
    assert.equal(financing.requiredForClosing, true);
    assert.equal(financing.requiredForScheduling, true);
    assert.equal(financing.dueAt, "2026-09-28T14:00:00Z");
  } finally {
    app.close();
    tempDb.cleanup();
  }
});

test("risk engine prioritizes blockers and overdue transaction deadlines", () => {
  const tempDb = makeTempDb();
  const app = createApp(testConfig(tempDb.dbPath));
  try {
    const { opportunityId } = seedPresentedDeal(app.db, "priority");
    app.services.transactions.transition({ opportunityId, action: "accept", actor: "test", effectiveAt: "2026-09-03T14:00:00Z" });
    app.services.transactions.transition({ opportunityId, action: "begin_due_diligence", actor: "test", effectiveAt: "2026-09-03T14:05:00Z" });

    const title = app.services.transactions.listTasks(opportunityId).find(t => t.taskKey === "title_commitment");
    app.services.transactions.upsertTask({ opportunityId, taskKey:title.taskKey, category:title.category, title:title.title, status:"blocked", requiredForClosing:title.requiredForClosing, requiredForScheduling:title.requiredForScheduling, dueAt:title.dueAt, blockerReason:"Unreleased lien found in title search", actor:"test" });

    const risk = app.services.transactions.riskReport(opportunityId, "2026-09-14T14:00:00Z");
    assert.equal(risk.riskLevel, "critical");
    assert.ok(risk.criticalCount >= 2);
    assert.equal(risk.risks[0].severity, "critical");
    assert.ok(risk.risks.some(r => r.kind === "title_blocked" && /lien/i.test(r.detail)));
    assert.ok(risk.risks.some(r => r.kind === "inspection_overdue"));
    assert.equal(risk.nextDeadline, "2026-09-06T14:00:00Z");
  } finally {
    app.close();
    tempDb.cleanup();
  }
});

test("Piper context receives transaction risk without recomputing underwriting", () => {
  const tempDb = makeTempDb();
  const app = createApp(testConfig(tempDb.dbPath));
  try {
    const { opportunityId } = seedPresentedDeal(app.db, "piper");
    app.services.transactions.transition({ opportunityId, action: "accept", actor: "test", effectiveAt: "2026-08-01T14:00:00Z" });
    app.services.transactions.transition({ opportunityId, action: "begin_due_diligence", actor: "test", effectiveAt: "2026-08-01T14:05:00Z" });

    const snapshot = app.services.piperContext.snapshot();
    const opp = snapshot.opportunities.find(o => o.id === opportunityId);
    assert.ok(opp.transactionRisk);
    assert.equal(opp.transactionRisk.riskLevel, "critical");
    assert.ok(opp.risks.some(r => r.source === "transaction-workflow"));
    assert.ok(snapshot.totals.criticalTransactionRisks > 0);
    assert.ok(snapshot.totals.transactionsAtRisk > 0);
  } finally {
    app.close();
    tempDb.cleanup();
  }
});
