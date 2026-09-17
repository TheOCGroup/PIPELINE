/**
 * Investment committee endpoints — /api/v1/investment-committee/*
 *
 *  POST /api/v1/investment-committee/review   run the committee rules review
 *                                             against the active offer version
 *
 * The committee is a deterministic rules engine over the active offer and the
 * latest underwriting reference (approve / hold / revise / kill). It is the
 * gate the offer-approval trigger (migration 014) requires: an offer can only
 * move to 'approved' when the latest review for its active version is
 * 'approve'. The founder runs the review, revises terms on hold/revise/kill,
 * and re-runs it until the deal is defensible.
 *
 * GET list remains on the read API (apiRouter).
 */

import { sendJson } from "../response.js";

const actorOf = (req) =>
  req.operatorAuth?.actor || req.pipelineSession?.userId || req.pipelineSession?.subject || "local-operator";

const WORKFLOW_ERRORS = new Set([
  "active_offer_required",
  "active_offer_version_required",
  "underwriting_required",
]);

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

export async function handleInvestmentCommitteeRoutes(req, res, ctx, url, segments) {
  // segments: ["investment-committee", ...]
  const [, action] = segments;
  if (action !== "review") return false; // GET list is served by the read API
  if (req.method !== "POST") {
    sendJson(res, 405, { ok: false, error: "method_not_allowed" }, { Allow: "POST" });
    return true;
  }
  if (ctx.config.readOnly === true) {
    sendJson(res, 503, { ok: false, error: "read_only" });
    return true;
  }
  const committee = ctx.services.investmentCommittee;
  if (!committee) {
    sendJson(res, 503, { ok: false, error: "investment_committee_unavailable" });
    return true;
  }

  let body;
  try {
    body = await readJson(req);
  } catch {
    sendJson(res, 400, { ok: false, error: "invalid_json" });
    return true;
  }
  const opportunityId = body.opportunityId ? String(body.opportunityId).trim() : "";
  if (!opportunityId) {
    sendJson(res, 400, { ok: false, error: "missing_opportunityId" });
    return true;
  }

  try {
    const review = committee.reviewActiveOffer({ opportunityId, actor: actorOf(req) });
    sendJson(res, 200, { ok: true, review });
  } catch (err) {
    if (WORKFLOW_ERRORS.has(err.message)) {
      sendJson(res, 409, { ok: false, error: err.message });
    } else {
      console.error("Investment committee review failed:", err.message);
      sendJson(res, 500, { ok: false, error: "committee_review_failed" });
    }
  }
  return true;
}
