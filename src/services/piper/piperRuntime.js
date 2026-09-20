/**
 * Piper's runtime.
 *
 * Orchestrates one turn: retrieve real state, ask the model (if one is
 * configured), execute read tools, park write tools for approval, persist the
 * transcript, and settle the run in a state that reflects what actually
 * happened.
 *
 * Three invariants hold whether or not a model is connected:
 *
 *   1. Facts come from SQLite. The model phrases; retrieval supplies. A model
 *      that hallucinates an opportunity cannot make one appear, because every
 *      claim the UI renders is drawn from tool results, not prose.
 *   2. No write happens without approval. Write tools are recorded as proposals
 *      and executed on a separate, operator-initiated call.
 *   3. Cancellation is real. The abort signal reaches the provider's socket, so
 *      "stop" stops the request rather than hiding it.
 *
 * With no provider configured the runtime falls back to the deterministic intent
 * router, which answers the operator's real questions from the same snapshot.
 */

import { randomUUID } from "node:crypto";
import { RUN_STATES, assertTransition, describeState, isCancellable } from "../../domain/piper/runState.js";
import { answerQuestion } from "../../domain/piper/intentRouter.js";
import { buildBrief } from "../../domain/piper/briefModel.js";
import { TOOL_SCHEMAS, executeTool, isWriteTool, isKnownTool, describeToolCall } from "./toolRegistry.js";

const MAX_TOOL_ITERATIONS = 4;
const MAX_HISTORY_TURNS = 12;
const MAX_RECENT_ENTITIES = 10;
const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

/**
 * Bounded, explicit session context. Holds identifiers only — never CRM facts.
 * Facts always come from tools at answer time; this only resolves who "he",
 * "Robert", or "this deal" refer to within a thread.
 */
function blankThreadContext() {
  return {
    active_seller_id: null,
    active_seller_name: null,
    active_opportunity_id: null,
    active_property_id: null,
    recent_entities: [],
    last_intent: null,
    pending_confirmation: null,
  };
}

function parseThreadContext(row) {
  const ctx = blankThreadContext();
  if (!row) return ctx;
  try {
    const parsed = JSON.parse(row.context_json || "null");
    if (parsed && typeof parsed === "object") {
      for (const k of Object.keys(ctx)) {
        if (parsed[k] !== undefined) ctx[k] = parsed[k];
      }
      if (!Array.isArray(ctx.recent_entities)) ctx.recent_entities = [];
      ctx.recent_entities = ctx.recent_entities.slice(0, MAX_RECENT_ENTITIES);
    }
  } catch { /* corrupt context degrades to blank, never crashes the turn */ }
  return ctx;
}

const SYSTEM_PROMPT = `You are Piper, the head agent for OCG PIPELINE, a seller-opportunity pipeline.

Rules you must follow:
- Every factual claim must come from a tool result. Never state an address, price, stage, classification or count that a tool did not return.
- If the tools do not contain the answer, say so plainly. Do not estimate or infer.
- A fact that is not in a tool result is NOT RECORDED — say "not recorded" rather than filling it in.
- Never infer seller motivation, commitments, objections, dates, offer responses, or contact attempts. If the records do not support it, it did not happen as far as you are concerned.
- When find_seller reports ambiguous=true, ask the operator which seller they mean. Never guess between candidates.
- The conversation context tells you which seller and opportunity "he", "she", "him", "Robert", "this", or "it" refer to. It holds identifiers only — every fact still comes from a tool call.
- You do not write SQL. The listed tools are the only way to read or change PIPELINE data. Never describe a database operation outside them.
- PIPELINE snapshots underwriting from Victor (Deal Scout); it never computes it. Deal Finder intake is Hunter's. You are not Hunter or Victor.
- Provenance "unresolved" means the source could not be established. It is NOT a finding that a record is synthetic.
- To change anything, call a write tool. It will be shown to the operator for approval; never claim an action is done before it is approved and executed.
- Be concise and specific. Lead with the answer.`;

// Exported for contract tests: grounding rules are part of Piper's safety
// contract, not an implementation detail.
export { SYSTEM_PROMPT };

export class PiperRuntime {
  /**
   * @param {object} deps { db, config, contextService, operator, provider }
   */
  constructor({ db, config, contextService, operator, provider }) {
    this.db = db;
    this.config = config;
    this.context = contextService;
    this.operator = operator;
    this.provider = provider;
    /** runId -> AbortController, for in-flight cancellation. */
    this.active = new Map();
  }

  describeProvider() {
    return this.provider.describe();
  }

  probe(options = {}) {
    return this.provider.probe(options);
  }

  // --- persistence --------------------------------------------------------

  ensureThread(threadId, { opportunityId = null } = {}) {
    if (threadId) {
      const existing = this.db.prepare("SELECT * FROM piper_threads WHERE id = ?").get(threadId);
      if (existing) return { ...existing, context: parseThreadContext(existing) };
    }
    const id = threadId || randomUUID();
    this.db.prepare("INSERT INTO piper_threads (id, opportunity_id) VALUES (?, ?)").run(id, opportunityId);
    const created = this.db.prepare("SELECT * FROM piper_threads WHERE id = ?").get(id);
    return { ...created, context: parseThreadContext(created) };
  }

  /** Persist bounded session context for a thread. Identifiers only. */
  #saveThreadContext(threadId, ctx) {
    const bounded = { ...blankThreadContext(), ...ctx };
    bounded.recent_entities = (bounded.recent_entities || []).slice(0, MAX_RECENT_ENTITIES);
    this.db.prepare("UPDATE piper_threads SET context_json = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(bounded), now(), threadId);
    return bounded;
  }

  #rememberEntity(ctx, kind, id, label) {
    if (!id) return;
    ctx.recent_entities = [
      { kind, id, label: label || id },
      ...(ctx.recent_entities || []).filter((e) => !(e.kind === kind && e.id === id)),
    ].slice(0, MAX_RECENT_ENTITIES);
  }

  /**
   * Deterministic context update from a tool result — the ONLY way session
   * context changes. Ambiguous or empty results never overwrite the context.
   */
  #updateContextFromTool(threadId, ctx, name, args, result) {
    if (!result?.ok) return;
    const data = result.data || {};
    let changed = false;
    const setSeller = (id, label) => {
      if (id && ctx.active_seller_id !== id) {
        ctx.active_seller_id = id;
        ctx.active_seller_name = label || ctx.active_seller_name;
        changed = true;
      }
      this.#rememberEntity(ctx, "seller", id, label);
    };
    const setOpportunity = (id) => {
      if (id && ctx.active_opportunity_id !== id) {
        ctx.active_opportunity_id = id;
        changed = true;
      }
      if (id) this.#rememberEntity(ctx, "opportunity", id, null);
    };

    switch (name) {
      case "find_seller": {
        // Exactly one unambiguous candidate: the founder means this seller.
        // Ambiguous or empty: leave the context untouched — never guess.
        if (!data.ambiguous && data.candidates?.length === 1) {
          const c = data.candidates[0];
          setSeller(c.contactId, c.displayName);
          if (c.opportunities?.length === 1) setOpportunity(c.opportunities[0].opportunityId);
        }
        break;
      }
      case "get_seller_summary":
        if (data.seller?.contactId) setSeller(data.seller.contactId, data.seller.displayName);
        break;
      case "get_opportunity":
        if (data.id) {
          setOpportunity(data.id);
          const propId = data.propertyRef || data.property?.externalPropertyId || null;
          if (propId) { ctx.active_property_id = propId; changed = true; }
        }
        break;
      case "find_opportunities":
        if (data.matched === 1 && data.opportunities?.length === 1) setOpportunity(data.opportunities[0].id);
        break;
      case "get_outreach_state":
      case "get_seller_timeline":
      case "get_last_contact":
      case "get_offer_history":
        if (args.opportunityId) setOpportunity(args.opportunityId);
        break;
      case "prepare_call":
        if (data.contact?.name) setSeller(data.contactId || null, data.contact.name);
        if (data.opportunity?.opportunityId) setOpportunity(data.opportunity.opportunityId);
        break;
      default:
        break;
    }
    if (name) { ctx.last_intent = name; changed = true; }
    if (changed) this.#saveThreadContext(threadId, ctx);
  }

  #appendMessage(threadId, runId, role, content) {
    this.db.prepare(`
      INSERT INTO piper_messages (id, thread_id, run_id, role, content) VALUES (?, ?, ?, ?, ?)
    `).run(randomUUID(), threadId, runId, role, String(content ?? ""));
    this.db.prepare("UPDATE piper_threads SET updated_at = ? WHERE id = ?").run(now(), threadId);
  }

  getTranscript(threadId, limit = MAX_HISTORY_TURNS * 2) {
    return this.db.prepare(`
      SELECT role, content, created_at, run_id FROM piper_messages
      WHERE thread_id = ? AND role IN ('user','assistant')
      ORDER BY created_at DESC, rowid DESC LIMIT ?
    `).all(threadId, limit).reverse();
  }

  getRun(runId) {
    const run = this.db.prepare("SELECT * FROM piper_runs WHERE id = ?").get(runId);
    if (!run) return null;
    const toolCalls = this.db.prepare("SELECT * FROM piper_tool_calls WHERE run_id = ? ORDER BY created_at").all(runId);
    return { ...run, toolCalls: toolCalls.map(toToolCall) };
  }

  #setState(runId, from, to, extra = {}) {
    assertTransition(from, to);
    const settled = ["complete", "failed", "canceled"].includes(to);
    this.db.prepare(`
      UPDATE piper_runs SET state = ?, error_code = COALESCE(?, error_code), settled_at = ?
      WHERE id = ?
    `).run(to, extra.errorCode || null, settled ? now() : null, runId);
    return to;
  }

  // --- cancellation -------------------------------------------------------

  cancel(runId, { actor = "local-operator" } = {}) {
    const run = this.db.prepare("SELECT * FROM piper_runs WHERE id = ?").get(runId);
    if (!run) return { ok: false, error: "not_found" };
    if (!isCancellable(run.state)) {
      return { ok: false, error: "not_cancellable", state: run.state };
    }

    // Abort the in-flight provider request if this process owns it.
    const controller = this.active.get(runId);
    if (controller) controller.abort();

    // Any parked proposal dies with the run; nothing was written.
    this.db.prepare(`
      UPDATE piper_tool_calls SET status = 'rejected', decided_by = ?, settled_at = ?
      WHERE run_id = ? AND status = 'proposed'
    `).run(actor, now(), runId);

    this.#setState(runId, run.state, RUN_STATES.CANCELED);
    this.#appendMessage(run.thread_id, runId, "assistant", "Canceled. Nothing was written.");
    return { ok: true, state: RUN_STATES.CANCELED };
  }

  // --- the turn -----------------------------------------------------------

  /**
   * @returns {Promise<object>} the settled run plus the operator-facing answer
   */
  async ask({ question, threadId = null, activeOpportunityId = null, actor = "local-operator" }) {
    const thread = this.ensureThread(threadId, { opportunityId: activeOpportunityId });
    const runId = randomUUID();
    const describe = this.provider.describe();

    // Session context: identifiers only, persisted per thread. The on-screen
    // record seeds the conversation subject when the thread has none; after
    // that, tool results own it — the screen param never yanks the subject
    // mid-conversation.
    const threadCtx = thread.context;
    if (activeOpportunityId && !threadCtx.active_opportunity_id) {
      threadCtx.active_opportunity_id = activeOpportunityId;
      this.#rememberEntity(threadCtx, "opportunity", activeOpportunityId, null);
      this.#saveThreadContext(thread.id, threadCtx);
    }

    this.db.prepare(`
      INSERT INTO piper_runs (id, thread_id, state, provider, model, question, active_opportunity_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(runId, thread.id, RUN_STATES.RETRIEVING, describe.provider, describe.model, String(question || ""), activeOpportunityId);

    this.#appendMessage(thread.id, runId, "user", question);

    const controller = new AbortController();
    this.active.set(runId, controller);

    try {
      // 1. Retrieval — real database work, which is why the state exists.
      const snapshot = this.context.snapshot();

      // 2. No provider: the deterministic router still answers from real state.
      if (!this.provider.connected) {
        const deterministic = answerQuestion(question, snapshot, { activeOpportunityId });
        this.#setState(runId, RUN_STATES.RETRIEVING, RUN_STATES.COMPLETE);
        this.#appendMessage(thread.id, runId, "assistant", deterministic.answer);
        return this.#result(runId, thread.id, {
          answer: deterministic.answer,
          items: deterministic.items,
          proposal: deterministic.proposal,
          capabilities: deterministic.capabilities,
          directive: deterministic.directive || null,
          followUps: deterministic.followUps || [],
          deterministic: true,
        });
      }

      // 3. Model turn, with tool use.
      let state = this.#setState(runId, RUN_STATES.RETRIEVING, RUN_STATES.GENERATING);

      const messages = [
        { role: "system", content: SYSTEM_PROMPT + this.#contextPreamble(snapshot, activeOpportunityId, threadCtx) },
        ...this.getTranscript(thread.id).slice(0, -1).map((m) => ({ role: m.role, content: m.content })),
        { role: "user", content: String(question || "") },
      ];

      let answer = "";
      const readResults = [];

      for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
        const reply = await this.provider.complete({
          messages,
          tools: TOOL_SCHEMAS,
          signal: controller.signal,
          system: SYSTEM_PROMPT,
        });

        answer = reply.text || answer;
        const calls = (reply.toolCalls || []).filter((c) => c.name);

        if (!calls.length) break;

        const writes = calls.filter((c) => isWriteTool(c.name));
        const reads = calls.filter((c) => !isWriteTool(c.name));

        // Read tools run now; they cannot mutate anything.
        for (const call of reads) {
          if (!isKnownTool(call.name)) continue;
          const result = await executeTool({ name: call.name, args: call.arguments, snapshot, operator: this.operator, actor });
          readResults.push({ name: call.name, result });
          // Deterministic session-context update from the tool result.
          this.#updateContextFromTool(thread.id, threadCtx, call.name, call.arguments, result);
          messages.push({ role: "assistant", content: `[tool ${call.name} requested]` });
          messages.push({ role: "user", content: `Tool ${call.name} returned:\n${JSON.stringify(result).slice(0, 6000)}` });
          this.#appendMessage(thread.id, runId, "tool", `${call.name} -> ${result.ok ? "ok" : result.error}`);
        }

        // Write tools are parked, never executed here.
        if (writes.length) {
          for (const call of writes) {
            this.db.prepare(`
              INSERT INTO piper_tool_calls (id, run_id, thread_id, tool_name, arguments_json, requires_approval, status)
              VALUES (?, ?, ?, ?, ?, 1, 'proposed')
            `).run(randomUUID(), runId, thread.id, call.name, JSON.stringify(call.arguments || {}));
          }
          threadCtx.pending_confirmation = writes[0].name;
          this.#saveThreadContext(thread.id, threadCtx);
          state = this.#setState(runId, state, RUN_STATES.AWAITING_APPROVAL);
          const text = answer || "I can do that — approve the action below and I'll write it.";
          this.#appendMessage(thread.id, runId, "assistant", text);
          return this.#result(runId, thread.id, { answer: text, items: itemsFrom(readResults), deterministic: false });
        }

        if (!reads.length) break;
      }

      state = this.#setState(runId, state, RUN_STATES.COMPLETE);
      const finalText = answer || "I don't have an answer for that from stored PIPELINE state.";
      this.#appendMessage(thread.id, runId, "assistant", finalText);
      const inferred = inferDirectives(question, snapshot, readResults, activeOpportunityId);
      return this.#result(runId, thread.id, {
        answer: finalText,
        items: itemsFrom(readResults),
        directive: inferred.directive,
        followUps: inferred.followUps,
        deterministic: false
      });
    } catch (err) {
      const run = this.db.prepare("SELECT state FROM piper_runs WHERE id = ?").get(runId);
      // A cancel() call already settled the run; don't overwrite it.
      if (run && run.state === RUN_STATES.CANCELED) {
        return this.#result(runId, thread.id, { answer: "Canceled. Nothing was written.", items: [], deterministic: false });
      }
      const code = err.code === "canceled" ? "canceled" : err.code || "runtime_error";
      if (run && !["complete", "failed", "canceled"].includes(run.state)) {
        this.#setState(runId, run.state, code === "canceled" ? RUN_STATES.CANCELED : RUN_STATES.FAILED, { errorCode: code });
      }
      const text = code === "canceled" ? "Canceled. Nothing was written." : `I couldn't complete that (${code}). Nothing was written.`;
      this.#appendMessage(thread.id, runId, "assistant", text);
      return this.#result(runId, thread.id, { answer: text, items: [], deterministic: false, errorCode: code });
    } finally {
      this.active.delete(runId);
    }
  }

  /** Approve or reject a parked tool call. The only path to a Piper write. */
  async decide({ toolCallId, approve, actor = "local-operator" }) {
    const call = this.db.prepare("SELECT * FROM piper_tool_calls WHERE id = ?").get(toolCallId);
    if (!call) return { ok: false, error: "not_found" };
    if (call.status !== "proposed") return { ok: false, error: "already_decided", status: call.status };

    if (!approve) {
      this.db.prepare("UPDATE piper_tool_calls SET status='rejected', decided_by=?, settled_at=? WHERE id=?")
        .run(actor, now(), toolCallId);
      const run = this.db.prepare("SELECT state, thread_id FROM piper_runs WHERE id = ?").get(call.run_id);
      if (run.state === RUN_STATES.AWAITING_APPROVAL) {
        this.#setState(call.run_id, run.state, RUN_STATES.COMPLETE);
      }
      this.#clearPendingConfirmation(call.thread_id);
      this.#appendMessage(call.thread_id, call.run_id, "assistant", "Declined. Nothing was written.");
      return { ok: true, status: "rejected", wrote: false };
    }

    if (this.config.readOnly === true) {
      this.db.prepare("UPDATE piper_tool_calls SET status='failed', error_code='read_only', decided_by=?, settled_at=? WHERE id=?")
        .run(actor, now(), toolCallId);
      return { ok: false, error: "read_only" };
    }

    const run = this.db.prepare("SELECT state FROM piper_runs WHERE id = ?").get(call.run_id);
    this.#setState(call.run_id, run.state, RUN_STATES.RUNNING_TOOL);
    this.db.prepare("UPDATE piper_tool_calls SET status = 'approved', decided_by = ? WHERE id = ?")
      .run(actor, toolCallId);

    try {
      const snapshot = this.context.snapshot();
      const result = await executeTool({
        name: call.tool_name,
        args: JSON.parse(call.arguments_json),
        snapshot,
        operator: this.operator,
        actor,
      });

      if (!result.ok) throw Object.assign(new Error(result.error), { code: result.error });

      this.db.prepare("UPDATE piper_tool_calls SET status='executed', result_json=?, settled_at=? WHERE id=?")
        .run(JSON.stringify(result.data ?? {}), now(), toolCallId);
      this.#setState(call.run_id, RUN_STATES.RUNNING_TOOL, RUN_STATES.COMPLETE);
      this.#clearPendingConfirmation(call.thread_id);
      this.#appendMessage(call.thread_id, call.run_id, "assistant", `Done — ${describeToolCall(call.tool_name, JSON.parse(call.arguments_json))}. Written to PIPELINE.`);
      return { ok: true, status: "executed", wrote: true, data: result.data };
    } catch (err) {
      const code = err.code || "tool_failed";
      this.db.prepare("UPDATE piper_tool_calls SET status='failed', error_code=?, settled_at=? WHERE id=?")
        .run(code, now(), toolCallId);
      this.#setState(call.run_id, RUN_STATES.RUNNING_TOOL, RUN_STATES.FAILED, { errorCode: code });
      this.#clearPendingConfirmation(call.thread_id);
      this.#appendMessage(call.thread_id, call.run_id, "assistant", `That action failed (${code}). Nothing was written.`);
      return { ok: false, error: code, wrote: false };
    }
  }

  /** A decided approval is no longer pending — drop it from session context. */
  #clearPendingConfirmation(threadId) {
    const row = this.db.prepare("SELECT context_json FROM piper_threads WHERE id = ?").get(threadId);
    if (!row?.context_json) return;
    try {
      const ctx = JSON.parse(row.context_json);
      if (ctx && ctx.pending_confirmation) {
        ctx.pending_confirmation = null;
        this.#saveThreadContext(threadId, ctx);
      }
    } catch { /* ignore */ }
  }

  #contextPreamble(snapshot, activeOpportunityId, threadCtx = null) {
    const open = snapshot.opportunities.filter((o) => !o.closed);
    const active = activeOpportunityId
      ? snapshot.opportunities.find((o) => o.id === activeOpportunityId)
      : null;

    let preamble = `\n\nCurrent PIPELINE state: ${snapshot.totals.opportunities} opportunities, ${open.length} active, ` +
      `${snapshot.totals.stalled} stalled, ${snapshot.totals.unresolvedProvenance} with unresolved provenance, ` +
      `${snapshot.totals.withoutUnderwriting} without Victor underwriting.` +
      (active
        ? `\nThe operator currently has ${active.id}${active.address ? ` (${active.address})` : ""} open on screen. ` +
          `Treat "this" or "it" as that opportunity unless they name another.`
        : "\nNo opportunity is open on screen.");

    // Session context: identifiers only. Pronouns and bare names resolve here;
    // every fact still comes from a tool call.
    if (threadCtx && (threadCtx.active_seller_id || threadCtx.active_opportunity_id)) {
      const sellerBit = threadCtx.active_seller_id
        ? `the active seller is ${threadCtx.active_seller_name || threadCtx.active_seller_id} (contact ${threadCtx.active_seller_id})`
        : "no seller is active";
      const oppBit = threadCtx.active_opportunity_id
        ? `the active opportunity is ${threadCtx.active_opportunity_id}`
        : "no opportunity is active";
      preamble += `\nConversation context (this thread): ${sellerBit}; ${oppBit}. ` +
        `"He", "him", "she", "her", "the seller", or the seller's first name refer to the active seller; ` +
        `"this deal" or "it" refer to the active opportunity — unless the operator names someone or something else, ` +
        `in which case resolve the new entity with find_seller and update the context.`;
      if (threadCtx.pending_confirmation) {
        preamble += ` A ${threadCtx.pending_confirmation} action is still awaiting the operator's approval; do not re-propose it unprompted.`;
      }
    }
    return preamble;
  }

  #result(runId, threadId, payload) {
    const run = this.getRun(runId);
    const executed = run.toolCalls.filter((c) => c.status === "executed").length;
    return {
      ...payload,
      runId,
      threadId,
      state: run.state,
      stateLabel: describeState(run.state, {
        toolName: run.toolCalls.find((c) => c.status === "proposed")?.toolName || null,
        executedToolCount: executed,
        errorCode: run.error_code,
      }),
      wrote: executed > 0,
      pendingApprovals: run.toolCalls
        .filter((c) => c.status === "proposed")
        .map((c) => ({ id: c.id, tool: c.toolName, summary: describeToolCall(c.toolName, c.arguments), arguments: c.arguments })),
      provider: this.provider.describe(),
    };
  }

  /** The startup brief — unchanged semantics, now runtime-aware. */
  brief({ excludeFixtures = false } = {}) {
    const snapshot = this.context.snapshot();
    if (excludeFixtures) {
      const fixtureIds = new Set(
        snapshot.opportunities.filter((o) => o.isFixture).map((o) => o.id)
      );
      snapshot.opportunities = snapshot.opportunities.filter((o) => !o.isFixture);
      if (snapshot.recent) {
        if (snapshot.recent.stageEvents) {
          snapshot.recent.stageEvents = snapshot.recent.stageEvents.filter((e) => !fixtureIds.has(e.opportunity_id));
        }
        if (snapshot.recent.classificationChanges) {
          snapshot.recent.classificationChanges = snapshot.recent.classificationChanges.filter((c) => !fixtureIds.has(c.opportunity_id));
        }
        if (snapshot.recent.victorUpdates) {
          snapshot.recent.victorUpdates = snapshot.recent.victorUpdates.filter((v) => !fixtureIds.has(v.opportunity_id));
        }
        if (snapshot.recent.intakes) {
          snapshot.recent.intakes = snapshot.recent.intakes.filter((i) => !fixtureIds.has(i.opportunityId));
        }
      }
    }
    return { brief: buildBrief(snapshot), provider: this.provider.describe() };
  }
}

function toToolCall(r) {
  let args = {};
  try { args = JSON.parse(r.arguments_json); } catch { /* opaque payload */ }
  return {
    id: r.id,
    runId: r.run_id,
    toolName: r.tool_name,
    arguments: args,
    status: r.status,
    requiresApproval: r.requires_approval === 1,
    errorCode: r.error_code,
    createdAt: r.created_at,
    settledAt: r.settled_at,
  };
}

function itemsFrom(readResults) {
  const items = [];
  for (const { name, result } of readResults) {
    if (!result?.ok) continue;
    if (name === "find_opportunities") {
      for (const o of result.data.opportunities || []) {
        items.push({ opportunityId: o.id, label: `${o.address || o.id} (${o.stage})`, reasons: [] });
      }
    }
    if (name === "get_opportunity" && result.data?.id) {
      items.push({ opportunityId: result.data.id, label: `${result.data.address || result.data.id} (${result.data.stageLabel})`, reasons: [] });
    }
  }
  return items;
}


function inferDirectives(question, snapshot, readResults, activeOppId) {
  const q = String(question || "").toLowerCase();
  const unres = snapshot.opportunities.find((o) => o.provenanceState === "unresolved");
  const targetId = activeOppId || (readResults.find(r => r.result?.data?.id)?.result.data.id) || (unres ? unres.id : null);

  if (/what needs.*attention|anything urgent|needs me/i.test(q)) {
    const priority = unres || snapshot.opportunities.find((o) => o.underwriting?.status === "insufficient_evidence") || snapshot.opportunities[0];
    return {
      directive: priority ? { type: "highlight", opportunityId: priority.id, view: "opportunities" } : null,
      followUps: ["Show me why", "Go to underwriting", "Show me the unresolved classifications"]
    };
  }

  if (/^(?:show me )?why|why does (?:this|it) need|explain why/i.test(q)) {
    return {
      directive: targetId ? { type: "open_evidence", opportunityId: targetId } : null,
      followUps: ["Go to underwriting", "Show me the unresolved classifications", "Prepare draft offer"]
    };
  }

  if (/go to underwrit|open underwrit|show underwrit/i.test(q)) {
    return {
      directive: targetId ? { type: "navigate_underwriting", opportunityId: targetId } : null,
      followUps: ["Show me the unresolved classifications", "What am I missing?", "Provenance state"]
    };
  }

  if (/unresolved classif|unresolved record|show.*unresolved/i.test(q)) {
    return {
      directive: { type: "navigate_classifications", filter: "unresolved" },
      followUps: ["Show me the unresolved one", "Show underwriting for this deal", "Provenance state"]
    };
  }

  return { directive: null, followUps: ["What needs my attention?", "Show me the unresolved classifications", "System health"] };
}
