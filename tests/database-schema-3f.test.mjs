import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTempDb } from "./helpers/temporaryDatabase.mjs";
import { runMigrations } from "../src/database/migrationRunner.js";
import { openPipelineDatabase } from "../src/database/openDatabase.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(__dirname, "../migrations");

test("Phase 3F: Clean migration from empty database and schema verification", (t) => {
  const tempDb = makeTempDb();
  t.after(() => tempDb.cleanup());
  const db = openPipelineDatabase(tempDb.dbPath);

  // 1. Run migrations
  const runResults = runMigrations(db, migrationsDir);
  assert.ok(runResults.length > 0, "Migrations must execute");

  // 2. Verify all required tables exist
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all()
    .map((r) => r.name);

  const requiredTables = [
    "seller_opportunities",
    "seller_opportunity_participants",
    "seller_opportunity_sources",
    "seller_stage_events",
    "seller_appointments",
    "seller_interactions",
    "seller_offers",
    "seller_offer_versions",
    "seller_offer_approval_links",
    "seller_opportunity_outcomes",
    "source_provenance",
    "recovery_metadata",
    "record_classifications",
    "classification_history",
    "operational_audit_events"
  ];

  for (const table of requiredTables) {
    assert.ok(tables.includes(table), `Table ${table} must exist in Phase 3F schema`);
  }

  // 3. Verify no OCG ONE-owned tables exist
  const banned = ["properties", "people", "users", "sellers", "leads"];
  for (const table of banned) {
    assert.ok(!tables.includes(table), `Table ${table} must not exist in standalone PIPELINE database`);
  }

  // 4. Verify no cross-database foreign keys
  const fkList = db.prepare("PRAGMA foreign_key_list(seller_opportunities)").all();
  assert.equal(fkList.length, 0, "seller_opportunities must not have external foreign keys");
});

test("Phase 3F: Deprecation triggers on seller_opportunities underwriting fields", (t) => {
  const tempDb = makeTempDb();
  t.after(() => tempDb.cleanup());
  const db = openPipelineDatabase(tempDb.dbPath);
  runMigrations(db, migrationsDir);

  // Direct insertion with underwriting fields must fail
  assert.throws(() => {
    db.prepare(`
      INSERT INTO seller_opportunities (id, opportunity_code, ocg_one_property_id, created_by, target_purchase_price)
      VALUES ('opp-1', 'OPP-1', 'prop-1', 'system', 100000)
    `).run();
  }, /Direct writes to seller_opportunities underwriting fields are deprecated/);

  // Safe insertion without underwriting fields
  db.prepare(`
    INSERT INTO seller_opportunities (id, opportunity_code, ocg_one_property_id, created_by)
    VALUES ('opp-1', 'OPP-1', 'prop-1', 'system')
  `).run();

  // Direct update of underwriting fields must fail
  assert.throws(() => {
    db.prepare(`
      UPDATE seller_opportunities SET target_purchase_price = 100000 WHERE id = 'opp-1'
    `).run();
  }, /Direct updates to seller_opportunities underwriting fields are deprecated/);
});

test("Phase 3F: Append-only triggers on audit and history tables", (t) => {
  const tempDb = makeTempDb();
  t.after(() => tempDb.cleanup());
  const db = openPipelineDatabase(tempDb.dbPath);
  runMigrations(db, migrationsDir);

  // Setup opportunity
  db.prepare(`
    INSERT INTO seller_opportunities (id, opportunity_code, ocg_one_property_id, created_by)
    VALUES ('opp-1', 'OPP-1', 'prop-1', 'system')
  `).run();

  // Test stage events append-only
  db.prepare(`
    INSERT INTO seller_stage_events (id, opportunity_id, prior_stage, new_stage, changed_by, reason)
    VALUES ('event-1', 'opp-1', 'new_lead', 'needs_review', 'system', 'test')
  `).run();

  assert.throws(() => {
    db.prepare("UPDATE seller_stage_events SET new_stage = 'contacted' WHERE id = 'event-1'").run();
  }, /Updating seller_stage_events is prohibited/);

  assert.throws(() => {
    db.prepare("DELETE FROM seller_stage_events WHERE id = 'event-1'").run();
  }, /Deleting seller_stage_events is prohibited/);

  // Test interactions append-only
  db.prepare(`
    INSERT INTO seller_interactions (id, opportunity_id, channel, direction, occurred_at, summary, created_by)
    VALUES ('int-1', 'opp-1', 'email', 'inbound', '2026-08-01T12:00:00Z', 'Test interaction', 'system')
  `).run();

  assert.throws(() => {
    db.prepare("UPDATE seller_interactions SET summary = 'Modified summary' WHERE id = 'int-1'").run();
  }, /Updating seller_interactions is prohibited/);

  assert.throws(() => {
    db.prepare("DELETE FROM seller_interactions WHERE id = 'int-1'").run();
  }, /Deleting seller_interactions is prohibited/);
});

test("Phase 3F: Immutability triggers on approved and pending seller_offer_versions", (t) => {
  const tempDb = makeTempDb();
  t.after(() => tempDb.cleanup());
  const db = openPipelineDatabase(tempDb.dbPath);
  runMigrations(db, migrationsDir);

  // Setup opportunity and offer
  db.prepare(`
    INSERT INTO seller_opportunities (id, opportunity_code, ocg_one_property_id, created_by)
    VALUES ('opp-1', 'OPP-1', 'prop-1', 'system')
  `).run();

  db.prepare(`
    INSERT INTO seller_offers (id, opportunity_id, created_by)
    VALUES ('off-1', 'opp-1', 'system')
  `).run();

  // Insert draft version (mutable)
  db.prepare(`
    INSERT INTO seller_offer_versions (
      id, offer_id, version_number, version_status, strategy_type, purchase_price,
      earnest_money, inspection_days, closing_days, contingencies_json,
      underwriting_source_type, underwriting_source_id, underwriting_version_id,
      underwriting_arv_snapshot, underwriting_rehab_snapshot, underwriting_mao_snapshot, created_by
    ) VALUES (
      'ver-1', 'off-1', 1, 'draft', 'cash_purchase', 200000, 5000, 10, 30, '{}',
      'victor_analysis', 'u-1', 'uv-1', 300000, 40000, 210000, 'system'
    )
  `).run();

  // Modifying draft should succeed
  db.prepare("UPDATE seller_offer_versions SET purchase_price = 210000 WHERE id = 'ver-1'").run();

  // Update status to pending_approval
  db.prepare("UPDATE seller_offer_versions SET version_status = 'pending_approval' WHERE id = 'ver-1'").run();

  // Modifying terms of pending_approval version must fail
  assert.throws(() => {
    db.prepare("UPDATE seller_offer_versions SET purchase_price = 220000 WHERE id = 'ver-1'").run();
  }, /Modifying terms of a pending_approval or approved seller_offer_version is prohibited/);

  // Deleting pending_approval version must fail
  assert.throws(() => {
    db.prepare("DELETE FROM seller_offer_versions WHERE id = 'ver-1'").run();
  }, /Deleting a pending_approval or approved seller_offer_version is prohibited/);
});

test("Phase 3F: Active version and outcome version ownership invariants", (t) => {
  const tempDb = makeTempDb();
  t.after(() => tempDb.cleanup());
  const db = openPipelineDatabase(tempDb.dbPath);
  runMigrations(db, migrationsDir);

  // Setup opportunities, offers, and versions
  db.prepare(`
    INSERT INTO seller_opportunities (id, opportunity_code, ocg_one_property_id, created_by)
    VALUES ('opp-1', 'OPP-1', 'prop-1', 'system'), ('opp-2', 'OPP-2', 'prop-2', 'system')
  `).run();

  db.prepare(`
    INSERT INTO seller_offers (id, opportunity_id, created_by)
    VALUES ('off-1', 'opp-1', 'system'), ('off-2', 'opp-2', 'system')
  `).run();

  db.prepare(`
    INSERT INTO seller_offer_versions (
      id, offer_id, version_number, version_status, strategy_type, purchase_price,
      earnest_money, inspection_days, closing_days, contingencies_json,
      underwriting_source_type, underwriting_source_id, underwriting_version_id,
      underwriting_arv_snapshot, underwriting_rehab_snapshot, underwriting_mao_snapshot, created_by
    ) VALUES (
      'ver-1', 'off-1', 1, 'draft', 'cash_purchase', 200000, 5000, 10, 30, '{}',
      'victor_analysis', 'u-1', 'uv-1', 300000, 40000, 210000, 'system'
    ), (
      'ver-2', 'off-2', 1, 'draft', 'cash_purchase', 200000, 5000, 10, 30, '{}',
      'victor_analysis', 'u-1', 'uv-1', 300000, 40000, 210000, 'system'
    )
  `).run();

  // Link valid version to off-1
  db.prepare("UPDATE seller_offers SET active_version_id = 'ver-1' WHERE id = 'off-1'").run();

  // Try to link ver-2 to off-1 (ownership mismatch)
  assert.throws(() => {
    db.prepare("UPDATE seller_offers SET active_version_id = 'ver-2' WHERE id = 'off-1'").run();
  }, /Active offer version must belong to the exact seller offer/);

  // Link valid outcome for opp-1
  db.prepare(`
    INSERT INTO seller_opportunity_outcomes (id, opportunity_id, outcome_type, reason, effective_at, actor_id, related_offer_version_id)
    VALUES ('out-1', 'opp-1', 'purchased', 'Accepted offer', '2026-08-01T12:00:00Z', 'system', 'ver-1')
  `).run();

  // Try to insert outcome for opp-2 with ver-1 (ownership mismatch)
  assert.throws(() => {
    db.prepare(`
      INSERT INTO seller_opportunity_outcomes (id, opportunity_id, outcome_type, reason, effective_at, actor_id, related_offer_version_id)
      VALUES ('out-2', 'opp-2', 'purchased', 'Mismatched version', '2026-08-01T12:00:00Z', 'system', 'ver-1')
    `).run();
  }, /Related offer version must belong to an offer under the same opportunity/);
});
