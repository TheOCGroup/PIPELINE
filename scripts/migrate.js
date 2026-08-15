/**
 * Applies PIPELINE migrations to the configured PIPELINE database only.
 * The canonical guard (invoked by openPipelineDatabase) rejects the OCG ONE
 * database before anything is opened. Prints a JSON summary.
 */

import { loadConfig } from "../src/config/environment.js";
import { openPipelineDatabase } from "../src/database/openDatabase.js";
import { runMigrations, readSchemaVersion } from "../src/database/migrationRunner.js";
import { join } from "node:path";
import { APP_ROOT } from "../src/config/environment.js";

const config = loadConfig();
const db = openPipelineDatabase(config.dbPath);
try {
  const results = runMigrations(db, join(APP_ROOT, "migrations"));
  console.log(JSON.stringify({ ok: true, dbPath: config.dbPath, schemaVersion: readSchemaVersion(db), results }, null, 2));
} finally {
  db.close();
}
