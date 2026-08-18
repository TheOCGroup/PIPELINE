import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app/createApp.js";
import { makeTempDb, testConfig, startApp } from "./helpers/temporaryDatabase.mjs";

test("Seller Offers Workflow: draft creation, snapshot integrity, modification, approval gate, and restart persistence", async (t) => {
  const db = makeTempDb();
  const { app, baseUrl } = await startApp(createApp, testConfig(db.dbPath, { dataSource: "empty" }));
  t.after(() => { app.close(); db.cleanup(); });

  const sqlite = await import("node:sqlite");
  const conn = new sqlite.DatabaseSync(db.dbPath);

  // 1. Seed opportunity and underwriting ref
  conn.prepare(`
    INSERT INTO seller_opportunities (id, opportunity_code, pipeline_stage, opportunity_status, created_by, ocg_one_property_id, asking_price)
    VALUES ('opp_3d9274ef0cb9', 'OPP-197067', 'new_lead', 'active', 'deal-findr', 'prop-197067', 80000)
  `).run();

  conn.prepare(`
    INSERT INTO opportunity_underwriting_refs (
      id, opportunity_id, source_system, source_agent, source_project_id, 
      source_underwriting_id, source_version_id, analysis_status, arv, rehab, mao, 
      confidence, limitations, evidence_summary_json, analyzed_at
    ) VALUES ('ref_3d9274ef0cb9', 'opp_3d9274ef0cb9', 'deal-scout', 'Victor', 'opp_3d9274ef0cb9', 'analysis-123', '1', 'completed', 159566.69, 26000.0, 93675.02, 0.90, 'Solid comps', '{}', '2026-08-18T00:00:00Z')
  `).run();
  conn.close();

  // 2. Propose draft offer preparation (POST /api/v1/operator/offers)
  const resPrep = await fetch(`${baseUrl}/api/v1/operator/offers`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ opportunityId: "opp_3d9274ef0cb9" })
  });
  assert.equal(resPrep.status, 201);
  const bodyPrep = await resPrep.json();
  assert.equal(bodyPrep.ok, true);
  const offer = bodyPrep.data.offer;
  assert.equal(offer.status, "draft");
  assert.equal(offer.opportunityId, "opp_3d9274ef0cb9");
  assert.equal(offer.versions.length, 1);
  
  // Verify snapshot integrity
  const ver1 = offer.versions[0];
  assert.equal(ver1.versionStatus, "draft");
  assert.equal(ver1.purchasePrice, 93675); // Math.round(MAO)
  assert.equal(ver1.underwritingArvSnapshot, 159566.69);
  assert.equal(ver1.underwritingRehabSnapshot, 26000.0);
  assert.equal(ver1.underwritingMaoSnapshot, 93675.02);
  assert.equal(ver1.underwritingConfidence, 0.90);
  assert.equal(ver1.underwritingLimitations, "Solid comps");

  // 3. Modify offer price (POST /api/v1/operator/offers/:id)
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

  // 4. Decline produces no approval
  const resDec = await fetch(`${baseUrl}/api/v1/operator/offers/${offer.id}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "decline" })
  });
  assert.equal(resDec.status, 200);
  const bodyDec = await resDec.json();
  assert.equal(bodyDec.data.offer.status, "rejected");
  assert.equal(bodyDec.data.offer.versions.find(v => v.versionNumber === 2).versionStatus, "rejected");

  // 5. Explicit approve transitions to approved
  const resApprove = await fetch(`${baseUrl}/api/v1/operator/offers/${offer.id}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "approve" })
  });
  assert.equal(resApprove.status, 200);
  const bodyApprove = await resApprove.json();
  assert.equal(bodyApprove.data.offer.status, "approved");
  assert.equal(bodyApprove.data.offer.versions.find(v => v.versionNumber === 2).versionStatus, "approved");

  // 6. Restart persistence
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
