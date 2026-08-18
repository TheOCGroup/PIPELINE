import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app/createApp.js";
import { makeTempDb, testConfig, startApp } from "./helpers/temporaryDatabase.mjs";

test("API: GET /api/v1/opportunities listing, filters, and pagination", async (t) => {
  const db = makeTempDb();
  const { app, baseUrl } = await startApp(createApp, testConfig(db.dbPath, { dataSource: "fixtures" }));
  t.after(() => { app.close(); db.cleanup(); });

  // 1. Fetch all (fixtures mode has 6 items)
  const res = await fetch(`${baseUrl}/api/v1/opportunities`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.data.length, 6);
  assert.ok(body.meta.correlationId);
  assert.equal(body.meta.dataSource, "fixtures");

  // 2. Filter by stage
  const resFiltered = await fetch(`${baseUrl}/api/v1/opportunities?stage=negotiating`);
  const bodyFiltered = await resFiltered.json();
  assert.equal(bodyFiltered.data.length, 1);
  assert.equal(bodyFiltered.data[0].id, "FX-OPP-0001");

  // 3. Invalid filter -> 400 Bad Request
  const resInvalid = await fetch(`${baseUrl}/api/v1/opportunities?stage=invalid_stage`);
  assert.equal(resInvalid.status, 400);
  const bodyInvalid = await resInvalid.json();
  assert.equal(bodyInvalid.error, "invalid_request");

  // 4. Pagination limits
  const resPaged = await fetch(`${baseUrl}/api/v1/opportunities?pageSize=2`);
  const bodyPaged = await resPaged.json();
  assert.equal(bodyPaged.data.length, 2);
  assert.equal(bodyPaged.meta.pagination.totalPages, 3);
});

test("API: GET /api/v1/opportunities/:id detail and 404", async (t) => {
  const db = makeTempDb();
  const { app, baseUrl } = await startApp(createApp, testConfig(db.dbPath, { dataSource: "fixtures" }));
  t.after(() => { app.close(); db.cleanup(); });

  // 1. Valid opportunity
  const res = await fetch(`${baseUrl}/api/v1/opportunities/FX-OPP-0001`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.data.id, "FX-OPP-0001");
  assert.equal(body.data.sellerDisplayName, "Ada Fixtureton");

  // 2. Invalid opportunity -> 404
  const resMissing = await fetch(`${baseUrl}/api/v1/opportunities/non-existent-id`);
  assert.equal(resMissing.status, 404);
  const bodyMissing = await resMissing.json();
  assert.equal(bodyMissing.error, "not_found");
});

test("API: GET /api/v1/provenance", async (t) => {
  const db = makeTempDb();
  const { app, baseUrl } = await startApp(createApp, testConfig(db.dbPath, { dataSource: "fixtures" }));
  t.after(() => { app.close(); db.cleanup(); });

  const res = await fetch(`${baseUrl}/api/v1/provenance`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.length, 6);
  assert.ok(body.data.some(r => r.opportunityId === "FX-OPP-0002" && r.provenanceState === "recovered"));
});

test("API: GET /api/v1/classifications", async (t) => {
  const db = makeTempDb();
  const { app, baseUrl } = await startApp(createApp, testConfig(db.dbPath, { dataSource: "fixtures" }));
  t.after(() => { app.close(); db.cleanup(); });

  const res = await fetch(`${baseUrl}/api/v1/classifications`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.current.length, 6);
  assert.equal(body.data.history.length, 4);
});

test("API: GET /api/v1/data-quality", async (t) => {
  const db = makeTempDb();
  const { app, baseUrl } = await startApp(createApp, testConfig(db.dbPath, { dataSource: "fixtures" }));
  t.after(() => { app.close(); db.cleanup(); });

  const res = await fetch(`${baseUrl}/api/v1/data-quality`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.totalOpportunities, 6);
  assert.equal(body.data.originalProvenance, 3);
});

test("API: GET /api/v1/system/status constraints", async (t) => {
  const db = makeTempDb();
  const { app, baseUrl } = await startApp(createApp, testConfig(db.dbPath, { dataSource: "fixtures" }));
  t.after(() => { app.close(); db.cleanup(); });

  const res = await fetch(`${baseUrl}/api/v1/system/status`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.name, "OCG PIPELINE");
  assert.equal(body.data.dataSource, "fixtures");

  // Verify security invariants: no filesystem paths or secrets returned
  const jsonStr = JSON.stringify(body.data);
  assert.ok(!jsonStr.includes("Users/"), "Should not contain filesystem paths");
  assert.ok(!jsonStr.includes("secret"), "Should not contain secret values");
});

test("API: GET /api/v1/opportunities S2S Bearer token authentication", async (t) => {
  const { generateKeyPair, exportPKCS8, exportSPKI, SignJWT, importPKCS8 } = await import("jose");
  const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
  const privateKeyPem = await exportPKCS8(privateKey);
  const publicKeyPem = await exportSPKI(publicKey);

  const db = makeTempDb();
  const config = testConfig(db.dbPath, {
    dataSource: "fixtures",
    integrationEnabled: true,
    handoffIssuer: "ocg-one",
    handoffAudience: "pipeline",
    servicePublicKeys: { "service-key-2": publicKeyPem }
  });
  config.env = "production"; // force production integration checks

  const { app, baseUrl } = await startApp(createApp, config);
  t.after(() => { app.close(); db.cleanup(); });

  // 1. Unauthenticated request -> 401
  const resUnauth = await fetch(`${baseUrl}/api/v1/opportunities`);
  assert.equal(resUnauth.status, 401);

  // 2. Request with wrong signature -> 403
  const wrongKeys = await generateKeyPair("RS256", { extractable: true });
  const wrongPrivateKeyPem = await exportPKCS8(wrongKeys.privateKey);
  const badToken = await new SignJWT({ scope: "ocg-one.pipeline.read", contract_version: "1.0.0" })
    .setProtectedHeader({ alg: "RS256", kid: "service-key-2", typ: "JWT" })
    .setIssuer("ocg-one")
    .setAudience("pipeline")
    .setSubject("ocg-one-service")
    .setJti(Math.random().toString())
    .setIssuedAt(Math.floor(Date.now() / 1000))
    .setExpirationTime(Math.floor(Date.now() / 1000) + 60)
    .sign(await importPKCS8(wrongPrivateKeyPem, "RS256"));

  const resBadSig = await fetch(`${baseUrl}/api/v1/opportunities`, {
    headers: { "Authorization": `Bearer ${badToken}` }
  });
  assert.equal(resBadSig.status, 403);

  // 3. Request with insufficient scope -> 403
  const readKey = await importPKCS8(privateKeyPem, "RS256");
  const badScopeToken = await new SignJWT({ scope: "wrong.scope", contract_version: "1.0.0" })
    .setProtectedHeader({ alg: "RS256", kid: "service-key-2", typ: "JWT" })
    .setIssuer("ocg-one")
    .setAudience("pipeline")
    .setSubject("ocg-one-service")
    .setJti(Math.random().toString())
    .setIssuedAt(Math.floor(Date.now() / 1000))
    .setExpirationTime(Math.floor(Date.now() / 1000) + 60)
    .sign(readKey);

  const resBadScope = await fetch(`${baseUrl}/api/v1/opportunities`, {
    headers: { "Authorization": `Bearer ${badScopeToken}` }
  });
  assert.equal(resBadScope.status, 403);

  // 4. Request with valid token and scope -> 200
  const validToken = await new SignJWT({ scope: "ocg-one.pipeline.read", contract_version: "1.0.0" })
    .setProtectedHeader({ alg: "RS256", kid: "service-key-2", typ: "JWT" })
    .setIssuer("ocg-one")
    .setAudience("pipeline")
    .setSubject("ocg-one-service")
    .setJti(Math.random().toString())
    .setIssuedAt(Math.floor(Date.now() / 1000))
    .setExpirationTime(Math.floor(Date.now() / 1000) + 60)
    .sign(readKey);

  const resValid = await fetch(`${baseUrl}/api/v1/opportunities`, {
    headers: { "Authorization": `Bearer ${validToken}` }
  });
  assert.equal(resValid.status, 200);
  const bodyValid = await resValid.json();
  assert.equal(bodyValid.ok, true);
  assert.equal(bodyValid.data.length, 6);
});

test("API: GET /api/v1/opportunities contains underwriting references", async (t) => {
  const db = makeTempDb();
  const { app, baseUrl } = await startApp(createApp, testConfig(db.dbPath, { dataSource: "empty" }));
  t.after(() => { app.close(); db.cleanup(); });

  // Add underwriting references
  const sqlite = await import("node:sqlite");
  const conn = new sqlite.DatabaseSync(db.dbPath);

  // Insert two opportunities in seller_opportunities
  conn.prepare(`
    INSERT INTO seller_opportunities (id, opportunity_code, pipeline_stage, opportunity_status, created_by, ocg_one_property_id)
    VALUES ('FX-OPP-0001', 'DEMO-OPP-0001', 'negotiating', 'active', 'system-seed', 'prop-FX-OPP-0001')
  `).run();
  conn.prepare(`
    INSERT INTO seller_opportunities (id, opportunity_code, pipeline_stage, opportunity_status, created_by, ocg_one_property_id)
    VALUES ('FX-OPP-0002', 'DEMO-OPP-0002', 'contacted', 'active', 'system-seed', 'prop-FX-OPP-0002')
  `).run();

  conn.prepare(`
    INSERT INTO opportunity_underwriting_refs (
      id, opportunity_id, source_system, source_agent, source_project_id, 
      source_underwriting_id, source_version_id, analysis_status, arv, rehab, mao, 
      confidence, limitations, evidence_summary_json, analyzed_at
    ) VALUES ('ref1', 'FX-OPP-0001', 'deal-scout', 'Victor', 'proj1', 'und1', '1', 'completed', 250000, 50000, 137500, 0.85, 'Solid comps', '{}', '2026-08-18T00:00:00Z')
  `).run();

  conn.prepare(`
    INSERT INTO opportunity_underwriting_refs (
      id, opportunity_id, source_system, source_agent, analysis_status, 
      arv, rehab, mao, confidence, limitations, evidence_summary_json, analyzed_at
    ) VALUES ('ref2', 'FX-OPP-0002', 'deal-scout', 'Victor', 'insufficient_evidence', null, null, null, 0.0, 'INSUFFICIENT COMPARABLE EVIDENCE', '{}', '2026-08-18T00:00:00Z')
  `).run();
  conn.close();

  // Test FX-OPP-0001 (Completed)
  const res1 = await fetch(`${baseUrl}/api/v1/opportunities/FX-OPP-0001`);
  const body1 = await res1.json();
  assert.equal(body1.ok, true);
  assert.ok(body1.data.underwriting);
  assert.equal(body1.data.underwriting.status, "completed");
  assert.equal(body1.data.underwriting.arv, 250000);
  assert.equal(body1.data.underwriting.rehab, 50000);
  assert.equal(body1.data.underwriting.mao, 137500);
  assert.equal(body1.data.underwriting.confidence, 0.85);

  // Test FX-OPP-0002 (Insufficient evidence)
  const res2 = await fetch(`${baseUrl}/api/v1/opportunities/FX-OPP-0002`);
  const body2 = await res2.json();
  assert.equal(body2.ok, true);
  assert.ok(body2.data.underwriting);
  assert.equal(body2.data.underwriting.status, "insufficient_evidence");
  assert.equal(body2.data.underwriting.arv, null);
  assert.equal(body2.data.underwriting.rehab, null);
  assert.equal(body2.data.underwriting.mao, null);
  assert.equal(body2.data.underwriting.limitations, "INSUFFICIENT COMPARABLE EVIDENCE");
});


