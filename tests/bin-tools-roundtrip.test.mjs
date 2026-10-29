import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openPipelineDatabase } from "../src/database/openDatabase.js";
import { runMigrations } from "../src/database/migrationRunner.js";

// Regression battery for F-027-EXPORT (source mutation via journal-mode
// flip) and F-027-IMPORT (offers imported with active_version_id before
// their versions exist; opportunity-level underwriting columns dropped).
// Fixtures mirror the production shape: offers whose active_version_id
// is populated, protected approved/pending_approval versions, explicit
// underwriting_ref_id links (incl. a NULL-snapshot version), and refs.

const REPO = new URL("..", import.meta.url).pathname;
const MIGRATIONS_DIR = join(REPO, "migrations");
const EXPORT_CLI = join(REPO, "src/bin/pipeline-export.js");
const IMPORT_CLI = join(REPO, "src/bin/pipeline-import.js");

const EXPORT_TABLES = [
  "seller_opportunities",
  "seller_opportunity_participants",
  "seller_opportunity_sources",
  "seller_stage_events",
  "seller_appointments",
  "seller_interactions",
  "seller_offers",
  "opportunity_underwriting_refs",
  "seller_offer_versions",
  "seller_offer_approval_links",
  "seller_opportunity_outcomes"
];

const sha256File = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

function migratedDb(path, { wal }) {
  const db = wal ? openPipelineDatabase(path) : new DatabaseSync(path);
  runMigrations(db, MIGRATIONS_DIR);
  return db;
}

function journalMode(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  const mode = db.prepare("PRAGMA journal_mode").get().journal_mode;
  db.close();
  return mode;
}

function seedProductionShape(db) {
  // Opportunity-level underwriting snapshot columns are deprecated by
  // migration 006 (triggers forbid non-NULL writes; production holds
  // NULL there) — the seed mirrors production: only the underwriting
  // SOURCE columns are populated on oppA.
  const opp = db.prepare(`INSERT INTO seller_opportunities (id, opportunity_code, ocg_one_property_id, created_by, pipeline_stage, qualification_status, contact_status, opportunity_status, data_quality_status, asking_price, underwriting_source_type, underwriting_source_id, underwriting_version_id) VALUES (?, ?, ?, 'qa', 'property_review', 'qualified', 'in_contact', 'active', 'verified_owner', ?, ?, ?, ?)`);
  opp.run("oppA", "OPP-A", "prop-A", 100000, "victor_analysis", "srcA", "2.0");
  opp.run("oppB", "OPP-B", "prop-B", 180000, null, null, null);
  opp.run("oppC", "OPP-C", "prop-C", 100000, null, null, null);

  db.prepare(`INSERT INTO seller_opportunity_participants (id, opportunity_id, ocg_one_person_id, participant_role, is_primary, decision_authority_status, ownership_percentage, source_id, verification_status, created_by, created_at) VALUES ('partA', 'oppA', 'person-A', 'primary_owner', 1, 'full_authority', 100, 'srcA', 'verified', 'qa', '2026-09-19T00:20:00Z')`).run();
  const src = db.prepare(`INSERT INTO seller_opportunity_sources (id, opportunity_id, source_type, source_record_id, source_message_id, original_address, source_timestamp, conversion_actor, conversion_timestamp, provenance_metadata_json, created_at) VALUES (?, ?, 'deal_scout_handoff', ?, ?, ?, '2026-09-19T00:19:00Z', 'victor', '2026-09-19T00:19:30Z', ?, '2026-09-19T00:19:30Z')`);
  src.run("srcRowA", "oppA", "rec-A", "msg-A", "1 A St", "{\"recovered_source_message_id\":\"msg-A-r\"}");
  src.run("srcRowB", "oppB", "rec-B", null, "2 B St", null);
  src.run("srcRowC", "oppC", "rec-C", "msg-C", "3 C St", null);
  db.prepare(`INSERT INTO seller_stage_events (id, opportunity_id, prior_stage, new_stage, changed_by, reason, transition_metadata_json, created_at) VALUES ('evtA1', 'oppA', 'new_lead', 'property_review', 'qa', 'seed', '{}', '2026-09-19T00:21:00Z')`).run();
  db.prepare(`INSERT INTO seller_appointments (id, opportunity_id, ocg_one_property_id, starts_at_utc, ends_at_utc, timezone, local_display_start, appointment_type, location, meeting_method, status, confirmation_status, outcome, linked_task_id, created_by, created_at, updated_at) VALUES ('apptA', 'oppA', 'prop-A', '2026-09-21T15:00:00Z', '2026-09-21T16:00:00Z', 'America/Chicago', '2026-09-21 10:00', 'property_walkthrough', '1 A St', 'in_person', 'scheduled', 'pending', null, null, 'qa', '2026-09-19T00:22:00Z', '2026-09-19T00:22:00Z')`).run();
  db.prepare(`INSERT INTO seller_interactions (id, opportunity_id, participant_id, channel, direction, occurred_at, outcome, summary, private_note, source_type, source_record_id, external_message_id, visibility_classification, created_by, created_at) VALUES ('intA', 'oppA', 'partA', 'phone', 'outbound', '2026-09-19T14:00:00Z', 'answered', 'intro call', null, 'manual', null, null, 'internal', 'qa', '2026-09-19T14:05:00Z')`).run();

  const ref = db.prepare(`INSERT INTO opportunity_underwriting_refs (id, opportunity_id, source_system, source_agent, source_version_id, analysis_status, arv, rehab, mao, confidence, limitations, analyzed_at, created_at) VALUES (?, ?, 'deal-scout', 'Victor', '2.0', ?, ?, ?, ?, ?, ?, ?, ?)`);
  ref.run("refA1", "oppA", "completed", 150000, 30000, 69500, 0.9, "[]", "2026-09-19T00:23:53Z", "2026-09-19T00:23:53Z");
  ref.run("refA2", "oppA", "completed", 150000, 30000, 69500, 0.9, "[]", "2026-09-19T00:24:47Z", "2026-09-19T00:24:47Z");
  ref.run("refB1", "oppB", "completed", 200000, 25000, 112000, 0, "[]", "2026-09-20T17:57:43Z", "2026-09-20T17:57:43Z");
  ref.run("refC1", "oppC", "insufficient_evidence", null, null, null, 0, "[\"no comps\"]", "2026-10-25T15:21:03Z", "2026-10-25T15:21:03Z");

  const offer = db.prepare(`INSERT INTO seller_offers (id, opportunity_id, current_version, status, created_by) VALUES (?, ?, ?, ?, 'qa')`);
  offer.run("offA", "oppA", 1, "approved");
  offer.run("offB", "oppB", 5, "pending_approval");
  offer.run("offC", "oppC", 1, "rejected");

  const ver = db.prepare(`INSERT INTO seller_offer_versions (id, offer_id, version_number, version_status, strategy_type, purchase_price, earnest_money, inspection_days, closing_days, contingencies_json, seller_facing_terms, underwriting_source_type, underwriting_source_id, underwriting_version_id, underwriting_ref_id, underwriting_arv_snapshot, underwriting_rehab_snapshot, underwriting_mao_snapshot, underwriting_confidence, underwriting_limitations, underwriting_timestamp, created_by, created_at) VALUES (?, ?, ?, ?, 'cash_purchase', 100000, 1000, 7, 30, '[]', null, 'victor_analysis', 'unknown', '2.0', ?, ?, ?, ?, ?, ?, ?, 'qa', ?)`);
  ver.run("verA1", "offA", 1, "approved", null, 150000, 30000, 69500, 0, "[]", "2026-09-19T00:23:53Z", "2026-09-19T00:23:53Z");
  for (let n = 1; n <= 5; n++) {
    ver.run(`verB${n}`, "offB", n, n === 5 ? "pending_approval" : "draft", n === 1 ? "refB1" : null, 200000, 25000, 112000, 0, "[]", "2026-09-20T17:57:43Z", "2026-09-20T17:57:43Z");
  }
  ver.run("verC1", "offC", 1, "rejected", "refC1", null, null, null, 0, "[\"no comps\"]", "2026-10-25T15:21:03Z", "2026-10-25T15:21:03Z");

  db.prepare(`INSERT INTO seller_offer_approval_links (id, offer_version_id, ocg_one_approval_id, link_status, created_by, created_at) VALUES ('lnkA', 'verA1', 'appr-1', 'linked', 'qa', '2026-09-19T00:25:00Z')`).run();

  // Pointers last — the ownership trigger requires the versions to exist.
  db.prepare(`UPDATE seller_offers SET active_version_id = 'verA1' WHERE id = 'offA'`).run();
  db.prepare(`UPDATE seller_offers SET active_version_id = 'verB5' WHERE id = 'offB'`).run();
  db.prepare(`UPDATE seller_offers SET active_version_id = 'verC1' WHERE id = 'offC'`).run();

  // Outcomes last: their related-version trigger requires the version row to exist.
  db.prepare(`INSERT INTO seller_opportunity_outcomes (id, opportunity_id, outcome_type, reason, effective_at, actor_id, related_offer_version_id, reopen_eligibility, created_at) VALUES ('outC', 'oppC', 'seller_declined', 'committee kill', '2026-10-25T15:22:02Z', 'qa', 'verC1', 'eligible_with_approval', '2026-10-25T15:22:02Z')`).run();
}

function buildSource({ wal }) {
  const dir = mkdtempSync(join(tmpdir(), "pipeline-roundtrip-"));
  const path = join(dir, "source.db");
  const db = migratedDb(path, { wal });
  seedProductionShape(db);
  if (wal) db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  db.close();
  return { dir, path };
}

function runExport(sourcePath, dir) {
  const snapshot = join(dir, "snapshot.db");
  const json = join(dir, "export.json");
  const res = spawnSync("node", [EXPORT_CLI, sourcePath, snapshot, json], { encoding: "utf8" });
  return { res, snapshot, json };
}

function runImport(json, target, mode = "apply") {
  return spawnSync("node", [IMPORT_CLI, mode, json, target], { encoding: "utf8" });
}

function freshTarget(dir, name = "target.db") {
  const target = join(dir, name);
  const db = migratedDb(target, { wal: false });
  db.close();
  return target;
}

// updated_at on seller_opportunities and seller_offers is system-owned:
// migration 006 stamp triggers rewrite it on INSERT and on UPDATE, so no
// insert-based import can carry the source value — a round trip
// necessarily restamps it. Those two columns are compared for presence
// (non-null ISO timestamp) rather than equality; every other cell of
// every exported table is compared exactly.
const STAMPED_TABLES = new Set(["seller_opportunities", "seller_offers"]);

function dumpTables(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  const out = {};
  for (const t of EXPORT_TABLES) {
    out[t] = db.prepare(`SELECT * FROM ${t} ORDER BY id`).all();
    if (STAMPED_TABLES.has(t)) {
      for (const row of out[t]) {
        assert.equal(typeof row.updated_at, "string", `${t}.updated_at is stamped`);
        delete row.updated_at;
      }
    }
  }
  db.close();
  return out;
}

function fixChecksum(payload, table) {
  payload.checksums[table] = createHash("sha256").update(JSON.stringify(payload.data[table])).digest("hex");
}

test("F-027-EXPORT: export from a non-WAL source leaves the source byte-identical", () => {
  const { dir, path } = buildSource({ wal: false });
  assert.equal(journalMode(path), "delete");
  const before = sha256File(path);
  const { res, json } = runExport(path, dir);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /was not mutated/);
  assert.equal(sha256File(path), before, "source file bytes unchanged");
  assert.equal(journalMode(path), "delete", "journal mode unchanged");
  const payload = JSON.parse(readFileSync(json, "utf8"));
  assert.equal(payload.recordCounts.seller_offer_versions, 7);
  assert.equal(payload.recordCounts.seller_offers, 3);
  assert.equal(payload.recordCounts.opportunity_underwriting_refs, 4);
});

test("F-027-EXPORT: export from a WAL source leaves the source byte-identical", () => {
  const { dir, path } = buildSource({ wal: true });
  assert.equal(journalMode(path), "wal");
  const before = sha256File(path);
  const { res, json } = runExport(path, dir);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(sha256File(path), before, "source file bytes unchanged");
  assert.equal(journalMode(path), "wal", "journal mode unchanged");
  const payload = JSON.parse(readFileSync(json, "utf8"));
  assert.equal(payload.recordCounts.seller_offer_versions, 7);
});

test("F-027: production-shaped round trip preserves every exported cell (WAL source)", () => {
  const { dir, path } = buildSource({ wal: true });
  const { res, json } = runExport(path, dir);
  assert.equal(res.status, 0, res.stderr);
  const target = freshTarget(dir);
  const imp = runImport(json, target);
  assert.equal(imp.status, 0, imp.stdout + imp.stderr);
  assert.match(imp.stdout, /Active-version pointers restored: 3/);
  assert.deepEqual(dumpTables(target), dumpTables(path), "all 11 exported tables cell-identical after round trip");

  const db = new DatabaseSync(target, { readOnly: true });
  assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);
  const verC1 = db.prepare("SELECT underwriting_arv_snapshot, underwriting_ref_id FROM seller_offer_versions WHERE id = 'verC1'").get();
  assert.equal(verC1.underwriting_arv_snapshot, null, "NULL snapshot preserved as NULL");
  assert.equal(verC1.underwriting_ref_id, "refC1", "explicit ref link preserved");
  const verA1 = db.prepare("SELECT underwriting_ref_id FROM seller_offer_versions WHERE id = 'verA1'").get();
  assert.equal(verA1.underwriting_ref_id, null, "protected approved version remains unlinked");
  db.close();
});

test("F-027: production-shaped round trip works from a non-WAL source", () => {
  const { dir, path } = buildSource({ wal: false });
  const { res, json } = runExport(path, dir);
  assert.equal(res.status, 0, res.stderr);
  const target = freshTarget(dir);
  const imp = runImport(json, target);
  assert.equal(imp.status, 0, imp.stdout + imp.stderr);
  const db = new DatabaseSync(target, { readOnly: true });
  const offers = db.prepare("SELECT id, active_version_id FROM seller_offers ORDER BY id").all();
  assert.deepEqual(offers.map(o => [o.id, o.active_version_id]), [["offA", "verA1"], ["offB", "verB5"], ["offC", "verC1"]]);
  db.close();
});

test("F-027-IMPORT: fails closed when a declared active version is missing from the payload", () => {
  const { dir, path } = buildSource({ wal: true });
  const { json } = runExport(path, dir);
  const payload = JSON.parse(readFileSync(json, "utf8"));
  payload.data.seller_offer_versions = payload.data.seller_offer_versions.filter(v => v.id !== "verB5");
  payload.recordCounts.seller_offer_versions = payload.data.seller_offer_versions.length;
  fixChecksum(payload, "seller_offer_versions");
  const bad = join(dir, "bad.json");
  writeFileSync(bad, JSON.stringify(payload, null, 2));
  const target = freshTarget(dir);
  const imp = runImport(bad, target);
  assert.notEqual(imp.status, 0);
  assert.match(imp.stdout + imp.stderr, /import integrity failure: active version verB5 .* missing/);
  const dump = dumpTables(target);
  for (const t of EXPORT_TABLES) assert.equal(dump[t].length, 0, `${t} empty after atomic rollback`);
});

test("F-027-IMPORT: fails closed when the active version belongs to a different offer", () => {
  const { dir, path } = buildSource({ wal: true });
  const { json } = runExport(path, dir);
  const payload = JSON.parse(readFileSync(json, "utf8"));
  payload.data.seller_offers.find(o => o.id === "offA").active_version_id = "verB5";
  fixChecksum(payload, "seller_offers");
  const bad = join(dir, "bad.json");
  writeFileSync(bad, JSON.stringify(payload, null, 2));
  const target = freshTarget(dir);
  const imp = runImport(bad, target);
  assert.notEqual(imp.status, 0);
  assert.match(imp.stdout + imp.stderr, /belongs to offer offB, not offA/);
  assert.equal(dumpTables(target).seller_offers.length, 0);
});

test("F-027-IMPORT: fails closed when current_version disagrees with the active version number", () => {
  const { dir, path } = buildSource({ wal: true });
  const { json } = runExport(path, dir);
  const payload = JSON.parse(readFileSync(json, "utf8"));
  payload.data.seller_offers.find(o => o.id === "offB").current_version = 4;
  fixChecksum(payload, "seller_offers");
  const bad = join(dir, "bad.json");
  writeFileSync(bad, JSON.stringify(payload, null, 2));
  const target = freshTarget(dir);
  const imp = runImport(bad, target);
  assert.notEqual(imp.status, 0);
  assert.match(imp.stdout + imp.stderr, /declares current_version 4 but its active version verB5 has version_number 5/);
  assert.equal(dumpTables(target).seller_offers.length, 0);
});

test("F-027-IMPORT: preview writes nothing; a second apply fails closed and changes nothing", () => {
  const { dir, path } = buildSource({ wal: true });
  const { json } = runExport(path, dir);
  const target = freshTarget(dir);
  const preview = runImport(json, target, "preview");
  assert.equal(preview.status, 0, preview.stdout + preview.stderr);
  assert.equal(dumpTables(target).seller_offers.length, 0, "preview left the target empty");

  const first = runImport(json, target);
  assert.equal(first.status, 0, first.stdout + first.stderr);
  const afterFirst = dumpTables(target);

  const second = runImport(json, target);
  assert.notEqual(second.status, 0, "duplicate import must fail");
  assert.deepEqual(dumpTables(target), afterFirst, "failed second import rolled back atomically");
});

test("F-027-IMPORT: ownership trigger still enforced on the imported database", () => {
  const { dir, path } = buildSource({ wal: true });
  const { json } = runExport(path, dir);
  const target = freshTarget(dir);
  assert.equal(runImport(json, target).status, 0);
  const db = new DatabaseSync(target);
  assert.throws(
    () => db.prepare(`UPDATE seller_offers SET active_version_id = 'verB1' WHERE id = 'offA'`).run(),
    /Active offer version must belong to the exact seller offer/
  );
  db.close();
});

test("F-027-IMPORT-2: deprecated opportunity-level values warn explicitly and are not carried", () => {
  const { dir, path } = buildSource({ wal: true });
  const { json } = runExport(path, dir);
  const payload = JSON.parse(readFileSync(json, "utf8"));
  payload.data.seller_opportunities.find(o => o.id === "oppA").underwriting_arv_snapshot = 150000;
  fixChecksum(payload, "seller_opportunities");
  const legacy = join(dir, "legacy.json");
  writeFileSync(legacy, JSON.stringify(payload, null, 2));
  const target = freshTarget(dir);
  const imp = runImport(legacy, target);
  assert.equal(imp.status, 0, imp.stdout + imp.stderr);
  assert.match(imp.stderr, /WARNING: opportunity oppA carries value\(s\) in deprecated opportunity-level underwriting column\(s\) \[underwriting_arv_snapshot\]/);
  const db = new DatabaseSync(target, { readOnly: true });
  assert.equal(db.prepare("SELECT underwriting_arv_snapshot FROM seller_opportunities WHERE id = 'oppA'").get().underwriting_arv_snapshot, null);
  assert.equal(db.prepare("SELECT underwriting_source_id FROM seller_opportunities WHERE id = 'oppA'").get().underwriting_source_id, "srcA", "unguarded source columns ARE carried");
  assert.equal(db.prepare("SELECT COUNT(*) c FROM seller_offer_versions").get().c, 7, "rest of the import unaffected");
  db.close();
});

test("F-027-IMPORT-2/U1: deprecation warnings are persisted in the MIGRATION_IMPORT audit event", () => {
  const { dir, path } = buildSource({ wal: true });
  const { json } = runExport(path, dir);
  const payload = JSON.parse(readFileSync(json, "utf8"));
  payload.data.seller_opportunities.find(o => o.id === "oppA").underwriting_arv_snapshot = 150000;
  payload.data.seller_opportunities.find(o => o.id === "oppB").underwriting_mao_snapshot = 42000;
  fixChecksum(payload, "seller_opportunities");
  const legacy = join(dir, "legacy2.json");
  writeFileSync(legacy, JSON.stringify(payload, null, 2));
  const target = freshTarget(dir);
  const imp = runImport(legacy, target);
  assert.equal(imp.status, 0, imp.stdout + imp.stderr);
  assert.match(imp.stdout, /Deprecation warnings: 2 opportunity row\(s\) carried deprecated underwriting value\(s\) that were NOT carried/);
  assert.match(imp.stdout, /recorded in the MIGRATION_IMPORT audit event/);
  const db = new DatabaseSync(target, { readOnly: true });
  const evt = db.prepare("SELECT payload_json FROM operational_audit_events WHERE event_type = 'MIGRATION_IMPORT'").get();
  assert.ok(evt, "audit event exists");
  const recorded = JSON.parse(evt.payload_json).deprecationWarnings;
  assert.deepEqual(recorded, [
    { opportunityId: "oppA", columns: ["underwriting_arv_snapshot"] },
    { opportunityId: "oppB", columns: ["underwriting_mao_snapshot"] }
  ]);
  db.close();

  // A clean payload records an explicit empty warning list.
  const target2 = freshTarget(dir, "target2.db");
  const imp2 = runImport(json, target2);
  assert.equal(imp2.status, 0, imp2.stdout + imp2.stderr);
  assert.doesNotMatch(imp2.stdout, /Deprecation warnings: [1-9]/);
  const db2 = new DatabaseSync(target2, { readOnly: true });
  const evt2 = db2.prepare("SELECT payload_json FROM operational_audit_events WHERE event_type = 'MIGRATION_IMPORT'").get();
  assert.deepEqual(JSON.parse(evt2.payload_json).deprecationWarnings, []);
  db2.close();
});

test("schema governance: migration 006 forbids direct writes to deprecated opportunity underwriting columns", () => {
  const dir = mkdtempSync(join(tmpdir(), "pipeline-gov-"));
  const db = migratedDb(join(dir, "gov.db"), { wal: false });
  assert.throws(
    () => db.prepare(`INSERT INTO seller_opportunities (id, opportunity_code, created_by, underwriting_arv_snapshot) VALUES ('oppX', 'OPP-X', 'qa', 1)`).run(),
    /Direct writes to seller_opportunities underwriting fields are deprecated/
  );
  db.close();
});

test("F-027-IMPORT: refuses a nonexistent target without creating a file", () => {
  const { dir, path } = buildSource({ wal: true });
  const { json } = runExport(path, dir);
  const missing = join(dir, "does-not-exist.db");
  const imp = runImport(json, missing);
  assert.equal(imp.status, 1);
  assert.match(imp.stderr, /import refused: target database not found/);
  assert.equal(existsSync(missing), false, "no empty file created by the refusal");
});
