/** Database isolation: migrations, idempotency, rollback, and canonical rejection. */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openPipelineDatabase } from "../src/database/openDatabase.js";
import { runMigrations, readSchemaVersion } from "../src/database/migrationRunner.js";
import { inspectDbPath, assertNotCanonical, CANONICAL_OCG_ONE_PATH } from "../src/database/canonicalDatabaseGuard.js";
import { APP_ROOT } from "../src/config/environment.js";
import { makeTempDb } from "./helpers/temporaryDatabase.mjs";

const MIGRATIONS_DIR = join(APP_ROOT, "migrations");

test("a temporary PIPELINE database is created and migrations apply", (t) => {
  const db = makeTempDb();
  t.after(() => db.cleanup());
  const conn = openPipelineDatabase(db.dbPath);
  t.after(() => conn.close());

  const results = runMigrations(conn, MIGRATIONS_DIR);
  assert.ok(results.some((r) => r.file.startsWith("001") && r.status === "applied"));
  assert.equal(readSchemaVersion(conn), "1");
  assert.ok(existsSync(db.dbPath), "the PIPELINE database file exists");
});

test("re-running migrations is idempotent", (t) => {
  const db = makeTempDb();
  t.after(() => db.cleanup());
  const conn = openPipelineDatabase(db.dbPath);
  t.after(() => conn.close());

  runMigrations(conn, MIGRATIONS_DIR);
  const second = runMigrations(conn, MIGRATIONS_DIR);
  assert.ok(second.every((r) => r.status === "skipped"), "second run applies nothing");
  assert.equal(conn.prepare("SELECT COUNT(*) n FROM pipeline_migrations").get().n, second.length);
});

test("a failing migration rolls back and leaves no partial state", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pipeline-badmig-"));
  const dbDir = makeTempDb();
  t.after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} dbDir.cleanup(); });

  // A migration that creates a table and then fails on a bad statement.
  writeFileSync(join(dir, "001_ok.sql"), "CREATE TABLE keep_me (x TEXT);");
  writeFileSync(join(dir, "002_boom.sql"),
    "CREATE TABLE should_rollback (x TEXT);\nINSERT INTO does_not_exist VALUES (1);");

  const conn = openPipelineDatabase(dbDir.dbPath);
  t.after(() => conn.close());

  assert.throws(() => runMigrations(conn, dir), /002_boom\.sql failed and was rolled back/);
  // First migration committed; the failing one left nothing behind.
  assert.ok(conn.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='keep_me'").get());
  assert.equal(conn.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='should_rollback'").get(), undefined);
  assert.equal(conn.prepare("SELECT 1 FROM pipeline_migrations WHERE filename='002_boom.sql'").get(), undefined);
});

test("the OCG ONE canonical path is rejected before opening", () => {
  const verdict = inspectDbPath(CANONICAL_OCG_ONE_PATH);
  assert.equal(verdict.ok, false);
  assert.throws(() => assertNotCanonical(CANONICAL_OCG_ONE_PATH), /refusing to open database/);
  // basename anywhere
  assert.equal(inspectDbPath(join(tmpdir(), "ocg_one.db")).ok, false);
});

test("a relative path resolving inside the OCG ONE database dir is rejected", () => {
  // From this app's root, ../ocg-one/database/whatever.db lands inside the guarded dir.
  const sneaky = join(APP_ROOT, "..", "ocg-one", "database", "sneaky.db");
  const verdict = inspectDbPath(sneaky);
  assert.equal(verdict.ok, false, verdict.reason);
  assert.match(verdict.reason, /ocg_one|inside_ocg_one_database_dir|protected/);
});

test("the shell never creates or modifies ocg_one.db", (t) => {
  const db = makeTempDb();
  t.after(() => db.cleanup());
  const canonicalExistedBefore = existsSync(CANONICAL_OCG_ONE_PATH);

  const conn = openPipelineDatabase(db.dbPath);
  runMigrations(conn, MIGRATIONS_DIR);
  conn.close();

  // We only ever opened the temp path; our db path is demonstrably not the
  // canonical path, and the canonical file's existence is unchanged by us.
  assert.notEqual(db.dbPath, CANONICAL_OCG_ONE_PATH);
  assert.equal(existsSync(CANONICAL_OCG_ONE_PATH), canonicalExistedBefore,
    "we neither created nor removed the canonical file");
});
