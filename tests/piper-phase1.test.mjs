/**
 * Piper Phase 1 acceptance tests — the intelligence layer.
 *
 * Disposable temp database + a scripted stub provider standing in for Vertex.
 * What is under test is the governed wiring, not any model's quality:
 *
 *   - read tools return real CRM facts from real tables
 *   - entity resolution is deterministic; ambiguity asks, never guesses
 *   - multi-turn context resolves pronouns from stored identifiers
 *   - writes park for approval; approval executes through the operator repo
 *   - missing data is reported as not recorded, never invented
 *   - the null provider degrades honestly
 *   - unauthorized HTTP access is rejected
 */

import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDb, testConfig, startApp } from "./helpers/temporaryDatabase.mjs";
import { openPipelineDatabase } from "../src/database/openDatabase.js";
import { createApp } from "../src/app/createApp.js";
import { PiperRuntime, SYSTEM_PROMPT } from "../src/services/piper/piperRuntime.js";
import { PiperContextService } from "../src/services/piperContextService.js";
import { SqliteOperatorRepository } from "../src/repositories/sqlite/sqliteOperatorRepository.js";
import { NullProvider } from "../src/services/piper/providers/nullProvider.js";

/** Scripted stand-in for the Vertex model. Captures what the runtime sent. */
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
  async complete({ messages, tools, signal }) {
    this.sent.push({ messages, tools: (tools || []).map((t) => t.function.name) });
    const next = this.script.shift();
    if (typeof next === "function") return next({ messages });
    return next || { text: "done", toolCalls: [] };
  }
}

const call = (name, args = {}) => ({ text: "", toolCalls: [{ name, arguments: args }] });
const say = (text) => ({ text, toolCalls: [] });

function buildRuntime(dbPath, provider) {
  const config = testConfig(dbPath, { readOnly: false, isTest: false, dataSource: "empty" });
  const db = openPipelineDatabase(dbPath);
  const runtime = new PiperRuntime({
    db,
    config,
    contextService: new PiperContextService(db, config),
    operator: new SqliteOperatorRepository(db),
    provider,
  });
  return { runtime, db, config };
}

async function boot(dbPath) {
  // createApp applies every migration (incl. 026) to the temp database.
  const app = createApp(testConfig(dbPath, { dataSource: "empty" }));
  return app;
}

/** Disposable seller fixtures. Nothing here touches production. */
function seed(conn) {
  const contact = (id, fn, ln, email, phone) => conn.prepare(`
    INSERT INTO pipeline_contacts (id, first_name, last_name, email, phone)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, fn, ln, email, phone);
  const opp = (id, code, stage, price, prop) => conn.prepare(`
    INSERT INTO seller_opportunities (id, opportunity_code, pipeline_stage, opportunity_status, created_by, ocg_one_property_id, asking_price)
    VALUES (?, ?, ?, 'active', 'phase1-test', ?, ?)
  `).run(id, code, stage, prop, price);
  const part = (id, oppId, contactId) => conn.prepare(`
    INSERT INTO seller_opportunity_participants (id, opportunity_id, ocg_one_person_id, participant_role, is_primary, created_by)
    VALUES (?, ?, ?, 'primary_owner', 1, 'phase1-test')
  `).run(id, oppId, contactId);
  const src = (id, oppId, addr) => conn.prepare(`
    INSERT INTO seller_opportunity_sources (id, opportunity_id, source_type, original_address, conversion_actor, source_timestamp, conversion_timestamp)
    VALUES (?, ?, 'manual_entry', ?, 'phase1-test', '2026-09-01T10:00:00Z', '2026-09-01T10:00:00Z')
  `).run(id, oppId, addr);

  // Robert Chen — the fully-worked seller.
  contact("ct_robert", "Robert", "Chen", "robert@example.com", "3165550101");
  opp("opp_robert_001", "OPP-P1-001", "contacted", 180000, "prop-robert-1");
  part("part_robert", "opp_robert_001", "ct_robert");
  src("src_robert", "opp_robert_001", "123 Main St, Wichita, KS");
  conn.prepare(`
    INSERT INTO seller_interactions (id, opportunity_id, channel, direction, occurred_at, outcome, summary, created_by)
    VALUES ('int_robert_1', 'opp_robert_001', 'phone', 'outbound', '2026-09-15T14:00:00Z',
            'follow_up_scheduled', 'Discussed asking price; seller objected to the closing timeline.', 'phase1-test')
  `).run();
  conn.prepare(`
    INSERT INTO operator_notes (id, opportunity_id, body, created_by)
    VALUES ('note_robert_1', 'opp_robert_001', 'Seller motivated by relocation; wants close before October.', 'phase1-test')
  `).run();
  conn.prepare(`
    INSERT INTO operator_next_actions (id, opportunity_id, title, due_date, status, created_by)
    VALUES ('task_robert_overdue', 'opp_robert_001', 'Call Robert back', '2026-09-10', 'open', 'phase1-test')
  `).run();
  conn.prepare(`
    INSERT INTO operator_next_actions (id, opportunity_id, title, due_date, status, created_by)
    VALUES ('task_robert_future', 'opp_robert_001', 'Send comps', '2026-12-01', 'open', 'phase1-test')
  `).run();
  conn.prepare(`
    INSERT INTO seller_stage_events (id, opportunity_id, prior_stage, new_stage, changed_by)
    VALUES ('stage_robert_1', 'opp_robert_001', 'new_lead', 'contacted', 'phase1-test')
  `).run();
  // One offer with two versions.
  conn.prepare(`
    INSERT INTO seller_offers (id, opportunity_id, current_version, status, created_by)
    VALUES ('offer_robert_1', 'opp_robert_001', 2, 'presented', 'phase1-test')
  `).run();
  const ver = (id, n, status, price) => conn.prepare(`
    INSERT INTO seller_offer_versions (id, offer_id, version_number, version_status, strategy_type,
      purchase_price, earnest_money, inspection_days, closing_days, contingencies_json,
      underwriting_source_type, underwriting_source_id, underwriting_version_id,
      underwriting_arv_snapshot, underwriting_rehab_snapshot, underwriting_mao_snapshot, created_by)
    VALUES (?, 'offer_robert_1', ?, ?, 'cash_purchase', ?, 1000, 10, 30, '[]',
      'victor_analysis', 'uw1', 'v1', 220000, 30000, 140000, 'phase1-test')
  `).run(id, n, status, price);
  ver("over_robert_v1", 1, "superseded", 135000);
  ver("over_robert_v2", 2, "approved", 140000);

  // Robert Smith — the ambiguity fixture (same first name, different seller).
  contact("ct_robert2", "Robert", "Smith", "rsmith@example.com", "3165550202");
  opp("opp_robert2_001", "OPP-P1-002", "new_lead", 95000, "prop-robert-2");
  part("part_robert2", "opp_robert2_001", "ct_robert2");
  src("src_robert2", "opp_robert2_001", "456 Oak Ave, Wichita, KS");

  // Tom Baker — "the guy on Maple who wanted 180".
  contact("ct_tom", "Tom", "Baker", "tom@example.com", "3165550303");
  opp("opp_tom_001", "OPP-P1-003", "qualified", 180000, "prop-tom-1");
  part("part_tom", "opp_tom_001", "ct_tom");
  src("src_tom", "opp_tom_001", "789 Maple Dr, Wichita, KS");

  // Maria Garcia — no interactions, no tasks, no offers (missing-data fixture).
  contact("ct_maria", "Maria", "Garcia", "maria@example.com", "3165550404");
  opp("opp_maria_001", "OPP-P1-004", "new_lead", 120000, "prop-maria-1");
  part("part_maria", "opp_maria_001", "ct_maria");
  src("src_maria", "opp_maria_001", "321 Elm St, Wichita, KS");

  // Dana White — email only, no phone (channel-validation fixture).
  contact("ct_dana", "Dana", "White", "dana@example.com", null);
  opp("opp_dana_001", "OPP-P1-005", "contacted", 150000, "prop-dana-1");
  part("part_dana", "opp_dana_001", "ct_dana");
  src("src_dana", "opp_dana_001", "654 Pine St, Wichita, KS");
}

async function fresh(t) {
  const tmp = makeTempDb();
  const app = await boot(tmp.dbPath);
  const { default: sqlite } = await import("node:sqlite");
  const conn = new sqlite.DatabaseSync(tmp.dbPath);
  seed(conn);
  conn.close();
  const provider = new ScriptedProvider();
  const { runtime, db } = buildRuntime(tmp.dbPath, provider);
  t.after(() => { try { app.close(); } catch {} try { db.close(); } catch {} tmp.cleanup(); });
  return { runtime, db, provider, dbPath: tmp.dbPath };
}

// --- 1. exact-name seller lookup --------------------------------------------

test("1. find_seller resolves an exact seller name", async (t) => {
  const { runtime, provider } = await fresh(t);
  provider.script.push(
    call("find_seller", { name: "Robert Chen" }),
    say("Robert Chen at 123 Main St.")
  );
  const res = await runtime.ask({ question: "Tell me about Robert Chen." });
  assert.equal(res.state, "complete");
  const toolResult = provider.sent.length; // sanity: the model was consulted
  assert.ok(toolResult >= 1);
  const ctx = runtime.db.prepare("SELECT context_json FROM piper_threads WHERE id = ?").get(res.threadId);
  const parsed = JSON.parse(ctx.context_json);
  assert.equal(parsed.active_seller_id, "ct_robert");
  assert.equal(parsed.active_seller_name, "Robert Chen");
});

// --- 2. property lookup ------------------------------------------------------

test("2. find_seller resolves a seller by property address", async (t) => {
  const { runtime, provider } = await fresh(t);
  provider.script.push(
    call("find_seller", { address: "Main St" }),
    say("Found on Main St.")
  );
  const res = await runtime.ask({ question: "Who owns the place on Main St?" });
  assert.equal(res.state, "complete");
  const parsed = JSON.parse(runtime.db.prepare("SELECT context_json FROM piper_threads WHERE id = ?").get(res.threadId).context_json);
  assert.equal(parsed.active_seller_id, "ct_robert");
});

// --- 3. partial / descriptive lookup ----------------------------------------

test("3. search_pipeline finds the guy on Maple who wanted 180", async (t) => {
  const { runtime, provider } = await fresh(t);
  provider.script.push(
    call("search_pipeline", { street: "Maple", askingPrice: 180000 }),
    say("Tom Baker, 789 Maple Dr.")
  );
  const res = await runtime.ask({ question: "Find the guy on Maple who wanted 180." });
  assert.equal(res.state, "complete");
  // The governed tool ran against real data; verify directly too.
  const { executeTool } = await import("../src/services/piper/toolRegistry.js");
  const direct = await executeTool({
    name: "search_pipeline",
    args: { street: "Maple", askingPrice: 180000 },
    snapshot: runtime.context.snapshot(),
    operator: runtime.operator,
  });
  assert.equal(direct.ok, true);
  assert.equal(direct.data.results.length, 1);
  assert.equal(direct.data.results[0].seller, "Tom Baker");
  assert.ok(direct.data.results[0].matchReasons.some((r) => r.includes("Maple")));
});

// --- 4. seller summary -------------------------------------------------------

test("4. get_seller_summary returns grounded seller facts", async (t) => {
  const { runtime, provider } = await fresh(t);
  provider.script.push(
    call("get_seller_summary", { contactId: "ct_robert" }),
    say("Robert Chen summary.")
  );
  const res = await runtime.ask({ question: "Summarize Robert Chen for me." });
  assert.equal(res.state, "complete");
  const { executeTool } = await import("../src/services/piper/toolRegistry.js");
  const direct = await executeTool({
    name: "get_seller_summary",
    args: { contactId: "ct_robert" },
    snapshot: runtime.context.snapshot(),
    operator: runtime.operator,
  });
  assert.equal(direct.ok, true);
  assert.equal(direct.data.seller.displayName, "Robert Chen");
  assert.equal(direct.data.seller.phone, "3165550101");
  assert.ok(direct.data.opportunities.some((o) => o.address.includes("123 Main St")));
});

// --- 5. opportunity summary --------------------------------------------------

test("5. get_opportunity returns the opportunity snapshot", async (t) => {
  const { runtime, provider } = await fresh(t);
  provider.script.push(
    call("get_opportunity", { opportunityId: "opp_robert_001" }),
    say("Opportunity summary.")
  );
  const res = await runtime.ask({ question: "What is going on with opp_robert_001?" });
  assert.equal(res.state, "complete");
  const parsed = JSON.parse(runtime.db.prepare("SELECT context_json FROM piper_threads WHERE id = ?").get(res.threadId).context_json);
  assert.equal(parsed.active_opportunity_id, "opp_robert_001");
});

// --- 6. last contact ---------------------------------------------------------

test("6. get_last_contact answers from the recorded interaction", async (t) => {
  const { runtime, provider } = await fresh(t);
  provider.script.push(
    call("get_last_contact", { opportunityId: "opp_robert_001" }),
    ({ messages }) => {
      const toolMsg = messages.find((m) => m.content.startsWith("Tool get_last_contact returned:"));
      assert.ok(toolMsg.content.includes("2026-09-15T14:00:00Z"), "tool result carries the real date");
      assert.ok(toolMsg.content.includes("closing timeline"), "tool result carries the real summary");
      return say("You last spoke with Robert on 2026-09-15.");
    }
  );
  const res = await runtime.ask({ question: "When did we last speak with Robert?", activeOpportunityId: "opp_robert_001" });
  assert.equal(res.state, "complete");
  assert.match(res.answer, /2026-09-15/);
});

// --- 7. offer history --------------------------------------------------------

test("7. get_offer_history returns versions, newest first", async (t) => {
  const { runtime } = await fresh(t);
  const { executeTool } = await import("../src/services/piper/toolRegistry.js");
  const direct = await executeTool({
    name: "get_offer_history",
    args: { opportunityId: "opp_robert_001" },
    snapshot: runtime.context.snapshot(),
    operator: runtime.operator,
  });
  assert.equal(direct.ok, true);
  assert.equal(direct.data.offers.length, 1);
  assert.equal(direct.data.offers[0].versions.length, 2);
  assert.equal(direct.data.offers[0].versions[0].purchasePrice, 140000);
  assert.equal(direct.data.offers[0].versions[0].versionStatus, "approved");
});

// --- 8. follow-ups due -------------------------------------------------------

test("8. get_tasks with filter=due surfaces the overdue follow-up", async (t) => {
  const { runtime } = await fresh(t);
  const { executeTool } = await import("../src/services/piper/toolRegistry.js");
  const direct = await executeTool({
    name: "get_tasks",
    args: { filter: "due" },
    snapshot: runtime.context.snapshot(),
    operator: runtime.operator,
  });
  assert.equal(direct.ok, true);
  assert.ok(direct.data.tasks.some((x) => x.id === "task_robert_overdue"), "overdue task is due");
  assert.ok(!direct.data.tasks.some((x) => x.id === "task_robert_future"), "future task is not due");
});

// --- 9. overdue follow-ups ---------------------------------------------------

test("9. get_tasks with filter=overdue returns only past-due open tasks", async (t) => {
  const { runtime } = await fresh(t);
  const { executeTool } = await import("../src/services/piper/toolRegistry.js");
  const direct = await executeTool({
    name: "get_tasks",
    args: { filter: "overdue" },
    snapshot: runtime.context.snapshot(),
    operator: runtime.operator,
  });
  assert.equal(direct.ok, true);
  assert.equal(direct.data.tasks.length, 1);
  assert.equal(direct.data.tasks[0].id, "task_robert_overdue");
  assert.equal(direct.data.tasks[0].overdue, true);
  assert.ok(direct.data.tasks[0].address.includes("123 Main St"));
});

// --- 10. multi-turn pronoun resolution --------------------------------------

test("10. pronouns resolve across turns without repeating the name", async (t) => {
  const { runtime, provider } = await fresh(t);
  provider.script.push(
    call("find_seller", { name: "Robert Chen" }),
    say("Robert Chen, 123 Main St, stage contacted."),
    // Turn 2: the script inspects what the runtime actually sent the model.
    ({ messages }) => {
      const system = messages.find((m) => m.role === "system").content;
      assert.ok(system.includes("Robert Chen"), "preamble carries the active seller");
      assert.ok(system.includes("ct_robert"), "preamble carries the seller id");
      return call("get_last_contact", { opportunityId: "opp_robert_001" });
    },
    say("Last spoke 2026-09-15; he objected to the closing timeline.")
  );
  const turn1 = await runtime.ask({ question: "Tell me about Robert Chen." });
  assert.equal(turn1.state, "complete");
  const turn2 = await runtime.ask({ question: "When did we last speak?", threadId: turn1.threadId });
  assert.equal(turn2.state, "complete");
  assert.equal(turn2.threadId, turn1.threadId);
  assert.match(turn2.answer, /2026-09-15/);
});

// --- 11. active record context ------------------------------------------------

test("11. activeOpportunityId seeds the thread context", async (t) => {
  const { runtime, provider } = await fresh(t);
  provider.script.push(({ messages }) => {
    const system = messages.find((m) => m.role === "system").content;
    assert.ok(system.includes("opp_robert_001"), "preamble names the on-screen record");
    return say("ok");
  });
  const res = await runtime.ask({ question: "Summarize this.", activeOpportunityId: "opp_robert_001" });
  assert.equal(res.state, "complete");
  const parsed = JSON.parse(runtime.db.prepare("SELECT context_json FROM piper_threads WHERE id = ?").get(res.threadId).context_json);
  assert.equal(parsed.active_opportunity_id, "opp_robert_001");
});

// --- 12. ambiguous entity handling --------------------------------------------

test("12. ambiguous sellers produce a clarification, never a guess", async (t) => {
  const { runtime, provider } = await fresh(t);
  provider.script.push(
    call("find_seller", { name: "Robert" }),
    ({ messages }) => {
      const toolMsg = messages.find((m) => m.content.startsWith("Tool find_seller returned:"));
      const payload = JSON.parse(toolMsg.content.replace("Tool find_seller returned:\n", ""));
      assert.equal(payload.ok, true);
      assert.equal(payload.data.ambiguous, true, "two Roberts = ambiguous");
      assert.equal(payload.data.candidates.length, 2);
      return say("I found two sellers named Robert — Robert Chen (123 Main St) and Robert Smith (456 Oak Ave). Which one?");
    }
  );
  const res = await runtime.ask({ question: "Tell me about Robert." });
  assert.equal(res.state, "complete");
  assert.match(res.answer, /two sellers|which one/i);
  // The context must NOT have guessed.
  const parsed = JSON.parse(runtime.db.prepare("SELECT context_json FROM piper_threads WHERE id = ?").get(res.threadId).context_json);
  assert.equal(parsed.active_seller_id, null);
});

// --- 13. missing data ----------------------------------------------------------

test("13. missing facts are reported as not recorded", async (t) => {
  const { runtime, provider } = await fresh(t);
  provider.script.push(
    call("get_last_contact", { opportunityId: "opp_maria_001" }),
    say("I don't have any recorded contact with Maria Garcia — it's not recorded in PIPELINE.")
  );
  const res = await runtime.ask({ question: "When did we last speak with Maria Garcia?", activeOpportunityId: "opp_maria_001" });
  assert.equal(res.state, "complete");
  assert.match(res.answer, /not recorded/i);
  assert.doesNotMatch(res.answer, /2026-09-1[05]/, "no invented date leaks in");
});

// --- 14. no hallucinated facts --------------------------------------------------

test("14. empty tool results stay empty; grounding rules are contractual", async (t) => {
  const { runtime } = await fresh(t);
  const { executeTool } = await import("../src/services/piper/toolRegistry.js");
  const noSeller = await executeTool({
    name: "find_seller",
    args: { name: "Nobody Nonexistent" },
    snapshot: runtime.context.snapshot(),
    operator: runtime.operator,
  });
  assert.equal(noSeller.ok, true);
  assert.equal(noSeller.data.candidates.length, 0);
  assert.equal(noSeller.data.ambiguous, false);
  const noOpp = await executeTool({
    name: "get_seller_timeline",
    args: { opportunityId: "opp_does_not_exist" },
    snapshot: runtime.context.snapshot(),
    operator: runtime.operator,
  });
  assert.equal(noOpp.ok, false);
  assert.equal(noOpp.error, "not_found");
  // The grounding rules are part of the shipped contract.
  assert.match(SYSTEM_PROMPT, /not recorded/i);
  assert.match(SYSTEM_PROMPT, /never infer/i);
  assert.match(SYSTEM_PROMPT, /do not write SQL/i);
});

// --- 15. unauthorized access rejected --------------------------------------------

test("15. piper endpoints reject unauthenticated production requests", async (t) => {
  const tmp = makeTempDb();
  const secret = "f".repeat(64);
  const { app, baseUrl } = await startApp(
    createApp,
    testConfig(tmp.dbPath, { env: "production", operatorSecret: secret, dataSource: "empty" })
  );
  t.after(() => { app.close(); tmp.cleanup(); });

  const anon = await fetch(`${baseUrl}/api/v1/piper/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question: "Who needs my attention?" }),
  });
  assert.equal(anon.status, 401);
  const anonBody = await anon.json();
  assert.equal(anonBody.error, "authentication_required");

  const authed = await fetch(`${baseUrl}/api/v1/piper/status`, {
    headers: { Authorization: `Bearer ${secret}` },
  });
  assert.equal(authed.status, 200);
});

// --- 16. write approval gate ------------------------------------------------------

test("16. writes park for approval; approval executes; drafts never send", async (t) => {
  const { runtime, provider, db, dbPath } = await fresh(t);
  provider.script.push(call("create_next_action", { opportunityId: "opp_robert_001", title: "Call Robert", dueDate: "2026-09-25" }));
  const res = await runtime.ask({ question: "Remind me to call Robert on Sept 25." });
  assert.equal(res.state, "awaiting_approval");
  assert.equal(res.pendingApprovals.length, 1);
  assert.equal(res.pendingApprovals[0].tool, "create_next_action");
  // Parked, not written.
  const before = db.prepare("SELECT COUNT(*) AS n FROM operator_next_actions WHERE title = 'Call Robert'").get().n;
  assert.equal(before, 0);

  const approved = await runtime.decide({ toolCallId: res.pendingApprovals[0].id, approve: true, actor: "phase1-test" });
  assert.equal(approved.ok, true);
  assert.equal(approved.wrote, true);
  const after = db.prepare("SELECT COUNT(*) AS n FROM operator_next_actions WHERE title = 'Call Robert'").get().n;
  assert.equal(after, 1);

  // SMS draft approval: creates a draft + drafted event, never a send.
  const provider2 = new ScriptedProvider([
    call("draft_sms", { opportunityId: "opp_robert_001", contentText: "Hi Robert, following up." }),
  ]);
  const built2 = buildRuntime(dbPath, provider2);
  const runtime2 = built2.runtime;
  const db2 = built2.db;
  t.after(() => { try { db2.close(); } catch {} });
  const res2 = await runtime2.ask({ question: "Draft a text to Robert." });
  assert.equal(res2.state, "awaiting_approval");
  const decided = await runtime2.decide({ toolCallId: res2.pendingApprovals[0].id, approve: true, actor: "phase1-test" });
  assert.equal(decided.ok, true);
  const comm = db.prepare("SELECT * FROM seller_communications WHERE opportunity_id = 'opp_robert_001' AND recipient_channel = 'sms'").get();
  assert.ok(comm, "sms draft row exists");
  const events = db.prepare("SELECT event_type FROM seller_communication_events WHERE communication_id = ?").all(comm.id).map((e) => e.event_type);
  assert.deepEqual(events, ["drafted"]);
  assert.ok(!events.includes("sent") && !events.includes("send_attempted"), "sending is not wired");

  // Channel validation: Dana has no phone — draft_sms must fail explicitly.
  const { executeTool } = await import("../src/services/piper/toolRegistry.js");
  const bad = await executeTool({
    name: "draft_sms",
    args: { opportunityId: "opp_dana_001", contentText: "Hi Dana." },
    snapshot: runtime.context.snapshot(),
    operator: runtime.operator,
  }).catch((err) => ({ ok: false, error: err.message }));
  assert.equal(bad.ok, false);
  assert.match(String(bad.error), /recipient_phone_required/);
});

// --- 17. provider-unavailable fallback -------------------------------------------------

test("17. null provider degrades to the honest deterministic path", async (t) => {
  const { db } = await fresh(t);
  const config = testConfig(":memory:");
  const runtime = new PiperRuntime({
    db,
    config,
    contextService: new PiperContextService(db, config),
    operator: new SqliteOperatorRepository(db),
    provider: new NullProvider(),
  });
  const res = await runtime.ask({ question: "Who do I need to follow up with today?" });
  assert.equal(res.deterministic, true);
  assert.equal(res.state, "complete");
  assert.equal(typeof res.answer, "string");
  assert.ok(res.answer.length > 0);
  assert.equal(res.wrote, false);
});

// --- 18. paraphrases hit the same governed tools ---------------------------------------

test("18. paraphrased follow-up questions route to the same governed tool", async (t) => {
  const mk = async () => {
    const tmp2 = makeTempDb();
    const app = await boot(tmp2.dbPath);
    const { default: sqlite } = await import("node:sqlite");
    const conn = new sqlite.DatabaseSync(tmp2.dbPath);
    seed(conn);
    conn.close();
    const p = new ScriptedProvider([call("get_tasks", { filter: "due" }), say("Here are the follow-ups due.")]);
    const { runtime: r, db: d } = buildRuntime(tmp2.dbPath, p);
    return { tmp: tmp2, app, runtime: r, db: d, provider: p, close() { try { app.close(); } catch {} try { d.close(); } catch {} tmp2.cleanup(); } };
  };
  const a = await mk();
  const b = await mk();
  t.after(() => { a.close(); b.close(); });

  const resA = await a.runtime.ask({ question: "Who do I need to follow up with today?" });
  const resB = await b.runtime.ask({ question: "Show me sellers with no follow-up scheduled." });
  assert.equal(resA.state, "complete");
  assert.equal(resB.state, "complete");

  const toolsUsed = (rt) => rt.db.prepare("SELECT DISTINCT tool_name FROM piper_tool_calls").all().map((r) => r.tool_name);
  // NOTE: read tools execute without a piper_tool_calls row (only writes are
  // recorded). Assert via the provider capture instead:
  const readNames = (p) => p.sent.flatMap((s) => s.messages)
    .filter((m) => typeof m.content === "string" && m.content.startsWith("Tool "))
    .map((m) => m.content.split(" ")[1]);
  assert.ok(readNames(a.provider).includes("get_tasks"), "paraphrase A used get_tasks");
  assert.ok(readNames(b.provider).includes("get_tasks"), "paraphrase B used get_tasks");
  assert.equal(resA.wrote, false);
  assert.equal(resB.wrote, false);
  assert.ok(!toolsUsed(a.runtime).length && !toolsUsed(b.runtime).length, "reads leave no tool-call rows");
});
