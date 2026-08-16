#!/usr/bin/env node
/**
 * Timestamped SQLite backup.
 *
 * Uses `VACUUM INTO`, which takes a consistent snapshot of a database that is
 * currently in use — safe to run while PIPELINE is serving. Copying the .db
 * file directly is not safe: it can capture a torn page mid-write and silently
 * miss anything still sitting in the WAL.
 *
 *   node scripts/backup.js              # back up the configured database
 *   node scripts/backup.js --keep 30    # change how many backups are retained
 *   node scripts/backup.js --list       # show what is currently held
 *
 * Backups land in ./backups, which is gitignored. No external dependency and
 * nothing to pay for.
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readdirSync, statSync, unlinkSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BACKUP_DIR = join(APP_ROOT, "backups");
const DEFAULT_KEEP = 14;

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function resolveDbPath() {
  const configured = process.env.PIPELINE_DB_PATH || "./runtime/pipeline.db";
  return resolve(APP_ROOT, configured);
}

function listBackups() {
  if (!existsSync(BACKUP_DIR)) return [];
  return readdirSync(BACKUP_DIR)
    .filter((f) => f.startsWith("pipeline-") && f.endsWith(".db"))
    .map((f) => ({ name: f, path: join(BACKUP_DIR, f), mtime: statSync(join(BACKUP_DIR, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
}

function human(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

if (process.argv.includes("--list")) {
  const all = listBackups();
  if (!all.length) {
    console.log("No backups yet.");
  } else {
    console.log(`${all.length} backup(s) in ${BACKUP_DIR}:`);
    for (const b of all) console.log(`  ${b.name}  ${human(statSync(b.path).size)}`);
  }
  process.exit(0);
}

const dbPath = resolveDbPath();
if (!existsSync(dbPath)) {
  console.error(`No database at ${dbPath}. Start PIPELINE once to create it.`);
  process.exit(1);
}

mkdirSync(BACKUP_DIR, { recursive: true });

const stamp = new Date().toISOString().replace(/[:.]/g, "-").replace("Z", "");
const target = join(BACKUP_DIR, `pipeline-${stamp}.db`);

// Read-only handle: a backup must never be able to modify the source.
const db = new DatabaseSync(dbPath, { readOnly: true });
try {
  db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
} finally {
  db.close();
}

// Verify the snapshot opens and carries the expected schema before trusting it.
const check = new DatabaseSync(target, { readOnly: true });
let opportunities = 0;
try {
  opportunities = check.prepare("SELECT COUNT(*) n FROM seller_opportunities").get().n;
  const tables = check.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type = 'table'").get().n;
  console.log(`Backup written: ${target}`);
  console.log(`  ${human(statSync(target).size)}, ${tables} tables, ${opportunities} opportunities`);
} catch (err) {
  console.error(`Backup verification FAILED — removing ${target}`);
  try { unlinkSync(target); } catch { /* nothing to remove */ }
  process.exitCode = 1;
} finally {
  check.close();
}

// Retention.
const keep = Number(arg("keep", DEFAULT_KEEP));
if (Number.isInteger(keep) && keep > 0) {
  const stale = listBackups().slice(keep);
  for (const b of stale) {
    unlinkSync(b.path);
    console.log(`  pruned ${b.name}`);
  }
  if (stale.length) console.log(`  retained the ${keep} most recent`);
}
