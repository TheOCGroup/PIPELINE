import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDb, testConfig } from "./helpers/temporaryDatabase.mjs";
import { createApp } from "../src/app/createApp.js";
import { buildSellerTimeline } from "../src/services/sellerTimelineService.js";

// Regression battery for the 2026-10-25 acceptance findings:
//   U1/U4 — unknown underwriting figures must remain unknown (never 0)
//   U3    — every workflow transition / decision must be timeline-visible
//   U5    — offer versions must trace to the VICTOR underwriting reference

function seedNullEvidenceDeal(app, suffix) {
  const db = app.db;
  const opportunityId = `opp_hard_${suffix}`;
  const refId = `uw_hard_${suffix}`;
  db.prepare(`
    INSERT INTO seller_opportunities (id, opportunity_code, ocg_one_property_id, created_by, pipeline_stage)
    VALUES (?, ?, ?, 'test', 'property_review')
  `).run(opportunityId, `HARD-${suffix}`, `property-${suffix}`);
  db.prepare(`
    INSERT INTO opportunity_underwriting_refs
      (id, opportunity_id, source_system, source_agent, source_project_id,
       source_underwriting_id, source_version_id, analysis_status,
       arv, rehab, mao, confidence, limitations, evidence_summary_json, analyzed_at)
    VALUES (?, ?, 'deal-scout', 'Victor', ?, NULL, '2.0', 'insufficient_evidence',
            NULL, NULL, NULL, NULL, ?, ?, '2026-10-25T15:21:03Z')
  `).run(
    refId,
    opportunityId,
    `hunter-${suffix}`,
    "No published figures; ARV, rehab and MAO not estimated.",
    JSON.stringify({ comps: [], compsCount: 0, hold: { strategy: null, dscr: null, noi: null, monthlyDebtService: null } })
  );
  db.prepare(`
    INSERT INTO seller_opportunity_sources
      (id, opportunity_id, source_type, source_record_id, original_address, source_timestamp, conversion_actor, conversion_timestamp, provenance_metadata_json)
    VALUES (?, ?, 'deal_scout_handoff', ?, '10410 w taft ct, wichita, ks 67209', '2026-10-25T15:21:03Z', 'victor', '2026-10-25T15:21:10Z', ?)
  `).run(`src_hard_${suffix}`, opportunityId, `hunter-${suffix}`,
         JSON.stringify({ originSystem: "deal-scout", originAgent: "Victor", apn: "249545" }));
  db.prepare(`
    INSERT INTO source_provenance (id, opportunity_id, original_source_json, resolution_status)
    VALUES (?, ?, ?, 'original_resolved')
  `).run(`prov_hard_${suffix}`, opportunityId, JSON.stringify({ source: "deal-scout", apn: "249545" }));
  return { opportunityId, refId };
}

function prepareDraft(app, opportunityId) {
  return app.services.operator.prepareOffer({
    opportunityId,
    proposedPrice: 100000,
    strategyType: "cash_purchase",
    earnestMoney: 2500,
    inspectionDays: 7,
    closingDays: 30,
    internalNotes: "hardening regression draft",
    actor: "founder-operator",
  });
}

test("U1/U5: offer snapshots present unknown figures as null and trace to the VICTOR reference", () => {
  const tempDb = makeTempDb();
  const app = createApp(testConfig(tempDb.dbPath, { dataSource: "empty" }));
  try {
    const { opportunityId, refId } = seedNullEvidenceDeal(app, "u1");
    const offer = prepareDraft(app, opportunityId);
    const v = offer.versions[0];
    assert.equal(v.underwritingArvSnapshot, null);
    assert.equal(v.underwritingRehabSnapshot, null);
    assert.equal(v.underwritingMaoSnapshot, null);
    assert.equal(v.underwritingConfidence, null);
    assert.notEqual(v.underwritingSourceId, "unknown");
    assert.equal(v.underwritingSourceId, "hunter-u1"); // source_project_id fallback
    // The opportunities read model resolves identically.
    return app.services.opportunities.getById(opportunityId).then((detail) => {
      const dv = detail.offers[0].versions[0];
      assert.equal(dv.underwritingArvSnapshot, null);
      assert.equal(dv.underwritingMaoSnapshot, null);
      assert.equal(dv.underwritingSourceId, "hunter-u1");
      assert.ok(refId);
    });
  } finally {
    tempDb.cleanup();
  }
});

test("U4: committee metrics and rationale never fabricate figures from missing evidence", () => {
  const tempDb = makeTempDb();
  const app = createApp(testConfig(tempDb.dbPath, { dataSource: "empty" }));
  try {
    const { opportunityId } = seedNullEvidenceDeal(app, "u4");
    prepareDraft(app, opportunityId);
    const review = app.services.investmentCommittee.reviewActiveOffer({ opportunityId, actor: "founder-operator" });
    assert.equal(review.metrics.arv, null);
    assert.equal(review.metrics.rehab, null);
    assert.equal(review.metrics.mao, null);
    assert.equal(review.metrics.confidence, null);
    assert.equal(review.metrics.dscr, null);
    assert.notEqual(review.decision, "approve");
    assert.doesNotMatch(review.rationale, /0\.00/);
    assert.doesNotMatch(review.rationale, /DSCR/);
    assert.match(review.rationale, /confidence is unavailable/i);
  } finally {
    tempDb.cleanup();
  }
});

test("U3: committee review attests its stage transition and appears in the timeline with refusals", async () => {
  const tempDb = makeTempDb();
  const app = createApp(testConfig(tempDb.dbPath, { dataSource: "empty" }));
  try {
    const { opportunityId } = seedNullEvidenceDeal(app, "u3");
    const offer = prepareDraft(app, opportunityId);

    // Refusal BEFORE any review is audited.
    assert.throws(
      () => app.services.operator.decideOffer({ offerId: offer.id, action: "approve", actor: "founder-operator" }),
      /committee_approval_required/
    );
    const refusal = app.db.prepare(
      "SELECT * FROM operational_audit_events WHERE event_type = 'OFFER_APPROVAL_REFUSED'"
    ).get();
    assert.ok(refusal, "refusal is written to the audit log");
    assert.match(refusal.payload_json, new RegExp(opportunityId));

    const review = app.services.investmentCommittee.reviewActiveOffer({ opportunityId, actor: "founder-operator" });
    assert.notEqual(review.decision, "approve");

    // The review's stage transition is attested in seller_stage_events.
    const stageEvents = app.db.prepare(
      "SELECT * FROM seller_stage_events WHERE opportunity_id = ? ORDER BY created_at ASC"
    ).all(opportunityId);
    assert.ok(stageEvents.length >= 1, "committee stage transition has a stage event");
    const last = stageEvents[stageEvents.length - 1];
    const current = app.db.prepare("SELECT pipeline_stage FROM seller_opportunities WHERE id = ?").get(opportunityId);
    assert.equal(last.new_stage, current.pipeline_stage);
    assert.equal(last.changed_by, "founder-operator");

    // Refusal AFTER a non-approve review still holds.
    assert.throws(
      () => app.services.operator.decideOffer({ offerId: offer.id, action: "approve", actor: "founder-operator" }),
      /committee_approval_required/
    );

    // Timeline: committee decision + refusals visible; the creation-time
    // offer event says "drafted", never the later state.
    const timeline = await buildSellerTimeline(app, opportunityId);
    const types = timeline.events.map((e) => e.type);
    assert.ok(types.includes("committee_review"), `timeline has committee_review (${types.join(",")})`);
    assert.ok(types.includes("offer_approval_refused"), "timeline has offer_approval_refused");
    assert.ok(types.includes("stage_change"), "timeline has the committee stage_change");
    const committeeEv = timeline.events.find((e) => e.type === "committee_review");
    assert.match(committeeEv.summary, new RegExp(review.decision));
    const offerEv = timeline.events.find((e) => e.type === "offer");
    assert.match(offerEv.summary, /Offer drafted/);
  } finally {
    tempDb.cleanup();
  }
});

test("UA3/UA4 residuals: whitespace figures stay unknown; committee kill attests the rejection", () => {
  const tempDb = makeTempDb();
  const app = createApp(testConfig(tempDb.dbPath, { dataSource: "empty" }));
  try {
    const { opportunityId } = seedNullEvidenceDeal(app, "ua");
    // Whitespace-typed figures in the evidence JSON must not become 0,
    // while a real low DSCR in a second field still drives a kill.
    app.db.prepare("UPDATE opportunity_underwriting_refs SET evidence_summary_json = ? WHERE opportunity_id = ?")
      .run(JSON.stringify({ hold: { strategy: "DSCR", dscr: " ", noi: " ", monthlyDebtService: " " } }), opportunityId);
    const offer = prepareDraft(app, opportunityId);
    const review = app.services.investmentCommittee.reviewActiveOffer({ opportunityId, actor: "founder-operator" });
    assert.equal(review.metrics.dscr, null);
    assert.equal(review.metrics.noi, null);
    assert.ok(offer.id);
    // UA4: a committee kill (driven here by price > MAO on a valued ref)
    // attests the offer rejection under its own event type.
    const db = app.db;
    db.prepare("UPDATE opportunity_underwriting_refs SET mao = 50000, confidence = 0.9 WHERE opportunity_id = ?").run(opportunityId);
    const offer2 = app.services.operator.prepareOffer({ opportunityId, proposedPrice: 90000, strategyType: "cash_purchase", earnestMoney: 1000, inspectionDays: 7, closingDays: 30, internalNotes: "ua4 kill-path draft", actor: "founder-operator" });
    assert.ok(offer2.id);
    const review2 = app.services.investmentCommittee.reviewActiveOffer({ opportunityId, actor: "founder-operator" });
    assert.equal(review2.decision, "kill");
    const rej = db.prepare("SELECT * FROM operational_audit_events WHERE event_type = 'OFFER_REJECTED'").get();
    assert.ok(rej, "committee kill writes OFFER_REJECTED");
    assert.match(rej.payload_json, /investment_committee/);
  } finally {
    tempDb.cleanup();
  }
});

test("real zeros and real DSCR values survive intact (no over-correction)", () => {
  const tempDb = makeTempDb();
  const app = createApp(testConfig(tempDb.dbPath, { dataSource: "empty" }));
  try {
    const db = app.db;
    const opportunityId = "opp_hard_real";
    db.prepare(`
      INSERT INTO seller_opportunities (id, opportunity_code, ocg_one_property_id, created_by, pipeline_stage)
      VALUES (?, 'HARD-REAL', 'property-real', 'test', 'property_review')
    `).run(opportunityId);
    db.prepare(`
      INSERT INTO opportunity_underwriting_refs
        (id, opportunity_id, source_system, source_agent, source_project_id,
         source_underwriting_id, source_version_id, analysis_status,
         arv, rehab, mao, confidence, limitations, evidence_summary_json, analyzed_at)
      VALUES ('uw_hard_real', ?, 'deal-scout', 'Victor', 'hunter-real', 'pkg-real', '2.0', 'completed',
              0, 0, 0, 0.9, NULL, ?, '2026-10-25T15:21:03Z')
    `).run(opportunityId, JSON.stringify({ hold: { strategy: "DSCR", dscr: 0.94, noi: 900, monthlyDebtService: 1000 } }));
    const offer = prepareDraft(app, opportunityId);
    assert.equal(offer.versions[0].underwritingArvSnapshot, 0); // a recorded 0 stays 0
    assert.equal(offer.versions[0].underwritingSourceId, "pkg-real"); // explicit id wins
    const review = app.services.investmentCommittee.reviewActiveOffer({ opportunityId, actor: "founder-operator" });
    assert.equal(review.metrics.dscr, 0.94);
    assert.match(review.rationale, /DSCR 0\.94/);
    assert.equal(review.decision, "kill"); // real low DSCR still kills
  } finally {
    tempDb.cleanup();
  }
});
