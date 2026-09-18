/**
 * PIPELINE migration runner — isolated, deterministic, idempotent, rollback-safe.
 *
 * Applies every *.sql in the migrations directory in filename order, records each
 * in `pipeline_migrations`, never reapplies a completed migration, wraps each
 * migration in a transaction, and rolls back on failure. It operates only on the
 * database handle it is given (which the caller obtained through the guard).
 *
 * Transaction opt-out: a migration whose first meaningful line is the comment
 * `-- pipeline:migration-no-transaction` manages its own transaction. This exists
 * for DDL SQLite cannot perform inside the runner's transaction — notably the
 * documented 12-step ALTER TABLE procedure, which requires
 * `PRAGMA foreign_keys=OFF` outside any transaction (the pragma is a no-op
 * inside one). Such migrations MUST issue their own BEGIN/COMMIT and MUST leave
 * `PRAGMA foreign_keys=ON` when done; the runner re-asserts it defensively after
 * every migration.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const TRACKING_DDL = `
  CREATE TABLE IF NOT EXISTS pipeline_migrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    filename TEXT UNIQUE NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
  );`;

const NO_TRANSACTION_MARKER = "pipeline:migration-no-transaction";

/**
 * A migration opts out of the runner's transaction wrapper when its first
 * meaningful line is a comment containing the no-transaction marker.
 */
function managesOwnTransaction(sql) {
  for (const line of String(sql).split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (!trimmed.startsWith("--")) return false;
    return trimmed.includes(NO_TRANSACTION_MARKER);
  }
  return false;
}

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
    const ownTransaction = managesOwnTransaction(sql);
    if (!ownTransaction) db.exec("BEGIN");
    try {
      db.exec(sql);
      db.prepare("INSERT INTO pipeline_migrations (filename) VALUES (?)").run(file);
      if (!ownTransaction) db.exec("COMMIT");
      results.push({ file, status: "applied" });
    } catch (err) {
      try { db.exec("ROLLBACK"); } catch { /* nothing to roll back */ }
      try { db.exec("PRAGMA foreign_keys=ON;"); } catch { /* defensive */ }
      throw new Error(`migration ${file} failed and was rolled back: ${err.message}`);
    }
    try { db.exec("PRAGMA foreign_keys=ON;"); } catch { /* defensive */ }
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
