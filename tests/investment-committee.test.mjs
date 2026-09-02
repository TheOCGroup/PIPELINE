import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDb, testConfig } from "./helpers/temporaryDatabase.mjs";
import { createApp } from "../src/app/createApp.js";

function seedDeal(db, suffix, { price, arv, rehab, mao, confidence, dscr }) {
  const opportunityId = `opp_committee_${suffix}`;
  const offerId = `off_committee_${suffix}`;
  const versionId = `ver_committee_${suffix}_1`;
  const underwritingId = `uw_committee_${suffix}`;

  db.prepare(`
    INSERT INTO seller_opportunities
      (id, opportunity_code, ocg_one_property_id, created_by, pipeline_stage)
    VALUES (?, ?, ?, 'test', 'offer_approval_required')
  `).run(opportunityId, `COMMITTEE-${suffix}`, `property-${suffix}`);

  db.prepare(`
    INSERT INTO opportunity_underwriting_refs
      (id, opportunity_id, source_system, source_agent, source_underwriting_id,
       arv, rehab, mao, confidence, evidence_summary_json, analyzed_at)
    VALUES (?, ?, 'deal-scout', 'Victor', ?, ?, ?, ?, ?, ?, '2026-09-02T18:00:00Z')
  `).run(
    underwritingId,
    opportunityId,
    `victor-${suffix}`,
    arv,
    rehab,
    mao,
    confidence,
    JSON.stringify({ hold: { strategy: "DSCR", dscr, noi: 1800, monthlyDebtService: 1400 } })
  );

  db.prepare(`
    INSERT INTO seller_offers
      (id, opportunity_id, current_version, status, active_version_id, created_by)
    VALUES (?, ?, 1, 'draft', NULL, 'test')
  `).run(offerId, opportunityId);

  db.prepare(`
    INSERT INTO seller_offer_versions (
      id, offer_id, version_number, version_status, strategy_type, purchase_price,
      earnest_money, inspection_days, closing_days, contingencies_json,
      underwriting_source_type, underwriting_source_id, underwriting_version_id,
      underwriting_arv_snapshot, underwriting_rehab_snapshot, underwriting_mao_snapshot,
      underwriting_confidence, created_by
    ) VALUES (?, ?, 1, 'draft', 'cash_purchase', ?, 1000, 10, 30, '[]',
              'victor_analysis', ?, '1', ?, ?, ?, ?, 'test')
  `).run(versionId, offerId, price, `victor-${suffix}`, arv, rehab, mao, confidence);

  db.prepare("UPDATE seller_offers SET active_version_id = ? WHERE id = ?").run(versionId, offerId);
  return { opportunityId, offerId, versionId, underwritingId };
}

test("Investment Committee kills an offer above MAO and blocks approval", () => {
  const tempDb = makeTempDb();
  const app = createApp(testConfig(tempDb.dbPath));
  try {
    const deal = seedDeal(app.db, "kill", {
      price: 180000,
      arv: 240000,
      rehab: 35000,
      mao: 160000,
      confidence: 0.88,
      dscr: 1.31,
    });

    assert.throws(
      () => app.db.prepare("UPDATE seller_offers SET status = 'approved' WHERE id = ?").run(deal.offerId),
      /investment_committee_approval_required/
    );

    const review = app.services.investmentCommittee.reviewActiveOffer({ opportunityId: deal.opportunityId });
    assert.equal(review.decision, "kill");
    assert.ok(review.risks.some((risk) => risk.includes("exceeds Victor MAO")));

    assert.throws(
      () => app.db.prepare("UPDATE seller_offers SET status = 'approved' WHERE id = ?").run(deal.offerId),
      /investment_committee_approval_required/
    );
  } finally {
    app.close();
    tempDb.cleanup();
  }
});

test("Investment Committee approval clears only the reviewed active offer version", () => {
  const tempDb = makeTempDb();
  const app = createApp(testConfig(tempDb.dbPath));
  try {
    const deal = seedDeal(app.db, "approve", {
      price: 145000,
      arv: 235000,
      rehab: 30000,
      mao: 155000,
      confidence: 0.9,
      dscr: 1.34,
    });

    const review = app.services.investmentCommittee.reviewActiveOffer({ opportunityId: deal.opportunityId, actor: "committee-test" });
    assert.equal(review.decision, "approve");
    assert.equal(review.offerVersionId, deal.versionId);

    app.db.prepare("UPDATE seller_offers SET status = 'approved' WHERE id = ?").run(deal.offerId);
    assert.equal(app.db.prepare("SELECT status FROM seller_offers WHERE id = ?").get(deal.offerId).status, "approved");

    assert.throws(
      () => app.db.prepare("UPDATE investment_committee_reviews SET rationale = 'rewritten' WHERE id = ?").run(review.id),
      /append-only/i
    );
  } finally {
    app.close();
    tempDb.cleanup();
  }
});

test("Low DSCR independently stops an otherwise acceptable offer", () => {
  const tempDb = makeTempDb();
  const app = createApp(testConfig(tempDb.dbPath));
  try {
    const deal = seedDeal(app.db, "dscr", {
      price: 140000,
      arv: 230000,
      rehab: 30000,
      mao: 155000,
      confidence: 0.92,
      dscr: 0.94,
    });

    const review = app.services.investmentCommittee.reviewActiveOffer({ opportunityId: deal.opportunityId });
    assert.equal(review.decision, "kill");
    assert.ok(review.risks.some((risk) => risk.includes("does not cover debt service")));
  } finally {
    app.close();
    tempDb.cleanup();
  }
});
