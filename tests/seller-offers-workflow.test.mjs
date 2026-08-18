import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app/createApp.js";
import { makeTempDb, testConfig, startApp } from "./helpers/temporaryDatabase.mjs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test("Seller Offers Workflow: draft creation, snapshot integrity, modification, approval gate, and restart persistence", async (t) => {
  const db = makeTempDb();
  const { app, baseUrl } = await startApp(createApp, testConfig(db.dbPath, { dataSource: "empty" }));
  t.after(() => { app.close(); db.cleanup(); });

  const sqlite = await import("node:sqlite");
  const conn = new sqlite.DatabaseSync(db.dbPath);

  // 1. Seed opportunities, underwriting refs, opportunity sources, and provenance records
  conn.prepare(`
    INSERT INTO seller_opportunities (id, opportunity_code, pipeline_stage, opportunity_status, created_by, ocg_one_property_id, asking_price)
    VALUES ('opp_3d9274ef0cb9', 'OPP-197067', 'new_lead', 'active', 'deal-findr', 'prop-197067', 80000)
  `).run();

  conn.prepare(`
    INSERT INTO seller_opportunity_sources (
      id, opportunity_id, source_type, source_message_id, original_address, conversion_actor
    ) VALUES ('src_3d9274ef0cb9', 'opp_3d9274ef0cb9', 'deal_scout_handoff', 'MSG-ID-ROANOKE', '1807 Roanoke St', 'deal-findr')
  `).run();

  conn.prepare(`
    INSERT INTO source_provenance (
      id, opportunity_id, original_source_json, resolution_status
    ) VALUES ('prov_3d9274ef0cb9', 'opp_3d9274ef0cb9', '{"source":"deal-findr","apn":"APN-ROANOKE-999"}', 'original_resolved')
  `).run();

  conn.prepare(`
    INSERT INTO opportunity_underwriting_refs (
      id, opportunity_id, source_system, source_agent, source_project_id, 
      source_underwriting_id, source_version_id, analysis_status, arv, rehab, mao, 
      confidence, limitations, evidence_summary_json, analyzed_at
    ) VALUES ('ref_3d9274ef0cb9', 'opp_3d9274ef0cb9', 'deal-scout', 'Victor', 'opp_3d9274ef0cb9', 'analysis-123', '1', 'completed', 159566.69, 26000.0, 93675.02, 0.90, 'Solid comps', '{"comps":[{"address":"1824 S Roanoke St","salePrice":162000}]}', '2026-08-18T00:00:00Z')
  `).run();

  conn.prepare(`
    INSERT INTO seller_opportunities (id, opportunity_code, pipeline_stage, opportunity_status, created_by, ocg_one_property_id, asking_price)
    VALUES ('opp_e7902d13ddba', 'OPP-197068', 'new_lead', 'active', 'deal-findr', 'prop-197068', 99900)
  `).run();

  conn.prepare(`
    INSERT INTO seller_opportunity_sources (
      id, opportunity_id, source_type, source_message_id, original_address, conversion_actor
    ) VALUES ('src_e7902d13ddba', 'opp_e7902d13ddba', 'deal_scout_handoff', 'MSG-ID-HIRAM', '1844 S Hiram Ave', 'deal-findr')
  `).run();

  conn.prepare(`
    INSERT INTO source_provenance (
      id, opportunity_id, original_source_json, resolution_status
    ) VALUES ('prov_e7902d13ddba', 'opp_e7902d13ddba', '{"source":"deal-findr","apn":"APN-HIRAM-111"}', 'original_resolved')
  `).run();

  conn.prepare(`
    INSERT INTO opportunity_underwriting_refs (
      id, opportunity_id, source_system, source_agent, source_project_id, 
      source_underwriting_id, source_version_id, analysis_status, arv, rehab, mao, 
      confidence, limitations, evidence_summary_json, analyzed_at
    ) VALUES ('ref_e7902d13ddba', 'opp_e7902d13ddba', 'deal-scout', 'Victor', 'opp_e7902d13ddba', 'analysis-456', '1', 'completed', 184093.80, 28000.0, 110070.35, 0.85, 'Deferred maint', '{"comps":[]}', '2026-08-18T00:00:00Z')
  `).run();

  conn.prepare(`
    INSERT INTO seller_opportunities (id, opportunity_code, pipeline_stage, opportunity_status, created_by, ocg_one_property_id, asking_price)
    VALUES ('opp_bad', 'OPP-197069', 'new_lead', 'active', 'deal-findr', 'prop-197069', 120000)
  `).run();

  conn.prepare(`
    INSERT INTO opportunity_underwriting_refs (
      id, opportunity_id, source_system, source_agent, source_project_id, 
      source_underwriting_id, source_version_id, analysis_status, arv, rehab, mao, 
      confidence, limitations, evidence_summary_json, analyzed_at
    ) VALUES ('ref_bad', 'opp_bad', 'deal-scout', 'Victor', 'opp_bad', 'analysis-789', '1', 'insufficient_evidence', 0, 0, 0, 0.0, 'No comps', '{}', '2026-08-18T00:00:00Z')
  `).run();

  // Opportunity with missing limitations
  conn.prepare(`
    INSERT INTO seller_opportunities (id, opportunity_code, pipeline_stage, opportunity_status, created_by, ocg_one_property_id, asking_price)
    VALUES ('opp_bad_lim', 'OPP-197070', 'new_lead', 'active', 'deal-findr', 'prop-197070', 85000)
  `).run();

  conn.prepare(`
    INSERT INTO opportunity_underwriting_refs (
      id, opportunity_id, source_system, source_agent, source_project_id, 
      source_underwriting_id, source_version_id, analysis_status, arv, rehab, mao, 
      confidence, limitations, evidence_summary_json, analyzed_at
    ) VALUES ('ref_bad_lim', 'opp_bad_lim', 'deal-scout', 'Victor', 'opp_bad_lim', 'analysis-999', '1', 'completed', 150000, 20000, 90000, 0.90, NULL, '{}', '2026-08-18T00:00:00Z')
  `).run();

  conn.close();

  // 2. Propose draft offer preparation failing due to missing terms (cannot invent terms)
  const resBadPrep = await fetch(`${baseUrl}/api/v1/operator/offers`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ opportunityId: "opp_3d9274ef0cb9" })
  });
  assert.equal(resBadPrep.status, 400);
  const bodyBadPrep = await resBadPrep.json();
  assert.equal(bodyBadPrep.ok, false);
  assert.equal(bodyBadPrep.error, "missing_proposedPrice");

  // 3. Propose draft offer preparation succeeding with explicitly passed terms (different from Victor MAO)
  const resPrep = await fetch(`${baseUrl}/api/v1/operator/offers`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      opportunityId: "opp_3d9274ef0cb9",
      proposedPrice: 90000, // Explicitly selected, different from Victor MAO ($93,675)
      strategyType: "cash_purchase",
      earnestMoney: 1000,
      inspectionDays: 10,
      closingDays: 30
    })
  });
  assert.equal(resPrep.status, 201);
  const bodyPrep = await resPrep.json();
  assert.equal(bodyPrep.ok, true);
  const offer = bodyPrep.data.offer;
  assert.equal(offer.status, "draft");
  assert.equal(offer.opportunityId, "opp_3d9274ef0cb9");
  assert.equal(offer.versions.length, 1);
  
  // Verify snapshot integrity and explicit purchase price choice
  const ver1 = offer.versions[0];
  assert.equal(ver1.versionStatus, "draft");
  assert.equal(ver1.purchasePrice, 90000); // Explicitly selected price, NOT auto Victor MAO
  assert.equal(ver1.underwritingArvSnapshot, 159566.69);
  assert.equal(ver1.underwritingRehabSnapshot, 26000.0);
  assert.equal(ver1.underwritingMaoSnapshot, 93675.02);
  assert.equal(ver1.underwritingConfidence, 0.90);
  assert.equal(ver1.underwritingLimitations, "Solid comps");

  // 4. Modify offer price (POST /api/v1/operator/offers/:id)
  const resMod = await fetch(`${baseUrl}/api/v1/operator/offers/${offer.id}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "modify", proposedPrice: 85000 })
  });
  assert.equal(resMod.status, 200);
  const bodyMod = await resMod.json();
  const offerMod = bodyMod.data.offer;
  assert.equal(offerMod.versions.length, 2);
  assert.equal(offerMod.currentVersion, 2);
  assert.equal(offerMod.status, "draft");

  // Active version should be v2 with new price
  const ver2 = offerMod.versions.find(v => v.versionNumber === 2);
  assert.equal(ver2.purchasePrice, 85000);
  assert.equal(ver2.versionStatus, "draft");
  // Preceding version should be v1 superseded
  const ver1Sup = offerMod.versions.find(v => v.versionNumber === 1);
  assert.equal(ver1Sup.supersededBy, ver2.id);

  // 5. Decline produces no approval
  const resDec = await fetch(`${baseUrl}/api/v1/operator/offers/${offer.id}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "decline" })
  });
  assert.equal(resDec.status, 200);
  const bodyDec = await resDec.json();
  assert.equal(bodyDec.data.offer.status, "rejected");
  assert.equal(bodyDec.data.offer.versions.find(v => v.versionNumber === 2).versionStatus, "rejected");

  // 6. Explicit approve transitions to approved
  const resApprove = await fetch(`${baseUrl}/api/v1/operator/offers/${offer.id}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "approve" })
  });
  assert.equal(resApprove.status, 200);
  const bodyApprove = await resApprove.json();
  assert.equal(bodyApprove.data.offer.status, "approved");
  assert.equal(bodyApprove.data.offer.versions.find(v => v.versionNumber === 2).versionStatus, "approved");

  // 7. Test Piper pre-decision brief for at least two different real opportunity IDs (Roanoke and Hiram)
  // Roanoke (verifying APN comes from provenance metadata and source_message_id is not treated as APN)
  const resPiperRoanoke = await fetch(`${baseUrl}/api/v1/piper/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      question: "Which Victor deal is ready for an offer decision?",
      activeOpportunityId: "opp_3d9274ef0cb9"
    })
  });
  assert.equal(resPiperRoanoke.status, 200);
  const bodyPiperRoanoke = await resPiperRoanoke.json();
  assert.match(bodyPiperRoanoke.data.answer, /opp_3d9274ef0cb9/i);
  assert.match(bodyPiperRoanoke.data.answer, /1 comp/i); // 1 comp seeded in test
  assert.match(bodyPiperRoanoke.data.answer, /APN-ROANOKE-999/i); // APN parsed from original_source_json
  assert.doesNotMatch(bodyPiperRoanoke.data.answer, /MSG-ID-ROANOKE/i); // source_message_id is not mapped as APN

  // Hiram (verifying APN comes from provenance metadata and source_message_id is not treated as APN)
  const resPiperHiram = await fetch(`${baseUrl}/api/v1/piper/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      question: "Which Victor deal is ready for an offer decision?",
      activeOpportunityId: "opp_e7902d13ddba"
    })
  });
  assert.equal(resPiperHiram.status, 200);
  const bodyPiperHiram = await resPiperHiram.json();
  assert.match(bodyPiperHiram.data.answer, /opp_e7902d13ddba/i);
  assert.match(bodyPiperHiram.data.answer, /0 comps/i); // comps array is empty []
  assert.match(bodyPiperHiram.data.answer, /APN-HIRAM-111/i); // APN parsed from original_source_json
  assert.doesNotMatch(bodyPiperHiram.data.answer, /MSG-ID-HIRAM/i); // source_message_id is not mapped as APN

  // 8. Test Zero/missing comp count never renders 3 (opp_bad returns Hold / Insufficient evidence)
  const resPiperBad = await fetch(`${baseUrl}/api/v1/piper/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      question: "Which Victor deal is ready for an offer decision?",
      activeOpportunityId: "opp_bad"
    })
  });
  assert.equal(resPiperBad.status, 200);
  const bodyPiperBad = await resPiperBad.json();
  assert.match(bodyPiperBad.data.answer, /Hold\. Insufficient comparable sales/i);

  // 9. Test missing limitations do not fabricate renovation assumptions
  const resPiperNoLim = await fetch(`${baseUrl}/api/v1/piper/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      question: "Which Victor deal is ready for an offer decision?",
      activeOpportunityId: "opp_bad_lim"
    })
  });
  assert.equal(resPiperNoLim.status, 200);
  const bodyPiperNoLim = await resPiperNoLim.json();
  assert.match(bodyPiperNoLim.data.answer, /Limitations not recorded/i);
  assert.doesNotMatch(bodyPiperNoLim.data.answer, /standard minor renovations needed/i);

  // 10. Test that no unsupported "Operator Default" label appears in public/app.js in the offer inputs
  const appJsPath = path.resolve(__dirname, "../public/app.js");
  const appJsContent = fs.readFileSync(appJsPath, "utf8");
  
  // Assert that "Operator Default" is not used in the input labels or form fields
  assert.equal(appJsContent.includes("Strategy Type (Operator Default)"), false);
  assert.equal(appJsContent.includes("Earnest Money (Operator Default)"), false);
  assert.equal(appJsContent.includes("Inspection Days (Operator Default)"), false);
  assert.equal(appJsContent.includes("Closing Days (Operator Default)"), false);

  // 11. Restart persistence
  app.close(); // shutdown
  
  // Re-open server
  const restart = await startApp(createApp, testConfig(db.dbPath, { dataSource: "empty" }));
  t.after(() => restart.app.close());

  // Fetch opportunity and verify offer is intact
  const resQuery = await fetch(`${restart.baseUrl}/api/v1/opportunities/opp_3d9274ef0cb9`);
  const bodyQuery = await resQuery.json();
  assert.equal(bodyQuery.ok, true);
  const restartedOpp = bodyQuery.data;
  assert.ok(restartedOpp.offers && restartedOpp.offers.length === 1);
  assert.equal(restartedOpp.offers[0].status, "approved");
  assert.equal(restartedOpp.offers[0].versions.length, 2);
  assert.equal(restartedOpp.offers[0].activeVersionId, restartedOpp.offers[0].versions.find(v => v.versionNumber === 2).id);
});
