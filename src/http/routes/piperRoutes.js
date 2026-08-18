/**
 * Piper endpoints — /api/v1/piper/*
 *
 *   GET  /brief              the operating brief, derived from stored state
 *   POST /ask                one turn; may settle awaiting_approval
 *   POST /cancel             abort an in-flight run
 *   POST /approve            approve or reject a proposed action — the only
 *                            path by which Piper writes
 *   GET  /thread             persisted transcript
 *   GET  /status             provider identity and connection state
 *   POST /probe              reachability plus a tool-calling check
 *
 * `ask` is a POST because a question is a body, not because it writes. Nothing
 * here mutates operator data except `approve`, which is gated on readOnly the
 * same way every other write in the application is.
 */

import { sendJson } from "../response.js";
import { CAPABILITIES } from "../../domain/piper/intentRouter.js";
import { describeState, RUN_STATES } from "../../domain/piper/runState.js";

const MAX_QUESTION = 2000;

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

const actorOf = (req) => req.pipelineSession?.userId || req.pipelineSession?.subject || "local-operator";

/** @returns {boolean} true when handled here */
export async function handlePiperRoutes(req, res, ctx, url, segments) {
  const [, action] = segments;
  const piper = ctx.services.piper;

  if (!piper) {
    sendJson(res, 503, { ok: false, error: "piper_unavailable" });
    return true;
  }

  const requirePost = () => {
    if (req.method !== "POST") {
      sendJson(res, 405, { ok: false, error: "method_not_allowed" }, { Allow: "POST" });
      return false;
    }
    return true;
  };
  const requireGet = () => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      sendJson(res, 405, { ok: false, error: "method_not_allowed" }, { Allow: "GET, HEAD" });
      return false;
    }
    return true;
  };

  try {
    switch (action) {
      case "brief": {
        if (!requireGet()) return true;
        const excludeFixtures = url.searchParams.get("excludeFixtures") === "true";
        const { brief, provider } = piper.brief({ excludeFixtures });
        if (url.searchParams.get("acknowledge") === "true" && ctx.config.readOnly !== true) {
          brief.acknowledgedAt = ctx.services.piperContext.markBriefDelivered();
        }
        sendJson(res, 200, {
          ok: true,
          data: brief,
          meta: { provider, deterministic: !provider.connected },
        });
        return true;
      }

      case "status": {
        if (!requireGet()) return true;
        sendJson(res, 200, {
          ok: true,
          data: {
            provider: piper.describeProvider(),
            states: Object.values(RUN_STATES),
            capabilities: CAPABILITIES,
            readOnly: ctx.config.readOnly === true,
          },
        });
        return true;
      }

      case "probe": {
        if (!requirePost()) return true;
        // Reachability plus tool-calling, which is the capability that actually
        // decides whether a model can serve as Piper's runtime.
        const result = await piper.probe();
        sendJson(res, 200, { ok: true, data: result, meta: { provider: piper.describeProvider() } });
        return true;
      }

      case "ask": {
        if (!requirePost()) return true;
        const body = await readJson(req);
        const question = String(body.question || "").slice(0, MAX_QUESTION);
        if (!question.trim()) {
          sendJson(res, 400, { ok: false, error: "missing_question" });
          return true;
        }
        const result = await piper.ask({
          question,
          threadId: body.threadId || null,
          activeOpportunityId: body.activeOpportunityId || null,
          actor: actorOf(req),
        });
        sendJson(res, 200, { ok: true, data: result, meta: { capabilities: result.capabilities || CAPABILITIES } });
        return true;
      }

      case "cancel": {
        if (!requirePost()) return true;
        const body = await readJson(req);
        if (!body.runId) {
          sendJson(res, 400, { ok: false, error: "missing_runId" });
          return true;
        }
        const result = piper.cancel(body.runId, { actor: actorOf(req) });
        sendJson(res, result.ok ? 200 : 409, {
          ok: result.ok,
          error: result.ok ? undefined : result.error,
          data: result.ok ? { state: result.state, stateLabel: describeState(result.state) } : undefined,
        });
        return true;
      }

      case "approve": {
        if (!requirePost()) return true;
        const body = await readJson(req);
        if (!body.toolCallId) {
          sendJson(res, 400, { ok: false, error: "missing_toolCallId" });
          return true;
        }
        const result = await piper.decide({
          toolCallId: body.toolCallId,
          approve: body.approve !== false,
          actor: actorOf(req),
        });
        const status = result.ok ? 200 : result.error === "read_only" ? 503 : 409;
        sendJson(res, status, result.ok ? { ok: true, data: result } : { ok: false, error: result.error });
        return true;
      }

      case "thread": {
        if (!requireGet()) return true;
        const threadId = url.searchParams.get("threadId");
        if (!threadId) {
          sendJson(res, 400, { ok: false, error: "missing_threadId" });
          return true;
        }
        sendJson(res, 200, { ok: true, data: { threadId, messages: piper.getTranscript(threadId) } });
        return true;
      }

      case "run": {
        if (!requireGet()) return true;
        const runId = url.searchParams.get("runId");
        const run = runId ? piper.getRun(runId) : null;
        if (!run) {
          sendJson(res, 404, { ok: false, error: "not_found" });
          return true;
        }
        sendJson(res, 200, { ok: true, data: run });
        return true;
      }

      default:
        sendJson(res, 404, { ok: false, error: "not_found" });
        return true;
    }
  } catch (err) {
    if (err instanceof SyntaxError) {
      sendJson(res, 400, { ok: false, error: "invalid_json" });
      return true;
    }
    console.error(`[piper] ${action} failed`);
    sendJson(res, 500, { ok: false, error: "piper_request_failed" });
    return true;
  }
}
