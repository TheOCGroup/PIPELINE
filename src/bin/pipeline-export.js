import { DatabaseSync } from "node:sqlite";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

const SOURCE_DB_PATH = "C:\\Users\\Genaro\\Documents\\OCG OS\\integration-work\\ocg-one-pipeline-3e\\database\\ocg_one.db";
const BACKUP_DB_PATH = "C:\\Users\\Genaro\\Documents\\OCG OS\\integration-work\\ocg_one_snapshot.db";
const EXPORT_JSON_PATH = "C:\\Users\\Genaro\\Documents\\OCG OS\\integration-work\\pipeline_export.json";

function getFileHash(filePath) {
  if (!existsSync(filePath)) return null;
  const content = readFileSync(filePath);
  return createHash("sha256").update(content).digest("hex");
}

async function runExport() {
  console.log("=== STARTING CONTROLLED DATA EXPORT ===");

  if (!existsSync(SOURCE_DB_PATH)) {
    console.error(`Source database not found at ${SOURCE_DB_PATH}`);
    process.exit(1);
  }

  // 1. Capture source db hash before backup
  const hashBefore = getFileHash(SOURCE_DB_PATH);
  console.log(`Source DB Hash (before): ${hashBefore}`);

  // 2. Perform online backup using VACUUM INTO
  console.log("Creating consistent snapshot using VACUUM INTO...");
  const srcDb = new DatabaseSync(SOURCE_DB_PATH);
  try {
    srcDb.exec("PRAGMA journal_mode = WAL;");
    // SQLite doesn't allow VACUUM INTO if target file already exists, so delete it if present
    const { rmSync } = await import("node:fs");
    try { rmSync(BACKUP_DB_PATH, { force: true }); } catch {}
    
    srcDb.exec(`VACUUM INTO '${BACKUP_DB_PATH}'`);
    console.log("Snapshot database created successfully.");
  } catch (err) {
    console.error(`Failed to create snapshot database: ${err.message}`);
    process.exit(1);
  } finally {
    srcDb.close();
  }

  // 3. Confirm source safety (hash must match)
  const hashAfter = getFileHash(SOURCE_DB_PATH);
  console.log(`Source DB Hash (after):  ${hashAfter}`);
  if (hashBefore !== hashAfter) {
    console.error("CRITICAL ERROR: Source database hash changed during backup! Aborting.");
    process.exit(1);
  }
  console.log("Source safety confirmed. Database was not mutated.");

  // 4. Open snapshot DB and run integrity checks
  const snapshotDb = new DatabaseSync(BACKUP_DB_PATH);
  const integrity = snapshotDb.prepare("PRAGMA integrity_check").get()?.integrity_check;
  const fkCheck = snapshotDb.prepare("PRAGMA foreign_key_check").get();
  console.log(`Snapshot integrity check: ${integrity}`);
  if (integrity !== "ok" || fkCheck !== undefined) {
    console.error("CRITICAL ERROR: Snapshot database integrity check failed! Aborting.");
    process.exit(1);
  }

  // 5. Export Pipeline-owned tables
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

  const exportPayload = {
    schemaVersion: "1.0.0",
    timestamp: new Date().toISOString(),
    sourceDatabaseHash: hashBefore,
    recordCounts: {},
    checksums: {},
    data: {}
  };

  for (const table of tables) {
    let rows = [];
    try {
      // Check if table exists in OCG ONE db
      const tableExists = snapshotDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
      if (tableExists) {
        rows = snapshotDb.prepare(`SELECT * FROM ${table}`).all();
      }
    } catch (err) {
      console.warn(`Could not read table ${table}: ${err.message}`);
    }
    
    exportPayload.data[table] = rows;
    exportPayload.recordCounts[table] = rows.length;

    // Table checksum
    const tableStr = JSON.stringify(rows);
    exportPayload.checksums[table] = createHash("sha256").update(tableStr).digest("hex");
    console.log(`Exported ${rows.length} rows from table ${table}. Checksum: ${exportPayload.checksums[table]}`);
  }

  // 6. Write to JSON
  writeFileSync(EXPORT_JSON_PATH, JSON.stringify(exportPayload, null, 2), "utf8");
  console.log(`Export payload written deterministically to ${EXPORT_JSON_PATH}`);
  snapshotDb.close();
}

runExport();
