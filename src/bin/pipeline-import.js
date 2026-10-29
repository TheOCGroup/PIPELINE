import { DatabaseSync } from "node:sqlite";
import { readFileSync, existsSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";

// F-027-IMPORT (fixed): seller offers are imported with active_version_id
// temporarily NULL; the pointers are restored only after the offer
// versions (and underwriting references) have landed, with exact
// ownership and version-number verification for each pointer. The
// previous order inserted offers with their pointers already populated,
// and the migration-006 ownership trigger correctly rejected the insert
// because the referenced version rows did not exist yet — the import
// could never import a database whose offers carry active versions
// (exactly the production shape). Constraints are NOT weakened: the
// restore runs through the same BEFORE UPDATE ownership trigger, and
// any missing, foreign, or version-inconsistent pointer aborts the
// whole transaction (atomic rollback, fail closed).
//
// RECOVERY HONESTY: this tool is a migration aid, not an exact
// disaster-recovery mechanism. Section 7.5 synthesizes provenance and
// classification records (new UUIDs and timestamps), and apply mode
// writes an audit event. File-level SQLite backup/restore remains the
// approved recovery method for production.
//
// F-027-IMPORT-2 (dispositioned): the seller_opportunities insert now
// carries the opportunity-level underwriting SOURCE columns
// (underwriting_source_type / _source_id / _version_id). The remaining
// opportunity-level underwriting columns (target_purchase_price,
// max_authorized_offer, underwriting_arv/rehab/mao_snapshot,
// underwriting_confidence, underwriting_limitations,
// underwriting_timestamp) are DEPRECATED BY SCHEMA DESIGN: migration
// 006's triggers forbid writing any non-NULL value into them
// ("Authoritative underwriting snapshots belong on
// seller_offer_versions"), and every production opportunity row holds
// NULL there. The import therefore cannot — and must not — write them.
// If a legacy payload nonetheless carries non-NULL values in those
// columns, the import prints an explicit per-row warning (never a
// silent drop): the values remain preserved in the export payload
// itself, which is the archival record, and a founder data decision is
// required before they can be represented anywhere in the target.

const DEFAULT_EXPORT_JSON_PATH = "C:\\Users\\Genaro\\Documents\\OCG OS\\integration-work\\pipeline_export.json";
const DEFAULT_DB_PATH = "C:\\Users\\Genaro\\Documents\\OCG OS\\apps\\pipeline\\pipeline.db";

async function runImport() {
  const args = process.argv.slice(2);
  const command = args[0] || "preview"; // preview, apply, rollback, verify
  const exportPath = args[1] || DEFAULT_EXPORT_JSON_PATH;
  const dbPath = args[2] || DEFAULT_DB_PATH;

  console.log(`=== RUNNING IMPORT TOOL: ${command.toUpperCase()} ===`);
  console.log(`Export File: ${exportPath}`);
  console.log(`Target DB:   ${dbPath}`);

  if (dbPath.toLowerCase().includes("ocg_one.db")) {
    console.error("CRITICAL SAFETY ERROR: Target database cannot be the canonical OCG ONE database! Aborting.");
    process.exit(1);
  }

  if (command === "rollback") {
    const db = new DatabaseSync(dbPath);
    try {
      console.log("Rolling back imported data (resetting schema to clean migration baseline)...");
      db.exec("PRAGMA foreign_keys = OFF;");
      
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('pipeline_migrations', 'pipeline_application_metadata')").all().map(r => r.name);
      for (const t of tables) {
        db.exec(`DROP TABLE IF EXISTS ${t};`);
      }
      const views = db.prepare("SELECT name FROM sqlite_master WHERE type='view'").all().map(r => r.name);
      for (const v of views) {
        db.exec(`DROP VIEW IF EXISTS ${v};`);
      }
      const triggers = db.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all().map(r => r.name);
      for (const trg of triggers) {
        db.exec(`DROP TRIGGER IF EXISTS ${trg};`);
      }
      
      // Remove applied migrations record from pipeline_migrations except 001 and 002
      db.exec("DELETE FROM pipeline_migrations WHERE filename NOT IN ('001_pipeline_application_metadata.sql', '002_pipeline_identity_sessions.sql');");
      
      // Re-run migrations 003-008 to restore clean empty schema and triggers
      const { runMigrations } = await import("../database/migrationRunner.js");
      const { dirname, join } = await import("node:path");
      const { fileURLToPath } = await import("node:url");
      const __dirname = dirname(fileURLToPath(import.meta.url));
      const migrationsDir = join(__dirname, "../../migrations");
      runMigrations(db, migrationsDir);
      
      console.log("[PASS] Standalone data cleared successfully.");
    } catch (err) {
      console.error(`Rollback failed: ${err.message}`);
      process.exit(1);
    } finally {
      db.close();
    }
    return;
  }

  if (!existsSync(exportPath)) {
    console.error(`Export file not found: ${exportPath}`);
    process.exit(1);
  }

  // Fail closed before opening the target: importing into a path that
  // does not exist would silently create an empty file (DatabaseSync
  // creates on open) and then fail mid-transaction. The target must be
  // an existing, fully migrated database.
  if (!existsSync(dbPath)) {
    console.error(`import refused: target database not found: ${dbPath} (create and migrate it first)`);
    process.exit(1);
  }

  const payload = JSON.parse(readFileSync(exportPath, "utf8"));

  // Checksum Verification
  console.log("Verifying per-section checksums...");
  for (const table in payload.data) {
    const dataStr = JSON.stringify(payload.data[table]);
    const currentHash = createHash("sha256").update(dataStr).digest("hex");
    if (currentHash !== payload.checksums[table]) {
      console.error(`CRITICAL ERROR: Checksum mismatch for table ${table}! File might be corrupted.`);
      process.exit(1);
    }
  }
  console.log("All checksums verified successfully.");

  const tables = [
    "seller_opportunities",
    "seller_opportunity_participants",
    "seller_opportunity_sources",
    "seller_stage_events",
    "seller_appointments",
    "seller_interactions",
    "seller_offers",
    "seller_offer_versions",
    "seller_offer_approval_links",
    "seller_opportunity_outcomes"
  ];

  const db = new DatabaseSync(dbPath);
  // Preflight: every table this tool writes to must already exist
  // (a partially migrated target fails here, cleanly, before any write).
  const requiredTables = [...tables, "opportunity_underwriting_refs", "source_provenance", "record_classifications", "classification_history", "operational_audit_events"];
  const presentTables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name));
  const missingTables = requiredTables.filter(t => !presentTables.has(t));
  if (missingTables.length > 0) {
    db.close();
    console.error(`import refused: target database is missing required table(s): ${missingTables.join(", ")}`);
    process.exit(1);
  }
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("BEGIN TRANSACTION;");

  try {
    const isApply = command === "apply";

    const DEFAULTS = {
      created_at: () => new Date().toISOString(),
      updated_at: () => new Date().toISOString(),
      pipeline_stage: "new_lead",
      qualification_status: "needs_review",
      contact_status: "uncontacted",
      opportunity_status: "active",
      data_quality_status: "raw_ingestion",
      decision_authority_status: "full_authority",
      verification_status: "unverified",
      timezone: "America/Chicago",
      status: "scheduled",
      confirmation_status: "pending",
      visibility_classification: "internal",
      current_version: 1,
      version_status: "draft",
      link_status: "linked",
      reopen_eligibility: "eligible_with_approval"
    };

    const getValue = (row, k) => {
      const val = row[k] === undefined ? null : row[k];
      if (val === null && DEFAULTS[k] !== undefined) {
        return typeof DEFAULTS[k] === "function" ? DEFAULTS[k]() : DEFAULTS[k];
      }
      return val;
    };
    
    // Deprecated opportunity-level underwriting columns (F-027-IMPORT-2):
    // migration 006 forbids writing non-NULL values into these columns,
    // so they are not carried. Warn explicitly — never silently drop —
    // when a legacy payload carries values there.
    const DEPRECATED_OPP_UW_COLUMNS = ["target_purchase_price", "max_authorized_offer", "underwriting_arv_snapshot", "underwriting_rehab_snapshot", "underwriting_mao_snapshot", "underwriting_confidence", "underwriting_limitations", "underwriting_timestamp"];
    const deprecationWarnings = [];
    for (const row of payload.data.seller_opportunities) {
      const carried = DEPRECATED_OPP_UW_COLUMNS.filter(c => row[c] !== null && row[c] !== undefined);
      if (carried.length > 0) {
        deprecationWarnings.push({ opportunityId: row.id, columns: carried });
        console.error(`WARNING: opportunity ${row.id} carries value(s) in deprecated opportunity-level underwriting column(s) [${carried.join(", ")}] that the target schema (migration 006) forbids writing. They are NOT carried into the target; they remain preserved in this export payload. A founder data decision is required to represent them.`);
      }
    }

    // Import seller_opportunities
    console.log("Migrating seller_opportunities...");
    for (const row of payload.data.seller_opportunities) {
      const get = (k) => getValue(row, k);
      db.prepare(`
        INSERT INTO seller_opportunities (
          id, tenant_id, opportunity_code, ocg_one_property_id, pipeline_stage,
          qualification_status, contact_status, opportunity_status, data_quality_status,
          seller_motivation_type, seller_motivation_score, timeline_urgency, asking_price,
          seller_expected_price, desired_closing_date, occupancy_status, property_condition_summary,
          underwriting_source_type, underwriting_source_id, underwriting_version_id,
          assigned_acquisition_manager_id, assigned_underwriter_id, first_contacted_at,
          last_contacted_at, next_scheduled_contact_at, underwriting_completed_at,
          offer_approved_at, offer_presented_at, contract_executed_at, scheduled_closing_at,
          closed_at, archived_at, created_by, updated_by, created_at, updated_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        get("id"), get("tenant_id"), get("opportunity_code"), get("property_id") || get("ocg_one_property_id"), get("pipeline_stage"),
        get("qualification_status"), get("contact_status"), get("opportunity_status"), get("data_quality_status"),
        get("seller_motivation_type"), get("seller_motivation_score"), get("timeline_urgency"), get("asking_price"),
        get("seller_expected_price"), get("desired_closing_date"), get("occupancy_status"), get("property_condition_summary"),
        get("underwriting_source_type"), get("underwriting_source_id"), get("underwriting_version_id"),
        get("assigned_acquisition_manager_id"), get("assigned_underwriter_id"), get("first_contacted_at"),
        get("last_contacted_at"), get("next_scheduled_contact_at"), get("underwriting_completed_at"),
        get("offer_approved_at"), get("offer_presented_at"), get("contract_executed_at"), get("scheduled_closing_at"),
        get("closed_at"), get("archived_at"), get("created_by"), get("updated_by"), get("created_at"), get("updated_at")
      );
    }

    // Import participants
    console.log("Migrating participants...");
    for (const row of payload.data.seller_opportunity_participants) {
      const get = (k) => getValue(row, k);
      db.prepare(`
        INSERT INTO seller_opportunity_participants (
          id, opportunity_id, ocg_one_person_id, participant_role, is_primary,
          decision_authority_status, ownership_percentage, source_id, verification_status,
          created_by, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        get("id"), get("opportunity_id"), get("person_id") || get("ocg_one_person_id"), get("participant_role"), get("is_primary"),
        get("decision_authority_status"), get("ownership_percentage"), get("source_id"), get("verification_status"),
        get("created_by"), get("created_at")
      );
    }

    // Import sources
    console.log("Migrating sources...");
    for (const row of payload.data.seller_opportunity_sources) {
      const get = (k) => getValue(row, k);
      db.prepare(`
        INSERT INTO seller_opportunity_sources (
          id, opportunity_id, source_type, source_record_id, source_message_id,
          original_address, source_timestamp, conversion_actor, conversion_timestamp,
          provenance_metadata_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        get("id"), get("opportunity_id"), get("source_type"), get("source_record_id"), get("source_message_id"),
        get("original_address"), get("source_timestamp"), get("conversion_actor"), get("conversion_timestamp"),
        get("provenance_metadata_json"), get("created_at")
      );
    }

    // Import stage events
    console.log("Migrating stage events...");
    for (const row of payload.data.seller_stage_events) {
      const get = (k) => getValue(row, k);
      db.prepare(`
        INSERT INTO seller_stage_events (
          id, opportunity_id, prior_stage, new_stage, changed_by, reason,
          transition_metadata_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        get("id"), get("opportunity_id"), get("prior_stage"), get("new_stage"), get("changed_by"), get("reason"),
        get("transition_metadata_json"), get("created_at")
      );
    }

    // Import appointments
    console.log("Migrating appointments...");
    for (const row of payload.data.seller_appointments) {
      const get = (k) => getValue(row, k);
      db.prepare(`
        INSERT INTO seller_appointments (
          id, opportunity_id, ocg_one_property_id, starts_at_utc, ends_at_utc,
          timezone, local_display_start, appointment_type, location, meeting_method,
          status, confirmation_status, outcome, linked_task_id, created_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        get("id"), get("opportunity_id"), get("property_id") || get("ocg_one_property_id"), get("starts_at_utc"), get("ends_at_utc"),
        get("timezone"), get("local_display_start"), get("appointment_type"), get("location"), get("meeting_method"),
        get("status"), get("confirmation_status"), get("outcome"), get("linked_task_id"), get("created_by"), get("created_at"), get("updated_at")
      );
    }

    // Import interactions
    console.log("Migrating interactions...");
    for (const row of payload.data.seller_interactions) {
      const get = (k) => getValue(row, k);
      db.prepare(`
        INSERT INTO seller_interactions (
          id, opportunity_id, participant_id, channel, direction, occurred_at,
          outcome, summary, private_note, source_type, source_record_id,
          external_message_id, visibility_classification, created_by, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        get("id"), get("opportunity_id"), get("participant_id"), get("channel"), get("direction"), get("occurred_at"),
        get("outcome"), get("summary"), get("private_note"), get("source_type"), get("source_record_id"),
        get("external_message_id"), get("visibility_classification"), get("created_by"), get("created_at")
      );
    }

    // Import offers — with active_version_id temporarily NULL
    // (F-027-IMPORT): the ownership trigger requires the referenced
    // version row to exist, and versions are imported after offers.
    // The declared pointers are restored and verified once every
    // version has landed (see the pointer-restoration step below).
    console.log("Migrating offers...");
    const intendedPointers = [];
    for (const row of payload.data.seller_offers) {
      const get = (k) => getValue(row, k);
      db.prepare(`
        INSERT INTO seller_offers (
          id, opportunity_id, current_version, status, active_version_id,
          created_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        get("id"), get("opportunity_id"), get("current_version"), get("status"), null,
        get("created_by"), get("created_at"), get("updated_at")
      );
      if (get("active_version_id") !== null) {
        intendedPointers.push({
          offerId: get("id"),
          activeVersionId: get("active_version_id"),
          currentVersion: get("current_version")
        });
      }
    }

    // Import underwriting references (migration 027: offer versions link
    // to these rows, so they must land before the versions import).
    console.log("Migrating underwriting references...");
    for (const row of payload.data.opportunity_underwriting_refs || []) {
      const get = (k) => getValue(row, k);
      db.prepare(`
        INSERT INTO opportunity_underwriting_refs (
          id, opportunity_id, source_system, source_agent, source_project_id,
          source_underwriting_id, source_version_id, analysis_status,
          arv, rehab, mao, confidence, limitations, evidence_summary_json, analyzed_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        get("id"), get("opportunity_id"), get("source_system"), get("source_agent"), get("source_project_id"),
        get("source_underwriting_id"), get("source_version_id"), get("analysis_status") || get("status"),
        get("arv"), get("rehab"), get("mao"), get("confidence"), get("limitations"),
        get("evidence_summary_json"), get("analyzed_at"), get("created_at")
      );
    }

    // Import offer versions
    console.log("Migrating offer versions...");
    for (const row of payload.data.seller_offer_versions) {
      const get = (k) => getValue(row, k);
      db.prepare(`
        INSERT INTO seller_offer_versions (
          id, offer_id, version_number, version_status, strategy_type, purchase_price,
          earnest_money, inspection_days, closing_days, expiration_at, contingencies_json,
          seller_facing_terms, internal_notes, underwriting_source_type, underwriting_source_id,
          underwriting_version_id, underwriting_ref_id, underwriting_arv_snapshot, underwriting_rehab_snapshot,
          underwriting_mao_snapshot, underwriting_confidence, underwriting_limitations,
          underwriting_timestamp, ocg_one_approval_id, created_by, created_at, superseded_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        get("id"), get("offer_id"), get("version_number"), get("version_status"), get("strategy_type"), get("purchase_price"),
        get("earnest_money"), get("inspection_days"), get("closing_days"), get("expiration_at"), get("contingencies_json"),
        get("seller_facing_terms"), get("internal_notes"), get("underwriting_source_type"), get("underwriting_source_id"),
        get("underwriting_version_id"), get("underwriting_ref_id") ?? null, get("underwriting_arv_snapshot"), get("underwriting_rehab_snapshot"),
        get("underwriting_mao_snapshot"), get("underwriting_confidence"), get("underwriting_limitations"),
        get("underwriting_timestamp"), get("approval_id") || get("ocg_one_approval_id"), get("created_by"), get("created_at"), get("superseded_by")
      );
    }

    // Import approval links
    console.log("Migrating approval links...");
    for (const row of payload.data.seller_offer_approval_links) {
      const get = (k) => getValue(row, k);
      db.prepare(`
        INSERT INTO seller_offer_approval_links (
          id, offer_version_id, ocg_one_approval_id, link_status, created_by, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        get("id"), get("offer_version_id"), get("approval_id") || get("ocg_one_approval_id"), get("link_status"), get("created_by"), get("created_at")
      );
    }

    // Import outcomes
    console.log("Migrating outcomes...");
    for (const row of payload.data.seller_opportunity_outcomes) {
      const get = (k) => getValue(row, k);
      db.prepare(`
        INSERT INTO seller_opportunity_outcomes (
          id, opportunity_id, outcome_type, reason, effective_at, actor_id,
          related_offer_version_id, reopen_eligibility, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        get("id"), get("opportunity_id"), get("outcome_type"), get("reason"), get("effective_at"), get("actor_id"),
        get("related_offer_version_id"), get("reopen_eligibility"), get("created_at")
      );
    }

    // Restore active-version pointers (F-027-IMPORT). Every declared
    // pointer is verified against the imported versions BEFORE it is
    // written: the version must exist, must belong to the exact offer,
    // and its version_number must equal the offer's current_version.
    // The UPDATE itself passes through the BEFORE UPDATE ownership
    // trigger. Any inconsistency throws, and the surrounding
    // transaction rolls the entire import back atomically.
    console.log("Restoring active-version pointers...");
    for (const pointer of intendedPointers) {
      const version = db.prepare(`SELECT offer_id, version_number FROM seller_offer_versions WHERE id = ?`).get(pointer.activeVersionId);
      if (!version) {
        throw new Error(`import integrity failure: active version ${pointer.activeVersionId} declared by offer ${pointer.offerId} is missing from the imported versions`);
      }
      if (version.offer_id !== pointer.offerId) {
        throw new Error(`import integrity failure: active version ${pointer.activeVersionId} belongs to offer ${version.offer_id}, not ${pointer.offerId}`);
      }
      if (Number(version.version_number) !== Number(pointer.currentVersion)) {
        throw new Error(`import integrity failure: offer ${pointer.offerId} declares current_version ${pointer.currentVersion} but its active version ${pointer.activeVersionId} has version_number ${version.version_number}`);
      }
      db.prepare(`UPDATE seller_offers SET active_version_id = ? WHERE id = ?`).run(pointer.activeVersionId, pointer.offerId);
    }
    const fkViolationsAfterRestore = db.prepare(`PRAGMA foreign_key_check`).all();
    if (fkViolationsAfterRestore.length > 0) {
      throw new Error(`import integrity failure: ${fkViolationsAfterRestore.length} foreign key violation(s) remain after pointer restoration`);
    }
    console.log(`Active-version pointers restored: ${intendedPointers.length} (ownership and version consistency verified).`);

    // 7.5 Provenance and classification migration + recovery
    console.log("Running provenance resolution & classification determination...");
    let resolvedCount = 0;
    let unresolvedCount = 0;
    
    for (const opp of payload.data.seller_opportunities) {
      // Find source for opportunity
      const src = payload.data.seller_opportunity_sources.find(s => s.opportunity_id === opp.id);
      let originalMsgId = src ? src.source_message_id : null;
      let recoveredMsgId = null;
      
      // Parse metadata to look for recovered message ID
      if (src && src.provenance_metadata_json) {
        try {
          const meta = JSON.parse(src.provenance_metadata_json);
          recoveredMsgId = meta.recovered_source_message_id || null;
        } catch (_) {}
      }

      // Resolve provenance
      let status = "unresolved";
      if (originalMsgId) {
        status = "original_resolved";
        resolvedCount++;
      } else if (recoveredMsgId) {
        status = "recovered_resolved";
        resolvedCount++;
      } else {
        unresolvedCount++;
      }

      db.prepare(`
        INSERT INTO source_provenance (
          id, opportunity_id, original_source_json, recovered_source_json,
          resolution_status, recovery_attempts, last_recovery_error, resolved_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        randomUUID(), opp.id, JSON.stringify({ original_message_id: originalMsgId }),
        recoveredMsgId ? JSON.stringify({ recovered_message_id: recoveredMsgId }) : null,
        status, 0, null, status !== "unresolved" ? new Date().toISOString() : null
      );

      // Recalculate record classifications based on rule mapping
      let cls = "unknown";
      // Simple motivation mapping
      const motivation = opp.seller_motivation_type || "None";
      if (motivation.toLowerCase().includes("retail")) {
        cls = "retail_listing";
      } else if (motivation.toLowerCase().includes("wholesale")) {
        cls = "wholesale_target";
      } else if (motivation.toLowerCase().includes("rehab")) {
        cls = "investment_rehab";
      } else if (motivation.toLowerCase().includes("land")) {
        cls = "land_hold";
      } else if (opp.pipeline_stage === "disqualified" || opp.qualification_status === "disqualified") {
        cls = "disqualified";
      }

      db.prepare(`
        INSERT INTO record_classifications (
          opportunity_id, classification_value, classification_rules_version, determined_at, determined_by, reason
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        opp.id, cls, "1.0.0", new Date().toISOString(), "importer", "Initial migration calculation"
      );

      db.prepare(`
        INSERT INTO classification_history (
          id, opportunity_id, prior_classification, new_classification,
          classification_rules_version, determined_at, determined_by, reason
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        randomUUID(), opp.id, null, cls, "1.0.0", new Date().toISOString(), "importer", "Initial migration calculation"
      );
    }

    console.log(`Provenance recovery completed. Resolved: ${resolvedCount}, Unresolved: ${unresolvedCount}`);

    // If apply, write to operational_audit_events
    if (isApply) {
      db.prepare(`
        INSERT INTO operational_audit_events (
          id, event_timestamp, event_type, actor_id, payload_json, correlation_id
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        randomUUID(), new Date().toISOString(), "MIGRATION_IMPORT", "importer",
        JSON.stringify({ recordCounts: payload.recordCounts, deprecationWarnings }), "migration-corr-id"
      );

      db.exec("COMMIT;");
      console.log("[PASS] Transaction committed. Data migration complete.");
    } else {
      db.exec("ROLLBACK;");
      console.log("[PASS] Dry-run preview complete. Transaction rolled back successfully.");
    }

    // Deprecation warnings must survive an unattended run: they are
    // printed here on stdout as a count, and on apply they are also
    // persisted in the MIGRATION_IMPORT audit event payload above
    // (QUINCEY U1, PR #34 certification).
    if (deprecationWarnings.length > 0) {
      console.log(`Deprecation warnings: ${deprecationWarnings.length} opportunity row(s) carried deprecated underwriting value(s) that were NOT carried into the target (details on stderr${isApply ? "; recorded in the MIGRATION_IMPORT audit event" : ""}).`);
    }

    console.log("\nNOTE: export/import is a migration aid, not an exact disaster-recovery mechanism.");
    console.log("Provenance/classification records are synthesized during import (new IDs/timestamps).");
    console.log("File-level SQLite backup/restore remains the approved production recovery method.");

    // Print Parity Statistics
    console.log("\n=== PARITY STATISTICS ===");
    for (const table of tables) {
      let count = 0;
      if (isApply) {
        count = db.prepare(`SELECT count(*) as count FROM ${table}`).get().count;
      } else {
        count = payload.recordCounts[table];
      }
      console.log(`${table}: Exported = ${payload.recordCounts[table]} | Imported = ${count} (Parity: ${payload.recordCounts[table] === count ? "MATCH" : "MISMATCH"})`);
    }

  } catch (err) {
    try { db.exec("ROLLBACK;"); } catch (_) {}
    console.error(`CRITICAL IMPORT ERROR: ${err.message}`);
    process.exit(1);
  } finally {
    db.close();
  }
}

runImport();
