/**
 * R1 S2 battery — the nine isolation cases authored in S2 §2, executed
 * against the PATCHED tree (Patches A/B/C applied).
 *
 * Two synthetic tenants share one disposable SQLite DB. The app is
 * configured tenant-a; tenant-b rows are seeded directly. Every case is
 * written so it can FAIL: Patch A cases fail against the unpatched convert
 * handler, the Patch B case fails against the unpatched work-room list(),
 * and the Patch C case inspects the rows the snapshot's auxiliary queries
 * actually return (failing against the unpatched full-table scans).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { SignJWT, importPKCS8 } from "jose";
import { makeTempDb, testConfig, startApp } from "./helpers/temporaryDatabase.mjs";
import { createApp } from "../src/app/createApp.js";
import { createAgentWorkRoomService } from "../src/services/agentWorkRoomService.js";
import { PiperContextService } from "../src/services/piperContextService.js";

const SECRET = "x".repeat(40);
const INTAKE_SECRET = "y".repeat(40);
const AUTH = { Authorization: `Bearer ${SECRET}` };
const INTAKE_AUTH = { Authorization: `Bearer ${INTAKE_SECRET}` };

const A_ID = "opp-a-0001";
const B_ID = "opp-b-0001";
const GHOST_ID = "opp-ghost-0000";
const A_ADDRESS = "200 tenant a way, wichita, ks 67217";
const B_ADDRESS = "100 tenant b way, wichita, ks 67217";
const A_APN = "111-111-A";
const B_APN = "215-407-B";
const TS = "2026-10-31T00:00:00.000Z";

function tenantConfig(dbPath, tenantId, extra = {}) {
  return testConfig(dbPath, {
    env: "production",
    operatorSecret: SECRET,
    operatorAuthEnabled: true,
    dataSource: "empty",
    tenantId,
    piperIntakeEnabled: true,
    piperIntakeSecret: INTAKE_SECRET,
    readOnly: false,
    ...extra,
  });
}

async function api(baseUrl, method, path, body, headers = AUTH) {
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

/** Full seed for one tenant: opportunity + source, provenance,
 *  classification (+history), note, checklist, interaction, next-action,
 *  stage event, communication + event, primary contact + participant. */
function seedFull(db, { id, tenantId, code, address, apn, sourceRecordId, email }) {
  db.prepare(
    `INSERT INTO seller_opportunities (id, tenant_id, opportunity_code, ocg_one_property_id,
       pipeline_stage, asking_price, created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'new_lead', 250000, 'seed', 'seed', ?, ?)`
  ).run(id, tenantId, code, `prop-${id}`, TS, TS);
  db.prepare(
    `INSERT INTO seller_opportunity_sources (id, opportunity_id, source_type, source_record_id,
       original_address, source_timestamp, conversion_actor, conversion_timestamp, provenance_metadata_json)
     VALUES (?, ?, 'deal_finder_intake', ?, ?, ?, 'deal-findr', ?, ?)`
  ).run(`${id}-src`, id, sourceRecordId, address, TS, TS, JSON.stringify({ apn }));
  db.prepare(
    `INSERT INTO source_provenance (id, opportunity_id, original_source_json, resolution_status)
     VALUES (?, ?, '{}', 'original_resolved')`
  ).run(`${id}-prov`, id);
  db.prepare(
    `INSERT INTO record_classifications (opportunity_id, classification_value, classification_rules_version, determined_by, reason)
     VALUES (?, 'wholesale_target', '1.0.0', 'seed', 'seeded classification')`
  ).run(id);
  db.prepare(
    `INSERT INTO classification_history (id, opportunity_id, prior_classification, new_classification,
       classification_rules_version, determined_by, reason)
     VALUES (?, ?, NULL, 'wholesale_target', '1.0.0', 'seed', 'seeded classification')`
  ).run(`${id}-clsh`, id);
  db.prepare(
    `INSERT INTO operator_notes (id, opportunity_id, body, created_by) VALUES (?, ?, 'seed note', 'seed')`
  ).run(`${id}-note`, id);
  db.prepare(
    `INSERT INTO operator_checklist_items (id, opportunity_id, item_key, label, is_checked, updated_by)
     VALUES (?, ?, 'title_search', 'Title search', 0, 'seed')`
  ).run(`${id}-chk`, id);
  db.prepare(
    `INSERT INTO seller_interactions (id, opportunity_id, channel, direction, occurred_at, summary, created_by)
     VALUES (?, ?, 'phone', 'outbound', ?, 'seed call', 'seed')`
  ).run(`${id}-int`, id, TS);
  db.prepare(
    `INSERT INTO operator_next_actions (id, opportunity_id, title, status, created_by)
     VALUES (?, ?, 'Call the seller', 'open', 'seed')`
  ).run(`${id}-next`, id);
  db.prepare(
    `INSERT INTO seller_stage_events (id, opportunity_id, prior_stage, new_stage, changed_by, reason)
     VALUES (?, ?, NULL, 'new_lead', 'seed', 'seeded')`
  ).run(`${id}-stage`, id);
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
    `INSERT INTO seller_communications (id, opportunity_id, offer_version_id, recipient_person_id,
       recipient_value_snapshot, recipient_channel, recipient_verification_status, direction,
       subject, content_text, in_reply_to_communication_id, created_by, created_at)
     VALUES (?, ?, NULL, ?, ?, 'email', 'SOURCE_SUPPLIED', 'outbound', 'Seed subject', 'Seed body', NULL, 'seed', ?)`
  ).run(`${id}-comm`, id, `${id}-contact`, email, TS);
  db.prepare(
    `INSERT INTO seller_communication_events (id, communication_id, event_type, actor_id, provider_ref, outcome, occurred_at)
     VALUES (?, ?, 'drafted', 'seed', NULL, NULL, ?)`
  ).run(`${id}-commev`, `${id}-comm`, TS);
}

async function bootPair(t, extra = {}) {
  const tempDb = makeTempDb();
  t.after(() => tempDb.cleanup());
  const started = await startApp(createApp, tenantConfig(tempDb.dbPath, "tenant-a", extra));
  t.after(() => started.app.close());
  seedFull(started.app.db, {
    id: A_ID, tenantId: "tenant-a", code: "OPP-A001",
    address: A_ADDRESS, apn: A_APN, sourceRecordId: "A-REC-1", email: "a@example.com",
  });
  seedFull(started.app.db, {
    id: B_ID, tenantId: "tenant-b", code: "OPP-B001",
    address: B_ADDRESS, apn: B_APN, sourceRecordId: "B-REC-1", email: "b@example.com",
  });
  return started;
}

test("S2-T1 list/get: tenant-a list contains A only; getById(B) is a plain not-found", async (t) => {
  const { baseUrl } = await bootPair(t);
  const list = await api(baseUrl, "GET", "/api/v1/opportunities");
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.data.map((o) => o.id), [A_ID]);

  const foreign = await api(baseUrl, "GET", `/api/v1/opportunities/${B_ID}`);
  const ghost = await api(baseUrl, "GET", `/api/v1/opportunities/${GHOST_ID}`);
  assert.equal(foreign.status, 404);
  assert.equal(foreign.status, ghost.status);
  assert.equal(foreign.body.error, ghost.body.error);
});

test("S2-T2 search + pagination: q matching only B returns zero items and total 0", async (t) => {
  const { baseUrl } = await bootPair(t);
  // Control: q DOES search the address field (A's token finds A).
  const control = await api(baseUrl, "GET", "/api/v1/opportunities?q=tenant%20a%20way");
  assert.equal(control.status, 200);
  assert.deepEqual(control.body.data.map((o) => o.id), [A_ID]);

  const search = await api(baseUrl, "GET", "/api/v1/opportunities?q=tenant%20b%20way");
  assert.equal(search.status, 200);
  assert.equal(search.body.data.length, 0);
  const total = search.body.meta?.pagination?.total ?? search.body.total;
  assert.equal(total, 0, `expected total 0, body: ${JSON.stringify(search.body).slice(0, 300)}`);
});

test("S2-T3 aggregates exclude B entirely (data-quality, classifications, provenance)", async (t) => {
  const { baseUrl } = await bootPair(t);
  for (const path of ["/api/v1/classifications", "/api/v1/provenance"]) {
    const res = await api(baseUrl, "GET", path);
    assert.equal(res.status, 200, path);
    const serialized = JSON.stringify(res.body);
    assert.ok(serialized.includes(A_ID), `${path} includes tenant-a`);
    assert.ok(!serialized.includes(B_ID), `${path} must not include tenant-b id`);
    assert.ok(!serialized.includes("tenant b way"), `${path} must not include tenant-b address`);
    assert.ok(!serialized.includes("b@example.com"), `${path} must not include tenant-b contact`);
  }
  const dq = await api(baseUrl, "GET", "/api/v1/data-quality");
  assert.equal(dq.status, 200);
  assert.equal(dq.body.data.totalOpportunities, 1, "data-quality counts tenant-a only");
  assert.ok(!JSON.stringify(dq.body).includes(B_ID));
});

test("S2-T4 operator surface: foreign reads are empty/null; next-actions list is A only", async (t) => {
  const { app, baseUrl } = await bootPair(t);
  const notes = await api(baseUrl, "GET", `/api/v1/operator/notes?opportunityId=${B_ID}`);
  assert.deepEqual(notes.body.data.notes, []);
  const offers = await api(baseUrl, "GET", `/api/v1/operator/offers?opportunityId=${B_ID}`);
  assert.deepEqual(offers.body.data.offers, []);
  const outreach = await api(baseUrl, "GET", `/api/v1/operator/outreach?opportunityId=${B_ID}`);
  assert.deepEqual(outreach.body.data.communications, []);
  const nextActions = await api(baseUrl, "GET", "/api/v1/operator/next-actions");
  assert.deepEqual(nextActions.body.data.nextActions.map((a) => a.opportunityId), [A_ID]);
  // Service-level: a foreign communication id resolves exactly like a missing one.
  assert.equal(app.services.operator.getCommunication(`${B_ID}-comm`), null);
  assert.ok(app.services.operator.getCommunication(`${A_ID}-comm`) !== null);
});

test("S2-T5 convert (Patch A): cross-tenant source lead and idempotency key never leak", async (t) => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pubPem = publicKey.export({ type: "spki", format: "pem" });
  const privPem = privateKey.export({ type: "pkcs8", format: "pem" });
  const convertExtra = {
    integrationEnabled: true,
    servicePublicKeys: { r1kid: pubPem },
    handoffIssuer: "ocg-one",
    handoffAudience: "pipeline",
  };
  async function convertToken() {
    const key = await importPKCS8(privPem, "RS256");
    return new SignJWT({
      method: "POST",
      path: "/api/v1/opportunities/convert",
      contract_version: "1.0.0",
      scope: "pipeline.opportunity.create",
    })
      .setProtectedHeader({ alg: "RS256", kid: "r1kid", typ: "JWT" })
      .setIssuer("ocg-one")
      .setAudience("pipeline")
      .setIssuedAt()
      .setExpirationTime("60s")
      .sign(key);
  }
  const convertBody = (idempotencyKey, sourceLeadId) => ({
    idempotencyKey,
    correlationId: `corr-${idempotencyKey}`,
    sourceLeadId,
    sourceSystem: "ocg_one_lead",
    property: { externalId: `prop-${sourceLeadId}`, address: "1 Convert Way, Wichita, KS" },
    participants: [{ externalId: `person-${sourceLeadId}`, role: "primary_owner" }],
  });

  const tempDb = makeTempDb();
  t.after(() => tempDb.cleanup());

  // Tenant-b converts lead L-1 first.
  const bStart = await startApp(createApp, tenantConfig(tempDb.dbPath, "tenant-b", convertExtra));
  const bToken = await convertToken();
  let bOppId;
  try {
    const bRes = await api(bStart.baseUrl, "POST", "/api/v1/opportunities/convert",
      convertBody("idem-b-1", "L-1"), { Authorization: `Bearer ${bToken}` });
    assert.equal(bRes.status, 201, JSON.stringify(bRes.body));
    bOppId = bRes.body.opportunityId;
    assert.ok(bOppId);
  } finally {
    bStart.app.close();
  }

  // Tenant-a, SAME database.
  const aStart = await startApp(createApp, tenantConfig(tempDb.dbPath, "tenant-a", convertExtra));
  t.after(() => aStart.app.close());
  const aToken = await convertToken();
  const aAuth = { Authorization: `Bearer ${aToken}` };

  // (a) Same source lead, A's own key: must create a NEW tenant-a opportunity,
  //     never return B's id as already_converted. (Fails pre-patch.)
  const a1 = await api(aStart.baseUrl, "POST", "/api/v1/opportunities/convert",
    convertBody("idem-a-1", "L-1"), aAuth);
  assert.equal(a1.status, 201, JSON.stringify(a1.body));
  assert.equal(a1.body.status, "converted");
  assert.notEqual(a1.body.opportunityId, bOppId);

  // (b) B's idempotency key replayed by A with a fresh lead: must NOT return
  //     B's conversion from the audit log. (Fails pre-patch.)
  const a2 = await api(aStart.baseUrl, "POST", "/api/v1/opportunities/convert",
    convertBody("idem-b-1", "L-2"), aAuth);
  assert.equal(a2.status, 201, JSON.stringify(a2.body));
  assert.notEqual(a2.body.opportunityId, bOppId);
  assert.notEqual(a2.body.opportunityId, a1.body.opportunityId);

  // (c) Own-tenant idempotency still works: replaying A's key returns A's id.
  const a3 = await api(aStart.baseUrl, "POST", "/api/v1/opportunities/convert",
    convertBody("idem-a-1", "L-1"), aAuth);
  assert.equal(a3.status, 200);
  assert.equal(a3.body.status, "already_converted");
  assert.equal(a3.body.opportunityId, a1.body.opportunityId);

  // (d) Own-tenant source dedupe still works with a fresh key.
  const a4 = await api(aStart.baseUrl, "POST", "/api/v1/opportunities/convert",
    convertBody("idem-a-2", "L-1"), aAuth);
  assert.equal(a4.status, 200);
  assert.equal(a4.body.opportunityId, a1.body.opportunityId);
});

test("S2-T6 work-room (Patch B): unfiltered list drops foreign-linked tasks only", async (t) => {
  const { app } = await bootPair(t);
  const roomA = createAgentWorkRoomService(app.db, "tenant-a");
  const roomB = createAgentWorkRoomService(app.db, "tenant-b");
  const taskA = roomA.create({ department: "acq", title: "A task", director: "Aiden", opportunityId: A_ID });
  const taskB = roomB.create({ department: "acq", title: "B task", director: "Aiden", opportunityId: B_ID });
  const taskU = roomA.create({ department: "acq", title: "Unlinked task", director: "Aiden" });

  const listAll = roomA.list({});
  const ids = listAll.map((x) => x.id);
  assert.ok(ids.includes(taskA.id), "own task listed");
  assert.ok(ids.includes(taskU.id), "unlinked task remains listed (documented semantics)");
  assert.ok(!ids.includes(taskB.id), "foreign-linked task must not be listed"); // fails pre-patch
  const listByState = roomA.list({ state: "queued" });
  assert.ok(!listByState.map((x) => x.id).includes(taskB.id), "state-filtered list also drops foreign task");
  assert.equal(roomA.get(taskB.id), null);
  // Negative control: the check can fail — B's own service DOES list the task.
  assert.ok(roomB.list({}).map((x) => x.id).includes(taskB.id));
});

test("S2-T7 Piper snapshot (Patch C): auxiliary loads return tenant-a rows only", async (t) => {
  const { app } = await bootPair(t);
  // Instrument the db handle: record every .all() result set with its SQL.
  const recorded = [];
  const spyDb = {
    prepare(sql) {
      const stmt = app.db.prepare(sql);
      return {
        get: (...args) => stmt.get(...args),
        all: (...args) => {
          const rows = stmt.all(...args);
          recorded.push({ sql, rows });
          return rows;
        },
        run: (...args) => stmt.run(...args),
      };
    },
    exec: (...args) => app.db.exec(...args),
  };
  const svc = new PiperContextService(spyDb, { tenantId: "tenant-a" });
  const snapshot = svc.snapshot();
  assert.deepEqual(snapshot.opportunities.map((o) => o.id), [A_ID]);

  // Patch C covers exactly seven auxiliary loads in snapshot(). Identify
  // each by a distinctive fragment and assert (a) the tenant predicate is
  // in the SQL and (b) no tenant-b row crosses the db boundary. (#recent()'s
  // tail queries post-filter in memory by design — S2 scoped Patch C to the
  // snapshot() loads — so the snapshot serialization itself is scanned as
  // the emission backstop for the whole surface.)
  const PATCH_C_LOADS = [
    "FROM operator_next_actions",
    "MAX(created_at) AS at FROM seller_stage_events",
    "MAX(occurred_at) AS at, COUNT(*) AS n",
    "FROM operator_notes",
    "recipient_value_snapshot",
    "FROM seller_communication_events",
    "FROM seller_opportunity_participants p",
  ];
  const seen = new Set();
  for (const { sql, rows } of recorded) {
    const fragment = PATCH_C_LOADS.find((f) => sql.includes(f));
    if (!fragment) continue;
    seen.add(fragment);
    assert.ok(sql.includes("tenant_id = ?"),
      `Patch C load lacks the tenant predicate (${fragment}): ${sql.slice(0, 120)}`);
    for (const row of rows) {
      assert.notEqual(row.opportunity_id, B_ID,
        `Patch C load leaked a tenant-b row (${fragment})`);
      assert.notEqual(row.communication_id, `${B_ID}-comm`,
        `Patch C load leaked tenant-b communication events (${fragment})`);
      assert.notEqual(row.email, "b@example.com",
        `Patch C load loaded tenant-b contact PII (${fragment})`);
    }
  }
  assert.deepEqual([...seen].sort(), [...PATCH_C_LOADS].sort(),
    "all seven Patch C loads were exercised");
  const serialized = JSON.stringify(snapshot);
  for (const marker of [B_ID, "tenant b way", "b@example.com"]) {
    assert.ok(!serialized.includes(marker), `snapshot emission leaked: ${marker}`);
  }
});

test("S2-T8 foreign id == nonexistent id on timeline, committee, dispositions, transactions", async (t) => {
  const { app, baseUrl } = await bootPair(t);
  const strip = (b) => { const c = JSON.parse(JSON.stringify(b)); if (c.meta) delete c.meta.correlationId; return c; };
  const timelineB = await api(baseUrl, "GET", `/api/v1/operator/timeline?opportunityId=${B_ID}`);
  const timelineG = await api(baseUrl, "GET", `/api/v1/operator/timeline?opportunityId=${GHOST_ID}`);
  assert.equal(timelineB.status, timelineG.status);
  assert.deepEqual(strip(timelineB.body), strip(timelineG.body));

  const committeeB = await api(baseUrl, "GET", `/api/v1/investment-committee?opportunityId=${B_ID}`);
  const committeeG = await api(baseUrl, "GET", `/api/v1/investment-committee?opportunityId=${GHOST_ID}`);
  assert.equal(committeeB.status, committeeG.status);
  assert.deepEqual(strip(committeeB.body), strip(committeeG.body));

  const dispB = await api(baseUrl, "GET", `/api/v1/operator/dispositions?opportunityId=${B_ID}`);
  const dispG = await api(baseUrl, "GET", `/api/v1/operator/dispositions?opportunityId=${GHOST_ID}`);
  assert.equal(dispB.status, dispG.status);
  assert.deepEqual(strip(dispB.body), strip(dispG.body));

  assert.deepEqual(app.services.transactions.listMilestones(B_ID), app.services.transactions.listMilestones(GHOST_ID));
  assert.deepEqual(app.services.transactions.listTasks(B_ID), app.services.transactions.listTasks(GHOST_ID));
});

test("S2-T9 intake dedupe: same APN/address/sourceRecordId under both tenants stay distinct", async (t) => {
  const { app, baseUrl } = await bootPair(t);
  const intake = (payload) =>
    api(baseUrl, "POST", "/api/integrations/deal-findr/intake", payload, INTAKE_AUTH);

  // B's exact APN + address + source record id, presented to tenant-a's intake.
  const created = await intake({ address: "100 Tenant B Way, Wichita, KS 67217", apn: B_APN });
  assert.equal(created.status, 201);
  assert.equal(created.body.duplicate, false);
  assert.notEqual(created.body.opportunityId, B_ID);
  const row = app.db.prepare("SELECT tenant_id FROM seller_opportunities WHERE id = ?")
    .get(created.body.opportunityId);
  assert.equal(row.tenant_id, "tenant-a");

  const byRecord = await intake({
    property: { id: "B-REC-1", address: "555 Victor Way, Wichita, KS 67203" },
    underwriting: { arv: 310000, renovationBudget: 40000, mao: 170000, confidenceScore: 0.8, analysisStatus: "completed" },
    packageId: "pkg-r1-t9",
    timestamp: TS,
  });
  assert.equal(byRecord.status, 201);
  assert.equal(byRecord.body.duplicate, false);
  assert.notEqual(byRecord.body.opportunityId, B_ID);
  assert.notEqual(byRecord.body.opportunityId, created.body.opportunityId);
});
