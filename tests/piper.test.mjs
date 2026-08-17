/**
 * Piper — brief and question answering.
 *
 * The property that matters most here is not that Piper answers, but that she
 * never answers with something the database does not contain. Several of these
 * tests exist specifically to catch a regression toward fabrication.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDb, testConfig, startApp } from "./helpers/temporaryDatabase.mjs";
import { openPipelineDatabase } from "../src/database/openDatabase.js";
import { createApp } from "../src/app/createApp.js";
import { PiperContextService } from "../src/services/piperContextService.js";
import { buildBrief } from "../src/domain/piper/briefModel.js";
import { answerQuestion } from "../src/domain/piper/intentRouter.js";

const ask = async (baseUrl, question, activeOpportunityId = null) => {
  const res = await fetch(`${baseUrl}/api/v1/piper/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question, activeOpportunityId }),
  });
  return { status: res.status, body: await res.json() };
};

test("Piper's brief is derived from stored state", async (t) => {
  const tempDb = makeTempDb();
  t.after(() => tempDb.cleanup());
  const { app, baseUrl } = await startApp(createApp, testConfig(tempDb.dbPath, { readOnly: false, isTest: false }));
  t.after(() => app.server.close());

  const res = await fetch(`${baseUrl}/api/v1/piper/brief`);
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.equal(body.ok, true);
  // Provider identity moved under meta.provider when the runtime landed; the
  // claim being guarded is unchanged — with no provider configured, none is
  // claimed and the answer is deterministic.
  assert.equal(body.meta.deterministic, true);
  assert.equal(body.meta.provider.connected, false, "no language model may be claimed");
  assert.equal(body.meta.provider.model, null);
  assert.ok(body.data.headline, "a headline is always produced");

  // Every referenced opportunity must exist.
  const db = openPipelineDatabase(tempDb.dbPath);
  const ids = new Set(db.prepare("SELECT id FROM seller_opportunities").all().map((r) => r.id));
  db.close();

  for (const section of body.data.sections) {
    for (const item of section.items) {
      if (item.opportunityId) {
        assert.ok(ids.has(item.opportunityId), `brief cites a real opportunity: ${item.opportunityId}`);
      }
    }
  }
});

test("Piper's counts match the database exactly", async (t) => {
  const tempDb = makeTempDb();
  t.after(() => tempDb.cleanup());
  const app = createApp(testConfig(tempDb.dbPath, { readOnly: false, isTest: false }));
  t.after(() => app.close());

  const db = openPipelineDatabase(tempDb.dbPath);
  t.after(() => db.close());

  const piper = new PiperContextService(db, testConfig(tempDb.dbPath, { isTest: false }));
  const snapshot = piper.snapshot();

  const actual = db.prepare("SELECT COUNT(*) n FROM seller_opportunities").get().n;
  assert.equal(snapshot.totals.opportunities, actual, "opportunity count matches");

  const unresolved = db.prepare("SELECT COUNT(*) n FROM source_provenance WHERE resolution_status = 'unresolved'").get().n;
  assert.equal(snapshot.totals.unresolvedProvenance, unresolved, "unresolved provenance count matches");

  const withUw = db.prepare("SELECT COUNT(*) n FROM seller_opportunities WHERE underwriting_source_type IS NOT NULL").get().n;
  const claimed = snapshot.opportunities.filter((o) => o.underwriting.sourceType).length;
  assert.equal(claimed, withUw, "underwriting attribution matches");
});

test("Piper refuses to rank when the data cannot support it", async (t) => {
  const tempDb = makeTempDb();
  t.after(() => tempDb.cleanup());
  const { app, baseUrl } = await startApp(createApp, testConfig(tempDb.dbPath, { readOnly: false, isTest: false }));
  t.after(() => app.server.close());

  // Seeded fixtures carry no underwriting, so "strongest" has nothing to rank on.
  const { body } = await ask(baseUrl, "Which opportunity looks strongest?");
  assert.equal(body.ok, true);
  assert.match(body.data.answer, /can't rank|cannot rank/i);
  assert.equal(body.data.items.length, 0, "no invented ranking");
});

test("Piper never claims underwriting that Victor did not supply", async (t) => {
  const tempDb = makeTempDb();
  t.after(() => tempDb.cleanup());
  const { app, baseUrl } = await startApp(createApp, testConfig(tempDb.dbPath, { readOnly: false, isTest: false }));
  t.after(() => app.server.close());

  const { body } = await ask(baseUrl, "Did Victor change the numbers?");
  assert.match(body.data.answer, /no opportunity has recorded underwriting|has no underwriting/i);
});

test("Piper uses the on-screen opportunity as context", async (t) => {
  const tempDb = makeTempDb();
  t.after(() => tempDb.cleanup());
  const { app, baseUrl } = await startApp(createApp, testConfig(tempDb.dbPath, { readOnly: false, isTest: false }));
  t.after(() => app.server.close());

  const withContext = await ask(baseUrl, "what am I missing?", "FX-OPP-0001");
  assert.equal(withContext.body.ok, true);
  const ids = withContext.body.data.items.map((i) => i.opportunityId);
  if (ids.length) {
    assert.deepEqual([...new Set(ids)], ["FX-OPP-0001"], "scoped to the open record");
  }

  const noContext = await ask(baseUrl, "tell me about it");
  assert.match(noContext.body.data.answer, /which opportunity/i);
});

test("Piper declines to move a stage and offers a real alternative", async (t) => {
  const tempDb = makeTempDb();
  t.after(() => tempDb.cleanup());
  const { app, baseUrl } = await startApp(createApp, testConfig(tempDb.dbPath, { readOnly: false, isTest: false }));
  t.after(() => app.server.close());

  const { body } = await ask(baseUrl, "move this to follow-up", "FX-OPP-0001");
  assert.match(body.data.answer, /can't move a stage/i);
  assert.equal(body.data.proposal.kind, "create_next_action");
});

test("Piper proposes rather than performs a write", async (t) => {
  const tempDb = makeTempDb();
  t.after(() => tempDb.cleanup());
  const { app, baseUrl } = await startApp(createApp, testConfig(tempDb.dbPath, { readOnly: false, isTest: false }));
  t.after(() => app.server.close());

  const { body } = await ask(baseUrl, "create next action call the seller tomorrow", "FX-OPP-0001");
  assert.equal(body.data.proposal.kind, "create_next_action");
  assert.equal(body.data.proposal.opportunityId, "FX-OPP-0001");

  // The proposal must not have written anything on its own.
  const db = openPipelineDatabase(tempDb.dbPath);
  const n = db.prepare("SELECT COUNT(*) n FROM operator_next_actions").get().n;
  db.close();
  assert.equal(n, 0, "asking Piper must never write by itself");
});

test("Piper admits when she does not understand", async (t) => {
  const tempDb = makeTempDb();
  t.after(() => tempDb.cleanup());
  const { app, baseUrl } = await startApp(createApp, testConfig(tempDb.dbPath, { readOnly: false, isTest: false }));
  t.after(() => app.server.close());

  const { body } = await ask(baseUrl, "write me a seller negotiation script in the style of a poem");
  assert.match(body.data.answer, /no language model/i);
  assert.ok(Array.isArray(body.meta.capabilities), "offers what she can actually do");
});

test("Piper reflects operator state once it exists", async (t) => {
  const tempDb = makeTempDb();
  t.after(() => tempDb.cleanup());
  const { app, baseUrl } = await startApp(createApp, testConfig(tempDb.dbPath, { readOnly: false, isTest: false }));
  t.after(() => app.server.close());

  await fetch(`${baseUrl}/api/v1/operator/next-actions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ opportunityId: "FX-OPP-0001", title: "Follow up with seller" }),
  });

  const db = openPipelineDatabase(tempDb.dbPath);
  const piper = new PiperContextService(db, testConfig(tempDb.dbPath, { isTest: false }));
  const snapshot = piper.snapshot();
  db.close();

  const target = snapshot.opportunities.find((o) => o.id === "FX-OPP-0001");
  assert.equal(target.openNextActionCount, 1, "Piper sees the action the operator recorded");
  assert.equal(target.nextActions[0].title, "Follow up with seller");
});

test("An empty database produces an honest brief, not a padded one", () => {
  const snapshot = {
    generatedAt: "2026-08-16T00:00:00Z",
    since: null,
    staleThresholdDays: 7,
    system: { dataSource: "empty", demo: false, integration: "disabled", readOnly: false, intakeEnabled: false },
    totals: { opportunities: 0, active: 0, stalled: 0, unresolvedProvenance: 0, missingProvenance: 0, withoutUnderwriting: 0, openNextActions: 0 },
    opportunities: [],
    recent: { intakes: [], stageEvents: [], classificationChanges: [], victorUpdates: [] },
  };

  const brief = buildBrief(snapshot);
  assert.match(brief.headline, /no active opportunities/i);
  assert.equal(brief.sections.length, 0, "no sections invented for an empty database");

  const answer = answerQuestion("what needs my attention?", snapshot);
  assert.equal(answer.items.length, 0);
});
