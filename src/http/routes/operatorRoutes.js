/**
 * Operator state endpoints — /api/v1/operator/*
 *
 * The only operator-facing write surface in PIPELINE. Reads are GET; writes are
 * POST and refuse when the deployment is read-only, so `PIPELINE_READ_ONLY=true`
 * blocks every mutation in the application uniformly.
 *
 * These are dispatched after the session enforcement block in createServer.js,
 * so in production with integration enabled a caller must already hold a valid
 * PIPELINE session before reaching here.
 *
 * Stage is intentionally absent. Stage belongs to the systems of record, and
 * the browser-local override this replaces silently outranked the server's
 * value in list and funnel counts.
 */

import { sendJson } from "../response.js";

const MAX_TEXT = 4000;

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

const actorOf = (req) => req.pipelineSession?.userId || req.pipelineSession?.subject || "local-operator";

function text(value, field, { required = true, max = MAX_TEXT } = {}) {
  const v = value === null || value === undefined ? "" : String(value).trim();
  if (!v && required) throw new BadRequest(`missing_${field}`);
  if (v.length > max) throw new BadRequest(`${field}_too_long`);
  return v || null;
}

class BadRequest extends Error {
  constructor(code) { super(code); this.code = code; }
}

/**
 * @returns {boolean} true when the request was handled here
 */
export async function handleOperatorRoutes(req, res, ctx, url, segments) {
  const [, resource, id] = segments; // ["operator", <resource>, <id?>]
  const known = ["next-actions", "notes", "checklist", "interactions", "offers", "outreach"];
  if (!known.includes(resource)) {
    sendJson(res, 404, { ok: false, error: "not_found" });
    return true;
  }

  const isWrite = req.method === "POST";
  if (!isWrite && req.method !== "GET" && req.method !== "HEAD") {
    sendJson(res, 405, { ok: false, error: "method_not_allowed" }, { Allow: "GET, HEAD, POST" });
    return true;
  }

  if (isWrite && ctx.config.readOnly === true) {
    sendJson(res, 503, { ok: false, error: "read_only" });
    return true;
  }

  const repo = ctx.services.operator;
  if (!repo) {
    sendJson(res, 503, { ok: false, error: "operator_state_unavailable" });
    return true;
  }

  const opportunityId = url.searchParams.get("opportunityId");
  const actor = actorOf(req);

  try {
    if (!isWrite) {
      switch (resource) {
        case "next-actions":
          return ok(res, { nextActions: repo.listNextActions(opportunityId || null) });
        case "notes":
          if (!opportunityId) throw new BadRequest("missing_opportunityId");
          return ok(res, { notes: repo.listNotes(opportunityId) });
        case "checklist":
          if (!opportunityId) throw new BadRequest("missing_opportunityId");
          return ok(res, { checklist: repo.listChecklist(opportunityId) });
        case "interactions":
          if (!opportunityId) throw new BadRequest("missing_opportunityId");
          return ok(res, { interactions: repo.listInteractions(opportunityId) });
        case "offers":
          if (!opportunityId) throw new BadRequest("missing_opportunityId");
          return ok(res, { offers: repo.listOffers(opportunityId) });
        case "outreach":
          if (!opportunityId) throw new BadRequest("missing_opportunityId");
          return ok(res, { communications: repo.listCommunications(opportunityId) });
      }
    }

    const body = await readJson(req);

    switch (resource) {
      case "next-actions": {
        if (id) {
          const updated = repo.completeNextAction({ id, actor, status: body.status || "done" });
          if (!updated) { sendJson(res, 404, { ok: false, error: "not_found" }); return true; }
          return ok(res, { nextAction: updated }, 200);
        }
        const created = repo.createNextAction({
          opportunityId: text(body.opportunityId, "opportunityId", { max: 200 }),
          title: text(body.title, "title", { max: 300 }),
          details: text(body.details, "details", { required: false }),
          dueDate: text(body.dueDate, "dueDate", { required: false, max: 40 }),
          actor,
        });
        return ok(res, { nextAction: created }, 201);
      }
      case "notes": {
        const note = repo.createNote({
          opportunityId: text(body.opportunityId, "opportunityId", { max: 200 }),
          body: text(body.body, "body"),
          actor,
        });
        return ok(res, { note }, 201);
      }
      case "checklist": {
        const item = repo.setChecklistItem({
          opportunityId: text(body.opportunityId, "opportunityId", { max: 200 }),
          key: text(body.key, "key", { max: 100 }),
          label: text(body.label, "label", { max: 300 }),
          checked: body.checked === true,
          actor,
        });
        return ok(res, { item }, 200);
      }
      case "interactions": {
        const interaction = repo.createInteraction({
          opportunityId: text(body.opportunityId, "opportunityId", { max: 200 }),
          channel: text(body.channel, "channel", { max: 40 }),
          direction: text(body.direction, "direction", { max: 20 }),
          summary: text(body.summary, "summary"),
          outcome: text(body.outcome, "outcome", { required: false, max: 200 }),
          occurredAt: text(body.occurredAt, "occurredAt", { required: false, max: 40 }),
          actor,
        });
        return ok(res, { interaction }, 201);
      }
      case "offers": {
        if (id) {
          const action = text(body.action, "action", { max: 50 });
          const updated = repo.decideOffer({
            offerId: id,
            action,
            proposedPrice: body.proposedPrice,
            strategyType: body.strategyType,
            earnestMoney: body.earnestMoney,
            inspectionDays: body.inspectionDays,
            closingDays: body.closingDays,
            contingencies: body.contingencies,
            internalNotes: body.internalNotes,
            actor
          });
          return ok(res, { offer: updated }, 200);
        }
        const oppId = text(body.opportunityId, "opportunityId", { max: 200 });
        if (body.proposedPrice === undefined || body.proposedPrice === null) throw new BadRequest("missing_proposedPrice");
        if (!body.strategyType) throw new BadRequest("missing_strategyType");
        if (body.earnestMoney === undefined || body.earnestMoney === null) throw new BadRequest("missing_earnestMoney");
        if (body.inspectionDays === undefined || body.inspectionDays === null) throw new BadRequest("missing_inspectionDays");
        if (body.closingDays === undefined || body.closingDays === null) throw new BadRequest("missing_closingDays");

        const created = repo.prepareOffer({
          opportunityId: oppId,
          proposedPrice: body.proposedPrice,
          strategyType: body.strategyType,
          earnestMoney: body.earnestMoney,
          inspectionDays: body.inspectionDays,
          closingDays: body.closingDays,
          contingencies: body.contingencies,
          internalNotes: body.internalNotes,
          actor
        });
        return ok(res, { offer: created }, 201);
      }
      case "outreach": {
        if (id && id !== "draft" && id !== "inbound") {
          if (segments[3] === "authorize") {
            const comm = repo.authorizeOutreach(id, actor);
            return ok(res, { communication: comm }, 200);
          }
          if (segments[3] === "send") {
            const comm = repo.attemptSendOutreach(id, actor);
            return ok(res, { communication: comm }, 200);
          }
          throw new BadRequest("invalid_action");
        }
        // POST /api/v1/operator/outreach/draft
        if (id === "draft") {
          const comm = repo.createOutreachDraft({
            opportunityId: text(body.opportunityId, "opportunityId"),
            offerVersionId: text(body.offerVersionId, "offerVersionId", { required: false }),
            recipientPersonId: text(body.recipientPersonId, "recipientPersonId"),
            recipientValueSnapshot: text(body.recipientValueSnapshot, "recipientValueSnapshot"),
            recipientChannel: text(body.recipientChannel, "recipientChannel"),
            subject: text(body.subject, "subject", { required: false }),
            contentText: text(body.contentText, "contentText"),
            templateVersion: text(body.templateVersion, "templateVersion", { required: false }),
            actor
          });
          return ok(res, { communication: comm }, 201);
        }
        // POST /api/v1/operator/outreach/inbound
        if (id === "inbound") {
          const comm = repo.receiveInboundCommunication({
            opportunityId: text(body.opportunityId, "opportunityId"),
            recipientPersonId: text(body.recipientPersonId, "recipientPersonId"),
            recipientValueSnapshot: text(body.recipientValueSnapshot, "recipientValueSnapshot"),
            recipientChannel: text(body.recipientChannel, "recipientChannel"),
            subject: text(body.subject, "subject", { required: false }),
            contentText: text(body.contentText, "contentText"),
            inReplyToCommunicationId: text(body.inReplyToCommunicationId, "inReplyToCommunicationId", { required: false }),
            actor
          });
          return ok(res, { communication: comm }, 201);
        }
        throw new BadRequest("invalid_endpoint");
      }
    }

    sendJson(res, 404, { ok: false, error: "not_found" });
    return true;
  } catch (err) {
    if (err instanceof BadRequest) {
      sendJson(res, 400, { ok: false, error: err.code });
      return true;
    }
    if (err instanceof SyntaxError) {
      sendJson(res, 400, { ok: false, error: "invalid_json" });
      return true;
    }
    // Never leak internals; matches the contract apiRouter holds itself to.
    console.error("[operator] request failed");
    sendJson(res, 500, { ok: false, error: "operator_request_failed" });
    return true;
  }
}

function ok(res, data, status = 200) {
  sendJson(res, status, { ok: true, data });
  return true;
}
