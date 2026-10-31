/**
 * Deterministic underwriting-ref selection for offers (Audit B adjacent
 * finding).
 *
 * Offer preparation/modification must cite the SAME underwriting ref the
 * investment committee evaluates: the latest by analyzed_at, tie-broken
 * `analyzed_at DESC, created_at DESC, rowid DESC` (the committee's exact
 * ORDER BY in investmentCommitteeService.js). Before this fix, prepare and
 * modify selected with no ORDER BY, so the cited ref depended on physical
 * row order whenever an opportunity carried more than one ref (e.g. a
 * Victor analysis plus later operator assumptions).
 *
 * Case A inserts the older ref first and the newer ref second; Case B
 * inserts them in the opposite order with the timestamps swapped. In both
 * cases selection must follow analyzed_at, never insertion order.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app/createApp.js";
import { makeTempDb, testConfig, startApp } from "./helpers/temporaryDatabase.mjs";

function seedOpportunity(db, id) {
  db.prepare(`
    INSERT INTO seller_opportunities (id, tenant_id, opportunity_code, pipeline_stage,
      opportunity_status, created_by, ocg_one_property_id, asking_price)
    VALUES (?, 'ocg-one', ?, 'new_lead', 'active', 'seed', ?, 120000)
  `).run(id, `OPP-${id}`, `prop-${id}`);
}

function seedRef(db, { id, opportunityId, sourceSystem, sourceAgent, analyzedAt, arv }) {
  db.prepare(`
    INSERT INTO opportunity_underwriting_refs (id, opportunity_id, source_system, source_agent,
      analysis_status, arv, rehab, mao, confidence, limitations, analyzed_at)
    VALUES (?, ?, ?, ?, 'completed', ?, 30000, ?, 0.8, 'test ref', ?)
  `).run(id, opportunityId, sourceSystem, sourceAgent, arv, Math.round(arv * 0.6), analyzedAt);
}

async function prepareOffer(baseUrl, opportunityId) {
  const res = await fetch(`${baseUrl}/api/v1/operator/offers`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      opportunityId, proposedPrice: 90000, strategyType: "cash_purchase",
      earnestMoney: 1000, inspectionDays: 10, closingDays: 30,
    }),
  });
  assert.equal(res.status, 201);
  return (await res.json()).data.offer;
}

test("offer prepare/modify cite the latest underwriting ref by analyzed_at, matching the committee", async (t) => {
  const tempDb = makeTempDb();
  t.after(() => tempDb.cleanup());
  const { app, baseUrl } = await startApp(createApp, testConfig(tempDb.dbPath, { dataSource: "empty" }));
  t.after(() => app.close());
  const db = app.db;

  // Case A: older Victor ref inserted FIRST, newer operator-assumption ref
  // inserted SECOND.
  seedOpportunity(db, "opp-refsel-a");
  seedRef(db, {
    id: "ref-a-victor", opportunityId: "opp-refsel-a", sourceSystem: "deal-scout",
    sourceAgent: "Victor", analyzedAt: "2026-08-01T00:00:00.000Z", arv: 200000,
  });
  seedRef(db, {
    id: "ref-a-operator", opportunityId: "opp-refsel-a", sourceSystem: "operator_assumption",
    sourceAgent: "operator", analyzedAt: "2026-09-15T00:00:00.000Z", arv: 210000,
  });

  const offerA = await prepareOffer(baseUrl, "opp-refsel-a");
  assert.equal(offerA.versions.length, 1);
  assert.equal(offerA.versions[0].underwritingRefId, "ref-a-operator",
    "prepare must cite the newest ref by analyzed_at");

  // The committee evaluates the same ref the offer cites.
  const reviewRes = await fetch(`${baseUrl}/api/v1/investment-committee/review`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ opportunityId: "opp-refsel-a" }),
  });
  assert.equal(reviewRes.status, 200);
  const review = (await reviewRes.json()).review;
  assert.equal(review.underwritingRefId, "ref-a-operator",
    "committee and offer must agree on the underwriting ref");

  // Modify path: the new version cites the same latest ref.
  const modifyRes = await fetch(`${baseUrl}/api/v1/operator/offers/${offerA.id}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "modify", proposedPrice: 95000 }),
  });
  assert.equal(modifyRes.status, 200);
  const modified = (await modifyRes.json()).data.offer;
  const activeVersion = modified.versions.find((v) => v.id === modified.activeVersionId);
  assert.equal(activeVersion.underwritingRefId, "ref-a-operator",
    "modify must cite the newest ref by analyzed_at");

  // Case B: timestamps reversed relative to insertion order — the operator
  // ref is inserted FIRST but is OLDER; the Victor ref inserted second is
  // NEWER. Selection must follow analyzed_at, not rowid/insertion order.
  seedOpportunity(db, "opp-refsel-b");
  seedRef(db, {
    id: "ref-b-operator", opportunityId: "opp-refsel-b", sourceSystem: "operator_assumption",
    sourceAgent: "operator", analyzedAt: "2026-08-01T00:00:00.000Z", arv: 180000,
  });
  seedRef(db, {
    id: "ref-b-victor", opportunityId: "opp-refsel-b", sourceSystem: "deal-scout",
    sourceAgent: "Victor", analyzedAt: "2026-09-15T00:00:00.000Z", arv: 195000,
  });

  const offerB = await prepareOffer(baseUrl, "opp-refsel-b");
  assert.equal(offerB.versions.length, 1);
  assert.equal(offerB.versions[0].underwritingRefId, "ref-b-victor",
    "selection follows analyzed_at even when the newer ref was inserted last");

  const storedB = db.prepare(
    "SELECT underwriting_ref_id FROM seller_offer_versions WHERE id = ?"
  ).get(offerB.versions[0].id);
  assert.equal(storedB.underwriting_ref_id, "ref-b-victor", "stored row cites the newest ref");
});
