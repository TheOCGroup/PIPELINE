/**
 * PIPELINE migration runner — isolated, deterministic, idempotent, rollback-safe.
 *
 * Applies every *.sql in the migrations directory in filename order, records each
 * in `pipeline_migrations`, never reapplies a completed migration, wraps each
 * migration in a transaction, and rolls back on failure. It operates only on the
 * database handle it is given (which the caller obtained through the guard).
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const TRACKING_DDL = `
  CREATE TABLE IF NOT EXISTS pipeline_migrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    filename TEXT UNIQUE NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
  );`;

export function runMigrations(db, migrationsDir) {
  db.exec(TRACKING_DDL);

  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const applied = new Set(
    db.prepare("SELECT filename FROM pipeline_migrations").all().map((r) => r.filename)
  );

  const results = [];
  for (const file of files) {
    if (applied.has(file)) {
      results.push({ file, status: "skipped" });
      continue;
    }
    const sql = readFileSync(join(migrationsDir, file), "utf8");
    db.exec("BEGIN");
    try {
      db.exec(sql);
      db.prepare("INSERT INTO pipeline_migrations (filename) VALUES (?)").run(file);
      db.exec("COMMIT");
      results.push({ file, status: "applied" });
    } catch (err) {
      try { db.exec("ROLLBACK"); } catch { /* nothing to roll back */ }
      throw new Error(`migration ${file} failed and was rolled back: ${err.message}`);
    }
  }
  return results;
}

/** Reads the recorded schema version (set by migration 001), or null. */
export function readSchemaVersion(db) {
  try {
    return db.prepare("SELECT value FROM pipeline_application_metadata WHERE key = 'schema_version'").get()?.value ?? null;
  } catch {
    return null;
  }
}
