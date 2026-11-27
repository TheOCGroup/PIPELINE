/**
 * Lane A — R1-F1 remediation proof: PiperContextService #recent() streams
 * are SQL-scoped (foreign rows never cross the db boundary), and the
 * MAX_RECENT tail can no longer be crowded out by foreign rows.
 *
 * Written to FAIL against the pre-fix piperContextService.js (post-filter
 * design): the spy-db assertions fail because pre-fix #recent SQL carries
 * no tenant predicate, and the crowding test fails because pre-fix
 * slice(0, MAX_RECENT) runs BEFORE the in-memory tenant filter.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDb, testConfig, startApp } from "./helpers/temporaryDatabase.mjs";
import { createApp } from "../src/app/createApp.js";
import { PiperContextService } from "../src/services/piperContextService.js";

const SECRET = "x".repeat(40);
const A_ID = "opp-a-0001";
const B_ID = "opp-b-0001";
const TS = "2026-10-31T00:00:00.000Z";
const NEWER = "2026-11-20T00:00:00.000Z";

function tenantConfig(dbPath, tenantId) {
  return testConfig(dbPath, {
    env: "production", operatorSecret: SECRET, operatorAuthEnabled: true,
    dataSource: "empty", tenantId, piperIntakeEnabled: true,
    piperIntakeSecret: "y".repeat(40), readOnly: false,
  });
}

function seedOpp(db, id, tenantId, code) {
  db.prepare(
    `INSERT INTO seller_opportunities (id, tenant_id, opportunity_code, ocg_one_property_id,
       pipeline_stage, asking_price, created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'new_lead', 250000, 'seed', 'seed', ?, ?)`
  ).run(id, tenantId, code, `prop-${id}`, TS, TS);
  db.prepare(
    `INSERT INTO seller_stage_events (id, opportunity_id, prior_stage, new_stage, changed_by, reason, created_at)
     VALUES (?, ?, NULL, 'new_lead', 'seed', 'seeded', ?)`
  ).run(`${id}-stage`, id, TS);
  db.prepare(
    `INSERT INTO classification_history (id, opportunity_id, prior_classification, new_classification,
       classification_rules_version, determined_by, reason, determined_at)
     VALUES (?, ?, NULL, 'wholesale_target', '1.0.0', 'seed', 'seeded', ?)`
  ).run(`${id}-clsh`, id, TS);
  db.prepare(
    `INSERT INTO opportunity_underwriting_refs (id, opportunity_id, source_system, mao, arv, confidence, created_at)
     VALUES (?, ?, 'victor_analysis', 180000, 300000, 0.9, ?)`
  ).run(`${id}-uwr`, id, TS);
  db.prepare(
    `INSERT INTO operational_audit_events (id, event_timestamp, event_type, actor_id, opportunity_id, payload_json)
     VALUES (?, ?, 'DEAL_FINDR_INTAKE', 'deal-findr', ?, ?)`
  ).run(`${id}-intake`, TS, id, JSON.stringify({ opportunityId: id, address: `${id} address` }));
}

async function boot(t) {
  const tempDb = makeTempDb();
  t.after(() => tempDb.cleanup());
  const started = await startApp(createApp, tenantConfig(tempDb.dbPath, "tenant-a"));
  t.after(() => started.app.close());
  seedOpp(started.app.db, A_ID, "tenant-a", "OPP-A001");
  seedOpp(started.app.db, B_ID, "tenant-b", "OPP-B001");
  return started;
}

function spyOn(app) {
  const recorded = [];
  const spyDb = {
    prepare(sql) {
      const stmt = app.db.prepare(sql);
      return {
        get: (...a) => stmt.get(...a),
        all: (...a) => { const rows = stmt.all(...a); recorded.push({ sql, rows }); return rows; },
        run: (...a) => stmt.run(...a),
      };
    },
    exec: (...a) => app.db.exec(...a),
  };
  return { spyDb, recorded };
}

const RECENT_LOADS = [
  "FROM operational_audit_events",
  "prior_stage, new_stage",
  "FROM classification_history",
  "FROM opportunity_underwriting_refs",
];

test("A-P1 #recent() loads are SQL-scoped: tenant predicate present, zero foreign rows cross the boundary", async (t) => {
  const { app } = await boot(t);
  const { spyDb, recorded } = spyOn(app);
  const svc = new PiperContextService(spyDb, { tenantId: "tenant-a" });
  const snapshot = svc.snapshot();

  const seen = new Set();
  for (const { sql, rows } of recorded) {
    const fragment = RECENT_LOADS.find((f) => sql.includes(f));
    if (!fragment) continue;
    seen.add(fragment);
    assert.ok(sql.includes("tenant_id = ?"),
      `#recent load lacks SQL tenant predicate (${fragment}): ${sql.slice(0, 160)}`);
    for (const row of rows) {
      assert.notEqual(row.opportunity_id, B_ID, `#recent load leaked a tenant-b row (${fragment})`);
    }
  }
  assert.deepEqual([...seen].sort(), [...RECENT_LOADS].sort(), "all four #recent loads exercised");

  // Emission: recent streams contain tenant-a's events and nothing of B's.
  assert.deepEqual(snapshot.recent.stageEvents.map((e) => e.opportunity_id), [A_ID]);
  assert.deepEqual(snapshot.recent.classificationChanges.map((e) => e.opportunity_id), [A_ID]);
  assert.deepEqual(snapshot.recent.victorUpdates.map((e) => e.opportunity_id), [A_ID]);
  assert.deepEqual(snapshot.recent.intakes.map((e) => e.opportunityId), [A_ID]);

  // Negative control: tenant-b's own service DOES see its recent events.
  const svcB = new PiperContextService(app.db, { tenantId: "tenant-b" });
  assert.deepEqual(svcB.snapshot().recent.stageEvents.map((e) => e.opportunity_id), [B_ID]);
});

test("A-P2 foreign rows cannot crowd tenant-a out of the MAX_RECENT tail", async (t) => {
  const { app } = await boot(t);
  // 30 foreign stage events NEWER than tenant-a's single event (> MAX_RECENT=25).
  const ins = app.db.prepare(
    `INSERT INTO seller_stage_events (id, opportunity_id, prior_stage, new_stage, changed_by, reason, created_at)
     VALUES (?, ?, 'new_lead', 'contacted', 'seed', 'crowd', ?)`);
  for (let i = 0; i < 30; i++) ins.run(`opp-b-crowd-${i}`, B_ID, NEWER);
  const insC = app.db.prepare(
    `INSERT INTO classification_history (id, opportunity_id, prior_classification, new_classification,
       classification_rules_version, determined_by, reason, determined_at)
     VALUES (?, ?, 'wholesale_target', 'retail_listing', '1.0.0', 'seed', 'crowd', ?)`);
  for (let i = 0; i < 30; i++) insC.run(`opp-b-crowdc-${i}`, B_ID, NEWER);

  const svc = new PiperContextService(app.db, { tenantId: "tenant-a" });
  const recent = svc.snapshot().recent;
  assert.ok(recent.stageEvents.some((e) => e.opportunity_id === A_ID),
    "tenant-a stage event was crowded out of the recent tail by foreign rows");
  assert.ok(recent.stageEvents.every((e) => e.opportunity_id === A_ID));
  assert.ok(recent.classificationChanges.some((e) => e.opportunity_id === A_ID),
    "tenant-a classification change was crowded out of the recent tail by foreign rows");
  assert.ok(recent.classificationChanges.every((e) => e.opportunity_id === A_ID));
});
