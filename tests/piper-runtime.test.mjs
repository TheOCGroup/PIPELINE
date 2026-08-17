/**
 * Piper runtime — memory, states, cancellation, and the approval gate.
 *
 * A fake provider stands in for a model so tool-calling, cancellation and
 * approval can be exercised deterministically. What is under test is the
 * runtime's contract, not any particular model's quality:
 *
 *   - a model can propose a write, but cannot perform one
 *   - a rejected or cancelled run writes nothing, verifiably
 *   - the transcript survives the process
 *   - state transitions match the work that actually happened
 */

import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDb, testConfig } from "./helpers/temporaryDatabase.mjs";
import { openPipelineDatabase } from "../src/database/openDatabase.js";
import { createApp } from "../src/app/createApp.js";
import { PiperRuntime } from "../src/services/piper/piperRuntime.js";
import { PiperContextService } from "../src/services/piperContextService.js";
import { SqliteOperatorRepository } from "../src/repositories/sqlite/sqliteOperatorRepository.js";
import { NullProvider } from "../src/services/piper/providers/nullProvider.js";
import { RUN_STATES, canTransition, isBusy, isSettled, describeState } from "../src/domain/piper/runState.js";

/** A model stand-in with scripted replies. */
class FakeProvider {
  constructor(script = []) {
    this.kind = "fake";
    this.model = "fake-1";
    this.connected = true;
    this.script = [...script];
    this.calls = 0;
    this.lastSignal = null;
  }
  describe() { return { provider: "fake", model: this.model, connected: true }; }
  async probe() { return { ok: true, toolCalling: true }; }
  async complete({ signal }) {
    this.calls += 1;
    this.lastSignal = signal;
    const next = this.script.shift();
    if (typeof next === "function") return next({ signal });
    return next || { text: "done", toolCalls: [] };
  }
}

function buildRuntime(dbPath, { provider = new NullProvider(), readOnly = false } = {}) {
  const config = testConfig(dbPath, { readOnly, isTest: false });
  const app = createApp(config);
  const db = openPipelineDatabase(dbPath);
  const runtime = new PiperRuntime({
    db,
    config,
    contextService: new PiperContextService(db, config),
    operator: new SqliteOperatorRepository(db),
    provider,
  });
  return { runtime, db, app, config };
}

// --- state machine ---------------------------------------------------------

test("run states model the work, not a simulation of it", () => {
  assert.ok(isBusy(RUN_STATES.RETRIEVING));
  assert.ok(isBusy(RUN_STATES.GENERATING));
  assert.ok(isBusy(RUN_STATES.RUNNING_TOOL));
  assert.ok(!isBusy(RUN_STATES.AWAITING_APPROVAL), "waiting on a human is not the system working");

  assert.ok(isSettled(RUN_STATES.COMPLETE));
  assert.ok(isSettled(RUN_STATES.FAILED));
  assert.ok(isSettled(RUN_STATES.CANCELED));

  // A run cannot claim success without having done the work.
  assert.ok(!canTransition(RUN_STATES.COMPLETE, RUN_STATES.GENERATING));
  assert.ok(canTransition(RUN_STATES.RETRIEVING, RUN_STATES.GENERATING));
  assert.ok(canTransition(RUN_STATES.AWAITING_APPROVAL, RUN_STATES.RUNNING_TOOL));

  // Failure and cancellation both state plainly that nothing was written.
  assert.match(describeState(RUN_STATES.FAILED), /nothing was written/i);
  assert.match(describeState(RUN_STATES.CANCELED), /nothing was written/i);
  assert.match(describeState(RUN_STATES.AWAITING_APPROVAL, { toolName: "add_note" }), /nothing has been written/i);
});

// --- no provider -----------------------------------------------------------

test("with no provider Piper still answers from stored state", async (t) => {
  const tempDb = makeTempDb();
  t.after(() => tempDb.cleanup());
  const { runtime, db, app } = buildRuntime(tempDb.dbPath);
  t.after(() => { db.close(); app.close(); });

  const res = await runtime.ask({ question: "what needs my attention?" });
  assert.equal(res.state, RUN_STATES.COMPLETE);
  assert.equal(res.deterministic, true);
  assert.equal(res.wrote, false);
  assert.ok(res.answer.length > 0);
  assert.equal(runtime.describeProvider().connected, false);
});

// --- memory ----------------------------------------------------------------

test("the transcript persists and is append-only", async (t) => {
  const tempDb = makeTempDb();
  t.after(() => tempDb.cleanup());
  const { runtime, db, app } = buildRuntime(tempDb.dbPath);
  t.after(() => { db.close(); app.close(); });

  const first = await runtime.ask({ question: "which deals are stalled?" });
  const second = await runtime.ask({ question: "what am I missing?", threadId: first.threadId });
  assert.equal(second.threadId, first.threadId, "the thread is reused");

  const transcript = runtime.getTranscript(first.threadId);
  assert.equal(transcript.filter((m) => m.role === "user").length, 2);
  assert.equal(transcript.filter((m) => m.role === "assistant").length, 2);

  // Survives a fresh handle — it is in SQLite, not memory.
  const reopened = openPipelineDatabase(tempDb.dbPath);
  const rows = reopened.prepare("SELECT COUNT(*) n FROM piper_messages WHERE thread_id = ?").get(first.threadId).n;
  assert.ok(rows >= 4);

  const row = reopened.prepare("SELECT id FROM piper_messages LIMIT 1").get();
  assert.throws(
    () => reopened.prepare("UPDATE piper_messages SET content = ? WHERE id = ?").run("rewritten", row.id),
    /append-only|prohibited/i
  );
  reopened.close();
});

// --- tool calling and approval --------------------------------------------

test("a model may propose a write but never performs one", async (t) => {
  const tempDb = makeTempDb();
  t.after(() => tempDb.cleanup());

  const provider = new FakeProvider([
    { text: "I can add that.", toolCalls: [{ id: "c1", name: "create_next_action", arguments: { opportunityId: "FX-OPP-0001", title: "Call the seller" } }] },
  ]);
  const { runtime, db, app } = buildRuntime(tempDb.dbPath, { provider });
  t.after(() => { db.close(); app.close(); });

  const res = await runtime.ask({ question: "add a next action to call the seller", activeOpportunityId: "FX-OPP-0001" });

  assert.equal(res.state, RUN_STATES.AWAITING_APPROVAL);
  assert.equal(res.wrote, false);
  assert.equal(res.pendingApprovals.length, 1);
  assert.equal(res.pendingApprovals[0].tool, "create_next_action");

  // Crucially: nothing in the database yet.
  assert.equal(db.prepare("SELECT COUNT(*) n FROM operator_next_actions").get().n, 0, "a proposal writes nothing");

  // Approving is what writes.
  const decision = await runtime.decide({ toolCallId: res.pendingApprovals[0].id, approve: true });
  assert.equal(decision.ok, true);
  assert.equal(decision.wrote, true);

  const row = db.prepare("SELECT * FROM operator_next_actions WHERE opportunity_id = ?").get("FX-OPP-0001");
  assert.ok(row, "the approved action is written");
  assert.equal(row.title, "Call the seller");
  assert.equal(runtime.getRun(res.runId).state, RUN_STATES.COMPLETE);
});

test("declining a proposal writes nothing and says so", async (t) => {
  const tempDb = makeTempDb();
  t.after(() => tempDb.cleanup());

  const provider = new FakeProvider([
    { text: "Proposing.", toolCalls: [{ id: "c1", name: "add_note", arguments: { opportunityId: "FX-OPP-0001", body: "should not persist" } }] },
  ]);
  const { runtime, db, app } = buildRuntime(tempDb.dbPath, { provider });
  t.after(() => { db.close(); app.close(); });

  const res = await runtime.ask({ question: "note that" });
  const decision = await runtime.decide({ toolCallId: res.pendingApprovals[0].id, approve: false });

  assert.equal(decision.ok, true);
  assert.equal(decision.wrote, false);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM operator_notes").get().n, 0);

  const call = db.prepare("SELECT status FROM piper_tool_calls WHERE id = ?").get(res.pendingApprovals[0].id);
  assert.equal(call.status, "rejected", "the declined proposal is recorded, not erased");
});

test("read tools execute without approval and cannot mutate", async (t) => {
  const tempDb = makeTempDb();
  t.after(() => tempDb.cleanup());

  const provider = new FakeProvider([
    { text: "", toolCalls: [{ id: "r1", name: "find_opportunities", arguments: { limit: 5 } }] },
    { text: "Four opportunities are loaded.", toolCalls: [] },
  ]);
  const { runtime, db, app } = buildRuntime(tempDb.dbPath, { provider });
  t.after(() => { db.close(); app.close(); });

  const res = await runtime.ask({ question: "what have we got?" });
  assert.equal(res.state, RUN_STATES.COMPLETE);
  assert.equal(res.wrote, false);
  assert.equal(res.pendingApprovals.length, 0);
  assert.ok(provider.calls >= 2, "the tool result was fed back to the model");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM operator_next_actions").get().n, 0);
});

// --- read-only -------------------------------------------------------------

test("read-only refuses an approved write", async (t) => {
  const tempDb = makeTempDb();
  t.after(() => tempDb.cleanup());

  const provider = new FakeProvider([
    { text: "Proposing.", toolCalls: [{ id: "c1", name: "add_note", arguments: { opportunityId: "FX-OPP-0001", body: "blocked" } }] },
  ]);
  const { runtime, db, app } = buildRuntime(tempDb.dbPath, { provider, readOnly: true });
  t.after(() => { db.close(); app.close(); });

  const res = await runtime.ask({ question: "note that" });
  const decision = await runtime.decide({ toolCallId: res.pendingApprovals[0].id, approve: true });

  assert.equal(decision.ok, false);
  assert.equal(decision.error, "read_only");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM operator_notes").get().n, 0);
});

// --- cancellation ----------------------------------------------------------

test("cancelling an in-flight run aborts it and writes nothing", async (t) => {
  const tempDb = makeTempDb();
  t.after(() => tempDb.cleanup());

  let capturedRunId = null;
  const provider = new FakeProvider([
    ({ signal }) => new Promise((resolve, reject) => {
      // Cancel arrives while the provider request is in flight.
      setTimeout(() => runtime.cancel(capturedRunId), 10);
      signal.addEventListener("abort", () => {
        const e = new Error("aborted");
        e.code = "canceled";
        reject(e);
      }, { once: true });
      setTimeout(() => resolve({ text: "should never arrive", toolCalls: [] }), 5000);
    }),
  ]);

  const { runtime, db, app } = buildRuntime(tempDb.dbPath, { provider });
  t.after(() => { db.close(); app.close(); });

  // Capture the run id as soon as it exists.
  const original = runtime.ask.bind(runtime);
  const promise = original({ question: "long running" });
  await new Promise((r) => setTimeout(r, 5));
  capturedRunId = db.prepare("SELECT id FROM piper_runs ORDER BY started_at DESC, rowid DESC LIMIT 1").get()?.id;

  const res = await promise;
  assert.equal(res.state, RUN_STATES.CANCELED);
  assert.equal(res.wrote, false);
  assert.match(res.answer, /nothing was written/i);
});

test("a settled run cannot be cancelled", async (t) => {
  const tempDb = makeTempDb();
  t.after(() => tempDb.cleanup());
  const { runtime, db, app } = buildRuntime(tempDb.dbPath);
  t.after(() => { db.close(); app.close(); });

  const res = await runtime.ask({ question: "system health" });
  const result = runtime.cancel(res.runId);
  assert.equal(result.ok, false);
  assert.equal(result.error, "not_cancellable");
});

// --- failure ---------------------------------------------------------------

test("a provider failure settles as failed and writes nothing", async (t) => {
  const tempDb = makeTempDb();
  t.after(() => tempDb.cleanup());

  const provider = new FakeProvider([
    () => { const e = new Error("boom"); e.code = "provider_error"; throw e; },
  ]);
  const { runtime, db, app } = buildRuntime(tempDb.dbPath, { provider });
  t.after(() => { db.close(); app.close(); });

  const res = await runtime.ask({ question: "anything" });
  assert.equal(res.state, RUN_STATES.FAILED);
  assert.equal(res.errorCode, "provider_error");
  assert.match(res.answer, /nothing was written/i);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM operator_next_actions").get().n, 0);
});

// --- screen context --------------------------------------------------------

test("the open opportunity is supplied to the model as context", async (t) => {
  const tempDb = makeTempDb();
  t.after(() => tempDb.cleanup());

  let seenSystem = "";
  const provider = new FakeProvider([
    () => { return { text: "ok", toolCalls: [] }; },
  ]);
  provider.complete = async ({ messages }) => {
    seenSystem = messages.find((m) => m.role === "system")?.content || "";
    return { text: "ok", toolCalls: [] };
  };

  const { runtime, db, app } = buildRuntime(tempDb.dbPath, { provider });
  t.after(() => { db.close(); app.close(); });

  await runtime.ask({ question: "why is this still here?", activeOpportunityId: "FX-OPP-0001" });
  assert.match(seenSystem, /FX-OPP-0001/, "the on-screen record is named in the prompt");
  assert.match(seenSystem, /open on screen/i);
});
