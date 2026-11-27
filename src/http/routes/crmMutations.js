/**
 * Governed CRM mutation routes — POST /api/integrations/crm/opportunities/:id/{stage|notes|update|contacts}
 *
 * The integration surface for chatbot's governed executor (S2 §3 contract;
 * built in R1 §4). Posture mirrors the Deal Findr intake route: dispatched
 * ahead of the session/S2S branch in createServer.js, carries its own
 * fail-closed gate — the intake-class bearer authorizer
 * (authorizePiperIntake: feature flag, constant-time secret comparison,
 * read-only refusal after authentication). Tenant comes from deployment
 * config only, never from the request.
 *
 * Every request must carry mutationKey (= the chatbot governedOperationKey),
 * actor, and approvalId; the route does not verify the WorkApproval itself
 * (chatbot adapter-side, exactly as W1) — approvalId is recorded on the
 * audit row so the chain is reconstructable.
 */

import { sendJson } from "../response.js";
import { authorizePiperIntake } from "./piperIntakeAuthorization.js";
import {
  createCrmMutationService,
  CrmMutationError,
} from "../../services/crmMutationService.js";
import { normalizeTenantId } from "../../repositories/sqlite/tenantScope.js";

const PATH_PATTERN =
  /^\/api\/integrations\/crm\/opportunities\/([^/]+)\/(stage|notes|update|contacts)$/;

async function readJsonBody(req, { maxBytes = 256 * 1024 } = {}) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > maxBytes) {
      const err = new Error("body_too_large");
      err.code = "body_too_large";
      throw err;
    }
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const err = new Error("invalid_json");
    err.code = "invalid_json";
    throw err;
  }
}

function requiredString(data, field) {
  const value = data[field];
  return typeof value === "string" && value.trim() ? value : null;
}

export async function handleCrmMutations(req, res, ctx, url) {
  const match = PATH_PATTERN.exec(url.pathname);
  if (!match) {
    return sendJson(res, 404, { ok: false, error: "not_found" });
  }
  if (req.method !== "POST") {
    return sendJson(res, 405, { ok: false, error: "method_not_allowed" }, { Allow: "POST" });
  }

  const authorization = authorizePiperIntake(req, ctx.config);
  if (!authorization.ok) {
    return sendJson(res, authorization.status, { ok: false, error: authorization.error });
  }

  let data;
  try {
    data = await readJsonBody(req);
  } catch (err) {
    return sendJson(res, 400, { ok: false, error: err.code || "invalid_json" });
  }

  const mutationKey = requiredString(data, "mutationKey");
  if (!mutationKey) return sendJson(res, 400, { ok: false, error: "missing_mutationKey" });
  const actor = requiredString(data, "actor");
  if (!actor) return sendJson(res, 400, { ok: false, error: "missing_actor" });
  const approvalId = requiredString(data, "approvalId");
  if (!approvalId) return sendJson(res, 400, { ok: false, error: "missing_approvalId" });

  const opportunityId = decodeURIComponent(match[1]);
  const operation = match[2];
  const service = createCrmMutationService(
    ctx.db,
    normalizeTenantId(ctx.config && ctx.config.tenantId)
  );

  try {
    let result;
    if (operation === "stage") {
      result = service.moveStage({
        opportunityId,
        stage: data.stage,
        reason: typeof data.reason === "string" ? data.reason : null,
        mutationKey,
        actor,
        approvalId,
      });
    } else if (operation === "notes") {
      result = service.addNote({
        opportunityId,
        body: data.body,
        mutationKey,
        actor,
        approvalId,
      });
    } else if (operation === "update") {
      result = service.updateOpportunity({
        opportunityId,
        fields: data.fields,
        mutationKey,
        actor,
        approvalId,
      });
    } else {
      result = service.upsertContact({
        opportunityId,
        name: data.name,
        phone: data.phone,
        email: data.email,
        role: data.role,
        mutationKey,
        actor,
        approvalId,
      });
    }
    return sendJson(res, result.duplicate ? 200 : 201, result);
  } catch (err) {
    if (err instanceof CrmMutationError) {
      return sendJson(res, err.status, { ok: false, error: err.code });
    }
    console.error("CRM mutation failed:", err.message);
    return sendJson(res, 500, { ok: false, error: "crm_mutation_failed" });
  }
}
