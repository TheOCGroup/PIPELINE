import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { APP_ROOT } from "../src/config/environment.js";
import { runMigrations } from "../src/database/migrationRunner.js";
import { openPipelineDatabase } from "../src/database/openDatabase.js";
import { PiperDiscoveryRunner } from "../src/discovery/piperDiscoveryRunner.js";
import { parsePiperSource } from "../src/discovery/piperSourceParsers.js";
import { isPathAllowedByRobots } from "../src/discovery/robotsPolicy.js";
import { syncPiperDiscoverySources } from "../src/discovery/piperSourceRegistry.js";
import { PiperIntelligenceService } from "../src/services/piperIntelligenceService.js";
import { makeTempDb } from "./helpers/temporaryDatabase.mjs";

test("PIPER parses approved JSON feeds using configurable field maps", () => {
  const listings = parsePiperSource(JSON.stringify({ records: [{ ref: "A1", location: "123 Main St", amount: 75000 }] }), {
    id: "source-test",
    sourceFormat: "json",
    configuration: { itemsPath: "records", fieldMap: { externalId: "ref", address: "location", askingPrice: "amount" } },
  });
  assert.equal(listings.length, 1);
  assert.equal(listings[0].externalId, "A1");
  assert.equal(listings[0].askingPrice, 75000);
});

test("PIPER honors the most specific applicable robots rule", () => {
  const robots = `User-agent: *\nDisallow: /private\nAllow: /private/public-feed`;
  assert.equal(isPathAllowedByRobots(robots, "https://example.test/private/listings"), false);
  assert.equal(isPathAllowedByRobots(robots, "https://example.test/private/public-feed/today"), true);
});

test("PIPER discovery run collects, scores, persists, recommends, and reconciles", async (t) => {
  const tmp = makeTempDb();
  t.after(() => tmp.cleanup());
  const db = openPipelineDatabase(tmp.dbPath);
  t.after(() => db.close());
  runMigrations(db, join(APP_ROOT, "migrations"));
  syncPiperDiscoverySources(db, [{
    id: "approved-feed",
    name: "Approved Wichita Feed",
    url: "https://example.test/listings.json",
    format: "json",
    respectRobots: true,
    configuration: {},
  }]);

  const feed = JSON.stringify([{ id: "W-419", address: "419 N Main Street, Wichita, KS", price: 70000,
    arv: 180000, rehab: 30000, description: "Vacant fixer, as-is cash only", url: "https://example.test/W-419" }]);
  const fetchImpl = async (url) => url.endsWith("/robots.txt")
    ? new Response("User-agent: *\nAllow: /", { status: 200 })
    : new Response(feed, { status: 200, headers: { "content-type": "application/json" } });
  const runner = new PiperDiscoveryRunner({ db, fetchImpl, userAgent: "OCG-PIPER-TEST/1.0" });

  const first = await runner.runAll();
  assert.equal(first.results[0].status, "completed");
  assert.equal(first.results[0].counts.created, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM seller_opportunities").get().count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM piper_recommendations").get().count, 1);
  assert.ok(db.prepare("SELECT piper_score AS score FROM piper_discovery_items").get().score >= 65);

  const second = await runner.runAll();
  assert.equal(second.results[0].counts.reconciled, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM seller_opportunities").get().count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM piper_discovery_items").get().count, 1);

  const intelligence = new PiperIntelligenceService(db);
  const recommendation = intelligence.recommendations(1)[0];
  assert.equal(recommendation.opportunityId.startsWith("opp_"), true);
  const analysis = intelligence.chat({ message: "Analyze this deal", opportunityId: recommendation.opportunityId });
  assert.equal(analysis.grounded, true);
  assert.match(analysis.answer, /70% rule/);
  assert.match(analysis.answer, /\$96,000/);

  const discoveryStatus = intelligence.chat({ message: "What did the website scan find?" });
  assert.match(discoveryStatus.answer, /found 1 properties/);
});
