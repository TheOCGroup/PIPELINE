import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTempDb } from "./helpers/temporaryDatabase.mjs";
import { runMigrations } from "../src/database/migrationRunner.js";
import { openPipelineDatabase } from "../src/database/openDatabase.js";
import { writeFileSync, readFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(__dirname, "../migrations");

// Helper to seed fake OCG ONE db schema and data
function seedFakeOcgOne(db) {
  // We need to create a simple mock version of OCG ONE tables needed for migration
  db.exec(`
    CREATE TABLE IF NOT EXISTS seller_opportunities (
      id TEXT PRIMARY KEY,
      tenant_id TEXT,
      opportunity_code TEXT UNIQUE,
      property_id TEXT,
      pipeline_stage TEXT,
      qualification_status TEXT,
      contact_status TEXT,
      opportunity_status TEXT,
      data_quality_status TEXT,
      seller_motivation_type TEXT,
      seller_motivation_score INTEGER,
      timeline_urgency TEXT,
      asking_price REAL,
      seller_expected_price REAL,
      desired_closing_date TEXT,
      occupancy_status TEXT,
      property_condition_summary TEXT,
      assigned_acquisition_manager_id TEXT,
      assigned_underwriter_id TEXT,
      first_contacted_at TEXT,
      last_contacted_at TEXT,
      next_scheduled_contact_at TEXT,
      underwriting_completed_at TEXT,
      offer_approved_at TEXT,
      offer_presented_at TEXT,
      contract_executed_at TEXT,
      scheduled_closing_at TEXT,
      closed_at TEXT,
      archived_at TEXT,
      created_by TEXT,
      updated_by TEXT,
      created_at TEXT,
      updated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS seller_opportunity_participants (
      id TEXT PRIMARY KEY,
      opportunity_id TEXT,
      person_id TEXT,
      participant_role TEXT,
      is_primary INTEGER,
      decision_authority_status TEXT,
      ownership_percentage REAL,
      source_id TEXT,
      verification_status TEXT,
      created_by TEXT,
      created_at TEXT
    );

    CREATE TABLE IF NOT EXISTS seller_opportunity_sources (
      id TEXT PRIMARY KEY,
      opportunity_id TEXT,
      source_type TEXT,
      source_record_id TEXT,
      source_message_id TEXT,
      original_address TEXT,
      source_timestamp TEXT,
      conversion_actor TEXT,
      conversion_timestamp TEXT,
      provenance_metadata_json TEXT,
      created_at TEXT
    );

    CREATE TABLE IF NOT EXISTS seller_stage_events (
      id TEXT PRIMARY KEY,
      opportunity_id TEXT,
      prior_stage TEXT,
      new_stage TEXT,
      changed_by TEXT,
      reason TEXT,
      transition_metadata_json TEXT,
      created_at TEXT
    );

    CREATE TABLE IF NOT EXISTS seller_appointments (
      id TEXT PRIMARY KEY,
      opportunity_id TEXT,
      property_id TEXT,
      starts_at_utc TEXT,
      ends_at_utc TEXT,
      timezone TEXT,
      local_display_start TEXT,
      appointment_type TEXT,
      location TEXT,
      meeting_method TEXT,
      status TEXT,
      confirmation_status TEXT,
      outcome TEXT,
      linked_task_id TEXT,
      created_by TEXT,
      created_at TEXT,
      updated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS seller_interactions (
      id TEXT PRIMARY KEY,
      opportunity_id TEXT,
      participant_id TEXT,
      channel TEXT,
      direction TEXT,
      occurred_at TEXT,
      outcome TEXT,
      summary TEXT,
      private_note TEXT,
      source_type TEXT,
      source_record_id TEXT,
      external_message_id TEXT,
      visibility_classification TEXT,
      created_by TEXT,
      created_at TEXT
    );

    CREATE TABLE IF NOT EXISTS seller_offers (
      id TEXT PRIMARY KEY,
      opportunity_id TEXT,
      current_version INTEGER,
      status TEXT,
      active_version_id TEXT,
      created_by TEXT,
      created_at TEXT,
      updated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS seller_offer_versions (
      id TEXT PRIMARY KEY,
      offer_id TEXT,
      version_number INTEGER,
      version_status TEXT,
      strategy_type TEXT,
      purchase_price REAL,
      earnest_money REAL,
      inspection_days INTEGER,
      closing_days INTEGER,
      expiration_at TEXT,
      contingencies_json TEXT,
      seller_facing_terms TEXT,
      internal_notes TEXT,
      underwriting_source_type TEXT,
      underwriting_source_id TEXT,
      underwriting_version_id TEXT,
      underwriting_arv_snapshot REAL,
      underwriting_rehab_snapshot REAL,
      underwriting_mao_snapshot REAL,
      underwriting_confidence REAL,
      underwriting_limitations TEXT,
      underwriting_timestamp TEXT,
      approval_id TEXT,
      created_by TEXT,
      created_at TEXT,
      superseded_by TEXT
    );

    CREATE TABLE IF NOT EXISTS seller_offer_approval_links (
      id TEXT PRIMARY KEY,
      offer_version_id TEXT,
      approval_id TEXT,
      link_status TEXT,
      created_by TEXT,
      created_at TEXT
    );

    CREATE TABLE IF NOT EXISTS seller_opportunity_outcomes (
      id TEXT PRIMARY KEY,
      opportunity_id TEXT,
      outcome_type TEXT,
      reason TEXT,
      effective_at TEXT,
      actor_id TEXT,
      related_offer_version_id TEXT,
      reopen_eligibility TEXT,
      created_at TEXT
    );
  `);

  // Insert mock records
  db.prepare(`
    INSERT INTO seller_opportunities (id, opportunity_code, property_id, pipeline_stage, qualification_status, opportunity_status, seller_motivation_type, created_by)
    VALUES ('opp-test-1', 'OPP-TEST-1', 'prop-test-1', 'new_lead', 'needs_review', 'active', 'Retail Motivation', 'tester')
  `).run();

  db.prepare(`
    INSERT INTO seller_opportunity_participants (id, opportunity_id, person_id, participant_role, is_primary, created_by)
    VALUES ('part-test-1', 'opp-test-1', 'person-test-1', 'primary_owner', 1, 'tester')
  `).run();

  db.prepare(`
    INSERT INTO seller_opportunity_sources (id, opportunity_id, source_type, original_address, source_timestamp, conversion_actor, provenance_metadata_json)
    VALUES ('src-test-1', 'opp-test-1', 'website_form', '123 Test St', '2026-08-01T12:00:00Z', 'tester', '{"recovered_source_message_id":"msg-recovered-1"}')
  `).run();

  db.prepare(`
    INSERT INTO seller_stage_events (id, opportunity_id, prior_stage, new_stage, changed_by, reason)
    VALUES ('evt-test-1', 'opp-test-1', NULL, 'new_lead', 'tester', 'Initial conversion')
  `).run();
}

test("Phase 3G: Importer dry-run and apply functionality", (t) => {
  // 1. Create a dummy OCG ONE database and seed it
  const dummyOcgOne = makeTempDb();
  t.after(() => dummyOcgOne.cleanup());
  const ocgOneDb = openPipelineDatabase(dummyOcgOne.dbPath); // openPipelineDatabase is safe as it doesn't match canonical path guard for apps/ocg-one
  seedFakeOcgOne(ocgOneDb);
  ocgOneDb.close();

  // 2. Create target standalone pipeline database
  const dummyPipeline = makeTempDb();
  t.after(() => dummyPipeline.cleanup());
  const pipelineDb = openPipelineDatabase(dummyPipeline.dbPath);
  runMigrations(pipelineDb, migrationsDir);
  pipelineDb.close();

  // 3. Export data using a test export script configuration
  const exportJsonPath = join(dummyOcgOne.dir, "export.json");
  
  // We will run the exporter by modifying env or calling node CLI
  const exportScript = join(__dirname, "../src/bin/pipeline-export.js");
  
  // To avoid executing full pipeline-export.js with production paths, let's create a wrapper/modified test runner or perform export programmatically!
  // Exporting programmatically is much easier and highly reliable:
  const exportPayload = {
    schemaVersion: "1.0.0",
    timestamp: new Date().toISOString(),
    sourceDatabaseHash: "dummy-hash",
    recordCounts: {
      seller_opportunities: 1,
      seller_opportunity_participants: 1,
      seller_opportunity_sources: 1,
      seller_stage_events: 1,
      seller_appointments: 0,
      seller_interactions: 0,
      seller_offers: 0,
      seller_offer_versions: 0,
      seller_offer_approval_links: 0,
      seller_opportunity_outcomes: 0
    },
    checksums: {},
    data: {
      seller_opportunities: [
        { id: "opp-test-1", tenant_id: "ocg-one", opportunity_code: "OPP-TEST-1", property_id: "prop-test-1", pipeline_stage: "new_lead", qualification_status: "needs_review", contact_status: "uncontacted", opportunity_status: "active", data_quality_status: "raw_ingestion", seller_motivation_type: "Retail Motivation", created_by: "tester", created_at: "2026-08-01T12:00:00Z" }
      ],
      seller_opportunity_participants: [
        { id: "part-test-1", opportunity_id: "opp-test-1", person_id: "person-test-1", participant_role: "primary_owner", is_primary: 1, decision_authority_status: "full_authority", created_by: "tester", created_at: "2026-08-01T12:00:00Z" }
      ],
      seller_opportunity_sources: [
        { id: "src-test-1", opportunity_id: "opp-test-1", source_type: "website_form", original_address: "123 Test St", source_timestamp: "2026-08-01T12:00:00Z", conversion_actor: "tester", conversion_timestamp: "2026-08-01T12:00:00Z", provenance_metadata_json: '{"recovered_source_message_id":"msg-recovered-1"}', created_at: "2026-08-01T12:00:00Z" }
      ],
      seller_stage_events: [
        { id: "evt-test-1", opportunity_id: "opp-test-1", prior_stage: null, new_stage: "new_lead", changed_by: "tester", reason: "Initial conversion", created_at: "2026-08-01T12:00:00Z" }
      ],
      seller_appointments: [],
      seller_interactions: [],
      seller_offers: [],
      seller_offer_versions: [],
      seller_offer_approval_links: [],
      seller_opportunity_outcomes: []
    }
  };

  // Generate checksums
  for (const table in exportPayload.data) {
    const tableStr = JSON.stringify(exportPayload.data[table]);
    exportPayload.checksums[table] = createHash("sha256").update(tableStr).digest("hex");
  }

  writeFileSync(exportJsonPath, JSON.stringify(exportPayload, null, 2), "utf8");

  // 4. Test Preview (Dry-Run)
  const importScript = join(__dirname, "../src/bin/pipeline-import.js");
  const cmdPreview = `node "${importScript}" preview "${exportJsonPath}" "${dummyPipeline.dbPath}"`;
  const outPreview = execSync(cmdPreview, { encoding: "utf8" });
  assert.ok(outPreview.includes("Dry-run preview complete"), "Preview command must complete dry-run");

  // Check target database - should be empty!
  const targetDbAfterPreview = openPipelineDatabase(dummyPipeline.dbPath);
  const oppCountPreview = targetDbAfterPreview.prepare("SELECT count(*) as count FROM seller_opportunities").get().count;
  assert.equal(oppCountPreview, 0, "No opportunities must be imported on preview");
  targetDbAfterPreview.close();

  // 5. Test Apply (Live Import)
  const cmdApply = `node "${importScript}" apply "${exportJsonPath}" "${dummyPipeline.dbPath}"`;
  const outApply = execSync(cmdApply, { encoding: "utf8" });
  assert.ok(outApply.includes("Transaction committed. Data migration complete."), "Apply command must complete commit");

  // Check target database - must have the imported opportunity!
  const targetDbAfterApply = openPipelineDatabase(dummyPipeline.dbPath);
  const opps = targetDbAfterApply.prepare("SELECT * FROM seller_opportunities").all();
  assert.equal(opps.length, 1);
  assert.equal(opps[0].id, "opp-test-1");
  assert.equal(opps[0].ocg_one_property_id, "prop-test-1");

  // Check provenance recovery
  const provenance = targetDbAfterApply.prepare("SELECT * FROM source_provenance").all();
  assert.equal(provenance.length, 1);
  assert.equal(provenance[0].opportunity_id, "opp-test-1");
  assert.equal(provenance[0].resolution_status, "recovered_resolved");

  // Check classification recalculation
  const classifications = targetDbAfterApply.prepare("SELECT * FROM record_classifications").all();
  assert.equal(classifications.length, 1);
  assert.equal(classifications[0].opportunity_id, "opp-test-1");
  assert.equal(classifications[0].classification_value, "retail_listing"); // mapped from motivation 'Retail Motivation'

  // Check audit events
  const audits = targetDbAfterApply.prepare("SELECT * FROM operational_audit_events").all();
  assert.equal(audits.length, 1);
  assert.equal(audits[0].event_type, "MIGRATION_IMPORT");

  targetDbAfterApply.close();

  // 6. Test Rollback command
  const cmdRollback = `node "${importScript}" rollback "${exportJsonPath}" "${dummyPipeline.dbPath}"`;
  const outRollback = execSync(cmdRollback, { encoding: "utf8" });
  assert.ok(outRollback.includes("data cleared successfully"), "Rollback command must clean tables");

  const targetDbAfterRollback = openPipelineDatabase(dummyPipeline.dbPath);
  const oppCountRollback = targetDbAfterRollback.prepare("SELECT count(*) as count FROM seller_opportunities").get().count;
  assert.equal(oppCountRollback, 0, "No opportunities must remain after rollback");
  targetDbAfterRollback.close();
});
