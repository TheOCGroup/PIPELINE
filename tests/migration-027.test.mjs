import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, cpSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTempDb, testConfig } from "./helpers/temporaryDatabase.mjs";
import { createApp } from "../src/app/createApp.js";
import { runMigrations } from "../src/database/migrationRunner.js";
import { resolveSnapshotFigures } from "../src/repositories/sqlite/snapshotResolution.js";
import { planRemediation, applyRemediation } from "../src/bin/pipeline-remediate-027.js";

const MIGRATIONS_DIR = new URL("../migrations", import.meta.url).pathname;

/** A migrations dir containing everything EXCEPT 027 (the pre-027 world). */
function preMigrationsDir() {
  const dir = mkdtempSync(join(tmpdir(), "pipeline-pre027-"));
  for (const f of readdirSync(MIGRATIONS_DIR)) {
    if (f.startsWith("027")) continue;
    cpSync(join(MIGRATIONS_DIR, f), join(dir, f));
  }
  return dir;
}

function seedBasics(db, { oppId, refId, analyzedAt, arv = null, rehab = null, mao = null, confidence = null }) {
  db.prepare(`INSERT INTO seller_opportunities (id, opportunity_code, ocg_one_property_id, created_by, pipeline_stage)
              VALUES (?, ?, ?, 'qa', 'property_review')`).run(oppId, `OPP-${oppId}`, `prop-${oppId}`);
  db.prepare(`INSERT INTO opportunity_underwriting_refs
      (id, opportunity_id, source_system, source_agent, source_project_id, source_underwriting_id, source_version_id,
       analysis_status, arv, rehab, mao, confidence, limitations, evidence_summary_json, analyzed_at)
      VALUES (?, ?, 'deal-scout', 'Victor', ?, NULL, '2.0', 'insufficient_evidence', ?, ?, ?, ?, 'seeded', '{}', ?)`)
    .run(refId, oppId, oppId, arv, rehab, mao, confidence, analyzedAt);
}
function seedVersion(db, { id, offerId, oppId, status = "rejected", timestamp, arv = 0, rehab = 0, mao = 0 }) {
  db.prepare(`INSERT OR IGNORE INTO seller_offers (id, opportunity_id, current_version, status, created_by) VALUES (?, ?, 1, 'draft', 'qa')`).run(offerId, oppId);
  db.prepare(`INSERT INTO seller_offer_versions
      (id, offer_id, version_number, version_status, strategy_type, purchase_price, earnest_money, inspection_days,
       closing_days, contingencies_json, underwriting_source_type, underwriting_source_id, underwriting_version_id,
       underwriting_arv_snapshot, underwriting_rehab_snapshot, underwriting_mao_snapshot, underwriting_confidence,
       underwriting_limitations, underwriting_timestamp, created_by)
      VALUES (?, ?, 1, ?, 'cash_purchase', 100000, 1000, 7, 30, '[]', 'victor_analysis', 'unknown', '2.0', ?, ?, ?, NULL, 'seeded', ?, 'qa')`)
    .run(id, offerId, status, arv, rehab, mao, timestamp);
}

test("027 migration: nullability, verbatim data, trigger inventory, FK behavior", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  runMigrations(db, preMigrationsDir());
  seedBasics(db, { oppId: "oppTaft", refId: "refTaft", analyzedAt: "2026-10-25T15:19:33Z" });
  seedVersion(db, { id: "verTaft", offerId: "offTaft", oppId: "oppTaft", status: "rejected", timestamp: "2026-10-25T15:19:33Z" });
  const triggersBefore = db.prepare(`SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name`).all().map((r) => r.name);
  const rowsBefore = db.prepare(`SELECT * FROM seller_offer_versions`).all();

  runMigrations(db, MIGRATIONS_DIR); // applies only 027

  const rowsAfter = db.prepare(`SELECT * FROM seller_offer_versions`).all();
  assert.equal(rowsAfter.length, rowsBefore.length);
  for (const col of ["underwriting_arv_snapshot", "underwriting_rehab_snapshot", "underwriting_mao_snapshot", "underwriting_source_id", "underwriting_timestamp"]) {
    assert.equal(rowsAfter[0][col], rowsBefore[0][col], col);
  }
  assert.equal(rowsAfter[0].underwriting_ref_id, null);
  const triggersAfter = db.prepare(`SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name`).all().map((r) => r.name);
  assert.deepEqual(triggersAfter, triggersBefore);
  const termsSql = db.prepare(`SELECT sql FROM sqlite_master WHERE name='trg_prevent_pending_or_approved_offer_version_terms_update'`).get().sql;
  assert.match(termsSql, /underwriting_arv_snapshot IS NOT OLD\.underwriting_arv_snapshot/);
  assert.match(termsSql, /underwriting_ref_id IS NOT OLD\.underwriting_ref_id/);
  // Nullability: a fresh version may store true NULLs.
  db.prepare(`INSERT INTO seller_offer_versions (id, offer_id, version_number, version_status, strategy_type, purchase_price, earnest_money, inspection_days, closing_days, contingencies_json, underwriting_source_type, underwriting_source_id, underwriting_version_id, underwriting_arv_snapshot, underwriting_rehab_snapshot, underwriting_mao_snapshot, created_by)
              VALUES ('verNull', 'offTaft', 2, 'draft', 'cash_purchase', 1, 1, 1, 1, '[]', 'victor_analysis', 'x', '2.0', NULL, NULL, NULL, 'qa')`).run();
  // FK: a bogus ref id is rejected; deleting a linked ref dissolves the link (SET NULL).
  assert.throws(() => db.prepare(`UPDATE seller_offer_versions SET underwriting_ref_id = 'nope' WHERE id = 'verTaft'`).run(), /FOREIGN KEY/);
  db.prepare(`UPDATE seller_offer_versions SET underwriting_ref_id = 'refTaft' WHERE id = 'verTaft'`).run();
  db.prepare(`DELETE FROM opportunity_underwriting_refs WHERE id = 'refTaft'`).run();
  assert.equal(db.prepare(`SELECT underwriting_ref_id FROM seller_offer_versions WHERE id = 'verTaft'`).get().underwriting_ref_id, null);
  assert.deepEqual(db.prepare(`PRAGMA foreign_key_check`).all(), []);
  db.close();
});

test("027 terms trigger is null-safe: protected versions cannot change snapshots across NULL", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  runMigrations(db, MIGRATIONS_DIR);
  seedBasics(db, { oppId: "oppA", refId: "refA", analyzedAt: "2026-01-01T00:00:00Z", arv: 200000 });
  seedVersion(db, { id: "verA", offerId: "offA", oppId: "oppA", status: "approved", timestamp: "2026-01-01T00:00:00Z", arv: 200000, rehab: 1, mao: 1 });
  assert.throws(() => db.prepare(`UPDATE seller_offer_versions SET underwriting_arv_snapshot = NULL WHERE id = 'verA'`).run(), /prohibited/);
  assert.throws(() => db.prepare(`UPDATE seller_offer_versions SET underwriting_ref_id = 'refA' WHERE id = 'verA'`).run(), /prohibited/);
  db.prepare(`UPDATE seller_offer_versions SET version_status = 'draft' WHERE id = 'verA'`).run();
  db.prepare(`UPDATE seller_offer_versions SET underwriting_arv_snapshot = NULL WHERE id = 'verA'`).run();
  db.close();
});

test("UA1 cured: explicit ref linkage wins over duplicate-timestamp ambiguity", () => {
  const tempDb = makeTempDb();
  const app = createApp(testConfig(tempDb.dbPath, { dataSource: "empty" }));
  try {
    const db = app.db;
    seedBasics(db, { oppId: "oppAmb", refId: "refSeed", analyzedAt: "2026-02-02T00:00:00Z", arv: 1 });
    db.prepare(`DELETE FROM opportunity_underwriting_refs WHERE id = 'refSeed'`).run();
    // Two references sharing one analyzed_at; timestamp matching alone
    // (ORDER BY created_at DESC) picks the LATER-created one (arv 111000).
    const mkRef = (id, createdAt, arv) => db.prepare(`INSERT INTO opportunity_underwriting_refs
      (id, opportunity_id, source_system, source_agent, source_project_id, source_version_id, analysis_status, arv, rehab, mao, confidence, limitations, analyzed_at, created_at)
      VALUES (?, 'oppAmb', 'deal-scout', 'Victor', 'amb-1', '2.0', 'completed', ?, 1, 1, 0.5, '', '2026-02-02T00:00:00Z', ?)`).run(id, arv, createdAt);
    mkRef("refOlder", "2026-02-01T00:00:00Z", 222000);
    mkRef("refNewer", "2026-02-03T00:00:00Z", 111000);
    const version = { underwriting_ref_id: "refOlder", underwriting_timestamp: "2026-02-02T00:00:00Z", underwriting_arv_snapshot: 0, underwriting_rehab_snapshot: 0, underwriting_mao_snapshot: 0, underwriting_confidence: null };
    assert.equal(resolveSnapshotFigures(db, "oppAmb", version).arv, 222000); // its own ref, not the timestamp winner
    const { underwriting_ref_id, ...legacy } = version;
    assert.equal(resolveSnapshotFigures(db, "oppAmb", legacy).arv, 111000); // documents the pre-027 ambiguity
  } finally {
    tempDb.cleanup();
  }
});

test("prepareOffer writes the explicit linkage and stores honest NULLs (post-027)", async () => {
  const tempDb = makeTempDb();
  const app = createApp(testConfig(tempDb.dbPath, { dataSource: "empty" }));
  try {
    const db = app.db;
    seedBasics(db, { oppId: "oppLink", refId: "uw_link", analyzedAt: "2026-10-25T15:21:03Z" });
    const offer = app.services.operator.prepareOffer({
      opportunityId: "oppLink", proposedPrice: 100000, strategyType: "cash_purchase",
      earnestMoney: 2500, inspectionDays: 7, closingDays: 30,
      internalNotes: "migration 027 linkage draft", actor: "founder-operator",
    });
    const v = offer.versions[0];
    const row = db.prepare(`SELECT * FROM seller_offer_versions WHERE id = ?`).get(v.id);
    assert.equal(row.underwriting_ref_id, "uw_link"); // explicit linkage stored
    assert.equal(row.underwriting_arv_snapshot, null); // honest NULL storage, no sentinel
    assert.equal(row.underwriting_rehab_snapshot, null);
    assert.equal(row.underwriting_mao_snapshot, null);
    assert.equal(v.underwritingRefId, "uw_link"); // surfaced by the operator read model
    const detail = await app.services.opportunities.getById("oppLink");
    assert.equal(detail.offers[0].versions[0].underwritingRefId, "uw_link");
    assert.equal(detail.offers[0].versions[0].underwritingArvSnapshot, null);
  } finally {
    tempDb.cleanup();
  }
});

test("DUA1: non-scalar evidence values are unknown, never coerced figures", () => {
  const tempDb = makeTempDb();
  const app = createApp(testConfig(tempDb.dbPath, { dataSource: "empty" }));
  try {
    const run = (suffix, dscr) => {
      const oppId = `opp_dua_${suffix}`;
      app.db.prepare(`INSERT INTO seller_opportunities (id, opportunity_code, ocg_one_property_id, created_by, pipeline_stage)
                      VALUES (?, ?, ?, 'qa', 'property_review')`).run(oppId, `OPP-${suffix}`, `prop-${suffix}`);
      app.db.prepare(`INSERT INTO opportunity_underwriting_refs
          (id, opportunity_id, source_system, source_agent, source_project_id, source_version_id, analysis_status,
           arv, rehab, mao, confidence, limitations, evidence_summary_json, analyzed_at)
          VALUES (?, ?, 'deal-scout', 'Victor', ?, '2.0', 'completed', 200000, 10000, 150000, 0.9, '', ?, '2026-06-06T00:00:00Z')`)
        .run(`uw_dua_${suffix}`, oppId, oppId, JSON.stringify({ hold: { strategy: null, dscr } }));
      app.services.operator.prepareOffer({
        opportunityId: oppId, proposedPrice: 100000, strategyType: "cash_purchase",
        earnestMoney: 1000, inspectionDays: 7, closingDays: 30, internalNotes: "dua1 probe", actor: "qa",
      });
      return app.services.investmentCommittee.reviewActiveOffer({ opportunityId: oppId, actor: "qa" });
    };
    for (const [suffix, bad] of [["arr", []], ["bool", true], ["hex", "0x10"], ["obj", {}], ["blank", " "]]) {
      const review = run(suffix, bad);
      assert.equal(review.metrics.dscr, null, `dscr ${JSON.stringify(bad)} must be unknown`);
      assert.doesNotMatch(review.rationale, /DSCR \d/, `no fabricated DSCR figure for ${JSON.stringify(bad)}`);
    }
    assert.equal(run("str", "1.25").metrics.dscr, 1.25); // plain decimal strings still parse
    assert.equal(run("zero", 0).metrics.dscr, 0); // genuine zero survives
  } finally {
    tempDb.cleanup();
  }
});

test("remediation tool: unique-link backfill, sentinel null-out, ambiguity preserved, immutability respected", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  runMigrations(db, MIGRATIONS_DIR);
  seedBasics(db, { oppId: "oppT", refId: "refT", analyzedAt: "2026-03-03T00:00:00Z" });
  seedVersion(db, { id: "verT", offerId: "offT", oppId: "oppT", status: "rejected", timestamp: "2026-03-03T00:00:00Z" });
  seedBasics(db, { oppId: "oppB", refId: "refB1", analyzedAt: "2026-04-04T00:00:00Z", arv: 200000 });
  db.prepare(`INSERT INTO opportunity_underwriting_refs (id, opportunity_id, source_system, source_agent, source_project_id, source_version_id, analysis_status, arv, analyzed_at)
              VALUES ('refB2', 'oppB', 'deal-scout', 'Victor', 'oppB', '2.0', 'completed', 240000, '2026-04-04T00:00:00Z')`).run();
  seedVersion(db, { id: "verB", offerId: "offB", oppId: "oppB", status: "draft", timestamp: "2026-04-04T00:00:00Z", arv: 200000, rehab: 5, mao: 5 });
  seedBasics(db, { oppId: "oppC", refId: "refC", analyzedAt: "2026-05-05T00:00:00Z", arv: 150000 });
  seedVersion(db, { id: "verC", offerId: "offC", oppId: "oppC", status: "approved", timestamp: "2026-05-05T00:00:00Z", arv: 150000, rehab: 5, mao: 5 });

  const plan = planRemediation(db);
  const byId = Object.fromEntries(plan.map((e) => [e.versionId, e]));
  assert.equal(byId.verT.disposition, "apply");
  assert.ok(byId.verT.actions.some((a) => a.type === "link_ref" && a.refId === "refT"));
  assert.equal(byId.verT.actions.filter((a) => a.type === "null_out_sentinel").length, 3);
  assert.equal(byId.verB.disposition, "unchanged"); // ambiguous: preserved, never guessed
  assert.ok(byId.verB.actions.some((a) => a.type === "unlinked" && a.reason.includes("ambiguous")));
  assert.equal(byId.verC.disposition, "deferred_immutable");

  applyRemediation(db, {});
  const rowT = db.prepare(`SELECT * FROM seller_offer_versions WHERE id = 'verT'`).get();
  assert.equal(rowT.underwriting_ref_id, "refT");
  assert.equal(rowT.underwriting_arv_snapshot, null);
  assert.equal(rowT.underwriting_source_id, "unknown"); // historical strings never rewritten
  assert.equal(db.prepare(`SELECT underwriting_ref_id FROM seller_offer_versions WHERE id = 'verC'`).get().underwriting_ref_id, null); // deferred without the flag

  const triggersBefore = db.prepare(`SELECT name, sql FROM sqlite_master WHERE type='trigger' ORDER BY name`).all();
  applyRemediation(db, { includeImmutable: true });
  assert.equal(db.prepare(`SELECT underwriting_ref_id FROM seller_offer_versions WHERE id = 'verC'`).get().underwriting_ref_id, "refC");
  const triggersAfter = db.prepare(`SELECT name, sql FROM sqlite_master WHERE type='trigger' ORDER BY name`).all();
  assert.deepEqual(triggersAfter, triggersBefore); // inventory byte-identical after the governed dance
  db.close();
});
