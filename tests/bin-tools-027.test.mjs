import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openPipelineDatabase } from "../src/database/openDatabase.js";
import { runMigrations } from "../src/database/migrationRunner.js";

const REPO = new URL("..", import.meta.url).pathname;
const MIGRATIONS_DIR = join(REPO, "migrations");

function scratchDb(name, { withVersion = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pipeline-bintools-"));
  const path = join(dir, name);
  const db = openPipelineDatabase(path);
  runMigrations(db, MIGRATIONS_DIR);
  if (withVersion) {
    db.prepare(`INSERT INTO seller_opportunities (id, opportunity_code, ocg_one_property_id, created_by, pipeline_stage) VALUES ('oppT', 'OPP-T', 'prop-T', 'qa', 'property_review')`).run();
    db.prepare(`INSERT INTO opportunity_underwriting_refs (id, opportunity_id, source_system, analysis_status, arv, analyzed_at) VALUES ('refT', 'oppT', 'deal-scout', 'insufficient_evidence', NULL, '2026-03-03T00:00:00Z')`).run();
    db.prepare(`INSERT INTO seller_offers (id, opportunity_id, current_version, status, created_by) VALUES ('offT', 'oppT', 1, 'draft', 'qa')`).run();
    db.prepare(`INSERT INTO seller_offer_versions (id, offer_id, version_number, version_status, strategy_type, purchase_price, earnest_money, inspection_days, closing_days, contingencies_json, underwriting_source_type, underwriting_source_id, underwriting_version_id, underwriting_arv_snapshot, underwriting_rehab_snapshot, underwriting_mao_snapshot, underwriting_timestamp, created_by)
                VALUES ('verT', 'offT', 1, 'rejected', 'cash_purchase', 100000, 1000, 7, 30, '[]', 'victor_analysis', 'unknown', '2.0', 0, 0, 0, '2026-03-03T00:00:00Z', 'qa')`).run();
  }
  db.close();
  return { dir, path };
}

test("UA-027-3: remediation CLI refuses a malformed database cleanly and writes nothing", () => {
  const { path } = scratchDb("malformed.db");
  const db = new DatabaseSync(path);
  db.exec(`DROP TABLE opportunity_underwriting_refs`);
  db.close();
  const before = readFileSync(path);
  const res = spawnSync("node", [join(REPO, "src/bin/pipeline-remediate-027.js"), path, "--apply"], { encoding: "utf8" });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /^remediation refused: required table missing: opportunity_underwriting_refs$/m);
  assert.doesNotMatch(res.stderr, /\n\s+at\s/, "no stack trace");
  assert.deepEqual(readFileSync(path), before, "database file untouched");
});

test("UA-027-3: remediation CLI refuses a pre-027 database cleanly", () => {
  const dir = mkdtempSync(join(tmpdir(), "pipeline-pre027-cli-"));
  const path = join(dir, "old.db");
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE seller_offer_versions (id TEXT); CREATE TABLE seller_offers (id TEXT); CREATE TABLE opportunity_underwriting_refs (id TEXT);`);
  db.close();
  const res = spawnSync("node", [join(REPO, "src/bin/pipeline-remediate-027.js"), path], { encoding: "utf8" });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /remediation refused: database has not been migrated to 027/);
});

test("UA-027-1: export CLI runs with explicit paths and the payload round-trips through import", () => {
  const { dir, path } = scratchDb("source.db");
  const snapshot = join(dir, "snapshot.db");
  const json = join(dir, "export.json");
  const out = execFileSync("node", [join(REPO, "src/bin/pipeline-export.js"), path, snapshot, json], { encoding: "utf8" });
  assert.match(out, /EXPORT COMPLETE|Export payload written/);
  assert.ok(existsSync(json));
  const payload = JSON.parse(readFileSync(json, "utf8"));
  assert.equal(payload.data.opportunity_underwriting_refs.length, 1);
  assert.equal(payload.data.seller_offer_versions.length, 1);
  assert.ok(payload.checksums.seller_offer_versions);
  // Import into a fresh migrated DB; the version and its ref must land.
  const target = join(dir, "target.db");
  const tdb = openPipelineDatabase(target);
  runMigrations(tdb, MIGRATIONS_DIR);
  tdb.close();
  execFileSync("node", [join(REPO, "src/bin/pipeline-import.js"), "apply", json, target], { encoding: "utf8" });
  const check = new DatabaseSync(target);
  assert.equal(check.prepare(`SELECT COUNT(*) n FROM opportunity_underwriting_refs`).get().n, 1);
  assert.equal(check.prepare(`SELECT COUNT(*) n FROM seller_offer_versions`).get().n, 1);
  check.close();
});
