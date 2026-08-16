/**
 * Operator state persistence.
 *
 * These replace browser localStorage, so the thing worth proving is that input
 * survives the process: written through the API, then read back from a fresh
 * database handle rather than from any in-memory cache.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDb, testConfig, startApp } from "./helpers/temporaryDatabase.mjs";
import { openPipelineDatabase } from "../src/database/openDatabase.js";
import { createApp } from "../src/app/createApp.js";

const OPP = "FX-OPP-0001";

async function post(baseUrl, resource, body) {
  const res = await fetch(`${baseUrl}/api/v1/operator/${resource}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function get(baseUrl, resource, oppId) {
  const res = await fetch(`${baseUrl}/api/v1/operator/${resource}?opportunityId=${encodeURIComponent(oppId)}`);
  return { status: res.status, body: await res.json() };
}

test("Operator state is written to the database and survives the request", async (t) => {
  const tempDb = makeTempDb();
  t.after(() => tempDb.cleanup());
  const { app, baseUrl } = await startApp(createApp, testConfig(tempDb.dbPath, { readOnly: false, isTest: false }));
  t.after(() => app.server.close());

  await t.test("a next action persists", async () => {
    const created = await post(baseUrl, "next-actions", { opportunityId: OPP, title: "Call the seller", dueDate: "2026-09-01" });
    assert.equal(created.status, 201);
    assert.equal(created.body.data.nextAction.title, "Call the seller");

    const db = openPipelineDatabase(tempDb.dbPath);
    const row = db.prepare("SELECT * FROM operator_next_actions WHERE opportunity_id = ?").get(OPP);
    db.close();
    assert.ok(row, "row exists in operator_next_actions");
    assert.equal(row.title, "Call the seller");
    assert.equal(row.status, "open");
  });

  await t.test("a next action can be completed", async () => {
    const { body } = await get(baseUrl, "next-actions", OPP);
    const id = body.data.nextActions[0].id;

    const res = await fetch(`${baseUrl}/api/v1/operator/next-actions/${id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "done" }),
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).data.nextAction.status, "done");
  });

  await t.test("notes persist and are append-only", async () => {
    const created = await post(baseUrl, "notes", { opportunityId: OPP, body: "Seller mentioned a competing offer." });
    assert.equal(created.status, 201);

    const db = openPipelineDatabase(tempDb.dbPath);
    const row = db.prepare("SELECT * FROM operator_notes WHERE opportunity_id = ?").get(OPP);
    assert.equal(row.body, "Seller mentioned a competing offer.");
    // Migration 010 protects notes with a trigger.
    assert.throws(
      () => db.prepare("UPDATE operator_notes SET body = ? WHERE id = ?").run("rewritten", row.id),
      /append-only|prohibited/i
    );
    db.close();
  });

  await t.test("checklist items upsert rather than duplicate", async () => {
    await post(baseUrl, "checklist", { opportunityId: OPP, key: "apn", label: "Verify APN/GIS records", checked: true });
    await post(baseUrl, "checklist", { opportunityId: OPP, key: "apn", label: "Verify APN/GIS records", checked: false });

    const { body } = await get(baseUrl, "checklist", OPP);
    const apn = body.data.checklist.filter((i) => i.key === "apn");
    assert.equal(apn.length, 1, "one row per (opportunity, item)");
    assert.equal(apn[0].checked, false, "latest value wins");
  });

  await t.test("interactions land in seller_interactions", async () => {
    const created = await post(baseUrl, "interactions", {
      opportunityId: OPP, channel: "phone", direction: "outbound", summary: "Left voicemail", outcome: "no_answer",
    });
    assert.equal(created.status, 201);

    const db = openPipelineDatabase(tempDb.dbPath);
    const row = db.prepare("SELECT * FROM seller_interactions WHERE opportunity_id = ?").get(OPP);
    db.close();
    assert.equal(row.summary, "Left voicemail");
    assert.equal(row.channel, "phone");
  });

  await t.test("bad input is rejected without writing", async () => {
    const missing = await post(baseUrl, "notes", { opportunityId: OPP });
    assert.equal(missing.status, 400);
    assert.equal(missing.body.error, "missing_body");

    const noOpp = await post(baseUrl, "next-actions", { title: "orphan" });
    assert.equal(noOpp.status, 400);
    assert.equal(noOpp.body.error, "missing_opportunityId");
  });
});

test("Read-only mode blocks every operator write but still serves reads", async (t) => {
  const tempDb = makeTempDb();
  t.after(() => tempDb.cleanup());
  const { app, baseUrl } = await startApp(createApp, testConfig(tempDb.dbPath, { readOnly: true, isTest: false }));
  t.after(() => app.server.close());

  for (const [resource, payload] of [
    ["next-actions", { opportunityId: OPP, title: "should not persist" }],
    ["notes", { opportunityId: OPP, body: "should not persist" }],
    ["checklist", { opportunityId: OPP, key: "k", label: "l", checked: true }],
    ["interactions", { opportunityId: OPP, channel: "phone", direction: "outbound", summary: "no" }],
  ]) {
    const res = await post(baseUrl, resource, payload);
    assert.equal(res.status, 503, `${resource} must be refused`);
    assert.equal(res.body.error, "read_only");
  }

  const reads = await get(baseUrl, "next-actions", OPP);
  assert.equal(reads.status, 200, "reads still work in read-only mode");

  const db = openPipelineDatabase(tempDb.dbPath);
  const n = db.prepare("SELECT COUNT(*) n FROM operator_next_actions").get().n;
  const notes = db.prepare("SELECT COUNT(*) n FROM operator_notes").get().n;
  db.close();
  assert.equal(n, 0, "read-only refusals wrote nothing");
  assert.equal(notes, 0);
});

test("Operator routes reject unsupported methods and unknown resources", async (t) => {
  const tempDb = makeTempDb();
  t.after(() => tempDb.cleanup());
  const { app, baseUrl } = await startApp(createApp, testConfig(tempDb.dbPath, { readOnly: false, isTest: false }));
  t.after(() => app.server.close());

  const notFound = await fetch(`${baseUrl}/api/v1/operator/nonsense`);
  assert.equal(notFound.status, 404);

  const badMethod = await fetch(`${baseUrl}/api/v1/operator/notes?opportunityId=${OPP}`, { method: "DELETE" });
  assert.equal(badMethod.status, 405);
});
