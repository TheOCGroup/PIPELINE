/**
 * Tenant isolation battery (Audit A §5.5).
 *
 * Production-shaped config (operator bearer, dataSource 'empty', temp DB),
 * server configured tenant 'tenant-a', with a full 'tenant-b' opportunity
 * seeded directly in the DB. On every surface, tenant-b's opportunity must
 * behave exactly like a nonexistent one, tenant-b rows must never leak into
 * reads or aggregates, writes against tenant-b ids must fail as not-found
 * and leave tenant-b's rows byte-unchanged, and intake dedupe must not
 * match across the tenant boundary.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDb, testConfig, startApp } from "./helpers/temporaryDatabase.mjs";
import { createApp } from "../src/app/createApp.js";

const SECRET = "x".repeat(40);
const INTAKE_SECRET = "intake-secret-0123456789abcdef";
const AUTH = { Authorization: `Bearer ${SECRET}` };
const INTAKE_AUTH = { Authorization: `Bearer ${INTAKE_SECRET}` };

const A_ID = "opp-a-0001";
const B_ID = "opp-b-0001";
const GHOST_ID = "opp-ghost-0000";
const B_ADDRESS = "100 tenant b way, wichita, ks 67217";
const B_APN = "215-407-B";
const B_SOURCE_RECORD = "B-REC-1";
const TS = "2026-10-31T00:00:00.000Z";

function tenantConfig(dbPath, tenantId) {
  return testConfig(dbPath, {
    env: "production",
    operatorSecret: SECRET,
    operatorAuthEnabled: true,
    dataSource: "empty",
    tenantId,
    piperIntakeEnabled: true,
    piperIntakeSecret: INTAKE_SECRET,
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

/** Seed one full opportunity: source, classification (+history), provenance,
 *  underwriting ref, active offer + version, note, checklist item,
 *  interaction, next-action, stage event. */
function seedOpportunity(db, { id, tenantId, code, propertyId, address, apn, sourceRecordId }) {
  db.prepare(`
    INSERT INTO seller_opportunities (id, tenant_id, opportunity_code, ocg_one_property_id,
      pipeline_stage, asking_price, created_by, updated_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'new_lead', 250000, 'seed', 'seed', ?, ?)
  `).run(id, tenantId, code, propertyId, TS, TS);
  db.prepare(`
    INSERT INTO seller_opportunity_sources (id, opportunity_id, source_type, source_record_id,
      original_address, source_timestamp, conversion_actor, conversion_timestamp, provenance_metadata_json)
    VALUES (?, ?, 'deal_finder_intake', ?, ?, ?, 'deal-findr', ?, ?)
  `).run(`${id}-src`, id, sourceRecordId, address, TS, TS, JSON.stringify({ apn }));
  db.prepare(`
    INSERT INTO source_provenance (id, opportunity_id, original_source_json, resolution_status)
    VALUES (?, ?, '{}', 'original_resolved')
  `).run(`${id}-prov`, id);
  db.prepare(`
    INSERT INTO record_classifications (opportunity_id, classification_value, classification_rules_version, determined_by, reason)
    VALUES (?, 'wholesale_target', '1.0.0', 'seed', 'seeded classification')
  `).run(id);
  db.prepare(`
    INSERT INTO classification_history (id, opportunity_id, prior_classification, new_classification,
      classification_rules_version, determined_by, reason)
    VALUES (?, ?, NULL, 'wholesale_target', '1.0.0', 'seed', 'seeded classification')
  `).run(`${id}-clsh`, id);
  db.prepare(`
    INSERT INTO opportunity_underwriting_refs (id, opportunity_id, source_system, source_agent,
      analysis_status, arv, rehab, mao, confidence, analyzed_at)
    VALUES (?, ?, 'deal-scout', 'Victor', 'completed', 300000, 50000, 160000, 0.7, ?)
  `).run(`${id}-uw`, id, TS);
  db.prepare(`
    INSERT INTO seller_offers (id, opportunity_id, current_version, status, active_version_id, created_by)
    VALUES (?, ?, 1, 'pending_approval', NULL, 'seed')
  `).run(`${id}-offer`, id);
  db.prepare(`
    INSERT INTO seller_offer_versions (id, offer_id, version_number, version_status, strategy_type,
      purchase_price, earnest_money, inspection_days, closing_days, contingencies_json,
      underwriting_source_type, underwriting_source_id, underwriting_version_id,
      underwriting_arv_snapshot, underwriting_rehab_snapshot, underwriting_mao_snapshot,
      underwriting_confidence, created_by)
    VALUES (?, ?, 1, 'pending_approval', 'cash_purchase', 150000, 1000, 10, 30, '{}',
      'deal_scout_project', 'uw-src', '2.0', 300000, 50000, 160000, 0.7, 'seed')
  `).run(`${id}-ver`, `${id}-offer`);
  // Migration 006 invariant: the active version must already exist and
  // belong to this offer when active_version_id is set.
  db.prepare("UPDATE seller_offers SET active_version_id = ? WHERE id = ?").run(`${id}-ver`, `${id}-offer`);
  db.prepare(`
    INSERT INTO operator_notes (id, opportunity_id, body, created_by) VALUES (?, ?, 'seed note', 'seed')
  `).run(`${id}-note`, id);
  db.prepare(`
    INSERT INTO operator_checklist_items (id, opportunity_id, item_key, label, is_checked, updated_by)
    VALUES (?, ?, 'title_search', 'Title search', 0, 'seed')
  `).run(`${id}-chk`, id);
  db.prepare(`
    INSERT INTO seller_interactions (id, opportunity_id, channel, direction, occurred_at, summary, created_by)
    VALUES (?, ?, 'phone', 'outbound', ?, 'seed call', 'seed')
  `).run(`${id}-int`, id, TS);
  db.prepare(`
    INSERT INTO operator_next_actions (id, opportunity_id, title, status, created_by)
    VALUES (?, ?, 'Call the seller', 'open', 'seed')
  `).run(`${id}-next`, id);
  db.prepare(`
    INSERT INTO seller_stage_events (id, opportunity_id, prior_stage, new_stage, changed_by, reason)
    VALUES (?, ?, NULL, 'new_lead', 'seed', 'seeded')
  `).run(`${id}-stage`, id);
}

const CHILD_TABLES = [
  "seller_opportunity_sources", "source_provenance", "record_classifications",
  "classification_history", "opportunity_underwriting_refs", "seller_stage_events",
  "operator_notes", "operator_checklist_items", "operator_next_actions", "seller_interactions",
];

/** Byte-level snapshot of every row belonging to an opportunity. */
function dumpOpportunity(db, id) {
  const out = {
    seller_opportunities: db.prepare("SELECT * FROM seller_opportunities WHERE id = ? ORDER BY rowid").all(id),
  };
  for (const table of CHILD_TABLES) {
    out[table] = db.prepare(`SELECT * FROM ${table} WHERE opportunity_id = ? ORDER BY rowid`).all(id);
  }
  out.seller_offers = db.prepare("SELECT * FROM seller_offers WHERE opportunity_id = ? ORDER BY rowid").all(id);
  out.seller_offer_versions = db.prepare(
    "SELECT v.* FROM seller_offer_versions v JOIN seller_offers o ON o.id = v.offer_id WHERE o.opportunity_id = ? ORDER BY v.rowid"
  ).all(id);
  out.investment_committee_reviews = db.prepare(
    "SELECT * FROM investment_committee_reviews WHERE opportunity_id = ? ORDER BY rowid"
  ).all(id);
  return JSON.stringify(out);
}

async function bootTenantA(t) {
  const tempDb = makeTempDb();
  t.after(() => tempDb.cleanup());
  const { app, baseUrl } = await startApp(createApp, tenantConfig(tempDb.dbPath, "tenant-a"));
  t.after(() => app.close());
  seedOpportunity(app.db, {
    id: A_ID, tenantId: "tenant-a", code: "OPP-A001", propertyId: "prop-a",
    address: "200 tenant a way, wichita, ks 67217", apn: "111-111-A", sourceRecordId: "A-REC-1",
  });
  seedOpportunity(app.db, {
    id: B_ID, tenantId: "tenant-b", code: "OPP-B001", propertyId: "prop-b",
    address: B_ADDRESS, apn: B_APN, sourceRecordId: B_SOURCE_RECORD,
  });
  return { app, baseUrl };
}

test("lists exclude the foreign tenant (opportunities, provenance, classifications, data-quality, next-actions)", async (t) => {
  const { baseUrl } = await bootTenantA(t);

  const list = await api(baseUrl, "GET", "/api/v1/opportunities");
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.data.map((o) => o.id), [A_ID]);

  const provenance = await api(baseUrl, "GET", "/api/v1/provenance");
  assert.equal(provenance.status, 200);
  assert.ok(JSON.stringify(provenance.body).includes(A_ID), "provenance includes tenant-a");
  assert.ok(!JSON.stringify(provenance.body).includes(B_ID), "provenance excludes tenant-b");

  const classifications = await api(baseUrl, "GET", "/api/v1/classifications");
  assert.equal(classifications.status, 200);
  assert.ok(JSON.stringify(classifications.body).includes(A_ID), "classifications include tenant-a");
  assert.ok(!JSON.stringify(classifications.body).includes(B_ID), "classifications exclude tenant-b");

  const quality = await api(baseUrl, "GET", "/api/v1/data-quality");
  assert.equal(quality.status, 200);
  assert.ok(!JSON.stringify(quality.body).includes(B_ID), "data-quality excludes tenant-b");

  const nextActions = await api(baseUrl, "GET", "/api/v1/operator/next-actions");
  assert.equal(nextActions.status, 200);
  assert.deepEqual(nextActions.body.data.nextActions.map((a) => a.opportunityId), [A_ID]);
});

test("opportunity detail: foreign id is indistinguishable from nonexistent", async (t) => {
  const { baseUrl } = await bootTenantA(t);

  const own = await api(baseUrl, "GET", `/api/v1/opportunities/${A_ID}`);
  assert.equal(own.status, 200);
  assert.equal(own.body.data.id, A_ID);

  const foreign = await api(baseUrl, "GET", `/api/v1/opportunities/${B_ID}`);
  const ghost = await api(baseUrl, "GET", `/api/v1/opportunities/${GHOST_ID}`);
  assert.equal(foreign.status, ghost.status);
  assert.equal(foreign.status, 404);
  assert.equal(foreign.body.error, ghost.body.error);
  assert.equal(foreign.body.ok, false);
});

test("operator reads by foreign id match the nonexistent-id response on every surface", async (t) => {
  const { baseUrl } = await bootTenantA(t);

  const surfaces = [
    (id) => `/api/v1/operator/notes?opportunityId=${id}`,
    (id) => `/api/v1/operator/checklist?opportunityId=${id}`,
    (id) => `/api/v1/operator/interactions?opportunityId=${id}`,
    (id) => `/api/v1/operator/offers?opportunityId=${id}`,
    (id) => `/api/v1/operator/underwriting?opportunityId=${id}`,
    (id) => `/api/v1/operator/next-actions?opportunityId=${id}`,
    (id) => `/api/v1/operator/transactions?opportunityId=${id}`,
    (id) => `/api/v1/operator/timeline?opportunityId=${id}`,
    (id) => `/api/v1/investment-committee?opportunityId=${id}`,
  ];
  for (const path of surfaces) {
    const foreign = await api(baseUrl, "GET", path(B_ID));
    const ghost = await api(baseUrl, "GET", path(GHOST_ID));
    assert.equal(foreign.status, ghost.status, `${path(B_ID)} status matches ghost`);
    // Read-API responses carry a per-request correlationId in meta; the
    // tenant claim is about status + payload, so compare with meta removed.
    const strip = (body) => { const { meta, ...rest } = body; return rest; };
    assert.deepEqual(strip(foreign.body), strip(ghost.body), `${path(B_ID)} body matches ghost`);
    assert.ok(!JSON.stringify(foreign.body).includes("seed note"), "no tenant-b content leaks");
  }

  // Sanity: tenant-a reads return tenant-a's rows.
  const notes = await api(baseUrl, "GET", `/api/v1/operator/notes?opportunityId=${A_ID}`);
  assert.equal(notes.body.data.notes.length, 1);
  const committee = await api(baseUrl, "GET", `/api/v1/investment-committee?opportunityId=${A_ID}`);
  assert.equal(committee.status, 200);
});

test("writes by foreign id fail as not-found and leave foreign rows byte-unchanged", async (t) => {
  const { app, baseUrl } = await bootTenantA(t);
  const before = dumpOpportunity(app.db, B_ID);

  const attempts = [
    (id) => api(baseUrl, "POST", `/api/v1/opportunities/${id}/stage`, { stage: "contacted" }),
    (id) => api(baseUrl, "POST", `/api/v1/opportunities/${id}/contacts`, { name: "Mallory", phone: "316-555-9999" }),
    (id) => api(baseUrl, "POST", "/api/v1/operator/notes", { opportunityId: id, body: "intrusion attempt" }),
    (id) => api(baseUrl, "POST", "/api/v1/operator/offers", {
      opportunityId: id, proposedPrice: 100000, strategyType: "cash_purchase",
      earnestMoney: 500, inspectionDays: 7, closingDays: 21,
    }),
    (id) => api(baseUrl, "POST", "/api/v1/investment-committee/review", { opportunityId: id }),
  ];
  for (const attempt of attempts) {
    const foreign = await attempt(B_ID);
    const ghost = await attempt(GHOST_ID);
    assert.equal(foreign.status, ghost.status, "write status matches ghost");
    assert.equal(foreign.body.error, ghost.body.error, "write error matches ghost");
    assert.ok(foreign.status >= 400, "write did not succeed");
  }

  assert.equal(dumpOpportunity(app.db, B_ID), before, "tenant-b rows are byte-unchanged");
});

test("intake dedupe is tenant-isolated: foreign keys create new tenant-a opportunities", async (t) => {
  const { app, baseUrl } = await bootTenantA(t);
  const before = dumpOpportunity(app.db, B_ID);
  const intake = (payload) =>
    api(baseUrl, "POST", "/api/integrations/deal-findr/intake", payload, INTAKE_AUTH);

  // APN leg: B's APN, fresh address, no source record id.
  const byApn = await intake({ address: "900 Fresh St, Wichita, KS 67202", apn: B_APN });
  assert.equal(byApn.status, 201);
  assert.equal(byApn.body.duplicate, false);
  assert.notEqual(byApn.body.opportunityId, B_ID);

  // Address leg: B's exact address, nothing else.
  const byAddress = await intake({ address: "100 Tenant B Way, Wichita, KS 67217" });
  assert.equal(byAddress.status, 201);
  assert.equal(byAddress.body.duplicate, false);
  assert.notEqual(byAddress.body.opportunityId, B_ID);

  // Source-record leg: B's sourceRecordId re-presented via the Victor
  // package form (source_type deal_scout_handoff). The tenant-scoped dedupe
  // must miss tenant-b's row and create a tenant-a opportunity.
  const byRecord = await intake({
    property: { id: B_SOURCE_RECORD, address: "555 Victor Way, Wichita, KS 67203" },
    underwriting: { arv: 310000, renovationBudget: 40000, mao: 170000, confidenceScore: 0.8, analysisStatus: "completed" },
    packageId: "pkg-isolation-1",
    timestamp: TS,
  });
  assert.equal(byRecord.status, 201);
  assert.equal(byRecord.body.duplicate, false);
  assert.notEqual(byRecord.body.opportunityId, B_ID);

  // The new opportunities belong to the configured tenant.
  for (const created of [byApn, byAddress, byRecord]) {
    const row = app.db.prepare("SELECT tenant_id FROM seller_opportunities WHERE id = ?").get(created.body.opportunityId);
    assert.equal(row.tenant_id, "tenant-a");
  }

  // In-tenant dedupe still works: re-presenting the APN now matches the
  // tenant-a record created above, not tenant-b's.
  const again = await intake({ address: "901 Other St, Wichita, KS 67202", apn: B_APN });
  assert.equal(again.status, 200);
  assert.equal(again.body.duplicate, true);
  assert.equal(again.body.opportunityId, byApn.body.opportunityId);

  assert.equal(dumpOpportunity(app.db, B_ID), before, "tenant-b rows are byte-unchanged");
});

test("PIPER snapshot aggregates only the configured tenant", async (t) => {
  const { app } = await bootTenantA(t);

  const snapshot = app.services.piperContext.snapshot();
  assert.equal(snapshot.totals.opportunities, 1);
  assert.deepEqual(snapshot.opportunities.map((o) => o.id), [A_ID]);
  const serialized = JSON.stringify(snapshot);
  assert.ok(!serialized.includes(B_ID), "snapshot excludes tenant-b id");
  assert.ok(!serialized.includes("tenant b way"), "snapshot excludes tenant-b address");

  const { brief } = app.services.piper.brief();
  assert.ok(!JSON.stringify(brief).includes(B_ID), "brief excludes tenant-b");
});

/** Seed a closed-purchased opportunity with a full renovation-exit chain:
 *  handoff, approve_sell review, and a disposition plan with one event. */
function seedExitChain(db, { id, tenantId }) {
  db.prepare(`
    INSERT INTO seller_opportunities (id, tenant_id, opportunity_code, ocg_one_property_id,
      pipeline_stage, opportunity_status, created_by, closed_at)
    VALUES (?, ?, ?, ?, 'closed', 'closed_purchased', 'seed', ?)
  `).run(id, tenantId, `OPP-${id}`, `prop-${id}`, TS);
  db.prepare(`
    INSERT INTO renovation_exit_handoffs (id, opportunity_id, source_project_id, payload_json,
      original_decision, recommended_decision, confidence, received_by)
    VALUES (?, ?, ?, ?, 'sell', 'sell', 'medium', 'seed')
  `).run(`${id}-exit`, id, `reno-${id}`, JSON.stringify(exitPayload(id)));
  db.prepare(`
    INSERT INTO renovation_exit_reviews (id, handoff_id, decision, rationale, metrics_json, reviewed_by)
    VALUES (?, ?, 'approve_sell', 'Approved after evidence review', '{}', 'committee')
  `).run(`${id}-review`, `${id}-exit`);
  db.prepare(`
    INSERT INTO disposition_plans (id, opportunity_id, renovation_exit_handoff_id,
      renovation_exit_review_id, disposition_type, requirements_json, created_by)
    VALUES (?, ?, ?, ?, 'sell', '["current_market_value"]', 'seed')
  `).run(`${id}-plan`, id, `${id}-exit`, `${id}-review`);
  db.prepare(`
    INSERT INTO disposition_plan_events (id, disposition_plan_id, event_type, detail, actor_id, occurred_at)
    VALUES (?, ?, 'ready', 'seeded plan', 'seed', ?)
  `).run(`${id}-plan-event`, `${id}-plan`, TS);
}

/** A contract-valid renovation-exit handoff payload for one opportunity. */
function exitPayload(opportunityId) {
  return {
    contractVersion: "1.0",
    sourceSystem: "mission-control",
    targetSystem: "ocg-os",
    handoffType: "renovation_exit_ready",
    sourceOpportunityId: opportunityId,
    decisionStatus: "investment_committee_required",
    renovation: { projectId: `reno-${opportunityId}-new`, completionEvidenceRef: "album://final" },
    exitEvaluation: {
      originalDecision: "sell", recommendedDecision: "sell", confidence: "medium",
      requiresInvestmentCommittee: true, metrics: {},
    },
  };
}

/** Byte-level snapshot of one opportunity's renovation-exit chain rows. */
function dumpExitChain(db, opportunityId) {
  const handoffs = db.prepare(
    "SELECT * FROM renovation_exit_handoffs WHERE opportunity_id = ? ORDER BY rowid"
  ).all(opportunityId);
  const plans = db.prepare(
    "SELECT * FROM disposition_plans WHERE opportunity_id = ? ORDER BY rowid"
  ).all(opportunityId);
  return JSON.stringify({
    opportunity: db.prepare("SELECT * FROM seller_opportunities WHERE id = ?").get(opportunityId),
    handoffs,
    reviews: handoffs.flatMap((h) =>
      db.prepare("SELECT * FROM renovation_exit_reviews WHERE handoff_id = ? ORDER BY rowid").all(h.id)),
    plans,
    planEvents: plans.flatMap((p) =>
      db.prepare("SELECT * FROM disposition_plan_events WHERE disposition_plan_id = ? ORDER BY rowid").all(p.id)),
    planEvidence: plans.flatMap((p) =>
      db.prepare("SELECT * FROM disposition_requirement_evidence WHERE disposition_plan_id = ? ORDER BY rowid").all(p.id)),
  });
}

test("renovation-exit and disposition surfaces treat foreign ids exactly like nonexistent ones", async (t) => {
  const { app, baseUrl } = await bootTenantA(t);
  seedExitChain(app.db, { id: "opp-a-exit", tenantId: "tenant-a" });
  seedExitChain(app.db, { id: "opp-b-exit", tenantId: "tenant-b" });
  const exits = app.services.renovationExits;
  const dispositions = app.services.dispositions;
  const before = dumpExitChain(app.db, "opp-b-exit");

  // Renovation-exit reads: foreign handoff/opportunity == ghost.
  assert.deepEqual(exits.list("opp-b-exit"), []);
  assert.deepEqual(exits.list("opp-b-exit"), exits.list(GHOST_ID));
  assert.equal(exits.get("opp-b-exit-exit"), null);
  assert.equal(exits.get("opp-b-exit-exit"), exits.get("ghost-handoff"));
  assert.deepEqual(exits.reviews("opp-b-exit-exit"), []);
  assert.deepEqual(exits.reviews("opp-b-exit-exit"), exits.reviews("ghost-handoff"));

  // Renovation-exit writes fail with the surface's not-found errors.
  assert.throws(
    () => exits.review({ handoffId: "opp-b-exit-exit", decision: "approve_sell", rationale: "probe" }),
    /renovation_exit_handoff_not_found/);
  assert.throws(
    () => exits.review({ handoffId: "ghost-handoff", decision: "approve_sell", rationale: "probe" }),
    /renovation_exit_handoff_not_found/);
  assert.throws(() => exits.receive({ payload: exitPayload("opp-b-exit") }), /opportunity_not_found/);
  assert.throws(() => exits.receive({ payload: exitPayload(GHOST_ID) }), /opportunity_not_found/);

  // Disposition reads: foreign plan/opportunity == ghost.
  assert.deepEqual(dispositions.list("opp-b-exit"), []);
  assert.deepEqual(dispositions.list("opp-b-exit"), dispositions.list(GHOST_ID));
  assert.equal(dispositions.get("opp-b-exit-plan"), null);
  assert.equal(dispositions.get("opp-b-exit-plan"), dispositions.get("ghost-plan"));
  assert.deepEqual(dispositions.events("opp-b-exit-plan"), []);
  assert.deepEqual(dispositions.events("opp-b-exit-plan"), dispositions.events("ghost-plan"));
  assert.deepEqual(dispositions.requirementEvidence("opp-b-exit-plan"), []);

  // Disposition writes fail with the surface's not-found errors.
  assert.throws(
    () => dispositions.createPlan({ handoffId: "opp-b-exit-exit", reviewId: "opp-b-exit-review" }),
    /renovation_exit_handoff_not_found/);
  assert.throws(
    () => dispositions.createPlan({ handoffId: "ghost-handoff", reviewId: "ghost-review" }),
    /renovation_exit_handoff_not_found/);
  assert.throws(
    () => dispositions.verifyRequirement({
      planId: "opp-b-exit-plan", requirementKey: "current_market_value", evidenceRef: "evidence://probe",
    }),
    /disposition_plan_not_found/);
  assert.throws(
    () => dispositions.recordEvent({ planId: "opp-b-exit-plan", eventType: "started" }),
    /disposition_plan_not_found/);

  // The HTTP dispositions list matches the ghost response as well.
  const foreignHttp = await api(baseUrl, "GET", "/api/v1/operator/dispositions?opportunityId=opp-b-exit");
  const ghostHttp = await api(baseUrl, "GET", `/api/v1/operator/dispositions?opportunityId=${GHOST_ID}`);
  assert.equal(foreignHttp.status, ghostHttp.status);
  assert.deepEqual(foreignHttp.body.data.plans, []);

  // Controls: the tenant-a chain remains fully usable on both services.
  assert.equal(exits.list("opp-a-exit").length, 1);
  assert.equal(exits.get("opp-a-exit-exit").opportunityId, "opp-a-exit");
  assert.equal(exits.reviews("opp-a-exit-exit").length, 1);
  assert.equal(dispositions.list("opp-a-exit").length, 1);
  assert.equal(dispositions.get("opp-a-exit-plan").opportunityId, "opp-a-exit");
  assert.equal(dispositions.events("opp-a-exit-plan").length, 1);

  // The Piper snapshot enrichment calls dispositions.list per opportunity;
  // it must keep building and must not leak the foreign chain.
  const snapshot = app.services.piperContext.snapshot();
  assert.ok(!JSON.stringify(snapshot).includes("opp-b-exit"), "snapshot excludes the foreign exit chain");

  assert.equal(dumpExitChain(app.db, "opp-b-exit"), before, "tenant-b exit chain rows are byte-unchanged");
});

test("production-shaped labels: 'pipeline' rows are invisible when the tenant is 'ocg-one'", async (t) => {
  const tempDb = makeTempDb();
  t.after(() => tempDb.cleanup());
  const { app, baseUrl } = await startApp(createApp, tenantConfig(tempDb.dbPath, "ocg-one"));
  t.after(() => app.close());

  // Documents the normalization dependency: production historically stored
  // the same business's rows under two labels ('ocg-one' canonical and the
  // legacy manual-create label 'pipeline'). The code does NOT rewrite stored
  // labels; until the separate founder-authorized normalization runs, the
  // legacy-labelled rows are simply outside the configured tenant's scope.
  seedOpportunity(app.db, {
    id: "opp-canonical-1", tenantId: "ocg-one", code: "OPP-C001", propertyId: "prop-c",
    address: "300 canonical rd, wichita, ks 67217", apn: "333-333-C", sourceRecordId: "C-REC-1",
  });
  seedOpportunity(app.db, {
    id: "opp-legacy-1", tenantId: "pipeline", code: "OPP-L001", propertyId: "prop-l",
    address: "400 legacy rd, wichita, ks 67217", apn: "444-444-L", sourceRecordId: "L-REC-1",
  });

  const list = await api(baseUrl, "GET", "/api/v1/opportunities");
  assert.deepEqual(list.body.data.map((o) => o.id), ["opp-canonical-1"]);

  const detail = await api(baseUrl, "GET", "/api/v1/opportunities/opp-legacy-1");
  const ghost = await api(baseUrl, "GET", `/api/v1/opportunities/${GHOST_ID}`);
  assert.equal(detail.status, 404);
  assert.equal(detail.status, ghost.status);
  assert.equal(detail.body.error, ghost.body.error);

  const snapshot = app.services.piperContext.snapshot();
  assert.equal(snapshot.totals.opportunities, 1);
});
