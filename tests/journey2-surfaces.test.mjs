/**
 * Journey artifacts (Issue #8 remainder — Builder JOURNEY2).
 *
 * Proves: migration 036 lands; seller briefs are durable stored artifacts
 * (byte-identical document on re-read, recorded figures with basis labels,
 * tenant-ghosted); the call-preparation REST surface returns the identical
 * plan the Piper prepare_call executor produces; journey recommendations
 * transcribe real decision state (committee hold stays a hold; the brief
 * NEXT derivation is the fallback basis; no basis = refusal, never a
 * fabrication) and surface on the timeline; follow-up history is complete
 * and chronological; and QUINCEY F6 is fixed — an archived buyer criteria
 * can no longer produce a ranking but remains readable as history.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDb, testConfig, startApp } from "./helpers/temporaryDatabase.mjs";
import { createApp } from "../src/app/createApp.js";
import { openPipelineDatabase } from "../src/database/openDatabase.js";
import { SqliteOperatorRepository } from "../src/repositories/sqlite/sqliteOperatorRepository.js";
import { prepareCallPlan } from "../src/services/piper/piperSellerData.js";

const SECRET = "x".repeat(40);
const AUTH = { Authorization: `Bearer ${SECRET}` };

function tenantConfig(dbPath, tenantId) {
  return testConfig(dbPath, {
    env: "production",
    operatorSecret: SECRET,
    operatorAuthEnabled: true,
    dataSource: "empty",
    tenantId,
    readOnly: false,
  });
}

async function api(baseUrl, method, path, body, headers = AUTH) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

function seedOpp(db, { id, tenantId, asking = 150000, stage = "property_review", createdAt = "2026-10-01T00:00:00Z" }) {
  db.prepare(`
    INSERT INTO seller_opportunities (id, tenant_id, opportunity_code, ocg_one_property_id,
      pipeline_stage, asking_price, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'seed', ?, ?)
  `).run(id, tenantId, `OPP-${id}`, `prop-${id}`, stage, asking, createdAt, createdAt);
  db.prepare(`
    INSERT INTO seller_opportunity_sources (id, opportunity_id, source_type, source_record_id,
      original_address, source_timestamp, conversion_actor, conversion_timestamp, provenance_metadata_json)
    VALUES (?, ?, 'deal_finder_intake', ?, ?, ?, 'deal-findr', ?, ?)
  `).run(`${id}-src`, id, `rec-${id}`, `${id} Test St, Wichita, KS 67202`, createdAt, createdAt,
    JSON.stringify({ apn: `APN-${id}` }));
}

function seedSeller(db, { oppId, contactId = "contact-1", phone = "316-555-0100" }) {
  db.prepare(`INSERT INTO pipeline_contacts (id, first_name, last_name, email, phone)
    VALUES (?, 'Test', 'Seller', 'seller@test.invalid', ?)`).run(contactId, phone);
  db.prepare(`INSERT INTO seller_opportunity_participants (id, opportunity_id, ocg_one_person_id, participant_role, is_primary, created_by)
    VALUES (?, ?, ?, 'primary_owner', 1, 'seed')`).run(`${oppId}-part`, oppId, contactId);
}

function seedRef(db, { oppId, id, mao = null, arv = null, analysisStatus = "insufficient_evidence", analyzedAt = "2026-10-02T00:00:00Z" }) {
  db.prepare(`
    INSERT INTO opportunity_underwriting_refs (id, opportunity_id, source_system, source_agent,
      analysis_status, arv, rehab, mao, confidence, analyzed_at)
    VALUES (?, ?, 'deal-scout', 'Victor', ?, ?, NULL, ?, NULL, ?)
  `).run(id, oppId, analysisStatus, arv, mao, analyzedAt);
}

async function fixture(t) {
  const tempDb = makeTempDb();
  t.after(() => tempDb.cleanup());
  const { app, baseUrl } = await startApp(createApp, tenantConfig(tempDb.dbPath, "tenant-a"));
  t.after(() => app.server.close());
  const db = openPipelineDatabase(tempDb.dbPath);
  t.after(() => db.close());
  return { baseUrl, db, dbPath: tempDb.dbPath };
}

test("migration 036 creates the journey artifact tables", async (t) => {
  const { db } = await fixture(t);
  for (const name of ["seller_briefs", "journey_recommendations"]) {
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
    assert.ok(row, `${name} exists after boot migrations`);
  }
});

test("F6 regression: archived buyer criteria cannot produce a ranking but stays readable", async (t) => {
  const { baseUrl, db } = await fixture(t);
  seedOpp(db, { id: "j2-c1", tenantId: "tenant-a" });

  const created = await api(baseUrl, "POST", "/api/v1/operator/buyer-criteria", { label: "F6 buyer", markets: ["Wichita"] });
  assert.equal(created.status, 201);
  const criteriaId = created.body.data.criteria.id;

  const ranked = await api(baseUrl, "GET", `/api/v1/operator/candidate-ranking?criteriaId=${criteriaId}`);
  assert.equal(ranked.status, 200, "active criteria ranks normally");

  const archived = await api(baseUrl, "POST", `/api/v1/operator/buyer-criteria/${criteriaId}`, { status: "archived" });
  assert.equal(archived.status, 200);
  assert.equal(archived.body.data.criteria.status, "archived");

  const refused = await api(baseUrl, "GET", `/api/v1/operator/candidate-ranking?criteriaId=${criteriaId}`);
  assert.equal(refused.status, 409, "archived criteria ranking is refused");
  assert.equal(refused.body.error, "criteria_archived");

  const history = await api(baseUrl, "GET", `/api/v1/operator/buyer-criteria/${criteriaId}`);
  assert.equal(history.status, 200, "archived criteria remains readable as history");
  assert.equal(history.body.data.criteria.status, "archived");
});

test("seller briefs are durable artifacts: stored document, basis labels, tenant ghosts", async (t) => {
  const { baseUrl, db } = await fixture(t);
  seedOpp(db, { id: "j2-seller", tenantId: "tenant-a" });
  seedSeller(db, { oppId: "j2-seller" });
  seedRef(db, { oppId: "j2-seller", id: "j2-seller-uw" }); // insufficient_evidence, all figures NULL
  seedOpp(db, { id: "j2-foreign", tenantId: "tenant-b" });

  const generated = await api(baseUrl, "POST", "/api/v1/operator/seller-briefs", { opportunityId: "j2-seller" });
  assert.equal(generated.status, 201, JSON.stringify(generated.body).slice(0, 200));
  const brief = generated.body.data.brief;
  assert.ok(brief.id);
  assert.equal(brief.seller.displayName, "Test Seller");
  assert.equal(brief.opportunity.askingPrice.value, 150000);
  assert.equal(brief.opportunity.askingPrice.basis, "recorded");
  assert.equal(brief.underwriting.analysisStatus, "insufficient_evidence");
  assert.equal(brief.underwriting.figures.mao.value, null, "absent MAO stays null");
  assert.equal(brief.underwriting.figures.mao.basis, "unknown", "absent figure is labeled unknown, never estimated");
  assert.equal(brief.sources[0].apn, "APN-j2-seller");
  assert.equal(brief.artifactProvenance.underwritingRefId, "j2-seller-uw");

  const reread = await api(baseUrl, "GET", `/api/v1/operator/seller-briefs/${brief.id}`);
  assert.equal(reread.status, 200);
  assert.deepEqual(reread.body.data.brief, brief, "stored brief reads back identically (artifact, not recomputation)");

  const list = await api(baseUrl, "GET", "/api/v1/operator/seller-briefs?opportunityId=j2-seller");
  assert.equal(list.status, 200);
  assert.equal(list.body.data.briefs.length, 1);
  assert.equal(list.body.data.latest.id, brief.id);

  const foreignGen = await api(baseUrl, "POST", "/api/v1/operator/seller-briefs", { opportunityId: "j2-foreign" });
  assert.equal(foreignGen.status, 404, "foreign opportunity brief generation is a ghost 404");
  const foreignList = await api(baseUrl, "GET", "/api/v1/operator/seller-briefs?opportunityId=j2-foreign");
  assert.equal(foreignList.status, 404);
  const ghostBrief = await api(baseUrl, "GET", "/api/v1/operator/seller-briefs/nonexistent-id");
  assert.equal(ghostBrief.status, 404);

  const stored = db.prepare("SELECT tenant_id FROM seller_briefs WHERE id = ?").get(brief.id);
  assert.equal(stored.tenant_id, "tenant-a", "brief tenant-stamped from configuration");
});

test("call preparation REST surface returns the identical plan as the Piper executor", async (t) => {
  const { baseUrl, db, dbPath } = await fixture(t);
  seedOpp(db, { id: "j2-call", tenantId: "tenant-a" });
  seedSeller(db, { oppId: "j2-call", contactId: "contact-call", phone: "316-555-0142" });
  seedOpp(db, { id: "j2-call-foreign", tenantId: "tenant-b" });

  const rest = await api(baseUrl, "GET", "/api/v1/operator/call-preparation?opportunityId=j2-call");
  assert.equal(rest.status, 200, JSON.stringify(rest.body).slice(0, 200));
  const plan = rest.body.data.callPreparation;
  assert.equal(plan.ok, true);
  assert.equal(plan.dials, false);
  assert.equal(plan.contact.phone, "316-555-0142");

  const directDb = openPipelineDatabase(dbPath);
  const operator = new SqliteOperatorRepository(directDb, { tenantId: "tenant-a" });
  const direct = prepareCallPlan(directDb, operator, { opportunityId: "j2-call", tenantId: "tenant-a" });
  directDb.close();
  assert.deepEqual(plan, direct, "REST surface and tool executor are one implementation");

  const foreign = await api(baseUrl, "GET", "/api/v1/operator/call-preparation?opportunityId=j2-call-foreign");
  assert.equal(foreign.status, 404, "foreign opportunity call prep is a ghost 404");
});

test("journey recommendations transcribe decision state and never upgrade it", async (t) => {
  const { baseUrl, db } = await fixture(t);
  seedOpp(db, { id: "j2-rec", tenantId: "tenant-a" });
  seedRef(db, { oppId: "j2-rec", id: "j2-rec-uw" });
  // Offer + version exist so the review's foreign keys resolve. The offer
  // is inserted with no active version (the migration-006 ownership
  // trigger requires the version row to exist first), then pointed at it.
  db.prepare(`INSERT INTO seller_offers (id, opportunity_id, current_version, status, active_version_id, created_by)
    VALUES ('j2-offer-1', 'j2-rec', 1, 'draft', NULL, 'seed')`).run();
  db.prepare(`INSERT INTO seller_offer_versions (id, offer_id, version_number, version_status, strategy_type,
      purchase_price, earnest_money, inspection_days, closing_days, contingencies_json,
      underwriting_source_type, underwriting_source_id, underwriting_version_id,
      underwriting_arv_snapshot, underwriting_rehab_snapshot, underwriting_mao_snapshot, created_by)
    VALUES ('j2-ver-1', 'j2-offer-1', 1, 'draft', 'cash_purchase', 140000, 1000, 10, 30, '[]',
      'victor_analysis', 'j2-rec-uw', '2.0', 0, 0, 0, 'seed')`).run();
  db.prepare(`UPDATE seller_offers SET active_version_id = 'j2-ver-1' WHERE id = 'j2-offer-1'`).run();
  // A persisted committee HOLD is the decision of record.
  db.prepare(`
    INSERT INTO investment_committee_reviews (id, opportunity_id, offer_id, offer_version_id,
      underwriting_ref_id, decision, rationale, risks_json, metrics_json, reviewed_by)
    VALUES ('j2-review-1', 'j2-rec', 'j2-offer-1', 'j2-ver-1', 'j2-rec-uw', 'hold',
      'Do not approve yet. No defensible MAO is available.', '[]', '{}', 'investment-committee')
  `).run();

  const recorded = await api(baseUrl, "POST", "/api/v1/operator/journey-recommendations", { opportunityId: "j2-rec" });
  assert.equal(recorded.status, 201, JSON.stringify(recorded.body).slice(0, 200));
  const rec = recorded.body.data.recommendation;
  assert.equal(rec.basisType, "committee_review");
  assert.equal(rec.basisRefId, "j2-review-1");
  assert.equal(rec.actionKind, "committee_hold", "a hold is recorded as a hold — never upgraded");
  assert.match(rec.actionLabel, /Hold/);
  assert.equal(rec.basis.decision, "hold");

  const list = await api(baseUrl, "GET", "/api/v1/operator/journey-recommendations?opportunityId=j2-rec");
  assert.equal(list.body.data.latest.id, rec.id);

  const timeline = await api(baseUrl, "GET", "/api/v1/operator/timeline?opportunityId=j2-rec");
  const events = timeline.body.data.timeline.events || [];
  assert.ok(events.some((e) => e.type === "recommendation" && /Hold/.test(e.summary || "")),
    "the recorded recommendation is readable on the journey timeline");

  // Brief NEXT fallback: ceiling fixture (recorded MAO below recorded ask), no committee review.
  // An open next action keeps the record out of the "stalled" derivation, so
  // the decision-flag NEXT item (ceiling below ask) is the one transcribed.
  seedOpp(db, { id: "j2-ceil", tenantId: "tenant-a", asking: 250000 });
  seedRef(db, { oppId: "j2-ceil", id: "j2-ceil-uw", mao: 200000, arv: 300000, analysisStatus: "completed" });
  const ceilAction = await api(baseUrl, "POST", "/api/v1/operator/next-actions", { opportunityId: "j2-ceil", title: "Working the ceiling case" });
  assert.equal(ceilAction.status, 201);
  const derived = await api(baseUrl, "POST", "/api/v1/operator/journey-recommendations", { opportunityId: "j2-ceil" });
  assert.equal(derived.status, 201, JSON.stringify(derived.body).slice(0, 240));
  assert.equal(derived.body.data.recommendation.basisType, "brief_next_derivation");
  assert.equal(derived.body.data.recommendation.actionKind, "open_opportunity");

  // No basis at all (closed record, no review, no NEXT derivation) = refusal, never fabrication.
  seedOpp(db, { id: "j2-closed", tenantId: "tenant-a", stage: "archived" });
  const refused = await api(baseUrl, "POST", "/api/v1/operator/journey-recommendations", { opportunityId: "j2-closed" });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error, "recommendation_basis_unavailable");
  const none = await api(baseUrl, "GET", "/api/v1/operator/journey-recommendations?opportunityId=j2-closed");
  assert.equal(none.body.data.recommendations.length, 0, "nothing was persisted for the refused recommendation");

  seedOpp(db, { id: "j2-rec-foreign", tenantId: "tenant-b" });
  const foreign = await api(baseUrl, "POST", "/api/v1/operator/journey-recommendations", { opportunityId: "j2-rec-foreign" });
  assert.equal(foreign.status, 404, "foreign opportunity recommendation is a ghost 404");
});

test("follow-up history is complete and chronological across the existing stores", async (t) => {
  const { baseUrl, db } = await fixture(t);
  seedOpp(db, { id: "j2-hist", tenantId: "tenant-a" });
  db.prepare(`INSERT INTO seller_stage_events (id, opportunity_id, prior_stage, new_stage, changed_by, reason, created_at)
    VALUES ('j2-ev-1', 'j2-hist', 'new_lead', 'property_review', 'seed', 'advanced', '2026-10-03T00:00:00Z')`).run();

  const na = await api(baseUrl, "POST", "/api/v1/operator/next-actions", { opportunityId: "j2-hist", title: "Follow up with seller" });
  assert.equal(na.status, 201);
  const interaction = await api(baseUrl, "POST", "/api/v1/operator/interactions", {
    opportunityId: "j2-hist", channel: "phone", direction: "outbound",
    outcome: "spoke_with_seller", summary: "Synthetic history fixture call.",
  });
  assert.equal(interaction.status, 201);

  const res = await api(baseUrl, "GET", "/api/v1/operator/follow-up-history?opportunityId=j2-hist");
  assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 200));
  const history = res.body.data.followUpHistory;
  assert.equal(history.counts.interactions, 1);
  assert.equal(history.counts.nextActions, 1);
  assert.equal(history.counts.stageEvents, 1);
  const ats = history.events.map((e) => e.at);
  assert.deepEqual(ats, [...ats].sort(), "merged stream is chronological");
  assert.ok(history.events.some((e) => e.kind === "interaction"));
  assert.ok(history.events.some((e) => e.kind === "stage_change"));

  seedOpp(db, { id: "j2-hist-foreign", tenantId: "tenant-b" });
  const foreign = await api(baseUrl, "GET", "/api/v1/operator/follow-up-history?opportunityId=j2-hist-foreign");
  assert.equal(foreign.status, 404, "foreign opportunity history is a ghost 404");
});
