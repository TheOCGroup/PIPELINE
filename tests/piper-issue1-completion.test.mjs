/**
 * Piper Issue #1 operational completion tests — the closers:
 *
 *   1. escalate_to_founder: a write tool that records an auditable founder
 *      escalation in the migration-023 work room, approval-gated.
 *   2. Structured intelligence report (Charlie format): a service derivation
 *      + GET /api/v1/piper/intelligence-report, null-honest throughout.
 *   3. handoff_to_agent: a write tool delegating through the same work-room
 *      substrate, approval-gated, unknown agents refused.
 *   4. Figure-basis labeling: recorded / estimated / unknown on every figure
 *      Piper presents, driven by stored provenance only.
 *
 * Same harness discipline as piper-phase1: disposable temp DB, scripted
 * provider, nothing touches production.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDb, testConfig, startApp } from "./helpers/temporaryDatabase.mjs";
import { openPipelineDatabase } from "../src/database/openDatabase.js";
import { createApp } from "../src/app/createApp.js";
import { PiperRuntime } from "../src/services/piper/piperRuntime.js";
import { PiperContextService } from "../src/services/piperContextService.js";
import { SqliteOperatorRepository } from "../src/repositories/sqlite/sqliteOperatorRepository.js";
import { createAgentWorkRoomService } from "../src/services/agentWorkRoomService.js";
import { TOOL_SCHEMAS, isWriteTool, executeTool, describeToolCall } from "../src/services/piper/toolRegistry.js";
import { buildIntelligenceReport, INTELLIGENCE_REPORT_VERSION } from "../src/services/piper/intelligenceReportService.js";
import { buildBrief } from "../src/domain/piper/briefModel.js";
import { answerQuestion } from "../src/domain/piper/intentRouter.js";

class ScriptedProvider {
  constructor(script = []) {
    this.kind = "scripted";
    this.model = "scripted-1";
    this.connected = true;
    this.script = [...script];
    this.sent = [];
  }
  describe() { return { provider: "scripted", model: this.model, connected: true }; }
  async probe() { return { ok: true, toolCalling: true }; }
  async complete({ messages, tools }) {
    this.sent.push({ messages, tools: (tools || []).map((t) => t.function.name) });
    const next = this.script.shift();
    if (typeof next === "function") return next({ messages });
    return next || { text: "done", toolCalls: [] };
  }
}

const call = (name, args = {}) => ({ text: "", toolCalls: [{ name, arguments: args }] });

function seed(conn) {
  const contact = (id, fn, ln) => conn.prepare(`
    INSERT INTO pipeline_contacts (id, first_name, last_name) VALUES (?, ?, ?)
  `).run(id, fn, ln);
  const opp = (id, code, stage, price, prop) => conn.prepare(`
    INSERT INTO seller_opportunities (id, opportunity_code, pipeline_stage, opportunity_status, created_by, ocg_one_property_id, asking_price)
    VALUES (?, ?, ?, 'active', 'issue1-test', ?, ?)
  `).run(id, code, stage, prop, price);
  const part = (id, oppId, contactId) => conn.prepare(`
    INSERT INTO seller_opportunity_participants (id, opportunity_id, ocg_one_person_id, participant_role, is_primary, created_by)
    VALUES (?, ?, ?, 'primary_owner', 1, 'issue1-test')
  `).run(id, oppId, contactId);
  const src = (id, oppId, addr) => conn.prepare(`
    INSERT INTO seller_opportunity_sources (id, opportunity_id, source_type, original_address, conversion_actor, source_timestamp, conversion_timestamp)
    VALUES (?, ?, 'manual_entry', ?, 'issue1-test', '2026-09-01T10:00:00Z', '2026-09-01T10:00:00Z')
  `).run(id, oppId, addr);
  const ref = (id, oppId, { arv, rehab, mao, confidence = null, evidence = null }) => conn.prepare(`
    INSERT INTO opportunity_underwriting_refs
      (id, opportunity_id, source_system, source_underwriting_id, analysis_status, arv, rehab, mao, confidence, limitations, evidence_summary_json)
    VALUES (?, ?, 'deal-scout', ?, 'completed', ?, ?, ?, ?, NULL, ?)
  `).run(id, oppId, `uw-${id}`, arv, rehab, mao, confidence, evidence ? JSON.stringify(evidence) : null);

  // Worked deal: asking price + a full Victor underwriting snapshot.
  contact("ct_alma", "Alma", "Reyes");
  opp("opp_alma_001", "OPP-I1-001", "contacted", 180000, "prop-alma-1");
  part("part_alma", "opp_alma_001", "ct_alma");
  src("src_alma", "opp_alma_001", "44 Elm St, Wichita, KS");
  ref("ref_alma", "opp_alma_001", { arv: 220000, rehab: 30000, mao: 140000, confidence: 0.8 });

  // Bare lead: no asking price, no underwriting — everything unknown.
  contact("ct_ben", "Ben", "Ortiz");
  opp("opp_ben_001", "OPP-I1-002", "new_lead", null, "prop-ben-1");
  part("part_ben", "opp_ben_001", "ct_ben");
  src("src_ben", "opp_ben_001", "9 Oak Ave, Wichita, KS");
}

async function fresh(t, provider = new ScriptedProvider()) {
  const tmp = makeTempDb();
  const app = createApp(testConfig(tmp.dbPath, { dataSource: "empty" }));
  app.close();
  const config = testConfig(tmp.dbPath, { readOnly: false, isTest: false, dataSource: "empty" });
  const db = openPipelineDatabase(tmp.dbPath);
  seed(db);
  const operator = new SqliteOperatorRepository(db);
  const workRoom = createAgentWorkRoomService(db, operator.tenantId);
  const contextService = new PiperContextService(db, config);
  const runtime = new PiperRuntime({ db, config, contextService, operator, provider, workRoom });
  t.after(() => { db.close(); tmp.cleanup(); });
  return { db, config, operator, workRoom, contextService, runtime, provider, dbPath: tmp.dbPath };
}

// --- Registry shape -------------------------------------------------------------

test("registry: tool count pin (26 after the item-5 move), Issue #1 tools classified read/write correctly", () => {
  const names = TOOL_SCHEMAS.map((s) => s.function.name);
  assert.equal(names.length, 26);
  assert.ok(names.includes("escalate_to_founder"));
  assert.ok(names.includes("handoff_to_agent"));
  assert.ok(names.includes("get_intelligence_report"));
  assert.equal(isWriteTool("escalate_to_founder"), true);
  assert.equal(isWriteTool("handoff_to_agent"), true);
  assert.equal(isWriteTool("get_intelligence_report"), false);
  for (const n of ["escalate_to_founder", "handoff_to_agent", "get_intelligence_report"]) {
    assert.doesNotMatch(describeToolCall(n, { reason: "r", summary: "s", targetAgent: "VICTOR" }), /^Perform /);
  }
});

// --- 4. Figure-basis labeling ---------------------------------------------------

test("figures: stored values are recorded with provenance; missing values are unknown, never zero", async (t) => {
  const { contextService } = await fresh(t);
  const snapshot = contextService.snapshot();
  const alma = snapshot.opportunities.find((o) => o.id === "opp_alma_001");
  const ben = snapshot.opportunities.find((o) => o.id === "opp_ben_001");

  assert.deepEqual(alma.figures.askingPrice, { value: 180000, basis: "recorded", source: "manual_entry" });
  assert.equal(alma.figures.arv.value, 220000);
  assert.equal(alma.figures.arv.basis, "recorded");
  assert.match(alma.figures.arv.source, /deal-scout/);
  assert.equal(alma.figures.mao.value, 140000);
  assert.equal(alma.figures.targetPurchasePrice.basis, alma.figures.mao.basis);

  assert.deepEqual(ben.figures.askingPrice, { value: null, basis: "unknown", source: null });
  assert.deepEqual(ben.figures.arv, { value: null, basis: "unknown", source: null });
  assert.equal(ben.underwriting.status, null); // no ref: status is null, never invented
});

test("figures: a source-labeled estimate stays estimated — never silently relabeled recorded", async (t) => {
  const tmp = makeTempDb();
  const app = createApp(testConfig(tmp.dbPath, { dataSource: "empty" }));
  app.close();
  const config = testConfig(tmp.dbPath, { dataSource: "empty" });
  const db = openPipelineDatabase(tmp.dbPath);
  t.after(() => { db.close(); tmp.cleanup(); });
  seed(db);
  db.prepare(`
    UPDATE opportunity_underwriting_refs
    SET evidence_summary_json = ?
    WHERE id = 'ref_alma'
  `).run(JSON.stringify({ figureBasis: { rehab: "estimated", mao: "estimated" } }));

  const snapshot = new PiperContextService(db, config).snapshot();
  const alma = snapshot.opportunities.find((o) => o.id === "opp_alma_001");
  assert.equal(alma.figures.rehab.basis, "estimated");
  assert.equal(alma.figures.mao.basis, "estimated");
  assert.equal(alma.figures.targetPurchasePrice.basis, "estimated");
  assert.equal(alma.figures.arv.basis, "recorded"); // unlabeled stays recorded
});

test("figures: the strongest-margin ranking labels bases and never claims 'recorded' for an estimate", async (t) => {
  const { contextService, db } = await fresh(t);
  const plain = answerQuestion("Which opportunity looks strongest?", contextService.snapshot());
  assert.match(plain.answer, /widest recorded margin/);
  assert.match(plain.answer, /\(recorded\)/);

  db.prepare(`
    UPDATE opportunity_underwriting_refs SET evidence_summary_json = ? WHERE id = 'ref_alma'
  `).run(JSON.stringify({ figureBasis: { mao: "estimated" } }));
  const estimated = answerQuestion("Which opportunity looks strongest?", contextService.snapshot());
  assert.doesNotMatch(estimated.answer, /widest recorded margin/);
  assert.match(estimated.answer, /\(estimated\)/);
});

test("figures: brief Victor-update items carry the labeled figures", async (t) => {
  const { contextService } = await fresh(t);
  const brief = buildBrief(contextService.snapshot());
  const changed = brief.sections.find((s) => s.title === "CHANGED");
  const victorItem = changed.items.find((i) => i.opportunityId === "opp_alma_001" && i.figures);
  assert.ok(victorItem, "expected a Victor update item carrying figures");
  assert.deepEqual(victorItem.figures.mao, { value: 140000, basis: "recorded", source: victorItem.figures.mao.source });
  assert.equal(victorItem.figures.arv.value, 220000);
});

// --- 1. escalate_to_founder -----------------------------------------------------

test("escalation: approval-gated write — parks as a proposal, executes into the work room on approval", async (t) => {
  const { runtime, provider, db } = await fresh(t);
  provider.script.push(call("escalate_to_founder", {
    opportunityId: "opp_alma_001",
    reason: "Seller's attorney rejected the assignment clause; founder decision needed.",
    severity: "high",
    evidenceRefs: ["brief:NEEDS YOU"],
  }));
  const res = await runtime.ask({ question: "Please escalate this to the founder — the attorney rejected the assignment clause." });
  assert.equal(res.state, "awaiting_approval");
  assert.equal(res.pendingApprovals.length, 1);
  assert.equal(res.pendingApprovals[0].tool, "escalate_to_founder");
  // Parked, not recorded: no work-room task exists yet.
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM agent_work_tasks").get().n, 0);

  const decided = await runtime.decide({ toolCallId: res.pendingApprovals[0].id, approve: true, actor: "issue1-test" });
  assert.equal(decided.ok, true);
  assert.equal(decided.wrote, true);
  assert.equal(decided.data.escalation.severity, "high");

  const task = db.prepare("SELECT * FROM agent_work_tasks WHERE id = ?").get(decided.data.escalation.id);
  assert.ok(task);
  assert.equal(task.director, "Founder");
  assert.equal(task.lead_agent, "Piper");
  assert.equal(task.state, "awaiting_approval");
  assert.equal(task.approval_required, 1);
  assert.equal(task.opportunity_id, "opp_alma_001");
  assert.match(task.blocker, /assignment clause/);

  const events = db.prepare("SELECT * FROM agent_work_events WHERE task_id = ? ORDER BY created_at, rowid").all(task.id);
  const requested = events.find((e) => e.event_type === "approval_requested");
  assert.ok(requested, "escalation must leave an approval_requested audit event");
  assert.equal(requested.from_actor, "Piper");
  assert.equal(requested.to_actor, "Founder");
  const meta = JSON.parse(requested.metadata_json);
  assert.equal(meta.via, "piper_escalate_to_founder");
  assert.equal(meta.severity, "high");
  assert.deepEqual(meta.evidenceRefs, ["brief:NEEDS YOU"]);
});

test("escalation: direct execution validates reason and opportunity (ghost reads as not_found)", async (t) => {
  const { contextService, operator, workRoom } = await fresh(t);
  const snapshot = contextService.snapshot();

  const noReason = await executeTool({ name: "escalate_to_founder", args: { opportunityId: "opp_alma_001" }, snapshot, operator, workRoom });
  assert.equal(noReason.ok, false);
  assert.equal(noReason.error, "missing_reason");

  const ghost = await executeTool({ name: "escalate_to_founder", args: { opportunityId: "opp_ghost", reason: "Blocked." }, snapshot, operator, workRoom });
  assert.equal(ghost.ok, false);
  assert.equal(ghost.error, "not_found");

  // Without an explicit workRoom the tool falls back to the operator's own
  // db + tenant — same substrate, same audit.
  const bare = await executeTool({ name: "escalate_to_founder", args: { reason: "Portfolio-level blocker." }, snapshot, operator });
  assert.equal(bare.ok, true);
  assert.equal(bare.data.escalation.state, "awaiting_approval");
  assert.equal(bare.data.escalation.opportunityId, null);
});

// --- 3. handoff_to_agent ----------------------------------------------------------

test("handoff: creates a queued work-room task for the named agent with a handoff audit event", async (t) => {
  const { contextService, operator, workRoom, db } = await fresh(t);
  const snapshot = contextService.snapshot();

  const res = await executeTool({
    name: "handoff_to_agent",
    args: { targetAgent: "VICTOR", summary: "Re-run underwriting with the new rehab bid.", opportunityId: "opp_alma_001" },
    snapshot, operator, workRoom,
  });
  assert.equal(res.ok, true);
  assert.equal(res.data.handoff.targetAgent, "VICTOR");
  assert.equal(res.data.handoff.state, "queued");

  const task = db.prepare("SELECT * FROM agent_work_tasks WHERE id = ?").get(res.data.handoff.id);
  // F7 remediation: the task records the directory identity's canonical
  // name (VICTOR), not a free-text display name — so directory governance
  // (e.g. retirement's open-task check) sees Piper's handoffs.
  assert.equal(task.lead_agent, "VICTOR");
  assert.equal(task.opportunity_id, "opp_alma_001");
  const events = db.prepare("SELECT * FROM agent_work_events WHERE task_id = ? ORDER BY created_at, rowid").all(task.id);
  const handoff = events.find((e) => e.event_type === "handoff");
  assert.ok(handoff);
  assert.equal(handoff.from_actor, "Piper");
  assert.equal(handoff.to_actor, "VICTOR");
  assert.match(handoff.summary, /rehab bid/);
});

test("handoff: unknown agents, missing summaries, and ghost opportunities are refused", async (t) => {
  const { contextService, operator, workRoom } = await fresh(t);
  const snapshot = contextService.snapshot();

  const unknown = await executeTool({ name: "handoff_to_agent", args: { targetAgent: "NOBODY", summary: "Do a thing." }, snapshot, operator, workRoom });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error, "unknown_agent");

  const noSummary = await executeTool({ name: "handoff_to_agent", args: { targetAgent: "HUNTER" }, snapshot, operator, workRoom });
  assert.equal(noSummary.ok, false);
  assert.equal(noSummary.error, "missing_summary");

  const ghost = await executeTool({ name: "handoff_to_agent", args: { targetAgent: "HUNTER", summary: "Find comps.", opportunityId: "opp_ghost" }, snapshot, operator, workRoom });
  assert.equal(ghost.ok, false);
  assert.equal(ghost.error, "not_found");
});

test("handoff: parks for approval through the runtime like every other write", async (t) => {
  const { runtime, provider, db } = await fresh(t);
  provider.script.push(call("handoff_to_agent", { targetAgent: "HUNTER", summary: "Pull fresh comps for Elm St.", opportunityId: "opp_alma_001" }));
  const res = await runtime.ask({ question: "Hand this off to Hunter for fresh comps." });
  assert.equal(res.state, "awaiting_approval");
  assert.equal(res.pendingApprovals[0].tool, "handoff_to_agent");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM agent_work_tasks").get().n, 0);
  const decided = await runtime.decide({ toolCallId: res.pendingApprovals[0].id, approve: true, actor: "issue1-test" });
  assert.equal(decided.ok, true);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM agent_work_tasks WHERE lead_agent = 'HUNTER'").get().n, 1);
});

// --- 2. Structured intelligence report -------------------------------------------

test("report: service derivation is versioned, basis-labeled, and counts open escalations", async (t) => {
  const { contextService, operator, workRoom } = await fresh(t);
  const snapshot = contextService.snapshot();

  const before = buildIntelligenceReport(snapshot, { workRoom });
  assert.equal(before.reportVersion, INTELLIGENCE_REPORT_VERSION);
  assert.equal(before.kind, "charlie_intelligence_report");
  assert.equal(before.escalations.open, 0);
  assert.equal(before.portfolio.totals.opportunities, 2);
  const alma = before.opportunities.find((o) => o.id === "opp_alma_001");
  assert.equal(alma.figures.mao.basis, "recorded");
  assert.equal(alma.underwriting.confidence, 0.8);
  const ben = before.opportunities.find((o) => o.id === "opp_ben_001");
  assert.equal(ben.figures.askingPrice.basis, "unknown");
  assert.equal(ben.underwriting.status, null);
  assert.ok(Array.isArray(before.openDecisions));
  assert.ok(Array.isArray(before.risks));

  // Without a work room the escalation block is honestly absent, not zeroed.
  const noRoom = buildIntelligenceReport(snapshot);
  assert.equal(noRoom.escalations, null);

  await executeTool({
    name: "escalate_to_founder",
    args: { reason: "Decision needed on earnest money.", opportunityId: "opp_alma_001" },
    snapshot, operator, workRoom,
  });
  const after = buildIntelligenceReport(contextService.snapshot(), { workRoom });
  assert.equal(after.escalations.open, 1);
  assert.equal(after.escalations.items[0].opportunityId, "opp_alma_001");
});

test("report: the read tool returns the same derivation without approval", async (t) => {
  const { contextService, operator, workRoom } = await fresh(t);
  const res = await executeTool({ name: "get_intelligence_report", args: {}, snapshot: contextService.snapshot(), operator, workRoom });
  assert.equal(res.ok, true);
  assert.equal(res.data.kind, "charlie_intelligence_report");
  assert.equal(res.data.reportVersion, INTELLIGENCE_REPORT_VERSION);
});

test("report: operator endpoint serves the report and rejects anonymous access", async (t) => {
  const tmp = makeTempDb();
  const secret = "a".repeat(64);
  const { app, baseUrl } = await startApp(
    createApp,
    testConfig(tmp.dbPath, { env: "production", operatorSecret: secret, dataSource: "empty" })
  );
  t.after(() => { app.close(); tmp.cleanup(); });

  const anon = await fetch(`${baseUrl}/api/v1/piper/intelligence-report`);
  assert.equal(anon.status, 401);

  const res = await fetch(`${baseUrl}/api/v1/piper/intelligence-report`, {
    headers: { Authorization: `Bearer ${secret}` },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.data.kind, "charlie_intelligence_report");
  assert.equal(body.data.reportVersion, INTELLIGENCE_REPORT_VERSION);
  assert.equal(body.meta.deterministic, true);
  assert.ok(body.data.escalations, "app wiring supplies the work room");
  assert.equal(body.data.escalations.open, 0);
});
