/**
 * Classification history consistency.
 *
 * Guards the boundary between two vocabularies that were previously conflated:
 *
 *   deal classification — retail_listing / wholesale_target / investment_rehab /
 *                         land_hold / disqualified / unknown. Stored, and
 *                         CHECK-constrained by migration 007.
 *   lineage             — REAL / SYNTHETIC / AMBIGUOUS. A determination about
 *                         whether a record's source is genuine. No column
 *                         stores it.
 *
 * Classification history is deal classification. Lineage values in that table
 * would be rejected by the CHECK constraint, so the fixtures carrying them were
 * describing something the database could never hold.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDb, testConfig, startApp } from "./helpers/temporaryDatabase.mjs";
import { openPipelineDatabase } from "../src/database/openDatabase.js";
import { createApp } from "../src/app/createApp.js";
import {
  CLASSIFICATION_HISTORY_FIXTURES,
  OPPORTUNITY_FIXTURES,
  DEAL_CLASSIFICATION_VALUES,
} from "../src/fixtures/opportunities.js";

/** Exactly the CHECK constraint in migrations/007. */
const ALLOWED = new Set(["retail_listing", "wholesale_target", "investment_rehab", "land_hold", "disqualified", "unknown"]);
const LINEAGE = ["REAL", "SYNTHETIC", "AMBIGUOUS"];

test("the fixture vocabulary is exactly the CHECK constraint", () => {
  assert.deepEqual([...DEAL_CLASSIFICATION_VALUES].sort(), [...ALLOWED].sort());
});

test("a fresh seed produces classification history", async (t) => {
  const tempDb = makeTempDb();
  t.after(() => tempDb.cleanup());
  const app = createApp(testConfig(tempDb.dbPath, { isTest: false }));
  t.after(() => app.close());

  const db = openPipelineDatabase(tempDb.dbPath);
  t.after(() => db.close());

  const opportunities = db.prepare("SELECT COUNT(*) n FROM seller_opportunities").get().n;
  const history = db.prepare("SELECT COUNT(*) n FROM classification_history").get().n;

  assert.ok(opportunities > 0, "the seeder produced opportunities");
  assert.equal(history, opportunities, "one initial history row per seeded opportunity");
});

test("every seeded classification satisfies the CHECK constraint", async (t) => {
  const tempDb = makeTempDb();
  t.after(() => tempDb.cleanup());
  const app = createApp(testConfig(tempDb.dbPath, { isTest: false }));
  t.after(() => app.close());

  const db = openPipelineDatabase(tempDb.dbPath);
  t.after(() => db.close());

  for (const r of db.prepare("SELECT opportunity_id, new_classification, prior_classification FROM classification_history").all()) {
    assert.ok(ALLOWED.has(r.new_classification), `${r.opportunity_id}: new_classification "${r.new_classification}" is permitted`);
    if (r.prior_classification !== null) {
      assert.ok(ALLOWED.has(r.prior_classification), `${r.opportunity_id}: prior_classification "${r.prior_classification}" is permitted`);
    }
  }

  for (const r of db.prepare("SELECT opportunity_id, classification_value FROM record_classifications").all()) {
    assert.ok(ALLOWED.has(r.classification_value), `${r.opportunity_id}: classification_value "${r.classification_value}" is permitted`);
  }

  // The constraint is real, not decorative.
  assert.throws(
    () => db.prepare(`
      INSERT INTO classification_history (id, opportunity_id, prior_classification, new_classification, classification_rules_version, determined_by, reason)
      VALUES ('probe', 'FX-OPP-0001', NULL, 'REAL', '1.0.0', 'test', 'should be rejected')
    `).run(),
    /CHECK constraint failed|constraint/i,
    "the database itself rejects a lineage value in classification history"
  );
});

test("seeded history agrees with the seeded current classification", async (t) => {
  const tempDb = makeTempDb();
  t.after(() => tempDb.cleanup());
  const app = createApp(testConfig(tempDb.dbPath, { isTest: false }));
  t.after(() => app.close());

  const db = openPipelineDatabase(tempDb.dbPath);
  t.after(() => db.close());

  const current = db.prepare("SELECT opportunity_id, classification_value FROM record_classifications").all();
  assert.ok(current.length > 0);

  for (const row of current) {
    const latest = db.prepare(`
      SELECT new_classification FROM classification_history
      WHERE opportunity_id = ? ORDER BY determined_at DESC, rowid DESC LIMIT 1
    `).get(row.opportunity_id);

    assert.ok(latest, `${row.opportunity_id} has history`);
    assert.equal(
      latest.new_classification,
      row.classification_value,
      `${row.opportunity_id}: latest history entry matches the current classification`
    );
  }
});

test("no lineage value survives anywhere in classification-history data", async (t) => {
  // Fixtures.
  for (const h of CLASSIFICATION_HISTORY_FIXTURES) {
    for (const field of ["newClassification", "priorClassification"]) {
      const v = h[field];
      if (v === null || v === undefined) continue;
      assert.ok(!LINEAGE.includes(v), `fixture ${h.opportunityId}.${field} is not a lineage value (got "${v}")`);
      assert.ok(ALLOWED.has(v), `fixture ${h.opportunityId}.${field} "${v}" satisfies the CHECK constraint`);
    }
  }

  // Fixture record classifications.
  for (const o of OPPORTUNITY_FIXTURES) {
    assert.ok(ALLOWED.has(o.recordClassification), `${o.id}.recordClassification "${o.recordClassification}" is permitted`);
    assert.ok(!LINEAGE.includes(o.recordClassification), `${o.id}.recordClassification is not a lineage value`);
  }

  // Seeded database.
  const tempDb = makeTempDb();
  t.after(() => tempDb.cleanup());
  const app = createApp(testConfig(tempDb.dbPath, { isTest: false }));
  t.after(() => app.close());
  const db = openPipelineDatabase(tempDb.dbPath);
  t.after(() => db.close());

  const contaminated = db.prepare(`
    SELECT COUNT(*) n FROM classification_history
    WHERE new_classification IN ('REAL','SYNTHETIC','AMBIGUOUS')
       OR prior_classification IN ('REAL','SYNTHETIC','AMBIGUOUS')
  `).get().n;
  assert.equal(contaminated, 0, "no lineage values in the seeded history");
});

test("fixture history preserves the recovered structure", () => {
  // Same three opportunities, same row counts, same ordering by timestamp.
  const byOpp = {};
  for (const h of CLASSIFICATION_HISTORY_FIXTURES) {
    byOpp[h.opportunityId] = (byOpp[h.opportunityId] || 0) + 1;
  }
  assert.deepEqual(byOpp, { "FX-OPP-0004": 2, "FX-OPP-0003": 1, "FX-OPP-0001": 1 });

  // prior null is retained where the recovered row had no predecessor.
  const initial = CLASSIFICATION_HISTORY_FIXTURES.filter((h) => h.priorClassification === null);
  assert.equal(initial.length, 3, "three initial classifications, unchanged from the recovered data");

  // The only row with a predecessor is FX-OPP-0004's re-review.
  const withPrior = CLASSIFICATION_HISTORY_FIXTURES.filter((h) => h.priorClassification !== null);
  assert.equal(withPrior.length, 1);
  assert.equal(withPrior[0].opportunityId, "FX-OPP-0004");
  assert.equal(withPrior[0].reason, "re-review confirmed");
});

test("fixture history terminates at the fixture's current classification", () => {
  const latest = new Map();
  for (const h of CLASSIFICATION_HISTORY_FIXTURES) {
    const prev = latest.get(h.opportunityId);
    if (!prev || h.changedAt > prev.changedAt) latest.set(h.opportunityId, h);
  }

  for (const [opportunityId, h] of latest) {
    const fixture = OPPORTUNITY_FIXTURES.find((o) => o.id === opportunityId);
    assert.ok(fixture, `${opportunityId} exists in the fixture set`);
    assert.equal(
      h.newClassification,
      fixture.recordClassification,
      `${opportunityId}: history and current classification agree`
    );
  }
});

test("fixture and SQLite repositories expose the same classification shape", async (t) => {
  const tempDb = makeTempDb();
  t.after(() => tempDb.cleanup());

  const sqliteApp = await startApp(createApp, testConfig(tempDb.dbPath, { dataSource: "empty", isTest: false }));
  t.after(() => sqliteApp.app.server.close());

  const fixtureDb = makeTempDb();
  t.after(() => fixtureDb.cleanup());
  const fixtureApp = await startApp(createApp, testConfig(fixtureDb.dbPath, { dataSource: "fixtures", isTest: false }));
  t.after(() => fixtureApp.app.server.close());

  const read = async (baseUrl) => (await (await fetch(`${baseUrl}/api/v1/classifications`)).json()).data;

  const fromSqlite = await read(sqliteApp.baseUrl);
  const fromFixtures = await read(fixtureApp.baseUrl);

  const currentKeys = (d) => Object.keys(d.current[0]).sort();
  assert.deepEqual(currentKeys(fromFixtures), currentKeys(fromSqlite), "current rows have identical fields");

  const historyKeys = (d) => Object.keys(d.history[0]).sort();
  assert.deepEqual(historyKeys(fromFixtures), historyKeys(fromSqlite), "history rows have identical fields");

  // And the shared field carries the same kind of value in both.
  for (const source of [fromSqlite, fromFixtures]) {
    for (const row of source.current) {
      assert.ok(
        ALLOWED.has(row.recordClassification),
        `recordClassification "${row.recordClassification}" is a deal classification`
      );
    }
    for (const row of source.history) {
      assert.ok(ALLOWED.has(row.newClassification), `history newClassification "${row.newClassification}" is a deal classification`);
    }
  }
});
