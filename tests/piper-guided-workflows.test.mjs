/**
 * Piper Issue #1 item 5 — persisted guided workflows (migration 033) — and
 * the QUINCEY F7 remediation: handoff_to_agent validated against the
 * Director identity registry + the governed executeTool fallback.
 *
 * Covers the design's test plan: migration on fresh + legacy DBs; the full
 * workflow state machine; tenant ghost on get/advance; approval parking for
 * both write tools; snapshot surfacing; the safety rule (steps execute
 * nothing); and the registry move (26 tools, contract file covers the pin).
 * Handoff: retired target refused, non-lead directory identity accepted,
 * unknown refused, canonical-name coherence with directory governance.
 *
 * Disposable temp DBs, scripted provider; nothing touches production.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { makeTempDb, testConfig } from "./helpers/temporaryDatabase.mjs";
import { openPipelineDatabase } from "../src/database/openDatabase.js";
import { runMigrations } from "../src/database/migrationRunner.js";
import { createApp } from "../src/app/createApp.js";
import { PiperRuntime } from "../src/services/piper/piperRuntime.js";
import { PiperContextService } from "../src/services/piperContextService.js";
import { SqliteOperatorRepository } from "../src/repositories/sqlite/sqliteOperatorRepository.js";
import { buildAgentGovernance } from "../src/services/agentGovernance.js";
import { createGuidedWorkflowService } from "../src/services/piper/guidedWorkflowService.js";
import { GUIDED_WORKFLOW_TEMPLATES, getGuidedWorkflowTemplate } from "../src/domain/piper/guidedWorkflows.js";
import { TOOL_SCHEMAS, isWriteTool, executeTool, describeToolCall } from "../src/services/piper/toolRegistry.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS_DIR = join(root, "migrations");

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

function seedOpp(conn, id = "opp_wf_001") {
  conn.prepare(`
    INSERT INTO seller_opportunities (id, opportunity_code, pipeline_stage, opportunity_status, created_by, ocg_one_property_id, asking_price)
    VALUES (?, 'OPP-WF-001', 'contacted', 'active', 'piper2-test', 'prop-wf-1', 175000)
  `).run(id);
  conn.prepare(`
    INSERT INTO seller_opportunity_sources (id, opportunity_id, source_type, original_address, conversion_actor, source_timestamp, conversion_timestamp)
    VALUES ('src_wf', ?, 'manual_entry', '12 Vine St, Wichita, KS', 'piper2-test', '2026-09-01T10:00:00Z', '2026-09-01T10:00:00Z')
  `).run(id);
}

/** A migrated, app-booted DB (identities seeded by buildServices) + seed opp. */
async function fresh(t, provider = new ScriptedProvider()) {
  const tmp = makeTempDb();
  const app = createApp(testConfig(tmp.dbPath, { dataSource: "empty" }));
  const config = testConfig(tmp.dbPath, { readOnly: false, isTest: false, dataSource: "empty" });
  const db = app.db;
  seedOpp(db);
  const operator = new SqliteOperatorRepository(db);
  const governance = buildAgentGovernance(db, operator.tenantId);
  const guidedWorkflows = createGuidedWorkflowService(db, operator.tenantId);
  const contextService = new PiperContextService(db, config);
  const runtime = new PiperRuntime({
    db, config, contextService, operator, provider,
    workRoom: governance.workRoom, agentDirectory: governance.directory, guidedWorkflows,
  });
  t.after(() => { app.close(); tmp.cleanup(); });
  return { db, config, operator, governance, guidedWorkflows, contextService, runtime, provider, app };
}

// --- Migration 033 --------------------------------------------------------------

test("migration 033: fresh database gains both tables and records the migration", async (t) => {
  const tmp = makeTempDb();
  const app = createApp(testConfig(tmp.dbPath, { dataSource: "empty" }));
  t.after(() => { app.close(); tmp.cleanup(); });
  const tables = app.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'piper_guided%' ORDER BY name").all().map((r) => r.name);
  assert.deepEqual(tables, ["piper_guided_workflow_steps", "piper_guided_workflows"]);
  const applied = app.db.prepare("SELECT filename FROM pipeline_migrations WHERE filename LIKE '033%'").all();
  assert.equal(applied.length, 1);
});

test("migration 033: applies cleanly on a legacy (<=032) database without touching existing data", async (t) => {
  const tmp = makeTempDb();
  const legacyDir = mkdtempSync(join(tmpdir(), "pipeline-legacy-migrations-"));
  t.after(() => { tmp.cleanup(); rmSync(legacyDir, { recursive: true, force: true }); });
  for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql") && !f.startsWith("033"))) {
    copyFileSync(join(MIGRATIONS_DIR, f), join(legacyDir, f));
  }
  const legacy = createApp(testConfig(tmp.dbPath, { dataSource: "empty", migrationsDir: legacyDir }));
  assert.equal(
    legacy.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'piper_guided_workflows'").get().n,
    0,
    "legacy schema must not have the guided-workflow tables yet"
  );
  seedOpp(legacy.db);
  legacy.close();

  const upgraded = createApp(testConfig(tmp.dbPath, { dataSource: "empty" }));
  t.after(() => upgraded.close());
  assert.equal(
    upgraded.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'piper_guided_workflows'").get().n,
    1
  );
  // Pre-existing data is intact and immediately usable by the new surface.
  assert.equal(upgraded.db.prepare("SELECT COUNT(*) AS n FROM seller_opportunities WHERE id = 'opp_wf_001'").get().n, 1);
  const svc = createGuidedWorkflowService(upgraded.db, "ocg-one");
  const wf = svc.start({ workflowKey: "seller_follow_up", opportunityId: "opp_wf_001", actor: "piper2-test" });
  assert.equal(wf.state, "active");
});

// --- Service state machine --------------------------------------------------------

test("workflows: start materializes the template's steps with the first one current", async (t) => {
  const { guidedWorkflows } = await fresh(t);
  const tpl = getGuidedWorkflowTemplate("seller_follow_up");
  const wf = guidedWorkflows.start({ workflowKey: "seller_follow_up", opportunityId: "opp_wf_001", actor: "piper2-test" });
  assert.equal(wf.state, "active");
  assert.equal(wf.templateVersion, tpl.templateVersion);
  assert.equal(wf.title, tpl.title);
  assert.equal(wf.steps.length, tpl.steps.length);
  assert.deepEqual(wf.steps.map((s) => s.key), tpl.steps.map((s) => s.key));
  assert.equal(wf.steps[0].state, "current");
  assert.ok(wf.steps.slice(1).every((s) => s.state === "pending"));
  assert.equal(wf.currentStep.key, tpl.steps[0].key);
  assert.equal(wf.currentStep.suggestedTool, tpl.steps[0].suggestedTool);
  assert.equal(wf.createdBy, "piper2-test");
});

test("workflows: full state machine — advance, skip, pause/resume, completion, settled refusals", async (t) => {
  const { guidedWorkflows } = await fresh(t);
  const wf = guidedWorkflows.start({ workflowKey: "seller_follow_up", opportunityId: "opp_wf_001", actor: "piper2-test" });

  const afterAdvance = guidedWorkflows.advance(wf.id, { actor: "op-1", note: "Reviewed with the seller file." });
  assert.equal(afterAdvance.steps[0].state, "done");
  assert.equal(afterAdvance.steps[0].decidedBy, "op-1");
  assert.equal(afterAdvance.steps[0].note, "Reviewed with the seller file.");
  assert.ok(afterAdvance.steps[0].decidedAt);
  assert.equal(afterAdvance.currentStep.key, "prepare_call");

  const afterSkip = guidedWorkflows.skip(wf.id, { actor: "op-1" });
  assert.equal(afterSkip.steps[1].state, "skipped");
  assert.equal(afterSkip.currentStep.key, "log_outcome");

  const paused = guidedWorkflows.pause(wf.id);
  assert.equal(paused.state, "paused");
  assert.throws(() => guidedWorkflows.advance(wf.id, {}), /guided_workflow_not_active/);
  assert.throws(() => guidedWorkflows.pause(wf.id), /guided_workflow_invalid_transition/);
  const resumed = guidedWorkflows.resume(wf.id);
  assert.equal(resumed.state, "active");
  assert.throws(() => guidedWorkflows.resume(wf.id), /guided_workflow_invalid_transition/);

  guidedWorkflows.advance(wf.id, { actor: "op-1" });
  const done = guidedWorkflows.advance(wf.id, { actor: "op-1" });
  assert.equal(done.state, "completed");
  assert.ok(done.completedAt);
  assert.equal(done.currentStep, null);
  assert.ok(done.steps.every((s) => ["done", "skipped"].includes(s.state)));
  assert.throws(() => guidedWorkflows.advance(wf.id, {}), /guided_workflow_settled/);
  assert.throws(() => guidedWorkflows.abandon(wf.id), /guided_workflow_settled/);
});

test("workflows: abandon keeps the record — state, steps, and history all survive", async (t) => {
  const { guidedWorkflows, db } = await fresh(t);
  const wf = guidedWorkflows.start({ workflowKey: "new_lead_qualification", opportunityId: "opp_wf_001", actor: "piper2-test" });
  guidedWorkflows.advance(wf.id, { actor: "op-1" });
  const abandoned = guidedWorkflows.abandon(wf.id);
  assert.equal(abandoned.state, "abandoned");
  assert.equal(abandoned.steps.length, 5);
  assert.equal(abandoned.steps[0].state, "done");
  assert.equal(abandoned.steps[1].state, "current"); // where the work stopped
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM piper_guided_workflows WHERE id = ?").get(wf.id).n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM piper_guided_workflow_steps WHERE workflow_id = ?").get(wf.id).n, 5);
  assert.deepEqual(guidedWorkflows.list({ state: "abandoned" }).map((w) => w.id), [wf.id]);
  assert.throws(() => guidedWorkflows.abandon(wf.id), /guided_workflow_settled/);
});

test("workflows: start validates the template and the opportunity", async (t) => {
  const { guidedWorkflows } = await fresh(t);
  assert.throws(() => guidedWorkflows.start({ workflowKey: "nope", actor: "x" }), /unknown_workflow/);
  assert.throws(
    () => guidedWorkflows.start({ workflowKey: "seller_follow_up", opportunityId: "opp_ghost", actor: "x" }),
    /opportunity_not_found/
  );
  // An opportunity-less workflow is legitimate (portfolio-level sequence).
  const bare = guidedWorkflows.start({ workflowKey: "offer_preparation", actor: "x" });
  assert.equal(bare.opportunityId, null);
  assert.equal(bare.state, "active");
});

// --- Tenant isolation ---------------------------------------------------------------

test("workflows: a foreign tenant reads a workflow exactly like a nonexistent one", async (t) => {
  const { db, guidedWorkflows } = await fresh(t);
  const wf = guidedWorkflows.start({ workflowKey: "seller_follow_up", opportunityId: "opp_wf_001", actor: "piper2-test" });
  const foreign = createGuidedWorkflowService(db, "other-tenant");
  assert.equal(foreign.get(wf.id), null);
  assert.equal(foreign.get("wf_does_not_exist"), null);
  assert.throws(() => foreign.advance(wf.id, {}), /guided_workflow_not_found/);
  assert.throws(() => foreign.abandon(wf.id), /guided_workflow_not_found/);
  assert.deepEqual(foreign.list({}), []);
  assert.equal(foreign.activeForOpportunity("opp_wf_001"), null);
  // The owning tenant is unaffected by the foreign attempts.
  assert.equal(guidedWorkflows.get(wf.id).state, "active");

  // Same ghost equality through the tools, driven by the operator's tenant.
  const foreignOperator = new SqliteOperatorRepository(db, { tenantId: "other-tenant", dataSource: "empty" });
  const viaTool = await executeTool({
    name: "advance_guided_workflow", args: { workflowId: wf.id },
    snapshot: { opportunities: [] }, operator: foreignOperator,
  });
  assert.equal(viaTool.ok, false);
  assert.equal(viaTool.error, "not_found");
  const viaRead = await executeTool({
    name: "get_guided_workflow", args: { workflowId: wf.id },
    snapshot: { opportunities: [] }, operator: foreignOperator,
  });
  assert.equal(viaRead.ok, false);
  assert.equal(viaRead.error, "not_found");
});

// --- Tools ---------------------------------------------------------------------------

test("guided workflow tools: registry shape, classification, descriptions", () => {
  const names = TOOL_SCHEMAS.map((s) => s.function.name);
  assert.equal(names.length, 26);
  assert.equal(isWriteTool("start_guided_workflow"), true);
  assert.equal(isWriteTool("advance_guided_workflow"), true);
  assert.equal(isWriteTool("get_guided_workflow"), false);
  for (const n of ["start_guided_workflow", "advance_guided_workflow", "get_guided_workflow"]) {
    assert.doesNotMatch(describeToolCall(n, { workflowKey: "seller_follow_up", workflowId: "wf_1" }), /^Perform /);
  }
  // Every suggested tool in every template is a real registry tool.
  for (const tpl of GUIDED_WORKFLOW_TEMPLATES) {
    for (const step of tpl.steps) {
      if (step.suggestedTool) assert.ok(names.includes(step.suggestedTool), `${tpl.key}.${step.key} suggests unknown tool ${step.suggestedTool}`);
    }
  }
});

test("guided workflow tools: direct execution — start, read back, validation errors", async (t) => {
  const { contextService, operator, guidedWorkflows } = await fresh(t);
  const snapshot = contextService.snapshot();

  const started = await executeTool({
    name: "start_guided_workflow",
    args: { workflowKey: "seller_follow_up", opportunityId: "opp_wf_001" },
    snapshot, operator, guidedWorkflows,
  });
  assert.equal(started.ok, true);
  assert.equal(started.data.workflow.state, "active");
  assert.equal(started.data.workflow.currentStep.key, "review_record");

  const readBack = await executeTool({
    name: "get_guided_workflow", args: { opportunityId: "opp_wf_001" },
    snapshot, operator, guidedWorkflows,
  });
  assert.equal(readBack.ok, true);
  assert.equal(readBack.data.active.id, started.data.workflow.id);
  assert.equal(readBack.data.workflows.length, 1);

  const unknown = await executeTool({
    name: "start_guided_workflow", args: { workflowKey: "teleport_sequence" },
    snapshot, operator, guidedWorkflows,
  });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error, "unknown_workflow");

  const ghost = await executeTool({
    name: "start_guided_workflow", args: { workflowKey: "seller_follow_up", opportunityId: "opp_ghost" },
    snapshot, operator, guidedWorkflows,
  });
  assert.equal(ghost.ok, false);
  assert.equal(ghost.error, "not_found");
});

test("guided workflow tools: both writes park for approval through the runtime", async (t) => {
  const { runtime, provider, db } = await fresh(t);

  provider.script.push(call("start_guided_workflow", { workflowKey: "seller_follow_up", opportunityId: "opp_wf_001" }));
  const startRes = await runtime.ask({ question: "Start the seller follow-up guided workflow for this deal." });
  assert.equal(startRes.state, "awaiting_approval");
  assert.equal(startRes.pendingApprovals[0].tool, "start_guided_workflow");
  // Parked, not started: no instance exists yet.
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM piper_guided_workflows").get().n, 0);

  const started = await runtime.decide({ toolCallId: startRes.pendingApprovals[0].id, approve: true, actor: "piper2-test" });
  assert.equal(started.ok, true);
  const wfId = started.data.workflow.id;
  assert.equal(db.prepare("SELECT state FROM piper_guided_workflows WHERE id = ?").get(wfId).state, "active");

  provider.script.push(call("advance_guided_workflow", { workflowId: wfId, action: "advance", note: "Record reviewed." }));
  const advRes = await runtime.ask({ question: "Advance the guided workflow — this step is done." });
  assert.equal(advRes.state, "awaiting_approval");
  assert.equal(advRes.pendingApprovals[0].tool, "advance_guided_workflow");
  // Still parked: step 0 remains current until approval lands.
  assert.equal(db.prepare("SELECT state FROM piper_guided_workflow_steps WHERE workflow_id = ? AND step_index = 0").get(wfId).state, "current");

  const advanced = await runtime.decide({ toolCallId: advRes.pendingApprovals[0].id, approve: true, actor: "piper2-test" });
  assert.equal(advanced.ok, true);
  assert.equal(advanced.data.workflow.currentStep.key, "prepare_call");
  assert.equal(advanced.data.workflow.steps[0].note, "Record reviewed.");
});

test("guided workflows: the SAFETY RULE — advancing never executes the suggested tool", async (t) => {
  const { contextService, operator, guidedWorkflows, db } = await fresh(t);
  const snapshot = contextService.snapshot();
  const counts = () => ({
    interactions: db.prepare("SELECT COUNT(*) AS n FROM seller_interactions").get().n,
    nextActions: db.prepare("SELECT COUNT(*) AS n FROM operator_next_actions").get().n,
    notes: db.prepare("SELECT COUNT(*) AS n FROM operator_notes").get().n,
    toolCalls: db.prepare("SELECT COUNT(*) AS n FROM piper_tool_calls").get().n,
  });
  const before = counts();

  // seller_follow_up steps suggest prepare_call / log_interaction /
  // create_next_action. Walk the whole sequence through the tools.
  const started = await executeTool({
    name: "start_guided_workflow", args: { workflowKey: "seller_follow_up", opportunityId: "opp_wf_001" },
    snapshot, operator, guidedWorkflows,
  });
  const wfId = started.data.workflow.id;
  for (let i = 0; i < 4; i++) {
    const res = await executeTool({
      name: "advance_guided_workflow", args: { workflowId: wfId },
      snapshot, operator, guidedWorkflows,
    });
    assert.equal(res.ok, true);
  }
  assert.equal(guidedWorkflows.get(wfId).state, "completed");
  assert.deepEqual(counts(), before); // bookkeeping only — nothing executed
});

test("guided workflows: the snapshot surfaces the in-flight workflow and its current step", async (t) => {
  const { contextService, guidedWorkflows } = await fresh(t);
  const before = contextService.snapshot().opportunities.find((o) => o.id === "opp_wf_001");
  assert.equal(before.guidedWorkflow, null);

  const wf = guidedWorkflows.start({ workflowKey: "seller_follow_up", opportunityId: "opp_wf_001", actor: "piper2-test" });
  const during = contextService.snapshot().opportunities.find((o) => o.id === "opp_wf_001");
  assert.equal(during.guidedWorkflow.id, wf.id);
  assert.equal(during.guidedWorkflow.workflowKey, "seller_follow_up");
  assert.equal(during.guidedWorkflow.state, "active");
  assert.deepEqual(
    { key: during.guidedWorkflow.currentStep.key, index: during.guidedWorkflow.currentStep.index },
    { key: "review_record", index: 0 }
  );

  guidedWorkflows.advance(wf.id, { actor: "op-1" });
  const advanced = contextService.snapshot().opportunities.find((o) => o.id === "opp_wf_001");
  assert.equal(advanced.guidedWorkflow.currentStep.key, "prepare_call");

  guidedWorkflows.pause(wf.id);
  const paused = contextService.snapshot().opportunities.find((o) => o.id === "opp_wf_001");
  assert.equal(paused.guidedWorkflow.state, "paused"); // still in-flight, honestly labeled

  guidedWorkflows.abandon(wf.id);
  const after = contextService.snapshot().opportunities.find((o) => o.id === "opp_wf_001");
  assert.equal(after.guidedWorkflow, null); // settled workflows leave the snapshot
});

// --- F7: handoff validation against the Director identity registry --------------------

test("handoff (F7): a non-lead directory identity is a valid target; names resolve case-insensitively", async (t) => {
  const { app, contextService, operator } = await fresh(t);
  const dir = app.services.agents;
  const founder = dir.byName("Genaro");
  const spec = dir.createIdentity({
    name: "Research Specialist", kind: "specialist", role: "specialist",
    managerName: "OCG OS Director", actorAgentId: founder.id,
  });
  const snapshot = contextService.snapshot();
  const deps = { snapshot, operator, workRoom: app.services.workRoom, agentDirectory: dir };

  const toSpec = await executeTool({
    name: "handoff_to_agent",
    args: { targetAgent: "Research Specialist", summary: "Verify the tax records for Vine St.", opportunityId: "opp_wf_001" },
    ...deps,
  });
  assert.equal(toSpec.ok, true);
  assert.equal(toSpec.data.handoff.targetAgent, "Research Specialist");
  assert.equal(toSpec.data.handoff.targetAgentId, spec.id);
  const task = app.db.prepare("SELECT * FROM agent_work_tasks WHERE id = ?").get(toSpec.data.handoff.id);
  assert.equal(task.lead_agent, "Research Specialist");

  // Model-typed casing still resolves to the canonical identity.
  const lower = await executeTool({
    name: "handoff_to_agent",
    args: { targetAgent: "victor", summary: "Re-check the rehab numbers." },
    ...deps,
  });
  assert.equal(lower.ok, true);
  assert.equal(lower.data.handoff.targetAgent, "VICTOR");
});

test("handoff (F7): retired identities and non-agent identities are refused", async (t) => {
  const { app, contextService, operator } = await fresh(t);
  const dir = app.services.agents;
  const founder = dir.byName("Genaro");
  const temp = dir.createIdentity({
    name: "Temp Scout", kind: "specialist", role: "specialist",
    managerName: "OCG OS Director", actorAgentId: founder.id,
  });
  dir.retireIdentity({ agentId: temp.id, actorAgentId: founder.id });
  const deps = { snapshot: contextService.snapshot(), operator, workRoom: app.services.workRoom, agentDirectory: dir };

  const retired = await executeTool({
    name: "handoff_to_agent", args: { targetAgent: "Temp Scout", summary: "One last look." }, ...deps,
  });
  assert.equal(retired.ok, false);
  assert.equal(retired.error, "agent_not_active");

  const human = await executeTool({
    name: "handoff_to_agent", args: { targetAgent: "Genaro", summary: "Founder, do this." }, ...deps,
  });
  assert.equal(human.ok, false);
  assert.equal(human.error, "unknown_agent"); // the founder is escalated to, not handed work

  const nobody = await executeTool({
    name: "handoff_to_agent", args: { targetAgent: "NOBODY", summary: "Do a thing." }, ...deps,
  });
  assert.equal(nobody.ok, false);
  assert.equal(nobody.error, "unknown_agent");
});

test("handoff (F7): canonical naming is coherent — a Piper handoff to VICTOR blocks VICTOR's retirement", async (t) => {
  const { app, contextService, operator } = await fresh(t);
  const dir = app.services.agents;
  const res = await executeTool({
    name: "handoff_to_agent",
    args: { targetAgent: "VICTOR", summary: "Underwrite Vine St.", opportunityId: "opp_wf_001" },
    snapshot: contextService.snapshot(), operator, workRoom: app.services.workRoom, agentDirectory: dir,
  });
  assert.equal(res.ok, true);
  // The open task carries the directory name, so the directory's own
  // open-work guard sees it — the seam the hardcoded map used to hide.
  assert.throws(
    () => dir.retireIdentity({ agentId: dir.byName("VICTOR").id, actorAgentId: dir.byName("Genaro").id }),
    /agent_has_open_tasks/
  );
});

test("executeTool fallback (F7): direct callers get the GOVERNED construction, not a bare room", async (t) => {
  // A database migrated but never booted through createApp: no buildServices,
  // no seeding has happened. The fallback itself must supply the governed
  // substrate — handoff validates against the registry it constructs.
  const tmp = makeTempDb();
  t.after(() => tmp.cleanup());
  const db = openPipelineDatabase(tmp.dbPath);
  runMigrations(db, MIGRATIONS_DIR);
  seedOpp(db);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM agent_identities").get().n, 0, "nothing seeded yet");
  const operator = new SqliteOperatorRepository(db);
  const snapshot = new PiperContextService(db, testConfig(tmp.dbPath, { dataSource: "empty" })).snapshot();

  const res = await executeTool({
    name: "handoff_to_agent",
    args: { targetAgent: "HUNTER", summary: "Source comparable sales near Vine St.", opportunityId: "opp_wf_001" },
    snapshot, operator, // no workRoom, no agentDirectory — the fallback path
  });
  assert.equal(res.ok, true);
  assert.equal(res.data.handoff.targetAgent, "HUNTER");
  assert.ok(res.data.handoff.targetAgentId, "the fallback resolved a real directory identity");
  // And the room it built is the governed one: the task is visible through a
  // governed work room over the same database.
  const governed = buildAgentGovernance(db, operator.tenantId);
  assert.ok(governed.workRoom.get(res.data.handoff.id));
  db.close();
});
