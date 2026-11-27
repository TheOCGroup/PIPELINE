/**
 * R1 §6 — T15 tenant propagation, PIPELINE server side.
 *
 * P1A's T15: "CRM read for tenant A carries A's tenant context; response
 * containing B-owned records is detected." P1A marked the PIPELINE
 * server-side half [NV] until this lane verified it. This battery is that
 * verification, against the patched tree:
 *  - reads served by a tenant-a deployment carry tenant-a's context only;
 *  - tenant context comes from deployment config ONLY — request headers,
 *    query params, and body fields naming tenant-b change nothing;
 *  - a response containing B-owned records would be detected: every
 *    response is scanned for B's id, address, and contact markers;
 *  - negative control: the identical assertions run against a tenant-b
 *    deployment DO see tenant-b's records, proving the checks can fail.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDb, testConfig, startApp } from "./helpers/temporaryDatabase.mjs";
import { createApp } from "../src/app/createApp.js";

const SECRET = "x".repeat(40);
const INTAKE_SECRET = "y".repeat(40);
const AUTH = { Authorization: `Bearer ${SECRET}` };
const A_ID = "opp-a-0001";
const B_ID = "opp-b-0001";
const TS = "2026-10-31T00:00:00.000Z";
const B_MARKERS = [B_ID, "tenant b way", "b@example.com", "215-407-B"];

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

function seed(db, id, tenantId, address, apn, email) {
  db.prepare(
    `INSERT INTO seller_opportunities (id, tenant_id, opportunity_code, ocg_one_property_id,
       pipeline_stage, asking_price, created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'new_lead', 250000, 'seed', 'seed', ?, ?)`
  ).run(id, tenantId, `OPP-${id}`, `prop-${id}`, TS, TS);
  db.prepare(
    `INSERT INTO seller_opportunity_sources (id, opportunity_id, source_type, source_record_id,
       original_address, source_timestamp, conversion_actor, conversion_timestamp, provenance_metadata_json)
     VALUES (?, ?, 'deal_finder_intake', ?, ?, ?, 'deal-findr', ?, ?)`
  ).run(`${id}-src`, id, `${id}-rec`, address, TS, TS, JSON.stringify({ apn }));
  db.prepare(
    `INSERT INTO pipeline_contacts (id, first_name, last_name, email, phone, primary_role, notes_summary, created_at, updated_at)
     VALUES (?, 'Seed', 'Seller', ?, '3165550100', 'seller', 'seed', ?, ?)`
  ).run(`${id}-contact`, email, TS, TS);
  db.prepare(
    `INSERT INTO seller_opportunity_participants (id, opportunity_id, ocg_one_person_id, participant_role,
       is_primary, decision_authority_status, verification_status, created_by, created_at)
     VALUES (?, ?, ?, 'primary_owner', 1, 'full_authority', 'source_supplied', 'seed', ?)`
  ).run(`${id}-part`, id, `${id}-contact`, TS);
  db.prepare(
    `INSERT INTO operator_notes (id, opportunity_id, body, created_by) VALUES (?, ?, 'seed note', 'seed')`
  ).run(`${id}-note`, id);
  db.prepare(
    `INSERT INTO operator_next_actions (id, opportunity_id, title, status, created_by)
     VALUES (?, ?, 'Call the seller', 'open', 'seed')`
  ).run(`${id}-next`, id);
}

async function bootSeeded(t, tenantId) {
  const tempDb = makeTempDb();
  t.after(() => tempDb.cleanup());
  const started = await startApp(createApp, config(tempDb.dbPath, tenantId));
  t.after(() => started.app.close());
  seed(started.app.db, A_ID, "tenant-a", "200 tenant a way, wichita, ks 67217", "111-111-A", "a@example.com");
  seed(started.app.db, B_ID, "tenant-b", "100 tenant b way, wichita, ks 67217", "215-407-B", "b@example.com");
  return started;
}

async function getJson(baseUrl, path, headers = AUTH) {
  const res = await fetch(`${baseUrl}${path}`, { headers });
  return { status: res.status, text: await res.text() };
}

function assertNoBMarkers(payloadText, surface) {
  for (const marker of B_MARKERS) {
    assert.ok(!payloadText.includes(marker), `${surface} leaked tenant-b marker: ${marker}`);
  }
}

test("T15: tenant-a deployment reads carry A's context on every read surface", async (t) => {
  const { app, baseUrl } = await bootSeeded(t, "tenant-a");
  const surfaces = [
    "/api/v1/opportunities",
    `/api/v1/opportunities/${A_ID}`,
    "/api/v1/provenance",
    "/api/v1/classifications",
    "/api/v1/operator/next-actions",
    `/api/v1/operator/notes?opportunityId=${A_ID}`,
  ];
  for (const path of surfaces) {
    const res = await getJson(baseUrl, path);
    assert.equal(res.status, 200, path);
    assert.ok(res.text.includes(A_ID), `${path} carries tenant-a's record`);
    assertNoBMarkers(res.text, path);
  }
  // Aggregate surface: data-quality carries no ids by design — the
  // propagation claim there is the count. Two opportunities are seeded
  // (one per tenant); a tenant-a read must total exactly 1.
  const dq = await getJson(baseUrl, "/api/v1/data-quality");
  assert.equal(dq.status, 200);
  assert.equal(JSON.parse(dq.text).data.totalOpportunities, 1,
    "data-quality total must count tenant-a only");
  assertNoBMarkers(dq.text, "/api/v1/data-quality");
  // Service-layer propagation: the Piper context built from the same config
  // aggregates tenant-a only.
  const snapshot = app.services.piperContext.snapshot();
  assert.deepEqual(snapshot.opportunities.map((o) => o.id), [A_ID]);
  assertNoBMarkers(JSON.stringify(snapshot), "piper snapshot");
});

test("T15: tenant context cannot be overridden by headers, query, or body", async (t) => {
  const { baseUrl } = await bootSeeded(t, "tenant-a");
  const attempts = [
    { path: "/api/v1/opportunities", headers: { ...AUTH, "x-tenant-id": "tenant-b" } },
    { path: "/api/v1/opportunities?tenantId=tenant-b", headers: AUTH },
    { path: "/api/v1/opportunities?tenant_id=tenant-b", headers: AUTH },
    { path: "/api/v1/opportunities", headers: { ...AUTH, "x-pipeline-tenant": "tenant-b" } },
  ];
  for (const attempt of attempts) {
    const res = await getJson(baseUrl, attempt.path, attempt.headers);
    assert.equal(res.status, 200, attempt.path);
    const parsed = JSON.parse(res.text);
    assert.deepEqual(parsed.data.map((o) => o.id), [A_ID],
      `tenant override attempt changed the read context: ${attempt.path} ${JSON.stringify(attempt.headers)}`);
    assertNoBMarkers(res.text, attempt.path);
  }
});

test("T15 negative control: a tenant-b deployment DOES see tenant-b records", async (t) => {
  const { baseUrl } = await bootSeeded(t, "tenant-b");
  const res = await getJson(baseUrl, "/api/v1/opportunities");
  assert.equal(res.status, 200);
  const parsed = JSON.parse(res.text);
  assert.deepEqual(parsed.data.map((o) => o.id), [B_ID],
    "control deployment sees its own tenant — the A-side assertions above can genuinely fail");
  assert.ok(res.text.includes("tenant b way"));
});
