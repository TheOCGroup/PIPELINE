/**
 * Piper endpoints — /api/v1/piper/*
 *
 *   GET  /api/v1/piper/brief   the operating brief, derived from stored state
 *   POST /api/v1/piper/ask     a question, answered deterministically
 *
 * `ask` is a POST because a question is a body, not because it writes. Neither
 * endpoint mutates anything except the "last brief delivered" marker, and that
 * only when the caller explicitly acknowledges a brief.
 */

import { sendJson } from "../response.js";
import { buildBrief } from "../../domain/piper/briefModel.js";
import { answerQuestion, CAPABILITIES } from "../../domain/piper/intentRouter.js";

const MAX_QUESTION = 500;

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

/** @returns {boolean} true when handled here */
export async function handlePiperRoutes(req, res, ctx, url, segments) {
  const [, action] = segments; // ["piper", <action>]
  const piper = ctx.services.piperContext;

  if (!piper) {
    sendJson(res, 503, { ok: false, error: "piper_unavailable" });
    return true;
  }

  if (action === "brief") {
    if (req.method !== "GET" && req.method !== "HEAD") {
      sendJson(res, 405, { ok: false, error: "method_not_allowed" }, { Allow: "GET, HEAD" });
      return true;
    }
    try {
      const snapshot = piper.snapshot();
      const brief = buildBrief(snapshot);

      // Only advance the marker when asked to, so a refresh does not silently
      // consume the "since last brief" window.
      if (url.searchParams.get("acknowledge") === "true" && ctx.config.readOnly !== true) {
        brief.acknowledgedAt = piper.markBriefDelivered();
      }

      sendJson(res, 200, {
        ok: true,
        data: brief,
        meta: {
          deterministic: true,
          model: null,
          note: "Derived from stored PIPELINE state. No language model is connected.",
        },
      });
    } catch {
      console.error("[piper] brief failed");
      sendJson(res, 500, { ok: false, error: "piper_brief_failed" });
    }
    return true;
  }

  if (action === "ask") {
    if (req.method !== "POST") {
      sendJson(res, 405, { ok: false, error: "method_not_allowed" }, { Allow: "POST" });
      return true;
    }
    try {
      const body = await readJson(req);
      const question = String(body.question || "").slice(0, MAX_QUESTION);
      const snapshot = piper.snapshot();
      const answer = answerQuestion(question, snapshot, {
        activeOpportunityId: body.activeOpportunityId || null,
      });

      sendJson(res, 200, {
        ok: true,
        data: answer,
        meta: {
          deterministic: true,
          model: null,
          capabilities: answer.capabilities || CAPABILITIES,
        },
      });
    } catch (err) {
      if (err instanceof SyntaxError) {
        sendJson(res, 400, { ok: false, error: "invalid_json" });
        return true;
      }
      console.error("[piper] ask failed");
      sendJson(res, 500, { ok: false, error: "piper_ask_failed" });
    }
    return true;
  }

  sendJson(res, 404, { ok: false, error: "not_found" });
  return true;
}
