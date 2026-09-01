/**
 * Intake boundary authorization.
 *
 * Intake is the only write path in PIPELINE and is dispatched ahead of the
 * session/S2S branch, so these tests are the whole of its access control.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDb, testConfig, startApp } from "./helpers/temporaryDatabase.mjs";
import { openPipelineDatabase } from "../src/database/openDatabase.js";
import { createApp } from "../src/app/createApp.js";

const SECRET = "test-piper-intake-secret-0001";
const INTAKE = "/api/integrations/deal-findr/intake";

function post(baseUrl, body, headers = {}) {
  return fetch(`${baseUrl}${INTAKE}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function contractBody(overrides = {}) {
  return {
    contractVersion: "1.0",
    propertyId: "ocg_prop_test000000000000000001",
    sourceSystem: "HUNTER",
    sourceRecordId: "hunter-test-record-1",
    sourceTimestamp: "2026-09-01T18:00:00.000Z",
    address: "1 Contract Way",
    ...overrides,
  };
}

function opportunityCount(dbPath) {
  const db = openPipelineDatabase(dbPath);
  const { n } = db.prepare("SELECT COUNT(*) n FROM seller_opportunities").get();
  db.close();
  return n;
}

test("Intake refuses every unauthorized caller and writes nothing", async (t) => {
  const tempDb = makeTempDb();
  t.after(() => tempDb.cleanup());
  const { app, baseUrl } = await startApp(createApp, testConfig(tempDb.dbPath));
  t.after(() => app.server.close());
  const baseline = opportunityCount(tempDb.dbPath);

  await t.test("intake is disabled by default and fails closed", async () => {
    const res = await post(baseUrl, { address: "1 Closed Default Way" });
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.error, "piper_intake_disabled");
    assert.equal(opportunityCount(tempDb.dbPath), baseline);
  });

  await t.test("a valid secret does not help while the flag is off", async () => {
    const res = await post(baseUrl, { address: "2 Flag Off Way" }, { Authorization: `Bearer ${SECRET}` });
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error, "piper_intake_disabled");
    assert.equal(opportunityCount(tempDb.dbPath), baseline);
  });
});

test("Intake enabled: only a caller holding the secret may write", async (t) => {
  const tempDb = makeTempDb();
  t.after(() => tempDb.cleanup());

  const config = testConfig(tempDb.dbPath, {
    piperIntakeEnabled: true,
    piperIntakeSecret: SECRET,
    readOnly: false,
  });
  const { app, baseUrl } = await startApp(createApp, config);
  t.after(() => app.server.close());
  const baseline = opportunityCount(tempDb.dbPath);

  await t.test("missing Authorization header is rejected", async () => {
    const res = await post(baseUrl, { address: "10 No Header St" });
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error, "piper_intake_unauthorized");
    assert.equal(opportunityCount(tempDb.dbPath), baseline);
  });

  await t.test("wrong secret of equal length is rejected", async () => {
    const wrong = "x".repeat(SECRET.length);
    const res = await post(baseUrl, { address: "11 Wrong Secret St" }, { Authorization: `Bearer ${wrong}` });
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error, "piper_intake_unauthorized");
    assert.equal(opportunityCount(tempDb.dbPath), baseline);
  });

  await t.test("a correct prefix of the secret is rejected", async () => {
    const res = await post(baseUrl, { address: "12 Prefix St" }, { Authorization: `Bearer ${SECRET.slice(0, -1)}` });
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error, "piper_intake_unauthorized");
    assert.equal(opportunityCount(tempDb.dbPath), baseline);
  });

  await t.test("a non-Bearer scheme carrying the secret is rejected", async () => {
    const res = await post(baseUrl, { address: "13 Basic St" }, { Authorization: `Basic ${SECRET}` });
    assert.equal(res.status, 401);
    assert.equal(opportunityCount(tempDb.dbPath), baseline);
  });

  await t.test("every rejection returns the identical generic body", async () => {
    const bodies = [];
    for (const header of [undefined, `Bearer `, `Bearer nope`, `Bearer ${SECRET}x`]) {
      const res = await post(baseUrl, { address: "14 Uniform St" }, header ? { Authorization: header } : {});
      assert.equal(res.status, 401);
      bodies.push(JSON.stringify(await res.json()));
    }
    assert.equal(new Set(bodies).size, 1);
  });

  await t.test("authorized intake refuses to invent a property identity", async () => {
    const res = await post(
      baseUrl,
      { contractVersion: "1.0", sourceSystem: "HUNTER", sourceRecordId: "missing-property-id", address: "15 Missing Property Id St" },
      { Authorization: `Bearer ${SECRET}` },
    );
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, "missing_property_id");
    assert.equal(opportunityCount(tempDb.dbPath), baseline);
  });

  await t.test("authorized intake writes all six tables with supplied canonical property id", async () => {
    const propertyId = "ocg_prop_bayshore000000000001";
    const res = await post(
      baseUrl,
      contractBody({
        propertyId,
        sourceRecordId: "hunter-bayshore-1",
        address: "  4820   Bayshore  Blvd, Tampa FL 33611 ",
        apn: "A-77-4410",
        askingPrice: 315000,
        arv: 470000,
        rehab: 78000,
        sellerName: "Authorized Seller",
        phone: "813-555-0199",
        email: "authorized@example.com",
      }),
      { Authorization: `Bearer ${SECRET}` },
    );
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.duplicate, false);
    assert.equal(body.propertyId, propertyId);
    const id = body.opportunityId;
    assert.ok(id);

    const db = openPipelineDatabase(tempDb.dbPath);
    t.after(() => { try { db.close(); } catch {} });

    const opportunity = db.prepare("SELECT * FROM seller_opportunities WHERE id = ?").get(id);
    assert.ok(opportunity);
    assert.equal(opportunity.ocg_one_property_id, propertyId);
    assert.equal(opportunity.pipeline_stage, "new_lead");
    assert.equal(opportunity.asking_price, 315000);
    assert.equal(opportunity.created_by, "deal-findr");

    const source = db.prepare("SELECT * FROM seller_opportunity_sources WHERE opportunity_id = ?").get(id);
    assert.ok(source);
    assert.equal(source.original_address, "4820 bayshore blvd, tampa fl 33611");
    assert.equal(source.source_type, "deal_scout_handoff");
    assert.equal(source.source_record_id, "hunter-bayshore-1");

    const provenance = db.prepare("SELECT * FROM source_provenance WHERE opportunity_id = ?").get(id);
    assert.ok(provenance);
    assert.equal(provenance.resolution_status, "original_resolved");
    assert.equal(JSON.parse(provenance.original_source_json).propertyId, propertyId);

    const classification = db.prepare("SELECT * FROM record_classifications WHERE opportunity_id = ?").get(id);
    assert.ok(classification);
    assert.equal(classification.classification_value, "unknown");

    const history = db.prepare("SELECT * FROM classification_history WHERE opportunity_id = ?").all(id);
    assert.equal(history.length, 1);
    assert.equal(history[0].prior_classification, null);
    assert.equal(history[0].new_classification, "unknown");

    const audit = db.prepare("SELECT * FROM operational_audit_events WHERE event_type = 'DEAL_FINDR_INTAKE' AND payload_json LIKE ?").get(`%${id}%`);
    assert.ok(audit);
    assert.equal(audit.actor_id, "deal-findr");
    assert.equal(JSON.parse(audit.payload_json).propertyId, propertyId);
  });

  await t.test("duplicate reconciliation prioritizes canonical property id", async () => {
    const propertyId = "ocg_prop_reconcile0000000001";
    const first = await post(baseUrl, contractBody({ propertyId, sourceRecordId: "hunter-reconcile-1", address: "77 Reconcile Ave, Tampa FL" }), { Authorization: `Bearer ${SECRET}` });
    assert.equal(first.status, 201);
    const originalId = (await first.json()).opportunityId;

    const second = await post(baseUrl, contractBody({ propertyId, sourceRecordId: "hunter-reconcile-2", address: "Different Display Address" }), { Authorization: `Bearer ${SECRET}` });
    assert.equal(second.status, 200);
    const body = await second.json();
    assert.equal(body.duplicate, true);
    assert.equal(body.opportunityId, originalId);
    assert.equal(body.propertyId, propertyId);
    assert.equal(body.matchType, "property_id");
  });

  await t.test("no seller contact data is persisted anywhere", async () => {
    const db = openPipelineDatabase(tempDb.dbPath);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
    const needles = ["%813-555-0199%", "%authorized@example.com%", "%Authorized Seller%"];
    const leaks = [];
    for (const table of tables) {
      const columns = db.prepare(`PRAGMA table_info(${table})`).all().filter((c) => /TEXT|CHAR|CLOB|JSON/i.test(c.type || ""));
      for (const column of columns) {
        const { n } = db.prepare(`SELECT COUNT(*) n FROM "${table}" WHERE "${column.name}" LIKE ? OR "${column.name}" LIKE ? OR "${column.name}" LIKE ?`).get(...needles);
        if (n > 0) leaks.push(`${table}.${column.name}`);
      }
    }
    db.close();
    assert.deepEqual(leaks, []);
  });
});

test("Read-only mode blocks intake, and only after the caller authenticates", async (t) => {
  const tempDb = makeTempDb();
  t.after(() => tempDb.cleanup());
  const config = testConfig(tempDb.dbPath, { piperIntakeEnabled: true, piperIntakeSecret: SECRET, readOnly: true });
  const { app, baseUrl } = await startApp(createApp, config);
  t.after(() => app.server.close());
  const baseline = opportunityCount(tempDb.dbPath);

  await t.test("an authorized write is refused with read_only", async () => {
    const res = await post(baseUrl, contractBody({ address: "20 Read Only Rd" }), { Authorization: `Bearer ${SECRET}` });
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error, "read_only");
    assert.equal(opportunityCount(tempDb.dbPath), baseline);
  });

  await t.test("an anonymous caller cannot probe read-only state", async () => {
    const res = await post(baseUrl, { address: "21 Probe Rd" });
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error, "piper_intake_unauthorized");
  });
});

test("Intake still rejects non-POST methods before consulting authorization", async (t) => {
  const tempDb = makeTempDb();
  t.after(() => tempDb.cleanup());
  const config = testConfig(tempDb.dbPath, { piperIntakeEnabled: true, piperIntakeSecret: SECRET });
  const { app, baseUrl } = await startApp(createApp, config);
  t.after(() => app.server.close());

  for (const method of ["GET", "PUT", "DELETE", "PATCH"]) {
    const res = await fetch(`${baseUrl}${INTAKE}`, { method });
    assert.equal(res.status, 405, `${method} must be 405`);
    assert.equal(res.headers.get("allow"), "POST");
  }
});
