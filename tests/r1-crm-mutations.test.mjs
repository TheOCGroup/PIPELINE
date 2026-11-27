/**
 * R1 §4 — governed CRM mutation APIs.
 *
 * POST /api/integrations/crm/opportunities/:id/{stage|notes|update|contacts}
 * under the intake-class bearer. The central claim is provider-level
 * dedupe: a replayed mutationKey returns the stored result and performs NO
 * second mutation (stage-event count, note count, contact count, and the
 * opportunity's updated_at all stay frozen). Foreign ids are 404 and are
 * indistinguishable from nonexistent ids.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDb, testConfig, startApp } from "./helpers/temporaryDatabase.mjs";
import { createApp } from "../src/app/createApp.js";

const SECRET = "x".repeat(40);
const INTAKE_SECRET = "y".repeat(40);
const INTAKE_AUTH = { Authorization: `Bearer ${INTAKE_SECRET}` };
const A_ID = "opp-a-0001";
const B_ID = "opp-b-0001";
const GHOST_ID = "opp-ghost-0000";
const TS = "2026-10-31T00:00:00.000Z";

function config(dbPath, tenantId) {
  return testConfig(dbPath, {
    env: "production",
    operatorSecret: SECRET,
    operatorAuthEnabled: true,
    dataSource: "empty",
    tenantId,
    piperIntakeEnabled: true,
    piperIntakeSecret: INTAKE_SECRET,
    readOnly: false,
  });
}

async function api(baseUrl, method, path, body, headers = INTAKE_AUTH) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { raw: text };
  }
  return { status: res.status, body: parsed };
}

function seedOpp(db, id, tenantId) {
  db.prepare(
    `INSERT INTO seller_opportunities (id, tenant_id, opportunity_code, ocg_one_property_id,
       pipeline_stage, created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'new_lead', 'seed', 'seed', ?, ?)`
  ).run(id, tenantId, `OPP-${id}`, `prop-${id}`, TS, TS);
}

async function boot(t, tenantId = "tenant-a", dbPath = null) {
  const tempDb = dbPath ? null : makeTempDb();
  const path = dbPath || tempDb.dbPath;
  if (tempDb) t.after(() => tempDb.cleanup());
  const started = await startApp(createApp, config(path, tenantId));
  t.after(() => started.app.close());
  return { ...started, dbPath: path };
}

async function bootPair(t) {
  const started = await boot(t);
  seedOpp(started.app.db, A_ID, "tenant-a");
  seedOpp(started.app.db, B_ID, "tenant-b");
  return started;
}

const governed = (extra) => ({
  actor: "chatbot-governed-executor",
  approvalId: "appr-0001",
  ...extra,
});

test("stage move: executes once, writes stage event + audit + receipt; replay dedupes", async (t) => {
  const { app, baseUrl } = await bootPair(t);
  const req = governed({ mutationKey: "mk-stage-1", stage: "contacted" });
  const first = await api(baseUrl, "POST", `/api/integrations/crm/opportunities/${A_ID}/stage`, req);
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.equal(first.body.ok, true);
  assert.equal(first.body.duplicate, false);
  assert.equal(first.body.readback.stage, "contacted");
  assert.equal(first.body.readback.id, A_ID);

  const eventsAfterFirst = app.db.prepare(
    "SELECT COUNT(*) AS n FROM seller_stage_events WHERE opportunity_id = ?"
  ).get(A_ID).n;
  assert.equal(eventsAfterFirst, 1);
  const updatedAtAfterFirst = app.db.prepare(
    "SELECT updated_at FROM seller_opportunities WHERE id = ?"
  ).get(A_ID).updated_at;

  const audit = app.db.prepare(
    "SELECT * FROM operational_audit_events WHERE correlation_id = 'mk-stage-1'"
  ).get();
  assert.ok(audit, "audit row keyed by mutationKey exists");
  assert.ok(JSON.parse(audit.payload_json).approvalId === "appr-0001", "approvalId recorded on audit row");
  const receipt = app.db.prepare(
    "SELECT * FROM crm_mutation_receipts WHERE mutation_key = 'mk-stage-1'"
  ).get();
  assert.ok(receipt, "receipt row exists");
  assert.equal(receipt.tenant_id, "tenant-a");
  assert.equal(receipt.operation, "stage");

  // Provider-level dedupe: identical replay returns the stored result and
  // performs NO second mutation.
  const replay = await api(baseUrl, "POST", `/api/integrations/crm/opportunities/${A_ID}/stage`, req);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.duplicate, true);
  assert.equal(replay.body.readback.stage, "contacted");
  assert.equal(
    app.db.prepare("SELECT COUNT(*) AS n FROM seller_stage_events WHERE opportunity_id = ?").get(A_ID).n,
    1,
    "no second stage event on replay"
  );
  assert.equal(
    app.db.prepare("SELECT updated_at FROM seller_opportunities WHERE id = ?").get(A_ID).updated_at,
    updatedAtAfterFirst,
    "opportunity untouched on replay"
  );
});

test("stage rules: invalid_stage 400, reopen without reason 409, with reason succeeds", async (t) => {
  const { baseUrl } = await bootPair(t);
  const bad = await api(baseUrl, "POST", `/api/integrations/crm/opportunities/${A_ID}/stage`,
    governed({ mutationKey: "mk-bad-stage", stage: "not_a_stage" }));
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, "invalid_stage");

  const close = await api(baseUrl, "POST", `/api/integrations/crm/opportunities/${A_ID}/stage`,
    governed({ mutationKey: "mk-close", stage: "closed" }));
  assert.equal(close.status, 201);
  assert.equal(close.body.readback.status, "closed_purchased");

  const reopen = await api(baseUrl, "POST", `/api/integrations/crm/opportunities/${A_ID}/stage`,
    governed({ mutationKey: "mk-reopen", stage: "contacted" }));
  assert.equal(reopen.status, 409);
  assert.equal(reopen.body.error, "reopen_requires_reason");

  const reopenOk = await api(baseUrl, "POST", `/api/integrations/crm/opportunities/${A_ID}/stage`,
    governed({ mutationKey: "mk-reopen-2", stage: "contacted", reason: "seller re-engaged" }));
  assert.equal(reopenOk.status, 201);
  assert.equal(reopenOk.body.readback.stage, "contacted");
});

test("notes: append-only insert; replay with same key adds no second note", async (t) => {
  const { app, baseUrl } = await bootPair(t);
  const req = governed({ mutationKey: "mk-note-1", body: "Seller prefers evening calls." });
  const first = await api(baseUrl, "POST", `/api/integrations/crm/opportunities/${A_ID}/notes`, req);
  assert.equal(first.status, 201);
  assert.equal(first.body.duplicate, false);
  assert.ok(first.body.noteId);
  const replay = await api(baseUrl, "POST", `/api/integrations/crm/opportunities/${A_ID}/notes`, req);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.duplicate, true);
  assert.equal(replay.body.noteId, first.body.noteId);
  assert.equal(
    app.db.prepare("SELECT COUNT(*) AS n FROM operator_notes WHERE opportunity_id = ?").get(A_ID).n, 1);
});

test("update: allowlist enforced; invalid status refused; no receipt on validation failure", async (t) => {
  const { app, baseUrl } = await bootPair(t);
  const okRes = await api(baseUrl, "POST", `/api/integrations/crm/opportunities/${A_ID}/update`,
    governed({ mutationKey: "mk-upd-1", fields: { assignedAcquisitionManagerId: "mgr-7" } }));
  assert.equal(okRes.status, 201);
  assert.equal(okRes.body.readback.assignedOperator, "mgr-7");

  const replay = await api(baseUrl, "POST", `/api/integrations/crm/opportunities/${A_ID}/update`,
    governed({ mutationKey: "mk-upd-1", fields: { assignedAcquisitionManagerId: "mgr-7" } }));
  assert.equal(replay.status, 200);
  assert.equal(replay.body.duplicate, true);

  const disallowed = await api(baseUrl, "POST", `/api/integrations/crm/opportunities/${A_ID}/update`,
    governed({ mutationKey: "mk-upd-2", fields: { askingPrice: 1 } }));
  assert.equal(disallowed.status, 400);
  assert.equal(disallowed.body.error, "field_not_allowed");
  assert.equal(
    app.db.prepare("SELECT COUNT(*) AS n FROM crm_mutation_receipts WHERE mutation_key = 'mk-upd-2'").get().n,
    0,
    "validation failures leave no receipt"
  );

  const badStatus = await api(baseUrl, "POST", `/api/integrations/crm/opportunities/${A_ID}/update`,
    governed({ mutationKey: "mk-upd-3", fields: { opportunityStatus: "bogus" } }));
  assert.equal(badStatus.status, 400);
  assert.equal(badStatus.body.error, "invalid_opportunity_status");

  const goodStatus = await api(baseUrl, "POST", `/api/integrations/crm/opportunities/${A_ID}/update`,
    governed({ mutationKey: "mk-upd-4", fields: { opportunityStatus: "on_hold" } }));
  assert.equal(goodStatus.status, 201);
  assert.equal(goodStatus.body.readback.status, "on_hold");
});

test("contacts: upsert matches normalized email across keys; replay dedupes by key", async (t) => {
  const { app, baseUrl } = await bootPair(t);
  const first = await api(baseUrl, "POST", `/api/integrations/crm/opportunities/${A_ID}/contacts`,
    governed({ mutationKey: "mk-contact-1", name: "Sam Seller", email: "Sam@Example.com", phone: "316-555-0100" }));
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.equal(first.body.matched, false);
  const contactId = first.body.contactId;
  assert.ok(contactId);

  // Different mutationKey, same person (email case differs): upsert match,
  // no second contact row.
  const second = await api(baseUrl, "POST", `/api/integrations/crm/opportunities/${A_ID}/contacts`,
    governed({ mutationKey: "mk-contact-2", name: "Sam Seller", email: "sam@example.com" }));
  assert.equal(second.status, 201);
  assert.equal(second.body.matched, true);
  assert.equal(second.body.contactId, contactId);
  assert.equal(
    app.db.prepare("SELECT COUNT(*) AS n FROM pipeline_contacts").get().n, 1,
    "upsert created no duplicate contact");

  const replay = await api(baseUrl, "POST", `/api/integrations/crm/opportunities/${A_ID}/contacts`,
    governed({ mutationKey: "mk-contact-1", name: "Sam Seller", email: "Sam@Example.com", phone: "316-555-0100" }));
  assert.equal(replay.status, 200);
  assert.equal(replay.body.duplicate, true);
  assert.equal(
    app.db.prepare("SELECT COUNT(*) AS n FROM pipeline_contacts").get().n, 1);
});

test("foreign and ghost ids are the same 404; missing governed fields are 400; auth gates hold", async (t) => {
  const { baseUrl } = await bootPair(t);
  const foreign = await api(baseUrl, "POST", `/api/integrations/crm/opportunities/${B_ID}/stage`,
    governed({ mutationKey: "mk-foreign", stage: "contacted" }));
  const ghost = await api(baseUrl, "POST", `/api/integrations/crm/opportunities/${GHOST_ID}/stage`,
    governed({ mutationKey: "mk-ghost", stage: "contacted" }));
  assert.equal(foreign.status, 404);
  assert.deepEqual(foreign.body, ghost.body);

  const noKey = await api(baseUrl, "POST", `/api/integrations/crm/opportunities/${A_ID}/stage`,
    { actor: "a", approvalId: "ap", stage: "contacted" });
  assert.equal(noKey.status, 400);
  assert.equal(noKey.body.error, "missing_mutationKey");
  const noApproval = await api(baseUrl, "POST", `/api/integrations/crm/opportunities/${A_ID}/stage`,
    { mutationKey: "mk-x", actor: "a", stage: "contacted" });
  assert.equal(noApproval.status, 400);
  assert.equal(noApproval.body.error, "missing_approvalId");
  const noActor = await api(baseUrl, "POST", `/api/integrations/crm/opportunities/${A_ID}/stage`,
    { mutationKey: "mk-x", approvalId: "ap", stage: "contacted" });
  assert.equal(noActor.status, 400);
  assert.equal(noActor.body.error, "missing_actor");

  const unauthenticated = await api(baseUrl, "POST", `/api/integrations/crm/opportunities/${A_ID}/stage`,
    governed({ mutationKey: "mk-auth", stage: "contacted" }), {});
  assert.equal(unauthenticated.status, 401);
  const wrongSecret = await api(baseUrl, "POST", `/api/integrations/crm/opportunities/${A_ID}/stage`,
    governed({ mutationKey: "mk-auth", stage: "contacted" }), { Authorization: "Bearer wrong" });
  assert.equal(wrongSecret.status, 401);

  const get = await api(baseUrl, "GET", `/api/integrations/crm/opportunities/${A_ID}/stage`, undefined);
  assert.equal(get.status, 405);
});

test("receipts are tenant-scoped: tenant-b cannot replay tenant-a's mutationKey", async (t) => {
  const a = await bootPair(t);
  const first = await api(a.baseUrl, "POST", `/api/integrations/crm/opportunities/${A_ID}/stage`,
    governed({ mutationKey: "mk-shared", stage: "contacted" }));
  assert.equal(first.status, 201);
  a.app.close();

  // Same DB, deployment reconfigured as tenant-b: the same mutationKey
  // against B's OWN opportunity must execute fresh, not replay A's result.
  const b = await boot(t, "tenant-b", a.dbPath);
  const asB = await api(b.baseUrl, "POST", `/api/integrations/crm/opportunities/${B_ID}/stage`,
    governed({ mutationKey: "mk-shared", stage: "qualified" }));
  assert.equal(asB.status, 201, JSON.stringify(asB.body));
  assert.equal(asB.body.duplicate, false);
  assert.equal(asB.body.readback.stage, "qualified");
});
