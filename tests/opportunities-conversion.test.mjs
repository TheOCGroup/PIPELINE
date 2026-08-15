import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPair, exportPKCS8, exportSPKI, SignJWT } from "jose";
import { makeTempDb, testConfig, startApp } from "./helpers/temporaryDatabase.mjs";
import { openPipelineDatabase } from "../src/database/openDatabase.js";
import { createApp } from "../src/app/createApp.js";

async function signServiceToken(privateKeyPem, {
  keyId = "service-key-1",
  issuer = "ocg-one",
  audience = "pipeline",
  subject = "ocg-one-service",
  scope = "pipeline.opportunity.create",
  contractVersion = "1.0.0",
  alg = "RS256",
  exp
} = {}) {
  const { importPKCS8 } = await import("jose");
  const privateKey = await importPKCS8(privateKeyPem, alg);
  const now = Math.floor(Date.now() / 1000);

  const payload = {
    scope,
    contract_version: contractVersion
  };

  const jwt = new SignJWT(payload)
    .setProtectedHeader({ alg, kid: keyId, typ: "JWT" })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject(subject)
    .setJti(Math.random().toString())
    .setIssuedAt(now)
    .setNotBefore(now)
    .setExpirationTime(exp !== undefined ? exp : now + 60);

  return await jwt.sign(privateKey);
}

test("S2S Opportunity Conversion Endpoint", async (t) => {
  const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
  const privateKeyPem = await exportPKCS8(privateKey);
  const publicKeyPem = await exportSPKI(publicKey);

  const tempDb = makeTempDb();
  t.after(() => tempDb.cleanup());

  const config = testConfig(tempDb.dbPath);
  config.env = "production"; // force integration protection checks
  config.integrationEnabled = true;
  config.handoffIssuer = "ocg-one";
  config.handoffAudience = "pipeline";
  config.servicePublicKeys = { "service-key-1": publicKeyPem };

  const { app, baseUrl } = await startApp(createApp, config);
  t.after(() => app.server.close());

  await t.test("Unauthenticated S2S requests are rejected", async () => {
    const res = await fetch(`${baseUrl}/api/v1/opportunities/convert`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceLeadId: "lead-1" })
    });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.ok, false);
  });

  await t.test("Requests with wrong signature are rejected", async () => {
    const wrongKeys = await generateKeyPair("RS256", { extractable: true });
    const wrongPrivateKeyPem = await exportPKCS8(wrongKeys.privateKey);
    const badToken = await signServiceToken(wrongPrivateKeyPem);

    const res = await fetch(`${baseUrl}/api/v1/opportunities/convert`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${badToken}`
      },
      body: JSON.stringify({ sourceLeadId: "lead-1" })
    });
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.ok, false);
  });

  await t.test("Requests with wrong contract version are rejected", async () => {
    const badToken = await signServiceToken(privateKeyPem, { contractVersion: "2.0.0" });

    const res = await fetch(`${baseUrl}/api/v1/opportunities/convert`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${badToken}`
      },
      body: JSON.stringify({ sourceLeadId: "lead-1" })
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.error, "contract_version_mismatch");
  });

  await t.test("Requests with insufficient scope are rejected", async () => {
    const badToken = await signServiceToken(privateKeyPem, { scope: "pipeline.read" });

    const res = await fetch(`${baseUrl}/api/v1/opportunities/convert`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${badToken}`
      },
      body: JSON.stringify({ sourceLeadId: "lead-1" })
    });
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.error, "forbidden_insufficient_scope");
  });

  await t.test("Valid conversion request succeeds and is idempotent", async () => {
    const token = await signServiceToken(privateKeyPem);
    const conversionData = {
      idempotencyKey: "key-12345",
      correlationId: "corr-12345",
      sourceLeadId: "lead-fixture-1",
      sourceSystem: "deal_scout_handoff",
      property: {
        externalId: "prop-fixture-1",
        address: "123 Main St",
        motivationType: "Wholesale",
        askingPrice: 250000,
        expectedPrice: 230000,
        propertyCondition: "Fair"
      },
      participants: [
        { externalId: "person-fixture-1", role: "primary_owner", isPrimary: true }
      ],
      sourceMessage: {
        sourceMessageId: "msg-123",
        sourceTimestamp: "2026-08-01T12:00:00Z"
      }
    };

    // First attempt -> should succeed (201 Created)
    let res = await fetch(`${baseUrl}/api/v1/opportunities/convert`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`
      },
      body: JSON.stringify(conversionData)
    });
    if (res.status !== 201) {
      console.error("CONVERSION FAILED:", await res.text());
    }
    assert.equal(res.status, 201);
    let body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.status, "converted");
    const opportunityId = body.opportunityId;
    assert.ok(opportunityId);

    // Second attempt (exact same payload) -> should return 200 with same opportunityId
    res = await fetch(`${baseUrl}/api/v1/opportunities/convert`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`
      },
      body: JSON.stringify(conversionData)
    });
    assert.equal(res.status, 200);
    body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.status, "already_converted");
    assert.equal(body.opportunityId, opportunityId);

    // Check DB state
    const db = openPipelineDatabase(tempDb.dbPath);
    const opp = db.prepare("SELECT * FROM seller_opportunities WHERE id = ?").get(opportunityId);
    assert.ok(opp);
    assert.equal(opp.ocg_one_property_id, "prop-fixture-1");
    assert.equal(opp.seller_motivation_type, "Wholesale");

    const provenance = db.prepare("SELECT * FROM source_provenance WHERE opportunity_id = ?").get(opportunityId);
    assert.ok(provenance);
    assert.equal(provenance.resolution_status, "original_resolved");

    const classification = db.prepare("SELECT * FROM record_classifications WHERE opportunity_id = ?").get(opportunityId);
    assert.ok(classification);
    assert.equal(classification.classification_value, "wholesale_target");

    const audit = db.prepare("SELECT * FROM operational_audit_events WHERE correlation_id = ?").get("key-12345");
    assert.ok(audit);
    assert.equal(audit.event_type, "OPPORTUNITY_CONVERSION");
    db.close();
  });
});
