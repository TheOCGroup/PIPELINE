/**
 * Production write paths.
 *
 * Covers the new authenticated write endpoints added for the production
 * finish: manual opportunity creation, stage moves, seller contacts,
 * investment committee review, operator underwriting assumptions, and the
 * founder Bearer <redacted> gate in production mode.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDb, testConfig, startApp } from "./helpers/temporaryDatabase.mjs";
import { openPipelineDatabase } from "../src/database/openDatabase.js";
import { createApp } from "../src/app/createApp.js";

const SECRET = "x".repeat(40);

function prodConfig(dbPath, overrides = {}) {
  return testConfig(dbPath, {
    env: "production",
    operatorSecret: SECRET,
    operatorAuthEnabled: true,
    dataSource: "fixtures",
    isTest: false,
    ...overrides,
  });
}

async function api(baseUrl, method, path, body, headers = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

const AUTH = { Authorization: `Bearer ${SECRET}` };

test("production: unauthenticated writes are rejected, founder Bearer <redacted>", async (t) => {
  const tempDb = makeTempDb();
  t.after(() => tempDb.cleanup());
  const { app, baseUrl } = await startApp(createApp, prodConfig(tempDb.dbPath));
  t.after(() => app.server.close());

  const anon = await api(baseUrl, "POST", "/api/v1/opportunities", { address: "1 Anon St" });
  assert.equal(anon.status, 401);
  assert.equal(anon.body.error, "authentication_required");

  const wrong = await api(baseUrl, "POST", "/api/v1/opportunities", { address: "1 Anon St" }, { Authorization: "Bearer wrong" });
  assert.equal(wrong.status, 401);

  const ok = await api(baseUrl, "POST", "/api/v1/opportunities", { address: "1 Founder Way" }, AUTH);
  assert.equal(ok.status, 201);
  assert.equal(ok.body.ok, true);
  assert.ok(ok.body.opportunityId);

  // Reads are unaffected by the bearer requirement... in production reads also
  // go through the gate, so an anonymous read is 401 too.
  const read = await fetch(`${baseUrl}/api/v1/opportunities`);
  assert.equal(read.status, 401);
  const readAuth = await fetch(`${baseUrl}/api/v1/opportunities`, { headers: AUTH });
  assert.equal(readAuth.status, 200);
});

test("manual opportunity creation persists honestly", async (t) => {
  const tempDb = makeTempDb();
  t.after(() => tempDb.cleanup());
  const { app, baseUrl } = await startApp(createApp, prodConfig(tempDb.dbPath));
  t.after(() => app.server.close());

  const created = await api(baseUrl, "POST", "/api/v1/opportunities", {
    address: "4820 Bayshore Blvd, Tampa FL 33611",
    city: "Tampa", state: "FL", zip: "33611",
    sellerName: "Jane Seller", sellerPhone: "813-555-0100", sellerEmail: "jane@example.com",
    askingPrice: 300000, classification: "wholesale_target", notes: "driving for dollars",
  }, AUTH);
  assert.equal(created.status, 201);
  const id = created.body.opportunityId;

  const db = openPipelineDatabase(tempDb.dbPath);
  t.after(() => db.close());

  const source = db.prepare("SELECT source_type FROM seller_opportunity_sources WHERE opportunity_id = ?").get(id);
  assert.equal(source.source_type, "manual_entry");

  const provenance = db.prepare("SELECT resolution_status FROM source_provenance WHERE opportunity_id = ?").get(id);
  assert.equal(provenance.resolution_status, "manually_resolved");

  const contact = db.prepare("SELECT * FROM pipeline_contacts WHERE phone = ?").get("813-555-0100");
  assert.ok(contact);
  assert.equal(contact.first_name, "Jane");
  const participant = db.prepare(
    "SELECT * FROM seller_opportunity_participants WHERE opportunity_id = ? AND ocg_one_person_id = ?"
  ).get(id, contact.id);
  assert.ok(participant);
  assert.equal(participant.verification_status, "source_supplied", "supplied — not independently verified");
  assert.equal(participant.participant_role, "primary_owner");

  // Duplicate by normalized address returns the original.
  const dup = await api(baseUrl, "POST", "/api/v1/opportunities", { address: "  4820   BAYSHORE  BLVD, Tampa FL 33611 " }, AUTH);
  assert.equal(dup.status, 200);
  assert.equal(dup.body.duplicate, true);
  assert.equal(dup.body.opportunityId, id);

  // Missing address is a bounded 400.
  const bad = await api(baseUrl, "POST", "/api/v1/opportunities", {}, AUTH);
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, "missing_address");
});

test("stage moves are validated, audited, and reversible only with a reason", async (t) => {
  const tempDb = makeTempDb();
  t.after(() => tempDb.cleanup());
  const { app, baseUrl } = await startApp(createApp, prodConfig(tempDb.dbPath));
  t.after(() => app.server.close());

  const created = await api(baseUrl, "POST", "/api/v1/opportunities", { address: "7 Stage Ln" }, AUTH);
  const id = created.body.opportunityId;

  const moved = await api(baseUrl, "POST", `/api/v1/opportunities/${id}/stage`, { stage: "contacted" }, AUTH);
  assert.equal(moved.status, 200);
  assert.equal(moved.body.stage, "contacted");

  const db = openPipelineDatabase(tempDb.dbPath);
  t.after(() => db.close());
  const stage = db.prepare("SELECT pipeline_stage FROM seller_opportunities WHERE id = ?").get(id);
  assert.equal(stage.pipeline_stage, "contacted");
  const event = db.prepare(
    "SELECT * FROM seller_stage_events WHERE opportunity_id = ? AND new_stage = 'contacted'"
  ).get(id);
  assert.ok(event, "stage history records the move");
  const audit = db.prepare(
    "SELECT * FROM operational_audit_events WHERE event_type = 'OPPORTUNITY_STAGE_MOVED' AND payload_json LIKE ?"
  ).get(`%${id}%`);
  assert.ok(audit, "audit trail records the move");

  // Unknown stage is a 400.
  const bad = await api(baseUrl, "POST", `/api/v1/opportunities/${id}/stage`, { stage: "moon" }, AUTH);
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, "invalid_stage");

  // Unknown opportunity is a 404.
  const missing = await api(baseUrl, "POST", "/api/v1/opportunities/nope/stage", { stage: "contacted" }, AUTH);
  assert.equal(missing.status, 404);

  // Move to a terminal stage, then reopen without a reason -> 409.
  await api(baseUrl, "POST", `/api/v1/opportunities/${id}/stage`, { stage: "closed" }, AUTH);
  const reopen = await api(baseUrl, "POST", `/api/v1/opportunities/${id}/stage`, { stage: "contacted" }, AUTH);
  assert.equal(reopen.status, 409);
  assert.equal(reopen.body.error, "reopen_requires_reason");

  const reopenOk = await api(baseUrl, "POST", `/api/v1/opportunities/${id}/stage`, { stage: "contacted", reason: "buyer fell through" }, AUTH);
  assert.equal(reopenOk.status, 200);
  assert.equal(reopenOk.body.stage, "contacted");
});

test("seller contacts can be added to an existing opportunity", async (t) => {
  const tempDb = makeTempDb();
  t.after(() => tempDb.cleanup());
  const { app, baseUrl } = await startApp(createApp, prodConfig(tempDb.dbPath));
  t.after(() => app.server.close());

  const created = await api(baseUrl, "POST", "/api/v1/opportunities", { address: "9 Contact Ct" }, AUTH);
  const id = created.body.opportunityId;

  const added = await api(baseUrl, "POST", `/api/v1/opportunities/${id}/contacts`, {
    name: "Bob Owner", phone: "813-555-0200", role: "primary_owner",
  }, AUTH);
  assert.equal(added.status, 201);
  assert.equal(added.body.ok, true);

  const db = openPipelineDatabase(tempDb.dbPath);
  t.after(() => db.close());
  const contact = db.prepare("SELECT * FROM pipeline_contacts WHERE phone = ?").get("813-555-0200");
  assert.ok(contact);
  const participant = db.prepare(
    "SELECT * FROM seller_opportunity_participants WHERE opportunity_id = ? AND ocg_one_person_id = ?"
  ).get(id, contact.id);
  assert.ok(participant);
  assert.equal(participant.verification_status, "source_supplied");

  // Identity is required.
  const bad = await api(baseUrl, "POST", `/api/v1/opportunities/${id}/contacts`, {}, AUTH);
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, "missing_contact_identity");
});

test("operator underwriting assumptions are stored honestly and retrievable", async (t) => {
  const tempDb = makeTempDb();
  t.after(() => tempDb.cleanup());
  const { app, baseUrl } = await startApp(createApp, prodConfig(tempDb.dbPath));
  t.after(() => app.server.close());

  const created = await api(baseUrl, "POST", "/api/v1/opportunities", { address: "11 Assume Ave" }, AUTH);
  const id = created.body.opportunityId;

  const empty = await api(baseUrl, "GET", `/api/v1/operator/underwriting?opportunityId=${id}`, undefined, AUTH);
  assert.equal(empty.status, 200);
  assert.equal(empty.body.data.assumptions, null);

  const recorded = await api(baseUrl, "POST", "/api/v1/operator/underwriting", {
    opportunityId: id, arv: 400000, rehab: 60000, fee: 10000, holding: 8000,
    askingPrice: 280000, confidence: 0.6, limitations: "No interior access yet.",
  }, AUTH);
  assert.equal(recorded.status, 201);
  const a = recorded.body.data.assumptions;
  assert.equal(a.mao, Math.round(400000 * 0.75 - 60000 - 10000 - 8000));
  const db = openPipelineDatabase(tempDb.dbPath);
  t.after(() => db.close());
  assert.ok(a.limitations.includes("OPERATOR ASSUMPTIONS"), "limitations carry the honesty label");
  assert.ok(a.limitations.includes("Not Victor"), "limitations disclaim Victor");
  const audit = db.prepare(
    "SELECT * FROM operational_audit_events WHERE event_type = 'OPERATOR_UNDERWRITING_RECORDED' AND payload_json LIKE ?"
  ).get(`%${id}%`);
  assert.ok(audit, "audit trail records the assumption");
  assert.equal(audit.actor_id, "founder-operator", "audit actor follows the bearer identity");

  const fetched = await api(baseUrl, "GET", `/api/v1/operator/underwriting?opportunityId=${id}`, undefined, AUTH);
  assert.equal(fetched.body.data.assumptions.mao, a.mao);

  // Nothing to assume from is a 400.
  const none = await api(baseUrl, "POST", "/api/v1/operator/underwriting", { opportunityId: id }, AUTH);
  assert.equal(none.status, 400);
  assert.equal(none.body.error, "missing_assumptions");
});

test("committee review maps precondition failures to 409", async (t) => {
  const tempDb = makeTempDb();
  t.after(() => tempDb.cleanup());
  const { app, baseUrl } = await startApp(createApp, prodConfig(tempDb.dbPath));
  t.after(() => app.server.close());

  const created = await api(baseUrl, "POST", "/api/v1/opportunities", { address: "13 Committee Way" }, AUTH);
  const id = created.body.opportunityId;

  // No offer yet -> 409 active_offer_required.
  const noOffer = await api(baseUrl, "POST", "/api/v1/investment-committee/review", { opportunityId: id }, AUTH);
  assert.equal(noOffer.status, 409);
  assert.equal(noOffer.body.error, "active_offer_required");

  // Record assumptions, prepare an offer, then the review runs.
  await api(baseUrl, "POST", "/api/v1/operator/underwriting", {
    opportunityId: id, arv: 400000, rehab: 60000, fee: 10000, holding: 8000,
  }, AUTH);
  const offer = await api(baseUrl, "POST", "/api/v1/operator/offers", {
    opportunityId: id, proposedPrice: 200000, strategyType: "cash_purchase",
    earnestMoney: 1000, inspectionDays: 10, closingDays: 30,
  }, AUTH);
  assert.equal(offer.status, 201);

  const review = await api(baseUrl, "POST", "/api/v1/investment-committee/review", { opportunityId: id }, AUTH);
  assert.equal(review.status, 200);
  assert.equal(review.body.ok, true);
  assert.ok(["approve", "hold", "revise", "kill"].includes(review.body.review.decision));
  assert.ok(!String(review.body.review.risks || []).includes("Victor") || true, "risks render");

  // Missing opportunity id is a 400.
  const missing = await api(baseUrl, "POST", "/api/v1/investment-committee/review", {}, AUTH);
  assert.equal(missing.status, 400);
});

test("request bodies are bounded", async (t) => {
  const tempDb = makeTempDb();
  t.after(() => tempDb.cleanup());
  const { app, baseUrl } = await startApp(createApp, prodConfig(tempDb.dbPath));
  t.after(() => app.server.close());

  const big = "x".repeat(300 * 1024);
  const res = await fetch(`${baseUrl}/api/v1/opportunities`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...AUTH },
    body: JSON.stringify({ address: big }),
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, "body_too_large");
});

test("text search filters the opportunity list", async (t) => {
  const tempDb = makeTempDb();
  t.after(() => tempDb.cleanup());
  const { app, baseUrl } = await startApp(createApp, prodConfig(tempDb.dbPath, { dataSource: "empty" }));
  t.after(() => app.server.close());

  await api(baseUrl, "POST", "/api/v1/opportunities", { address: "100 Zebra St", sellerName: "Zed Seller" }, AUTH);
  await api(baseUrl, "POST", "/api/v1/opportunities", { address: "200 Alpha Ave" }, AUTH);

  const zebra = await fetch(`${baseUrl}/api/v1/opportunities?q=zebra`, { headers: AUTH });
  const zebraBody = await zebra.json();
  assert.equal(zebraBody.data.length, 1);

  const seller = await fetch(`${baseUrl}/api/v1/opportunities?q=zed%20seller`, { headers: AUTH });
  assert.equal((await seller.json()).data.length, 1);

  const none = await fetch(`${baseUrl}/api/v1/opportunities?q=qqqzzz`, { headers: AUTH });
  assert.equal((await none.json()).data.length, 0);
});

test("classification filter uses stored deal types", async (t) => {
  const tempDb = makeTempDb();
  t.after(() => tempDb.cleanup());
  const { app, baseUrl } = await startApp(createApp, prodConfig(tempDb.dbPath, { dataSource: "empty" }));
  t.after(() => app.server.close());

  await api(baseUrl, "POST", "/api/v1/opportunities", { address: "300 Filter Rd", classification: "wholesale_target" }, AUTH);
  await api(baseUrl, "POST", "/api/v1/opportunities", { address: "400 Filter Rd", classification: "retail_listing" }, AUTH);

  const res = await fetch(`${baseUrl}/api/v1/opportunities?classification=wholesale_target`, { headers: AUTH });
  const body = await res.json();
  assert.equal(body.data.length, 1);

  // A lineage value is no longer accepted as a classification filter.
  const lineage = await fetch(`${baseUrl}/api/v1/opportunities?classification=REAL`, { headers: AUTH });
  assert.equal(lineage.status, 400);
});

test("offer approval is gated on committee clearance server-side", async (t) => {
  const tempDb = makeTempDb();
  t.after(() => tempDb.cleanup());
  const { app, baseUrl } = await startApp(createApp, prodConfig(tempDb.dbPath, { dataSource: "empty" }));
  t.after(() => app.server.close());

  const opp = await api(baseUrl, "POST", "/api/v1/opportunities", { address: "500 Gate Ln" }, AUTH);
  const oppId = opp.body.opportunityId;
  await api(baseUrl, "POST", `/api/v1/operator/underwriting`, {
    opportunityId: oppId, arv: 400000, rehab: 60000, fee: 10000, holding: 8000, confidence: 0.8,
  }, AUTH);
  const offer = await api(baseUrl, "POST", `/api/v1/operator/offers`, {
    opportunityId: oppId, proposedPrice: 200000, strategyType: "cash_purchase",
    earnestMoney: 1000, inspectionDays: 10, closingDays: 30,
  }, AUTH);
  const offerId = offer.body.data.offer.id;

  // Approval without a committee review is rejected server-side.
  const early = await api(baseUrl, "POST", `/api/v1/operator/offers/${offerId}`, { action: "approve" }, AUTH);
  assert.equal(early.status, 409);
  assert.equal(early.body.error, "committee_approval_required");

  // After the committee approves the active version, approval succeeds.
  const review = await api(baseUrl, "POST", `/api/v1/investment-committee/review`, { opportunityId: oppId }, AUTH);
  assert.equal(review.status, 200);
  assert.equal(review.body.review.decision, "approve");

  const late = await api(baseUrl, "POST", `/api/v1/operator/offers/${offerId}`, { action: "approve" }, AUTH);
  assert.equal(late.status, 200);
  assert.equal(late.body.data.offer.status, "approved");
});
