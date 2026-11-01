/**
 * PIPER -> ONCALL governed callback — client, tool gate, and runtime gate.
 *
 * What is under test is the governance wiring, not any model's quality:
 *
 *   - the bridge capability is DISABLED unless explicitly configured, and a
 *     disabled client never touches the network
 *   - a call request without an approval reference is refused before the
 *     network — by the client, and again by the tool layer, where a
 *     model-supplied approvalRef in tool arguments is never read
 *   - the tool executes only from the runtime's operator-approval path, and
 *     the approval reference ONCALL receives is derived from that approval
 *   - the destination is PIPELINE's recorded seller phone; a phone number in
 *     tool arguments is ignored
 *   - ONCALL's verdicts map to honest typed states: queued is not contacted,
 *     policy_denied surfaces its reasons, and the unprovisioned PIPER voice
 *     profile is a distinct state that is reported, never retried around
 */

import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDb, testConfig } from "./helpers/temporaryDatabase.mjs";
import { openPipelineDatabase } from "../src/database/openDatabase.js";
import { createApp } from "../src/app/createApp.js";
import { loadConfig } from "../src/config/environment.js";
import { OncallCommsClient, summarizeCallStatus } from "../src/integrations/oncall/oncallCommsClient.js";
import { executeTool, isWriteTool, isKnownTool } from "../src/services/piper/toolRegistry.js";
import { PiperRuntime } from "../src/services/piper/piperRuntime.js";
import { PiperContextService } from "../src/services/piperContextService.js";
import { SqliteOperatorRepository } from "../src/repositories/sqlite/sqliteOperatorRepository.js";

const SECRET = "bridge-secret-for-tests";
const BASE = "http://oncall.test";

/** A fetch stand-in that records every call and answers from a script. */
function stubFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    const record = {
      url,
      method: opts.method || "GET",
      headers: opts.headers || {},
      body: opts.body ? JSON.parse(opts.body) : null,
    };
    calls.push(record);
    const r = handler(record, calls.length);
    return { status: r.status, json: async () => r.body };
  };
  return { calls, fetchImpl };
}

const enabledClient = (fetchImpl) =>
  new OncallCommsClient({ oncallCommsBaseUrl: `${BASE}/`, piperOncallBridgeSecret: SECRET }, { fetchImpl });

const ok201 = () => ({ status: 201, body: { ok: true, outboundId: "out_0123456789ab", status: "queued", providerCallId: "vapi-call-1" } });

// --- configuration -----------------------------------------------------------

test("config: the ONCALL bridge is disabled by default and enabled only with both settings", () => {
  const off = loadConfig({});
  assert.equal(off.oncallCommsEnabled, false);
  assert.equal(off.oncallCommsBaseUrl, "");
  assert.equal(off.piperOncallBridgeSecret, "");

  const urlOnly = loadConfig({ ONCALL_COMMS_BASE_URL: "https://oncall.example.com" });
  assert.equal(urlOnly.oncallCommsEnabled, false);

  const on = loadConfig({ ONCALL_COMMS_BASE_URL: "https://oncall.example.com/", PIPER_ONCALL_BRIDGE_SECRET: SECRET });
  assert.equal(on.oncallCommsEnabled, true);
  assert.equal(on.oncallCommsBaseUrl, "https://oncall.example.com", "trailing slash is trimmed");
});

// --- client: disabled and pre-network refusals --------------------------------

test("client: disabled by default — every method refuses and nothing is fetched", async () => {
  const { calls, fetchImpl } = stubFetch(ok201);
  const client = new OncallCommsClient({}, { fetchImpl });
  assert.equal(client.isEnabled, false);
  assert.equal(client.capability().state, "disabled");

  const r = await client.requestCallback({ phone: "+13165550142", consentBasis: "express_consent", approvalRef: "appr-1" });
  assert.equal(r.ok, false);
  assert.equal(r.state, "disabled");
  assert.equal((await client.getResult("out_0123456789ab")).state, "disabled");
  assert.equal((await client.listResults({ taskRef: "opp-1" })).state, "disabled");
  assert.equal(calls.length, 0);
});

test("client: a request without an approval reference is refused before the network", async () => {
  const { calls, fetchImpl } = stubFetch(ok201);
  const client = enabledClient(fetchImpl);
  for (const approvalRef of [undefined, null, "", "   "]) {
    const r = await client.requestCallback({ phone: "+13165550142", consentBasis: "express_consent", approvalRef });
    assert.equal(r.ok, false);
    assert.equal(r.state, "approval_ref_required");
  }
  assert.equal(calls.length, 0);
});

test("client: consent bases outside the seller_callback binding are refused before the network", async () => {
  const { calls, fetchImpl } = stubFetch(ok201);
  const client = enabledClient(fetchImpl);
  for (const consentBasis of ["founder_own_number", "existing_relationship", "appointment_holder", "", undefined]) {
    const r = await client.requestCallback({ phone: "+13165550142", consentBasis, approvalRef: "appr-1" });
    assert.equal(r.ok, false, `basis ${consentBasis}`);
    assert.equal(r.state, "consent_basis_not_permitted");
  }
  assert.equal(calls.length, 0);
});

// --- client: the wire contract -------------------------------------------------

test("client: requestCallback posts the governed payload with the bridge header", async () => {
  const { calls, fetchImpl } = stubFetch(ok201);
  const client = enabledClient(fetchImpl);
  const r = await client.requestCallback({
    phone: "+13165550142",
    consentBasis: "callback_requested",
    approvalRef: "piper-approval:tc-1",
    taskRef: "opp-1",
    idempotencyKey: "piper-callback-tc-1",
    instructions: "Ask about the spring timeline.",
    customerName: "Pat Seller",
  });

  assert.equal(r.ok, true);
  assert.equal(r.state, "queued");
  assert.equal(r.outboundId, "out_0123456789ab");
  assert.equal(r.contacted, false, "queued is never reported as contacted");
  assert.match(r.summary, /not evidence/i);

  assert.equal(calls.length, 1);
  const sent = calls[0];
  assert.equal(sent.url, `${BASE}/api/integrations/comms/request-call`);
  assert.equal(sent.method, "POST");
  assert.equal(sent.headers["x-comms-bridge-secret"], SECRET);
  assert.equal(sent.body.to, "+13165550142");
  assert.equal(sent.body.purpose, "seller_callback");
  assert.equal(sent.body.consentBasis, "callback_requested");
  assert.equal(sent.body.idempotencyKey, "piper-callback-tc-1");
  assert.deepEqual(sent.body.requestContext, {
    approvalRef: "piper-approval:tc-1",
    taskRef: "opp-1",
    instructions: "Ask about the spring timeline.",
  });
});

test("client: ONCALL verdicts map to honest typed states", async () => {
  const scenarios = [
    [{ status: 403, body: { ok: false, error: "policy_denied", reasons: ["consent_basis_required", "outside_calling_hours"], outboundId: "out_0123456789ab" } },
      (r) => { assert.equal(r.state, "policy_denied"); assert.deepEqual(r.reasons, ["consent_basis_required", "outside_calling_hours"]); assert.equal(r.contacted, false); }],
    [{ status: 503, body: { ok: false, error: "outbound_not_configured" } },
      (r) => assert.equal(r.state, "voice_profile_not_provisioned")],
    [{ status: 503, body: { ok: false, error: "outbound_not_enabled" } },
      (r) => assert.equal(r.state, "outbound_disabled")],
    [{ status: 401, body: { ok: false, error: "unauthorized" } },
      (r) => assert.equal(r.state, "unauthorized")],
    [{ status: 409, body: { ok: false, error: "idempotency_key_conflict", duplicate: true, outboundId: "out_0123456789ab", status: "queued" } },
      (r) => assert.equal(r.state, "idempotency_conflict")],
    [{ status: 502, body: { ok: false, error: "provider_call_failed", providerStatus: "failed_http_400", outboundId: "out_0123456789ab" } },
      (r) => { assert.equal(r.state, "provider_failed"); assert.equal(r.providerStatus, "failed_http_400"); assert.equal(r.contacted, false); }],
    [{ status: 400, body: { ok: false, error: "approval_ref_required" } },
      (r) => { assert.equal(r.state, "request_rejected"); assert.equal(r.error, "approval_ref_required"); }],
    [{ status: 200, body: { ok: true, duplicate: true, outboundId: "out_0123456789ab", status: "queued", providerCallId: "vapi-call-1" } },
      (r) => { assert.equal(r.ok, true); assert.equal(r.state, "queued"); assert.equal(r.duplicate, true); }],
    [{ status: 200, body: { ok: false, duplicate: true, outboundId: "out_0123456789ab", status: "failed", error: "provider_call_failed" } },
      (r) => { assert.equal(r.ok, false); assert.equal(r.state, "provider_failed"); assert.equal(r.duplicate, true); }],
  ];
  for (const [response, check] of scenarios) {
    const { fetchImpl } = stubFetch(() => response);
    const r = await enabledClient(fetchImpl).requestCallback({ phone: "+13165550142", consentBasis: "express_consent", approvalRef: "appr-1" });
    check(r);
    assert.ok(!JSON.stringify(r).includes(SECRET), "the bridge secret never appears in a result");
  }
});

test("client: a network failure is reported once — never retried into a possible double call", async () => {
  let attempts = 0;
  const fetchImpl = async () => { attempts += 1; throw new Error("ECONNREFUSED"); };
  const r = await enabledClient(fetchImpl).requestCallback({ phone: "+13165550142", consentBasis: "express_consent", approvalRef: "appr-1", idempotencyKey: "k-1" });
  assert.equal(r.ok, false);
  assert.equal(r.state, "unreachable");
  assert.equal(attempts, 1);
});

test("client: getResult and listResults map ONCALL records without overclaiming contact", async () => {
  const record = {
    id: "out_0123456789ab", to_number: "+13165550142", purpose: "seller_callback",
    consent_basis: "express_consent", status: "completed", provider_call_id: "vapi-call-1",
    provider_end_reason: "customer-ended-call",
    request_context: { agent: "piper", approvalRef: "piper-approval:tc-1", taskRef: "opp-1", instructions: "" },
    est_cost_cents: 100, created: "2026-11-01T17:00:00.000Z", updated: "2026-11-01T17:02:00.000Z",
  };
  const { calls, fetchImpl } = stubFetch((req) =>
    req.url.includes("/calls/") ? { status: 200, body: { ok: true, call: record } } : { status: 200, body: { ok: true, calls: [record] } });
  const client = enabledClient(fetchImpl);

  const one = await client.getResult("out_0123456789ab");
  assert.equal(one.ok, true);
  assert.equal(one.call.status, "completed");
  assert.equal(one.call.consentBasis, "express_consent");
  assert.equal(one.call.taskRef, "opp-1");
  assert.equal(one.call.approvalRef, "piper-approval:tc-1");
  assert.equal(one.call.contacted, false, "even a completed record does not by itself prove a conversation");
  assert.match(one.call.summary, /call record in ONCALL/i);
  assert.equal(calls[0].headers["x-comms-bridge-secret"], SECRET);

  const list = await client.listResults({ taskRef: "opp 1" });
  assert.equal(list.ok, true);
  assert.equal(list.calls.length, 1);
  assert.ok(calls[1].url.endsWith("/api/integrations/comms/calls?taskRef=opp%201"));

  const { fetchImpl: fetch404 } = stubFetch(() => ({ status: 404, body: { ok: false, error: "not_found" } }));
  const missing = await enabledClient(fetch404).getResult("out_ffffffffffff");
  assert.equal(missing.ok, false);
  assert.equal(missing.state, "not_found");
});

test("status summaries never claim contact that the record does not prove", () => {
  assert.match(summarizeCallStatus("queued"), /not evidence/i);
  assert.match(summarizeCallStatus("failed"), /not contacted/i);
  assert.match(summarizeCallStatus("policy_denied"), /not contacted/i);
  assert.match(summarizeCallStatus("completed", "customer-ended-call"), /customer-ended-call/);
});

// --- tool layer ------------------------------------------------------------------

function seedSellerDb(t) {
  const tmp = makeTempDb();
  t.after(() => tmp.cleanup());
  createApp(testConfig(tmp.dbPath, { dataSource: "empty" })); // migrations
  const db = openPipelineDatabase(tmp.dbPath);
  const contact = (id, fn, ln, email, phone) => db.prepare(`
    INSERT INTO pipeline_contacts (id, first_name, last_name, email, phone) VALUES (?, ?, ?, ?, ?)
  `).run(id, fn, ln, email, phone);
  const opp = (id) => db.prepare(`
    INSERT INTO seller_opportunities (id, opportunity_code, pipeline_stage, opportunity_status, created_by, ocg_one_property_id, asking_price)
    VALUES (?, ?, 'new_lead', 'active', 'comms-test', ?, 150000)
  `).run(id, `CODE-${id}`, `prop-${id}`);
  const part = (id, oppId, contactId) => db.prepare(`
    INSERT INTO seller_opportunity_participants (id, opportunity_id, ocg_one_person_id, participant_role, is_primary, created_by)
    VALUES (?, ?, ?, 'primary_owner', 1, 'comms-test')
  `).run(id, oppId, contactId);
  contact("c-phone", "Pat", "Seller", "pat@example.com", "+13165550142");
  opp("opp-1"); part("p-1", "opp-1", "c-phone");
  contact("c-emailonly", "Em", "Ailer", "em@example.com", null);
  opp("opp-2"); part("p-2", "opp-2", "c-emailonly");
  return db;
}

const APPROVAL = { ref: "piper-approval:tc-1", toolCallId: "tc-1", decidedBy: "founder" };

test("tools: request_callback is a known, approval-gated write tool; get_callback_result is a read", () => {
  assert.equal(isKnownTool("request_callback"), true);
  assert.equal(isWriteTool("request_callback"), true);
  assert.equal(isKnownTool("get_callback_result"), true);
  assert.equal(isWriteTool("get_callback_result"), false);
});

test("tool: without the runtime's approval record the request is refused — even with an approvalRef smuggled into args", async (t) => {
  const db = seedSellerDb(t);
  const operator = new SqliteOperatorRepository(db);
  const { calls, fetchImpl } = stubFetch(ok201);
  const comms = enabledClient(fetchImpl);

  const noApproval = await executeTool({
    name: "request_callback",
    args: { opportunityId: "opp-1", consentBasis: "express_consent" },
    snapshot: {}, operator, comms,
  });
  assert.equal(noApproval.ok, false);
  assert.equal(noApproval.error, "approval_ref_required");

  const smuggled = await executeTool({
    name: "request_callback",
    args: { opportunityId: "opp-1", consentBasis: "express_consent", approvalRef: "model-invented-ref" },
    snapshot: {}, operator, comms,
  });
  assert.equal(smuggled.ok, false);
  assert.equal(smuggled.error, "approval_ref_required");
  assert.equal(calls.length, 0, "nothing reached ONCALL");
});

test("tool: with approval, the request uses the recorded phone and the approval-derived reference — argument phones are ignored", async (t) => {
  const db = seedSellerDb(t);
  const operator = new SqliteOperatorRepository(db);
  const { calls, fetchImpl } = stubFetch(ok201);
  const comms = enabledClient(fetchImpl);

  const r = await executeTool({
    name: "request_callback",
    args: { opportunityId: "opp-1", consentBasis: "express_consent", phone: "+19999999999", approvalRef: "model-invented-ref" },
    snapshot: {}, operator, comms, approval: APPROVAL,
  });
  assert.equal(r.ok, true);
  assert.equal(r.data.outcome, "queued");
  assert.equal(r.data.contacted, false);
  assert.equal(r.data.approvalRef, "piper-approval:tc-1");

  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.to, "+13165550142", "the recorded seller phone, never an argument-supplied number");
  assert.equal(calls[0].body.requestContext.approvalRef, "piper-approval:tc-1", "the approval record's reference, never the model's");
  assert.equal(calls[0].body.requestContext.taskRef, "opp-1");
  assert.equal(calls[0].body.idempotencyKey, "piper-callback-tc-1");
});

test("tool: founder-only consent, a phoneless seller, an unknown opportunity, and a disabled bridge all refuse without a fetch", async (t) => {
  const db = seedSellerDb(t);
  const operator = new SqliteOperatorRepository(db);
  const { calls, fetchImpl } = stubFetch(ok201);
  const comms = enabledClient(fetchImpl);
  const run = (args, extra = {}) => executeTool({ name: "request_callback", args, snapshot: {}, operator, comms, approval: APPROVAL, ...extra });

  assert.equal((await run({ opportunityId: "opp-1", consentBasis: "founder_own_number" })).error, "consent_basis_not_permitted");
  assert.equal((await run({ opportunityId: "opp-2", consentBasis: "express_consent" })).error, "no_phone_on_record");
  assert.equal((await run({ opportunityId: "opp-nope", consentBasis: "express_consent" })).error, "seller_not_found");
  assert.equal((await executeTool({ name: "request_callback", args: { opportunityId: "opp-1", consentBasis: "express_consent" }, snapshot: {}, operator, approval: APPROVAL })).error, "comms_disabled");
  assert.equal(calls.length, 0);
});

test("tool: an ONCALL policy denial is governed data, not a tool crash", async (t) => {
  const db = seedSellerDb(t);
  const operator = new SqliteOperatorRepository(db);
  const { fetchImpl } = stubFetch(() => ({ status: 403, body: { ok: false, error: "policy_denied", reasons: ["outside_calling_hours"], outboundId: "out_0123456789ab" } }));
  const r = await executeTool({
    name: "request_callback",
    args: { opportunityId: "opp-1", consentBasis: "callback_requested" },
    snapshot: {}, operator, comms: enabledClient(fetchImpl), approval: APPROVAL,
  });
  assert.equal(r.ok, true);
  assert.equal(r.data.outcome, "policy_denied");
  assert.deepEqual(r.data.reasons, ["outside_calling_hours"]);
  assert.match(r.data.summary, /not contacted/i);
});

test("tool: get_callback_result reads through the bridge and refuses when it is disabled", async (t) => {
  const db = seedSellerDb(t);
  const operator = new SqliteOperatorRepository(db);
  const { fetchImpl } = stubFetch(() => ({ status: 200, body: { ok: true, calls: [] } }));
  const r = await executeTool({ name: "get_callback_result", args: { opportunityId: "opp-1" }, snapshot: {}, operator, comms: enabledClient(fetchImpl) });
  assert.equal(r.ok, true);
  assert.deepEqual(r.data.calls, []);
  const off = await executeTool({ name: "get_callback_result", args: { opportunityId: "opp-1" }, snapshot: {}, operator });
  assert.equal(off.ok, false);
  assert.equal(off.error, "comms_disabled");
});

// --- runtime: the full two-key gate ----------------------------------------------

class ScriptedProvider {
  constructor(script = []) {
    this.kind = "scripted";
    this.model = "scripted-1";
    this.connected = true;
    this.script = [...script];
  }
  describe() { return { provider: "scripted", model: this.model, connected: true }; }
  async probe() { return { ok: true, toolCalling: true }; }
  async complete() {
    const next = this.script.shift();
    if (typeof next === "function") return next();
    return next || { text: "done", toolCalls: [] };
  }
}
const callTool = (name, args = {}) => ({ text: "", toolCalls: [{ name, arguments: args }] });
const say = (text) => ({ text, toolCalls: [] });

function buildRuntimeFor(t, provider, comms) {
  const tmp = makeTempDb();
  t.after(() => tmp.cleanup());
  createApp(testConfig(tmp.dbPath, { dataSource: "empty" })); // migrations
  const db = openPipelineDatabase(tmp.dbPath);
  const config = testConfig(tmp.dbPath, { readOnly: false, isTest: false, dataSource: "empty" });
  const runtime = new PiperRuntime({
    db,
    config,
    contextService: new PiperContextService(db, config),
    operator: new SqliteOperatorRepository(db),
    provider,
    comms,
  });
  return { runtime, db };
}

function seedRuntimeSeller(db) {
  db.prepare(`INSERT INTO pipeline_contacts (id, first_name, last_name, email, phone) VALUES ('c-rt', 'Pat', 'Seller', NULL, '+13165550142')`).run();
  db.prepare(`
    INSERT INTO seller_opportunities (id, opportunity_code, pipeline_stage, opportunity_status, created_by, ocg_one_property_id, asking_price)
    VALUES ('opp-rt', 'CODE-opp-rt', 'new_lead', 'active', 'comms-test', 'prop-rt', 150000)
  `).run();
  db.prepare(`
    INSERT INTO seller_opportunity_participants (id, opportunity_id, ocg_one_person_id, participant_role, is_primary, created_by)
    VALUES ('p-rt', 'opp-rt', 'c-rt', 'primary_owner', 1, 'comms-test')
  `).run();
}

test("runtime: a model may propose a callback, but only the operator's approval sends it — with the approval-derived reference", async (t) => {
  const { calls, fetchImpl } = stubFetch(ok201);
  const provider = new ScriptedProvider([callTool("request_callback", { opportunityId: "opp-rt", consentBasis: "express_consent" })]);
  const { runtime, db } = buildRuntimeFor(t, provider, enabledClient(fetchImpl));
  seedRuntimeSeller(db);

  const asked = await runtime.ask({ question: "Please call the seller back about the offer", actor: "founder" });
  assert.equal(asked.pendingApprovals.length, 1);
  assert.equal(asked.pendingApprovals[0].tool, "request_callback");
  assert.equal(calls.length, 0, "a proposal alone sends nothing to ONCALL");

  const toolCallId = asked.pendingApprovals[0].id;
  const decided = await runtime.decide({ toolCallId, approve: true, actor: "founder" });
  assert.equal(decided.ok, true);
  assert.equal(decided.data.outcome, "queued");

  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.to, "+13165550142");
  assert.equal(calls[0].body.requestContext.approvalRef, `piper-approval:${toolCallId}`);
  assert.equal(calls[0].body.idempotencyKey, `piper-callback-${toolCallId}`);

  const run = runtime.getRun(asked.runId);
  const settled = run.toolCalls.find((c) => c.id === toolCallId);
  assert.equal(settled.status, "executed");
});

test("runtime: a callback proposed without an explicit founder request to call is blocked before the approval queue", async (t) => {
  const { calls, fetchImpl } = stubFetch(ok201);
  const provider = new ScriptedProvider([
    callTool("request_callback", { opportunityId: "opp-rt", consentBasis: "express_consent" }),
    say("The opportunity is in the new_lead stage."),
  ]);
  const { runtime, db } = buildRuntimeFor(t, provider, enabledClient(fetchImpl));
  seedRuntimeSeller(db);

  const asked = await runtime.ask({ question: "What is the status of this opportunity?", actor: "founder" });
  assert.equal(asked.pendingApprovals.length, 0);
  assert.equal(calls.length, 0);
});
