/**
 * Unified seller timeline (P2).
 *
 * Proves the operator timeline endpoint aggregates every recorded seller
 * event for one opportunity into a single newest-first list — without
 * inventing data and without leaking raw ids into summaries.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDb, testConfig, startApp } from "./helpers/temporaryDatabase.mjs";
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

async function getTimeline(baseUrl, oppId) {
  const qs = oppId === undefined ? "" : `?opportunityId=${encodeURIComponent(oppId)}`;
  const res = await fetch(`${baseUrl}/api/v1/operator/timeline${qs}`);
  return { status: res.status, body: await res.json() };
}

test("Seller timeline aggregates every recorded event, newest first", async (t) => {
  const tempDb = makeTempDb();
  t.after(() => tempDb.cleanup());
  const { app, baseUrl } = await startApp(
    createApp,
    testConfig(tempDb.dbPath, { readOnly: false, isTest: false, dataSource: "fixtures" })
  );
  t.after(() => app.server.close());

  await t.test("fixture stage history appears without any writes", async () => {
    const { status, body } = await getTimeline(baseUrl, OPP);
    assert.equal(status, 200);
    assert.ok(body.ok);
    const types = body.data.timeline.events.map((e) => e.type);
    assert.ok(types.includes("lead_created"), "lead_created present");
    assert.ok(types.includes("stage_change"), "stage_change present");
    // Newest-first ordering.
    const ats = body.data.timeline.events.map((e) => e.at).filter(Boolean);
    const sorted = [...ats].sort().reverse();
    assert.deepEqual(ats, sorted, "events are newest-first");
    // No raw ids or audit noise in summaries.
    for (const e of body.data.timeline.events) {
      assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}/i.test(e.summary), `no raw uuid in summary: ${e.summary}`);
      assert.ok(typeof e.type === "string" && typeof e.summary === "string");
    }
  });

  await t.test("notes, follow-ups, interactions and offers join the timeline", async () => {
    const note = await post(baseUrl, "notes", { opportunityId: OPP, body: "Seller prefers a quick close." });
    assert.equal(note.status, 201);

    const action = await post(baseUrl, "next-actions", {
      opportunityId: OPP,
      title: "Call the seller",
      dueDate: "2026-10-01",
    });
    assert.equal(action.status, 201);
    const actionId = action.body.data.nextAction.id;

    const doneRes = await fetch(`${baseUrl}/api/v1/operator/next-actions/${encodeURIComponent(actionId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "done" }),
    });
    const done = { status: doneRes.status, body: await doneRes.json() };
    assert.equal(done.status, 200);

    const call = await post(baseUrl, "interactions", {
      opportunityId: OPP,
      channel: "phone",
      direction: "outbound",
      summary: "Spoke with the seller about timeline.",
    });
    assert.equal(call.status, 201);

    const uw = await post(baseUrl, "underwriting", {
      opportunityId: OPP,
      arv: 220000,
      rehab: 45000,
      fee: 10000,
      basis: "Operator walkthrough estimate",
    });
    assert.equal(uw.status, 201);

    const offer = await post(baseUrl, "offers", {
      opportunityId: OPP,
      proposedPrice: 150000,
      earnestMoney: 1000,
      inspectionDays: 10,
      closingDays: 30,
      strategyType: "cash_purchase",
    });
    assert.equal(offer.status, 201);

    const { status, body } = await getTimeline(baseUrl, OPP);
    assert.equal(status, 200);
    const types = body.data.timeline.events.map((e) => e.type);
    for (const want of ["note", "followup_done", "call", "offer", "lead_created", "stage_change"]) {
      assert.ok(types.includes(want), `timeline includes ${want} (got: ${types.join(",")})`);
    }
    // The completed follow-up must not also appear as an open follow-up.
    assert.ok(!types.includes("followup"), "completed action is not listed as open");
    const callEv = body.data.timeline.events.find((e) => e.type === "call");
    assert.match(callEv.summary, /outbound call/i);
    const offerEv = body.data.timeline.events.find((e) => e.type === "offer");
    assert.match(offerEv.summary, /\$150,000/);
  });

  await t.test("missing opportunityId is a 400", async () => {
    const { status, body } = await getTimeline(baseUrl, undefined);
    assert.equal(status, 400);
    assert.equal(body.error, "missing_opportunityId");
  });

  await t.test("unknown opportunity is a 404", async () => {
    const { status, body } = await getTimeline(baseUrl, "NOPE-0000");
    assert.equal(status, 404);
    assert.equal(body.error, "opportunity_not_found");
  });
});
