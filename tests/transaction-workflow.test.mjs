import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDb, testConfig } from "./helpers/temporaryDatabase.mjs";
import { createApp } from "../src/app/createApp.js";

function seedPresentedDeal(db, suffix = "happy") {
  const opportunityId = `opp_tx_${suffix}`;
  const offerId = `off_tx_${suffix}`;
  const versionId = `ver_tx_${suffix}_1`;

  db.prepare(`
    INSERT INTO seller_opportunities
      (id, opportunity_code, ocg_one_property_id, created_by, pipeline_stage, opportunity_status, offer_presented_at)
    VALUES (?, ?, ?, 'test', 'offer_presented', 'active', '2026-09-02T20:00:00Z')
  `).run(opportunityId, `TX-${suffix}`, `property-tx-${suffix}`);

  db.prepare(`
    INSERT INTO seller_offers
      (id, opportunity_id, current_version, status, active_version_id, created_by)
    VALUES (?, ?, 1, 'presented', NULL, 'test')
  `).run(offerId, opportunityId);

  db.prepare(`
    INSERT INTO seller_offer_versions (
      id, offer_id, version_number, version_status, strategy_type, purchase_price,
      earnest_money, inspection_days, closing_days, contingencies_json,
      underwriting_source_type, underwriting_source_id, underwriting_version_id,
      underwriting_arv_snapshot, underwriting_rehab_snapshot, underwriting_mao_snapshot,
      underwriting_confidence, created_by
    ) VALUES (?, ?, 1, 'approved', 'cash_purchase', 145000, 1000, 10, 30, '[]',
              'victor_analysis', 'victor-tx', '1', 235000, 30000, 155000, 0.9, 'test')
  `).run(versionId, offerId);

  db.prepare("UPDATE seller_offers SET active_version_id = ? WHERE id = ?").run(versionId, offerId);
  // Migration 015 moves a newly-active version back into preparation; emulate the
  // already-presented production state after the successful seller send.
  db.prepare("UPDATE seller_opportunities SET pipeline_stage = 'offer_presented', opportunity_status = 'active' WHERE id = ?").run(opportunityId);
  db.prepare("UPDATE seller_offers SET status = 'presented' WHERE id = ?").run(offerId);

  return { opportunityId, offerId, versionId };
}

test("post-offer workflow reaches closed purchase through governed milestones", () => {
  const tempDb = makeTempDb();
  const app = createApp(testConfig(tempDb.dbPath));
  try {
    const deal = seedPresentedDeal(app.db);

    let m = app.services.transactions.transition({ opportunityId: deal.opportunityId, action: "start_negotiation", actor: "test" });
    assert.equal(m.type, "negotiation_started");
    assert.equal(app.db.prepare("SELECT pipeline_stage FROM seller_opportunities WHERE id = ?").get(deal.opportunityId).pipeline_stage, "negotiating");
    assert.equal(app.db.prepare("SELECT status FROM seller_offers WHERE id = ?").get(deal.offerId).status, "countered");

    m = app.services.transactions.transition({ opportunityId: deal.opportunityId, action: "accept", actor: "test", effectiveAt: "2026-09-03T14:00:00Z" });
    assert.equal(m.type, "seller_accepted");
    let opp = app.db.prepare("SELECT * FROM seller_opportunities WHERE id = ?").get(deal.opportunityId);
    assert.equal(opp.pipeline_stage, "under_contract");
    assert.equal(opp.opportunity_status, "under_contract");
    assert.equal(opp.contract_executed_at, "2026-09-03T14:00:00Z");
    assert.equal(app.db.prepare("SELECT status FROM seller_offers WHERE id = ?").get(deal.offerId).status, "accepted");

    app.services.transactions.transition({ opportunityId: deal.opportunityId, action: "begin_due_diligence", actor: "test" });
    opp = app.db.prepare("SELECT * FROM seller_opportunities WHERE id = ?").get(deal.opportunityId);
    assert.equal(opp.pipeline_stage, "due_diligence");

    app.services.transactions.transition({
      opportunityId: deal.opportunityId,
      action: "schedule_closing",
      actor: "test",
      scheduledClosingAt: "2026-09-25T15:00:00Z"
    });
    opp = app.db.prepare("SELECT * FROM seller_opportunities WHERE id = ?").get(deal.opportunityId);
    assert.equal(opp.pipeline_stage, "closing_scheduled");
    assert.equal(opp.scheduled_closing_at, "2026-09-25T15:00:00Z");

    app.services.transactions.transition({ opportunityId: deal.opportunityId, action: "close", actor: "test", effectiveAt: "2026-09-25T16:00:00Z" });
    opp = app.db.prepare("SELECT * FROM seller_opportunities WHERE id = ?").get(deal.opportunityId);
    assert.equal(opp.pipeline_stage, "closed");
    assert.equal(opp.opportunity_status, "closed_purchased");
    assert.equal(opp.closed_at, "2026-09-25T16:00:00Z");

    const outcome = app.db.prepare("SELECT * FROM seller_opportunity_outcomes WHERE opportunity_id = ? ORDER BY rowid DESC LIMIT 1").get(deal.opportunityId);
    assert.equal(outcome.outcome_type, "purchased");
    assert.equal(outcome.reopen_eligibility, "permanently_closed");

    const milestones = app.services.transactions.listMilestones(deal.opportunityId);
    assert.equal(milestones.length, 5);
    assert.deepEqual(new Set(milestones.map(x => x.type)), new Set([
      "negotiation_started", "seller_accepted", "due_diligence_started", "closing_scheduled", "closed_purchased"
    ]));

    assert.throws(
      () => app.db.prepare("UPDATE transaction_milestones SET milestone_type = 'transaction_lost' WHERE opportunity_id = ?").run(deal.opportunityId),
      /append-only/i
    );
  } finally {
    app.close();
    tempDb.cleanup();
  }
});

test("transaction workflow refuses stage skipping and records a lost deal", () => {
  const tempDb = makeTempDb();
  const app = createApp(testConfig(tempDb.dbPath));
  try {
    const deal = seedPresentedDeal(app.db, "guard");

    assert.throws(
      () => app.services.transactions.transition({
        opportunityId: deal.opportunityId,
        action: "schedule_closing",
        scheduledClosingAt: "2026-09-25T15:00:00Z"
      }),
      /due_diligence_required/
    );

    const milestone = app.services.transactions.transition({
      opportunityId: deal.opportunityId,
      action: "lose",
      actor: "test",
      reason: "Seller accepted a competing offer"
    });
    assert.equal(milestone.type, "transaction_lost");

    const opp = app.db.prepare("SELECT * FROM seller_opportunities WHERE id = ?").get(deal.opportunityId);
    assert.equal(opp.pipeline_stage, "lost");
    assert.equal(opp.opportunity_status, "closed_lost");

    const outcome = app.db.prepare("SELECT * FROM seller_opportunity_outcomes WHERE opportunity_id = ? ORDER BY rowid DESC LIMIT 1").get(deal.opportunityId);
    assert.equal(outcome.outcome_type, "other");
    assert.match(outcome.reason, /competing offer/);
  } finally {
    app.close();
    tempDb.cleanup();
  }
});
