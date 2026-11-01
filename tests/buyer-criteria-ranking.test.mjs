/**
 * Buyer criteria + candidate ranking (Issue #8 seller-to-deal journey).
 *
 * Proves: migration 029 lands; criteria CRUD is tenant-stamped and
 * tenant-ghosted; ranking uses recorded figures only — a candidate missing
 * a figure a criterion needs is unrankable on that criterion (never scored
 * with an invented number), a candidate failing a stated bound is excluded
 * with the bound named, and closed/foreign candidates never appear.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDb, testConfig, startApp } from "./helpers/temporaryDatabase.mjs";
import { createApp } from "../src/app/createApp.js";
import { openPipelineDatabase } from "../src/database/openDatabase.js";

const SECRET = "x".repeat(40);
const AUTH = { Authorization: `Bearer ${SECRET}` };
const TS = "2026-10-31T00:00:00Z";

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

function seedCandidate(db, { id, tenantId, address, asking, stage = "new_lead", mao = null, confidence = null, analysisStatus = "completed", createdAt }) {
  db.prepare(`
    INSERT INTO seller_opportunities (id, tenant_id, opportunity_code, ocg_one_property_id,
      pipeline_stage, asking_price, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'seed', ?, ?)
  `).run(id, tenantId, `OPP-${id}`, `prop-${id}`, stage, asking, createdAt, createdAt);
  db.prepare(`
    INSERT INTO seller_opportunity_sources (id, opportunity_id, source_type, source_record_id,
      original_address, source_timestamp, conversion_actor, conversion_timestamp, provenance_metadata_json)
    VALUES (?, ?, 'deal_finder_intake', ?, ?, ?, 'deal-findr', ?, '{}')
  `).run(`${id}-src`, id, `rec-${id}`, address, createdAt, createdAt);
  if (analysisStatus !== null) {
    db.prepare(`
      INSERT INTO opportunity_underwriting_refs (id, opportunity_id, source_system, source_agent,
        analysis_status, arv, rehab, mao, confidence, analyzed_at)
      VALUES (?, ?, 'deal-scout', 'Victor', ?, NULL, NULL, ?, ?, ?)
    `).run(`${id}-uw`, id, analysisStatus, mao, confidence, createdAt);
  }
}

async function fixture(t) {
  const tempDb = makeTempDb();
  t.after(() => tempDb.cleanup());
  const { app, baseUrl } = await startApp(createApp, tenantConfig(tempDb.dbPath, "tenant-a"));
  t.after(() => app.server.close());
  const db = openPipelineDatabase(tempDb.dbPath);
  t.after(() => db.close());
  seedCandidate(db, { id: "c1", tenantId: "tenant-a", address: "10 Alpha St, Wichita, KS 67202", asking: 100000, mao: 150000, confidence: 0.8, createdAt: "2026-10-01T00:00:00Z" });
  seedCandidate(db, { id: "c2", tenantId: "tenant-a", address: "20 Beta St, Wichita, KS 67203", asking: 120000, mao: 140000, confidence: 0.9, createdAt: "2026-10-02T00:00:00Z" });
  seedCandidate(db, { id: "c3", tenantId: "tenant-a", address: "30 Gamma St, Wichita, KS 67204", asking: 90000, mao: null, confidence: null, analysisStatus: "insufficient_evidence", createdAt: "2026-10-03T00:00:00Z" });
  seedCandidate(db, { id: "c4", tenantId: "tenant-a", address: "40 Delta St, Tulsa, OK 74101", asking: 80000, mao: 200000, confidence: 0.9, createdAt: "2026-10-04T00:00:00Z" });
  seedCandidate(db, { id: "c5", tenantId: "tenant-a", address: "50 Epsilon St, Wichita, KS 67205", asking: 300000, mao: 400000, confidence: 0.9, createdAt: "2026-10-05T00:00:00Z" });
  seedCandidate(db, { id: "c6", tenantId: "tenant-a", address: "60 Zeta St, Wichita, KS 67206", asking: null, mao: 100000, confidence: 0.9, createdAt: "2026-10-06T00:00:00Z" });
  seedCandidate(db, { id: "c7", tenantId: "tenant-a", address: "70 Eta St, Wichita, KS 67207", asking: 50000, stage: "archived", mao: 90000, confidence: 0.9, createdAt: "2026-10-07T00:00:00Z" });
  seedCandidate(db, { id: "cB", tenantId: "tenant-b", address: "80 Theta St, Wichita, KS 67208", asking: 100000, mao: 500000, confidence: 0.99, createdAt: "2026-10-08T00:00:00Z" });
  return { baseUrl, db };
}

test("migration 029 creates the buyer_criteria table", async (t) => {
  const { db } = await fixture(t);
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'buyer_criteria'").get();
  assert.ok(row, "buyer_criteria exists after boot migrations");
});

test("buyer criteria CRUD is tenant-stamped, validated, and archive-aware", async (t) => {
  const { baseUrl, db } = await fixture(t);

  const missing = await api(baseUrl, "POST", "/api/v1/operator/buyer-criteria", { markets: ["Wichita"] });
  assert.equal(missing.status, 400);
  assert.equal(missing.body.error, "missing_label");

  const badMarkets = await api(baseUrl, "POST", "/api/v1/operator/buyer-criteria", { label: "X", markets: "Wichita" });
  assert.equal(badMarkets.status, 400);
  assert.equal(badMarkets.body.error, "invalid_markets");

  const created = await api(baseUrl, "POST", "/api/v1/operator/buyer-criteria", {
    label: "Wichita cash buyer", markets: ["Wichita"], maxPrice: 200000,
  });
  assert.equal(created.status, 201);
  const criteria = created.body.data.criteria;
  assert.equal(criteria.label, "Wichita cash buyer");
  assert.deepEqual(criteria.markets, ["Wichita"]);
  assert.equal(criteria.maxPrice, 200000);
  assert.equal(criteria.status, "active");
  const stored = db.prepare("SELECT tenant_id FROM buyer_criteria WHERE id = ?").get(criteria.id);
  assert.equal(stored.tenant_id, "tenant-a", "tenant stamped from configuration, never the request");

  const list = await api(baseUrl, "GET", "/api/v1/operator/buyer-criteria");
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.data.buyerCriteria.map((c) => c.id), [criteria.id]);

  const got = await api(baseUrl, "GET", `/api/v1/operator/buyer-criteria/${criteria.id}`);
  assert.equal(got.status, 200);
  assert.equal(got.body.data.criteria.id, criteria.id);

  const archived = await api(baseUrl, "POST", `/api/v1/operator/buyer-criteria/${criteria.id}`, { status: "archived" });
  assert.equal(archived.status, 200);
  assert.equal(archived.body.data.criteria.status, "archived");

  const listAfter = await api(baseUrl, "GET", "/api/v1/operator/buyer-criteria");
  assert.equal(listAfter.body.data.buyerCriteria.length, 0, "archived excluded by default");
  const listAll = await api(baseUrl, "GET", "/api/v1/operator/buyer-criteria?includeArchived=true");
  assert.equal(listAll.body.data.buyerCriteria.length, 1);
});

test("ranking orders by recorded MAO headroom and separates excluded from unrankable", async (t) => {
  const { baseUrl } = await fixture(t);
  const created = await api(baseUrl, "POST", "/api/v1/operator/buyer-criteria", {
    label: "Wichita cash buyer", markets: ["Wichita"], maxPrice: 200000,
  });
  const criteriaId = created.body.data.criteria.id;

  const res = await api(baseUrl, "GET", `/api/v1/operator/candidate-ranking?criteriaId=${criteriaId}`);
  assert.equal(res.status, 200);
  const ranking = res.body.data.ranking;

  assert.deepEqual(ranking.ranked.map((r) => r.opportunityId), ["c1", "c2"], "widest recorded headroom first");
  assert.equal(ranking.ranked[0].headroom, 50000);
  assert.equal(ranking.ranked[1].headroom, 20000);

  const excludedBy = Object.fromEntries(ranking.excluded.map((r) => [r.opportunityId, r.reasons.join(" ")]));
  assert.match(excludedBy.c4 || "", /market/);
  assert.match(excludedBy.c5 || "", /price band/);

  const unrankableBy = Object.fromEntries(ranking.unrankable.map((r) => [r.opportunityId, r.reasons.join(" ")]));
  assert.match(unrankableBy.c3 || "", /MAO not recorded/);
  assert.match(unrankableBy.c6 || "", /asking price not recorded/);
  for (const entry of ranking.unrankable) assert.equal(entry.headroom, null, "unrankable entries never carry a score");

  const everywhere = [...ranking.ranked, ...ranking.excluded, ...ranking.unrankable].map((r) => r.opportunityId);
  assert.ok(!everywhere.includes("c7"), "closed-stage candidate is not considered");
  assert.ok(!everywhere.includes("cB"), "foreign-tenant candidate never appears");
  assert.equal(ranking.counts.considered, 6);
});

test("ranking honours minMaoHeadroom and criteria.minConfidence as stated bounds", async (t) => {
  const { baseUrl } = await fixture(t);
  const created = await api(baseUrl, "POST", "/api/v1/operator/buyer-criteria", {
    label: "Strict buyer", minMaoHeadroom: 30000, criteria: { minConfidence: 0.85 },
  });
  const criteriaId = created.body.data.criteria.id;
  const res = await api(baseUrl, "GET", `/api/v1/operator/candidate-ranking?criteriaId=${criteriaId}`);
  const ranking = res.body.data.ranking;
  assert.deepEqual(ranking.ranked.map((r) => r.opportunityId), ["c4", "c5"], "c4 (headroom 120000) and c5 (headroom 100000) clear both bounds with recorded figures");
  const excludedBy = Object.fromEntries(ranking.excluded.map((r) => [r.opportunityId, r.reasons.join(" ")]));
  assert.match(excludedBy.c1 || "", /confidence/);
  assert.match(excludedBy.c2 || "", /headroom/);
  const unrankableBy = Object.fromEntries(ranking.unrankable.map((r) => [r.opportunityId, r.reasons.join(" ")]));
  assert.match(unrankableBy.c3 || "", /confidence not recorded|MAO not recorded/);
});

test("a property-type criterion makes candidates unrankable rather than guessed", async (t) => {
  const { baseUrl } = await fixture(t);
  const created = await api(baseUrl, "POST", "/api/v1/operator/buyer-criteria", {
    label: "Type buyer", propertyTypes: ["single_family"],
  });
  const criteriaId = created.body.data.criteria.id;
  const res = await api(baseUrl, "GET", `/api/v1/operator/candidate-ranking?criteriaId=${criteriaId}`);
  const ranking = res.body.data.ranking;
  assert.equal(ranking.ranked.length, 0);
  assert.ok(ranking.unrankable.length > 0);
  assert.ok(ranking.unrankable.every((r) => r.reasons.some((x) => /property type not recorded/.test(x))));
});

test("foreign-tenant criteria are ghosts: get, update, and ranking all 404", async (t) => {
  const { baseUrl, db } = await fixture(t);
  db.prepare(`
    INSERT INTO buyer_criteria (id, tenant_id, label, markets_json, property_types_json, criteria_json, status, created_by, created_at, updated_at)
    VALUES ('crit-b', 'tenant-b', 'Tenant B buyer', '[]', '[]', '{}', 'active', 'seed', ?, ?)
  `).run(TS, TS);

  const got = await api(baseUrl, "GET", "/api/v1/operator/buyer-criteria/crit-b");
  assert.equal(got.status, 404);
  const updated = await api(baseUrl, "POST", "/api/v1/operator/buyer-criteria/crit-b", { label: "hijacked" });
  assert.equal(updated.status, 404);
  const ranking = await api(baseUrl, "GET", "/api/v1/operator/candidate-ranking?criteriaId=crit-b");
  assert.equal(ranking.status, 404);
  const list = await api(baseUrl, "GET", "/api/v1/operator/buyer-criteria?includeArchived=true");
  assert.ok(!list.body.data.buyerCriteria.some((c) => c.id === "crit-b"));
  const row = db.prepare("SELECT label FROM buyer_criteria WHERE id = 'crit-b'").get();
  assert.equal(row.label, "Tenant B buyer", "foreign row untouched by the refused update");
});
