import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app/createApp.js";
import { loadConfig } from "../src/config/environment.js";
import { makeTempDb, testConfig, startApp } from "./helpers/temporaryDatabase.mjs";

test("Safety: Production mode rejects fixtures data source", () => {
  // Production + fixtures -> must throw immediately
  assert.throws(() => {
    loadConfig({
      PIPELINE_ENV: "production",
      PIPELINE_DATA_SOURCE: "fixtures",
    });
  }, /not permitted in production/);
});

test("Safety: Empty mode returns empty states and arrays", async (t) => {
  const db = makeTempDb();
  const { app, baseUrl } = await startApp(createApp, testConfig(db.dbPath, { dataSource: "empty" }));
  t.after(() => { app.close(); db.cleanup(); });

  const resOpps = await fetch(`${baseUrl}/api/v1/opportunities`);
  const bodyOpps = await resOpps.json();
  assert.equal(bodyOpps.data.length, 0, "Opportunities list must be empty");

  const resProv = await fetch(`${baseUrl}/api/v1/provenance`);
  const bodyProv = await resProv.json();
  assert.equal(bodyProv.data.length, 0, "Provenance list must be empty");

  const resCls = await fetch(`${baseUrl}/api/v1/classifications`);
  const bodyCls = await resCls.json();
  assert.equal(bodyCls.data.current.length, 0, "Current classifications list must be empty");
  assert.equal(bodyCls.data.history.length, 0, "Classification history list must be empty");

  const resDq = await fetch(`${baseUrl}/api/v1/data-quality`);
  const bodyDq = await resDq.json();
  assert.equal(bodyDq.data.totalOpportunities, 0);
  assert.equal(bodyDq.data.originalProvenance, 0);
});

test("Safety: Database schema remains metadata only (no production schema tables)", (t) => {
  const db = makeTempDb();
  t.after(() => db.cleanup());
  const app = createApp(testConfig(db.dbPath, { dataSource: "empty" }));
  t.after(() => app.close());

  // Confirm database exists
  const tables = app.db
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all()
    .map((r) => r.name);

  // Allowed tables: pipeline_migrations, pipeline_application_metadata, and PIPELINE-owned production tables
  assert.ok(tables.includes("pipeline_migrations"));
  assert.ok(tables.includes("pipeline_application_metadata"));
  assert.ok(tables.includes("seller_opportunities"));
  assert.ok(tables.includes("seller_opportunity_sources"));
  assert.ok(tables.includes("seller_opportunity_participants"));
  assert.ok(tables.includes("source_provenance"));
  assert.ok(tables.includes("record_classifications"));

  // Banned OCG ONE-owned tables in PIPELINE database
  const prohibited = [
    "properties",
    "people",
    "users",
    "sellers",
    "leads"
  ];
  for (const table of prohibited) {
    assert.ok(!tables.includes(table), `Table ${table} must not exist in standalone PIPELINE database`);
  }
});
