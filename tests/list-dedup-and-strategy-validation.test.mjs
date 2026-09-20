import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app/createApp.js";
import { makeTempDb, testConfig, startApp } from "./helpers/temporaryDatabase.mjs";

function seedBase(conn) {
  conn.prepare(`
    INSERT INTO seller_opportunities (id, opportunity_code, pipeline_stage, opportunity_status, created_by, ocg_one_property_id, asking_price)
    VALUES ('opp_dup_001', 'OPP-900001', 'new_lead', 'active', 'qa', 'prop-900001', 80000)
  `).run();
  // Three source rows for one opportunity (re-submissions / multiple intakes).
  const src = (id, type, addr, ts) => conn.prepare(`
    INSERT INTO seller_opportunity_sources (
      id, opportunity_id, source_type, source_message_id, original_address, conversion_actor, source_timestamp, conversion_timestamp
    ) VALUES (?, 'opp_dup_001', ?, ?, ?, 'qa', ?, ?)
  `).run(id, type, `MSG-${id}`, addr, ts, ts);
  src("src_dup_001_a", "manual_entry", "111 Dup Row Way", "2026-09-20T10:00:00Z");
  src("src_dup_001_b", "website_form", "111 Dup Row Way", "2026-09-20T11:00:00Z");
  src("src_dup_001_c", "referral", "111 Dup Row Way", "2026-09-20T12:00:00Z");
  // Two underwriting ref rows for the same opportunity (revised analyses).
  const ref = (id, mao, ts) => conn.prepare(`
    INSERT INTO opportunity_underwriting_refs (
      id, opportunity_id, source_system, source_agent, source_project_id,
      source_underwriting_id, source_version_id, analysis_status, arv, rehab, mao,
      confidence, limitations, evidence_summary_json, analyzed_at, created_at
    ) VALUES (?, 'opp_dup_001', 'operator_assumption', 'Victor', 'opp_dup_001',
      'analysis-dup', '1', 'completed', 200000, 25000, ?, 0.85, 'QA seed', '{}', ?, ?)
  `).run(id, mao, ts, ts);
  ref("ref_dup_001_a", 100000, "2026-09-20T10:30:00Z");
  ref("ref_dup_001_b", 112000, "2026-09-20T11:30:00Z");

  // A normal opportunity with a single source + ref, for the offer tests.
  conn.prepare(`
    INSERT INTO seller_opportunities (id, opportunity_code, pipeline_stage, opportunity_status, created_by, ocg_one_property_id, asking_price)
    VALUES ('opp_strat_001', 'OPP-900002', 'new_lead', 'active', 'qa', 'prop-900002', 90000)
  `).run();
  conn.prepare(`
    INSERT INTO seller_opportunity_sources (
      id, opportunity_id, source_type, source_message_id, original_address, conversion_actor, source_timestamp, conversion_timestamp
    ) VALUES ('src_strat_001', 'opp_strat_001', 'manual_entry', 'MSG-STRAT', '222 Strategy Ave', 'qa', '2026-09-20T10:00:00Z', '2026-09-20T10:00:00Z')
  `).run();
  conn.prepare(`
    INSERT INTO opportunity_underwriting_refs (
      id, opportunity_id, source_system, source_agent, source_project_id,
      source_underwriting_id, source_version_id, analysis_status, arv, rehab, mao,
      confidence, limitations, evidence_summary_json, analyzed_at, created_at
    ) VALUES ('ref_strat_001', 'opp_strat_001', 'operator_assumption', 'Victor', 'opp_strat_001',
      'analysis-strat', '1', 'completed', 200000, 25000, 112000, 0.85, 'QA seed', '{}',
      '2026-09-20T10:30:00Z', '2026-09-20T10:30:00Z')
  `).run();
}

test("Regression: opportunity list returns one row per opportunity despite multiple sources/refs", async (t) => {
  const db = makeTempDb();
  const { app, baseUrl } = await startApp(createApp, testConfig(db.dbPath, { dataSource: "empty" }));
  t.after(() => { app.close(); db.cleanup(); });
  const sqlite = await import("node:sqlite");
  const conn = new sqlite.DatabaseSync(db.dbPath);
  seedBase(conn);

  const res = await fetch(`${baseUrl}/api/v1/opportunities`);
  assert.equal(res.status, 200);
  const body = await res.json();
  const rows = body.data.filter((o) => o.id === "opp_dup_001");
  assert.equal(rows.length, 1, `expected 1 list row for opp_dup_001, got ${rows.length}`);
  // Deterministic representative row: the earliest source (original provenance)
  // and the latest underwriting ref (revised analyses supersede earlier ones).
  assert.equal(rows[0].property.address, "111 Dup Row Way");
  assert.equal(rows[0].underwriting.mao, 112000);
  assert.equal(body.meta.pagination.total, 2);
});

test("Regression: invalid offer strategyType fails closed with 400, not 500", async (t) => {
  const db = makeTempDb();
  const { app, baseUrl } = await startApp(createApp, testConfig(db.dbPath, { dataSource: "empty" }));
  t.after(() => { app.close(); db.cleanup(); });
  const sqlite = await import("node:sqlite");
  const conn = new sqlite.DatabaseSync(db.dbPath);
  seedBase(conn);

  const offerBody = (strategyType) => JSON.stringify({
    opportunityId: "opp_strat_001",
    proposedPrice: 120000,
    strategyType,
    earnestMoney: 1000,
    inspectionDays: 10,
    closingDays: 30,
  });

  // 1. Invalid strategy -> 400 invalid_strategyType (was: 500 operator_request_failed).
  const resBad = await fetch(`${baseUrl}/api/v1/operator/offers`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: offerBody("cash"),
  });
  assert.equal(resBad.status, 400);
  assert.equal((await resBad.json()).error, "invalid_strategyType");

  // 2. Every vocabulary value still accepted.
  for (const s of ["cash_purchase", "assignment", "novation", "seller_finance", "subject_to", "lease_option", "listing_referral", "no_offer"]) {
    const r = await fetch(`${baseUrl}/api/v1/operator/offers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: offerBody(s),
    });
    assert.equal(r.status, 201, `strategy ${s} should be accepted`);
  }

  // 3. decideOffer modify path with an invalid strategy -> 400 as well.
  const created = await (await fetch(`${baseUrl}/api/v1/operator/offers`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: offerBody("cash_purchase"),
  })).json();
  const offerId = created.data.offer.id;
  const resModify = await fetch(`${baseUrl}/api/v1/operator/offers/${offerId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "modify", strategyType: "bogus" }),
  });
  assert.equal(resModify.status, 400);
  assert.equal((await resModify.json()).error, "invalid_strategyType");
});
