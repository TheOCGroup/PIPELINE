/**
 * Intake boundary authorization.
 *
 * Intake is the only write path in PIPELINE and is dispatched ahead of the
 * session/S2S branch, so these tests are the whole of its access control.
 * They assert refusals do not write, that an authorized caller keeps the exact
 * behaviour verified before the gate existed, and that an anonymous caller
 * cannot learn the deployment's read-only posture.
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

/** Rows written by intake, counted straight from the database. */
function opportunityCount(dbPath) {
  const db = openPipelineDatabase(dbPath);
  const { n } = db.prepare("SELECT COUNT(*) n FROM seller_opportunities").get();
  db.close();
  return n;
}

test("Intake refuses every unauthorized caller and writes nothing", async (t) => {
  const tempDb = makeTempDb();
  t.after(() => tempDb.cleanup());

  // Deliberately no piperIntake* keys: the default posture must be closed.
  const { app, baseUrl } = await startApp(createApp, testConfig(tempDb.dbPath));
  t.after(() => app.server.close());

  const baseline = opportunityCount(tempDb.dbPath);

  await t.test("intake is disabled by default and fails closed", async () => {
    const res = await post(baseUrl, { address: "1 Closed Default Way" });
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.error, "piper_intake_disabled");
    assert.equal(opportunityCount(tempDb.dbPath), baseline, "disabled intake must not write");
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
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.error, "piper_intake_unauthorized");
    assert.equal(opportunityCount(tempDb.dbPath), baseline, "rejected intake must not write");
  });

  await t.test("wrong secret of equal length is rejected", async () => {
    const wrong = "x".repeat(SECRET.length);
    const res = await post(baseUrl, { address: "11 Wrong Secret St" }, { Authorization: `Bearer ${wrong}` });
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error, "piper_intake_unauthorized");
    assert.equal(opportunityCount(tempDb.dbPath), baseline);
  });

  await t.test("a correct prefix of the secret is rejected", async () => {
    // Guards against a truncating or prefix comparison.
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
    assert.equal(new Set(bodies).size, 1, "responses must not distinguish how wrong the secret was");
  });

  await t.test("authorized intake writes all six tables", async () => {
    const res = await post(
      baseUrl,
      {
        address: "  4820   Bayshore  Blvd, Tampa FL 33611 ",
        apn: "A-77-4410",
        askingPrice: 315000,
        arv: 470000,
        rehab: 78000,
        sellerName: "Authorized Seller",
        phone: "813-555-0199",
        email: "authorized@example.com",
      },
      { Authorization: `Bearer ${SECRET}` }
    );
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.duplicate, false);
    const id = body.opportunityId;
    assert.ok(id);

    const db = openPipelineDatabase(tempDb.dbPath);
    t.after(() => { try { db.close(); } catch { /* already closed */ } });

    const opportunity = db.prepare("SELECT * FROM seller_opportunities WHERE id = ?").get(id);
    assert.ok(opportunity, "seller_opportunities");
    assert.equal(opportunity.pipeline_stage, "new_lead");
    assert.equal(opportunity.asking_price, 315000);
    assert.equal(opportunity.created_by, "deal-findr");

    const source = db.prepare("SELECT * FROM seller_opportunity_sources WHERE opportunity_id = ?").get(id);
    assert.ok(source, "seller_opportunity_sources");
    assert.equal(source.original_address, "4820 bayshore blvd, tampa fl 33611", "address is normalized");
    assert.equal(source.source_type, "deal_scout_handoff");

    const provenance = db.prepare("SELECT * FROM source_provenance WHERE opportunity_id = ?").get(id);
    assert.ok(provenance, "source_provenance");
    assert.equal(provenance.resolution_status, "original_resolved");

    const classification = db.prepare("SELECT * FROM record_classifications WHERE opportunity_id = ?").get(id);
    assert.ok(classification, "record_classifications");
    assert.equal(classification.classification_value, "investment_rehab");

    const history = db.prepare("SELECT * FROM classification_history WHERE opportunity_id = ?").all(id);
    assert.equal(history.length, 1, "classification_history: exactly one initial row");
    assert.equal(history[0].prior_classification, null);
    assert.equal(history[0].new_classification, "investment_rehab");

    const audit = db
      .prepare("SELECT * FROM operational_audit_events WHERE event_type = 'DEAL_FINDR_INTAKE' AND payload_json LIKE ?")
      .get(`%${id}%`);
    assert.ok(audit, "operational_audit_events");
    assert.equal(audit.actor_id, "deal-findr");
  });

  await t.test("duplicate reconciliation still works for an authorized caller", async () => {
    const first = await post(baseUrl, { address: "77 Reconcile Ave, Tampa FL" }, { Authorization: `Bearer ${SECRET}` });
    assert.equal(first.status, 201);
    const originalId = (await first.json()).opportunityId;

    // Same address, different case and spacing.
    const second = await post(baseUrl, { address: "  77   RECONCILE   AVE,  TAMPA FL " }, { Authorization: `Bearer ${SECRET}` });
    assert.equal(second.status, 200);
    const body = await second.json();
    assert.equal(body.duplicate, true);
    assert.equal(body.opportunityId, originalId, "duplicate resolves to the original opportunity");

    const db = openPipelineDatabase(tempDb.dbPath);
    const { n } = db
      .prepare("SELECT COUNT(*) n FROM seller_opportunity_sources WHERE LOWER(original_address) = ?")
      .get("77 reconcile ave, tampa fl");
    db.close();
    assert.equal(n, 1, "duplicate must not create a second source row");
  });

  await t.test("no seller contact data is persisted anywhere", async () => {
    const db = openPipelineDatabase(tempDb.dbPath);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
    const needles = ["%813-555-0199%", "%authorized@example.com%", "%Authorized Seller%"];
    const leaks = [];

    for (const table of tables) {
      const columns = db
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .filter((c) => /TEXT|CHAR|CLOB|JSON/i.test(c.type || ""));
      for (const column of columns) {
        const { n } = db
          .prepare(`SELECT COUNT(*) n FROM "${table}" WHERE "${column.name}" LIKE ? OR "${column.name}" LIKE ? OR "${column.name}" LIKE ?`)
          .get(...needles);
        if (n > 0) leaks.push(`${table}.${column.name}`);
      }
    }
    db.close();
    assert.deepEqual(leaks, [], "PIPELINE must hold no seller contact details");
  });
});

test("Read-only mode blocks intake, and only after the caller authenticates", async (t) => {
  const tempDb = makeTempDb();
  t.after(() => tempDb.cleanup());

  const config = testConfig(tempDb.dbPath, {
    piperIntakeEnabled: true,
    piperIntakeSecret: SECRET,
    readOnly: true,
  });
  const { app, baseUrl } = await startApp(createApp, config);
  t.after(() => app.server.close());

  const baseline = opportunityCount(tempDb.dbPath);

  await t.test("an authorized write is refused with read_only", async () => {
    const res = await post(baseUrl, { address: "20 Read Only Rd" }, { Authorization: `Bearer ${SECRET}` });
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.error, "read_only");
    assert.equal(opportunityCount(tempDb.dbPath), baseline, "read-only intake must not write");
  });

  await t.test("an anonymous caller cannot probe read-only state", async () => {
    // Must be indistinguishable from a writable deployment: 401, never read_only.
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
