/**
 * Convert idempotency tenant isolation (QUINCEY U1, Phase 6).
 *
 * The S2S convert endpoint's two idempotency legs — the source-record
 * lookup and the audit-key lookup — must be tenant-scoped in integration
 * mode against a shared multi-tenant DB: a record owned by another tenant
 * is indistinguishable from a nonexistent one, so `already_converted` may
 * never disclose a foreign opportunity id.
 *
 * Fixture: ONE database, TWO app instances over it — one configured
 * tenant-a, one tenant-b — both integration-enabled and trusting the same
 * S2S caller key (the tenant is deployment config, never caller input).
 * Tenant A converts first; tenant B then attacks both idempotency legs.
 *
 * Migration 035 (founder remediation order §6; ASTRA package §3) retired
 * the old documented residual: seller_opportunity_sources is now unique
 * per (tenant_id, source_type, source_record_id), so a foreign
 * re-presentation of the same pair converts TENANT-LOCALLY — the
 * presenting tenant creates its own record (201, its own id) instead of
 * aborting on the old global UNIQUE. The security properties are
 * unchanged and stronger: neither leg may ever disclose a foreign
 * opportunity id, foreign rows stay byte-unchanged, and same-tenant
 * dedupe behavior is exactly as before. T1/T4 below assert the new
 * semantics; their no-disclosure assertions are the original ones.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPair, exportPKCS8, exportSPKI, SignJWT } from "jose";
import { randomUUID } from "node:crypto";
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
} = {}) {
  const { importPKCS8 } = await import("jose");
  const privateKey = await importPKCS8(privateKeyPem, alg);
  const now = Math.floor(Date.now() / 1000);
  const jwt = new SignJWT({ scope, contract_version: contractVersion })
    .setProtectedHeader({ alg, kid: keyId, typ: "JWT" })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject(subject)
    .setJti(Math.random().toString())
    .setIssuedAt(now)
    .setNotBefore(now)
    .setExpirationTime(now + 60); // verifier caps token TTL (existing harness uses 60s)
  return await jwt.sign(privateKey);
}

function conversionBody({ idempotencyKey, correlationId, sourceLeadId, externalId, personId }) {
  return {
    idempotencyKey,
    correlationId,
    sourceLeadId,
    sourceSystem: "deal_scout_handoff",
    property: {
      externalId,
      address: "123 Main St",
      motivationType: "Wholesale",
      askingPrice: 250000,
      expectedPrice: 230000,
      propertyCondition: "Fair",
    },
    participants: [
      { externalId: personId, role: "primary_owner", isPrimary: true },
    ],
    sourceMessage: {
      sourceMessageId: `msg-${sourceLeadId}`,
      sourceTimestamp: "2026-08-01T12:00:00Z",
    },
  };
}

/** Byte-level snapshot of every row a conversion wrote for one opportunity. */
function dumpConversion(db, opportunityId) {
  const byOpportunity = [
    "seller_opportunities", "seller_opportunity_participants",
    "seller_opportunity_sources", "seller_stage_events", "source_provenance",
    "record_classifications", "classification_history",
  ];
  const out = {};
  for (const table of byOpportunity) {
    const column = table === "seller_opportunities" ? "id" : "opportunity_id";
    out[table] = db.prepare(`SELECT * FROM ${table} WHERE ${column} = ? ORDER BY rowid`).all(opportunityId);
  }
  out.operational_audit_events = db.prepare(
    "SELECT * FROM operational_audit_events WHERE payload_json LIKE ? ORDER BY rowid"
  ).all(`%${opportunityId}%`);
  return JSON.stringify(out);
}

test("S2S convert idempotency legs never leak across the tenant boundary", async (t) => {
  const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
  const privateKeyPem = await exportPKCS8(privateKey);
  const publicKeyPem = await exportSPKI(publicKey);

  const tempDb = makeTempDb();
  t.after(() => tempDb.cleanup());

  const configFor = (tenantId) => testConfig(tempDb.dbPath, {
    env: "production", // force integration protection checks
    integrationEnabled: true,
    readOnly: false,
    tenantId,
    handoffIssuer: "ocg-one",
    handoffAudience: "pipeline",
    servicePublicKeys: { "service-key-1": publicKeyPem },
  });

  const a = await startApp(createApp, configFor("tenant-a"));
  t.after(() => a.app.close());
  const b = await startApp(createApp, configFor("tenant-b"));
  t.after(() => b.app.close());

  const db = openPipelineDatabase(tempDb.dbPath);
  t.after(() => db.close());

  const convert = async (baseUrl, payload) => {
    const token = await signServiceToken(privateKeyPem); // fresh token per call
    const res = await fetch(`${baseUrl}/api/v1/opportunities/convert`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
      body: JSON.stringify(payload),
    });
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch { /* asserted via text */ }
    return { status: res.status, text, body };
  };

  const bodyA = conversionBody({
    idempotencyKey: "key-a-1", correlationId: "corr-a-1",
    sourceLeadId: "lead-shared-1", externalId: "prop-a-1", personId: "person-a-1",
  });

  let idA;
  let tenantABefore;

  await t.test("setup: tenant A converts its lead (201, stamped tenant-a)", async () => {
    const res = await convert(a.baseUrl, bodyA);
    assert.equal(res.status, 201, res.text);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.status, "converted");
    idA = res.body.opportunityId;
    assert.ok(idA);
    const row = db.prepare("SELECT tenant_id FROM seller_opportunities WHERE id = ?").get(idA);
    assert.equal(row.tenant_id, "tenant-a");
    tenantABefore = dumpConversion(db, idA);
  });

  await t.test("T1 source leg: tenant B replaying A's exact body converts tenant-locally (201, own id, zero disclosure)", async () => {
    const res = await convert(b.baseUrl, bodyA);
    assert.ok(!res.text.includes(idA), "response must not contain tenant A's opportunity id");
    // Migration 035 semantics: both scoped legs miss for B and the
    // tenant-aware UNIQUE no longer collides with A's row, so B converts
    // the lead as its OWN record.
    assert.equal(res.status, 201, res.text);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.status, "converted");
    const idB = res.body.opportunityId;
    assert.ok(idB && idB !== idA, "B receives its own new opportunity id");
    const row = db.prepare("SELECT tenant_id FROM seller_opportunities WHERE id = ?").get(idB);
    assert.equal(row.tenant_id, "tenant-b", "B's copy is stamped with the caller's tenant");
    // The source row carries the parent opportunity's tenant (migration 035).
    const src = db.prepare("SELECT tenant_id FROM seller_opportunity_sources WHERE opportunity_id = ?").get(idB);
    assert.equal(src.tenant_id, "tenant-b");
    assert.equal(dumpConversion(db, idA), tenantABefore, "tenant A's rows are byte-unchanged");
    // B's own replay now dedupes against B's record — never A's.
    const replay = await convert(b.baseUrl, bodyA);
    assert.equal(replay.status, 200, replay.text);
    assert.equal(replay.body.status, "already_converted");
    assert.equal(replay.body.opportunityId, idB, "B dedupes against its OWN record");
    assert.equal(dumpConversion(db, idA), tenantABefore, "tenant A's rows are still byte-unchanged");
  });

  await t.test("T2 legitimate idempotency preserved: tenant A replaying its own body gets already_converted with its own id", async () => {
    const res = await convert(a.baseUrl, bodyA);
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.status, "already_converted");
    assert.equal(res.body.opportunityId, idA);
  });

  await t.test("T3 audit-key leg: tenant B reusing A's idempotencyKey for a NEW lead converts fresh under B, never A's id", async () => {
    // A converts a second lead under its own key first, so the audit leg
    // holds exactly one A-owned record for key-a-2.
    const bodyA2 = conversionBody({
      idempotencyKey: "key-a-2", correlationId: "corr-a-2",
      sourceLeadId: "lead-a-2", externalId: "prop-a-2", personId: "person-a-2",
    });
    const setupRes = await convert(a.baseUrl, bodyA2);
    assert.equal(setupRes.status, 201, setupRes.text);
    const idA2 = setupRes.body.opportunityId;
    assert.ok(idA2 && idA2 !== idA);
    const tenantA2Before = dumpConversion(db, idA2);

    const bodyB = conversionBody({
      idempotencyKey: "key-a-2", correlationId: "corr-b-1",
      sourceLeadId: "lead-b-1", externalId: "prop-b-1", personId: "person-b-1",
    });
    const res = await convert(b.baseUrl, bodyB);
    assert.ok(!res.text.includes(idA2), "response must not contain tenant A's opportunity id");
    assert.ok(!res.text.includes(idA), "response must not contain tenant A's first opportunity id either");
    assert.equal(res.status, 201, res.text);
    assert.equal(res.body.status, "converted");
    const idB = res.body.opportunityId;
    assert.ok(idB && idB !== idA2 && idB !== idA);
    const row = db.prepare("SELECT tenant_id FROM seller_opportunities WHERE id = ?").get(idB);
    assert.equal(row.tenant_id, "tenant-b", "the fresh conversion is stamped with the caller's tenant");
    // A's own conversion audit row is untouched and still the only one
    // recording A's second conversion under key-a-2.
    const aAudit = db.prepare(
      "SELECT * FROM operational_audit_events WHERE correlation_id = 'key-a-2' AND payload_json LIKE ?"
    ).all(`%${idA2}%`);
    assert.equal(aAudit.length, 1);
    assert.equal(JSON.parse(aAudit[0].payload_json).opportunityId, idA2);
    assert.equal(dumpConversion(db, idA2), tenantA2Before, "tenant A's second conversion is byte-unchanged");
    assert.equal(dumpConversion(db, idA), tenantABefore, "tenant A's first conversion is byte-unchanged");
  });

  await t.test("T4 clean foreign conversion: B's own lead converts under B and A's re-presentation converts tenant-locally, disclosing nothing", async () => {
    const bodyB2 = conversionBody({
      idempotencyKey: "key-b-2", correlationId: "corr-b-2",
      sourceLeadId: "lead-b-2", externalId: "prop-b-2", personId: "person-b-2",
    });
    const res = await convert(b.baseUrl, bodyB2);
    assert.equal(res.status, 201, res.text);
    const idB2 = res.body.opportunityId;
    const row = db.prepare("SELECT tenant_id FROM seller_opportunities WHERE id = ?").get(idB2);
    assert.equal(row.tenant_id, "tenant-b");
    const tenantB2Before = dumpConversion(db, idB2);

    // Tenant A re-presenting B's conversion (either leg) must not learn
    // idB2; under migration 035 it converts its own tenant-local copy.
    const replay = await convert(a.baseUrl, bodyB2);
    assert.ok(!replay.text.includes(idB2), "tenant A must not receive tenant B's opportunity id");
    assert.equal(replay.status, 201, replay.text);
    assert.equal(replay.body.status, "converted");
    assert.ok(replay.body.opportunityId && replay.body.opportunityId !== idB2, "A receives its own new id");
    const rowA = db.prepare("SELECT tenant_id FROM seller_opportunities WHERE id = ?").get(replay.body.opportunityId);
    assert.equal(rowA.tenant_id, "tenant-a", "A's copy is stamped with A's tenant");
    assert.equal(dumpConversion(db, idB2), tenantB2Before, "tenant B's rows are byte-unchanged");
  });

  await t.test("T5 dangling audit payloads (foreign id, nonexistent id) are treated as not found", async () => {
    const seedAudit = (key, opportunityId) => db.prepare(`
      INSERT INTO operational_audit_events (id, event_type, actor_id, payload_json, correlation_id)
      VALUES (?, 'OPPORTUNITY_CONVERSION', 's2s', ?, ?)
    `).run(randomUUID(), JSON.stringify({ opportunityId, sourceLeadId: "lead-seeded", sourceSystem: "deal_scout_handoff" }), key);
    seedAudit("key-seed-foreign", idA); // names tenant A's opportunity
    seedAudit("key-seed-ghost", "opp-does-not-exist"); // names nothing at all

    // Snapshot AFTER seeding: the seeded dangling rows themselves reference
    // idA, so the byte-unchanged baseline must include them; the claim is
    // that the conversions below mutate none of A's (or the seeded) rows.
    const afterSeed = dumpConversion(db, idA);

    for (const [key, lead] of [["key-seed-foreign", "lead-b-3"], ["key-seed-ghost", "lead-b-4"]]) {
      const res = await convert(b.baseUrl, conversionBody({
        idempotencyKey: key, correlationId: `corr-${lead}`,
        sourceLeadId: lead, externalId: `prop-${lead}`, personId: `person-${lead}`,
      }));
      assert.equal(res.status, 201, `${key}: ${res.text}`);
      assert.equal(res.body.status, "converted");
      assert.ok(res.body.opportunityId && res.body.opportunityId !== idA,
        "the dangling key must not resurrect the foreign id");
      const row = db.prepare("SELECT tenant_id FROM seller_opportunities WHERE id = ?").get(res.body.opportunityId);
      assert.equal(row.tenant_id, "tenant-b");
    }
    assert.equal(dumpConversion(db, idA), afterSeed, "tenant A's rows are byte-unchanged");
  });
});
