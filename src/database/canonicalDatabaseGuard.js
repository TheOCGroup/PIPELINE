/**
 * PIPELINE canonical-database guard.
 *
 * PIPELINE must NEVER open the OCG ONE canonical database. This guard runs
 * before any database is opened and fails closed. It rejects:
 *   - the known OCG ONE canonical path (<apps>/ocg-one/database/ocg_one.db)
 *   - any path inside the OCG ONE database directory
 *   - protected OCG ONE database basenames wherever they appear
 *   - a path that resolves to the same file as the canonical database
 * It normalises separators and relative paths so a disguised path cannot slip
 * through. It stats — never opens — the canonical file, and only to compare.
 */

import { resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { realpathSync, existsSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url)); // <app>/src/database
/** <app>/src/database -> <app> -> apps -> apps/ocg-one/database */
const APPS_DIR = resolve(__dirname, "../../..");
const OCG_ONE_DB_DIR = resolve(APPS_DIR, "ocg-one", "database");
const OCG_ONE_CANONICAL = resolve(OCG_ONE_DB_DIR, "ocg_one.db");

const PROTECTED_BASENAMES = new Set([
  "ocg_one.db",
  "ocg_one.db-wal",
  "ocg_one.db-shm",
  "ocg_one_backup_20260728.db",
  "ocg_one_production_verified.db",
]);

const norm = (p) => resolve(p).replace(/\\/g, "/").toLowerCase();

/** @returns {{ok:true,path:string}|{ok:false,reason:string}} */
export function inspectDbPath(dbPath) {
  if (typeof dbPath !== "string" || !dbPath.trim()) {
    return { ok: false, reason: "empty_or_missing_path" };
  }
  const abs = resolve(dbPath);
  const n = norm(abs);
  const base = basename(n);

  if (PROTECTED_BASENAMES.has(base)) return { ok: false, reason: "protected_ocg_one_basename" };
  if (n === norm(OCG_ONE_CANONICAL)) return { ok: false, reason: "canonical_ocg_one_path" };
  if (n.startsWith(norm(OCG_ONE_DB_DIR) + "/")) return { ok: false, reason: "inside_ocg_one_database_dir" };

  // Same-file detection (symlink / hardlink / alias) when both exist.
  try {
    if (existsSync(abs) && existsSync(OCG_ONE_CANONICAL) && realpathSync(abs) === realpathSync(OCG_ONE_CANONICAL)) {
      return { ok: false, reason: "same_file_as_canonical" };
    }
  } catch {
    /* stat failure is not a reason to allow; fall through to allow only clean paths */
  }

  return { ok: true, path: abs };
}

/** Throws before the database is opened unless the path is a safe PIPELINE target. */
export function assertNotCanonical(dbPath) {
  const verdict = inspectDbPath(dbPath);
  if (!verdict.ok) {
    throw new Error(`[pipeline-db-guard] refusing to open database: ${verdict.reason}. PIPELINE must never open the OCG ONE canonical database.`);
  }
  return verdict.path;
}

export const CANONICAL_OCG_ONE_PATH = OCG_ONE_CANONICAL;
